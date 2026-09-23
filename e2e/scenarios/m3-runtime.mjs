import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createM3RuntimeHarness, RUNTIME_POLICY, RUNTIME_POLICY_DIGEST, RUNSC_SHA256 } from "../support/m3-runtime.mjs";
import { ScenarioExpectationError } from "../support/http-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const M3_RUNTIME_REQUIRED_ASSERTIONS = Object.freeze([
  "M3-RUNTIME-01", "M3-RUNTIME-02", "M3-RUNTIME-03", "M3-RUNTIME-04", "M3-RUNTIME-05",
]);

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

function requirePerformanceAssessment(observed, evaluation) {
  const baselineThroughputRps = Number(observed?.compatibility?.baseline_throughput_rps);
  const sandboxThroughputRps = Number(observed?.compatibility?.sandbox_throughput_rps);
  if (!Number.isFinite(baselineThroughputRps) || baselineThroughputRps <= 0 || !Number.isFinite(sandboxThroughputRps) || sandboxThroughputRps <= 0) {
    throw new Error("runtime performance assessment requires positive finite baseline and sandbox throughput measurements");
  }
  const throughputRatio = sandboxThroughputRps / baselineThroughputRps;
  if (!Number.isFinite(throughputRatio) || throughputRatio <= 0) throw new Error("runtime performance throughput ratio is not positive and finite");
  const throughputTargetRatio = 0.5;
  const throughputTargetMet = throughputRatio >= throughputTargetRatio;
  const expectedFacts = {
    decision: "owned_fixture_only",
    throughput_target_ratio: throughputTargetRatio,
    throughput_target_met: throughputTargetMet,
    production_ready: false,
  };
  const actualFacts = evaluation?.receipt?.evaluation?.performance;
  if (!actualFacts || Object.keys(actualFacts).sort().join(",") !== Object.keys(expectedFacts).sort().join(",") ||
      actualFacts.decision !== expectedFacts.decision || actualFacts.throughput_target_ratio !== expectedFacts.throughput_target_ratio ||
      actualFacts.throughput_target_met !== expectedFacts.throughput_target_met || actualFacts.production_ready !== expectedFacts.production_ready) {
    throw new Error("runtime evaluation performance facts are missing or inconsistent with measured throughput");
  }
  return {
    facts: expectedFacts,
    evidence: {
      baseline_throughput_rps: baselineThroughputRps,
      sandbox_throughput_rps: sandboxThroughputRps,
      throughput_ratio: throughputRatio,
      throughput_target_ratio: throughputTargetRatio,
      status: throughputTargetMet ? "met" : "deferred",
      scope: "owned_fixture_only",
      customer_admission_enabled: false,
      production_ready: false,
    },
  };
}

async function step(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M3 actual gVisor runtime isolation and enforcement", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(id, "M3 actual gVisor runtime isolation and enforcement", expected, safeObserved(error), false, error instanceof ScenarioExpectationError ? error.check : error.message);
    throw error;
  }
}

function requireRuntimeInputs(m3) {
  const inputs = m3.state.runtimeEvaluationInputs;
  if (!inputs || !inputs.nodeBaseRoots || !inputs.tenantPeers) {
    throw new Error("M3 runtime requires real build outputs, exported Node base rootfs directories and tenant peer inventory");
  }
  return { ...inputs, buildOutputs: inputs.buildOutputs ?? m3.state.buildOutputs };
}

export async function runM3RuntimeScenarios(context, m3, options = {}) {
  if (options.releaseDiagnostic === true && context.state.configuration.scenarios.includes("m3-journey")) {
    throw new Error("the full M3 journey cannot omit runtime acceptance checks");
  }
  context.registerFixture("M3 runtime E2E scenario", "e2e/scenarios/m3-runtime.mjs");
  context.registerFixture("M3 runtime E2E support", "e2e/support/m3-runtime.mjs");
  context.registerFixture("M3 policy probe resource fixture", "e2e/fixtures/m3/policy-probes/server.mjs");
  for (const path of ["scripts/runtime/hostlet-runtime-launcher", "scripts/runtime/hostlet-runtime-peer", "scripts/runtime/hostlet-runtime-fixture-peer", "scripts/runtime/hostlet-runtime-cleanup", "scripts/runtime/hostlet-runtime-migration-probe.py", "scripts/runtime/hostlet-runtime-relay.py", "scripts/runtime/prepare-artifact.py", "scripts/runtime/finalize-runtime-evaluation.py", "docs/M3-RUNTIME.md", "docs/M3-RUNTIME-CONTROL.md"]) context.registerFixture(`M3 runtime boundary: ${path}`, path);
  const inputs = options.inputs ?? requireRuntimeInputs(m3);
  for (const key of ["node22_api", "fullstack_v2", "next16", "policy_probes", "crash_runtime"]) {
    if (!inputs.buildOutputs?.[key] && !inputs.buildOutputs?.has?.(key)) {
      if (typeof m3.state.m3Build?.buildFixture !== "function") throw new Error(`M3 runtime requires the real ${key} build output`);
      await m3.state.m3Build.buildFixture(key);
    }
  }
  const runtimeInputs = { ...inputs, buildOutputs: m3.state.buildOutputs ?? inputs.buildOutputs };
  const runtime = createM3RuntimeHarness(context, m3, { ...options, artifactRoot: options.artifactRoot });
  await runtime.initialize();
  m3.state.runtime = runtime;

  const installRuntimeIntegrations = () => {
    m3.state.runtimeDatabaseProbe = runtime.runtimeDatabaseProbe;
    m3.state.runtimeReadOnlyDatabaseProbe = runtime.runtimeReadOnlyDatabaseProbe;
    m3.state.pauseRuntimeDatabasePeer = runtime.pauseDatabasePeer;
    m3.state.evaluateRuntimeRelease = runtime.evaluateRelease;
    m3.state.launchProbeAgainstDatabase = runtime.launchProbeAgainstDatabase;
  };

  const raw = await runtime.exerciseRuntimeEvaluation({ buildOutputs: runtimeInputs.buildOutputs, tenantPeers: runtimeInputs.tenantPeers, nodeBaseRoots: runtimeInputs.nodeBaseRoots });
  const observed = runtime.finalizeObservedEvaluation(raw);
  const evaluation = await runtime.registerEvaluation(observed);
  const performanceAssessment = requirePerformanceAssessment(observed, evaluation);
  if (options.releaseDiagnostic === true) {
    installRuntimeIntegrations();
    writeFileSync(join(context.artifactDir, "m3-runtime-release-diagnostic.json"), `${JSON.stringify({
      schema: "hostlet.m3-runtime-release-diagnostic/v1",
      diagnostic: true,
      runsc_sha256: RUNSC_SHA256,
      evaluation,
      observations: observed,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    m3.state.runtimeEvidence = Object.freeze({ evaluation, observations: observed, diagnostic: true });
    return m3.state.runtimeEvidence;
  }
  const policyBuildRaw = raw.buildOutputs instanceof Map ? raw.buildOutputs.get("policy_probes") : raw.buildOutputs.policy_probes;
  const policyBuild = Array.isArray(policyBuildRaw) ? policyBuildRaw.find((value) => value.kind === "application") : policyBuildRaw;
  const node22BuildRaw = raw.buildOutputs instanceof Map ? raw.buildOutputs.get("node22_api") : raw.buildOutputs.node22_api;
  const node22Build = Array.isArray(node22BuildRaw) ? node22BuildRaw.find((value) => value.kind === "application") : node22BuildRaw;
  const secondaryEvaluationIdentity = raw.policyEvaluationIdentities?.at(-1);
  const crashEvaluationIdentity = raw.policyEvaluationIdentities?.[0];
  if (!secondaryEvaluationIdentity || !crashEvaluationIdentity) throw new Error("runtime enforcement requires two spare evaluator identities for the measured policy probe artifact");
  const secondaryEvaluation = await runtime.registerEvaluation({ ...observed, evaluationIdentity: secondaryEvaluationIdentity });
  const crashEvaluation = await runtime.registerEvaluation({ ...observed, evaluationIdentity: crashEvaluationIdentity });
  const admittedEnforcement = await runtime.exerciseAdmittedEnforcement({ buildOutputs: raw.buildOutputs, policyBuild, node22Build, evaluationId: evaluation.id, memoryEvaluationId: secondaryEvaluation.id, crashEvaluationId: crashEvaluation.id, isolationFixtures: raw.isolationFixtures });
  const nextBuildRaw = raw.buildOutputs instanceof Map ? raw.buildOutputs.get("next16") : raw.buildOutputs.next16;
  const nextBuild = Array.isArray(nextBuildRaw) ? nextBuildRaw.find((value) => value.kind === "application") : nextBuildRaw;
  const nextAdmission = await m3.roleInternal("runtime", "/internal/v1/runtime/allocations", { method: "POST", body: { build_job_id: nextBuild.buildJobId, artifact_id: nextBuild.artifactId, evaluation_id: evaluation.id } });
  const nextPattern = observed.patterns.find((value) => value.key === "next16");
  const nextSupported = nextPattern?.assertions_passed === nextPattern?.assertions_total && nextPattern?.cold_starts_healthy === nextPattern?.cold_starts_total && nextPattern?.cold_starts_total >= 3 && nextPattern?.warm_idle_seconds >= 60;
  const nextDeferred = !nextSupported && nextPattern?.admission_rejected === true && nextPattern?.cold_starts_total >= 3 && nextPattern?.assertions_passed < nextPattern?.assertions_total && nextAdmission.status === 409 && nextAdmission.payload?.error?.code === "runtime_allocation_ineligible";
  if ((nextSupported && ![200, 201].includes(nextAdmission.status)) || (!nextSupported && !nextDeferred)) throw new Error("Next admission did not follow its observed runtime evidence");

  await step(context, "M3-RUNTIME-01", "actual evaluated gVisor runs Node 22, Node 24, and Next 16 with measured compatibility or fail-closed Next admission, while the throughput decision remains explicitly owned-fixture-only", async () => {
    const byKey = new Map(observed.patterns.map((value) => [value.key, value]));
    if (byKey.get("node22_api")?.cold_starts_healthy !== 3 || byKey.get("fullstack_v1")?.cold_starts_healthy !== 3 || byKey.get("fullstack_v2")?.cold_starts_healthy !== 3 || (!nextSupported && !nextDeferred) || observed.compatibility.warm_run_seconds < 60 || observed.compatibility.p95_startup_ms > 5_000 || observed.compatibility.baseline_samples < 1 || observed.compatibility.sandbox_samples < 1) throw new Error("runtime compatibility measurements are incomplete or outside the accepted bound");
    return {
      runsc_sha256: RUNSC_SHA256,
      node22_cold_starts: byKey.get("node22_api")?.cold_starts_healthy,
      node24_cold_starts: byKey.get("fullstack_v1")?.cold_starts_healthy,
      next16_cold_starts: byKey.get("next16")?.cold_starts_healthy,
      next16_admission: byKey.get("next16")?.assertions_passed === byKey.get("next16")?.assertions_total ? "supported" : "observed_failure_rejected",
      next16_admission_status: nextAdmission.status,
      next16_explicit_deferral: nextDeferred,
      next16_unmet_requirements: byKey.get("next16")?.unmet_requirements ?? [],
      warm_idle_seconds: observed.compatibility.warm_run_seconds,
      p95_startup_ms: observed.compatibility.p95_startup_ms,
      baseline_samples: observed.compatibility.baseline_samples,
      sandbox_samples: observed.compatibility.sandbox_samples,
      performance_facts: performanceAssessment.facts,
      performance: performanceAssessment.evidence,
    };
  });

  await step(context, "M3-RUNTIME-02", "inside-sandbox and independent observations prove every declared IPv4, IPv6, DNS, host, peer, builder, Docker, platform, and metadata decision", async () => {
    if (observed.network.forbidden_total < 1 || observed.network.forbidden_passed !== observed.network.forbidden_total || observed.network.allowed_total < 1 || observed.network.allowed_passed !== observed.network.allowed_total || !observed.network.independent_observation || !(raw.network.forbidden_packets > 0)) throw new Error("runtime network isolation evidence did not prove every declared decision");
    return { forbidden_passed: observed.network.forbidden_passed, forbidden_total: observed.network.forbidden_total, allowed_passed: observed.network.allowed_passed, allowed_total: observed.network.allowed_total, independent_observation: observed.network.independent_observation, forbidden_packets: raw.network.forbidden_packets, probe_kinds: raw.network.probe_kinds };
  });

  await step(context, "M3-RUNTIME-03", "actual CPU, memory, scratch, PID, connection and crash probes observe exact limits and bounded reasons without starving the peer tenant or control", async () => {
    const requiredReasons = ["cpu_throttled", "runtime_oom", "scratch_limit_exceeded", "process_limit_exceeded", "network_connection_limit", "crash_loop_backoff"];
    const oracles = raw.resources.enforcement_oracles;
    const ownerObservations = admittedEnforcement?.owner_observations ?? [];
    const ownerReasons = new Set(ownerObservations.flatMap((entry) => entry.observations?.map((value) => value.reason_code) ?? []));
    const ownerEvidenceExact = ownerObservations.length >= 6 && ownerObservations.every((entry) => entry.observations?.every((value) => value.allocation_id === entry.allocation_id && value.generation === entry.generation) && entry.observations?.some((value) => value.reason_code === entry.expected_reason));
    const processMemoryEvents = oracles?.processes?.memory_events;
    const processCodeObserved = Array.isArray(oracles?.processes?.error_codes) && oracles.processes.error_codes.some((code) => code === "EAGAIN" || code === "ENOMEM");
    const processStructuredResponse = oracles?.processes?.http_status === 200 && oracles.processes.failed > 0 && processCodeObserved;
    const processStoppedReceipt = oracles?.processes?.request_failed === true && oracles.processes.http_status === null && oracles.processes.receipt_status === "stopped" && oracles.processes.runsc_status === null && oracles.processes.inspect_receipt_status === "stopped" && oracles.processes.inspect_runsc_status === "stopped" && /^sha256:[0-9a-f]{64}$/.test(oracles.processes.stop_receipt_digest ?? "") && oracles.processes.stop_receipt_digest === oracles.processes.receipt_digest;
    const processPidBounded = oracles?.processes?.pids_max === RUNTIME_POLICY.pids && oracles.processes.pids_max_events > 0;
    const processNoOom = processMemoryEvents?.max === 0 && processMemoryEvents?.oom === 0 && processMemoryEvents?.oom_kill === 0;
    const memoryRestart = raw.resources?.memory_restart_freshness;
    const memoryRestartFresh = /^sha256:[0-9a-f]{64}$/.test(memoryRestart?.previous_oom_receipt_digest ?? "") && memoryRestart?.previous_oom_reason_code === "runtime_oom" && memoryRestart?.previous_oom_memory_events?.oom_kill > 0 && typeof memoryRestart?.previous_cgroup_path === "string" && typeof memoryRestart?.fresh_cgroup_path === "string" && memoryRestart.previous_cgroup_path !== memoryRestart.fresh_cgroup_path && Number.isInteger(memoryRestart.previous_cgroup_epoch) && Number.isInteger(memoryRestart.fresh_cgroup_epoch) && memoryRestart.fresh_cgroup_epoch > memoryRestart.previous_cgroup_epoch && /^sha256:[0-9a-f]{64}$/.test(memoryRestart?.reconcile_receipt_digest ?? "") && memoryRestart.reconcile_status === "restart_scheduled" && memoryRestart.reconcile_reason_code === "runtime_oom" && /^sha256:[0-9a-f]{64}$/.test(memoryRestart?.fresh_receipt_digest ?? "") && !["runtime_oom", "process_limit_exceeded"].includes(memoryRestart.fresh_reason_code) && memoryRestart.limits_match === true && memoryRestart.fresh_memory_events?.max === 0 && memoryRestart.fresh_memory_events?.oom === 0 && memoryRestart.fresh_memory_events?.oom_kill === 0 && memoryRestart.fresh_pids_events?.max === 0 && Number.isFinite(memoryRestart.healthy_observed_elapsed_ms) && memoryRestart.healthy_observed_elapsed_ms <= 5_000 && Number.isFinite(memoryRestart.restart_poll_elapsed_ms) && memoryRestart.restart_poll_elapsed_ms <= 5_000;
    const restartDelayMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    const crashRestartAttempts = oracles?.crash_restart?.attempts;
    const crashRestartSchedule = Array.isArray(crashRestartAttempts) && crashRestartAttempts.length === 7 && crashRestartAttempts.slice(0, 6).every((value, index) => /^sha256:[0-9a-f]{64}$/.test(value?.receipt_digest ?? "") && value.status === "restart_scheduled" && value.expected_delay_ms === restartDelayMs[index] && Number.isFinite(value.elapsed_ms) && value.elapsed_ms + 50 >= value.expected_delay_ms && value.elapsed_ms <= 45_000) && /^sha256:[0-9a-f]{64}$/.test(crashRestartAttempts[6]?.receipt_digest ?? "") && crashRestartAttempts[6].status === "crash_loop_backoff" && crashRestartAttempts[6].expected_delay_ms === 0 && Number.isFinite(crashRestartAttempts[6].elapsed_ms) && crashRestartAttempts[6].elapsed_ms <= 45_000;
    const admittedPidEvidence = admittedEnforcement?.pressure_evidence?.find((value) => value.mode === "processes");
    const admittedPidStopReceipt = admittedPidEvidence?.stopped_observation !== true || (admittedPidEvidence.receipt_status === "stopped" && admittedPidEvidence.runsc_status === null && admittedPidEvidence.inspect_receipt_status === "stopped" && admittedPidEvidence.inspect_runsc_status === "stopped" && /^sha256:[0-9a-f]{64}$/.test(admittedPidEvidence.stop_receipt_digest ?? "") && admittedPidEvidence.stop_receipt_digest === admittedPidEvidence.receipt_digest);
    const admittedPidOwnerStopped = admittedPidEvidence?.stopped_observation !== true || ownerObservations.some((entry) => entry.mode === "processes" && entry.observations?.some((value) => value.state === "stopped" && value.reason_code === "process_limit_exceeded"));
    const admittedCrashAttempts = admittedEnforcement?.pressure_evidence?.find((value) => value.mode === "crash")?.attempts;
    const admittedCrashSchedule = Array.isArray(admittedCrashAttempts) && admittedCrashAttempts.length === 7 && admittedCrashAttempts.slice(0, 6).every((value, index) => /^sha256:[0-9a-f]{64}$/.test(value?.receipt_digest ?? "") && value.status === "restart_scheduled" && value.expected_delay_ms === restartDelayMs[index] && Number.isFinite(value.elapsed_ms) && value.elapsed_ms + 50 >= value.expected_delay_ms && value.elapsed_ms <= 45_000) && /^sha256:[0-9a-f]{64}$/.test(admittedCrashAttempts[6]?.receipt_digest ?? "") && admittedCrashAttempts[6].status === "crash_loop_backoff" && admittedCrashAttempts[6].expected_delay_ms === 0 && Number.isFinite(admittedCrashAttempts[6].elapsed_ms) && admittedCrashAttempts[6].elapsed_ms <= 45_000;
    const cleanupOracles = raw.resources?.cleanup_oracles;
    const cleanupReceiptPasses = (value, digest, operation, result, status) => value && /^sha256:[0-9a-f]{64}$/.test(digest ?? "") && operation === "cleanup" && result === "passed" && status === "cleaned" && value.sandbox_absent === true && value.application_namespace_absent === true && value.gateway_namespace_absent === true && value.cgroup_absent === true && value.mounts_absent === true && value.state_retained === false;
    const cleanupOraclesPass = cleanupReceiptPasses(cleanupOracles?.first, cleanupOracles?.first_receipt_digest, cleanupOracles?.first_operation, cleanupOracles?.first_result, cleanupOracles?.first_status) && cleanupReceiptPasses(cleanupOracles?.replay, cleanupOracles?.replay_receipt_digest, cleanupOracles?.replay_operation, cleanupOracles?.replay_result, cleanupOracles?.replay_status);
    const cleanupObservationNegative = admittedEnforcement?.cleanup_observation_negative;
    const cleanupObservationNegativePass = UUID.test(cleanupObservationNegative?.allocation_id ?? "") && Number.isInteger(cleanupObservationNegative?.generation) && Number.isInteger(cleanupObservationNegative?.fence) && /^sha256:[0-9a-f]{64}$/.test(cleanupObservationNegative?.source_cleanup_receipt_digest ?? "") && /^sha256:[0-9a-f]{64}$/.test(cleanupObservationNegative?.mounts_false?.receipt_digest ?? "") && cleanupObservationNegative.mounts_false.status === 409 && cleanupObservationNegative.mounts_false.error_code === "runtime_observation_mismatch" && /^sha256:[0-9a-f]{64}$/.test(cleanupObservationNegative?.mounts_missing?.receipt_digest ?? "") && cleanupObservationNegative.mounts_missing.status === 422 && cleanupObservationNegative.mounts_missing.error_code === "runtime_receipt_invalid" && cleanupObservationNegative.durable_unchanged === true;
    const actualOracles = oracles?.cpu?.reason_code === "cpu_throttled" && oracles.cpu.nr_throttled > 0 && oracles?.scratch?.failed === true && oracles.scratch.error_code === "ENOSPC" && oracles?.connections?.reason_code === "network_connection_limit" && oracles.connections.limited_packets > 0 && oracles?.processes?.reason_code === "process_limit_exceeded" && (processStructuredResponse || processStoppedReceipt) && processPidBounded && processNoOom && memoryRestartFresh && crashRestartSchedule && admittedCrashSchedule && cleanupOraclesPass && cleanupObservationNegativePass && admittedPidStopReceipt && admittedPidOwnerStopped && oracles?.request_validation?.malformed_rejected === true && oracles.request_validation.over_limit_rejected === true;
    if (observed.resources.cpu_max !== "25000 100000" || observed.resources.memory_max_bytes !== RUNTIME_POLICY.memory_bytes || observed.resources.pids_max !== RUNTIME_POLICY.pids || observed.resources.scratch_max_bytes !== RUNTIME_POLICY.scratch_bytes || observed.resources.max_connections !== RUNTIME_POLICY.max_connections || requiredReasons.some((reason) => !observed.resources.enforced_reason_codes.includes(reason)) || !actualOracles || !raw.resources.peer_healthy_during_pressure || !raw.resources.control_healthy_during_pressure || !ownerEvidenceExact || requiredReasons.some((reason) => !ownerReasons.has(reason))) throw new Error("runtime resource enforcement evidence is incomplete");
    return { policy_digest: RUNTIME_POLICY_DIGEST, cpu_max: observed.resources.cpu_max, memory_max_bytes: observed.resources.memory_max_bytes, pids_max: observed.resources.pids_max, scratch_max_bytes: observed.resources.scratch_max_bytes, max_connections: observed.resources.max_connections, reasons: observed.resources.enforced_reason_codes, enforcement_oracles: oracles, memory_restart_freshness: memoryRestart, crash_restart_schedule: crashRestartAttempts, admitted_crash_schedule: admittedCrashAttempts, cleanup_oracles: cleanupOracles, cleanup_observation_negative: cleanupObservationNegative, owner_observations: ownerObservations, owner_executor_receipt_digests: admittedEnforcement.executor_receipt_digests, restart_delays_seconds: observed.resources.restart_delays_seconds, peer_healthy_during_pressure: raw.resources.peer_healthy_during_pressure, control_healthy_during_pressure: raw.resources.control_healthy_during_pressure };
  });

  const allocations = new Map();
  for (const [key, rawBuild] of (raw.buildOutputs instanceof Map ? raw.buildOutputs : Object.entries(raw.buildOutputs))) {
    if (!["node22_api", "fullstack_v1", "fullstack_v2"].includes(key)) continue;
    const pattern = observed.patterns.find((value) => value.key === key);
    if (pattern && pattern.assertions_passed !== pattern.assertions_total) continue;
    const build = Array.isArray(rawBuild) ? rawBuild.find((value) => value.kind === "application") : rawBuild;
    allocations.set(key, await runtime.allocate(build, evaluation.id));
  }

  const postCapability = await runtime.exercisePostCapability({ evaluation, observations: observed, allocations, buildOutputs: raw.buildOutputs, tenantPeers: runtimeInputs.tenantPeers });

  await step(context, "M3-RUNTIME-04", "the same durable allocation and database stay healthy for at least 60 real seconds across idle scheduler activity, build exhaustion, stale completion, runtime/API restart", async () => {
    const continuity = postCapability.continuity;
    if (!continuity || continuity.real_observation_seconds < 60 || continuity.idle_stop_observed || !continuity.runtime_restart_preserved || !continuity.same_allocation_after_restart || !continuity.database_read_write_after_restart || !continuity.build_exhaustion_ignored || !continuity.stale_worker_fenced || !continuity.api_restart_preserved) throw new Error("runtime continuity evidence is incomplete");
    return continuity;
  });

  await step(context, "M3-RUNTIME-05", "missing, mismatched, expired, failed and inconsistent performance assessment evidence reject evaluation or allocation without allocation side effects; the owned fixture uses the recorded capability and customer admission stays disabled", async () => {
    if (!postCapability.admission || Object.values(postCapability.admission).some((value) => value !== true)) throw new Error("runtime fail-closed admission matrix is incomplete");
    const fullstackRaw = raw.buildOutputs instanceof Map ? raw.buildOutputs.get("fullstack_v1") : raw.buildOutputs?.fullstack_v1;
    const fullstackBuild = Array.isArray(fullstackRaw) ? fullstackRaw.find((value) => value?.kind === "application") : fullstackRaw;
    if (!fullstackBuild?.buildJobId || !fullstackBuild?.artifactId) throw new Error("runtime performance negatives require the exact succeeded fullstack application artifact");
    if (typeof runtime.registerEvaluationVariant !== "function") throw new Error("runtime support must export registerEvaluationVariant for real performance assessment negatives");
    const basePerformance = performanceAssessment.facts;
    const baseCompatibility = structuredClone(evaluation.receipt?.evaluation?.compatibility ?? observed.compatibility);
    const negativeCases = [
      { key: "missing_assessment", omitPerformance: true, registration: "invalid" },
      { key: "unknown_scope", performance: { ...basePerformance, decision: "unknown_scope" }, registration: "invalid" },
      { key: "changed_target", performance: { ...basePerformance, throughput_target_ratio: 0.75 }, registration: "invalid" },
      { key: "prodreadytrue", performance: { ...basePerformance, production_ready: true }, registration: "invalid" },
      { key: "mismatched_target_met", performance: { ...basePerformance, throughput_target_met: !basePerformance.throughput_target_met }, registration: "invalid" },
      { key: "invalid_throughput", compatibility: { ...baseCompatibility, baseline_throughput_rps: 0, sandbox_throughput_rps: -1 }, performance: { ...basePerformance, throughput_target_met: false }, registration: "invalid" },
    ];
    const uuidLiteral = (value, label) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${label} is not a UUID`);
      return `'${value}'::uuid`;
    };
    const allocationCounts = (label) => m3.postgres.psqlJson(label, `SELECT json_build_object(
      'total',(SELECT COUNT(*)::int FROM runtime_allocations),
      'exact',(SELECT COUNT(*)::int FROM runtime_allocations WHERE build_job_id=${uuidLiteral(fullstackBuild.buildJobId, "build job")} AND artifact_id=${uuidLiteral(fullstackBuild.artifactId, "artifact")})
    );`);
    const negativeEvidence = [];
    for (const candidate of negativeCases) {
      const before = await allocationCounts(`m3-runtime-performance-negative-${candidate.key}-before`);
      const variant = await runtime.registerEvaluationVariant({
        buildOutput: fullstackBuild,
        templateReceipt: evaluation.receipt,
        omitPerformance: candidate.omitPerformance === true,
        performance: candidate.performance,
        compatibility: candidate.compatibility,
      });
      const registration = variant?.registration ?? variant?.response ?? variant;
      const registrationCode = registration?.payload?.error?.code ?? null;
      const schemaRejected = registration?.status === 422 && registrationCode === "runtime_evidence_invalid";
      if (!schemaRejected) throw new Error(`runtime performance negative ${candidate.key} did not reject at the expected evaluation boundary`);
      const evaluationId = randomUUID();
      const allocationAttempt = await m3.roleInternal("runtime", "/internal/v1/runtime/allocations", {
        method: "POST", body: { build_job_id: fullstackBuild.buildJobId, artifact_id: fullstackBuild.artifactId, evaluation_id: evaluationId },
      });
      if (allocationAttempt.status !== 409 || allocationAttempt.payload?.error?.code !== "runtime_allocation_ineligible") throw new Error(`runtime performance negative ${candidate.key} unexpectedly admitted an allocation`);
      const after = await allocationCounts(`m3-runtime-performance-negative-${candidate.key}-after`);
      if (before.total !== after.total || before.exact !== after.exact) throw new Error(`runtime performance negative ${candidate.key} changed durable allocations`);
      negativeEvidence.push({ key: candidate.key, registration_status: registration.status, registration_code: registrationCode, allocation_status: allocationAttempt.status, allocation_code: allocationAttempt.payload?.error?.code, allocations_before: before, allocations_after: after });
    }
    return { ...postCapability.admission, capability_digest: evaluation.capability_digest, evidence_digest: evaluation.evidenceDigest, performance: performanceAssessment.evidence, customer_admission_enabled: false, allocated_profiles: [...allocations].map(([key, value]) => ({ key, allocation_id: value.id, profile: value.profile })), performance_negative_cases: negativeEvidence };
  });

  const evidence = {
    schema: "hostlet.m3-runtime-e2e/v1", runsc_sha256: RUNSC_SHA256,
    policy: RUNTIME_POLICY, policy_digest: RUNTIME_POLICY_DIGEST,
    evidence_digest: evaluation.evidenceDigest, capability_digest: evaluation.capability_digest,
    evaluation_id: evaluation.id,
    patterns: observed.patterns.map(({ key, framework, node_major, artifact_digest, manifest_digest, build_profile_digest, source_commit, assertions_passed, assertions_total, cold_starts_healthy, cold_starts_total, cold_start_ms, warm_idle_seconds }) => ({ key, framework, node_major, artifact_digest, manifest_digest, build_profile_digest, source_commit, assertions_passed, assertions_total, cold_starts_healthy, cold_starts_total, cold_start_ms, warm_idle_seconds })),
    compatibility: observed.compatibility, performance: performanceAssessment.evidence, performance_facts: performanceAssessment.facts, network: observed.network, resources: observed.resources, admitted_enforcement: admittedEnforcement,
    allocations: [...allocations].map(([key, value]) => ({ key, allocation_id: value.id, generation: value.generation, fence: value.fence, artifact_digest: value.artifact_digest, profile: value.profile })),
  };
  writeFileSync(join(context.artifactDir, "m3-runtime-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  m3.state.runtimeEvidence = Object.freeze({ evaluation, allocations, evidence });
  installRuntimeIntegrations();
  return m3.state.runtimeEvidence;
}

async function runScenario(context) {
  const { runM3Context } = await import("../support/m3-context.mjs");
  await runM3Context(context, async (m3) => runM3RuntimeScenarios(context, m3));
}

export const scenario = Object.freeze({
  id: "m3-runtime",
  description: "M3 actual gVisor runtime evaluation, evidence-gated allocation, isolation, enforcement, continuity and fail-closed admission",
  requiredAssertions: M3_RUNTIME_REQUIRED_ASSERTIONS,
  run: runScenario,
});
