#!/usr/bin/env python3
"""Stage HCA1 static output and atomically install a prepared route manifest."""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import sys
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath

DIGEST = re.compile(r"sha256:([0-9a-f]{64})\Z")
MAX_STATIC_BYTES = 250 * 1024 * 1024
MAX_MIGRATION_BYTES = 1024 * 1024
MAX_ENTRIES = 10_000

def die(code):
    print(code, file=sys.stderr)
    raise SystemExit(1)

def private_owned_root(value, marker, marker_value):
    path = Path(value)
    try:
        info = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError:
        die("release_root_unavailable")
    if not path.is_absolute() or stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
        die("release_root_not_private")
    try:
        if (resolved / marker).read_text().strip() != marker_value:
            die("release_root_not_owned")
    except OSError:
        die("release_root_not_owned")
    return resolved

def digest_hex(value):
    match = DIGEST.fullmatch(value) if isinstance(value, str) else None
    if not match: die("release_digest_invalid")
    return match.group(1)

def cas_file(root, digest):
    value = digest_hex(digest)
    candidates = (root / "sha256" / value, root / value)
    for path in candidates:
        try:
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                observed = hashlib.sha256(path.read_bytes()).hexdigest()
                if observed != value: die("release_artifact_digest_mismatch")
                return path
        except FileNotFoundError:
            pass
    die("release_artifact_missing")

def read_exact(handle, count):
    value = handle.read(count)
    if len(value) != count: die("release_artifact_truncated")
    return value

def number(handle, size):
    return int.from_bytes(read_exact(handle, size), "big")

def string(handle, maximum):
    size = number(handle, 2)
    if not 0 < size <= maximum: die("release_artifact_invalid")
    try: return read_exact(handle, size).decode("utf-8")
    except UnicodeDecodeError: die("release_artifact_invalid")

def safe_relative(value):
    pure = PurePosixPath(value)
    return bool(value) and not pure.is_absolute() and "\\" not in value and "\x00" not in value and all(part not in ("", ".", "..") for part in pure.parts)

def verify_manifest(root, digest, archive_digest, kind):
    path = cas_file(root, digest)
    try: value = json.loads(path.read_bytes())
    except Exception: die("release_artifact_manifest_invalid")
    expected = {"schema":"hostlet.build-artifact/v1", "kind":kind, "archive_digest":archive_digest}
    if any(value.get(key) != item for key, item in expected.items()): die("release_artifact_manifest_mismatch")
    return value

def extract_static(root, state, artifact):
    archive_digest = artifact.get("archive_digest")
    manifest = verify_manifest(root, artifact.get("manifest_digest"), archive_digest, "static")
    archive = cas_file(root, archive_digest)
    destination = state / "release-static" / digest_hex(archive_digest)
    owned = destination / ".hostlet-release-static-owned"
    if destination.exists():
        if not owned.is_file() or owned.read_text().strip() != archive_digest: die("release_static_collision")
        return destination, tree_digest(destination)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".stage-", dir=destination.parent))
    os.chmod(temporary, 0o700)
    try:
        with archive.open("rb") as handle:
            if read_exact(handle, 4) != b"HCA1" or read_exact(handle, 1) != b"\x01": die("release_artifact_invalid")
            service_id = string(handle, 128)
            try: uuid.UUID(service_id)
            except ValueError: die("release_artifact_invalid")
            entries, total = number(handle, 4), number(handle, 8)
            if not 0 < entries <= MAX_ENTRIES or total > MAX_STATIC_BYTES: die("release_artifact_limits")
            if manifest.get("entry_count") != entries or manifest.get("unpacked_bytes") != total: die("release_artifact_manifest_mismatch")
            previous, observed = None, 0
            for _ in range(entries):
                name, mode, size = string(handle, 1024), number(handle, 4), number(handle, 8)
                if not safe_relative(name) or (previous is not None and name <= previous) or mode not in (0o644, 0o755): die("release_artifact_invalid")
                previous = name; observed += size
                if observed > total: die("release_artifact_limits")
                target = temporary.joinpath(*PurePosixPath(name).parts)
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with target.open("xb") as output:
                    remaining = size
                    while remaining:
                        chunk = read_exact(handle, min(65536, remaining)); output.write(chunk); remaining -= len(chunk)
                    output.flush(); os.fsync(output.fileno())
                os.chmod(target, mode)
            if observed != total or handle.read(1): die("release_artifact_invalid")
        atomic_bytes(temporary / ".hostlet-release-static-owned", (archive_digest + "\n").encode(), 0o600)
        os.rename(temporary, destination)
        directory=os.open(destination.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return destination, tree_digest(destination)

def materialize_migration(root,state,candidate):
    backend=candidate.get("backend")
    path=candidate.get("migration_artifact_path")
    digest=candidate.get("migration_digest")
    if not isinstance(backend,dict) or not isinstance(path,str) or not path.startswith("dist/migrations/") or not path.endswith(".sql") or not safe_relative(path):
        die("release_migration_artifact_invalid")
    expected=digest_hex(digest)
    archive_digest=backend.get("archive_digest")
    verify_manifest(root,backend.get("manifest_digest"),archive_digest,"application")
    found=None
    with cas_file(root,archive_digest).open("rb") as handle:
        if read_exact(handle,4)!=b"HCA1" or read_exact(handle,1)!=b"\x02": die("release_artifact_invalid")
        try: uuid.UUID(string(handle,128))
        except ValueError: die("release_artifact_invalid")
        entries,total=number(handle,4),number(handle,8)
        if not 0<entries<=MAX_ENTRIES or total>MAX_STATIC_BYTES: die("release_artifact_limits")
        previous=None; observed=0
        for _ in range(entries):
            name,mode,size=string(handle,1024),number(handle,4),number(handle,8)
            if not safe_relative(name) or (previous is not None and name<=previous) or mode not in (0o644,0o755): die("release_artifact_invalid")
            previous=name; observed+=size
            if observed>total: die("release_artifact_limits")
            if name==path:
                if found is not None or not 0<size<=MAX_MIGRATION_BYTES: die("release_migration_artifact_invalid")
                found=read_exact(handle,size)
            else:
                remaining=size
                while remaining:
                    chunk=read_exact(handle,min(65536,remaining)); remaining-=len(chunk)
        if observed!=total or handle.read(1): die("release_artifact_invalid")
    if found is None or hashlib.sha256(found).hexdigest()!=expected or b"\x00" in found: die("release_migration_digest_mismatch")
    try: found.decode("utf-8")
    except UnicodeDecodeError: die("release_migration_artifact_invalid")
    relative=Path("migration-artifacts")/"sha256"/expected[:2]/(expected[2:]+".sql")
    destination=state/relative; destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    for owned in (state/"migration-artifacts",state/"migration-artifacts"/"sha256",destination.parent): os.chmod(owned,0o700)
    if destination.exists():
        info=destination.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or hashlib.sha256(destination.read_bytes()).hexdigest()!=expected: die("release_migration_collision")
    else:
        descriptor,temporary=tempfile.mkstemp(prefix=".migration-",dir=destination.parent)
        try:
            os.fchmod(descriptor,0o600)
            with os.fdopen(descriptor,"wb") as output: output.write(found); output.flush(); os.fsync(output.fileno())
            try: os.link(temporary,destination)
            except FileExistsError:
                if hashlib.sha256(destination.read_bytes()).hexdigest()!=expected: die("release_migration_collision")
            directory=os.open(destination.parent,os.O_RDONLY|os.O_DIRECTORY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            try: os.unlink(temporary)
            except FileNotFoundError: pass
    return relative.as_posix()

def tree_digest(root):
    lines=[]
    for path in sorted(root.rglob("*")):
        if path.is_dir(): continue
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode): die("release_static_invalid")
        relative=path.relative_to(root).as_posix()
        if relative == ".hostlet-release-static-owned": continue
        lines.append(f"{relative}\0{stat.S_IMODE(info.st_mode):04o}\0{info.st_size}\0{hashlib.sha256(path.read_bytes()).hexdigest()}\n")
    return "sha256:" + hashlib.sha256("".join(lines).encode()).hexdigest()

def atomic_bytes(path, value, mode=0o600):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".new-", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as output:
            output.write(value); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass

def load(path):
    try:
        info=Path(path).lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > 1024*1024: die("release_input_invalid")
        return json.loads(Path(path).read_bytes())
    except (OSError, ValueError): die("release_input_invalid")

def stage(value, state, artifacts):
    candidate=value.get("candidate")
    if not isinstance(candidate,dict): die("release_lease_invalid")
    staged=[]
    frontend=candidate.get("frontend")
    if frontend is not None:
        path,digest=extract_static(artifacts,state,frontend)
        staged.append({"archive_digest":frontend["archive_digest"],"tree_digest":digest,"relative_root":str(path.relative_to(state))})
    phase=value.get("reconciliation",{}).get("requirements",{}).get("phase")
    materialized=materialize_migration(artifacts,state,candidate) if phase=="prepare_trial" else None
    result={"schema":"hostlet.release-stage-receipt/v1","result":"staged","release_id":candidate.get("release_id"),"project_id":candidate.get("project_id"),"frontend":staged[0] if staged else None,"migration_materialized_ref":materialized,"observed_at_unix_ms":int(time.time()*1000)}
    print(json.dumps(result,separators=(",",":")))

def validate_route(manifest):
    if not isinstance(manifest,dict) or manifest.get("schema") != "hostlet.route-manifest/v1": die("release_route_manifest_invalid")
    for key in ("project_id","release_id","deployment_id","configuration_revision_id"):
        try: uuid.UUID(manifest[key])
        except (KeyError,ValueError,TypeError): die("release_route_manifest_invalid")
    if not isinstance(manifest.get("generation"),int) or manifest["generation"] <= 0: die("release_route_manifest_invalid")
    frontend=manifest.get("frontend")
    if frontend is not None:
        digest_hex(frontend.get("archive_digest")); digest_hex(frontend.get("manifest_digest"))
    backend=manifest.get("backend")
    if backend is not None:
        try: uuid.UUID(backend["allocation_id"])
        except (KeyError,ValueError,TypeError): die("release_route_manifest_invalid")
        if not all(isinstance(backend.get(key),int) and backend[key]>0 for key in ("generation","fence")): die("release_route_manifest_invalid")
        digest_hex(backend.get("artifact_digest")); digest_hex(backend.get("artifact_manifest_digest"))
        expected=f"runtime-allocation:{backend['allocation_id']}:{backend['generation']}:{backend['fence']}"
        if backend.get("backend_ref")!=expected: die("release_route_manifest_invalid")
    retained=manifest.get("retained_assets")
    # Control retains the routed release plus its two most recent predecessors
    # while the candidate becomes current, so a prepared manifest can carry
    # three distinct retained frontend identities.
    if not isinstance(retained,list) or len(retained)>3: die("release_route_manifest_invalid")
    for item in retained:
        try: uuid.UUID(item["release_id"])
        except (KeyError,ValueError,TypeError): die("release_route_manifest_invalid")
        digest_hex(item.get("archive_digest")); digest_hex(item.get("manifest_digest"))

def switch(value, state, artifacts, args):
    reconciliation=value.get("reconciliation")
    if value.get("state") != "prepared" and (not isinstance(reconciliation,dict) or reconciliation.get("state")!="prepared"):
        die("release_not_prepared")
    manifest=value.get("route_manifest")
    validate_route(manifest)
    # The control response must include the exact compact bytes whose digest it
    # committed. JSON object reserialization is deliberately not trusted.
    exact=value.get("route_manifest_json")
    if not isinstance(exact,str) or len(exact)>512*1024: die("release_route_manifest_bytes_missing")
    try: exact_value=json.loads(exact)
    except ValueError: die("release_route_manifest_invalid")
    if exact_value != manifest: die("release_route_manifest_mismatch")
    raw=exact.encode()
    observed="sha256:"+hashlib.sha256(raw).hexdigest()
    if observed != value.get("route_manifest_digest"): die("release_route_manifest_digest_mismatch")
    if manifest["generation"] != value.get("route_generation"): die("release_route_generation_mismatch")
    frontend=manifest.get("frontend")
    if frontend is not None: extract_static(artifacts,state,frontend)
    for retained in manifest["retained_assets"]: extract_static(artifacts,state,retained)
    project=manifest["project_id"]
    route_root=state/"release-routes"/project
    immutable=route_root/"manifests"/(digest_hex(observed)+".json")
    if immutable.exists():
        if hashlib.sha256(immutable.read_bytes()).hexdigest()!=digest_hex(observed): die("release_route_manifest_collision")
    else: atomic_bytes(immutable,raw)
    current=route_root/"current.json"
    if current.exists():
        prior=json.loads(current.read_bytes())
        if prior.get("generation",0)>manifest["generation"]: die("release_route_generation_stale")
        if prior.get("generation")==manifest["generation"] and prior!=manifest: die("release_route_generation_collision")
    atomic_bytes(current,raw)
    receipt={"schema":"hostlet.release-route-switch/v1","reconciliation_id":args.reconciliation_id,"attempt_id":args.attempt_id,"fence":args.fence,"project_id":project,"release_id":manifest["release_id"],"previous_release_id":manifest.get("previous_release_id"),"route_generation":manifest["generation"],"route_manifest_digest":observed,"result":"switched","observed_at_unix_ms":int(time.time()*1000)}
    print(json.dumps(receipt,separators=(",",":")))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("operation",choices=("stage","switch")); parser.add_argument("--input-file",required=True)
    parser.add_argument("--state-root",required=True); parser.add_argument("--artifact-root",required=True)
    parser.add_argument("--reconciliation-id"); parser.add_argument("--attempt-id"); parser.add_argument("--fence",type=int)
    args=parser.parse_args()
    state=private_owned_root(args.state_root,".hostlet-release-owned","hostlet-release-state-v1")
    artifacts=private_owned_root(args.artifact_root,".hostlet-cas-owned","hostlet-private-cas-v1")
    value=load(args.input_file)
    if args.operation=="stage": stage(value,state,artifacts)
    else:
        try: uuid.UUID(args.reconciliation_id); uuid.UUID(args.attempt_id)
        except (ValueError,TypeError): die("release_switch_identity_invalid")
        if not args.fence or args.fence<=0: die("release_switch_identity_invalid")
        switch(value,state,artifacts,args)
if __name__=="__main__": main()
