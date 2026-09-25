#!/usr/bin/env python3
"""M3.5 exact-host Cloudflare preview route lifecycle. Private state only."""

import argparse
import base64
import datetime
import email.utils
import fcntl
import hashlib
import json
import os
import secrets
import signal
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from contextlib import contextmanager

API = "https://api.cloudflare.com/client/v4"
HOSTS = ("beta.hostlet.cloud", "beta-demo.hostlet.cloud", "beta-portfolio.hostlet.cloud")
GUARDS = ("*.hostlet.cloud", "hostlet.cloud")
READ_ATTEMPTS = 3
READ_DEADLINE_SECONDS = 12
READ_TIMEOUT_SECONDS = 4
RETRY_DELAYS_SECONDS = (0.25, 0.5)
CURRENT_COMMAND = None
CURRENT_GET_ATTEMPT = 0


class Refusal(Exception):
    pass


class ProviderRefusal(Refusal):
    def __init__(self, code, method, http_status=None, attempts=1):
        super().__init__(code)
        self.code = code
        self.method = method
        self.http_status = http_status
        self.attempts = attempts


def diagnostic(schema, code, method=None, http_status=None, **fields):
    print(json.dumps({"schema": schema, "command": CURRENT_COMMAND,
                      "code": code, "method": method, "httpStatus": http_status,
                      **fields}, sort_keys=True), file=sys.stderr)


def retry_after_seconds(value):
    if not value:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
        if when.tzinfo is None:
            return None
        return max(0, (when - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
    except (TypeError, ValueError, OverflowError):
        return None


@contextmanager
def read_wall_deadline():
    previous_handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()

    def expired(_signum, _frame):
        raise ProviderRefusal("transport_failure", "GET", attempts=max(1, CURRENT_GET_ATTEMPT))

    signal.signal(signal.SIGALRM, expired)
    previous_remaining, previous_interval = signal.setitimer(signal.ITIMER_REAL, READ_DEADLINE_SECONDS)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_remaining:
            remaining = max(0.001, previous_remaining - (time.monotonic() - started))
            signal.setitimer(signal.ITIMER_REAL, remaining, previous_interval)


def require_private_file(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise Refusal("private input must be a regular 0600 file")
    return path


def load_private(path):
    return json.loads(require_private_file(path).read_text())


def save_private(path, data):
    path = Path(path)
    if path.parent.is_symlink() or stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
        raise Refusal("private work directory must deny group and other access")
    fd, tmp = tempfile.mkstemp(prefix=".cloudflare-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(data, f, sort_keys=True, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        dfd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def save_token(path, value):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix=".cloudflare-token-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(value + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextmanager
def exclusive_lock(cfg):
    path = Path(cfg["workDir"]) / "cloudflare.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if stat.S_IMODE(os.fstat(fd).st_mode) & 0o077:
            raise Refusal("private lock file permissions are unsafe")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal("another Cloudflare route operation is running") from None
        yield
    finally:
        os.close(fd)


def api(method, path, token, body=None):
    if method == "GET":
        with read_wall_deadline():
            return api_request(method, path, token, body)
    return api_request(method, path, token, body)


def api_request(method, path, token, body=None):
    global CURRENT_GET_ATTEMPT
    payload = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        API + path, data=payload, method=method,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    deadline = started + READ_DEADLINE_SECONDS if method == "GET" else None
    limit = READ_ATTEMPTS if method == "GET" else 1
    last_code = "transport_failure"
    last_status = None
    for attempt in range(1, limit + 1):
        if method == "GET":
            CURRENT_GET_ATTEMPT = attempt
        remaining = deadline - time.monotonic() if deadline else None
        if remaining is not None and remaining <= 0:
            raise ProviderRefusal(last_code, method, last_status, attempt - 1)
        timeout = min(READ_TIMEOUT_SECONDS, remaining) if remaining is not None else 20
        retry_after = None
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                try:
                    result = json.load(response)
                except (ValueError, UnicodeError):
                    raise ProviderRefusal("response_failure", method, attempts=attempt) from None
        except urllib.error.HTTPError as exc:
            status = exc.code
            retry_after = retry_after_seconds(exc.headers.get("Retry-After") if exc.headers else None)
            exc.close()
            if method != "GET" or not (status == 429 or 500 <= status <= 599):
                raise ProviderRefusal("http_failure", method, status, attempt) from None
            code = "http_retry_exhausted"
        except (urllib.error.URLError, TimeoutError, OSError):
            status = None
            code = "transport_failure"
        else:
            if not isinstance(result, dict) or result.get("success") is not True:
                raise ProviderRefusal("provider_rejected", method, attempts=attempt)
            return result.get("result"), result.get("result_info", {})
        remaining = deadline - time.monotonic() if deadline else 0
        last_code, last_status = code, status
        delay = retry_after if retry_after is not None else RETRY_DELAYS_SECONDS[attempt - 1] if attempt < limit else 0
        if attempt == limit or delay >= remaining:
            raise ProviderRefusal(code, method, status, attempt) from None
        diagnostic("hostlet.beta.cloudflare.retry/v1", code, method, status,
                   attempt=attempt, elapsedMs=int((time.monotonic() - started) * 1000))
        time.sleep(delay)


def query(params):
    return "?" + urllib.parse.urlencode(params)


def records(cfg, name):
    path = f"/zones/{cfg['zoneId']}/dns_records" + query({"name": name, "per_page": 100})
    result, info = api("GET", path, os.environ["M35_CF_DNS_TOKEN"])
    if not isinstance(result, list) or info.get("total_count", len(result)) > len(result):
        raise Refusal("DNS result incomplete")
    return sorted((r for r in result if r.get("name") == name), key=lambda r: r["id"])


def dns_view(record):
    return {key: record.get(key) for key in ("id", "type", "name", "content", "proxied", "ttl", "comment", "tags", "settings")}


def dns_matches_baseline(actual, baseline):
    # Cloudflare may return an empty comment after PATCH clears a baseline null.
    # Every other field, including tags and settings, must still match exactly.
    if not isinstance(actual, dict) or not isinstance(baseline, dict):
        return False
    if baseline.get("comment") is None and actual.get("comment") == "":
        actual = {**actual, "comment": None}
    return actual == baseline


def dns_list_matches_baseline(actual, baseline):
    return len(actual) == len(baseline) and all(
        dns_matches_baseline(a, b) for a, b in zip(actual, baseline))


def current_dns(cfg):
    return {name: [dns_view(r) for r in records(cfg, name)] for name in (*HOSTS, *GUARDS)}


def tunnel_path(cfg, suffix=""):
    return f"/accounts/{cfg['accountId']}/cfd_tunnel{suffix}"


def tunnel_list(cfg, name):
    result, info = api("GET", tunnel_path(cfg) + query({"name": name, "is_deleted": "false", "per_page": 100}), os.environ["M35_CF_TUNNEL_TOKEN"])
    if not isinstance(result, list) or info.get("total_count", len(result)) > len(result):
        raise Refusal("tunnel result incomplete")
    return [r for r in result if r.get("name") == name and not r.get("deleted_at")]


def tunnel_get(cfg, tunnel_id):
    result, _ = api("GET", tunnel_path(cfg, "/" + tunnel_id), os.environ["M35_CF_TUNNEL_TOKEN"])
    if not isinstance(result, dict) or result.get("id") != tunnel_id or result.get("account_tag") != cfg["accountId"]:
        raise Refusal("tunnel account or identity mismatch")
    return result


def tunnel_config(cfg, tunnel_id):
    result, _ = api("GET", tunnel_path(cfg, "/" + tunnel_id + "/configurations"), os.environ["M35_CF_TUNNEL_TOKEN"])
    return result.get("config") if isinstance(result, dict) else None


def expected_ingress(cfg):
    origin = f"http://127.0.0.1:{cfg['originPort']}"
    return {"ingress": [{"hostname": name, "service": origin} for name in HOSTS] + [{"service": "http_status:404"}]}


def ingress_matches(actual, expected):
    # Observed Cloudflare readback adds only this disabled default to the PUT
    # payload. Keep equality exact so a path, origin override, extra rule, or
    # enabled private-network route cannot be mistaken for our configuration.
    return actual == {"ingress": expected["ingress"], "warp-routing": {"enabled": False}}


def assert_tunnel_owned(cfg, journal):
    tunnel_id = journal.get("tunnelId")
    if not tunnel_id:
        raise Refusal("preview tunnel has no recorded identity")
    t = tunnel_get(cfg, tunnel_id)
    if t.get("name") != journal["tunnelName"] or not (t.get("config_src") == "cloudflare" or (t.get("config_src") is None and t.get("remote_config") is True)) or t.get("deleted_at"):
        raise Refusal("preview tunnel ownership mismatch")
    return t


def assert_guards(cfg, journal):
    legacy = tunnel_get(cfg, journal["legacyTunnelId"])
    if legacy.get("name") != journal["legacyTunnelName"] or legacy.get("created_at") != journal["legacyTunnelCreatedAt"]:
        raise Refusal("legacy tunnel identity changed")
    if tunnel_config(cfg, journal["legacyTunnelId"]) != journal["legacyConfig"]:
        raise Refusal("legacy tunnel configuration changed")
    now = current_dns(cfg)
    for name in GUARDS:
        if now[name] != journal["beforeDns"][name]:
            raise Refusal("apex or wildcard changed; refusing mutation")
    return now


def validate_baseline(cfg, before):
    if before.get("zone", {}).get("id") != cfg["zoneId"] or before["zone"].get("account_id") != cfg["accountId"] or before["zone"].get("name") != "hostlet.cloud":
        raise Refusal("before-state account or zone mismatch")
    expected = before.get("dns_records", {})
    for name in (*HOSTS, "*.hostlet.cloud"):
        if name not in expected or not isinstance(expected[name], list):
            raise Refusal("before-state DNS inventory incomplete")
    if len(expected[HOSTS[0]]) != 1 or expected[HOSTS[0]][0].get("type") != "CNAME" or any(expected[n] for n in HOSTS[1:]):
        raise Refusal("before-state exact-host shape differs from accepted placement")
    legacy = before.get("historical_tunnel", {})
    if not isinstance(legacy, dict) or legacy.get("id") != before.get("historical_tunnel_id") or not legacy.get("remote_config"):
        raise Refusal("legacy tunnel identity is unverified")
    live = current_dns(cfg)
    for name in (*HOSTS, "*.hostlet.cloud"):
        for r in expected[name]:
            if any(k not in r for k in ("id", "type", "name", "content", "proxied", "ttl")):
                raise Refusal("before-state record incomplete")
        # The read-only snapshot omitted settings; compare the fields it captured.
        fields = ("id", "type", "name", "content", "proxied", "ttl", "comment", "tags")
        actual = [{k: r.get(k) for k in fields} for r in live[name]]
        baseline = [{k: r.get(k) for k in fields} for r in expected[name]]
        if not (dns_list_matches_baseline(actual, baseline) if name == HOSTS[0] else actual == baseline):
            raise Refusal("DNS changed since before-state capture")
    legacy_live = tunnel_get(cfg, legacy["id"])
    if legacy_live.get("name") != legacy.get("name") or legacy_live.get("created_at") != legacy.get("created_at"):
        raise Refusal("legacy tunnel identity changed")
    if tunnel_config(cfg, legacy["id"]) != before["historical_tunnel_configuration"].get("config"):
        raise Refusal("legacy tunnel configuration changed")
    return live


def load_config(path):
    cfg = load_private(path)
    if set(cfg) != {"accountId", "zoneId", "originPort", "workDir"}:
        raise Refusal("config must contain accountId, zoneId, originPort and workDir only")
    if not all(isinstance(cfg[k], str) and len(cfg[k]) == 32 and all(c in "0123456789abcdef" for c in cfg[k].lower()) for k in ("accountId", "zoneId")):
        raise Refusal("invalid Cloudflare account or zone ID")
    if type(cfg["originPort"]) is not int or not 1024 <= cfg["originPort"] <= 65535:
        raise Refusal("originPort must be an unused high loopback port")
    work = Path(cfg["workDir"])
    if not work.is_absolute() or work.is_symlink() or not work.is_dir() or stat.S_IMODE(work.stat().st_mode) & 0o077:
        raise Refusal("workDir must be an existing private absolute directory")
    cfg["workDir"] = str(work.resolve())
    return cfg


def journal_path(cfg):
    return Path(cfg["workDir"]) / "cloudflare-journal.json"


def load_journal(cfg):
    path = journal_path(cfg)
    if not path.exists():
        raise Refusal("run inventory first")
    j = load_private(path)
    if j.get("schema") != "hostlet.beta.cloudflare/v1" or j.get("accountId") != cfg["accountId"] or j.get("zoneId") != cfg["zoneId"] or j.get("originPort") != cfg["originPort"]:
        raise Refusal("journal/config mismatch")
    return j


def save_journal(cfg, journal):
    save_private(journal_path(cfg), journal)


def inventory(cfg, before_path):
    if journal_path(cfg).exists():
        raise Refusal("journal already exists; use status or resume")
    before = load_private(before_path)
    live = validate_baseline(cfg, before)
    # Apex is guarded too, although the supplied snapshot did not contain it.
    suffix = secrets.token_hex(8)
    name = "hostlet-m35-preview-" + suffix
    if tunnel_list(cfg, name):
        raise Refusal("generated tunnel name already exists")
    j = {"schema": "hostlet.beta.cloudflare/v1", "accountId": cfg["accountId"], "zoneId": cfg["zoneId"],
         "originPort": cfg["originPort"], "beforeSnapshotSha256": hashlib.sha256(Path(before_path).read_bytes()).hexdigest(),
         "beforeDns": live, "legacyTunnelId": before["historical_tunnel_id"],
         "legacyTunnelName": before["historical_tunnel"]["name"],
         "legacyTunnelCreatedAt": before["historical_tunnel"]["created_at"],
         "legacyConfig": before["historical_tunnel_configuration"]["config"], "tunnelName": name,
         "tunnelId": None, "phase": "inventoried", "pending": None, "actions": [], "createdRecords": {}}
    save_journal(cfg, j)
    print("inventory recorded privately; exact beta record and guards verified")


def log_action(cfg, j, action, **values):
    j["actions"].append({"action": action, **values})
    j["pending"] = None
    save_journal(cfg, j)


def prepare(cfg, j):
    if j["phase"] not in ("inventoried", "prepared"):
        raise Refusal("prepare is only valid before cutover")
    now = assert_guards(cfg, j)
    for name in HOSTS:
        if not (dns_list_matches_baseline(now[name], j["beforeDns"][name]) if name == HOSTS[0]
                else now[name] == j["beforeDns"][name]):
            raise Refusal("exact DNS changed before prepare")
    matches = tunnel_list(cfg, j["tunnelName"])
    if len(matches) > 1:
        raise Refusal("ambiguous preview tunnel name")
    if not j["tunnelId"]:
        if matches:
            if j.get("pending") != "create-tunnel":
                raise Refusal("unrecorded preview tunnel exists")
            j["tunnelId"] = matches[0]["id"]
            save_journal(cfg, j)
        else:
            j["pending"] = "create-tunnel"
            save_journal(cfg, j)
            secret = base64.b64encode(secrets.token_bytes(32)).decode()
            created, _ = api("POST", tunnel_path(cfg), os.environ["M35_CF_TUNNEL_TOKEN"],
                             {"name": j["tunnelName"], "config_src": "cloudflare", "tunnel_secret": secret})
            if not isinstance(created, dict) or not created.get("id"):
                raise Refusal("tunnel creation response incomplete; rerun prepare")
            j["tunnelId"] = created["id"]
            save_journal(cfg, j)
        log_action(cfg, j, "created-tunnel", tunnelId=j["tunnelId"])
    assert_tunnel_owned(cfg, j)
    expected = expected_ingress(cfg)
    current = tunnel_config(cfg, j["tunnelId"])
    if not ingress_matches(current, expected):
        if j.get("pending") == "configure-tunnel" and current and current.get("ingress"):
            raise Refusal("unexpected tunnel configuration after interrupted write")
        if current and current.get("ingress") and not ingress_matches(current, {"ingress": [{"service": "http_status:404"}]}):
            raise Refusal("preview tunnel configuration has foreign ingress")
        j["pending"] = "configure-tunnel"
        save_journal(cfg, j)
        api("PUT", tunnel_path(cfg, "/" + j["tunnelId"] + "/configurations"), os.environ["M35_CF_TUNNEL_TOKEN"], {"config": expected})
        if not ingress_matches(tunnel_config(cfg, j["tunnelId"]), expected):
            raise Refusal("preview ingress readback mismatch")
        log_action(cfg, j, "configured-tunnel")
    elif j.get("pending") == "configure-tunnel":
        log_action(cfg, j, "configured-tunnel")
    elif not any(a["action"] == "configured-tunnel" for a in j["actions"]):
        raise Refusal("unrecorded preview tunnel configuration")
    token_file = Path(cfg["workDir"]) / "connector-token"
    token, _ = api("GET", tunnel_path(cfg, "/" + j["tunnelId"] + "/token"), os.environ["M35_CF_TUNNEL_TOKEN"])
    if not isinstance(token, str) or not token:
        raise Refusal("connector token unavailable")
    if not token_file.exists():
        save_token(token_file, token)
    else:
        if require_private_file(token_file).read_text().strip() != token:
            raise Refusal("connector token file does not match provider")
    j["phase"] = "prepared"
    save_journal(cfg, j)
    print("dedicated tunnel prepared; connector token stored in private workDir")


def proof_ok(cfg, path):
    proof = load_private(path)
    if proof != {"ready": True, "originPort": cfg["originPort"], "hosts": list(HOSTS)}:
        raise Refusal("local readiness proof does not match exact hosts and origin")


def cname(j, name):
    return {"type": "CNAME", "name": name, "content": j["tunnelId"] + ".cfargotunnel.com", "ttl": 1,
            "proxied": True, "comment": "hostlet-m35-preview:" + j["tunnelName"]}


def same_route(record, intended):
    return all(record.get(k) == v for k, v in intended.items())


def cutover(cfg, j, proof):
    if j["phase"] not in ("prepared", "cutover", "reversed"):
        raise Refusal("prepare the tunnel before cutover")
    proof_ok(cfg, proof)
    assert_tunnel_owned(cfg, j)
    if not ingress_matches(tunnel_config(cfg, j["tunnelId"]), expected_ingress(cfg)):
        raise Refusal("preview ingress no longer matches")
    for name in HOSTS:
        now = assert_guards(cfg, j)
        rs = now[name]
        desired = cname(j, name)
        if name == HOSTS[0]:
            old = j["beforeDns"][name][0]
            if len(rs) != 1 or rs[0]["id"] != old["id"]:
                raise Refusal("legacy beta DNS ID changed")
            if same_route(rs[0], desired):
                if j.get("pending") == "cutover:" + name:
                    log_action(cfg, j, "cutover", host=name, recordId=old["id"])
                elif j["phase"] == "reversed" or not any(a["action"] == "cutover" and a.get("host") == name for a in j["actions"]):
                    raise Refusal("unrecorded beta route change")
                continue
            if not dns_matches_baseline(rs[0], old):
                raise Refusal("legacy beta DNS target or metadata changed")
            j["pending"] = "cutover:" + name
            save_journal(cfg, j)
            api("PATCH", f"/zones/{cfg['zoneId']}/dns_records/{old['id']}", os.environ["M35_CF_DNS_TOKEN"], desired)
            after = records(cfg, name)
            if len(after) != 1 or after[0]["id"] != old["id"] or not same_route(after[0], desired):
                raise Refusal("beta DNS readback mismatch")
            log_action(cfg, j, "cutover", host=name, recordId=old["id"])
        else:
            if rs:
                recorded = j["createdRecords"].get(name)
                if len(rs) != 1 or not same_route(rs[0], desired) or (recorded and rs[0]["id"] != recorded) or (not recorded and j.get("pending") != "cutover:" + name):
                    raise Refusal("sibling record ownership or target mismatch")
                if not recorded:
                    j["createdRecords"][name] = rs[0]["id"]
                    log_action(cfg, j, "created-record", host=name, recordId=rs[0]["id"])
                continue
            if j["beforeDns"][name] or name in j["createdRecords"]:
                raise Refusal("sibling record disappeared unexpectedly")
            j["pending"] = "cutover:" + name
            save_journal(cfg, j)
            created, _ = api("POST", f"/zones/{cfg['zoneId']}/dns_records", os.environ["M35_CF_DNS_TOKEN"], desired)
            if not isinstance(created, dict) or not created.get("id"):
                raise Refusal("DNS creation response incomplete; rerun cutover")
            j["createdRecords"][name] = created["id"]
            save_journal(cfg, j)
            after = records(cfg, name)
            if len(after) != 1 or after[0]["id"] != created["id"] or not same_route(after[0], desired):
                raise Refusal("sibling DNS readback mismatch")
            log_action(cfg, j, "created-record", host=name, recordId=created["id"])
    j["phase"] = "cutover"
    save_journal(cfg, j)
    print("three exact preview routes now target dedicated tunnel")


def reverse(cfg, j):
    if j["phase"] not in ("prepared", "cutover", "reversed"):
        raise Refusal("reverse requires a prepared journal")
    assert_tunnel_owned(cfg, j)
    for name in reversed(HOSTS):
        now = assert_guards(cfg, j)
        rs = now[name]
        desired = cname(j, name)
        if name != HOSTS[0]:
            rid = j["createdRecords"].get(name)
            if rs and not rid and j.get("pending") == "cutover:" + name and len(rs) == 1 and same_route(rs[0], desired):
                rid = rs[0]["id"]
                j["createdRecords"][name] = rid
                log_action(cfg, j, "created-record", host=name, recordId=rid)
            if not rs:
                if rid:
                    if j.get("pending") != "reverse:" + name:
                        raise Refusal("owned sibling record disappeared unexpectedly")
                    j["createdRecords"].pop(name)
                    log_action(cfg, j, "removed-record", host=name, recordId=rid)
                continue
            if len(rs) != 1 or not rid or rs[0]["id"] != rid or not same_route(rs[0], desired):
                raise Refusal("sibling record is foreign or changed")
            j["pending"] = "reverse:" + name
            save_journal(cfg, j)
            api("DELETE", f"/zones/{cfg['zoneId']}/dns_records/{rid}", os.environ["M35_CF_DNS_TOKEN"])
            if records(cfg, name):
                raise Refusal("sibling DNS deletion readback mismatch")
            j["createdRecords"].pop(name)
            log_action(cfg, j, "removed-record", host=name, recordId=rid)
        else:
            old = j["beforeDns"][name][0]
            if len(rs) != 1 or rs[0]["id"] != old["id"]:
                raise Refusal("legacy beta DNS identity changed")
            if dns_matches_baseline(rs[0], old):
                if j.get("pending") == "reverse:" + name:
                    log_action(cfg, j, "reversed-beta", host=name, recordId=old["id"])
                elif j["phase"] == "cutover":
                    raise Refusal("beta route was restored outside this journal")
                continue
            if not same_route(rs[0], desired):
                raise Refusal("beta target is not the owned preview tunnel")
            j["pending"] = "reverse:" + name
            save_journal(cfg, j)
            restore = {k: v for k, v in old.items() if k in ("type", "name", "content", "ttl", "proxied", "comment", "tags", "settings") and v is not None}
            # PATCH only accepts a string comment. Empty clears an original null comment.
            if old.get("comment") is None:
                restore["comment"] = ""
            api("PATCH", f"/zones/{cfg['zoneId']}/dns_records/{old['id']}", os.environ["M35_CF_DNS_TOKEN"], restore)
            after = records(cfg, name)
            actual = dns_view(after[0]) if len(after) == 1 else None
            if not dns_matches_baseline(actual, old):
                raise Refusal("exact legacy beta restoration readback mismatch")
            log_action(cfg, j, "reversed-beta", host=name, recordId=old["id"])
    j["phase"] = "reversed"
    save_journal(cfg, j)
    print("exact legacy beta route restored; newly created sibling records removed; tunnel and data retained")


def status(cfg, j):
    now = assert_guards(cfg, j)
    old = j["beforeDns"][HOSTS[0]][0]
    current_beta = now[HOSTS[0]][0] if len(now[HOSTS[0]]) == 1 else None
    exact_original = (dns_matches_baseline(current_beta, old)
                      and all(not now[name] for name in HOSTS[1:]))
    exact_preview = False
    if j.get("tunnelId") and all(len(now[name]) == 1 for name in HOSTS):
        assert_tunnel_owned(cfg, j)
        exact_preview = (ingress_matches(tunnel_config(cfg, j["tunnelId"]), expected_ingress(cfg))
                         and now[HOSTS[0]][0]["id"] == old["id"]
                         and all(same_route(now[name][0], cname(j, name)) for name in HOSTS)
                         and all(now[name][0]["id"] == j["createdRecords"].get(name)
                                 for name in HOSTS[1:]))
    print(json.dumps({"phase": j["phase"], "pending": j["pending"],
                      "tunnelRecorded": bool(j["tunnelId"]), "actions": len(j["actions"]),
                      "exactOriginalRoute": exact_original, "exactPreviewRoute": exact_preview,
                      "exactRecordCounts": {name: len(now[name]) for name in HOSTS}}, sort_keys=True))


def main():
    global CURRENT_COMMAND
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inventory", "prepare", "cutover", "reverse", "status"))
    parser.add_argument("--config", required=True, help="private 0600 JSON configuration")
    parser.add_argument("--before", help="private 0600 read-only before-state JSON, inventory only")
    parser.add_argument("--ready-proof", help="private 0600 readiness JSON, cutover only")
    args = parser.parse_args()
    CURRENT_COMMAND = args.command
    try:
        cfg = load_config(args.config)
        if not os.environ.get("M35_CF_DNS_TOKEN") or not os.environ.get("M35_CF_TUNNEL_TOKEN"):
            raise Refusal("both scoped Cloudflare token environment variables are required")
        with exclusive_lock(cfg):
            if args.command == "inventory":
                if not args.before:
                    raise Refusal("inventory requires --before")
                inventory(cfg, args.before)
            else:
                j = load_journal(cfg)
                if args.command == "prepare":
                    prepare(cfg, j)
                elif args.command == "cutover":
                    if not args.ready_proof:
                        raise Refusal("cutover requires --ready-proof")
                    cutover(cfg, j, args.ready_proof)
                elif args.command == "reverse":
                    reverse(cfg, j)
                else:
                    status(cfg, j)
    except (Refusal, KeyError, IndexError, AttributeError, TypeError, ValueError, OSError) as exc:
        if isinstance(exc, ProviderRefusal):
            diagnostic("hostlet.beta.cloudflare.error/v1", exc.code, exc.method,
                       exc.http_status, attempts=exc.attempts)
        else:
            code = "guard_refusal" if isinstance(exc, Refusal) else "input_or_journal_malformed"
            diagnostic("hostlet.beta.cloudflare.error/v1", code, attempts=0)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
