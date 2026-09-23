import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerM3BuildFixtures } from "../support/m3-build.mjs";
import { runM3Context } from "../support/m3-context.mjs";
import { createM3RuntimeHarness, RUNTIME_POLICY, RUNSC_SHA256 } from "../support/m3-runtime.mjs";
import { runM3BuildScenarios } from "./m3-build.mjs";
import { M3_UPGRADE_REQUIRED_ASSERTIONS } from "./m3-upgrade.mjs";

const ASSERTION = "M3-RUNTIME-PRESSURE-DEVELOPMENT";
const RESPONSE_TEXT_LIMIT = 4_096;
const RELAY_TIMEOUT_MS = 15_000;
const RESTART_STARTUP_DEADLINE_MS = 5_000;
const RESTART_STARTUP_POLL_MS = 100;

function oneApplication(value) {
  const candidates = Array.isArray(value) ? value : [value];
  const application = candidates.find((candidate) => candidate?.kind === "application");
  if (!application) throw new Error("policy probe development build emitted no application artifact");
  return application;
}

function safeErrorText(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, RESPONSE_TEXT_LIMIT);
}

async function relayJson(relay, path, { method = "GET", body } = {}, signal) {
  const response = await fetch(`http://127.0.0.1:${relay.port}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.any([AbortSignal.timeout(RELAY_TIMEOUT_MS), signal]),
  });
  const raw = await response.text();
  const text = raw.slice(0, RESPONSE_TEXT_LIMIT);
  let payload = null;
  try { payload = raw.length <= RESPONSE_TEXT_LIMIT ? JSON.parse(raw) : null; } catch {}
  return { status: response.status, payload, text };
}

function responseEvidence(response) {
  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    payload: response?.payload ?? null,
    safe_error_text: typeof response?.text === "string" ? response.text.slice(0, RESPONSE_TEXT_LIMIT) : null,
  };
}

function requestErrorEvidence(error) {
  return { status: null, payload: null, safe_error_text: safeErrorText(error) };
}

function executorEvidence(invocation) {
  return {
    receipt_digest: invocation?.digest ?? null,
    reason_code: invocation?.receipt?.reason_code ?? null,
    receipt: invocation?.receipt ?? null,
    observed_limits: invocation?.receipt?.observed_limits ?? null,
  };
}

function ownedCgroupState(observedLimits, allocation, label) {
  const identityHash = createHash("sha256")
    .update(`${allocation.id}:${allocation.generation}:${allocation.fence}`)
    .digest("hex")
    .slice(0, 16);
  const path = observedLimits?.cgroup_path;
  const match = new RegExp(`^/hostlet-owned-runtime-${identityHash}-e([1-9][0-9]*)$`).exec(path ?? "");
  if (!match) throw new Error(`${label} cgroup receipt is not an owned epoch path`);
  const state = {
    schema: "hostlet.runtime.cgroup-state/v1",
    allocation_id: allocation.id,
    generation: allocation.generation,
    fence: allocation.fence,
    identity_hash: identityHash,
    cgroup_path: path,
    cgroup_epoch: Number(match[1]),
    source: "executor_receipt.observed_limits.cgroup_path",
  };
  if (
    state.allocation_id !== allocation.id ||
    state.generation !== allocation.generation ||
    state.fence !== allocation.fence ||
    state.identity_hash !== identityHash ||
    state.cgroup_path !== `/hostlet-owned-runtime-${identityHash}-e${state.cgroup_epoch}` ||
    !Number.isInteger(state.cgroup_epoch) ||
    state.cgroup_epoch < 1
  ) throw new Error(`${label} cgroup state is not an owned epoch record`);
  return state;
}

async function runRuntimePressureDevelopment(context) {
  context.registerFixture("M3 runtime pressure development scenario", "e2e/scenarios/m3-runtime-pressure-development.mjs");
  context.registerFixture("M3 runtime support", "e2e/support/m3-runtime.mjs");
  for (const path of [
    "scripts/runtime/hostlet-runtime-launcher",
    "scripts/runtime/hostlet-runtime-cleanup",
    "scripts/runtime/hostlet-runtime-relay.py",
    "scripts/runtime/prepare-artifact.py",
  ]) context.registerFixture(`M3 runtime pressure boundary: ${path}`, path);
  registerM3BuildFixtures(context);

  await runM3Context(context, async (m3) => {
    // This intentionally runs only the retained upgrade, BUILD-01/02
    // development subset, one policy-probe build, and one disposable owned
    // sandbox. It is diagnostic evidence and cannot satisfy M3-RUNTIME-01..05.
    await runM3BuildScenarios(m3, { developmentBuildsOnly: true });
    const built = await m3.state.m3Build.buildFixture("policy_probes");
    const buildOutput = oneApplication(built.outputs ?? m3.state.buildOutputs.policy_probes);
    const nodeBaseRoots = { 24: join(context.repo, ".local/m3-assets/node24/runtime-base/rootfs") };
    const runtime = createM3RuntimeHarness(context, m3);
    await runtime.initialize();

    const evidencePath = join(context.artifactDir, "m3-runtime-pressure-development.json");
    const evidence = {
      schema: "hostlet.m3-runtime-pressure-development/v1",
      diagnostic_only: true,
      production_capability_registered: false,
      runsc_sha256: RUNSC_SHA256,
      policy: {
        cpu_quota_micros: RUNTIME_POLICY.cpu_quota_micros,
        cpu_period_micros: RUNTIME_POLICY.cpu_period_micros,
        pids_max: RUNTIME_POLICY.pids,
        scratch_bytes: RUNTIME_POLICY.scratch_bytes,
      },
      pressure: [],
    };
    const persistEvidence = () => writeFileSync(
      evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    let entry;
    let relayMapPath;
    let memoryEntry;
    let memoryRelayMapPath;
    try {
      const assembled = await runtime.assembleArtifacts(new Map([["policy_probes", buildOutput]]), nodeBaseRoots);
      const runtimeBuild = assembled.get("policy_probes");
      evidence.build = {
        build_job_id: runtimeBuild?.buildJobId ?? null,
        artifact_id: runtimeBuild?.artifactId ?? null,
        archive_digest: runtimeBuild?.archiveDigest ?? null,
        build_manifest_digest: runtimeBuild?.manifestDigest ?? null,
        runtime_tree_digest: runtimeBuild?.runtimeTreeDigest ?? null,
        base_rootfs_digest: runtimeBuild?.runtimeManifest?.base_rootfs_digest ?? null,
        runtime_manifest_schema: runtimeBuild?.runtimeManifest?.schema ?? null,
      };
      persistEvidence();
      if (
        runtimeBuild?.nodeMajor !== 24 ||
        runtimeBuild.framework !== "node_http" ||
        runtimeBuild.runtimeManifest?.schema !== "hostlet.runtime-artifact/v1" ||
        !existsSync(runtimeBuild.runtimeRootfs)
      ) throw new Error("verified Node 24 policy-probe runtime artifact was not assembled through the private HCA/base boundary");

      entry = await runtime.launchDiagnosticBootstrap({ buildOutput: runtimeBuild, index: 1 });
      relayMapPath = entry.relay.mapPath;
      evidence.runtime = {
        allocation_id: entry.allocation.id,
        generation: entry.allocation.generation,
        fence: entry.allocation.fence,
        profile: entry.allocation.profile,
        capability_digest: entry.allocation.capability_digest,
        prepare_receipt_digest: entry.prepared.digest,
        start_receipt_digest: entry.started.digest,
        initial_inspect_receipt_digest: entry.inspected.digest,
        initial_health_passing: entry.inspected.receipt?.health?.passing === true,
      };
      persistEvidence();

      for (const probe of [
        { mode: "cpu", amount: 2_000 },
        { mode: "scratch", amount: 300 },
        { mode: "processes", amount: 160 },
      ]) {
        const record = { mode: probe.mode, request: probe, response: null, request_failed: false, executor_inspect: null };
        let requestError = null;
        try {
          const response = await relayJson(entry.relay, "/probe/resource", { method: "POST", body: probe }, context.abortSignal);
          record.response = responseEvidence(response);
        } catch (error) {
          requestError = error;
          record.response = requestErrorEvidence(error);
        }
        record.request_failed = Boolean(requestError);
        evidence.pressure.push(record);
        // Preserve the exact bounded relay response before inspecting or
        // asserting its status. A 500 body is diagnostic evidence and remains
        // a failure below.
        persistEvidence();

        let inspectError = null;
        try {
          const inspection = await runtime.invoke(entry.allocation, "inspect", {
            network: entry.network,
            secret_version_refs: entry.secretVersionRefs,
            environment: entry.environment,
          });
          record.executor_inspect = executorEvidence(inspection);
        } catch (error) {
          inspectError = error;
          record.executor_inspect_error = safeErrorText(error);
        }
        persistEvidence();

        if (probe.mode === "scratch") {
          try {
            const cleanupResponse = await relayJson(entry.relay, "/probe/resource", {
              method: "POST",
              body: { mode: "scratch_cleanup", amount: 0 },
            }, context.abortSignal);
            record.scratch_cleanup_response = responseEvidence(cleanupResponse);
          } catch (error) {
            record.scratch_cleanup_response = requestErrorEvidence(error);
          }
          // The scratch inspection is deliberately retained above before the
          // fixture's exact owned file cleanup request.
          persistEvidence();
        }

        if (inspectError) throw inspectError;
        if (requestError && probe.mode !== "processes") throw requestError;
      }

      await runtime.stopAndCleanup(entry, { cleanup: true });
      evidence.cleanup = {
        stopped: entry.stopped === true,
        relay_map_absent: !existsSync(relayMapPath),
        receipt_digest: entry.cleanup?.digest ?? null,
        state_retained: entry.cleanup?.receipt?.cleanup?.state_retained ?? null,
        receipt: entry.cleanup?.receipt ?? null,
      };
      persistEvidence();

      const cleanupReplay = await runtime.invoke(entry.allocation, "cleanup", {
        network: entry.network,
        secret_version_refs: entry.secretVersionRefs,
        environment: entry.environment,
      });
      evidence.cleanup_replay = executorEvidence(cleanupReplay);
      persistEvidence();
      const replay = cleanupReplay.receipt;
      if (replay.operation !== "cleanup" || replay.result !== "passed" || replay.status !== "cleaned" ||
        replay.cleanup?.sandbox_absent !== true || replay.cleanup?.application_namespace_absent !== true ||
        replay.cleanup?.gateway_namespace_absent !== true || replay.cleanup?.cgroup_absent !== true ||
        replay.cleanup?.mounts_absent !== true || replay.cleanup?.state_retained !== false) {
        throw new Error("runtime cleanup replay did not prove exact resource absence");
      }

      const http500Failures = evidence.pressure.flatMap((record) => {
        const failures = [];
        if (record.response?.status === 500) failures.push({ mode: record.mode, phase: "pressure", response: record.response });
        if (record.scratch_cleanup_response?.status === 500) failures.push({ mode: record.mode, phase: "scratch_cleanup", response: record.scratch_cleanup_response });
        return failures;
      });
      evidence.http_500_failures = http500Failures;
      persistEvidence();
      if (http500Failures.some(({ response }) => response.payload === null && !response.safe_error_text)) {
        throw new Error("HTTP 500 pressure response did not preserve its bounded diagnostic payload");
      }
      if (http500Failures.length > 0) {
        throw new Error("HTTP 500 pressure response remains a failure; bounded diagnostic payload was retained");
      }

      const [cpu, scratch, processes] = evidence.pressure;
      const pressureCleanupReceipt = evidence.cleanup?.receipt?.cleanup;
      if (
        !evidence.cleanup?.stopped ||
        !evidence.cleanup.relay_map_absent ||
        evidence.cleanup.state_retained !== false ||
        pressureCleanupReceipt?.sandbox_absent !== true ||
        pressureCleanupReceipt?.application_namespace_absent !== true ||
        pressureCleanupReceipt?.gateway_namespace_absent !== true ||
        pressureCleanupReceipt?.cgroup_absent !== true ||
        pressureCleanupReceipt?.mounts_absent !== true
      ) {
        throw new Error("runtime pressure diagnostic did not prove exact stop and cleanup");
      }
      if (cpu.response?.status !== 200 || cpu.executor_inspect?.reason_code !== "cpu_throttled" || !(cpu.executor_inspect.observed_limits?.cpu_nr_throttled > 0)) {
        throw new Error("CPU pressure lacks an actual throttling receipt and counter");
      }
      if (
        scratch.response?.status !== 200 ||
        scratch.response.payload?.failed !== true ||
        scratch.response.payload.code !== "ENOSPC" ||
        scratch.executor_inspect?.reason_code !== "scratch_limit_exceeded" ||
        scratch.executor_inspect.receipt?.scratch_observation?.capacity_bytes !== RUNTIME_POLICY.scratch_bytes ||
        scratch.executor_inspect.receipt?.scratch_observation?.available_bytes !== 0 ||
        scratch.scratch_cleanup_response?.status !== 200 ||
        scratch.scratch_cleanup_response.payload?.removed !== true
      ) throw new Error("scratch pressure lacks ENOSPC, pinned zero-available evidence, or exact cleanup receipt");
      const processCodes = processes.response?.payload?.codes ?? [];
      const processMemoryEvents = processes.executor_inspect?.observed_limits?.memory_events ?? {};
      const noMemoryOomEvent = processMemoryEvents.max === 0 && processMemoryEvents.oom === 0 && processMemoryEvents.oom_kill === 0;
      const processLimits = processes.executor_inspect?.observed_limits;
      const processLimitReceipt = processes.executor_inspect?.reason_code === "process_limit_exceeded" &&
        processLimits?.pids_max === RUNTIME_POLICY.pids && processLimits?.pids_events?.max > 0 && noMemoryOomEvent;
      const structuredPidFailure = processes.response?.status === 200 && processes.response.payload?.failed > 0 &&
        processCodes.some((code) => code === "EAGAIN" || code === "ENOMEM") && processLimitReceipt;
      const stoppedPidFailure = processes.request_failed === true && processes.response?.status === null &&
        processes.response?.safe_error_text && processes.executor_inspect?.receipt?.runsc_status === "stopped" && processLimitReceipt;
      if (!structuredPidFailure && !stoppedPidFailure) {
        throw new Error("PID pressure lacks either a structured EAGAIN/ENOMEM response or an exact stopped process-limit receipt without an OOM event");
      }

      memoryEntry = await runtime.launchDiagnosticBootstrap({ buildOutput: runtimeBuild, index: 2 });
      memoryRelayMapPath = memoryEntry.relay.mapPath;
      evidence.memory = {
        allocation_id: memoryEntry.allocation.id,
        generation: memoryEntry.allocation.generation,
        fence: memoryEntry.allocation.fence,
        profile: memoryEntry.allocation.profile,
        capability_digest: memoryEntry.allocation.capability_digest,
        prepare_receipt_digest: memoryEntry.prepared.digest,
        start_receipt_digest: memoryEntry.started.digest,
        initial_inspect_receipt_digest: memoryEntry.inspected.digest,
        initial_health_passing: memoryEntry.inspected.receipt?.health?.passing === true,
        request: { mode: "memory", amount: 600 },
        response: null,
        executor_inspect: null,
      };
      persistEvidence();

      let memoryRequestError = null;
      try {
        const response = await relayJson(memoryEntry.relay, "/probe/resource", {
          method: "POST",
          body: { mode: "memory", amount: 600 },
        }, context.abortSignal);
        evidence.memory.response = responseEvidence(response);
      } catch (error) {
        memoryRequestError = error;
        evidence.memory.response = requestErrorEvidence(error);
      }
      // The memory request is expected to lose its connection when the guest
      // is OOM-killed. Preserve that bounded error before collecting the
      // post-exit executor receipt.
      persistEvidence();

      let memoryInspectError = null;
      try {
        const inspection = await runtime.invoke(memoryEntry.allocation, "inspect", {
          network: memoryEntry.network,
          secret_version_refs: memoryEntry.secretVersionRefs,
          environment: memoryEntry.environment,
        });
        evidence.memory.executor_inspect = executorEvidence(inspection);
      } catch (error) {
        memoryInspectError = error;
        evidence.memory.executor_inspect_error = safeErrorText(error);
      }
      persistEvidence();

      if (memoryInspectError) throw memoryInspectError;
      const memoryLimits = evidence.memory.executor_inspect?.observed_limits;
      const memoryOomEvents = memoryLimits?.memory_events ?? {};
      if (
        !memoryRequestError ||
        evidence.memory.response?.status !== null ||
        !evidence.memory.response?.safe_error_text ||
        evidence.memory.executor_inspect?.reason_code !== "runtime_oom" ||
        memoryLimits?.memory_max_bytes !== RUNTIME_POLICY.memory_bytes ||
        memoryLimits?.memory_swap_max_bytes !== RUNTIME_POLICY.memory_swap_bytes ||
        !(memoryOomEvents.oom_kill > 0) ||
        !(memoryOomEvents.max > 0) ||
        !(memoryOomEvents.oom > 0)
      ) throw new Error("memory pressure did not produce the expected connection failure, post-exit runtime_oom receipt, and positive OOM counters before reconcile");

      // Keep the first post-exit receipt and cgroup epoch intact while the
      // real reconcile operation replaces the stopped attempt.
      evidence.memory.initial_oom_receipt = evidence.memory.executor_inspect;
      evidence.memory.initial_cgroup_state = ownedCgroupState(
        memoryLimits,
        memoryEntry.allocation,
        "initial memory attempt",
      );
      persistEvidence();

      let reconcileError = null;
      try {
        const reconciliation = await runtime.invoke(memoryEntry.allocation, "reconcile", {
          network: memoryEntry.network,
          secret_version_refs: memoryEntry.secretVersionRefs,
          environment: memoryEntry.environment,
          timeoutMs: 45_000,
        });
        evidence.memory.reconcile = executorEvidence(reconciliation);
      } catch (error) {
        reconcileError = error;
        evidence.memory.reconcile_error = safeErrorText(error);
      }
      persistEvidence();
      if (reconcileError) throw reconcileError;
      if (
        evidence.memory.reconcile?.receipt?.operation !== "reconcile" ||
        evidence.memory.reconcile.receipt.status !== "restart_scheduled" ||
        evidence.memory.reconcile.reason_code !== "runtime_oom"
      ) throw new Error("memory reconcile did not retain the previous runtime_oom cause while scheduling a fresh attempt");

      let restartInspection = null;
      let restartHealthyAt = null;
      let restartInspectError = null;
      let restartInspectAttempts = 0;
      const restartInspectErrors = [];
      const restartInspectReceiptDigests = [];
      const restartDeadline = performance.now() + RESTART_STARTUP_DEADLINE_MS;
      while (performance.now() < restartDeadline) {
        if (context.abortSignal?.aborted) throw new Error("memory restart inspection was aborted");
        restartInspectAttempts += 1;
        const remainingMs = Math.max(1, Math.ceil(restartDeadline - performance.now()));
        try {
          const inspection = await runtime.invoke(memoryEntry.allocation, "inspect", {
            network: memoryEntry.network,
            secret_version_refs: memoryEntry.secretVersionRefs,
            environment: memoryEntry.environment,
            timeoutMs: remainingMs,
          });
          restartInspection = inspection;
          if (inspection.digest) restartInspectReceiptDigests.push(inspection.digest);
          if (
            inspection.receipt?.status === "running" &&
            inspection.receipt?.result === "passed" &&
            inspection.receipt?.runsc_status === "running" &&
            inspection.receipt?.health?.passing === true
          ) {
            restartHealthyAt = performance.now();
            break;
          }
        } catch (error) {
          restartInspectError = error;
          if (restartInspectErrors.length < 16) restartInspectErrors.push(safeErrorText(error));
          if (error.runtimeReceiptDigests) restartInspectReceiptDigests.push(...error.runtimeReceiptDigests);
        }
        const delayMs = Math.min(RESTART_STARTUP_POLL_MS, Math.max(0, restartDeadline - performance.now()));
        if (delayMs <= 0) break;
        await context.delay(delayMs);
      }
      evidence.memory.restart_inspect = restartInspection ? executorEvidence(restartInspection) : null;
      evidence.memory.restart_inspect_attempts = restartInspectAttempts;
      evidence.memory.restart_health_elapsed_ms = restartHealthyAt === null ? null : restartHealthyAt - (restartDeadline - RESTART_STARTUP_DEADLINE_MS);
      evidence.memory.restart_inspect_errors = restartInspectErrors;
      evidence.memory.restart_inspect_receipt_digests = [...new Set(restartInspectReceiptDigests)].slice(-16);
      if (restartInspectError) evidence.memory.restart_inspect_error = safeErrorText(restartInspectError);
      persistEvidence();

      if (
        !restartInspection ||
        restartHealthyAt === null || restartHealthyAt > restartDeadline ||
        restartInspection.receipt?.status !== "running" ||
        restartInspection.receipt?.result !== "passed" ||
        restartInspection.receipt?.runsc_status !== "running" ||
        restartInspection.receipt?.health?.passing !== true
      ) throw new Error("memory reconcile did not produce a healthy replacement attempt within the 5 second startup deadline");

      const initialCgroupState = evidence.memory.initial_cgroup_state;
      const restartLimits = evidence.memory.restart_inspect.observed_limits;
      const restartMemoryEvents = restartLimits?.memory_events ?? {};
      const restartPidEvents = restartLimits?.pids_events ?? {};
      evidence.memory.restart_cgroup_state = ownedCgroupState(
        restartLimits,
        memoryEntry.allocation,
        "restarted memory attempt",
      );
      const restartCgroupState = evidence.memory.restart_cgroup_state;
      if (
        restartCgroupState.allocation_id !== initialCgroupState.allocation_id ||
        restartCgroupState.generation !== initialCgroupState.generation ||
        restartCgroupState.fence !== initialCgroupState.fence ||
        restartCgroupState.identity_hash !== initialCgroupState.identity_hash ||
        restartCgroupState.cgroup_epoch <= initialCgroupState.cgroup_epoch ||
        restartCgroupState.cgroup_path === initialCgroupState.cgroup_path ||
        ["runtime_oom", "process_limit_exceeded"].includes(restartInspection.receipt.reason_code) ||
        restartLimits?.cgroup_path !== restartCgroupState.cgroup_path ||
        restartLimits?.cpu_max !== memoryLimits.cpu_max ||
        restartLimits?.cpu_max !== "25000 100000" ||
        restartLimits?.memory_max_bytes !== memoryLimits.memory_max_bytes ||
        restartLimits?.memory_max_bytes !== RUNTIME_POLICY.memory_bytes ||
        restartLimits?.memory_swap_max_bytes !== memoryLimits.memory_swap_max_bytes ||
        restartLimits?.memory_swap_max_bytes !== RUNTIME_POLICY.memory_swap_bytes ||
        restartLimits?.pids_max !== memoryLimits.pids_max ||
        restartLimits?.pids_max !== RUNTIME_POLICY.pids ||
        restartMemoryEvents.max !== 0 ||
        restartMemoryEvents.oom !== 0 ||
        restartMemoryEvents.oom_kill !== 0 ||
        restartPidEvents.max !== 0
      ) throw new Error("memory reconcile replacement did not receive a fresh owned cgroup epoch with exact limits and clean pressure counters");
      persistEvidence();

      let memoryCleanupError = null;
      try {
        await runtime.stopAndCleanup(memoryEntry, { cleanup: true });
      } catch (error) {
        memoryCleanupError = error;
        evidence.memory.cleanup_error = safeErrorText(error);
      }
      evidence.memory.stop = memoryEntry.stop ? executorEvidence(memoryEntry.stop) : null;
      evidence.memory.cleanup = {
        stopped: memoryEntry.stopped === true,
        relay_map_absent: !existsSync(memoryRelayMapPath),
        receipt_digest: memoryEntry.cleanup?.digest ?? null,
        state_retained: memoryEntry.cleanup?.receipt?.cleanup?.state_retained ?? null,
        receipt: memoryEntry.cleanup?.receipt ?? null,
      };
      persistEvidence();

      if (memoryCleanupError) throw memoryCleanupError;
      const memoryCleanupReceipt = evidence.memory.cleanup?.receipt?.cleanup;
      if (
        !evidence.memory.cleanup?.stopped ||
        !evidence.memory.cleanup.relay_map_absent ||
        evidence.memory.cleanup.state_retained !== false ||
        memoryCleanupReceipt?.sandbox_absent !== true ||
        memoryCleanupReceipt?.application_namespace_absent !== true ||
        memoryCleanupReceipt?.gateway_namespace_absent !== true ||
        memoryCleanupReceipt?.cgroup_absent !== true ||
        memoryCleanupReceipt?.mounts_absent !== true
      ) throw new Error("memory pressure restart did not finish with an exact stop and cleanup receipt");
      evidence.memory.request_error_observed = Boolean(memoryRequestError);
      persistEvidence();

      context.assertion(
        ASSERTION,
        "M3 diagnostic runtime pressure",
        "the actual Node 24 policy-probe HCA produces CPU, scratch, PID, and post-exit memory OOM receipts through the relay and cleans completely",
        {
          diagnostic_only: true,
          production_capability_registered: false,
          evidence_file: "m3-runtime-pressure-development.json",
          pressure_modes: evidence.pressure.map(({ mode, response, executor_inspect, scratch_cleanup_response }) => ({
            mode,
            status: response?.status ?? null,
            reason_code: executor_inspect?.reason_code ?? null,
            scratch_cleanup_status: scratch_cleanup_response?.status ?? null,
          })),
          cleanup_complete: true,
          pid_failure_codes: processCodes,
          pid_request_failed: processes.request_failed === true,
          pid_runsc_status: processes.executor_inspect?.receipt?.runsc_status ?? null,
          memory_request_failed: true,
          memory_reason_code: evidence.memory.executor_inspect.reason_code,
          memory_oom_kill: memoryOomEvents.oom_kill,
          memory_reconcile_status: evidence.memory.reconcile.receipt.status,
          memory_reconcile_reason_code: evidence.memory.reconcile.reason_code,
          memory_initial_cgroup_epoch: evidence.memory.initial_cgroup_state.cgroup_epoch,
          memory_restart_cgroup_epoch: evidence.memory.restart_cgroup_state.cgroup_epoch,
          memory_restart_cgroup_path: evidence.memory.restart_cgroup_state.cgroup_path,
          memory_restart_memory_events: restartMemoryEvents,
          memory_restart_pids_max_events: restartPidEvents.max,
          http_500_failures: 0,
        },
        true,
      );
    } catch (error) {
      let cleanupError = null;
      if (memoryEntry && !memoryEntry.stopped) {
        try { await runtime.stopAndCleanup(memoryEntry, { cleanup: true }); } catch (caught) { cleanupError = caught; }
      }
      if (entry && !entry.stopped) {
        try { await runtime.stopAndCleanup(entry, { cleanup: true }); } catch (caught) { cleanupError ??= caught; }
      }
      evidence.failure = { error_text: safeErrorText(error) };
      if (cleanupError) evidence.cleanup_finalizer_error = safeErrorText(cleanupError);
      persistEvidence();
      context.assertion(
        ASSERTION,
        "M3 diagnostic runtime pressure",
        "the actual Node 24 policy-probe HCA produces CPU, scratch, PID, and post-exit memory OOM receipts through the relay and cleans completely",
        { diagnostic_only: true, production_capability_registered: false, evidence_file: "m3-runtime-pressure-development.json", failed_checks: 1 },
        false,
        error.message,
      );
      if (cleanupError) throw new AggregateError([error, cleanupError], "runtime pressure diagnostic and cleanup both failed");
      throw error;
    }
  });
}

export const scenario = Object.freeze({
  id: "m3-runtime-pressure-development",
  description: "Diagnostic-only Node 24 policy-probe CPU, scratch, PID and post-exit memory pressure through the real relay, including fresh post-OOM reconcile epoch verification; excludes M3 runtime acceptance and production capability registration",
  requiredAssertions: Object.freeze([...M3_UPGRADE_REQUIRED_ASSERTIONS, "M3-BUILD-01", "M3-BUILD-02", ASSERTION]),
  run: runRuntimePressureDevelopment,
});
