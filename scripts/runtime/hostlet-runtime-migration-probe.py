#!/usr/bin/env python3
"""Run one fenced release probe in a disposable gVisor allocation."""

import argparse
import atexit
import hashlib
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote

REQUEST_SCHEMA = "hostlet.runtime.migration-probe-request/v1"
CREDENTIAL_SCHEMA = "hostlet.runtime.probe-credential/v1"
RESULT_SCHEMA = "hostlet.runtime.migration-probe-result/v1"
PROBE_SCHEMA = "hostlet.runtime.probe-receipt/v2"
APPLICATION_SCHEMA = "hostlet.runtime.application-probe-receipt/v1"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SAFE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
MARKER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,78}")
CHECK_KINDS = {
    "current_data",
    "cached_old_frontend_candidate_api",
    "candidate_frontend_retained_api",
}
HEALTH_ERROR_CODES = {
    "42P01", "42501", "28P01", "3D000", "08001", "08006", "57P03", "53300",
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EACCES",
}


class ProbeFailure(Exception):
    pass


def fail(code):
    raise ProbeFailure(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def exact_keys(value, keys, code):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail(code)


def as_uuid(value, code):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        fail(code)
    if str(parsed) != value:
        fail(code)
    return value


def private_root(path, marker, content):
    value = Path(path)
    try:
        metadata = value.lstat()
        resolved = value.resolve(strict=True)
        marker_path = resolved / marker
        marker_metadata = marker_path.lstat()
    except OSError:
        fail("migration_probe_root_invalid")
    if (not value.is_absolute() or resolved != value or not stat.S_ISDIR(metadata.st_mode) or
            stat.S_IMODE(metadata.st_mode) & 0o077 or not stat.S_ISREG(marker_metadata.st_mode) or
            marker_path.read_text().strip() != content):
        fail("migration_probe_root_invalid")
    return resolved


def regular_file(path, private=False, executable=False):
    value = Path(path)
    try:
        metadata = value.lstat()
        resolved = value.resolve(strict=True)
    except OSError:
        fail("migration_probe_path_invalid")
    mode = stat.S_IMODE(metadata.st_mode)
    if (not value.is_absolute() or resolved != value or not stat.S_ISREG(metadata.st_mode) or
            (private and mode & 0o077) or (executable and not mode & 0o111)):
        fail("migration_probe_path_invalid")
    return resolved


def read_bound(path, expected_hex, maximum, private=False):
    value = regular_file(path, private=private)
    data = value.read_bytes()
    if len(data) > maximum or hashlib.sha256(data).hexdigest() != expected_hex:
        fail("migration_probe_input_digest_mismatch")
    return value, data


def read_cas(root, digest):
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        fail("migration_probe_evidence_digest_invalid")
    hexdigest = digest[7:]
    path = root / "evidence" / "sha256" / hexdigest[:2] / f"{hexdigest[2:]}.json"
    try:
        metadata = path.lstat()
        data = path.read_bytes()
    except OSError:
        fail("migration_probe_evidence_missing")
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o077 or
            len(data) > 512 * 1024 or sha256(data) != digest):
        fail("migration_probe_evidence_invalid")
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("migration_probe_evidence_invalid")


def store_cas(root, value):
    data = canonical(value)
    digest = sha256(data)
    hexdigest = digest[7:]
    directory = root / "evidence" / "sha256" / hexdigest[:2]
    owner = root.stat()
    for path in (root / "evidence", root / "evidence" / "sha256", directory):
        try:
            path.mkdir(mode=0o700)
            os.chown(path, owner.st_uid, owner.st_gid)
        except FileExistsError:
            metadata = path.lstat()
            if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != owner.st_uid or
                    metadata.st_gid != owner.st_gid or stat.S_IMODE(metadata.st_mode) & 0o077):
                fail("migration_probe_evidence_owner_invalid")
    path = directory / f"{hexdigest[2:]}.json"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except FileExistsError:
        metadata = path.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner.st_uid or
                metadata.st_gid != owner.st_gid or stat.S_IMODE(metadata.st_mode) & 0o077 or
                path.read_bytes() != data):
            fail("migration_probe_evidence_collision")
        return digest
    with os.fdopen(descriptor, "wb") as output:
        os.fchown(output.fileno(), owner.st_uid, owner.st_gid)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    return digest


def health_error_code(gateway_namespace, address, port, path):
    url = f"http://{address}:{port}{path}"
    try:
        result = subprocess.run(
            ["ip", "netns", "exec", gateway_namespace, "curl", "--silent", "--show-error",
             "--max-time", "2", "--max-filesize", "512", url], capture_output=True, timeout=3,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, check=False)
        if result.returncode != 0 or len(result.stdout) > 512:
            return "unknown"
        code = json.loads(result.stdout).get("diagnostic_code")
        return code.lower() if code in HEALTH_ERROR_CODES else "unknown"
    except (OSError, subprocess.TimeoutExpired, UnicodeDecodeError, json.JSONDecodeError, AttributeError, TypeError):
        return "unknown"


def run(command, *, stdin=None, timeout=60, code="migration_probe_command_failed"):
    try:
        completed = subprocess.run(command, input=stdin, capture_output=True, timeout=timeout,
                                   env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail(code)
    if completed.returncode != 0:
        fail(code)
    return completed.stdout


def write_private(path, data, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def wipe_unlink(path):
    try:
        descriptor = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            os.close(descriptor)
            fail("migration_probe_credential_cleanup_failed")
        with os.fdopen(descriptor, "r+b", buffering=0) as value:
            remaining = metadata.st_size
            zeroes = b"\0" * min(65536, max(1, remaining))
            while remaining:
                count = min(len(zeroes), remaining)
                value.write(zeroes[:count])
                remaining -= count
            os.fsync(value.fileno())
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        fail("migration_probe_credential_cleanup_failed")


def quiet_wipe(path):
    try:
        wipe_unlink(path)
    except ProbeFailure:
        pass


def remove_private_tree(path, secret_names=()):
    """Remove one helper-owned private directory without following links."""
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        fail("migration_probe_credential_cleanup_failed")
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o077:
        fail("migration_probe_credential_cleanup_failed")
    secrets = set(secret_names)
    try:
        children = list(path.iterdir())
    except OSError:
        fail("migration_probe_credential_cleanup_failed")
    for child in children:
        if child.name in secrets:
            wipe_unlink(child)
            continue
        try:
            child_metadata = child.lstat()
        except OSError:
            fail("migration_probe_credential_cleanup_failed")
        if not stat.S_ISREG(child_metadata.st_mode):
            fail("migration_probe_credential_cleanup_failed")
        try:
            child.unlink()
        except OSError:
            fail("migration_probe_credential_cleanup_failed")
    try:
        path.rmdir()
    except OSError:
        fail("migration_probe_credential_cleanup_failed")


def unique_marker_match(value, name):
    if not isinstance(value, dict) or not isinstance(value.get("items"), list):
        return False
    return sum(1 for item in value["items"]
               if isinstance(item, dict) and item.get("name") == name) == 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-file", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--credential-file", required=True)
    parser.add_argument("--credential-sha256", required=True)
    parser.add_argument("--runtime-binary", required=True)
    parser.add_argument("--launcher", required=True)
    parser.add_argument("--runsc", required=True)
    parser.add_argument("--peer-helper", required=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--evidence-root", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{64}", args.request_sha256) or not re.fullmatch(r"[0-9a-f]{64}", args.credential_sha256):
        fail("migration_probe_digest_invalid")
    runtime_binary = regular_file(args.runtime_binary, executable=True)
    launcher = regular_file(args.launcher, executable=True)
    runsc = regular_file(args.runsc, executable=True)
    peer_helper = regular_file(args.peer_helper, executable=True)
    state_root = private_root(args.state_root, ".hostlet-runtime-owned", "hostlet-runtime-state-v1")
    artifact_root = private_root(args.artifact_root, ".hostlet-artifacts-owned", "hostlet-artifacts-v1")
    evidence_root = private_root(args.evidence_root, ".hostlet-release-owned", "hostlet-release-state-v1")
    _, request_bytes = read_bound(args.request_file, args.request_sha256, 512 * 1024, private=True)
    credential_path, credential_bytes = read_bound(args.credential_file, args.credential_sha256, 64 * 1024, private=True)
    atexit.register(quiet_wipe, credential_path)
    try:
        request = json.loads(request_bytes)
        credential = json.loads(credential_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("migration_probe_input_invalid")
    request_keys = {
        "schema", "probe_execution_id", "reconciliation_id", "attempt_id", "release_fence",
        "check_kind", "release_id", "peer_release_id", "source_allocation_id",
        "source_generation", "source_fence", "artifact_digest", "artifact_manifest_digest",
        "build_profile_digest", "executor_template_receipt_digest",
        "tenant_database_id", "database_generation", "migration_id", "target", "executor",
    }
    exact_keys(request, request_keys, "migration_probe_request_invalid")
    if request["schema"] != REQUEST_SCHEMA or request["target"] != "isolated" or request["check_kind"] not in CHECK_KINDS:
        fail("migration_probe_request_invalid")
    for field in ("probe_execution_id", "reconciliation_id", "attempt_id", "release_id",
                  "source_allocation_id", "tenant_database_id", "database_generation", "migration_id"):
        as_uuid(request[field], "migration_probe_identity_invalid")
    if request["peer_release_id"] is not None:
        as_uuid(request["peer_release_id"], "migration_probe_identity_invalid")
    if ((request["check_kind"] == "current_data") != (request["peer_release_id"] is None)):
        fail("migration_probe_peer_identity_invalid")
    if request["probe_execution_id"] == request["source_allocation_id"]:
        fail("migration_probe_not_disposable")
    for field in ("release_fence", "source_generation", "source_fence"):
        if not isinstance(request[field], int) or request[field] <= 0 or request[field] > 2**63 - 1:
            fail("migration_probe_identity_invalid")
    for field in ("artifact_digest", "artifact_manifest_digest", "build_profile_digest",
                  "executor_template_receipt_digest"):
        if not isinstance(request[field], str) or not DIGEST.fullmatch(request[field]):
            fail("migration_probe_digest_invalid")
    executor_keys = {"runtime_binary_digest", "policy_digest", "capability_digest", "platform", "profile",
                     "argv", "application_port", "health_port", "health_path"}
    executor = request["executor"]
    exact_keys(executor, executor_keys, "migration_probe_executor_invalid")
    if (not all(isinstance(executor[field], str) and DIGEST.fullmatch(executor[field])
                for field in ("runtime_binary_digest", "policy_digest", "capability_digest")) or
            executor["platform"] not in ("systrap", "kvm") or
            executor["profile"] != "evidence_gated_owned_fixture" or
            not isinstance(executor["argv"], list) or not executor["argv"] or len(executor["argv"]) > 32 or
            any(not isinstance(item, str) or not item or len(item) > 4096 or "\0" in item for item in executor["argv"]) or
            not isinstance(executor["application_port"], int) or not 0 < executor["application_port"] < 65536 or
            not isinstance(executor["health_port"], int) or not 0 < executor["health_port"] < 65536 or
            not isinstance(executor["health_path"], str) or not executor["health_path"].startswith("/") or
            len(executor["health_path"]) > 256 or any(character in executor["health_path"] for character in "?#") or
            any(ord(character) < 32 for character in executor["health_path"])):
        fail("migration_probe_executor_invalid")
    credential_keys = {"schema", "probe_execution_id", "reconciliation_id", "attempt_id", "release_fence",
                       "release_id", "tenant_database_id", "database_generation", "migration_id", "target",
                       "credential_id", "database_name", "role_name", "password"}
    exact_keys(credential, credential_keys, "migration_probe_credential_invalid")
    if credential["schema"] != CREDENTIAL_SCHEMA or credential["target"] != "isolated":
        fail("migration_probe_credential_invalid")
    for field in ("probe_execution_id", "reconciliation_id", "attempt_id", "release_id", "tenant_database_id",
                  "database_generation", "migration_id"):
        if credential[field] != request[field]:
            fail("migration_probe_credential_mismatch")
    if credential["release_fence"] != request["release_fence"]:
        fail("migration_probe_credential_mismatch")
    as_uuid(credential["credential_id"], "migration_probe_credential_invalid")
    if (not SAFE_NAME.fullmatch(credential["database_name"]) or not SAFE_NAME.fullmatch(credential["role_name"]) or
            credential["database_name"] != "hdr_" + request["migration_id"].replace("-", "") or
            not isinstance(credential["password"], str) or not 16 <= len(credential["password"]) <= 1024 or
            any(ord(character) < 32 for character in credential["password"])):
        fail("migration_probe_credential_invalid")
    expected_credential = evidence_root / "probe-credentials" / f"{request['probe_execution_id']}.json"
    if credential_path != expected_credential:
        fail("migration_probe_credential_path_invalid")
    template = read_cas(evidence_root, request["executor_template_receipt_digest"])
    if (template.get("schema") != "hostlet.runtime.executor-receipt/v1" or
            template.get("allocation_id") != request["source_allocation_id"] or
            template.get("generation") != request["source_generation"] or template.get("fence") != request["source_fence"] or
            template.get("artifact_digest") != request["artifact_digest"] or
            template.get("runtime_binary_digest") != executor["runtime_binary_digest"] or
            template.get("policy_digest") != executor["policy_digest"] or
            template.get("capability_digest") != executor["capability_digest"] or
            template.get("platform") != executor["platform"] or template.get("profile") != executor["profile"] or
            template.get("runsc_status") != "running" or not isinstance(template.get("observed_limits"), dict) or
            template.get("health", {}).get("passing") is not True or not template.get("health", {}).get("checks")):
        fail("migration_probe_template_mismatch")
    artifact = artifact_root / request["artifact_manifest_digest"][7:]
    if artifact.is_symlink() or not (artifact / "rootfs").is_dir():
        fail("migration_probe_artifact_missing")
    manifest_path = regular_file(artifact / "manifest.json")
    try:
        manifest_bytes = manifest_path.read_bytes()
        if len(manifest_bytes) > 64 * 1024:
            fail("migration_probe_artifact_invalid")
        manifest = json.loads(manifest_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("migration_probe_artifact_invalid")
    if (not isinstance(manifest, dict) or manifest.get("schema") != "hostlet.runtime-artifact/v1" or
            manifest.get("archive_digest") != request["artifact_digest"] or
            manifest.get("build_manifest_digest") != request["artifact_manifest_digest"] or
            manifest.get("build_profile_digest") != request["build_profile_digest"]):
        fail("migration_probe_artifact_invalid")
    inventory_path = evidence_root / "database-inventory.json"
    inventory_metadata = inventory_path.lstat()
    if not stat.S_ISREG(inventory_metadata.st_mode) or stat.S_IMODE(inventory_metadata.st_mode) & 0o077:
        fail("migration_probe_inventory_invalid")
    inventory = json.loads(inventory_path.read_bytes())
    matches = [item for item in inventory.get("targets", []) if
               item.get("tenant_database_id") == request["tenant_database_id"] and
               item.get("database_generation") == request["database_generation"] and
               item.get("recovery_id") == request["migration_id"] and item.get("restore_target") is True]
    if inventory.get("schema_version") != 1 or len(matches) != 1:
        fail("migration_probe_clone_unavailable")
    database = matches[0]
    if not re.fullmatch(r"[0-9a-f]{64}", database.get("container_id", "")):
        fail("migration_probe_inventory_invalid")
    endpoint4 = ipaddress.ip_address(database["endpoint_ipv4"])
    endpoint6 = ipaddress.ip_address(database["endpoint_ipv6"])
    if endpoint4.version != 4 or endpoint6.version != 6:
        fail("migration_probe_inventory_invalid")
    network4 = ipaddress.ip_network(f"{endpoint4}/30", strict=False)
    network6 = ipaddress.ip_network(f"{endpoint6}/126", strict=False)
    database_gateway4, database_gateway6 = network4.network_address + 1, network6.network_address + 1
    if endpoint4 != network4.network_address + 2 or endpoint6 != network6.network_address + 2:
        fail("migration_probe_inventory_invalid")
    execution_uuid = uuid.UUID(request["probe_execution_id"])
    raw = execution_uuid.bytes
    application4 = ipaddress.ip_address(f"10.{64 + raw[0] % 64}.{raw[1]}.2")
    gateway4 = application4 - 1
    application6 = ipaddress.ip_address(f"fd42:686f:7072:{int.from_bytes(raw[:2], 'big'):x}::2")
    gateway6 = application6 - 1
    runtime_request_base = {
        "schema": "hostlet.runtime.executor-request/v1", "profile": executor["profile"],
        "allocation_id": request["probe_execution_id"], "generation": 1, "fence": request["release_fence"],
        "artifact_digest": request["artifact_digest"],
        "artifact_manifest_digest": request["artifact_manifest_digest"],
        "build_profile_digest": request["build_profile_digest"],
        "runtime_binary_digest": executor["runtime_binary_digest"],
        "policy_digest": executor["policy_digest"], "capability_digest": executor["capability_digest"],
        "platform": executor["platform"], "argv": executor["argv"], "environment": [],
        "secret_version_refs": [{"name": "DATABASE_URL", "version_id": credential["credential_id"]}],
        "health_port": executor["health_port"], "health_path": executor["health_path"],
        "application_port": executor["application_port"],
        "network": {"application_ipv4": str(application4), "gateway_ipv4": str(gateway4),
                    "application_ipv6": str(application6), "gateway_ipv6": str(gateway6),
                    "ingress_sources": [],
                    "outbound_destinations": [
                        {"address": str(endpoint4), "port": 5432, "protocol": "tcp"},
                        {"address": str(endpoint6), "port": 5432, "protocol": "tcp"},
                    ]},
        "resources": {"memory_bytes": 536870912, "memory_swap_bytes": 0, "cpu_quota_micros": 25000,
                      "cpu_period_micros": 100000, "pids": 128, "scratch_bytes": 268435456,
                      "max_connections": 128, "new_connections_per_second": 20,
                      "new_connections_burst": 40},
        "exit_history_unix_ms": [],
    }
    work_root = state_root / ".migration-probes" / request["probe_execution_id"]
    work_root.mkdir(mode=0o700, parents=True, exist_ok=False)
    secret_root = state_root / "secret-input" / request["probe_execution_id"] / str(request["release_fence"])
    prepared = attached = started = False
    cleanup_digest = executor_digest = application_digest = None
    invoke_sequence = 0

    def invoke(operation, *, timeout=90, allow_failed=False):
        nonlocal invoke_sequence
        invoke_sequence += 1
        runtime_request = dict(runtime_request_base)
        runtime_request["operation"] = operation
        runtime_request["observed_at_unix_ms"] = int(time.time() * 1000)
        path = work_root / f"executor-{operation}-{invoke_sequence:04d}.json"
        data = canonical(runtime_request)
        write_private(path, data)
        try:
            completed = subprocess.run([str(runtime_binary), "owned-fixture", "--request-file", str(path),
                                        "--launcher", str(launcher), "--state-root", str(state_root),
                                        "--artifact-root", str(artifact_root), "--runsc", str(runsc)],
                                       capture_output=True, timeout=timeout,
                                       env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, check=False)
        except subprocess.TimeoutExpired:
            fail(f"migration_probe_executor_{operation}_timeout")
        except OSError:
            fail(f"migration_probe_executor_{operation}_unavailable")
        receipt = None
        for line in reversed(completed.stdout.splitlines()):
            try:
                receipt = json.loads(line)
                break
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        if not isinstance(receipt, dict):
            fail(f"migration_probe_executor_{operation}_failed")
        if (receipt.get("operation") != operation or
                receipt.get("allocation_id") != request["probe_execution_id"] or
                receipt.get("generation") != 1 or
                receipt.get("fence") != request["release_fence"]):
            fail("migration_probe_executor_identity_mismatch")
        digest = store_cas(evidence_root, receipt)
        if completed.returncode != 0:
            fail(f"migration_probe_executor_{operation}_failed")
        if receipt.get("result") != "passed":
            if allow_failed and operation == "inspect":
                return receipt, digest
            fail(f"migration_probe_executor_{operation}_failed")
        return receipt, digest

    try:
        secret_root.mkdir(mode=0o700, parents=True, exist_ok=False)
        marker = {"allocation_id": request["probe_execution_id"], "fence": request["release_fence"]}
        write_private(secret_root / "OWNERSHIP.json", canonical(marker), 0o400)
        database_url = (f"postgresql://{quote(credential['role_name'], safe='')}:{quote(credential['password'], safe='')}"
                        f"@{endpoint4}:5432/{quote(credential['database_name'], safe='')}?sslmode=disable")
        write_private(secret_root / credential["credential_id"], database_url.encode(), 0o400)
        wipe_unlink(credential_path)
        prepared = True
        _, _ = invoke("prepare")
        peer_request = {
            "schema": "hostlet.runtime.peer-request/v1", "operation": "attach_postgres",
            "allocation_id": request["probe_execution_id"], "runtime_generation": 1,
            "runtime_fence": request["release_fence"], "container_id": database["container_id"],
            "run_id": inventory["run_id"], "tenant_database_id": request["tenant_database_id"],
            "database_generation": request["database_generation"], "restore_target": True,
            "endpoint_ipv4": str(endpoint4), "endpoint_ipv6": str(endpoint6),
            "gateway_ipv4": str(database_gateway4), "gateway_ipv6": str(database_gateway6),
        }
        peer_path = work_root / "peer-attach.json"
        peer_bytes = canonical(peer_request)
        write_private(peer_path, peer_bytes)
        run([str(peer_helper), "--request-file", str(peer_path), "--request-sha256", sha256(peer_bytes)[7:],
             "--state-root", str(state_root)], code="migration_probe_peer_attach_failed")
        attached = True
        _, _ = invoke("start")
        started = True
        gateway_namespace = f"hostlet-gateway-{request['probe_execution_id']}-1"

        def health_timeout():
            code = health_error_code(gateway_namespace, application4, executor["health_port"],
                                     executor["health_path"])
            fail(f"migration_probe_health_timeout_{code}")

        health_deadline = time.monotonic() + 5.0
        while True:
            remaining = health_deadline - time.monotonic()
            if remaining <= 0:
                health_timeout()
            try:
                health_receipt, candidate_executor_digest = invoke(
                    "inspect", timeout=max(0.001, remaining), allow_failed=True)
            except ProbeFailure as error:
                if str(error) == "migration_probe_executor_inspect_timeout":
                    health_timeout()
                raise
            observed = time.monotonic()
            if observed > health_deadline:
                health_timeout()
            if (health_receipt.get("status") != "running" or
                    health_receipt.get("runsc_status") != "running"):
                fail("migration_probe_health_stopped")
            if (health_receipt.get("result") == "passed" and
                    health_receipt.get("health", {}).get("passing") is True):
                executor_digest = candidate_executor_digest
                break
            time.sleep(min(0.1, max(0, health_deadline - time.monotonic())))
        marker_name = "migration-probe-" + request["probe_execution_id"]
        if not MARKER_NAME.fullmatch(marker_name):
            fail("migration_probe_marker_invalid")
        write_value = {"name": marker_name, "client_release": request["check_kind"]}
        url = f"http://{application4}:{executor['application_port']}/api/items"
        began = int(time.time() * 1000)
        post = run(["ip", "netns", "exec", gateway_namespace, "curl", "--silent", "--show-error",
                    "--max-time", "5", "--request", "POST", "--header", "content-type: application/json",
                    "--data-binary", "@-", "--output", "/dev/null", "--write-out", "%{http_code}", url],
                   stdin=canonical(write_value), code="migration_probe_application_write_failed")
        get_result = run(["ip", "netns", "exec", gateway_namespace, "curl", "--silent", "--show-error",
                          "--max-time", "5", "--write-out", "\n%{http_code}", url],
                         code="migration_probe_application_read_failed")
        try:
            get_output, get_status_bytes = get_result.rsplit(b"\n", 1)
            get_status = int(get_status_bytes)
        except (ValueError, TypeError):
            fail("migration_probe_application_read_failed")
        try:
            visible = unique_marker_match(json.loads(get_output), marker_name)
        except (UnicodeDecodeError, json.JSONDecodeError):
            visible = False
        post_status = post.decode("ascii", "strict")
        if not re.fullmatch(r"2[0-9]{2}", post_status) or get_status != 200 or not visible:
            fail("migration_probe_application_incompatible")
        application_receipt = {
            "schema": APPLICATION_SCHEMA, "probe_execution_id": request["probe_execution_id"],
            "allocation_id": request["probe_execution_id"], "generation": 1,
            "fence": request["release_fence"], "artifact_digest": request["artifact_digest"],
            "database_generation": request["database_generation"], "migration_id": request["migration_id"],
            "check_kind": request["check_kind"], "target": "isolated", "result": "passed",
            "reason_code": "runtime_application_probe_passed", "observed_at_unix_ms": int(time.time() * 1000),
            "http": {"write_status_code": int(post_status), "read_status_code": get_status,
                     "response_sha256": sha256(get_output), "elapsed_ms": max(1, int(time.time() * 1000) - began)},
            "assertions": [{"name": "write_accepted", "passed": True},
                           {"name": "written_data_visible", "passed": True}],
        }
        application_digest = store_cas(evidence_root, application_receipt)
    finally:
        cleanup_failure = None
        try:
            wipe_unlink(credential_path)
        except ProbeFailure as error:
            cleanup_failure = error
        if started:
            try:
                invoke("stop")
            except ProbeFailure as error:
                cleanup_failure = error
        if attached:
            try:
                peer_request["operation"] = "detach_postgres"
                peer_bytes = canonical(peer_request)
                peer_path = work_root / "peer-detach.json"
                write_private(peer_path, peer_bytes)
                run([str(peer_helper), "--request-file", str(peer_path), "--request-sha256", sha256(peer_bytes)[7:],
                     "--state-root", str(state_root)], code="migration_probe_peer_detach_failed")
            except ProbeFailure as error:
                cleanup_failure = error
        if prepared:
            try:
                cleanup_receipt, cleanup_digest = invoke("cleanup")
                cleanup = cleanup_receipt.get("cleanup", {})
                if not (cleanup_receipt.get("status") == "cleaned" and cleanup_receipt.get("result") == "passed" and
                        cleanup.get("sandbox_absent") and cleanup.get("application_namespace_absent") and
                        cleanup.get("gateway_namespace_absent") and cleanup.get("cgroup_absent") and
                        cleanup.get("state_retained") is False):
                    fail("migration_probe_cleanup_incomplete")
            except ProbeFailure as error:
                cleanup_failure = error
        try:
            remove_private_tree(secret_root, (credential["credential_id"],))
        except ProbeFailure as error:
            cleanup_failure = error
        if work_root.exists():
            try:
                shutil.rmtree(work_root)
            except OSError:
                cleanup_failure = ProbeFailure("migration_probe_cleanup_incomplete")
        if cleanup_failure is not None:
            raise cleanup_failure
    if not all((executor_digest, application_digest, cleanup_digest)):
        fail("migration_probe_incomplete")
    observed = int(time.time() * 1000)
    assertions = [
        {"name": "disposable_execution_identity", "passed": True},
        {"name": "executor_healthy", "passed": True},
        {"name": "clone_write_read_compatible", "passed": True},
        {"name": "owned_cleanup_complete", "passed": True},
    ]
    receipt = {
        "schema": PROBE_SCHEMA, "probe_execution_id": request["probe_execution_id"],
        "reconciliation_id": request["reconciliation_id"], "attempt_id": request["attempt_id"],
        "release_fence": request["release_fence"], "check_kind": request["check_kind"],
        "release_id": request["release_id"], "peer_release_id": request["peer_release_id"],
        "source_allocation_id": request["source_allocation_id"],
        "source_generation": request["source_generation"], "source_fence": request["source_fence"],
        "artifact_digest": request["artifact_digest"],
        "artifact_manifest_digest": request["artifact_manifest_digest"],
        "build_profile_digest": request["build_profile_digest"],
        "database_generation": request["database_generation"],
        "migration_id": request["migration_id"], "target": "isolated",
        "executor_receipt_digest": executor_digest, "application_probe_receipt_digest": application_digest,
        "cleanup_receipt_digest": cleanup_digest, "result": "passed",
        "reason_code": "runtime_isolated_probe_passed", "observed_at_unix_ms": observed,
        "assertions": assertions,
    }
    probe_digest = store_cas(evidence_root, receipt)
    result = {"schema": RESULT_SCHEMA, "probe_execution_id": request["probe_execution_id"],
              "probe_receipt_digest": probe_digest, "executor_receipt_digest": executor_digest,
              "application_probe_receipt_digest": application_digest, "cleanup_receipt_digest": cleanup_digest}
    sys.stdout.buffer.write(canonical(result))


if __name__ == "__main__":
    try:
        main()
    except ProbeFailure as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        print("migration_probe_internal_failure", file=sys.stderr)
        raise SystemExit(1)
