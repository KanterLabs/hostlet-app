#!/usr/bin/env python3
"""Validate actual harness samples and attach a deterministic evaluation object."""
import argparse, json, math, re
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--receipt", required=True); p.add_argument("--measurement", required=True); p.add_argument("--output", required=True)
a = p.parse_args(); receipt = json.loads(Path(a.receipt).read_text()); value = json.loads(Path(a.measurement).read_text())
digest = re.compile(r"^sha256:[0-9a-f]{64}$")
if receipt.get("schema") != "hostlet.runtime.executor-receipt/v1" or receipt.get("profile") != "owned_fixture_evaluation" or receipt.get("operation") != "validate" or receipt.get("capability_digest") is not None: raise SystemExit("evaluation_receipt_invalid")
for key in ("evaluator_digest", "oci_schema_digest", "unpack_tool_digest"):
    if not digest.fullmatch(value.get(key, "")): raise SystemExit(f"{key}_invalid")
if set(value) != {"evaluator_digest","oci_schema_digest","unpack_tool_digest","patterns","compatibility","performance","network","resources","benchmark"}: raise SystemExit("evaluation_shape_invalid")

def p95(samples):
    if not samples or any(not isinstance(v, (int, float)) or v < 0 for v in samples): raise SystemExit("sample_invalid")
    return sorted(samples)[math.ceil(len(samples) * .95) - 1]

patterns = value.get("patterns", [])
if not patterns or len(patterns) > 8: raise SystemExit("patterns_missing")
required_patterns = set()
for pattern in patterns:
    if set(pattern) != {"framework","node_major","artifact_digest","manifest_digest","build_profile_digest","source_commit","assertions_passed","assertions_total","cold_starts_healthy","cold_starts_total","cold_start_ms","warm_idle_seconds"}: raise SystemExit("pattern_shape_invalid")
    samples = pattern.get("cold_start_ms", [])
    identity = (pattern.get("framework"), pattern.get("node_major"))
    if identity[0] not in ("node_http", "nextjs16_standalone") or identity[1] not in (22, 24): raise SystemExit("pattern_identity_invalid")
    if pattern.get("cold_starts_total") != len(samples) or not 0 < len(samples) <= 100 or pattern.get("assertions_total", 0) <= 0: raise SystemExit("pattern_shape_invalid")
    source = pattern.get("source_commit", "")
    if len(source) not in (40, 64) or any(c not in "0123456789abcdef" for c in source): raise SystemExit("pattern_source_invalid")
    for key in ("artifact_digest", "manifest_digest", "build_profile_digest"):
        if not digest.fullmatch(pattern.get(key, "")): raise SystemExit("pattern_digest_invalid")
    passes = (pattern.get("cold_starts_total", 0) >= 3 and pattern.get("cold_starts_healthy") == pattern.get("cold_starts_total") and
              pattern.get("warm_idle_seconds", 0) >= 60 and pattern.get("assertions_passed") == pattern.get("assertions_total") and
              all(isinstance(sample, int) and 0 <= sample <= 10000 for sample in samples))
    if identity[0] == "node_http" and passes:
        required_patterns.add(identity)
if not {("node_http", 22), ("node_http", 24)}.issubset(required_patterns): raise SystemExit("required_patterns_failed")

bench = value.get("benchmark", {})
if set(bench) != {"baseline_cpu_usec","sandbox_cpu_usec","baseline_peak_memory_bytes","sandbox_peak_memory_bytes","baseline_request_samples_ms","sandbox_request_samples_ms","startup_samples_ms"}: raise SystemExit("benchmark_shape_invalid")
for key in ("baseline_cpu_usec", "sandbox_cpu_usec", "baseline_peak_memory_bytes", "sandbox_peak_memory_bytes"):
    if not isinstance(bench.get(key), int) or bench[key] <= 0: raise SystemExit("benchmark_counter_invalid")
baseline = bench.get("baseline_request_samples_ms", []); sandbox = bench.get("sandbox_request_samples_ms", []); startup = bench.get("startup_samples_ms", [])
baseline_p95 = p95(baseline); sandbox_p95 = p95(sandbox); startup_p95 = p95(startup)
compat = value.get("compatibility", {})
if set(compat) != {"warm_run_seconds","p95_startup_ms","baseline_samples","sandbox_samples","baseline_p95_request_ms","sandbox_p95_request_ms","baseline_throughput_rps","sandbox_throughput_rps"}: raise SystemExit("compatibility_shape_invalid")
if compat.get("warm_run_seconds", 0) < 60: raise SystemExit("compatibility_counts_invalid")
if compat.get("baseline_samples") != len(baseline) or compat.get("sandbox_samples") != len(sandbox): raise SystemExit("compatibility_sample_counts_invalid")
if compat.get("p95_startup_ms") != startup_p95 or compat.get("baseline_p95_request_ms") != baseline_p95 or compat.get("sandbox_p95_request_ms") != sandbox_p95: raise SystemExit("benchmark_p95_mismatch")
if startup_p95 > 5000 or sandbox_p95 > max(2 * baseline_p95, baseline_p95 + 25): raise SystemExit("benchmark_latency_threshold_failed")
def finite_positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0

baseline_throughput = compat.get("baseline_throughput_rps")
sandbox_throughput = compat.get("sandbox_throughput_rps")
if not finite_positive(baseline_throughput) or not finite_positive(sandbox_throughput): raise SystemExit("benchmark_throughput_invalid")
performance = value.get("performance")
if not isinstance(performance, dict) or set(performance) != {"decision","throughput_target_ratio","throughput_target_met","production_ready"}: raise SystemExit("performance_shape_invalid")
if performance.get("decision") != "owned_fixture_only" or performance.get("throughput_target_ratio") != 0.5 or performance.get("production_ready") is not False: raise SystemExit("performance_contract_invalid")
target_met = sandbox_throughput >= baseline_throughput * performance["throughput_target_ratio"]
if performance.get("throughput_target_met") is not target_met: raise SystemExit("performance_throughput_mismatch")
network = value.get("network", {})
if set(network) != {"forbidden_passed","forbidden_total","allowed_passed","allowed_total","independent_observation"}: raise SystemExit("network_shape_invalid")
if network.get("forbidden_total", 0) <= 0 or network.get("forbidden_passed") != network.get("forbidden_total") or network.get("allowed_total", 0) <= 0 or network.get("allowed_passed") != network.get("allowed_total") or network.get("independent_observation") is not True: raise SystemExit("network_evaluation_failed")
resources = value.get("resources", {})
if set(resources) != {"cpu_max","memory_max_bytes","memory_swap_max_bytes","pids_max","scratch_max_bytes","max_connections","new_connections_per_second","new_connections_burst","enforced_reason_codes","restart_delays_seconds","restart_limit","restart_window_seconds","healthy_reset_seconds","idle_stop_observed"}: raise SystemExit("resource_shape_invalid")
expected = {"cpu_max":"25000 100000","memory_max_bytes":536870912,"memory_swap_max_bytes":0,"pids_max":128,"scratch_max_bytes":268435456,"max_connections":128,"new_connections_per_second":20,"new_connections_burst":40,"restart_delays_seconds":[1,2,4,8,16,30],"restart_limit":6,"restart_window_seconds":600,"healthy_reset_seconds":600,"idle_stop_observed":False}
if any(resources.get(k) != v for k, v in expected.items()): raise SystemExit("resource_evaluation_failed")
required_reasons = {"runtime_oom","cpu_throttled","process_limit_exceeded","scratch_limit_exceeded","network_connection_limit","crash_loop_backoff"}
if not required_reasons.issubset(set(resources.get("enforced_reason_codes", []))): raise SystemExit("resource_reasons_missing")
receipt["evaluation"] = value; receipt["result"] = "passed"; receipt["reason_code"] = "runtime_evaluation_passed"
Path(a.output).write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n")
