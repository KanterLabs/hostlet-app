#!/usr/bin/env python3
"""Read-only M3.5 provider GET fault boundary with private E2E receipt."""

import argparse
import hashlib
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROVIDER = ROOT / "scripts/beta/cloudflare.py"
UPSTREAM = "https://api.cloudflare.com/client/v4"
ERROR_SCHEMA = "hostlet.beta.cloudflare.error/v1"
RETRY_SCHEMA = "hostlet.beta.cloudflare.retry/v1"
LAUNCHER = """import importlib.util, sys
spec = importlib.util.spec_from_file_location('hostlet_cloudflare', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.API = sys.argv[2]
sys.argv = [sys.argv[1], 'status', '--config', sys.argv[3]]
raise SystemExit(module.main())
"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_file(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("private input must be a mode-0600 regular file")
    info = path.lstat()
    if not path.is_file() or info.st_mode & 0o077:
        raise ValueError("private input must be a mode-0600 regular file")
    return path.resolve(strict=True)


class FaultProxy(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, faults):
        super().__init__(("127.0.0.1", 0), FaultHandler)
        self.faults = list(faults)
        self.gets = 0
        self.writes = 0
        self.forward_failures = 0
        self.lock = threading.Lock()
        self.stop_trickle = threading.Event()


class FaultHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        with self.server.lock:
            self.server.gets += 1
            fault = self.server.faults.pop(0) if self.server.faults else None
        if fault == "drop":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if fault == "trickle":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "100000")
            self.end_headers()
            while not self.server.stop_trickle.wait(0.2):
                try:
                    self.wfile.write(b" ")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
            return
        if fault:
            status, retry_after, body = fault
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if retry_after is not None:
                self.send_header("Retry-After", str(retry_after))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not self.path.startswith("/") or self.path.startswith("//"):
            self.send_error(400)
            return
        request = urllib.request.Request(
            UPSTREAM + self.path, method="GET",
            headers={key: self.headers[key] for key in ("Authorization", "Accept", "Content-Type")
                     if key in self.headers},
        )
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                status, body = response.status, response.read()
                retry_after = response.headers.get("Retry-After")
        except urllib.error.HTTPError as exc:
            status, body = exc.code, exc.read()
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            exc.close()
        except (urllib.error.URLError, TimeoutError, OSError):
            with self.server.lock:
                self.server.forward_failures += 1
            self.send_error(502)
            return
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if retry_after is not None:
                self.send_header("Retry-After", retry_after)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reject_write(self):
        with self.server.lock:
            self.server.writes += 1
        self.send_error(405)

    do_POST = reject_write
    do_PUT = reject_write
    do_PATCH = reject_write
    do_DELETE = reject_write


def safe_events(stderr):
    events = []
    for line in stderr.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            raise ValueError("provider emitted non-JSON stderr") from None
        if not isinstance(item, dict) or item.get("schema") not in (ERROR_SCHEMA, RETRY_SCHEMA):
            raise ValueError("provider emitted unknown stderr schema")
        allowed = {"schema", "command", "code", "method", "httpStatus", "attempts", "attempt", "elapsedMs"}
        if set(item) - allowed or item.get("command") != "status" or item.get("method") not in ("GET", None):
            raise ValueError("provider emitted unsafe stderr fields")
        if item.get("code") not in ("transport_failure", "http_retry_exhausted", "http_failure",
                                     "provider_rejected", "response_failure", "guard_refusal",
                                     "input_or_journal_malformed"):
            raise ValueError("provider emitted unknown refusal code")
        if item.get("httpStatus") is not None and (type(item["httpStatus"]) is not int or not 100 <= item["httpStatus"] <= 599):
            raise ValueError("provider emitted invalid HTTP status")
        for key in ("attempt", "attempts", "elapsedMs"):
            if key in item and (type(item[key]) is not int or not 0 <= item[key] <= 120000):
                raise ValueError("provider emitted invalid diagnostic count")
        events.append(item)
    return events


def run_status(config, faults):
    proxy = FaultProxy(faults)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    started = time.monotonic()
    try:
        command = [sys.executable, "-c", LAUNCHER, str(PROVIDER),
                   "http://127.0.0.1:" + str(proxy.server_port), str(config)]
        child = subprocess.run(command, cwd=ROOT, capture_output=True, text=True,
                               timeout=120, check=False)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        events = safe_events(child.stderr)
        output = json.loads(child.stdout) if child.returncode == 0 else None
        if output is not None and (not isinstance(output, dict) or
                                   set(output) != {"phase", "pending", "tunnelRecorded", "actions",
                                                   "exactOriginalRoute", "exactPreviewRoute", "exactRecordCounts"}):
            raise ValueError("provider success stdout shape changed")
        return {"exit": child.returncode, "elapsedMs": elapsed_ms, "events": events,
                "output": output, "gets": proxy.gets, "writes": proxy.writes,
                "forwardFailures": proxy.forward_failures}
    finally:
        proxy.stop_trickle.set()
        proxy.shutdown()
        proxy.server_close()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cloudflare-config", required=True)
    parser.add_argument("--run-id", help="fresh artifact name; omitted for automatic fresh name")
    args = parser.parse_args()
    run_id = args.run_id or "provider-read-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + os.urandom(4).hex()
    if not run_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in run_id):
        parser.error("run ID must contain only letters, digits, hyphen and underscore")
    os.umask(0o077)
    artifact = ROOT / "artifacts/e2e/M3.5" / run_id
    artifact.mkdir(mode=0o700, parents=True, exist_ok=False)
    started_at = datetime.now(timezone.utc).isoformat()
    manifest = {"schema": "hostlet.beta.provider-read-boundary/v1", "runId": run_id,
                "startedAt": started_at, "status": "failed", "source": {}, "inputs": {},
                "cases": [], "assertions": [], "cleanup": {"proxyClosed": False,
                                                      "journalUnchanged": None, "finalReadValid": None}}
    config = None
    journal = None
    journal_before = None

    def check(name, passed, observed):
        manifest["assertions"].append({"id": name, "passed": bool(passed), "observed": observed})

    try:
        config = private_file(args.cloudflare_config)
        cfg = json.loads(config.read_text())
        journal = private_file(Path(cfg["workDir"]) / "cloudflare-journal.json")
        journal_before = journal.read_bytes()
        if not os.environ.get("M35_CF_DNS_TOKEN") or not os.environ.get("M35_CF_TUNNEL_TOKEN"):
            raise ValueError("scoped provider tokens are required in the environment")
        manifest["source"] = {"commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "runnerSha256": digest(Path(__file__).read_bytes()),
            "providerSha256": digest(PROVIDER.read_bytes())}
        manifest["inputs"] = {"configSha256": digest(config.read_bytes()),
                              "journalBeforeSha256": digest(journal_before),
                              "repeatCommand": "python3 e2e/beta/provider-read-boundary.py --cloudflare-config " + str(config)}
        baseline = run_status(config, [])
        manifest["cases"].append({"name": "baseline", **baseline})
        check("baseline-preview", baseline["exit"] == 0 and baseline["output"]["exactPreviewRoute"] is True
              and baseline["output"]["pending"] is None and not baseline["events"]
              and baseline["gets"] >= 9 and baseline["writes"] == 0
              and baseline["forwardFailures"] == 0,
              {"exit": baseline["exit"], "gets": baseline["gets"]})
        success_cases = [
            ("drop-recovery", ["drop"], "transport_failure", None, 1),
            ("503-recovery", [(503, None, b"{}")], "http_retry_exhausted", 503, 1),
            ("429-retry-after-recovery", [(429, 1, b"{}")], "http_retry_exhausted", 429, 1),
        ]
        failure_cases = [
            ("503-exhaustion", [(503, None, b"{}")] * 3, "http_retry_exhausted", 503, 3),
            ("403-immediate", [(403, None, b"{}")], "http_failure", 403, 1),
            ("malformed-immediate", [(200, None, b"{")], "response_failure", None, 1),
            ("provider-rejection-immediate", [(200, None, b'{"success":false}')], "provider_rejected", None, 1),
            ("429-long-retry-after", [(429, 60, b"{}")], "http_retry_exhausted", 429, 1),
            ("slow-trickle-deadline", ["trickle"], "transport_failure", None, 1),
        ]
        for name, faults, code, status, attempts in success_cases + failure_cases:
            result = run_status(config, faults)
            manifest["cases"].append({"name": name, **result})
            retries = [item for item in result["events"] if item["schema"] == RETRY_SCHEMA]
            errors = [item for item in result["events"] if item["schema"] == ERROR_SCHEMA]
            success = name in {item[0] for item in success_cases}
            good = (result["writes"] == 0 and result["forwardFailures"] == 0
                    and result["gets"] == (baseline["gets"] + 1 if success else attempts)
                    and (result["exit"] == 0 if success else result["exit"] == 2)
                    and (result["output"] == baseline["output"] if success else result["output"] is None)
                    and len(retries) == (attempts if success else attempts - 1 if name == "503-exhaustion" else 0)
                    and len(errors) == (0 if success else 1))
            if success:
                good = good and retries[0]["code"] == code and retries[0]["httpStatus"] == status and retries[0]["attempt"] == 1
            else:
                error = errors[0] if errors else {}
                good = good and error.get("code") == code and error.get("httpStatus") == status and error.get("attempts") == attempts
            if name == "503-exhaustion":
                good = good and [event["attempt"] for event in retries] == [1, 2]
            if name == "429-retry-after-recovery":
                good = good and result["elapsedMs"] >= 900
            if name == "429-long-retry-after":
                good = good and result["elapsedMs"] < 12000
            if name == "slow-trickle-deadline":
                good = good and 11000 <= result["elapsedMs"] < 16000
            check(name, good, {"exit": result["exit"], "gets": result["gets"],
                               "writes": result["writes"], "elapsedMs": result["elapsedMs"],
                               "events": result["events"]})
            check(name + "-journal", journal.read_bytes() == journal_before,
                  {"sha256": digest(journal.read_bytes())})
    except Exception as exc:
        # The message is deliberately an allowlisted class, never a provider or input string.
        manifest["errorClass"] = type(exc).__name__ if type(exc).__name__ in (
            "ValueError", "KeyError", "FileNotFoundError", "PermissionError", "TimeoutExpired",
            "JSONDecodeError", "CalledProcessError") else "other"
    finally:
        if config is not None and journal is not None and journal_before is not None:
            try:
                final = run_status(config, [])
                manifest["cases"].append({"name": "final-unfaulted", **final})
                final_ok = final["exit"] == 0 and final["output"]["exactPreviewRoute"] is True and final["output"]["pending"] is None and final["writes"] == 0 and final["forwardFailures"] == 0
                manifest["cleanup"]["finalReadValid"] = final_ok
                check("final-unfaulted-preview", final_ok, {"exit": final["exit"], "gets": final["gets"]})
            except Exception:
                manifest["cleanup"]["finalReadValid"] = False
                check("final-unfaulted-preview", False, {"error": "read-failed"})
            unchanged = journal.read_bytes() == journal_before
            manifest["cleanup"]["journalUnchanged"] = unchanged
            check("journal-unchanged", unchanged, {"sha256": digest(journal.read_bytes())})
        manifest["cleanup"]["proxyClosed"] = True
        manifest["endedAt"] = datetime.now(timezone.utc).isoformat()
        manifest["status"] = "passed" if manifest["assertions"] and all(item["passed"] for item in manifest["assertions"]) and "errorClass" not in manifest else "failed"
        shutil.copyfile(__file__, artifact / "provider-read-boundary.py")
        os.chmod(artifact / "provider-read-boundary.py", 0o600)
        report = ["# M3.5 provider-read boundary " + run_id, "", "Status: **" + manifest["status"] + "**", "",
                  "Repeat: `" + manifest["inputs"].get("repeatCommand", "unavailable") + "`", "",
                  "| Assertion | Result |", "| --- | --- |"]
        report += ["| " + item["id"] + " | " + ("PASS" if item["passed"] else "FAIL") + " |" for item in manifest["assertions"]]
        report += ["", "No provider writes were forwarded; the local fault proxies were closed.", ""]
        (artifact / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        (artifact / "REPORT.md").write_text("\n".join(report))
        receipt = "".join(digest((artifact / name).read_bytes()) + "  " + name + "\n"
                          for name in ("REPORT.md", "manifest.json", "provider-read-boundary.py"))
        (artifact / "SHA256SUMS").write_text(receipt)
        print("M3.5 provider-read " + manifest["status"] + ": " + str(artifact.relative_to(ROOT)))
        print("SHA256SUMS sha256: " + digest((artifact / "SHA256SUMS").read_bytes()))
    return 0 if manifest["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
