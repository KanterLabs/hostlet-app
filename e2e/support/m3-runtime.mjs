import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { assertStatus, expectScenario } from "./http-client.mjs";

export const RUNSC_RELEASE = "release-20260914.0";
export const RUNSC_SHA256 = "c0f4ec0ac1198975d5cf919a78f2302426de096f69eebd33e50125c3ca42d699";
export const RUNTIME_POLICY = Object.freeze({
  schema: "hostlet.runtime.policy/v1",
  memory_bytes: 536_870_912,
  memory_swap_bytes: 0,
  cpu_quota_micros: 25_000,
  cpu_period_micros: 100_000,
  pids: 128,
  scratch_bytes: 268_435_456,
  max_connections: 128,
  new_connections_per_second: 20,
  new_connections_burst: 40,
});
const EXECUTOR_RESOURCES = Object.freeze({
  memory_bytes: RUNTIME_POLICY.memory_bytes,
  memory_swap_bytes: RUNTIME_POLICY.memory_swap_bytes,
  cpu_quota_micros: RUNTIME_POLICY.cpu_quota_micros,
  cpu_period_micros: RUNTIME_POLICY.cpu_period_micros,
  pids: RUNTIME_POLICY.pids,
  scratch_bytes: RUNTIME_POLICY.scratch_bytes,
  max_connections: RUNTIME_POLICY.max_connections,
  new_connections_per_second: RUNTIME_POLICY.new_connections_per_second,
  new_connections_burst: RUNTIME_POLICY.new_connections_burst,
});
const POLICY_DOCUMENT = '{"cpu_period_micros":100000,"cpu_quota_micros":25000,"healthy_reset_seconds":600,"max_connections":128,"memory_bytes":536870912,"memory_swap_bytes":0,"new_connections_burst":40,"new_connections_per_second":20,"pids":128,"restart_delays_seconds":[1,2,4,8,16,30],"restart_limit":6,"restart_window_seconds":600,"scratch_bytes":268435456,"schema":"hostlet.runtime.policy/v1"}';
export const RUNTIME_POLICY_DIGEST = `sha256:${createHash("sha256").update(POLICY_DOCUMENT).digest("hex")}`;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUIRED_PATTERN_KEYS = Object.freeze(["node22_api", "fullstack_v1", "fullstack_v2", "next16", "policy_probes"]);
const REQUIRED_REASONS = Object.freeze([
  "cpu_throttled", "runtime_oom", "scratch_limit_exceeded", "process_limit_exceeded",
  "network_connection_limit", "crash_loop_backoff",
]);
const NODE24_IMAGE = "node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7";
const RUNTIME_BENCHMARK_REQUEST_COUNT = 1_000;
const RUNTIME_LIVENESS_INTERVAL_MS = 50;
const RUNTIME_STARTUP_DEADLINE_MS = 5_000;
const RUNTIME_STARTUP_POLL_MS = 100;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  if ((statSync(path).mode & 0o777) !== 0o700 || realpathSync(path) !== resolve(path)) {
    throw new Error(`runtime protected directory is unsafe: ${path}`);
  }
}

function writePrivate(path, value, flag = "w") {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag });
  chmodSync(path, 0o600);
  if (!statSync(path).isFile() || lstatSync(path).isSymbolicLink() || (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`runtime protected file is unsafe: ${path}`);
  }
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function percentile95(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error("runtime measurement samples must be finite positive numbers");
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function requireDigest(value, label) {
  if (!DIGEST.test(value ?? "")) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function requireBuildOutput(key, value) {
  if (!value || !UUID.test(value.buildJobId ?? "") || !UUID.test(value.artifactId ?? "")) {
    throw new Error(`runtime build output ${key} lacks durable build/artifact identity`);
  }
  for (const field of ["archiveDigest", "manifestDigest", "buildProfileDigest"]) {
    requireDigest(value[field], `${key}.${field}`);
  }
  if (!/^[0-9a-f]{40}$/.test(value.sourceCommit ?? "")) throw new Error(`${key}.sourceCommit is invalid`);
  if (!Number.isInteger(value.nodeMajor) || ![22, 24].includes(value.nodeMajor)) throw new Error(`${key}.nodeMajor is unsupported`);
  if (!new Set(["node_http", "nextjs16_standalone"]).has(value.framework)) throw new Error(`${key}.framework is unsupported`);
  return value;
}

function outputsMap(outputs) {
  if (outputs instanceof Map) return outputs;
  if (outputs && typeof outputs === "object") return new Map(Object.entries(outputs));
  throw new Error("M3 runtime requires actual build outputs");
}

function primaryTenantPeer(peers, projectId = null) {
  if (peers?.primary) return peers.primary;
  if (projectId && typeof peers?.get === "function" && peers.get(projectId)) return peers.get(projectId);
  if (typeof peers?.get === "function" && peers.get("primary")) return peers.get("primary");
  if (typeof peers?.values === "function") return [...peers.values()].find((peer) => peer && peer.restoreTarget === false) ?? null;
  if (peers && typeof peers === "object") return Object.values(peers).find((peer) => peer && peer.restoreTarget === false) ?? null;
  return null;
}

function safeReceipt(value) {
  if (!value || value.schema !== "hostlet.runtime.executor-receipt/v1") throw new Error("runtime executor returned no valid receipt");
  if (!DIGEST.test(value.artifact_digest ?? "") || !DIGEST.test(value.runtime_binary_digest ?? "")) throw new Error("runtime executor receipt identity is invalid");
  return value;
}

function requestFor(allocation, operation, network, overrides = {}) {
  return {
    schema: "hostlet.runtime.executor-request/v1",
    profile: allocation.executor_profile ?? allocation.profile,
    operation,
    allocation_id: allocation.id,
    generation: allocation.generation,
    fence: allocation.fence,
    artifact_digest: allocation.artifact_digest,
    artifact_manifest_digest: requireDigest(allocation.artifact_manifest_digest, "allocation artifact manifest digest"),
    build_profile_digest: requireDigest(allocation.build_profile_digest, "allocation build profile digest"),
    runtime_binary_digest: allocation.runtime_binary_digest,
    policy_digest: requireDigest(allocation.policy?.digest ?? allocation.policy_digest, "allocation policy digest"),
    capability_digest: allocation.capability_digest ?? null,
    platform: allocation.platform,
    argv: allocation.argv,
    environment: overrides.environment ?? [],
    secret_version_refs: overrides.secret_version_refs ?? [],
    health_port: allocation.health_port ?? 3000,
    health_path: allocation.health_path,
    application_port: allocation.application_port ?? 3000,
    network,
    resources: EXECUTOR_RESOURCES,
    exit_history_unix_ms: overrides.exit_history_unix_ms ?? [],
    observed_at_unix_ms: Date.now(),
  };
}

export function createM3RuntimeHarness(context, m3, options = {}) {
  const runtimeBinary = resolve(options.runtimeBinary ?? join(context.repo, "target/debug/hostlet-runtime"));
  const runsc = resolve(options.runsc ?? `/opt/hostlet-owned-fixture-tools/gvisor/${RUNSC_RELEASE}/runsc`);
  const launcher = resolve(options.launcher ?? join(context.repo, "scripts/runtime/hostlet-runtime-launcher"));
  const peerHelper = resolve(options.peerHelper ?? join(context.repo, "scripts/runtime/hostlet-runtime-peer"));
  const fixturePeerHelper = resolve(options.fixturePeerHelper ?? join(context.repo, "scripts/runtime/hostlet-runtime-fixture-peer"));
  const runtimeCleanupHelper = resolve(options.runtimeCleanupHelper ?? join(context.repo, "scripts/runtime/hostlet-runtime-cleanup"));
  const artifactPreparer = resolve(options.artifactPreparer ?? join(context.repo, "scripts/runtime/prepare-artifact.py"));
  const migrationProbe = resolve(options.migrationProbe ?? join(context.repo, "scripts/runtime/hostlet-runtime-migration-probe.py"));
  const nativeBaselineHelper = resolve(options.nativeBaselineHelper ?? join(context.repo, "scripts/runtime/hostlet-runtime-native-baseline"));
  const relay = resolve(options.relay ?? join(context.repo, "scripts/runtime/hostlet-runtime-relay.py"));
  const relayStopHelper = resolve(options.relayStopHelper ?? join(context.repo, "scripts/runtime/hostlet-runtime-relay-stop"));
  const stateRoot = resolve(options.stateRoot ?? join(context.tempDir, "m3-runtime-state"));
  const artifactRoot = resolve(options.artifactRoot ?? m3.state.buildArtifactRoot ?? join(context.tempDir, "m3-runtime-artifacts"));
  const requestsRoot = join(stateRoot, "requests");
  const nativeBaselineMetadataPath = join(requestsRoot, ".native-baseline.json");
  const relaysRoot = join(stateRoot, "runtime-relays");
  const privilegedCommand = process.getuid?.() === 0 ? null : (options.privilegedCommand ?? "sudo");
  const active = new Map();
  const networkReservations = new Map();
  const networkSlotOwners = new Map();
  const executorReceiptDigests = new Set();
  const evaluatedCapabilities = new Map();
  const projectBuildOutputs = new Map();
  const cleanupRegistered = new WeakSet();
  let lastRuntimeEvaluation = null;
  let evaluatedNodeBaseRoots = null;
  let lastRuntimeInputs = null;
  let commandSequence = 0;
  let measurementSequence = 0;
  const runtimeObservationArtifactPath = join(context.artifactDir, "m3-runtime-observations.json");
  const runtimeEvaluationArtifactPath = join(context.artifactDir, "m3-runtime-evaluation-registrations.json");
  const runtimeCleanupObservationArtifactPath = join(context.artifactDir, "m3-runtime-cleanup-observation-negatives.json");
  const runtimeObservationRecords = [];
  const runtimeEvaluationRecords = [];

  function command(binary, args) {
    return privilegedCommand ? [privilegedCommand, ["-n", binary, ...args]] : [binary, args];
  }

  function persistRuntimeArtifact(path, value, label) {
    const bytes = jsonLine(value);
    if (Buffer.byteLength(bytes, "utf8") > 512 * 1024) throw new Error(`${label} is unexpectedly large`);
    const existing = existsSync(path);
    if (existing) {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error(`${label} path is unsafe`);
    }
    writePrivate(path, bytes, existing ? "w" : "wx");
  }

  function persistRuntimeObservation(record) {
    if (runtimeObservationRecords.length >= 256) throw new Error("runtime observation artifact exceeded its bounded record count");
    runtimeObservationRecords.push(Object.freeze({ sequence: runtimeObservationRecords.length + 1, ...record }));
    persistRuntimeArtifact(runtimeObservationArtifactPath, {
      schema: "hostlet.runtime.observations/v1",
      observations: runtimeObservationRecords,
    }, "runtime observation artifact");
  }

  function persistRuntimeEvaluation(record) {
    if (runtimeEvaluationRecords.length >= 256) throw new Error("runtime evaluation artifact exceeded its bounded record count");
    runtimeEvaluationRecords.push(Object.freeze({ sequence: runtimeEvaluationRecords.length + 1, ...record }));
    persistRuntimeArtifact(runtimeEvaluationArtifactPath, {
      schema: "hostlet.runtime.evaluation-registrations/v1",
      registrations: runtimeEvaluationRecords,
    }, "runtime evaluation registration artifact");
  }

  async function runOwnedHelper(label, binary, args, logName, timeoutMs = 60_000, cleanup = false) {
    const [executable, executableArgs] = command(binary, args);
    const result = await context.runCommand(label, executable, executableArgs, {
      env: m3.componentEnvironment("runtime"), timeoutMs, logName, cleanup,
    });
    return result;
  }

  async function runExecutor(label, args, logName, timeoutMs = 60_000, cleanup = false) {
    return context.runCommand(label, runtimeBinary, args, {
      env: m3.componentEnvironment("runtime"), timeoutMs, logName, cleanup,
    });
  }

  function relayIdentityArguments(operation, relayRecord) {
    const argumentsList = [
      operation,
      "--state-root", stateRoot,
      "--allocation-id", relayRecord.allocation_id,
      "--generation", String(relayRecord.generation),
      "--fence", String(relayRecord.fence),
      "--map-file", relayRecord.mapPath,
      "--relay-pid", String(relayRecord.relay_pid),
      "--relay-pgid", String(relayRecord.relay_pgid),
      "--relay-starttime-ticks", String(relayRecord.relay_starttime_ticks),
      "--allow-missing-map",
    ];
    if (operation === "verify") {
      for (const member of relayRecord.trackedMembers ?? []) {
        if (!Number.isInteger(member?.pid) || !Number.isInteger(member?.starttime_ticks) || member.pid <= 0 || member.starttime_ticks <= 0) throw new Error("runtime relay stop receipt has an invalid tracked member");
        argumentsList.push("--known-member", `${member.pid}:${member.starttime_ticks}`);
      }
    }
    return argumentsList;
  }

  function relayReceipt(result, label, relayRecord) {
    if (result.code !== 0) throw new Error(`${label} failed with exit ${result.code}`);
    let receipt;
    try { receipt = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); }
    catch { throw new Error(`${label} emitted no JSON receipt`); }
    if (receipt?.schema !== "hostlet.runtime.relay-stop/v1" || receipt.allocation_id !== relayRecord.allocation_id ||
        receipt.generation !== relayRecord.generation || receipt.fence !== relayRecord.fence ||
        receipt.relay_pid !== relayRecord.relay_pid || receipt.relay_pgid !== relayRecord.relay_pgid ||
        receipt.relay_starttime_ticks !== relayRecord.relay_starttime_ticks) {
      throw new Error(`${label} emitted an unrelated identity receipt`);
    }
    return receipt;
  }

  async function stopRelay(entry, reason, cleanup = false) {
    const relayRecord = entry?.relay;
    if (!relayRecord) return null;
    let firstError = null;
    let stopReceipt = null;
    try {
      const result = await runOwnedHelper(
        `Stop exact M3 runtime relay ${relayRecord.allocation_id}`,
        relayStopHelper,
        relayIdentityArguments("stop", relayRecord),
        `m3-runtime-relay-stop-${relayRecord.allocation_id}-${++commandSequence}.log`,
        30_000,
        cleanup,
      );
      stopReceipt = relayReceipt(result, `M3 runtime relay ${relayRecord.allocation_id} stop`, relayRecord);
      relayRecord.trackedMembers = Array.isArray(stopReceipt.tracked_members) ? stopReceipt.tracked_members : [];
    } catch (error) { firstError = error; }
    try {
      // The privileged helper owns root workers; stopManaged still waits for
      // the original runner child so Node reaps its leader and closes pipes.
      await context.stopManaged(relayRecord.process, reason);
    } catch (error) { firstError ??= error; }
    let verifyReceipt = null;
    try {
      const result = await runOwnedHelper(
        `Verify exact M3 runtime relay ${relayRecord.allocation_id} absence`,
        relayStopHelper,
        relayIdentityArguments("verify", relayRecord),
        `m3-runtime-relay-verify-${relayRecord.allocation_id}-${++commandSequence}.log`,
        10_000,
        cleanup,
      );
      verifyReceipt = relayReceipt(result, `M3 runtime relay ${relayRecord.allocation_id} absence`, relayRecord);
      if (verifyReceipt.process_absent !== true || verifyReceipt.map_absent !== true) throw new Error(`M3 runtime relay ${relayRecord.allocation_id} process absence was not proven after leader reap`);
    } catch (error) { firstError ??= error; }
    relayRecord.stopReceipt = stopReceipt;
    relayRecord.verifyReceipt = verifyReceipt;
    entry.relayStop = { stop: stopReceipt, verify: verifyReceipt };
    if (firstError) throw firstError;
    return entry.relayStop;
  }

  function trackActive(entry) {
    const key = networkAllocationKey(entry?.allocation);
    const existing = active.get(entry.allocation.id);
    if (existing && existing !== entry) {
      const existingKey = networkAllocationKey(existing.allocation);
      if (!existing.stopped || existingKey !== key) throw new Error("runtime allocation would overwrite a live allocation identity");
      active.delete(entry.allocation.id);
    }
    const reservation = networkReservations.get(key);
    if (!reservation || reservation.state !== "pending" || networkSlotOwners.get(reservation.index) !== key) {
      if (reservation?.state === "active" && reservation.entry === entry) return entry;
      throw new Error("runtime allocation has no matching pending network slot reservation");
    }
    if (networkIndexFromNetwork(entry.network) !== reservation.index) throw new Error("runtime allocation network does not match its reserved slot");
    reservation.state = "active";
    reservation.entry = entry;
    entry.networkSlot = reservation.index;
    active.set(entry.allocation.id, entry);
    try {
      if (!cleanupRegistered.has(entry)) {
        cleanupRegistered.add(entry);
        context.registerCleanup(`M3 runtime allocation ${entry.allocation.id}`, async () => {
          await stopAndCleanup(entry, { cleanup: true });
        });
      }
    } catch (error) {
      if (active.get(entry.allocation.id) === entry) active.delete(entry.allocation.id);
      reservation.state = "pending";
      reservation.entry = null;
      cleanupRegistered.delete(entry);
      throw error;
    }
    return entry;
  }

  function wipeSecretInput(allocation, references = []) {
    const directory = join(stateRoot, "secret-input", allocation.id, String(allocation.fence));
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory() || !realpathSync(directory).startsWith(`${realpathSync(stateRoot)}/secret-input/${allocation.id}/`)) throw new Error("runtime secret input cleanup path is unsafe");
    const ownershipPath = join(directory, "OWNERSHIP.json");
    const ownershipMetadata = lstatSync(ownershipPath);
    if (!ownershipMetadata.isFile() || ownershipMetadata.isSymbolicLink()) throw new Error("runtime secret input ownership marker is unsafe");
    const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
    if (ownership.allocation_id !== allocation.id || ownership.fence !== allocation.fence) throw new Error("runtime secret input ownership mismatch");
    const allowed = new Set(references.map(({ version_id: id }) => id));
    const names = readdirSync(directory);
    for (const name of names) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65_536 || (name !== "OWNERSHIP.json" && !allowed.has(name))) throw new Error("runtime secret input cleanup encountered an unsafe entry");
    }
    for (const name of names.filter((name) => name !== "OWNERSHIP.json")) {
      const path = join(directory, name);
      chmodSync(path, 0o600);
      if (statSync(path).size > 0) writeFileSync(path, Buffer.alloc(statSync(path).size), { flag: "r+" });
      rmSync(path);
    }
    rmSync(ownershipPath);
    rmdirSync(directory);
    const allocationDirectory = dirname(directory);
    if (existsSync(allocationDirectory) && readdirSync(allocationDirectory).length === 0) rmdirSync(allocationDirectory);
  }

  async function initialize() {
    for (const path of [runtimeBinary, runsc, launcher, peerHelper, fixturePeerHelper, runtimeCleanupHelper, relay, relayStopHelper, artifactPreparer, migrationProbe, nativeBaselineHelper]) {
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`runtime prerequisite is missing: ${path}`);
    }
    const observedRunsc = createHash("sha256").update(readFileSync(runsc)).digest("hex");
    if (observedRunsc !== RUNSC_SHA256) throw new Error("the evaluated gVisor binary digest does not match the M3 pin");
    for (const [tool, args] of [["ip", ["-Version"]], ["nft", ["--version"]], ["jq", ["--version"]], ["mountpoint", ["--version"]]]) {
      const check = await context.runCommand(`M3 runtime prerequisite ${tool}`, tool, args, { timeoutMs: 10_000, logName: `m3-runtime-prerequisite-${tool}.log` });
      if (check.code !== 0) throw new Error(`M3 runtime prerequisite is unavailable: ${tool}`);
    }
    privateDirectory(stateRoot); privateDirectory(artifactRoot); privateDirectory(requestsRoot); privateDirectory(relaysRoot);
    writePrivate(join(stateRoot, ".hostlet-runtime-owned"), "hostlet-runtime-state-v1\n", "wx");
    const artifactMarker = join(artifactRoot, ".hostlet-artifacts-owned");
    if (!existsSync(artifactMarker)) writePrivate(artifactMarker, "hostlet-artifacts-v1\n", "wx");
    else if (readFileSync(artifactMarker, "utf8").trim() !== "hostlet-artifacts-v1") throw new Error("runtime artifact root ownership marker is invalid");
    context.state.toolchains.gvisor = { release: RUNSC_RELEASE, sha256: RUNSC_SHA256, platform: "systrap" };
    context.state.configuration.m3Runtime = {
      mode: "owned fixture evaluation followed by evidence-gated allocation",
      customerAdmission: false,
      runtimeBinary: "target/debug/hostlet-runtime",
      runscRelease: RUNSC_RELEASE,
      runscSha256: RUNSC_SHA256,
      policyDigest: RUNTIME_POLICY_DIGEST,
      privilegeBoundary: "executor invokes only the validated launcher through its fixed sudo boundary; E2E invokes validated peer and relay-stop helpers through sudo -n",
      policyClockUse: "evaluation expiry only; performance, health, idle, and backoff use actual clocks",
    };
    context.registerFixture("M3 native baseline fixture helper", nativeBaselineHelper);
    context.registerFixture("M3 exact relay-stop helper", relayStopHelper);
    // Runner cleanup is LIFO. Register this before any allocation callback so
    // every runtime, relay, and fixture callback completes before the
    // root-owned runsc state is torn down through the narrow helper.
    context.registerCleanup("M3 runtime root teardown", async () => {
      const result = await runOwnedHelper(
        "Remove exact M3 runtime runsc state",
        runtimeCleanupHelper,
        ["--state-root", stateRoot, "--runsc", runsc, "--runsc-sha256", RUNSC_SHA256],
        "m3-runtime-root-teardown.log",
        30_000,
        true,
      );
      if (result.code !== 0) throw new Error(`runtime root teardown failed with exit ${result.code}`);
    });
    context.registerCleanup("M3 native baseline cgroup cleanup", async () => {
      const result = await runOwnedHelper(
        "Remove exact M3 native baseline cgroup",
        nativeBaselineHelper,
        ["cleanup", "--state-root", stateRoot],
        "m3-runtime-native-baseline-cleanup.log",
        30_000,
        true,
      );
      if (result.code !== 0) throw new Error(`native baseline cleanup failed with exit ${result.code}`);
    });
    return api;
  }

  function casStore(receipt, label) {
    const bytes = Buffer.from(jsonLine(receipt));
    const digest = sha256(bytes);
    const hex = digest.slice(7);
    const directory = join(m3.policyClock.stateDir, "evidence", "sha256", hex.slice(0, 2));
    privateDirectory(directory);
    const path = join(directory, `${hex.slice(2)}.json`);
    if (!existsSync(path)) writePrivate(path, bytes, "wx");
    if (sha256(readFileSync(path)) !== digest) throw new Error(`${label} CAS digest mismatch`);
    return { digest, path };
  }

  function networkAllocationKey(allocation) {
    if (!allocation || !UUID.test(allocation.id ?? "") || !Number.isSafeInteger(allocation.generation) || allocation.generation <= 0 || !Number.isSafeInteger(allocation.fence) || allocation.fence <= 0) {
      throw new Error("runtime network slot requires the exact allocation identity");
    }
    return `${allocation.id}:${allocation.generation}:${allocation.fence}`;
  }

  function networkIndexFromNetwork(network) {
    const ipv4 = /^10\.203\.0\.(\d+)$/.exec(network?.application_ipv4 ?? "");
    const gateway = /^10\.203\.0\.(\d+)$/.exec(network?.gateway_ipv4 ?? "");
    const index = ipv4 ? (Number(ipv4[1]) - 2) / 4 : NaN;
    if (!Number.isInteger(index) || index < 1 || index > 50 || Number(gateway?.[1]) !== index * 4 + 1 || network.application_ipv6 !== `fd77:203:${index.toString(16)}::2` || network.gateway_ipv6 !== `fd77:203:${index.toString(16)}::1`) {
      throw new Error("runtime network slot identity is invalid");
    }
    return index;
  }

  function synchronizeActiveNetworkReservations() {
    for (const entry of active.values()) {
      if (entry.stopped) continue;
      const key = networkAllocationKey(entry.allocation);
      const index = networkIndexFromNetwork(entry.network);
      const existing = networkReservations.get(key);
      if (existing) {
        if (existing.index !== index || existing.state !== "active" || existing.entry !== entry || networkSlotOwners.get(index) !== key) {
          throw new Error("runtime active network slot reservation is inconsistent");
        }
        continue;
      }
      const owner = networkSlotOwners.get(index);
      if (owner && owner !== key) throw new Error("runtime active network slot is already owned");
      networkReservations.set(key, { index, state: "active", entry });
      networkSlotOwners.set(index, key);
    }
  }

  function releasePendingNetworkSlot(allocation) {
    const key = networkAllocationKey(allocation);
    const reservation = networkReservations.get(key);
    if (!reservation || reservation.state !== "pending") return;
    if (networkSlotOwners.get(reservation.index) === key) networkSlotOwners.delete(reservation.index);
    networkReservations.delete(key);
  }

  function releaseActiveNetworkSlot(entry) {
    const key = networkAllocationKey(entry?.allocation);
    const reservation = networkReservations.get(key);
    if (!reservation || reservation.state !== "active" || reservation.entry !== entry || networkSlotOwners.get(reservation.index) !== key) {
      throw new Error("runtime active network slot reservation is missing or mismatched");
    }
    networkSlotOwners.delete(reservation.index);
    networkReservations.delete(key);
  }

  function networkFor(index, destinations = [], ingress = [], allocation) {
    if (!Number.isInteger(index) || index < 1 || index > 50) throw new Error("runtime network index is outside owned range");
    const key = networkAllocationKey(allocation);
    synchronizeActiveNetworkReservations();
    let reservation = networkReservations.get(key);
    if (!reservation) {
      const candidates = [index, ...Array.from({ length: 50 }, (_, offset) => offset + 1).filter((candidate) => candidate !== index)];
      const selected = candidates.find((candidate) => !networkSlotOwners.has(candidate));
      if (!selected) throw new Error("runtime network slot pool is exhausted");
      reservation = { index: selected, state: "pending", entry: null };
      networkReservations.set(key, reservation);
      networkSlotOwners.set(selected, key);
    } else if (networkSlotOwners.get(reservation.index) !== key) {
      throw new Error("runtime network slot reservation owner is inconsistent");
    }
    const octet = reservation.index * 4;
    const hex = reservation.index.toString(16);
    return {
      application_ipv4: `10.203.0.${octet + 2}`,
      gateway_ipv4: `10.203.0.${octet + 1}`,
      application_ipv6: `fd77:203:${hex}::2`,
      gateway_ipv6: `fd77:203:${hex}::1`,
      ingress_sources: ingress,
      outbound_destinations: destinations,
    };
  }

  async function assembleArtifacts(buildOutputs, nodeBaseRoots) {
    const builds = outputsMap(buildOutputs);
    const assembled = new Map();
    for (const [key, raw] of builds) {
      const candidates = Array.isArray(raw) ? raw : [raw];
      const decorated = [];
      for (const build of candidates.filter((value) => value.kind === "application" || value.framework === "nextjs16_standalone" || value.framework === "node_http")) {
        requireBuildOutput(key, build);
        const suppliedBase = nodeBaseRoots?.[build.nodeMajor] ?? nodeBaseRoots?.[String(build.nodeMajor)];
        const rootfs = resolve(typeof suppliedBase === "string" ? suppliedBase : suppliedBase?.rootfs ?? "");
        const baseManifest = resolve(typeof suppliedBase === "object" && suppliedBase?.manifest ? suppliedBase.manifest : join(dirname(rootfs), "base.json"));
        if (!rootfs || !existsSync(rootfs) || !statSync(rootfs).isDirectory()) throw new Error(`runtime Node ${build.nodeMajor} base rootfs is unavailable`);
        if (!existsSync(baseManifest) || !statSync(baseManifest).isFile() || lstatSync(baseManifest).isSymbolicLink()) throw new Error(`runtime Node ${build.nodeMajor} base manifest is unavailable`);
        const archive = join(m3.policyClock.stateDir, "private-cas", "sha256", build.archiveDigest.slice(7));
        const buildManifest = join(m3.policyClock.stateDir, "private-cas", "sha256", build.manifestDigest.slice(7));
        if (![archive, buildManifest].every((path) => existsSync(path) && statSync(path).isFile() && !lstatSync(path).isSymbolicLink())) throw new Error(`runtime ${key} canonical HCA or build manifest is unavailable`);
        const baseManifestDigest = typeof suppliedBase === "object" && suppliedBase?.manifestDigest
          ? requireDigest(suppliedBase.manifestDigest, `Node ${build.nodeMajor} base manifest digest`)
          : sha256(readFileSync(baseManifest));
        let baseRootfsDigest = typeof suppliedBase === "object" ? suppliedBase?.rootfsDigest : null;
        if (baseRootfsDigest) requireDigest(baseRootfsDigest, `Node ${build.nodeMajor} base rootfs digest`);
        else {
          const tree = await context.runCommand(`Measure Node ${build.nodeMajor} runtime base`, artifactPreparer, ["--tree-digest", rootfs], { env: m3.componentEnvironment("runtime"), timeoutMs: 120_000, logName: `m3-runtime-node${build.nodeMajor}-base-digest.log` });
          if (tree.code !== 0 || !DIGEST.test(tree.stdout.trim())) throw new Error(`runtime Node ${build.nodeMajor} base digest verification failed`);
          baseRootfsDigest = tree.stdout.trim();
        }
        const prepared = await context.runCommand(`Assemble verified runtime artifact ${key}`, artifactPreparer, [
          "--archive-file", archive, "--archive-digest", build.archiveDigest,
          "--build-manifest", buildManifest, "--build-manifest-digest", build.manifestDigest,
          "--build-profile-digest", build.buildProfileDigest,
          "--base-rootfs", rootfs, "--base-rootfs-digest", baseRootfsDigest,
          "--base-manifest", baseManifest, "--base-manifest-digest", baseManifestDigest,
          "--artifact-root", artifactRoot,
        ], { env: m3.componentEnvironment("runtime"), timeoutMs: 180_000, logName: `m3-runtime-prepare-${key}.log` });
        if (prepared.code !== 0) throw new Error(`verified runtime artifact assembly failed for ${key}`);
        let manifest;
        try { manifest = JSON.parse(prepared.stdout); } catch { throw new Error(`runtime artifact preparer emitted an invalid manifest for ${key}`); }
        if (manifest.archive_digest !== build.archiveDigest || manifest.build_manifest_digest !== build.manifestDigest || manifest.build_profile_digest !== build.buildProfileDigest || manifest.base_rootfs_digest !== baseRootfsDigest || manifest.base_manifest_digest !== baseManifestDigest || manifest.source_commit !== build.sourceCommit || manifest.service_id !== build.serviceId || manifest.workdir !== "/app") throw new Error(`runtime artifact manifest identity mismatch for ${key}`);
        const directory = join(artifactRoot, build.manifestDigest.slice(7));
        decorated.push(Object.freeze({ ...build, runtimeRootfs: join(directory, "rootfs"), runtimeTreeDigest: requireDigest(manifest.rootfs_tree_digest, `${key} runtime tree digest`), runtimeManifest: Object.freeze(manifest) }));
      }
      assembled.set(key, Array.isArray(raw) ? Object.freeze(decorated) : decorated[0]);
    }
    return assembled;
  }

  async function invoke(allocation, operation, { network = allocation.network, timeoutMs = 60_000, cleanup = false, ...overrides } = {}) {
    const request = requestFor(allocation, operation, network, overrides);
    const path = join(requestsRoot, `${String(++commandSequence).padStart(4, "0")}-${allocation.id}-${operation}.json`);
    writePrivate(path, jsonLine(request), "wx");
    const args = ["owned-fixture", "--request-file", path, "--launcher", launcher, "--state-root", stateRoot, "--artifact-root", artifactRoot, "--runsc", runsc];
    const result = await runExecutor(`M3 runtime ${operation} ${allocation.id}`, args, `m3-runtime-${String(commandSequence).padStart(4, "0")}-${operation}.log`, timeoutMs, cleanup);
    if (result.code !== 0) {
      let failureDigest = null;
      try {
        const failureLine = result.stdout.trim().split(/\r?\n/).at(-1);
        const failureReceipt = safeReceipt(JSON.parse(failureLine));
        if (failureReceipt.operation === operation && failureReceipt.allocation_id === allocation.id && failureReceipt.generation === allocation.generation && failureReceipt.fence === allocation.fence) {
          const storedFailure = casStore(failureReceipt, `failed runtime ${operation}`);
          executorReceiptDigests.add(storedFailure.digest);
          failureDigest = storedFailure.digest;
        }
      } catch {
        // A launcher rejection before a receipt is not evidence. Preserve the
        // original exit failure and let the caller decide whether deferral is
        // permitted for this pattern.
      }
      const failure = new Error(`runtime ${operation} failed with exit ${result.code}`);
      if (failureDigest) failure.runtimeReceiptDigests = [failureDigest];
      throw failure;
    }
    const line = result.stdout.trim().split(/\r?\n/).at(-1);
    let receipt;
    try { receipt = safeReceipt(JSON.parse(line)); } catch { throw new Error(`runtime ${operation} did not emit a valid receipt`); }
    if (receipt.operation !== operation || receipt.allocation_id !== allocation.id || receipt.generation !== allocation.generation || receipt.fence !== allocation.fence) {
      throw new Error(`runtime ${operation} receipt does not bind the allocation fence`);
    }
    const stored = casStore(receipt, `runtime ${operation}`);
    executorReceiptDigests.add(stored.digest);
    return { request, receipt, ...stored };
  }

  async function rejectRequest(allocation, requestOverrides, expectedError) {
    const request = { ...requestFor(allocation, "validate", allocation.network), ...requestOverrides };
    const path = join(requestsRoot, `${String(++commandSequence).padStart(4, "0")}-${allocation.id}-invalid.json`);
    writePrivate(path, jsonLine(request), "wx");
    const result = await runExecutor(`Reject invalid M3 runtime request ${allocation.id}`, ["owned-fixture", "--request-file", path, "--launcher", launcher, "--state-root", stateRoot, "--artifact-root", artifactRoot, "--runsc", runsc], `m3-runtime-${String(commandSequence).padStart(4, "0")}-invalid.log`);
    if (result.code === 0 || !`${result.stderr}\n${result.stdout}`.includes(expectedError)) throw new Error(`runtime invalid request was not rejected with ${expectedError}`);
    return { code: result.code, error: expectedError };
  }

  async function record(allocation, state, invocation) {
    const submitted = {
      allocation_id: allocation.id,
      generation: allocation.generation,
      fence: allocation.fence,
      state,
      operation: typeof invocation?.receipt?.operation === "string" ? invocation.receipt.operation : null,
      receipt_digest: DIGEST.test(invocation?.digest ?? "") ? invocation.digest : null,
    };
    let response;
    try {
      response = await m3.roleInternal("runtime", "/internal/v1/runtime/observations", {
        method: "POST", body: { allocation_id: allocation.id, generation: allocation.generation, fence: allocation.fence, state, receipt_digest: invocation.digest },
      });
    } catch (error) {
      persistRuntimeObservation({
        ...submitted,
        recorded_at_unix_ms: Date.now(),
        status: null,
        accepted: false,
        error_code: null,
        error_message_present: false,
        transport_error: true,
      });
      throw error;
    }
    const errorCode = response.payload?.error?.code;
    persistRuntimeObservation({
      ...submitted,
      recorded_at_unix_ms: Date.now(),
      status: response.status,
      accepted: response.status === 201,
      error_code: typeof errorCode === "string" && /^[a-z0-9_.:-]{1,96}$/.test(errorCode) ? errorCode : null,
      error_message_present: typeof response.payload?.error?.message === "string" && response.payload.error.message.length > 0,
      transport_error: false,
      response_id: UUID.test(response.payload?.id ?? "") ? response.payload.id : null,
      response_sequence: Number.isInteger(response.payload?.sequence) ? response.payload.sequence : null,
      response_state: typeof response.payload?.state === "string" && /^[a-z0-9_.:-]{1,96}$/.test(response.payload.state) ? response.payload.state : null,
      response_reason_code: typeof response.payload?.reason_code === "string" && /^[a-z0-9_.:-]{1,96}$/.test(response.payload.reason_code) ? response.payload.reason_code : null,
    });
    expectScenario(
      response.status === 201,
      `runtime ${state} observation`,
      {
        status: response.status,
        error_code: typeof errorCode === "string" && /^[a-z0-9_.:-]{1,96}$/.test(errorCode) ? errorCode : null,
        error_message_present: typeof response.payload?.error?.message === "string" && response.payload.error.message.length > 0,
        ...submitted,
      },
    );
    return response.payload;
  }

  async function ownerObservationRows(allocation, label) {
    const response = await m3.ownerHTTP(`/v1/projects/${allocation.project_id}/runtime/observations`);
    if (response.status !== 200 || !Array.isArray(response.payload?.observations)) throw new Error(`${label} owner observation query failed`);
    const rows = response.payload.observations.filter((value) => value?.allocation_id === allocation.id && value?.generation === allocation.generation);
    if (rows.length === 0) throw new Error(`${label} owner observation query returned no exact allocation/generation rows`);
    return rows.map(({ allocation_id, generation, state, reason_code, observed_at }) => ({ allocation_id, generation, state, reason_code, observed_at }));
  }

  async function verifyCleanupObservationContract(allocation, invocation) {
    if (!UUID.test(allocation?.id ?? "") || invocation?.receipt?.operation !== "cleanup" || invocation.receipt.result !== "passed" || invocation.receipt.status !== "cleaned" || invocation.receipt.cleanup?.mounts_absent !== true) {
      throw new Error("cleanup observation negative oracle requires an authentic complete cleanup receipt");
    }
    const uuid = `'${allocation.id}'::uuid`;
    const snapshot = (label) => m3.postgres.psqlJson(label, `SELECT json_build_object(
      'allocation_state',(SELECT state FROM runtime_allocations WHERE id=${uuid}),
      'observation_count',(SELECT COUNT(*)::int FROM runtime_observations WHERE allocation_id=${uuid}),
      'last_sequence',(SELECT COALESCE(MAX(sequence),0)::int FROM runtime_observations WHERE allocation_id=${uuid}),
      'last_state',(SELECT state FROM runtime_observations WHERE allocation_id=${uuid} ORDER BY sequence DESC LIMIT 1),
      'last_reason_code',(SELECT reason_code FROM runtime_observations WHERE allocation_id=${uuid} ORDER BY sequence DESC LIMIT 1),
      'last_receipt_digest',(SELECT receipt_digest FROM runtime_observations WHERE allocation_id=${uuid} ORDER BY sequence DESC LIMIT 1)
    );`);
    const before = await snapshot("m3-runtime-cleanup-observation-negative-before");
    if (!before || before.allocation_state !== "stopped" || before.observation_count < 1 || before.last_state !== "stopped") throw new Error("cleanup observation negative oracle lacks the authentic stopped lifecycle boundary");
    const submit = async (label, receipt) => {
      const stored = casStore(receipt, label);
      let response;
      try {
        response = await m3.roleInternal("runtime", "/internal/v1/runtime/observations", {
          method: "POST",
          body: { allocation_id: allocation.id, generation: allocation.generation, fence: allocation.fence, state: "cleaned", receipt_digest: stored.digest },
        });
      } catch {
        return { receipt_digest: stored.digest, status: null, error_code: null, error_message_present: false, transport_error: true };
      }
      const errorCode = response.payload?.error?.code;
      return {
        receipt_digest: stored.digest,
        status: response.status,
        error_code: typeof errorCode === "string" && /^[a-z0-9_.:-]{1,96}$/.test(errorCode) ? errorCode : null,
        error_message_present: typeof response.payload?.error?.message === "string" && response.payload.error.message.length > 0,
        transport_error: false,
      };
    };
    const mountsFalse = structuredClone(invocation.receipt);
    mountsFalse.cleanup.mounts_absent = false;
    const mountsFalseResponse = await submit("runtime cleanup mounts_absent=false receipt", mountsFalse);
    const mountsMissing = structuredClone(invocation.receipt);
    delete mountsMissing.cleanup.mounts_absent;
    const mountsMissingResponse = await submit("runtime cleanup mounts_absent-missing receipt", mountsMissing);
    const after = await snapshot("m3-runtime-cleanup-observation-negative-after");
    const durableUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const result = {
      allocation_id: allocation.id,
      generation: allocation.generation,
      fence: allocation.fence,
      source_cleanup_receipt_digest: invocation.digest,
      mounts_false: mountsFalseResponse,
      mounts_missing: mountsMissingResponse,
      before,
      after,
      durable_unchanged: durableUnchanged,
    };
    persistRuntimeArtifact(runtimeCleanupObservationArtifactPath, {
      schema: "hostlet.runtime.cleanup-observation-negatives/v1",
      ...result,
    }, "runtime cleanup observation negative artifact");
    if (mountsFalseResponse.status !== 409 || mountsFalseResponse.error_code !== "runtime_observation_mismatch") throw new Error("cleanup mounts_absent=false receipt was not rejected as a lifecycle mismatch");
    if (mountsMissingResponse.status !== 422 || mountsMissingResponse.error_code !== "runtime_receipt_invalid") throw new Error("cleanup mounts_absent-missing receipt was not rejected as invalid evidence");
    if (!durableUnchanged) throw new Error("cleanup observation negatives changed durable allocation or observation state");
    return result;
  }

  async function recordHealthyInspection(allocation, invocation, label) {
    if (invocation?.receipt?.operation !== "inspect" || invocation.receipt.status !== "running" || invocation.receipt.result !== "passed" || invocation.receipt.health?.passing !== true) throw new Error(`${label} did not produce a healthy inspect receipt`);
    return record(allocation, "healthy", invocation);
  }

  async function recordBackoffReconcile(allocation, invocation, label) {
    if (invocation?.receipt?.operation !== "reconcile" || !["restart_scheduled", "crash_loop_backoff"].includes(invocation.receipt.status)) throw new Error(`${label} did not produce a bounded backoff receipt`);
    return record(allocation, "backoff", invocation);
  }

  async function inspectUntilHealthy(allocation, { network = allocation.network, secretVersionRefs = [], environment = [], purpose, startedReceiptDigest = null } = {}) {
    if (typeof purpose !== "string" || !/^[a-z0-9-]+$/.test(purpose)) throw new Error("runtime startup health poll purpose is invalid");
    const startedAt = performance.now();
    const deadline = startedAt + RUNTIME_STARTUP_DEADLINE_MS;
    const attempts = [];
    const errors = [];
    let healthy = null;
    let healthyObservedAt = null;
    while (performance.now() < deadline) {
      const attemptStartedAt = performance.now();
      const remainingMs = Math.max(1, Math.ceil(deadline - attemptStartedAt));
      try {
        const candidate = await invoke(allocation, "inspect", {
          network,
          secret_version_refs: secretVersionRefs,
          environment,
          timeoutMs: remainingMs,
        });
        const observedAt = performance.now();
        const passing = candidate.receipt.health?.passing === true;
        attempts.push({
          receipt_digest: candidate.digest,
          status: candidate.receipt.status,
          reason_code: candidate.receipt.reason_code,
          health_passing: passing,
          elapsed_ms: observedAt - startedAt,
          duration_ms: observedAt - attemptStartedAt,
        });
        if (observedAt <= deadline && passing) {
          healthy = candidate;
          healthyObservedAt = observedAt;
          break;
        }
      } catch (error) {
        const observedAt = performance.now();
        const receiptDigests = (error?.runtimeReceiptDigests ?? []).filter((digest) => DIGEST.test(digest));
        const errorCode = error?.name === "TimeoutError" || error?.code === "ETIMEDOUT"
          ? "runtime_inspect_timeout"
          : "runtime_inspect_failed";
        attempts.push({
          receipt_digests: receiptDigests,
          elapsed_ms: observedAt - startedAt,
          duration_ms: observedAt - attemptStartedAt,
          error_code: errorCode,
        });
        errors.push(errorCode);
        if (context.abortSignal?.aborted) throw error;
      }
      const delayMs = Math.min(RUNTIME_STARTUP_POLL_MS, Math.max(0, deadline - performance.now()));
      if (delayMs <= 0) break;
      await context.delay(delayMs);
    }
    const elapsedMs = performance.now() - startedAt;
    const receiptDigests = attempts.flatMap((attempt) => attempt.receipt_digest ? [attempt.receipt_digest] : attempt.receipt_digests ?? []);
    const evidence = Object.freeze({
      schema: "hostlet.runtime.startup-health-poll/v1",
      purpose,
      allocation_id: allocation.id,
      generation: allocation.generation,
      fence: allocation.fence,
      deadline_ms: RUNTIME_STARTUP_DEADLINE_MS,
      started_receipt_digest: DIGEST.test(startedReceiptDigest ?? "") ? startedReceiptDigest : null,
      attempts,
      receipt_digests: receiptDigests,
      errors,
      healthy_receipt_digest: healthy?.digest ?? null,
      healthy_observed_elapsed_ms: healthyObservedAt === null ? null : healthyObservedAt - startedAt,
      elapsed_ms: elapsedMs,
    });
    persistRuntimeArtifact(
      join(context.artifactDir, `m3-runtime-startup-health-${purpose}-${allocation.id}-${++measurementSequence}.json`),
      evidence,
      `${purpose} runtime startup health poll artifact`,
    );
    if (!healthy) {
      const failure = new Error(`runtime application did not become healthy within the ${RUNTIME_STARTUP_DEADLINE_MS}ms startup budget`);
      failure.startupDeadlineExceeded = true;
      failure.startupMs = Math.max(1, Math.round(elapsedMs));
      failure.runtimeReceiptDigests = [...new Set([
        ...(DIGEST.test(startedReceiptDigest ?? "") ? [startedReceiptDigest] : []),
        ...receiptDigests,
      ])];
      throw failure;
    }
    return Object.freeze({ invocation: healthy, evidence });
  }

  async function launch(allocation, { network = allocation.network, secretVersionRefs = [], environment = [], fixtures = [] } = {}) {
    const entry = { allocation: { ...allocation, network }, network, secretVersionRefs, environment, stopped: false };
    let tracked = false;
    try {
      trackActive(entry);
      tracked = true;
      entry.prepared = await invoke(entry.allocation, "prepare", { network, secret_version_refs: secretVersionRefs, environment });
      entry.fixturePeers = [];
      for (const fixture of fixtures) {
        await fixturePeer(entry.allocation, fixture);
        entry.fixturePeers.push(fixture);
      }
      entry.started = await invoke(entry.allocation, "start", { network, secret_version_refs: secretVersionRefs, environment });
      if (allocation.executor_profile === "evidence_gated_owned_fixture") entry.running = await record(allocation, "running", entry.started);
      const startupHealth = await inspectUntilHealthy(entry.allocation, { network, secretVersionRefs, environment, purpose: "launch", startedReceiptDigest: entry.started.digest });
      entry.inspected = startupHealth.invocation;
      entry.startupHealthEvidence = startupHealth.evidence;
      if (allocation.executor_profile === "evidence_gated_owned_fixture") entry.healthy = await record(allocation, "healthy", entry.inspected);
      entry.relay = await startRelay(entry.allocation, entry);
      return entry;
    } catch (error) {
      if (!tracked) {
        releasePendingNetworkSlot(entry.allocation);
        throw error;
      }
      try { await stopAndCleanup(entry, { cleanup: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "runtime launch and owned cleanup both failed"); }
      throw error;
    }
  }

  async function stopAndCleanup(entry, { cleanup = false, cleanupObservationContract = false } = {}) {
    if (!entry || entry.stopped) return;
    const allocation = entry.allocation;
    let firstError = null;
    let cleanupObservationNegative = null;
    if (entry.prepared && !entry.runtimeCleaned) {
      try {
        entry.stop = await invoke(allocation, "stop", { network: entry.network, secret_version_refs: entry.secretVersionRefs ?? [], environment: entry.environment ?? [], cleanup });
        if (!cleanup && allocation.executor_profile === "evidence_gated_owned_fixture") await record(allocation, "stopped", entry.stop);
      } catch (error) { firstError = error; }
    }
    for (const fixture of [...(entry.fixturePeers ?? [])].reverse()) {
      try {
        await fixturePeer(allocation, fixture, "detach_fixture_service", { cleanup });
        entry.fixturePeers = entry.fixturePeers.filter((value) => value !== fixture);
      } catch (error) { firstError ??= error; }
    }
    if (entry.databasePeer) {
      try {
        await attachPostgres(allocation, entry.databasePeer, "detach_postgres", { cleanup });
        entry.databasePeer = null;
      } catch (error) { firstError ??= error; }
    }
    if (entry.relay) {
      try {
        await stopRelay(entry, `M3 runtime relay ${allocation.id} cleanup`, cleanup);
        if (existsSync(entry.relay.mapPath)) throw new Error("privileged runtime relay did not remove its exact ownership map");
        if (existsSync(entry.relay.directory)) rmdirSync(entry.relay.directory);
        const allocationRelayDirectory = join(relaysRoot, allocation.id);
        if (existsSync(allocationRelayDirectory)) rmdirSync(allocationRelayDirectory);
        entry.relay = null;
      } catch (error) { firstError ??= error; }
    }
    if (!entry.runtimeCleaned) try {
      entry.cleanup = await invoke(allocation, "cleanup", { network: entry.network, secret_version_refs: entry.secretVersionRefs ?? [], environment: entry.environment ?? [], cleanup });
      if (!cleanup && cleanupObservationContract && allocation.executor_profile === "evidence_gated_owned_fixture") {
        cleanupObservationNegative = await verifyCleanupObservationContract(allocation, entry.cleanup);
      }
      if (!cleanup && allocation.executor_profile === "evidence_gated_owned_fixture") await record(allocation, "cleaned", entry.cleanup);
      entry.runtimeCleaned = true;
    } catch (error) { firstError ??= error; }
    try { wipeSecretInput(allocation, entry.secretVersionRefs ?? []); } catch (error) { firstError ??= error; }
    if (firstError) throw firstError;
    entry.cleanupObservationNegative = cleanupObservationNegative;
    releaseActiveNetworkSlot(entry);
    entry.stopped = true;
    active.delete(allocation.id);
    return cleanupObservationNegative;
  }

  async function startRelay(allocation, entry) {
    if (!entry || entry.allocation.id !== allocation.id || entry.stopped) throw new Error("runtime relay requires the live owned allocation");
    if (entry.relay) return entry.relay;
    const port = await context.allocatePort();
    const directory = join(relaysRoot, allocation.id, String(allocation.generation));
    const mapPath = join(directory, `${allocation.fence}.json`);
    if (existsSync(mapPath)) throw new Error("runtime relay map already exists");
    const relayArguments = ["--state-root", stateRoot, "--allocation-id", allocation.id, "--generation", String(allocation.generation), "--listen-port", String(port), "--fence", String(allocation.fence), "--target-address", entry.network.application_ipv4, "--target-port", String(allocation.application_port)];
    const [relayExecutable, privilegedRelayArguments] = command(relay, relayArguments);
    const process = context.spawnManaged(
      `M3 runtime relay ${allocation.id}`,
      relayExecutable,
      privilegedRelayArguments,
      { env: m3.componentEnvironment("runtime") },
      `m3-runtime-relay-${allocation.id}-${++commandSequence}.log`,
    );
    try {
      // Read and bind the exact identity map before waiting for application
      // health. If health aborts, the catch path can still stop root workers.
      const mapDeadline = performance.now() + 15_000;
      while (!existsSync(mapPath)) {
        if (process.child.exitCode !== null || performance.now() >= mapDeadline) throw new Error("privileged runtime relay emitted no ownership map");
        await context.delay(50);
      }
      if (lstatSync(mapPath).isSymbolicLink() || !statSync(mapPath).isFile() || (statSync(mapPath).mode & 0o077) !== 0) throw new Error("privileged runtime relay emitted no safe ownership map");
      const map = JSON.parse(readFileSync(mapPath, "utf8"));
      if (map.schema !== "hostlet.runtime.relay-map/v1" || map.allocation_id !== allocation.id || map.generation !== allocation.generation || map.fence !== allocation.fence || map.address !== "127.0.0.1" || map.port !== port || !Number.isInteger(map.relay_pid) || map.relay_pid <= 0 || !Number.isInteger(map.relay_pgid) || map.relay_pgid <= 0 || !Number.isInteger(map.relay_starttime_ticks) || map.relay_starttime_ticks <= 0) throw new Error("privileged runtime relay ownership map is invalid");
      entry.relay = { process, directory, mapPath, ...map };
      await context.waitForHttp(`http://127.0.0.1:${port}${allocation.health_path}`, 200, `M3 runtime relay ${allocation.id}`);
      if (!Number.isInteger(map.gateway_namespace_inode) || map.gateway_namespace_inode <= 0) throw new Error("privileged runtime relay ownership map lacks a namespace inode");
      return entry.relay;
    } catch (error) {
      if (entry.relay) {
        try { await stopRelay(entry, `M3 failed runtime relay ${allocation.id} cleanup`, true); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "runtime relay start and exact cleanup both failed"); }
      } else {
        await context.stopManaged(process, `M3 failed runtime relay ${allocation.id} cleanup`);
      }
      if (existsSync(mapPath)) throw new AggregateError([error, new Error("failed privileged runtime relay retained its ownership map")], "runtime relay start and cleanup both failed");
      if (existsSync(directory)) rmdirSync(directory);
      const allocationRelayDirectory = join(relaysRoot, allocation.id);
      if (existsSync(allocationRelayDirectory)) rmdirSync(allocationRelayDirectory);
      throw error;
    }
  }

  async function allocate(build, evaluationId) {
    const response = await m3.roleInternal("runtime", "/internal/v1/runtime/allocations", {
      method: "POST", body: { build_job_id: build.buildJobId, artifact_id: build.artifactId, evaluation_id: evaluationId },
    });
    if (![200, 201].includes(response.status)) {
      const code = response.payload?.error?.code;
      const safeCode = typeof code === "string" && /^[a-z0-9_.:-]{1,96}$/.test(code) ? code : "none";
      throw new Error(`runtime allocation rejected with HTTP ${response.status} code ${safeCode}`);
    }
    const value = response.payload;
    requireDigest(value.capability_digest, "allocation capability");
    if (value.artifact_digest !== build.archiveDigest || value.artifact_manifest_digest !== build.manifestDigest || value.build_profile_digest !== build.buildProfileDigest || value.source_commit !== build.sourceCommit) {
      throw new Error("runtime allocation differs from the exact build output");
    }
    return value;
  }

  async function attachPostgres(allocation, peer, operation = "attach_postgres", { cleanup = false } = {}) {
    for (const field of ["containerId", "runId", "tenantDatabaseId", "databaseGeneration", "endpointIpv4", "endpointIpv6", "gatewayIpv4", "gatewayIpv6"]) {
      if (!peer?.[field]) throw new Error(`runtime PostgreSQL peer lacks ${field}`);
    }
    const request = {
      schema: "hostlet.runtime.peer-request/v1", operation, allocation_id: allocation.id,
      runtime_generation: allocation.generation, runtime_fence: allocation.fence, container_id: peer.containerId, run_id: peer.runId,
      tenant_database_id: peer.tenantDatabaseId, database_generation: peer.databaseGeneration,
      restore_target: Boolean(peer.restoreTarget), endpoint_ipv4: peer.endpointIpv4,
      endpoint_ipv6: peer.endpointIpv6, gateway_ipv4: peer.gatewayIpv4, gateway_ipv6: peer.gatewayIpv6,
    };
    const path = join(requestsRoot, `${String(++commandSequence).padStart(4, "0")}-${operation}.json`);
    const bytes = jsonLine(request);
    writePrivate(path, bytes, "wx");
    const result = await runOwnedHelper(`M3 runtime ${operation}`, peerHelper, ["--request-file", path, "--request-sha256", sha256(bytes).slice(7), "--state-root", stateRoot], `m3-runtime-${operation}-${commandSequence}.log`, 60_000, cleanup);
    if (result.code !== 0) throw new Error(`runtime ${operation} failed`);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  }

  async function fixturePeer(allocation, fixture, operation = "attach_fixture_service", { cleanup = false } = {}) {
    const request = {
      schema: "hostlet.runtime.fixture-peer-request/v1", operation,
      allocation_id: allocation.id, runtime_generation: allocation.generation, runtime_fence: allocation.fence,
      container_id: fixture.containerId, run_id: fixture.runId, fixture_id: fixture.id,
      fixture_kind: fixture.kind, service_port: fixture.port,
      endpoint_ipv4: fixture.endpointIpv4, endpoint_ipv6: fixture.endpointIpv6,
      gateway_ipv4: fixture.gatewayIpv4, gateway_ipv6: fixture.gatewayIpv6,
    };
    const path = join(requestsRoot, `${String(++commandSequence).padStart(4, "0")}-${operation}-${fixture.kind}.json`);
    const bytes = jsonLine(request); writePrivate(path, bytes, "wx");
    const result = await runOwnedHelper(`M3 runtime ${operation} ${fixture.kind}`, fixturePeerHelper, ["--request-file", path, "--request-sha256", sha256(bytes).slice(7), "--state-root", stateRoot], `m3-runtime-${operation}-${fixture.kind}-${commandSequence}.log`, 60_000, cleanup);
    if (result.code !== 0) throw new Error(`runtime ${operation} ${fixture.kind} failed`);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  }

  async function createIsolationFixtures() {
    const fixtureRunId = randomUUID();
    const definitions = [
      {
        kind: "http", port: 8080, endpointIpv4: "10.204.0.2", gatewayIpv4: "10.204.0.1", endpointIpv6: "fd77:204::2", gatewayIpv6: "fd77:204::1",
        code: "const http=require('http');let n=0;http.createServer((q,r)=>{n++;const b=JSON.stringify({status:'ok',requests:n,path:q.url});r.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(b)});r.end(b);console.log(JSON.stringify({kind:'http',path:q.url,requests:n}))}).listen(8080,'::');",
      },
      {
        kind: "dns", port: 53, endpointIpv4: "10.204.0.6", gatewayIpv4: "10.204.0.5", endpointIpv6: "fd77:204:1::2", gatewayIpv6: "fd77:204:1::1",
        code: "const dgram=require('dgram'),net=require('net');let ready=0;const mark=()=>{if(++ready===3)console.log(JSON.stringify({kind:'ready',services:3}))},fatal=e=>{console.error(e.stack||e);process.exit(1)};function answer(q){const id=q.subarray(0,2),question=q.subarray(12),type=q.readUInt16BE(q.length-4),hdr=Buffer.from([id[0],id[1],0x81,0x80,0,1,0,1,0,0,0,0]),data=type===28?Buffer.from([0x20,1,0x0d,0xb8,0,0,0,0,0,0,0,0,0,0,0,10]):Buffer.from([203,0,113,10]),rr=Buffer.concat([Buffer.from([0xc0,0x0c,type===28?0:0,type===28?28:1,0,1,0,0,0,30,0,data.length]),data]);console.log(JSON.stringify({kind:'dns',type,bytes:q.length}));return Buffer.concat([hdr,question,rr])}for(const type of ['udp4','udp6']){const s=dgram.createSocket({type,ipv6Only:type==='udp6'});s.on('error',fatal);s.on('message',(q,r)=>{const a=answer(q);s.send(a,r.port,r.address)});s.bind({port:53,address:type==='udp4'?'0.0.0.0':'::'},mark)}const tcp=net.createServer(s=>s.once('data',b=>{const n=b.readUInt16BE(0),a=answer(b.subarray(2,2+n)),h=Buffer.alloc(2);h.writeUInt16BE(a.length);s.end(Buffer.concat([h,a]))}));tcp.on('error',fatal);tcp.listen({port:53,host:'::'},mark);setInterval(()=>{},1<<30);",
      },
    ];
    const fixtures = [];
    for (const definition of definitions) {
      const id = randomUUID();
      const name = `hostlet-${context.state.runId.slice(0, 8)}-runtime-${definition.kind}-${id.slice(0, 8)}`;
      const labels = ["--label", "io.hostlet.scope=m3-e2e", "--label", `io.hostlet.run-id=${fixtureRunId}`, "--label", `io.hostlet.artifact-run-id=${context.state.runId}`, "--label", "io.hostlet.resource=runtime-fixture-service", "--label", `io.hostlet.fixture-id=${id}`, "--label", `io.hostlet.fixture-kind=${definition.kind}`, "--label", `io.hostlet.fixture-port=${definition.port}`];
      const started = await context.runCommand(`Start M3 ${definition.kind} isolation fixture`, "docker", ["run", "--detach", "--network", "none", "--name", name, ...labels, NODE24_IMAGE, "node", "-e", definition.code], { timeoutMs: 30_000, logName: `m3-runtime-${definition.kind}-fixture-start.log` });
      if (started.code !== 0 || !/^[0-9a-f]{64}$/.test(started.stdout.trim())) throw new Error(`owned ${definition.kind} isolation fixture failed to start`);
      const fixture = { ...definition, id, name, runId: fixtureRunId, containerId: started.stdout.trim() };
      context.registerCleanup(`M3 ${definition.kind} isolation fixture`, async () => {
        const inspected = await context.runCommand(`Verify M3 ${definition.kind} isolation fixture ownership`, "docker", ["inspect", "--format", "{{.Id}}\t{{json .Config.Labels}}", fixture.containerId], { cleanup: true, timeoutMs: 10_000, logName: `m3-runtime-${definition.kind}-fixture-cleanup-inspect.log` });
        if (inspected.code !== 0) {
          if (/no such (?:object|container)/i.test(`${inspected.stderr}\n${inspected.stdout}`)) return;
          throw new Error(`owned ${definition.kind} isolation fixture cleanup inspection failed`);
        }
        const separator = inspected.stdout.indexOf("\t");
        let observedLabels;
        try { observedLabels = JSON.parse(inspected.stdout.slice(separator + 1).trim()); } catch { throw new Error(`owned ${definition.kind} isolation fixture labels are malformed`); }
        if (separator !== 64 || inspected.stdout.slice(0, separator) !== fixture.containerId || observedLabels?.["io.hostlet.scope"] !== "m3-e2e" || observedLabels?.["io.hostlet.run-id"] !== fixture.runId || observedLabels?.["io.hostlet.artifact-run-id"] !== context.state.runId || observedLabels?.["io.hostlet.resource"] !== "runtime-fixture-service" || observedLabels?.["io.hostlet.fixture-id"] !== fixture.id || observedLabels?.["io.hostlet.fixture-kind"] !== fixture.kind || observedLabels?.["io.hostlet.fixture-port"] !== String(fixture.port)) throw new Error(`refusing to remove unowned ${definition.kind} isolation fixture`);
        const removed = await context.runCommand(`Remove M3 ${definition.kind} isolation fixture`, "docker", ["rm", "--force", fixture.containerId], { cleanup: true, timeoutMs: 10_000, logName: `m3-runtime-${definition.kind}-fixture-remove.log` });
        if (removed.code !== 0) throw new Error(`owned ${definition.kind} isolation fixture cleanup failed`);
        const absent = await context.runCommand(`Verify M3 ${definition.kind} isolation fixture absence`, "docker", ["ps", "--all", "--filter", `id=${fixture.containerId}`, "--format", "{{.ID}}"], { cleanup: true, timeoutMs: 10_000, logName: `m3-runtime-${definition.kind}-fixture-absent.log` });
        if (absent.code !== 0 || absent.stdout.trim() !== "") throw new Error(`owned ${definition.kind} isolation fixture remains or absence could not be verified`);
      });
      fixtures.push(fixture);
      if (fixture.kind === "dns") {
        let ready = false;
        for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
          const logs = await context.runCommand("Observe M3 DNS fixture readiness", "docker", ["logs", fixture.containerId], { timeoutMs: 5_000, logName: "m3-runtime-dns-fixture-ready.log" });
          if (logs.code !== 0) throw new Error("owned DNS isolation fixture exited before readiness");
          ready = logs.stdout.includes('"kind":"ready"');
          if (!ready) await context.delay(100);
        }
        if (!ready) throw new Error("owned DNS isolation fixture did not bind IPv4 UDP, IPv6 UDP, and TCP listeners");
      }
    }
    return fixtures;
  }

  async function stageDatabaseSecret(allocation, peer) {
    const response = await m3.roleInternal("runtime", `/internal/v1/runtime/allocations/${allocation.id}/credentials`, {
      method: "POST", body: { generation: allocation.generation, fence: allocation.fence },
    });
    assertStatus(response, 200, "runtime scoped credential resolution");
    const value = response.payload?.value;
    if (!value || typeof value !== "string") throw new Error("runtime credential response is malformed");
    context.registerSensitiveValues([value]);
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new Error("runtime credential plaintext is malformed"); }
    if (parsed.database_ref !== peer.databaseRef || parsed.role_ref !== peer.roleRef || typeof parsed.password !== "string") throw new Error("runtime credential does not match the allocated database");
    context.registerSensitiveValues([parsed.password]);
    const roleName = peer.roleName ?? `ha_${parsed.role_ref.replaceAll("-", "")}`;
    if (!peer.databaseName || !/^h(?:db|dr)_[0-9a-f]{32}$/.test(peer.databaseName) || !/^ha_[0-9a-f]{32}$/.test(roleName)) throw new Error("runtime peer lacks the exact derived database/role names");
    const uri = `postgresql://${encodeURIComponent(roleName)}:${encodeURIComponent(parsed.password)}@${peer.endpointIpv4}:5432/${encodeURIComponent(peer.databaseName)}`;
    context.registerSensitiveValues([uri]);
    const input = join(stateRoot, "secret-input", allocation.id, String(allocation.fence));
    privateDirectory(input);
    writePrivate(join(input, "OWNERSHIP.json"), jsonLine({ allocation_id: allocation.id, fence: allocation.fence }), "wx");
    const versionId = response.payload.credential_id;
    writeFileSync(join(input, versionId), uri, { encoding: "utf8", mode: 0o400, flag: "wx" });
    return { name: "DATABASE_URL", version_id: versionId };
  }

  async function runtimeDatabaseProbe(input) {
    const { buildOutput, evaluationId, databasePeer, index = 40 } = input ?? {};
    const resolvedBuild = buildOutput ?? await projectApplicationBuild(input);
    if (databasePeer?.restoreTarget) return exerciseRestoredDatabaseProbe({ ...input, buildOutput: resolvedBuild, index: input?.index ?? 45 });
    let release;
    let passed = false;
    try {
      release = await launchRelease({ buildOutput: resolvedBuild, evaluationId, databasePeer, index });
      const before = await requestThroughRelay(release.relay, "/api/items");
      const name = `database-probe-${randomUUID()}`;
      const write = await requestThroughRelay(release.relay, "/api/items", { method: "POST", body: { name } });
      const after = await requestThroughRelay(release.relay, "/api/items");
      const readObserved = before.status === 200 && after.status === 200 && after.payload?.items?.some((item) => item.name === name);
      const writeObserved = write.status === 201 && write.payload?.item?.name === name;
      expectScenario(readObserved && writeObserved, "sandbox application performs tenant database read and write", { before_status: before.status, write_status: write.status, after_status: after.status, row_observed: readObserved });
      const executorReceiptDigest = requireDigest(release.executorReceiptDigest, "runtime database probe executor receipt digest");
      passed = true;
      return { allocationId: release.allocation.id, readObserved, writeObserved, executorReceiptDigest, peerReceiptDigest: sha256(jsonLine(release.entry.peerReceipt)) };
    } finally {
      if (release && !passed) await stopRelease(release);
    }
  }

  async function runtimeReadOnlyDatabaseProbe(input) {
    const { buildOutput, evaluationId, databasePeer, index = 41 } = input ?? {};
    const retained = [...active.values()].find((entry) => !entry.stopped && entry.relay &&
      entry.allocation.project_id === input?.expectedProjectId && entry.databasePeer?.tenantDatabaseId === databasePeer?.tenantDatabaseId &&
      entry.databasePeer?.databaseGeneration === databasePeer?.databaseGeneration && entry.databasePeer?.databaseName === databasePeer?.databaseName);
    const resolvedBuild = retained ? null : buildOutput ?? await projectApplicationBuild(input);
    let release;
    try {
      release = retained ? { allocation: retained.allocation, entry: retained, relay: retained.relay, retained: true } : await launchRelease({ buildOutput: resolvedBuild, evaluationId, databasePeer, index });
      const before = await requestThroughRelay(release.relay, "/api/items");
      const write = await requestThroughRelay(release.relay, "/api/items", { method: "POST", body: { name: `read-only-probe-${randomUUID()}` } });
      const after = await requestThroughRelay(release.relay, "/api/items");
      const readObserved = before.status === 200 && after.status === 200;
      const writeDenied = write.status >= 400;
      expectScenario(readObserved && writeDenied, "sandbox retains reads and denies writes after the database storage boundary", { before_status: before.status, write_status: write.status, after_status: after.status });
      const executorReceiptDigest = requireDigest(release.executorReceiptDigest ?? release.entry.inspected?.digest, "runtime read-only database probe executor receipt digest");
      return { allocationId: release.allocation.id, readObserved, writeDenied, retainedAllocation: release.retained === true, executorReceiptDigest };
    } finally {
      if (release && !release.retained) await stopRelease(release);
    }
  }

  async function pauseDatabasePeer(databasePeer) {
    if (!databasePeer?.containerId || !/^[0-9a-f]{64}$/.test(databasePeer.containerId)) throw new Error("runtime database peer has no exact owned container identity");
    const inspect = await context.runCommand("Verify M3 database peer ownership", "docker", ["inspect", "--format", "{{json .Config.Labels}}", databasePeer.containerId], { timeoutMs: 10_000, logName: "m3-runtime-database-peer-inspect.log" });
    if (inspect.code !== 0) throw new Error("runtime database peer is unavailable");
    let labels;
    try { labels = JSON.parse(inspect.stdout.trim()); } catch { throw new Error("runtime database peer labels are malformed"); }
    if (labels?.["io.hostlet.scope"] !== "m3-e2e" || labels?.["io.hostlet.run-id"] !== databasePeer.runId) throw new Error("runtime database peer is outside the owned M3 run");
    const paused = await context.runCommand("Pause M3 database publication peer", "docker", ["pause", databasePeer.containerId], { timeoutMs: 10_000, logName: "m3-runtime-database-peer-pause.log" });
    if (paused.code !== 0) throw new Error("runtime database peer pause failed");
    let resumed = false;
    const resume = async () => {
      if (resumed) return;
      const result = await context.runCommand("Resume M3 database publication peer", "docker", ["unpause", databasePeer.containerId], { cleanup: true, timeoutMs: 10_000, logName: "m3-runtime-database-peer-unpause.log" });
      if (result.code !== 0 && !result.stderr.includes("is not paused")) throw new Error("runtime database peer resume failed");
      resumed = true;
    };
    context.registerCleanup("M3 paused database publication peer", resume);
    return { containerId: databasePeer.containerId, paused: true, resume };
  }

  async function withEndpointsPaused(run) {
    if (typeof run !== "function") throw new Error("runtime endpoint pause requires a callback");
    const entries = [...active.values()].filter((entry) => !entry.stopped && entry.relay?.process?.child);
    const paused = [];
    try {
      for (const entry of entries) {
        const previous = entry.relay;
        await stopRelay(entry, `M3 runtime relay ${entry.allocation.id} endpoint pause`);
        if (existsSync(previous.mapPath)) throw new Error(`runtime relay ${entry.allocation.id} retained its map while paused`);
        entry.relay = null;
        paused.push({ entry, previous });
      }
      await context.delay(100);
      for (const { entry, previous } of paused) {
        const unavailable = await fetch(`http://127.0.0.1:${previous.port}${entry.allocation.health_path}`, { signal: AbortSignal.timeout(300) }).then(() => false, () => true);
        if (!unavailable) throw new Error(`runtime relay ${entry.allocation.id} remained available while paused`);
      }
      return await run();
    } finally {
      for (const { entry } of paused.reverse()) {
        if (!entry.stopped && !entry.relay) entry.relay = await startRelay(entry.allocation, entry);
      }
    }
  }

  async function launchRelease({ buildOutput, evaluationId, databasePeer, index = 35 }) {
    const build = requireBuildOutput("release", buildOutput);
    if (evaluationId !== undefined && !UUID.test(evaluationId)) throw new Error("release runtime evaluation identity is invalid");
    const exactEvaluationId = evaluationId ?? (await evaluateRelease(build, databasePeer)).id;
    const allocation = await allocate(build, exactEvaluationId);
    const existing = active.get(allocation.id);
    if (existing && !existing.stopped) {
      if (!existing.relay || existing.databasePeer?.tenantDatabaseId !== databasePeer.tenantDatabaseId || existing.databasePeer?.databaseGeneration !== databasePeer.databaseGeneration || existing.databasePeer?.databaseName !== databasePeer.databaseName) throw new Error("live runtime allocation is bound to a different database target");
      return { allocation, entry: existing, relay: existing.relay, executorReceiptDigest: existing.inspected?.digest, retained: true };
    }
    const network = networkFor(index, [
      { address: databasePeer.endpointIpv4, port: 5432, protocol: "tcp" },
      { address: databasePeer.endpointIpv6, port: 5432, protocol: "tcp" },
    ], [], allocation);
    allocation.network = network;
    let secret;
    try {
      secret = await stageDatabaseSecret(allocation, databasePeer);
    } catch (error) {
      releasePendingNetworkSlot(allocation);
      throw error;
    }
    const entry = { allocation: { ...allocation }, network, secretVersionRefs: [secret], environment: [{ name: "DATABASE_URL" }], stopped: false };
    let tracked = false;
    try {
      trackActive(entry);
      tracked = true;
      entry.prepared = await invoke(allocation, "prepare", { network, secret_version_refs: [secret], environment: [{ name: "DATABASE_URL" }] });
      entry.peerReceipt = await attachPostgres(allocation, databasePeer);
      entry.databasePeer = databasePeer;
      entry.started = await invoke(allocation, "start", { network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment });
      await record(allocation, "running", entry.started);
      const startupHealth = await inspectUntilHealthy(allocation, {
        network,
        secretVersionRefs: entry.secretVersionRefs,
        environment: entry.environment,
        purpose: "release",
        startedReceiptDigest: entry.started.digest,
      });
      entry.inspected = startupHealth.invocation;
      entry.startupHealthEvidence = startupHealth.evidence;
      await record(allocation, "healthy", entry.inspected);
      entry.relay = await startRelay(allocation, entry);
      return { allocation, entry, relay: entry.relay, executorReceiptDigest: entry.inspected.digest };
    } catch (error) {
      if (!tracked) {
        releasePendingNetworkSlot(allocation);
        throw error;
      }
      try { await stopAndCleanup(entry, { cleanup: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "release runtime launch and owned cleanup both failed"); }
      throw error;
    }
  }

  async function launchProbeAgainstDatabase({ request, credentialFile, evidenceRoot }) {
    if (request?.schema !== "hostlet.runtime.migration-probe-request/v1" || !UUID.test(request.probe_execution_id ?? "")) throw new Error("runtime migration probe request is invalid");
    const credential = resolve(credentialFile ?? "");
    const releaseEvidence = resolve(evidenceRoot ?? "");
    if (!existsSync(credential) || !statSync(credential).isFile() || lstatSync(credential).isSymbolicLink() || (statSync(credential).mode & 0o077) !== 0) throw new Error("runtime migration probe credential file is unsafe");
    if (!existsSync(releaseEvidence) || !statSync(releaseEvidence).isDirectory()) throw new Error("runtime migration probe evidence root is unavailable");
    const requestPath = join(requestsRoot, `${String(++commandSequence).padStart(4, "0")}-${request.probe_execution_id}-migration-probe.json`);
    const requestBytes = jsonLine(request);
    writePrivate(requestPath, requestBytes, "wx");
    const result = await runOwnedHelper("M3 isolated migration runtime probe", migrationProbe, [
      "--request-file", requestPath, "--request-sha256", sha256(requestBytes).slice(7),
      "--credential-file", credential, "--credential-sha256", sha256(readFileSync(credential)).slice(7),
      "--runtime-binary", runtimeBinary, "--launcher", launcher, "--runsc", runsc,
      "--peer-helper", peerHelper, "--state-root", stateRoot, "--artifact-root", artifactRoot,
      "--evidence-root", releaseEvidence,
    ], `m3-runtime-migration-probe-${request.probe_execution_id}.log`, 180_000);
    if (result.code !== 0) throw new Error("isolated migration runtime probe failed");
    let value;
    try { value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch { throw new Error("isolated migration runtime probe emitted no valid result"); }
    if (value.schema !== "hostlet.runtime.migration-probe-result/v1" || value.probe_execution_id !== request.probe_execution_id || !DIGEST.test(value.probe_receipt_digest ?? "") || !DIGEST.test(value.executor_receipt_digest ?? "") || !DIGEST.test(value.application_probe_receipt_digest ?? "") || !DIGEST.test(value.cleanup_receipt_digest ?? "")) throw new Error("isolated migration runtime probe result is malformed");
    return value;
  }

  async function stopRelease(release) {
    const entry = release?.entry ?? release;
    await stopAndCleanup(entry);
  }

  function bootstrapAllocation(build, index) {
    const value = requireBuildOutput(`bootstrap-${index}`, build);
    const allocation = {
      id: randomUUID(), generation: 1, fence: 1, profile: "owned_fixture_evaluation",
      artifact_digest: value.archiveDigest, artifact_manifest_digest: value.manifestDigest,
      build_profile_digest: value.buildProfileDigest, source_commit: value.sourceCommit,
      runtime_binary_digest: `sha256:${RUNSC_SHA256}`, policy_digest: RUNTIME_POLICY_DIGEST,
      capability_digest: null, platform: "systrap",
      argv: value.entrypointArgv ?? (value.framework === "nextjs16_standalone" ? ["node", "server.js"] : ["node", "dist/server.mjs"]),
      application_port: 3000, health_port: 3000, health_path: value.healthPath ?? (value.framework === "nextjs16_standalone" ? "/api/release" : "/healthz"),
    };
    allocation.network = networkFor(index, [], [], allocation);
    return allocation;
  }

  async function requestThroughRelay(relayRecord, path, { method = "GET", body, timeoutMs = 10_000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("runtime relay request timeout is outside the bounded range");
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${relayRecord.port}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), context.abortSignal]),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { status: response.status, payload, text: text.slice(0, 4096), elapsedMs: Math.max(0.001, performance.now() - started) };
  }

  async function evaluatorSecret(build, allocation, peer, { recoveryId = null } = {}) {
    const path = recoveryId ? "/internal/v1/runtime/restore-probes/credentials" : "/internal/v1/runtime/evaluations/credentials";
    const body = { build_job_id: build.buildJobId, artifact_id: build.artifactId, evaluation_subject_id: allocation.id, generation: allocation.generation, fence: allocation.fence };
    if (recoveryId) Object.assign(body, { recovery_id: recoveryId, tenant_database_id: peer.tenantDatabaseId, database_generation: peer.databaseGeneration });
    const response = await m3.roleInternal("runtime", path, { method: "POST", body });
    assertStatus(response, 200, "owned runtime evaluator credential");
    const value = response.payload?.value;
    if (typeof value !== "string") throw new Error("owned evaluator credential response is malformed");
    context.registerSensitiveValues([value]);
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new Error("owned evaluator credential plaintext is malformed"); }
    if (parsed.database_ref !== peer.databaseRef || parsed.role_ref !== peer.roleRef || typeof parsed.password !== "string") throw new Error("owned evaluator credential does not match its build/project database");
    if (response.payload.database_name !== peer.databaseName || response.payload.role_name !== peer.roleName) throw new Error("owned evaluator credential returned unexpected derived names");
    const uri = `postgresql://${encodeURIComponent(response.payload.role_name)}:${encodeURIComponent(parsed.password)}@${peer.endpointIpv4}:5432/${encodeURIComponent(response.payload.database_name)}`;
    context.registerSensitiveValues([parsed.password, uri]);
    const input = join(stateRoot, "secret-input", allocation.id, String(allocation.fence));
    privateDirectory(input);
    writePrivate(join(input, "OWNERSHIP.json"), jsonLine({ allocation_id: allocation.id, fence: allocation.fence }), "wx");
    writeFileSync(join(input, response.payload.credential_id), uri, { encoding: "utf8", mode: 0o400, flag: "wx" });
    return { name: "DATABASE_URL", version_id: response.payload.credential_id };
  }

  async function projectApplicationBuild({ expectedProjectId, databasePeer, artifactKey = "fullstack_v1" } = {}) {
    if (!UUID.test(expectedProjectId ?? "")) throw new Error("runtime database probe requires the exact project identity");
    if (!databasePeer) throw new Error("runtime database probe requires the exact tenant database peer");
    const publishedEntry = [...(m3.state.tenantPeers?.entries?.() ?? [])].find(([key, peer]) =>
      (key === expectedProjectId || key.startsWith(`${expectedProjectId}:replacement:`)) &&
      peer.containerId === databasePeer.containerId && peer.tenantDatabaseId === databasePeer.tenantDatabaseId &&
      peer.databaseGeneration === databasePeer.databaseGeneration && peer.databaseName === databasePeer.databaseName &&
      peer.roleRef === databasePeer.roleRef);
    if (!publishedEntry) throw new Error("runtime database probe peer does not belong to the requested project");
    if (projectBuildOutputs.has(expectedProjectId)) return projectBuildOutputs.get(expectedProjectId);
    if (!new Set(["fullstack_v1", "policy_probes"]).has(artifactKey)) throw new Error("runtime database probe requested an unsupported application fixture");
    if (typeof m3.state.m3Build?.buildFixture !== "function" || !(m3.state.m3Build.jobs instanceof Map)) throw new Error("runtime database probe cannot build the exact project application");
    const priorOutputPresent = Object.hasOwn(m3.state.buildOutputs, "fullstack_v1");
    const priorOutput = m3.state.buildOutputs.fullstack_v1;
    const priorJobPresent = m3.state.m3Build.jobs.has("fullstack_v1");
    const priorJob = m3.state.m3Build.jobs.get("fullstack_v1");
    let record;
    try {
      record = await m3.state.m3Build.buildFixture("fullstack_v1", { existingPrepared: { project: { project: { id: expectedProjectId } } } });
    } finally {
      if (priorOutputPresent) m3.state.buildOutputs.fullstack_v1 = priorOutput;
      else delete m3.state.buildOutputs.fullstack_v1;
      if (priorJobPresent) m3.state.m3Build.jobs.set("fullstack_v1", priorJob);
      else m3.state.m3Build.jobs.delete("fullstack_v1");
    }
    const candidates = Array.isArray(record?.outputs) ? record.outputs : [record?.outputs];
    const application = candidates.find((value) => value?.kind === "application");
    requireBuildOutput(`project-${expectedProjectId}`, application);
    projectBuildOutputs.set(expectedProjectId, application);
    return application;
  }

  function replacementRecoveryId(expectedProjectId, databasePeer) {
    const found = [...(m3.state.tenantPeers?.entries?.() ?? [])].find(([key, peer]) =>
      key.startsWith(`${expectedProjectId}:replacement:`) && peer.containerId === databasePeer.containerId &&
      peer.tenantDatabaseId === databasePeer.tenantDatabaseId && peer.databaseGeneration === databasePeer.databaseGeneration);
    const recoveryId = found?.[0]?.slice(`${expectedProjectId}:replacement:`.length);
    if (!UUID.test(recoveryId ?? "") || databasePeer.databaseName !== `hdr_${recoveryId.replaceAll("-", "")}`) throw new Error("runtime restore probe lacks the exact published recovery identity");
    return recoveryId;
  }

  async function launchBootstrap(build, index, peer = null, fixtures = [], { networkOnlyPeer = null, recoveryId = null } = {}) {
    const allocation = bootstrapAllocation(build, index);
    let secret = null;
    let entry = null;
    let tracked = false;
    const attachedPeer = peer ?? networkOnlyPeer;
    try {
      if (attachedPeer) {
        allocation.network = networkFor(index, [
          { address: attachedPeer.endpointIpv4, port: 5432, protocol: "tcp" },
          { address: attachedPeer.endpointIpv6, port: 5432, protocol: "tcp" },
        ], [], allocation);
      }
      if (peer) {
        secret = await evaluatorSecret(build, allocation, peer, { recoveryId });
      }
      for (const fixture of fixtures) {
        allocation.network.outbound_destinations.push(
          { address: fixture.endpointIpv4, port: fixture.port, protocol: "tcp" },
          { address: fixture.endpointIpv6, port: fixture.port, protocol: "tcp" },
        );
        if (fixture.kind === "dns") allocation.network.outbound_destinations.push(
          { address: fixture.endpointIpv4, port: 53, protocol: "udp" },
          { address: fixture.endpointIpv6, port: 53, protocol: "udp" },
        );
      }
      entry = {
        allocation: { ...allocation }, network: allocation.network,
        secretVersionRefs: secret ? [secret] : [], environment: secret ? [{ name: "DATABASE_URL" }] : [],
        startupReceiptDigests: [], startupStartedAt: null, startupDeadlineAt: null, startupMs: null, startupHealthyWithinBudget: false,
        stopped: false,
      };
      trackActive(entry);
      tracked = true;
      entry.prepared = await invoke(allocation, "prepare", { network: allocation.network, secret_version_refs: secret ? [secret] : [], environment: secret ? [{ name: "DATABASE_URL" }] : [] });
      if (attachedPeer) { entry.peerReceipt = await attachPostgres(allocation, attachedPeer); entry.databasePeer = attachedPeer; }
      entry.fixturePeers = [];
      for (const fixture of fixtures) { await fixturePeer(allocation, fixture); entry.fixturePeers.push(fixture); }
      entry.startupStartedAt = performance.now();
      entry.startupDeadlineAt = entry.startupStartedAt + RUNTIME_STARTUP_DEADLINE_MS;
      entry.started = await invoke(allocation, "start", { network: allocation.network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment, timeoutMs: RUNTIME_STARTUP_DEADLINE_MS });
      entry.startupReceiptDigests.push(entry.started.digest);
      let lastInspectError = null;
      let healthyWithinStartupBudget = false;
      let healthyObservedAt = null;
      while (performance.now() < entry.startupDeadlineAt) {
        const remainingMs = Math.max(1, Math.ceil(entry.startupDeadlineAt - performance.now()));
        try {
          entry.inspected = await invoke(allocation, "inspect", { network: allocation.network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment, timeoutMs: remainingMs });
          entry.startupReceiptDigests.push(entry.inspected.digest);
          const inspectedAt = performance.now();
          if (entry.inspected.receipt.health?.passing === true && inspectedAt <= entry.startupDeadlineAt) {
            healthyWithinStartupBudget = true;
            healthyObservedAt = inspectedAt;
            break;
          }
        } catch (error) {
          lastInspectError = error;
          entry.startupReceiptDigests.push(...(error.runtimeReceiptDigests ?? []).filter((digest) => DIGEST.test(digest)));
          if (context.abortSignal?.aborted) throw error;
        }
        const delayMs = Math.min(RUNTIME_STARTUP_POLL_MS, Math.max(0, entry.startupDeadlineAt - performance.now()));
        if (delayMs <= 0) break;
        await context.delay(delayMs);
      }
      entry.startupHealthyWithinBudget = healthyWithinStartupBudget;
      entry.startupMs = Math.max(1, Math.round((healthyObservedAt ?? performance.now()) - entry.startupStartedAt));
      if (!healthyWithinStartupBudget) {
        const failure = new Error(`owned evaluator sandbox did not become healthy within the ${RUNTIME_STARTUP_DEADLINE_MS}ms startup budget`);
        if (lastInspectError) failure.cause = lastInspectError;
        failure.startupDeadlineExceeded = true;
        failure.runtimeReceiptDigests = [...new Set(entry.startupReceiptDigests)];
        throw failure;
      }
      entry.relay = await startRelay(allocation, entry);
      return entry;
    } catch (error) {
      if (!tracked) {
        releasePendingNetworkSlot(allocation);
        throw error;
      }
      if (entry.startupStartedAt !== null && entry.startupMs === null) {
        entry.startupMs = Math.max(1, Math.round(performance.now() - entry.startupStartedAt));
      }
      if (entry.startupStartedAt !== null && !entry.startupHealthyWithinBudget && performance.now() >= entry.startupDeadlineAt) error.startupDeadlineExceeded = true;
      const runtimeReceiptDigests = [...new Set([
        ...(error.runtimeReceiptDigests ?? []),
        ...entry.startupReceiptDigests,
        entry.prepared?.digest,
        entry.started?.digest,
        entry.inspected?.digest,
      ].filter((digest) => DIGEST.test(digest ?? "")))];
      error.startupMs = entry.startupMs;
      try { await stopAndCleanup(entry, { cleanup: true }); }
      catch (cleanupError) {
        const aggregate = new AggregateError([error, cleanupError], "runtime bootstrap and owned cleanup both failed");
        aggregate.runtimeReceiptDigests = runtimeReceiptDigests;
        aggregate.startupMs = entry.startupMs;
        throw aggregate;
      }
      if (runtimeReceiptDigests.length) error.runtimeReceiptDigests = runtimeReceiptDigests;
      throw error;
    }
  }

  async function finishBootstrap(entry) {
    await stopAndCleanup(entry, { cleanup: true });
  }

  async function launchDiagnosticBootstrap({ buildOutput, index = 1, databasePeer = null } = {}) {
    const build = requireBuildOutput("diagnostic-bootstrap", buildOutput);
    if (build.framework !== "node_http" || ![22, 24].includes(build.nodeMajor)) throw new Error("runtime diagnostic bootstrap requires an actual Node HTTP build output for Node 22 or Node 24");
    return launchBootstrap(build, index, databasePeer);
  }

  function oneApplicationOutput(buildOutputs, key) {
    const value = outputsMap(buildOutputs).get(key);
    const candidates = Array.isArray(value) ? value : [value];
    const found = candidates.find((item) => item?.kind === "application" || item?.framework === "node_http" || item?.framework === "nextjs16_standalone");
    return requireBuildOutput(key, found);
  }

  function readProcStat(pid) {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closing = value.lastIndexOf(")");
    if (closing < 0) throw new Error(`process ${pid} stat is malformed`);
    const fields = value.slice(closing + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    const userTicks = Number(fields[11]);
    const systemTicks = Number(fields[12]);
    if (!Number.isInteger(ppid) || ppid < 0 || !Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) throw new Error(`process ${pid} stat counters are invalid`);
    return { ppid, cpuTicks: userTicks + systemTicks };
  }

  function readProcIdentity(pid) {
    const stat = readProcStat(pid);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? NaN);
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (!Number.isInteger(uid) || commandLine.length === 0) throw new Error(`process ${pid} identity is unavailable`);
    return { pid, ppid: stat.ppid, uid, commandLine };
  }

  function descendantProcessIdentities(rootPid) {
    const records = new Map();
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      try { records.set(pid, readProcIdentity(pid)); } catch { /* process exited during the scan */ }
    }
    const children = new Map();
    for (const record of records.values()) {
      const list = children.get(record.ppid) ?? [];
      list.push(record);
      children.set(record.ppid, list);
    }
    const found = [];
    const pending = [rootPid];
    const seen = new Set();
    while (pending.length) {
      const pid = pending.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const record = records.get(pid);
      if (record) found.push(record);
      for (const child of children.get(pid) ?? []) pending.push(child.pid);
    }
    return found;
  }

  async function findNativeNodeProcess(rootPid) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const candidates = descendantProcessIdentities(rootPid).filter((record) => {
        const executable = record.commandLine[0]?.split("/").at(-1);
        return record.uid === 65_532 && executable === "node" && record.commandLine.includes("/app/dist/server.mjs");
      });
      if (candidates.length === 1) return candidates[0].pid;
      if (candidates.length > 1) throw new Error("native baseline has multiple exact Node server processes");
      await context.delay(50);
    }
    throw new Error("native baseline exact Node server process was not found");
  }

  function executorResourceMeasurement(invocation, label) {
    const limits = invocation?.receipt?.observed_limits;
    const cpuUsec = Number(limits?.cpu_usage_usec ?? NaN);
    const peakMemoryBytes = Number(limits?.memory_peak_bytes ?? NaN);
    if (!Number.isFinite(cpuUsec) || cpuUsec < 0 || !Number.isFinite(peakMemoryBytes) || peakMemoryBytes <= 0) throw new Error(`${label} lacks cgroup CPU and peak-memory measurements`);
    return { cpuUsec, peakMemoryBytes };
  }

  async function waitForNativeBaseline(process, signal) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (existsSync(nativeBaselineMetadataPath)) {
        try {
          const metadata = JSON.parse(readFileSync(nativeBaselineMetadataPath, "utf8"));
          if (metadata.schema === "hostlet.runtime.native-baseline/v1" && Number.isInteger(metadata.pid) && metadata.pid > 0 && typeof metadata.cgroup_path === "string") return metadata;
        } catch {
          // The root helper writes the exact metadata atomically; retry while it starts.
        }
      }
      if (process.record.stoppedAt !== null) throw new Error(`native baseline helper exited before publishing its owned process metadata (code ${process.record.exitCode}, signal ${process.record.signal ?? "none"})`);
      await Promise.race([context.delay(50), process.exited]);
    }
    throw new Error("native baseline helper did not publish its owned process metadata");
  }

  function exactPathAbsent(path) {
    try { lstatSync(path); return false; }
    catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  }

  function procStarttimeTicks(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      if (!/^\d+$/.test(fields[19] ?? "")) throw new Error(`native baseline PID ${pid} has invalid process starttime`);
      return fields[19];
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  function exactPidAbsent(pid, starttimeTicks) {
    const current = procStarttimeTicks(pid);
    return current === null || (starttimeTicks !== null && current !== starttimeTicks);
  }

  async function waitForNativeReadiness(process, url, signal, evidence) {
    const started = performance.now();
    const deadline = started + 10_000;
    let exitOutcome = null;
    let activeRequest = null;
    const exited = process.exited.then((outcome) => {
      exitOutcome = outcome;
      activeRequest?.abort();
      return { kind: "exit", outcome };
    });
    try { while (performance.now() < deadline) {
      signal?.throwIfAborted();
      if (exitOutcome) throw new Error(`native baseline helper exited during readiness (code ${exitOutcome.code}, signal ${exitOutcome.signal ?? "none"})`);
      const requestAbort = new AbortController();
      activeRequest = requestAbort;
      const requestMs = Math.max(1, Math.min(500, Math.ceil(deadline - performance.now())));
      const requestSignal = AbortSignal.any([requestAbort.signal, AbortSignal.timeout(requestMs), ...(signal ? [signal] : [])]);
      try {
        const outcome = await Promise.race([
          fetch(url, { signal: requestSignal, cache: "no-store" }).then((response) => ({ kind: "response", response }), (error) => ({ kind: "request_error", error })),
          exited,
        ]);
        if (outcome.kind === "exit") throw new Error(`native baseline helper exited during readiness (code ${outcome.outcome.code}, signal ${outcome.outcome.signal ?? "none"})`);
        signal?.throwIfAborted();
        if (exitOutcome) throw new Error(`native baseline helper exited during readiness (code ${exitOutcome.code}, signal ${exitOutcome.signal ?? "none"})`);
        if (outcome.kind === "response") {
          evidence.last_health = `HTTP ${outcome.response.status}`;
          if (outcome.response.status === 200) {
            let body;
            try { body = await outcome.response.text(); }
            catch (error) {
              if (exitOutcome) throw new Error(`native baseline helper exited during readiness (code ${exitOutcome.code}, signal ${exitOutcome.signal ?? "none"})`);
              if (signal?.aborted) signal.throwIfAborted();
              evidence.last_health = context.redact(error.message);
              continue;
            }
            signal?.throwIfAborted();
            if (exitOutcome) throw new Error(`native baseline helper exited during readiness (code ${exitOutcome.code}, signal ${exitOutcome.signal ?? "none"})`);
            evidence.health_status = 200;
            evidence.health_body = context.redact(body.slice(0, 4096));
            evidence.readiness_elapsed_ms = Math.max(0, performance.now() - started);
            return;
          }
          await outcome.response.body?.cancel();
        } else {
          if (signal?.aborted) signal.throwIfAborted();
          evidence.last_health = context.redact(outcome.error.message);
        }
      } finally {
        requestAbort.abort();
        activeRequest = null;
      }
      if (exitOutcome) throw new Error(`native baseline helper exited during readiness (code ${exitOutcome.code}, signal ${exitOutcome.signal ?? "none"})`);
      await Promise.race([context.delay(Math.min(100, Math.max(1, Math.ceil(deadline - performance.now())))), exited]);
    }
    evidence.readiness_elapsed_ms = Math.max(0, performance.now() - started);
    throw new Error(`native baseline did not become healthy within 10000ms: ${evidence.last_health}`);
    } finally {
      evidence.readiness_elapsed_ms ??= Math.max(0, performance.now() - started);
      activeRequest?.abort();
    }
  }

  async function observeNativeBaseline(label) {
    const result = await runOwnedHelper(
      `Observe ${label} native baseline cgroup`,
      nativeBaselineHelper,
      ["observe", "--state-root", stateRoot],
      `m3-runtime-native-baseline-${label}.log`,
      10_000,
    );
    if (result.code !== 0) throw new Error(`${label} native baseline cgroup observation failed`);
    let observation;
    try { observation = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch { throw new Error(`${label} native baseline cgroup observation was not valid JSON`); }
    const limits = observation?.observed_limits;
    if (observation?.schema !== "hostlet.runtime.native-baseline-observation/v1" || !Number.isInteger(observation.pid) || observation.pid <= 0 || limits?.cpu_max !== "25000 100000" || limits?.memory_max_bytes !== RUNTIME_POLICY.memory_bytes || limits?.memory_swap_max_bytes !== RUNTIME_POLICY.memory_swap_bytes || limits?.pids_max !== RUNTIME_POLICY.pids || !Number.isFinite(limits.cpu_usage_usec) || limits.cpu_usage_usec < 0 || !Number.isFinite(limits.memory_peak_bytes) || limits.memory_peak_bytes <= 0) throw new Error(`${label} native baseline observation lacks the exact cgroup budget and measurements`);
    return observation;
  }

  async function runPressureWithLiveness(operation, label, peerEntry) {
    if (!peerEntry?.relay) throw new Error(`${label} requires a live peer tenant relay`);
    const startedAt = performance.now();
    const samples = [];
    let operationStartedAt = null;
    let finishedAt = null;
    let operationResult;
    let operationError = null;
    let finished = false;
    const monitor = (async () => {
      while (!finished) {
        const sampleStartedAt = performance.now();
        const [peerHealth, controlHealth] = await Promise.all([
          requestThroughRelay(peerEntry.relay, "/healthz").catch(() => ({ status: 0 })),
          m3.call("/healthz").catch(() => ({ status: 0 })),
        ]);
        const sampleFinishedAt = performance.now();
        samples.push({
          peer_healthy: peerHealth.status === 200,
          control_healthy: controlHealth.status === 200,
          started_at_ms: sampleStartedAt - startedAt,
          finished_at_ms: sampleFinishedAt - startedAt,
        });
        if (finished) break;
        await context.delay(RUNTIME_LIVENESS_INTERVAL_MS);
      }
    })();
    await Promise.resolve().then(() => {
      operationStartedAt = performance.now();
      return operation();
    }).then(
      (value) => { operationResult = value; },
      (error) => { operationError = error; },
    ).finally(() => { finishedAt = performance.now(); finished = true; });
    await monitor;
    const operationStartOffset = Math.max(0, (operationStartedAt ?? startedAt) - startedAt);
    const operationEndOffset = Math.max(operationStartOffset, (finishedAt ?? performance.now()) - startedAt);
    const elapsedMs = Math.max(0.001, operationEndOffset - operationStartOffset);
    const overlapSampleCount = samples.filter((sample) => sample.started_at_ms <= operationEndOffset && sample.finished_at_ms >= operationStartOffset).length;
    const peerHealthy = samples.length > 0 && samples.every((sample) => sample.peer_healthy);
    const controlHealthy = samples.length > 0 && samples.every((sample) => sample.control_healthy);
    const liveness = {
      sample_count: samples.length,
      overlap_sample_count: overlapSampleCount,
      elapsed_ms: elapsedMs,
      peer_healthy: peerHealthy,
      control_healthy: controlHealthy,
    };
    if (operationError) {
      operationError.pressureLiveness = liveness;
      throw operationError;
    }
    return { result: operationResult, liveness };
  }

  function requireHealthyPressureLiveness(liveness, label) {
    if (!liveness || liveness.sample_count < 2 || liveness.overlap_sample_count < 2 || !liveness.peer_healthy || !liveness.control_healthy) throw new Error(`${label} did not retain repeated healthy peer/control samples throughout pressure`);
  }

  function processPressureEvidencePasses(response, observation, requestFailed = false, stopInvocation = null) {
    const stopReceipt = stopInvocation?.receipt;
    const receipt = stopReceipt ?? observation?.receipt;
    const limits = receipt?.observed_limits;
    const memoryEvents = limits?.memory_events;
    const codes = response?.payload?.codes;
    const structuredResponse = response?.status === 200 && response.payload?.failed > 0 && Array.isArray(codes) && codes.some((code) => code === "EAGAIN" || code === "ENOMEM");
    const stopReceiptValid = stopReceipt?.operation === "stop" && stopReceipt.status === "stopped" && stopReceipt.result === "passed" && stopReceipt.runsc_status === null && stopReceipt.reason_code === "process_limit_exceeded";
    const stoppedObservation = observation?.receipt?.status === "stopped" && observation?.receipt?.runsc_status === "stopped";
    const stoppedAfterRequestFailure = requestFailed && response === null && stoppedObservation && stopReceiptValid;
    const structuredStopped = structuredResponse && stopInvocation !== null && stoppedObservation && stopReceiptValid;
    return (structuredResponse || stoppedAfterRequestFailure) &&
      (stopInvocation === null || structuredStopped || stoppedAfterRequestFailure) && receipt?.reason_code === "process_limit_exceeded" && limits?.pids_max === RUNTIME_POLICY.pids && (limits?.pids_events?.max ?? 0) > 0 &&
      memoryEvents?.max === 0 && memoryEvents?.oom === 0 && memoryEvents?.oom_kill === 0;
  }

  function runtimeCgroupEpoch(limits) {
    const match = typeof limits?.cgroup_path === "string" ? /^\/hostlet-owned-runtime-[0-9a-f]{16}-e([1-9][0-9]*)$/.exec(limits.cgroup_path) : null;
    return match ? Number(match[1]) : null;
  }

  function runtimeCgroupLimitsMatch(limits) {
    return limits?.cpu_max === "25000 100000" && limits?.memory_max_bytes === RUNTIME_POLICY.memory_bytes && limits?.memory_swap_max_bytes === RUNTIME_POLICY.memory_swap_bytes && limits?.pids_max === RUNTIME_POLICY.pids;
  }

  function memoryFreshAttemptPasses(previousReceipt, candidate) {
    const previous = previousReceipt?.receipt?.observed_limits;
    const fresh = candidate?.receipt?.observed_limits;
    const previousEpoch = runtimeCgroupEpoch(previous);
    const freshEpoch = runtimeCgroupEpoch(fresh);
    const receipt = previousReceipt?.receipt;
    const identity = createHash("sha256").update(`${receipt?.allocation_id}:${receipt?.generation}:${receipt?.fence}`).digest("hex").slice(0, 16);
    if (previous?.cgroup_path !== `/hostlet-owned-runtime-${identity}-e${previousEpoch}` || fresh?.cgroup_path !== `/hostlet-owned-runtime-${identity}-e${freshEpoch}`) return false;
    return candidate?.receipt?.operation === "inspect" && candidate.receipt.status === "running" && candidate.receipt.result === "passed" && candidate.receipt.runsc_status === "running" && candidate.receipt.health?.passing === true && !["runtime_oom", "process_limit_exceeded"].includes(candidate.receipt.reason_code) && typeof previous?.cgroup_path === "string" && typeof fresh?.cgroup_path === "string" && previous.cgroup_path !== fresh.cgroup_path && Number.isInteger(previousEpoch) && Number.isInteger(freshEpoch) && freshEpoch > previousEpoch && runtimeCgroupLimitsMatch(previous) && runtimeCgroupLimitsMatch(fresh) && fresh.memory_events?.max === 0 && fresh.memory_events?.oom === 0 && fresh.memory_events?.oom_kill === 0 && fresh.pids_events?.max === 0;
  }

  function cleanupReceiptPasses(invocation) {
    const cleanup = invocation?.receipt?.cleanup;
    return invocation?.receipt?.operation === "cleanup" && invocation.receipt.result === "passed" && invocation.receipt.status === "cleaned" && cleanup?.sandbox_absent === true && cleanup?.application_namespace_absent === true && cleanup?.gateway_namespace_absent === true && cleanup?.cgroup_absent === true && cleanup?.mounts_absent === true && cleanup?.state_retained === false;
  }

  async function exercisePattern(buildOutputs, key, startIndex, peer, { recoveryId = null, databaseAssertions = false, benchmarkRequests = false } = {}) {
    const build = oneApplicationOutput(buildOutputs, key);
    const starts = [];
    let healthyStarts = 0;
    const receipts = [];
    const requestSamples = [];
    const benchmarkRequestSamples = [];
    let benchmarkMeasurement = null;
    const total = 3;
    let assertionsPassed = 0;
    const assertionsTotal = key === "next16" ? 6 : databaseAssertions ? 4 : 2;
    let warmIdleSeconds = 0;
    const nextPassCounts = [];
    const unmetRequirements = new Set();
    const evaluationIdentities = [];
    const databasePassCounts = [];
    const peerReceiptDigests = [];
    let benchmarkWallElapsedMs = null;
    for (let sample = 0; sample < total; sample += 1) {
      let entry;
      const attemptStarted = performance.now();
      try {
        try {
          entry = await launchBootstrap(build, startIndex + sample, peer, [], { recoveryId });
        } catch (error) {
          if (key !== "next16" || context.abortSignal?.aborted || error instanceof AggregateError || error.startupDeadlineExceeded !== true || !Array.isArray(error.runtimeReceiptDigests) || error.runtimeReceiptDigests.length === 0) throw error;
          starts.push(Number.isFinite(error.startupMs) ? error.startupMs : Math.max(1, Math.round(performance.now() - attemptStarted)));
          receipts.push(...(error.runtimeReceiptDigests ?? []).filter((digest) => DIGEST.test(digest)));
          nextPassCounts.push(0);
          unmetRequirements.add("cold_start_health");
          continue;
        }
        if (peer) evaluationIdentities.push({ allocation_id: entry.allocation.id, generation: entry.allocation.generation, fence: entry.allocation.fence });
        if (entry.peerReceipt) peerReceiptDigests.push(sha256(jsonLine(entry.peerReceipt)));
        starts.push(entry.startupMs);
        healthyStarts += 1;
        receipts.push(...(entry.startupReceiptDigests ?? [entry.started.digest, entry.inspected.digest]));
        const health = await requestThroughRelay(entry.relay, build.healthPath ?? entry.allocation.health_path);
        if (health.status !== 200) throw new Error(`${key} health request failed`);
        assertionsPassed = Math.max(assertionsPassed, 1);
        if (key === "next16") {
          const page = await requestThroughRelay(entry.relay, "/");
          const apiResponse = await requestThroughRelay(entry.relay, "/api/release");
          const image = await requestThroughRelay(entry.relay, "/_next/image?url=%2Ffixture.svg&w=64&q=75");
          const actionField = /name=["'](\$ACTION_(?:ID|REF)_[^"']+)["']/.exec(page.text)?.[1];
          let actionPassed = false;
          if (actionField) {
            const form = new FormData(); form.append(actionField, ""); form.append("value", "runtime-server-action");
            const actionResponse = await fetch(`http://127.0.0.1:${entry.relay.port}/`, { method: "POST", body: form, headers: { Accept: "text/x-component" }, signal: AbortSignal.any([AbortSignal.timeout(10_000), context.abortSignal]) });
            const actionText = await actionResponse.text();
            actionPassed = actionResponse.status === 200 && actionText.includes("runtime-server-action") && actionText.includes("next16-v1");
          }
          const checks = new Map([
            ["standalone_page", page.status === 200 && page.text.includes("Next 16 standalone fixture")],
            ["server_rendering", page.text.includes("SSR next16-v1")],
            ["read_only_cache", page.text.includes("Cache owned-static-value")],
            ["route_handler", apiResponse.status === 200 && apiResponse.payload?.release_id === "next16-v1"],
            ["image_optimization", image.status === 200],
            ["server_action", actionPassed],
          ]);
          const passed = [...checks.values()].filter(Boolean).length;
          nextPassCounts.push(passed);
          for (const [name, value] of checks) if (!value) unmetRequirements.add(name);
        } else if (databaseAssertions) {
          const before = await requestThroughRelay(entry.relay, "/api/items");
          const name = `restore-probe-${randomUUID()}`;
          const write = await requestThroughRelay(entry.relay, "/api/items", { method: "POST", body: { name } });
          const after = await requestThroughRelay(entry.relay, "/api/items");
          const checks = [health.status === 200, before.status === 200, write.status === 201 && write.payload?.item?.name === name, after.status === 200 && after.payload?.items?.some((item) => item.name === name)];
          databasePassCounts.push(checks.filter(Boolean).length);
          assertionsPassed = Math.min(...databasePassCounts);
        } else {
          const root = await requestThroughRelay(entry.relay, build.healthPath ?? "/healthz");
          if (root.status === 200) assertionsPassed = 2;
        }
        const sampleIsBenchmark = benchmarkRequests && sample === 0;
        const benchmarkBefore = sampleIsBenchmark ? executorResourceMeasurement(entry.inspected, `${key} benchmark baseline`) : null;
        const benchmarkStartedAt = sampleIsBenchmark ? performance.now() : null;
        const requestCount = sampleIsBenchmark ? RUNTIME_BENCHMARK_REQUEST_COUNT : 20;
        for (let index = 0; index < requestCount; index += 1) {
          const response = await requestThroughRelay(entry.relay, build.healthPath ?? entry.allocation.health_path);
          if (response.status !== 200) throw new Error(`${key} measured health request failed`);
          const elapsedMs = response.elapsedMs;
          requestSamples.push(elapsedMs);
          if (sampleIsBenchmark) benchmarkRequestSamples.push(elapsedMs);
        }
        if (sampleIsBenchmark) {
          benchmarkWallElapsedMs = Math.max(1, performance.now() - benchmarkStartedAt);
          const benchmarkAfter = await invoke(entry.allocation, "inspect", { network: entry.network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment });
          receipts.push(benchmarkAfter.digest);
          const after = executorResourceMeasurement(benchmarkAfter, `${key} benchmark result`);
          const cpuUsec = after.cpuUsec - benchmarkBefore.cpuUsec;
          if (!(cpuUsec > 0)) throw new Error(`${key} benchmark cgroup CPU delta is unavailable`);
          benchmarkMeasurement = { cpu_usec: cpuUsec, peak_memory_bytes: after.peakMemoryBytes, wall_elapsed_ms: benchmarkWallElapsedMs, receipt_digest: benchmarkAfter.digest };
        }
        if (sample === total - 1) {
          const before = Date.now();
          await context.delay(60_000);
          const after = await invoke(entry.allocation, "inspect", { network: entry.network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment });
          receipts.push(after.digest);
          if (!after.receipt.health?.passing) throw new Error(`${key} stopped or became unhealthy while idle`);
          warmIdleSeconds = Math.floor((Date.now() - before) / 1000);
        }
      } finally { if (entry) await finishBootstrap(entry); }
    }
    const result = {
      pattern: { key, assertions_passed: key === "next16" ? Math.min(...nextPassCounts) : assertionsPassed, assertions_total: assertionsTotal, cold_starts_healthy: healthyStarts, cold_starts_total: total, cold_start_ms: starts, warm_idle_seconds: warmIdleSeconds, admission_rejected: unmetRequirements.size > 0, unmet_requirements: [...unmetRequirements] },
      receiptDigests: receipts, requestSamples, benchmarkRequestSamples, benchmarkMeasurement, benchmarkWallElapsedMs, evaluationIdentities, peerReceiptDigests,
    };
    writePrivate(join(context.artifactDir, `m3-runtime-pattern-${key}-${++measurementSequence}.json`), jsonLine(result), "wx");
    return result;
  }

  async function runNativeBaseline(build, { measure = true, abortSignal } = {}) {
    if (!build.runtimeRootfs) throw new Error("native baseline requires the assembled owned Node rootfs");
    const signal = AbortSignal.any([context.abortSignal, ...(abortSignal ? [abortSignal] : [])]);
    signal.throwIfAborted();
    const port = await context.allocatePort();
    const relayPort = await context.allocatePort();
    if (existsSync(nativeBaselineMetadataPath)) throw new Error("native baseline metadata from an earlier run is still present");
    const [baselineExecutable, baselineArguments] = command(nativeBaselineHelper, ["start", "--state-root", stateRoot, "--artifact-root", artifactRoot, "--rootfs", build.runtimeRootfs, "--port", String(port), "--relay-port", String(relayPort)]);
    const helperLogName = `m3-runtime-native-baseline-${randomUUID()}.log`;
    const process = context.spawnManaged(
      "M3 native Node baseline",
      baselineExecutable,
      baselineArguments,
      { env: m3.componentEnvironment("runtime") },
      helperLogName,
    );
    const baselineStarted = performance.now();
    const evidence = {
      schema: "hostlet.runtime.native-readiness/v1", rootfs_tree_digest: build.runtimeTreeDigest ?? null,
      helper_pid: process.child.pid, helper_log: process.record.log,
      metadata_deadline_ms: 10_000, readiness_deadline_ms: 10_000, request_interval_ms: 500,
      last_health: "no response", health_status: null, health_body: null,
      readiness_elapsed_ms: null, total_elapsed_ms: null, helper_exit: null,
      failure_observed_at: null, exit_to_failure_ms: null, metadata_identity_available: false,
      cgroup_path: null, relay_pid: null, node_starttime_ticks: null, relay_starttime_ticks: null,
      metadata_absent: null, cgroup_absent: null, node_pid_absent: null, relay_pid_absent: null,
      cleanup_succeeded: null,
    };
    let primaryError = null;
    try {
      const metadata = await waitForNativeBaseline(process, signal);
      if (metadata.relay_port !== relayPort) throw new Error("native baseline metadata does not bind the requested owned relay port");
      if (!/^\/sys\/fs\/cgroup\/hostlet-native-baseline-[0-9a-f]{32}$/.test(metadata.cgroup_path) || !Number.isInteger(metadata.relay_pid) || metadata.relay_pid <= 0) throw new Error("native baseline metadata has invalid owned process identity");
      evidence.node_pid = metadata.pid;
      evidence.relay_port = metadata.relay_port;
      evidence.relay_pid = metadata.relay_pid;
      evidence.cgroup_path = metadata.cgroup_path;
      evidence.node_starttime_ticks = procStarttimeTicks(metadata.pid);
      evidence.relay_starttime_ticks = procStarttimeTicks(metadata.relay_pid);
      evidence.metadata_identity_available = true;
      const baselineUrl = `http://127.0.0.1:${relayPort}${build.healthPath ?? "/healthz"}`;
      await waitForNativeReadiness(process, baselineUrl, signal, evidence);
      if (!measure) return evidence;
      for (let index = 0; index < 2; index += 1) {
        const warmup = await fetch(baselineUrl, { signal: AbortSignal.any([AbortSignal.timeout(5_000), context.abortSignal]) });
        if (warmup.status !== 200) throw new Error("native baseline warmup request failed");
        const warmupText = await warmup.text();
        try { JSON.parse(warmupText); } catch { /* requestThroughRelay also tolerates non-JSON health bodies */ }
      }
      const measuredPid = await findNativeNodeProcess(process.child.pid);
      if (metadata.pid !== measuredPid) throw new Error("native baseline metadata does not identify the exact Node server process");
      const before = await observeNativeBaseline("before");
      const samples = [];
      const started = performance.now();
      for (let index = 0; index < RUNTIME_BENCHMARK_REQUEST_COUNT; index += 1) {
        const before = performance.now();
        const response = await fetch(baselineUrl, { signal: AbortSignal.any([AbortSignal.timeout(5_000), context.abortSignal]) });
        if (response.status !== 200) throw new Error("native baseline request failed");
        const responseText = await response.text();
        try { JSON.parse(responseText); } catch { /* requestThroughRelay also tolerates non-JSON health bodies */ }
        samples.push(Math.max(0.001, performance.now() - before));
      }
      const elapsed = Math.max(1, performance.now() - started);
      const after = await observeNativeBaseline("after");
      if (after.pid !== measuredPid) throw new Error("native baseline process identity changed during measurement");
      const cpuUsec = after.observed_limits.cpu_usage_usec - before.observed_limits.cpu_usage_usec;
      if (!(cpuUsec > 0)) throw new Error("native baseline cgroup CPU delta is unavailable");
      const result = {
        schema: "hostlet.runtime.native-baseline/v1", request_samples_ms: samples,
        cpu_usec: cpuUsec, peak_memory_bytes: after.observed_limits.memory_peak_bytes,
        wall_elapsed_ms: elapsed, throughput_rps: RUNTIME_BENCHMARK_REQUEST_COUNT * 1_000 / elapsed,
        native_transport: "owned_local_relay_host_netns", cgroup_path: after.cgroup_path,
      };
      writePrivate(join(context.artifactDir, `m3-runtime-native-baseline-${++measurementSequence}.json`), jsonLine(result), "wx");
      return result;
    } catch (error) {
      primaryError = error;
      evidence.failure_observed_at = new Date().toISOString();
      if (process.record.stoppedAt !== null) evidence.exit_to_failure_ms = Math.max(0, Date.parse(evidence.failure_observed_at) - Date.parse(process.record.stoppedAt));
      throw error;
    } finally {
      evidence.total_elapsed_ms = Math.max(0, performance.now() - baselineStarted);
      evidence.helper_exit = process.record.stoppedAt === null ? null : { code: process.record.exitCode, signal: process.record.signal, stopped_at: process.record.stoppedAt };
      evidence.ready = primaryError === null && evidence.health_status === 200;
      if (primaryError) {
        evidence.error = context.redact(primaryError.message);
        primaryError.nativeBaselineEvidence = evidence;
      }
      let cleanupError = null;
      try { await context.stopManaged(process, "M3 native baseline complete"); }
      catch (error) { cleanupError = error; }
      try {
        evidence.metadata_absent = exactPathAbsent(nativeBaselineMetadataPath);
        if (evidence.metadata_identity_available) {
          evidence.cgroup_absent = exactPathAbsent(evidence.cgroup_path);
          evidence.node_pid_absent = exactPidAbsent(evidence.node_pid, evidence.node_starttime_ticks);
          evidence.relay_pid_absent = exactPidAbsent(evidence.relay_pid, evidence.relay_starttime_ticks);
        }
        evidence.cleanup_succeeded = !cleanupError && evidence.metadata_absent &&
          (!evidence.metadata_identity_available || (evidence.cgroup_absent && evidence.node_pid_absent && evidence.relay_pid_absent)) &&
          process.record.stoppedAt !== null;
        if (!evidence.cleanup_succeeded && !cleanupError) cleanupError = new Error("native baseline exact owned cleanup verification failed");
      } catch (error) { cleanupError ??= error; evidence.cleanup_succeeded = false; }
      if (cleanupError) {
        evidence.cleanup_error = context.redact(cleanupError.message);
        if (primaryError) primaryError.cleanupError = cleanupError;
      }
      evidence.helper_exit ??= process.record.stoppedAt === null ? null : { code: process.record.exitCode, signal: process.record.signal, stopped_at: process.record.stoppedAt };
      try { persistRuntimeArtifact(join(context.artifactDir, `m3-runtime-native-readiness-${process.child.pid}.json`), evidence, "native baseline readiness artifact"); }
      catch (error) {
        if (primaryError) primaryError.evidenceError = error;
        else throw error;
      }
      if (!primaryError && cleanupError) throw cleanupError;
    }
  }

  async function exerciseRuntimeEvaluation({ buildOutputs, tenantPeers, nodeBaseRoots }) {
    lastRuntimeInputs = { buildOutputs, tenantPeers, nodeBaseRoots };
    evaluatedNodeBaseRoots = nodeBaseRoots;
    const assembled = await assembleArtifacts(buildOutputs, nodeBaseRoots);
    const fullstackProjectId = m3.state.m3Build?.fullstackV1?.prepared?.project?.project?.id ?? null;
    const peer = primaryTenantPeer(tenantPeers, fullstackProjectId);
    if (!peer) throw new Error("runtime evaluation requires the exact owned primary PostgreSQL peer inventory");
    if (fullstackProjectId) projectBuildOutputs.set(fullstackProjectId, oneApplicationOutput(assembled, "fullstack_v1"));
    const baseline = await runNativeBaseline(oneApplicationOutput(assembled, "node22_api"));
    const node22 = await exercisePattern(assembled, "node22_api", 1, null, { benchmarkRequests: true });
    const node24 = await exercisePattern(assembled, "fullstack_v1", 5, peer);
    const fullstackV2 = await exercisePattern(assembled, "fullstack_v2", 9, peer);
    const next = await exercisePattern(assembled, "next16", 16, null);
    const policy = await exercisePattern(assembled, "policy_probes", 20, null);
    const policyBuild = oneApplicationOutput(assembled, "policy_probes");
    const invalidRequestAllocation = bootstrapAllocation(policyBuild, 15);
    let malformedRequest;
    let overLimitRequest;
    try {
      malformedRequest = await rejectRequest(invalidRequestAllocation, { unknown_runtime_field: true }, "runtime_request_invalid");
      overLimitRequest = await rejectRequest(invalidRequestAllocation, { resources: { ...EXECUTOR_RESOURCES, memory_bytes: EXECUTOR_RESOURCES.memory_bytes + 1 } }, "runtime_policy_not_admitted");
    } finally {
      releasePendingNetworkSlot(invalidRequestAllocation);
    }
    const isolationFixtures = await createIsolationFixtures();
    const httpFixture = isolationFixtures.find((value) => value.kind === "http");
    const dnsFixture = isolationFixtures.find((value) => value.kind === "dns");
    let policyEntry; let peerEntry;
    const networkReceipts = [];
    const resourceReceipts = [];
    const resourceObservedReasons = [];
    let isolation; const resourceResults = new Map();
    const resourceProbeEvidence = new Map();
    const resourceProbeEvidencePath = join(context.artifactDir, "m3-runtime-resource-probes.json");
    const persistResourceProbeEvidence = () => writePrivate(
      resourceProbeEvidencePath,
      jsonLine({ schema: "hostlet.runtime.resource-probes/v1", probes: [...resourceProbeEvidence.values()] }),
    );
    try {
      peerEntry = await launchBootstrap(oneApplicationOutput(assembled, "node22_api"), 11);
      policyEntry = await launchBootstrap(policyBuild, 12, null, isolationFixtures, { networkOnlyPeer: peer });
      networkReceipts.push(policyEntry.started.digest, policyEntry.inspected.digest);
      const probeDescriptors = [
        { name: "platform_ipv4", type: "http", expect: "deny", url: "http://10.250.0.10:8080/" },
        { name: "platform_ipv6", type: "http", expect: "deny", url: "http://[fd77:250::10]:8080/" },
        { name: "tenant_peer_ipv4", type: "http", expect: "deny", url: `http://${peerEntry.network.application_ipv4}:3000/healthz` },
        { name: "tenant_peer_ipv6", type: "http", expect: "deny", url: `http://[${peerEntry.network.application_ipv6}]:3000/healthz` },
        { name: "docker_socket", type: "path", expect: "deny", path: "/var/run/docker.sock" },
        { name: "host_path", type: "path", expect: "deny", path: "/etc/hostlet-owner" },
        { name: "builder_ipv4", type: "tcp", expect: "deny", host: "10.251.0.10", port: 22 },
        { name: "builder_ipv6", type: "tcp", expect: "deny", host: "fd77:251::10", port: 22 },
        { name: "metadata_ipv4", type: "http", expect: "deny", url: "http://169.254.169.254/latest/meta-data/" },
        { name: "metadata_ipv6", type: "http", expect: "deny", url: "http://[fd00:ec2::254]/latest/meta-data/" },
        { name: "dns_forbidden", type: "dns", expect: "deny", server: "10.252.0.53", hostname: "blocked.hostlet.invalid", family: 4 },
        { name: "dns_allowed", type: "dns", expect: "allow", server: dnsFixture.endpointIpv4, hostname: "allowed.hostlet.invalid", family: 4 },
        { name: "dns_forbidden_ipv6", type: "dns", expect: "deny", server: "fd77:252::53", hostname: "blocked-v6.hostlet.invalid", family: 6 },
        { name: "dns_allowed_ipv6", type: "dns", expect: "allow", server: dnsFixture.endpointIpv6, hostname: "allowed-v6.hostlet.invalid", family: 6 },
        { name: "tenant_database_ipv4", type: "tcp", expect: "allow", host: peer.endpointIpv4, port: 5432 },
        { name: "tenant_database_ipv6", type: "tcp", expect: "allow", host: peer.endpointIpv6, port: 5432 },
        { name: "public_http_ipv4", type: "http", expect: "allow", url: `http://${httpFixture.endpointIpv4}:8080/owned-public` },
        { name: "public_http_ipv6", type: "http", expect: "allow", url: `http://[${httpFixture.endpointIpv6}]:8080/owned-public-v6` },
      ];
      const isolationTimeoutMs = Math.min(60_000, probeDescriptors.length * 1_500 + 3_000);
      isolation = await requestThroughRelay(policyEntry.relay, "/probe/isolation", { method: "POST", body: { targets: probeDescriptors }, timeoutMs: isolationTimeoutMs });
      if (isolation.status !== 200 || isolation.payload?.schema !== "hostlet.owned-runtime-isolation/v1" || !Array.isArray(isolation.payload.results)) throw new Error("inside-sandbox isolation probe failed");
      for (const probe of [
        { mode: "cpu", amount: 2_000 }, { mode: "scratch", amount: 300 },
        { mode: "connections", amount: 150, target: { host: peer.endpointIpv4, port: 5432 } }, { mode: "processes", amount: 160 },
      ]) {
        let pressure;
        let requestFailed = false;
        let operationError = null;
        try {
          pressure = await runPressureWithLiveness(
            () => requestThroughRelay(policyEntry.relay, "/probe/resource", { method: "POST", body: probe }),
            `${probe.mode} pressure`,
            peerEntry,
          );
        } catch (error) {
          operationError = error instanceof Error ? error.message : String(error);
          resourceProbeEvidence.set(probe.mode, {
            mode: probe.mode,
            request_failed: true,
            error: operationError,
            liveness: error?.pressureLiveness ?? null,
          });
          persistResourceProbeEvidence();
          if (probe.mode !== "processes") throw error;
          requestFailed = true;
          pressure = { result: null, liveness: error?.pressureLiveness ?? null };
        }
        const response = pressure.result;
        resourceProbeEvidence.set(probe.mode, {
          mode: probe.mode,
          request_failed: requestFailed,
          response: response ? { status: response.status ?? null, payload: response.payload ?? null, text: response.text ?? null, elapsed_ms: response.elapsedMs ?? null } : null,
          operation_error: operationError,
          liveness: pressure.liveness,
        });
        persistResourceProbeEvidence();
        let observation;
        try {
          observation = await invoke(policyEntry.allocation, "inspect", { network: policyEntry.network, secret_version_refs: policyEntry.secretVersionRefs, environment: policyEntry.environment });
        } catch (inspectError) {
          if (requestFailed) {
            resourceProbeEvidence.set(probe.mode, { ...resourceProbeEvidence.get(probe.mode), inspect_error: inspectError instanceof Error ? inspectError.message : String(inspectError) });
            persistResourceProbeEvidence();
            throw new AggregateError([inspectError], "PID pressure request failed and stopped-runtime inspection failed");
          }
          throw inspectError;
        }
        resourceResults.set(probe.mode, { response, observation, request_failed: requestFailed, operation_error: operationError, ...pressure.liveness });
        resourceProbeEvidence.set(probe.mode, { ...resourceProbeEvidence.get(probe.mode), observation_digest: observation.digest });
        persistResourceProbeEvidence();
        resourceReceipts.push(observation.digest);
        networkReceipts.push(observation.digest);
        requireHealthyPressureLiveness(pressure.liveness, `${probe.mode} pressure`);
        if (requestFailed) {
          break;
        }
        if (probe.mode === "scratch") {
          const scratchCleanup = await requestThroughRelay(policyEntry.relay, "/probe/resource", { method: "POST", body: { mode: "scratch_cleanup", amount: 0 } });
          if (scratchCleanup.status !== 200 || scratchCleanup.payload?.removed !== true) throw new Error("scratch pressure left no exact owned file cleanup receipt");
        }
      }
    } finally { if (policyEntry) await finishBootstrap(policyEntry); }
    persistResourceProbeEvidence();
    const processEvidence = resourceResults.get("processes");
    const processNeedsStopReceipt = processEvidence?.request_failed === true || processEvidence?.observation?.receipt?.status === "stopped";
    const processStopEvidence = processNeedsStopReceipt ? policyEntry?.stop ?? null : null;
    if (processNeedsStopReceipt) {
      if (!processStopEvidence) throw new Error("PID pressure stopped the runtime without a retained stop receipt");
      resourceReceipts.push(processStopEvidence.digest);
      resourceProbeEvidence.set("processes", {
        ...resourceProbeEvidence.get("processes"),
        stop_observation_digest: processStopEvidence.digest,
        stop_receipt_status: processStopEvidence.receipt?.status ?? null,
        stop_runsc_status: processStopEvidence.receipt?.runsc_status ?? null,
        stop_reason_code: processStopEvidence.receipt?.reason_code ?? null,
        stop_pids_max: processStopEvidence.receipt?.observed_limits?.pids_max ?? null,
        stop_pids_max_events: processStopEvidence.receipt?.observed_limits?.pids_events?.max ?? null,
        stop_memory_events: processStopEvidence.receipt?.observed_limits?.memory_events ?? null,
      });
      persistResourceProbeEvidence();
    }
    if ([...resourceResults.entries()].some(([mode, value]) => value.response?.status !== 200 && !(mode === "processes" && value.request_failed === true && value.response === null))) throw new Error("one or more runtime resource probes failed to return evidence");
    const cpuEvidence = resourceResults.get("cpu");
    const scratchEvidence = resourceResults.get("scratch");
    const connectionEvidence = resourceResults.get("connections");
    const processReceipt = processStopEvidence?.receipt ?? processEvidence?.observation?.receipt;
    if (cpuEvidence?.observation.receipt.reason_code !== "cpu_throttled") throw new Error("CPU pressure produced no immediate actual cgroup throttling receipt");
    if (!(cpuEvidence.observation.receipt.observed_limits?.cpu_nr_throttled > 0)) throw new Error("CPU pressure receipt has no actual throttling counter");
    if (!scratchEvidence?.response.payload?.failed || scratchEvidence.response.payload.code !== "ENOSPC") throw new Error("scratch pressure produced no actual ENOSPC evidence");
    const scratchObservation = scratchEvidence.observation.receipt.scratch_observation;
    const scratchReason = scratchEvidence.observation.receipt.reason_code;
    if (scratchReason !== "scratch_limit_exceeded" || scratchObservation?.capacity_bytes !== RUNTIME_POLICY.scratch_bytes || scratchObservation?.available_bytes !== 0) throw new Error("scratch pressure produced no trusted zero-available receipt evidence");
    if (!connectionEvidence?.response.payload?.results?.some((value) => value !== "connected") || connectionEvidence.observation.receipt.reason_code !== "network_connection_limit") throw new Error("connection pressure produced no actual nft connection-limit receipt");
    const connectionLimitedPackets = connectionEvidence.observation.receipt.network?.counters?.find((value) => value.name === "connection_limited")?.packets ?? 0;
    if (!(connectionLimitedPackets > 0)) throw new Error("connection pressure receipt has no actual nft limit counter");
    if (!processPressureEvidencePasses(processEvidence?.response, processEvidence?.observation, processEvidence?.request_failed === true, processStopEvidence)) throw new Error("PID pressure produced no actual EAGAIN/ENOMEM or stopped process-limit receipt without an OOM event");
    const memoryEntry = await launchBootstrap(policyBuild, 13);
    let memoryPressure;
    try {
      memoryPressure = await runPressureWithLiveness(
        () => requestThroughRelay(memoryEntry.relay, "/probe/resource", { method: "POST", body: { mode: "memory", amount: 600 } })
          .then((response) => ({ response, error: null }), (error) => ({ response: null, error: error.message })),
        "memory pressure",
        peerEntry,
      );
    } catch (error) {
      resourceProbeEvidence.set("memory", {
        mode: "memory",
        error: error instanceof Error ? error.message : String(error),
        liveness: error?.pressureLiveness ?? null,
      });
      persistResourceProbeEvidence();
      throw error;
    }
    const memory = memoryPressure.result;
    const memoryLiveness = memoryPressure.liveness;
    resourceProbeEvidence.set("memory", {
      mode: "memory",
      response: memory.response ? { status: memory.response.status ?? null, payload: memory.response.payload ?? null, text: memory.response.text ?? null, elapsed_ms: memory.response.elapsedMs ?? null } : null,
      operation_error: memory.error,
      liveness: memoryLiveness,
    });
    persistResourceProbeEvidence();
    const memoryInspect = await invoke(memoryEntry.allocation, "inspect", { network: memoryEntry.network, secret_version_refs: memoryEntry.secretVersionRefs, environment: memoryEntry.environment });
    resourceReceipts.push(memoryInspect.digest);
    const memoryOomReceipt = memoryInspect.receipt.reason_code === "runtime_oom" && (memoryInspect.receipt.observed_limits?.memory_events?.oom_kill ?? 0) > 0 ? memoryInspect : null;
    resourceProbeEvidence.set("memory", {
      ...resourceProbeEvidence.get("memory"),
      oom_receipt_digest: memoryInspect.digest,
      oom_reason_code: memoryInspect.receipt.reason_code,
      oom_memory_events: memoryInspect.receipt.observed_limits?.memory_events ?? null,
    });
    persistResourceProbeEvidence();
    if (!memoryOomReceipt || !memory.error) throw new Error("memory exhaustion produced no actual runtime_oom inspect receipt");
    let memoryReconcile;
    try {
      memoryReconcile = await invoke(memoryEntry.allocation, "reconcile", { network: memoryEntry.network, secret_version_refs: memoryEntry.secretVersionRefs, environment: memoryEntry.environment, timeoutMs: 45_000 });
    } catch (error) {
      resourceProbeEvidence.set("memory", { ...resourceProbeEvidence.get("memory"), reconcile_error: error instanceof Error ? error.message : String(error), reconcile_receipt_digests: error?.runtimeReceiptDigests ?? [] });
      persistResourceProbeEvidence();
      throw error;
    }
    resourceReceipts.push(memoryReconcile.digest);
    resourceProbeEvidence.set("memory", {
      ...resourceProbeEvidence.get("memory"),
      reconcile_receipt_digest: memoryReconcile.digest,
      reconcile_status: memoryReconcile.receipt.status,
      reconcile_reason_code: memoryReconcile.receipt.reason_code,
    });
    persistResourceProbeEvidence();
    if (memoryReconcile.receipt.operation !== "reconcile" || memoryReconcile.receipt.status !== "restart_scheduled" || memoryReconcile.receipt.reason_code !== "runtime_oom") throw new Error("memory OOM reconcile did not retain the previous runtime_oom cause");
    const memoryRestartPollStartedAt = performance.now();
    const memoryRestartDeadline = memoryRestartPollStartedAt + 5_000;
    const memoryRestartPollReceiptDigests = [];
    const memoryRestartPollErrors = [];
    let memoryFreshInspect = null;
    while (performance.now() < memoryRestartDeadline) {
      const remainingMs = Math.max(1, Math.ceil(memoryRestartDeadline - performance.now()));
      try {
        const candidate = await invoke(memoryEntry.allocation, "inspect", { network: memoryEntry.network, secret_version_refs: memoryEntry.secretVersionRefs, environment: memoryEntry.environment, timeoutMs: remainingMs });
        const observedAt = performance.now();
        memoryRestartPollReceiptDigests.push(candidate.digest);
        resourceReceipts.push(candidate.digest);
        if (observedAt <= memoryRestartDeadline && memoryFreshAttemptPasses(memoryOomReceipt, candidate)) {
          memoryFreshInspect = { ...candidate, observedAtMs: observedAt };
          break;
        }
      } catch (error) {
        memoryRestartPollErrors.push(error instanceof Error ? error.message : String(error));
        resourceReceipts.push(...(error?.runtimeReceiptDigests ?? []).filter((digest) => DIGEST.test(digest)));
      }
      const delayMs = Math.min(100, Math.max(0, memoryRestartDeadline - performance.now()));
      if (delayMs <= 0) break;
      await context.delay(delayMs);
    }
    resourceProbeEvidence.set("memory", {
      ...resourceProbeEvidence.get("memory"),
      restart_poll_receipt_digests: memoryRestartPollReceiptDigests,
      restart_poll_errors: memoryRestartPollErrors,
      restart_poll_elapsed_ms: performance.now() - memoryRestartPollStartedAt,
    });
    persistResourceProbeEvidence();
    if (!memoryFreshInspect) throw new Error("memory OOM replacement did not become healthy with a fresh cgroup within 5000ms");
    const previousLimits = memoryOomReceipt.receipt.observed_limits;
    const freshLimits = memoryFreshInspect.receipt.observed_limits;
    const memoryRestartFreshness = {
      previous_oom_receipt_digest: memoryOomReceipt.digest,
      previous_oom_reason_code: memoryOomReceipt.receipt.reason_code,
      previous_oom_memory_events: previousLimits.memory_events,
      previous_cgroup_path: previousLimits.cgroup_path,
      previous_cgroup_epoch: runtimeCgroupEpoch(previousLimits),
      reconcile_receipt_digest: memoryReconcile.digest,
      reconcile_status: memoryReconcile.receipt.status,
      reconcile_reason_code: memoryReconcile.receipt.reason_code,
      fresh_receipt_digest: memoryFreshInspect.digest,
      fresh_reason_code: memoryFreshInspect.receipt.reason_code,
      fresh_cgroup_path: freshLimits.cgroup_path,
      fresh_cgroup_epoch: runtimeCgroupEpoch(freshLimits),
      fresh_memory_events: freshLimits.memory_events,
      fresh_pids_events: freshLimits.pids_events,
      limits_match: runtimeCgroupLimitsMatch(previousLimits) && runtimeCgroupLimitsMatch(freshLimits),
      healthy_observed_elapsed_ms: memoryFreshInspect.observedAtMs - memoryRestartPollStartedAt,
      restart_poll_elapsed_ms: memoryFreshInspect.observedAtMs - memoryRestartPollStartedAt,
    };
    resourceProbeEvidence.set("memory", { ...resourceProbeEvidence.get("memory"), restart_freshness: memoryRestartFreshness });
    persistResourceProbeEvidence();
    await finishBootstrap(memoryEntry);
    if (memoryEntry.stop) resourceReceipts.push(memoryEntry.stop.digest);
    requireHealthyPressureLiveness(memoryLiveness, "memory pressure");
    resourceObservedReasons.push(memoryOomReceipt.receipt.reason_code);
    const crashBuild = oneApplicationOutput(assembled, "crash_runtime");
    const crashAllocation = bootstrapAllocation(crashBuild, 14);
    const crashEntry = { allocation: crashAllocation, network: crashAllocation.network, stopped: false };
    try {
      trackActive(crashEntry);
    } catch (error) {
      releasePendingNetworkSlot(crashAllocation);
      throw error;
    }
    crashEntry.prepared = await invoke(crashAllocation, "prepare", { network: crashAllocation.network });
    crashEntry.started = await invoke(crashAllocation, "start", { network: crashAllocation.network });
    const restartDelayMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    const restartAttempts = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const reconcileStartedAt = performance.now();
      const receipt = await invoke(crashAllocation, "reconcile", { network: crashAllocation.network, timeoutMs: 45_000 });
      const elapsedMs = performance.now() - reconcileStartedAt;
      resourceReceipts.push(receipt.digest);
      restartAttempts.push({ attempt: attempt + 1, receipt_digest: receipt.digest, status: receipt.receipt.status, reason_code: receipt.receipt.reason_code, expected_delay_ms: restartDelayMs[attempt] ?? 0, elapsed_ms: elapsedMs });
      resourceObservedReasons.push(receipt.receipt.reason_code);
    }
    resourceProbeEvidence.set("crash_restart", { mode: "crash_restart", attempts: restartAttempts });
    persistResourceProbeEvidence();
    if (restartAttempts.length !== 7 || restartAttempts.slice(0, 6).some((value, index) => value.status !== "restart_scheduled" || value.expected_delay_ms !== restartDelayMs[index] || !Number.isFinite(value.elapsed_ms) || value.elapsed_ms + 50 < value.expected_delay_ms || value.elapsed_ms > 45_000) || restartAttempts[6].status !== "crash_loop_backoff" || restartAttempts[6].expected_delay_ms !== 0 || !Number.isFinite(restartAttempts[6].elapsed_ms) || restartAttempts[6].elapsed_ms > 45_000) throw new Error("crashing runtime did not produce the measured bounded restart schedule");
    await finishBootstrap(crashEntry);
    const cleanupAllocation = bootstrapAllocation(policyBuild, 34);
    const cleanupEntry = { allocation: cleanupAllocation, network: cleanupAllocation.network, secretVersionRefs: [], environment: [], stopped: false };
    try {
      trackActive(cleanupEntry);
    } catch (error) {
      releasePendingNetworkSlot(cleanupAllocation);
      throw error;
    }
    cleanupEntry.prepared = await invoke(cleanupAllocation, "prepare", { network: cleanupEntry.network, secret_version_refs: [], environment: [] });
    await stopAndCleanup(cleanupEntry);
    const firstCleanup = cleanupEntry.cleanup;
    const replayCleanup = await invoke(cleanupAllocation, "cleanup", { network: cleanupEntry.network, secret_version_refs: [], environment: [], cleanup: true });
    resourceReceipts.push(firstCleanup?.digest, replayCleanup.digest);
    resourceProbeEvidence.set("cleanup_replay", {
      mode: "cleanup_replay",
      first_receipt_digest: firstCleanup?.digest ?? null,
      first_receipt: firstCleanup?.receipt ?? null,
      replay_receipt_digest: replayCleanup.digest,
      replay_receipt: replayCleanup.receipt,
    });
    persistResourceProbeEvidence();
    if (!cleanupReceiptPasses(firstCleanup) || !cleanupReceiptPasses(replayCleanup)) throw new Error("unstarted runtime cleanup or immediate cleanup replay lacked exact absence receipts");
    const cleanupOracles = {
      first_receipt_digest: firstCleanup.digest,
      first_operation: firstCleanup.receipt.operation,
      first_result: firstCleanup.receipt.result,
      first_status: firstCleanup.receipt.status,
      first: firstCleanup.receipt.cleanup,
      replay_receipt_digest: replayCleanup.digest,
      replay_operation: replayCleanup.receipt.operation,
      replay_result: replayCleanup.receipt.result,
      replay_status: replayCleanup.receipt.status,
      replay: replayCleanup.receipt.cleanup,
    };
    const results = isolation.payload.results.map((probe) => {
      const succeeded = probe.type === "path" ? probe.readable === true : probe.connected === true;
      return { ...probe, passed: probe.expect === "allow" ? succeeded : !succeeded };
    });
    const denied = results.filter((probe) => probe.expect === "deny");
    const allowed = results.filter((probe) => probe.expect === "allow");
    const httpLogs = await context.runCommand("Read M3 HTTP observer evidence", "docker", ["logs", httpFixture.containerId], { timeoutMs: 10_000, logName: "m3-runtime-http-observer.log" });
    const dnsLogs = await context.runCommand("Read M3 DNS observer evidence", "docker", ["logs", dnsFixture.containerId], { timeoutMs: 10_000, logName: "m3-runtime-dns-observer.log" });
    const peerHealth = peerEntry ? await requestThroughRelay(peerEntry.relay, "/healthz") : { status: 0 };
    if (peerEntry) await finishBootstrap(peerEntry);
    const lastNetworkReceipt = JSON.parse(readFileSync(join(m3.policyClock.stateDir, "evidence", "sha256", networkReceipts.at(-1).slice(7, 9), `${networkReceipts.at(-1).slice(9)}.json`), "utf8"));
    const forbiddenPackets = lastNetworkReceipt.network?.counters?.find((value) => value.name === "forbidden")?.packets ?? 0;
    const independentObserved = httpLogs.code === 0 && dnsLogs.code === 0 && httpLogs.stdout.includes("owned-public") && dnsLogs.stdout.includes('"kind":"dns"') && forbiddenPackets > 0;
    if (!node22.benchmarkMeasurement || !(node22.benchmarkMeasurement.wall_elapsed_ms > 0) || node22.benchmarkRequestSamples.length !== RUNTIME_BENCHMARK_REQUEST_COUNT) throw new Error("Node 22 sandbox benchmark lacks the exact measured workload");
    const sandboxCpu = node22.benchmarkMeasurement.cpu_usec;
    const sandboxPeak = node22.benchmarkMeasurement.peak_memory_bytes;
    const pressureLiveness = Object.fromEntries([
      ...[...resourceResults.entries()].map(([mode, value]) => [mode, {
        sample_count: value.sample_count,
        overlap_sample_count: value.overlap_sample_count,
        elapsed_ms: value.elapsed_ms,
        peer_healthy: value.peer_healthy,
        control_healthy: value.control_healthy,
      }]),
      ["memory", {
        sample_count: memoryLiveness.sample_count,
        overlap_sample_count: memoryLiveness.overlap_sample_count,
        elapsed_ms: memoryLiveness.elapsed_ms,
        peer_healthy: memoryLiveness.peer_healthy,
        control_healthy: memoryLiveness.control_healthy,
      }],
    ]);
    const result = {
      buildOutputs: assembled,
      patterns: [
        { ...node22.pattern, receipt_digests: node22.receiptDigests },
        { ...node24.pattern, receipt_digests: node24.receiptDigests },
        { ...fullstackV2.pattern, receipt_digests: fullstackV2.receiptDigests },
        { ...next.pattern, receipt_digests: next.receiptDigests },
        { ...policy.pattern, receipt_digests: policy.receiptDigests },
      ],
      compatibility: { baseline_throughput_rps: baseline.throughput_rps, sandbox_throughput_rps: RUNTIME_BENCHMARK_REQUEST_COUNT * 1_000 / node22.benchmarkMeasurement.wall_elapsed_ms },
      network: { forbidden_passed: denied.filter((probe) => probe.passed).length, forbidden_total: denied.length, allowed_passed: allowed.filter((probe) => probe.passed).length, allowed_total: allowed.length, independent_observation: independentObserved, forbidden_packets: forbiddenPackets, probe_kinds: results.map((probe) => probe.name), executor_receipt_digests: networkReceipts },
      resources: {
        cpu_max: "25000 100000", memory_max_bytes: 536_870_912, memory_swap_max_bytes: 0, pids_max: 128, scratch_max_bytes: 268_435_456, max_connections: 128, new_connections_per_second: 20, new_connections_burst: 40,
        enforced_reason_codes: [...new Set([cpuEvidence.observation.receipt.reason_code, scratchReason, connectionEvidence.observation.receipt.reason_code, processReceipt?.reason_code, ...resourceObservedReasons])],
        memory_restart_freshness: memoryRestartFreshness,
        cleanup_oracles: cleanupOracles,
        enforcement_oracles: {
          cpu: { receipt_digest: cpuEvidence.observation.digest, reason_code: cpuEvidence.observation.receipt.reason_code, nr_throttled: cpuEvidence.observation.receipt.observed_limits.cpu_nr_throttled },
          scratch: { receipt_digest: scratchEvidence.observation.digest, failed: scratchEvidence.response.payload.failed, error_code: scratchEvidence.response.payload.code },
          connections: { receipt_digest: connectionEvidence.observation.digest, reason_code: connectionEvidence.observation.receipt.reason_code, limited_packets: connectionLimitedPackets },
          processes: { receipt_digest: processStopEvidence?.digest ?? processEvidence.observation.digest, inspect_receipt_digest: processEvidence.observation.digest, stop_receipt_digest: processStopEvidence?.digest ?? null, http_status: processEvidence.response?.status ?? null, request_failed: processEvidence.request_failed === true, operation_error: processEvidence.operation_error ?? null, receipt_status: processReceipt?.status ?? null, receipt_result: processReceipt?.result ?? null, runsc_status: processReceipt?.runsc_status ?? null, reason_code: processReceipt?.reason_code ?? null, failed: processEvidence.response?.payload?.failed ?? null, error_codes: processEvidence.response?.payload?.codes ?? null, pids_max: processReceipt?.observed_limits?.pids_max ?? null, pids_max_events: processReceipt?.observed_limits?.pids_events?.max ?? null, memory_events: processReceipt?.observed_limits?.memory_events ?? null, inspect_receipt_status: processEvidence.observation.receipt.status, inspect_runsc_status: processEvidence.observation.receipt.runsc_status },
          crash_restart: { attempts: restartAttempts },
          request_validation: { malformed_rejected: malformedRequest.code !== 0, over_limit_rejected: overLimitRequest.code !== 0 },
          pressure_liveness: pressureLiveness,
        },
        restart_delays_seconds: [1, 2, 4, 8, 16, 30], restart_limit: 6, restart_window_seconds: 600, healthy_reset_seconds: 600, idle_stop_observed: false, executor_receipt_digests: resourceReceipts,
        peer_healthy_during_pressure: peerHealth.status === 200 && memoryLiveness.peer_healthy && [...resourceResults.values()].every((value) => value.peer_healthy),
        control_healthy_during_pressure: memoryLiveness.control_healthy && [...resourceResults.values()].every((value) => value.control_healthy),
      },
      benchmark: { baseline_cpu_usec: baseline.cpu_usec, sandbox_cpu_usec: sandboxCpu, baseline_peak_memory_bytes: baseline.peak_memory_bytes, sandbox_peak_memory_bytes: sandboxPeak, baseline_request_samples_ms: baseline.request_samples_ms, sandbox_request_samples_ms: node22.benchmarkRequestSamples },
      evaluatorDigests: { evaluator: `sha256:${context.fileSha256(join(context.repo, "e2e/support/m3-runtime.mjs"))}`, ociSchema: `sha256:${context.fileSha256(launcher)}`, unpackTool: `sha256:${context.fileSha256(artifactPreparer)}` },
      evaluationIdentity: node24.evaluationIdentities.at(-1),
      spareEvaluationIdentities: node24.evaluationIdentities.slice(0, -1),
      policyEvaluationIdentities: fullstackV2.evaluationIdentities.slice(0, 2),
      evaluationObservedAtUnixMs: Date.now(),
      assembled,
      isolationFixtures,
    };
    lastRuntimeEvaluation = result;
    return result;
  }

  async function exerciseAdmittedEnforcement({ buildOutputs, policyBuild: suppliedPolicyBuild, node22Build: suppliedNode22Build, evaluationId, memoryEvaluationId, crashEvaluationId, isolationFixtures } = {}) {
    const evaluationIds = [evaluationId, memoryEvaluationId, crashEvaluationId];
    if (evaluationIds.some((value) => !UUID.test(value ?? "")) || new Set(evaluationIds).size !== evaluationIds.length) throw new Error("admitted runtime enforcement requires three distinct capability evaluations");
    const policyBuild = requireBuildOutput("admitted-policy-probes", suppliedPolicyBuild ?? oneApplicationOutput(buildOutputs, "policy_probes"));
    const node22Build = requireBuildOutput("admitted-liveness-peer", suppliedNode22Build ?? oneApplicationOutput(buildOutputs, "node22_api"));
    const httpFixture = isolationFixtures?.find((value) => value.kind === "http");
    if (!httpFixture) throw new Error("admitted runtime enforcement requires the owned HTTP fixture");
    const resourceAllocation = await allocate(policyBuild, evaluationId);
    const memoryAllocation = await allocate(policyBuild, memoryEvaluationId);
    const crashAllocation = await allocate(policyBuild, crashEvaluationId);
    let resourceNetwork;
    let memoryNetwork;
    let crashNetwork;
    try {
      resourceNetwork = networkFor(31, [
        { address: httpFixture.endpointIpv4, port: httpFixture.port, protocol: "tcp" },
        { address: httpFixture.endpointIpv6, port: httpFixture.port, protocol: "tcp" },
      ], [], resourceAllocation);
      memoryNetwork = networkFor(32, [], [], memoryAllocation);
      crashNetwork = networkFor(33, [], [], crashAllocation);
      resourceAllocation.network = resourceNetwork;
      memoryAllocation.network = memoryNetwork;
      crashAllocation.network = crashNetwork;
    } catch (error) {
      for (const allocation of [resourceAllocation, memoryAllocation, crashAllocation]) releasePendingNetworkSlot(allocation);
      throw error;
    }
    let peerEntry;
    let resourceEntry;
    let memoryEntry;
    let crashEntry;
    const pressureEvidence = [];
    const receiptDigests = [];
    let cleanupObservationNegative = null;
    try {
      peerEntry = await launchBootstrap(node22Build, 30);
      resourceEntry = await launch(resourceAllocation, { network: resourceNetwork, fixtures: [httpFixture] });
      for (const probe of [
        { mode: "cpu", amount: 2_000, reason: "cpu_throttled" },
        { mode: "scratch", amount: 300, reason: "scratch_limit_exceeded" },
        { mode: "connections", amount: 150, target: { host: httpFixture.endpointIpv4, port: httpFixture.port }, reason: "network_connection_limit" },
        { mode: "processes", amount: 160, reason: "process_limit_exceeded" },
      ]) {
        let pressure;
        let requestFailed = false;
        let operationError = null;
        try {
          pressure = await runPressureWithLiveness(
            () => requestThroughRelay(resourceEntry.relay, "/probe/resource", { method: "POST", body: probe }),
            `admitted ${probe.mode} pressure`,
            peerEntry,
          );
        } catch (error) {
          if (probe.mode !== "processes") throw error;
          requestFailed = true;
          operationError = error instanceof Error ? error.message : String(error);
          pressure = { result: null, liveness: error?.pressureLiveness ?? null };
        }
        const response = pressure.result;
        const observation = await invoke(resourceEntry.allocation, "inspect", { network: resourceEntry.network, secret_version_refs: resourceEntry.secretVersionRefs, environment: resourceEntry.environment });
        receiptDigests.push(observation.digest);
        const processStopped = probe.mode === "processes" && observation.receipt.status === "stopped" && observation.receipt.runsc_status === "stopped";
        const allocationIdentity = { allocation_id: resourceEntry.allocation.id, generation: resourceEntry.allocation.generation, fence: resourceEntry.allocation.fence };
        let stopInvocation = null;
        if (processStopped) {
          await stopAndCleanup(resourceEntry);
          stopInvocation = resourceEntry.stop;
          if (!stopInvocation) throw new Error("admitted PID pressure stopped the runtime without a retained stop receipt");
          receiptDigests.push(stopInvocation.digest);
          resourceEntry = null;
        }
        if (probe.mode === "processes") {
          if (!processPressureEvidencePasses(response, observation, requestFailed, stopInvocation)) throw new Error("admitted PID pressure lacks a real EAGAIN/ENOMEM or stopped process-limit receipt without an OOM event");
          if (!processStopped) await recordHealthyInspection(resourceAllocation, observation, "admitted PID pressure");
        } else {
          if (response?.status !== 200) throw new Error(`admitted ${probe.mode} pressure did not return an HTTP response`);
          await recordHealthyInspection(resourceAllocation, observation, `admitted ${probe.mode} pressure`);
        }
        requireHealthyPressureLiveness(pressure.liveness, `admitted ${probe.mode} pressure`);
        const pressureReceipt = stopInvocation?.receipt ?? observation.receipt;
        if (pressureReceipt.reason_code !== probe.reason) throw new Error(`admitted ${probe.mode} pressure receipt reason is ${pressureReceipt.reason_code}`);
        if (probe.mode === "cpu" && !(pressureReceipt.observed_limits?.cpu_nr_throttled > 0)) throw new Error("admitted CPU pressure receipt lacks throttling counters");
        if (probe.mode === "scratch") {
          if (response.payload?.failed !== true || response.payload.code !== "ENOSPC" || pressureReceipt.scratch_observation?.capacity_bytes !== RUNTIME_POLICY.scratch_bytes || pressureReceipt.scratch_observation?.available_bytes !== 0) throw new Error("admitted scratch pressure lacks ENOSPC and trusted zero-available receipt evidence");
          const cleanup = await requestThroughRelay(resourceEntry.relay, "/probe/resource", { method: "POST", body: { mode: "scratch_cleanup", amount: 0 } });
          if (cleanup.status !== 200 || cleanup.payload?.removed !== true) throw new Error("admitted scratch pressure left no exact owned file cleanup receipt");
        }
        if (probe.mode === "connections") {
          if (!response.payload?.results?.some((value) => value !== "connected")) throw new Error("admitted connection pressure did not produce rejected connections");
          const limitedPackets = pressureReceipt.network?.counters?.find((value) => value.name === "connection_limited")?.packets ?? 0;
          if (!(limitedPackets > 0)) throw new Error("admitted connection pressure receipt lacks the nft limit counter");
        }
        const pressureRecord = { mode: probe.mode, ...allocationIdentity, receipt_digest: stopInvocation?.digest ?? observation.digest, inspect_receipt_digest: observation.digest, reason_code: pressureReceipt.reason_code, liveness: pressure.liveness };
        if (probe.mode === "processes") Object.assign(pressureRecord, {
          http_status: response?.status ?? null,
          request_failed: requestFailed,
          operation_error: operationError,
          failed: response?.payload?.failed ?? null,
          error_codes: response?.payload?.codes ?? null,
          receipt_status: pressureReceipt.status,
          receipt_result: pressureReceipt.result,
          runsc_status: pressureReceipt.runsc_status,
          pids_max: pressureReceipt.observed_limits?.pids_max,
          pids_max_events: pressureReceipt.observed_limits?.pids_events?.max,
          memory_events: pressureReceipt.observed_limits?.memory_events,
          stop_receipt_digest: stopInvocation?.digest ?? null,
          inspect_receipt_status: observation.receipt.status,
          inspect_runsc_status: observation.receipt.runsc_status,
          stopped_observation: processStopped,
        });
        pressureEvidence.push(pressureRecord);
        if (processStopped) break;
      }

      await stopAndCleanup(resourceEntry);
      resourceEntry = null;
      memoryEntry = await launch(memoryAllocation, { network: memoryNetwork });
      const memoryPressure = await runPressureWithLiveness(
        () => requestThroughRelay(memoryEntry.relay, "/probe/resource", { method: "POST", body: { mode: "memory", amount: 600 } })
          .then((response) => ({ response, error: null }), (error) => ({ response: null, error: error.message })),
        "admitted memory pressure",
        peerEntry,
      );
      requireHealthyPressureLiveness(memoryPressure.liveness, "admitted memory pressure");
      const memoryFailure = Boolean(memoryPressure.result?.error) || memoryPressure.result?.response?.status >= 400;
      if (!memoryFailure) throw new Error("admitted memory pressure did not fail at the runtime boundary");
      const memoryInspect = await invoke(memoryEntry.allocation, "inspect", { network: memoryEntry.network, secret_version_refs: memoryEntry.secretVersionRefs, environment: memoryEntry.environment }).catch(() => null);
      if (memoryInspect) receiptDigests.push(memoryInspect.digest);
      cleanupObservationNegative = await stopAndCleanup(memoryEntry, { cleanupObservationContract: true });
      const memoryStop = memoryEntry.stop;
      memoryEntry = null;
      const memoryReason = memoryInspect?.receipt?.reason_code ?? memoryStop?.receipt?.reason_code ?? null;
      const memoryOomReceipt = [memoryInspect, memoryStop].find((value) => value?.receipt?.reason_code === "runtime_oom" && (value.receipt.observed_limits?.memory_events?.oom_kill ?? 0) > 0);
      if (memoryReason !== "runtime_oom" || !memoryOomReceipt) throw new Error("admitted memory pressure produced no runtime_oom evidence");
      pressureEvidence.push({ mode: "memory", allocation_id: memoryAllocation.id, generation: memoryAllocation.generation, fence: memoryAllocation.fence, receipt_digest: memoryOomReceipt.digest, reason_code: memoryReason, liveness: memoryPressure.liveness });

      crashEntry = await launch(crashAllocation, { network: crashNetwork });
      const crashAttempts = [];
      const admittedRestartDelayMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const crash = await requestThroughRelay(crashEntry.relay, "/probe/crash", { method: "POST" });
        if (crash.status !== 202) throw new Error(`admitted crash probe attempt ${attempt + 1} was not accepted`);
        await context.delay(100);
        const reconcilePressure = await runPressureWithLiveness(
          () => invoke(crashEntry.allocation, "reconcile", { network: crashEntry.network, secret_version_refs: crashEntry.secretVersionRefs, environment: crashEntry.environment, timeoutMs: 45_000 }),
          `admitted crash reconcile ${attempt + 1}`,
          peerEntry,
        );
        const reconcile = reconcilePressure.result;
        if (reconcile.receipt.status === "crash_loop_backoff") {
          if (reconcilePressure.liveness.sample_count < 1 || !reconcilePressure.liveness.peer_healthy || !reconcilePressure.liveness.control_healthy) throw new Error("admitted final crash backoff lacked a healthy peer/control sample");
        } else requireHealthyPressureLiveness(reconcilePressure.liveness, `admitted crash reconcile ${attempt + 1}`);
        receiptDigests.push(reconcile.digest);
        await recordBackoffReconcile(crashEntry.allocation, reconcile, `admitted crash reconcile ${attempt + 1}`);
        crashAttempts.push({ attempt: attempt + 1, receipt_digest: reconcile.digest, status: reconcile.receipt.status, reason_code: reconcile.receipt.reason_code, expected_delay_ms: admittedRestartDelayMs[attempt] ?? 0, elapsed_ms: reconcilePressure.liveness.elapsed_ms, liveness: reconcilePressure.liveness });
        if (reconcile.receipt.status === "crash_loop_backoff") break;
        const healthy = await invoke(crashEntry.allocation, "inspect", { network: crashEntry.network, secret_version_refs: crashEntry.secretVersionRefs, environment: crashEntry.environment });
        receiptDigests.push(healthy.digest);
        await recordHealthyInspection(crashEntry.allocation, healthy, `admitted crash recovery ${attempt + 1}`);
      }
      if (crashAttempts.at(-1)?.status !== "crash_loop_backoff" || crashAttempts.length !== 7) throw new Error("admitted crash probe did not exhaust the bounded restart schedule");
      pressureEvidence.push({ mode: "crash", allocation_id: crashEntry.allocation.id, generation: crashEntry.allocation.generation, fence: crashEntry.allocation.fence, receipt_digest: crashAttempts.at(-1).receipt_digest, reason_code: crashAttempts.at(-1).reason_code, attempts: crashAttempts });
      await stopAndCleanup(crashEntry);
      crashEntry = null;
    } finally {
      if (memoryEntry) { try { await stopAndCleanup(memoryEntry, { cleanup: true }); } catch {} }
      if (resourceEntry) { try { await stopAndCleanup(resourceEntry, { cleanup: true }); } catch {} }
      if (crashEntry) { try { await stopAndCleanup(crashEntry, { cleanup: true }); } catch {} }
      if (peerEntry) { try { await finishBootstrap(peerEntry); } catch {} }
      releasePendingNetworkSlot(resourceAllocation);
      releasePendingNetworkSlot(memoryAllocation);
      releasePendingNetworkSlot(crashAllocation);
    }
    const ownerObservations = [];
    for (const evidence of pressureEvidence) {
      const allocation = evidence.allocation_id === resourceAllocation.id ? resourceAllocation : evidence.allocation_id === memoryAllocation.id ? memoryAllocation : crashAllocation;
      const rows = await ownerObservationRows(allocation, `admitted ${evidence.mode} pressure`);
      const expected = evidence.mode === "crash" ? "crash_loop_backoff" : evidence.mode === "memory" ? "runtime_oom" : evidence.reason_code;
      if (!rows.some((value) => value.reason_code === expected && (!evidence.stopped_observation || value.state === "stopped"))) throw new Error(`owner observations lack ${expected} for admitted ${evidence.mode} pressure`);
      ownerObservations.push({ mode: evidence.mode, allocation_id: allocation.id, generation: allocation.generation, fence: allocation.fence, expected_reason: expected, observations: rows });
    }
    const requiredReasons = ["cpu_throttled", "runtime_oom", "scratch_limit_exceeded", "process_limit_exceeded", "network_connection_limit", "crash_loop_backoff"];
    if (requiredReasons.some((reason) => !ownerObservations.some((entry) => entry.observations.some((value) => value.reason_code === reason)))) throw new Error("owner observations lack one or more required admitted enforcement reasons");
    return { owner_observations: ownerObservations, executor_receipt_digests: receiptDigests, pressure_evidence: pressureEvidence, allocation_ids: [resourceAllocation.id, memoryAllocation.id, crashAllocation.id], cleanup_observation_negative: cleanupObservationNegative ?? null };
  }

  async function exercisePostCapability({ evaluation, observations, allocations, buildOutputs, tenantPeers }) {
    const fullstack = allocations.get("fullstack_v1");
    const fullstackProjectId = m3.state.m3Build?.fullstackV1?.prepared?.project?.project?.id ?? null;
    const peer = primaryTenantPeer(tenantPeers, fullstackProjectId);
    if (!fullstack || !peer) throw new Error("runtime continuity requires the evidence-gated fullstack allocation and primary database peer");
    const build = oneApplicationOutput(buildOutputs, "fullstack_v1");
    const network = networkFor(30, [
      { address: peer.endpointIpv4, port: 5432, protocol: "tcp" },
      { address: peer.endpointIpv6, port: 5432, protocol: "tcp" },
    ], [], fullstack);
    fullstack.network = network;
    let secret;
    try {
      secret = await stageDatabaseSecret(fullstack, peer);
    } catch (error) {
      releasePendingNetworkSlot(fullstack);
      throw error;
    }
    const entry = { allocation: { ...fullstack }, network, secretVersionRefs: [secret], environment: [{ name: "DATABASE_URL" }], stopped: false };
    try {
      trackActive(entry);
    } catch (error) {
      releasePendingNetworkSlot(fullstack);
      throw error;
    }
    entry.prepared = await invoke(fullstack, "prepare", { network, secret_version_refs: [secret], environment: [{ name: "DATABASE_URL" }] });
    entry.peerReceipt = await attachPostgres(fullstack, peer);
    entry.databasePeer = peer;
    entry.started = await invoke(fullstack, "start", { network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment });
    await record(fullstack, "running", entry.started);
    const startupHealth = await inspectUntilHealthy(fullstack, {
      network,
      secretVersionRefs: entry.secretVersionRefs,
      environment: entry.environment,
      purpose: "post-capability-initial",
      startedReceiptDigest: entry.started.digest,
    });
    entry.inspected = startupHealth.invocation;
    entry.startupHealthEvidence = startupHealth.evidence;
    await record(fullstack, "healthy", entry.inspected);
    entry.relay = await startRelay(fullstack, entry);
    const before = await requestThroughRelay(entry.relay, "/api/items");
    const created = await requestThroughRelay(entry.relay, "/api/items", { method: "POST", body: { name: `runtime-continuity-${context.state.runId}` } });
    if (typeof m3.state.m3Build?.exhaustAllowanceProbe !== "function") throw new Error("runtime continuity requires the real build allowance exhaustion probe");
    const buildAllowanceExhaustionReceipt = await m3.state.m3Build.exhaustAllowanceProbe();
    const started = Date.now();
    await context.delay(60_000);
    const idle = await invoke(fullstack, "inspect", { network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment });
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const runtimeStop = await invoke(fullstack, "stop", { network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment });
    const runtimeBackoff = await invoke(fullstack, "reconcile", { network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment, timeoutMs: 45_000 });
    await record(fullstack, "backoff", runtimeBackoff);
    const restartPollStartedAt = performance.now();
    const restartPollDeadline = restartPollStartedAt + 5_000;
    const restartPollAttempts = [];
    const restartPollErrors = [];
    let runtimeHealthy = null;
    let runtimeHealthyObservedAt = null;
    while (performance.now() < restartPollDeadline) {
      const attemptStartedAt = performance.now();
      const remainingMs = Math.max(1, Math.ceil(restartPollDeadline - attemptStartedAt));
      try {
        const candidate = await invoke(fullstack, "inspect", {
          network,
          secret_version_refs: entry.secretVersionRefs,
          environment: entry.environment,
          timeoutMs: remainingMs,
        });
        const observedAt = performance.now();
        const healthy = candidate.receipt.health?.passing === true;
        restartPollAttempts.push({
          receipt_digest: candidate.digest,
          status: candidate.receipt.status,
          reason_code: candidate.receipt.reason_code,
          health_passing: healthy,
          elapsed_ms: observedAt - restartPollStartedAt,
          duration_ms: observedAt - attemptStartedAt,
        });
        if (observedAt <= restartPollDeadline && healthy) {
          runtimeHealthy = candidate;
          runtimeHealthyObservedAt = observedAt;
          break;
        }
      } catch (error) {
        const observedAt = performance.now();
        const receiptDigests = (error?.runtimeReceiptDigests ?? []).filter((digest) => DIGEST.test(digest));
        const errorCode = error?.name === "TimeoutError" || error?.code === "ETIMEDOUT"
          ? "runtime_inspect_timeout"
          : "runtime_inspect_failed";
        restartPollAttempts.push({
          receipt_digests: receiptDigests,
          elapsed_ms: observedAt - restartPollStartedAt,
          duration_ms: observedAt - attemptStartedAt,
          error_code: errorCode,
        });
        restartPollErrors.push(errorCode);
      }
      const delayMs = Math.min(100, Math.max(0, restartPollDeadline - performance.now()));
      if (delayMs <= 0) break;
      await context.delay(delayMs);
    }
    const restartPollElapsedMs = performance.now() - restartPollStartedAt;
    const restartPollReceiptDigests = restartPollAttempts.flatMap((attempt) => attempt.receipt_digest ? [attempt.receipt_digest] : attempt.receipt_digests ?? []);
    persistRuntimeArtifact(join(context.artifactDir, "m3-runtime-restart-health-poll.json"), {
      schema: "hostlet.runtime.restart-health-poll/v1",
      allocation_id: fullstack.id,
      generation: fullstack.generation,
      fence: fullstack.fence,
      reconcile_receipt_digest: runtimeBackoff.digest,
      reconcile_status: runtimeBackoff.receipt.status,
      attempts: restartPollAttempts,
      receipt_digests: restartPollReceiptDigests,
      errors: restartPollErrors,
      healthy_receipt_digest: runtimeHealthy?.digest ?? null,
      healthy_observed_elapsed_ms: runtimeHealthyObservedAt === null ? null : runtimeHealthyObservedAt - restartPollStartedAt,
      elapsed_ms: restartPollElapsedMs,
    }, "runtime restart health poll artifact");
    if (!runtimeHealthy) throw new Error("runtime restart did not recover the existing allocation within 5000ms");
    const runtimeHealthyObservation = await record(fullstack, "healthy", runtimeHealthy);
    entry.stop = runtimeStop; entry.reconcile = runtimeBackoff; entry.started = runtimeBackoff; entry.inspected = runtimeHealthy;
    const afterRuntimeRestart = await requestThroughRelay(entry.relay, "/api/items");
    await m3.switchApi(m3.currentApiBinary, "M3 runtime continuity API restart");
    const afterApiRestart = await invoke(fullstack, "inspect", { network, secret_version_refs: entry.secretVersionRefs, environment: entry.environment });
    const afterApiRestartObservation = await record(fullstack, "healthy", afterApiRestart);
    entry.inspected = afterApiRestart;
    const postRestartName = `runtime-after-restart-${context.state.runId}`;
    const afterRestartWrite = await requestThroughRelay(entry.relay, "/api/items", { method: "POST", body: { name: postRestartName } });
    const afterRestart = await requestThroughRelay(entry.relay, "/api/items");
    const repeatAllocation = await allocate(build, evaluation.id);
    const stale = await m3.roleInternal("runtime", "/internal/v1/runtime/observations", {
      method: "POST", body: { allocation_id: fullstack.id, generation: fullstack.generation, fence: Math.max(0, fullstack.fence - 1), state: "healthy", receipt_digest: idle.digest },
    });
    const owner = await m3.ownerHTTP(`/v1/projects/${fullstack.project_id}/runtime/observations`);
    const ownerHealthy = (observation) => owner.status === 200 && owner.payload?.observations?.some((value) =>
      value.allocation_id === fullstack.id && value.generation === fullstack.generation &&
      value.state === "healthy" && value.observed_at === observation.observed_at);
    const buildExhausted = buildAllowanceExhaustionReceipt?.response?.status === 409 && buildAllowanceExhaustionReceipt?.response?.payload?.error?.code === "build_allowance_exhausted" && buildAllowanceExhaustionReceipt.buildSecondsLimitAfter === buildAllowanceExhaustionReceipt.buildSecondsLimitBefore;
    const continuity = {
      real_observation_seconds: elapsed,
      idle_stop_observed: idle.receipt.runsc_status !== "running" || !idle.receipt.health?.passing,
      restart_health_poll: {
        deadline_ms: 5_000,
        elapsed_ms: restartPollElapsedMs,
        attempts: restartPollAttempts,
        receipt_digests: restartPollReceiptDigests,
        errors: restartPollErrors,
        healthy_receipt_digest: runtimeHealthy.digest,
        healthy_observed_elapsed_ms: runtimeHealthyObservedAt - restartPollStartedAt,
      },
      runtime_restart_preserved: runtimeBackoff.receipt.status === "restart_scheduled" && runtimeHealthy.receipt.health?.passing === true && afterRuntimeRestart.status === 200 && afterRuntimeRestart.payload?.items?.some((item) => item.name === `runtime-continuity-${context.state.runId}`),
      same_allocation_after_restart: repeatAllocation.id === fullstack.id && repeatAllocation.generation === fullstack.generation && repeatAllocation.fence === fullstack.fence && ownerHealthy(runtimeHealthyObservation),
      database_read_write_after_restart: before.status === 200 && created.status === 201 && afterRuntimeRestart.status === 200 && afterRuntimeRestart.payload?.items?.some((item) => item.name === `runtime-continuity-${context.state.runId}`) && afterRestartWrite.status === 201 && afterRestart.status === 200 && afterRestart.payload?.items?.some((item) => item.name === postRestartName) && afterRestart.payload?.items?.some((item) => item.name === `runtime-continuity-${context.state.runId}`),
      build_exhaustion_ignored: buildExhausted && idle.receipt.health?.passing,
      stale_worker_fenced: stale.status === 409 && stale.payload?.error?.code === "runtime_fence_stale",
      api_restart_preserved: ownerHealthy(runtimeHealthyObservation) && ownerHealthy(afterApiRestartObservation) && afterApiRestart.receipt.health?.passing === true,
    };
    const missing = await m3.roleInternal("runtime", "/internal/v1/runtime/allocations", { method: "POST", body: { build_job_id: build.buildJobId, artifact_id: build.artifactId, evaluation_id: randomUUID() } });
    const evaluatedArtifactDigests = new Set(observations.patterns.map((pattern) => pattern.artifact_digest));
    const successfulBuilds = m3.state.m3Build?.jobs instanceof Map
      ? [...m3.state.m3Build.jobs.entries()]
        .filter(([, record]) => record?.detail?.build?.state === "succeeded" && record.detail.build.terminal_code === "build_succeeded")
        .map(([key]) => key)
      : [];
    const otherBuild = [...outputsMap(buildOutputs).entries()]
      .filter(([key]) => successfulBuilds.length === 0 || successfulBuilds.includes(key))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value])
      .find((value) => value?.artifactId && value.artifactId !== build.artifactId && value.kind === "application" && !evaluatedArtifactDigests.has(value.archiveDigest));
    if (!otherBuild) throw new Error("runtime admission mismatch probe requires an actual succeeded application artifact omitted from this evaluation");
    const mismatched = await m3.roleInternal("runtime", "/internal/v1/runtime/allocations", { method: "POST", body: { build_job_id: otherBuild.buildJobId, artifact_id: otherBuild.artifactId, evaluation_id: evaluation.id } });
    const [failedIdentity, outdatedIdentity] = observations.spareEvaluationIdentities ?? [];
    if (!failedIdentity || !outdatedIdentity) throw new Error("runtime admission checks require two actually exercised spare evaluator subjects");
    const failedReceipt = evaluationReceipt({ ...observations, evaluationIdentity: failedIdentity });
    failedReceipt.result = "failed"; failedReceipt.reason_code = "runtime_isolation_unverified";
    failedReceipt.evaluation.resources.memory_max_bytes -= 1;
    const failedStored = casStore(failedReceipt, "failed runtime evaluation");
    const failedRegistration = await m3.roleInternal("runtime", "/internal/v1/runtime/evaluations", { method: "POST", body: { evidence_digest: failedStored.digest } });
    if (failedRegistration.status !== 201 || failedRegistration.payload?.result !== "failed") throw new Error("control did not durably record failed isolation evidence");
    const failedAllocation = await m3.roleInternal("runtime", "/internal/v1/runtime/allocations", { method: "POST", body: { build_job_id: build.buildJobId, artifact_id: build.artifactId, evaluation_id: failedRegistration.payload.id } });
    const outdatedReceipt = evaluationReceipt({ ...observations, evaluationIdentity: outdatedIdentity });
    outdatedReceipt.observed_at_unix_ms = Date.now() - 31 * 60 * 1000;
    const outdatedStored = casStore(outdatedReceipt, "outdated runtime evaluation");
    const outdatedRegistration = await m3.roleInternal("runtime", "/internal/v1/runtime/evaluations", { method: "POST", body: { evidence_digest: outdatedStored.digest } });
    if (outdatedRegistration.status !== 422 || outdatedRegistration.payload?.error?.code !== "runtime_evidence_invalid") throw new Error("control accepted an evaluator receipt outside the real-time freshness window");
    const publicAttempt = await m3.ownerHTTP(`/v1/projects/${fullstack.project_id}/runtime/allocations`, { method: "POST", body: { artifact_id: build.artifactId } });
    const admission = {
      missing_evidence_rejected: missing.status === 409 && missing.payload?.error?.code === "runtime_allocation_ineligible",
      mismatched_evidence_rejected: mismatched?.status === 409 && mismatched.payload?.error?.code === "runtime_allocation_ineligible",
      failed_evidence_rejected: failedAllocation.status === 409 && failedAllocation.payload?.error?.code === "runtime_allocation_ineligible",
      outdated_evidence_rejected: outdatedRegistration.status === 422 && outdatedRegistration.payload?.error?.code === "runtime_evidence_invalid",
      fixture_requires_capability: DIGEST.test(fullstack.capability_digest),
      customer_admission_disabled: [404, 405].includes(publicAttempt.status),
    };
    return { continuity, admission };
  }

  function evaluationReceipt({ patterns, compatibility, network, resources, benchmark, performance, evaluatorDigests, evaluationIdentity, evaluationObservedAtUnixMs }) {
    for (const key of REQUIRED_PATTERN_KEYS) if (!patterns.some((p) => p.key === key)) throw new Error(`runtime evaluation lacks actual ${key} observations`);
    const facts = structuredClone({
      evaluator_digest: requireDigest(evaluatorDigests.evaluator, "evaluator digest"),
      oci_schema_digest: requireDigest(evaluatorDigests.ociSchema, "OCI schema digest"),
      unpack_tool_digest: requireDigest(evaluatorDigests.unpackTool, "unpack tool digest"),
      patterns: patterns.map((pattern) => ({
        framework: pattern.framework, node_major: pattern.node_major,
        artifact_digest: pattern.artifact_digest, manifest_digest: pattern.manifest_digest,
        build_profile_digest: pattern.build_profile_digest, source_commit: pattern.source_commit,
        assertions_passed: pattern.assertions_passed, assertions_total: pattern.assertions_total,
        cold_starts_healthy: pattern.cold_starts_healthy, cold_starts_total: pattern.cold_starts_total,
        cold_start_ms: pattern.cold_start_ms, warm_idle_seconds: pattern.warm_idle_seconds,
      })), compatibility, network, resources, benchmark, performance,
    });
    const anchor = patterns[0];
    return {
      schema: "hostlet.runtime.executor-receipt/v1", allocation_id: evaluationIdentity.allocation_id, generation: evaluationIdentity.generation, fence: evaluationIdentity.fence,
      operation: "validate", result: "passed", status: "prepared", reason_code: "runtime_evaluation_passed",
      artifact_digest: anchor.artifact_digest, runtime_binary_digest: `sha256:${RUNSC_SHA256}`,
      policy_digest: RUNTIME_POLICY_DIGEST, capability_digest: null, platform: "systrap",
      profile: "owned_fixture_evaluation", sandbox_id: null, oci_config_digest: null, runsc_status: null,
      namespace_inodes: [], observed_limits: null, network: null, health: null, cleanup: null,
      observed_at_unix_ms: evaluationObservedAtUnixMs ?? Date.now(), evaluation: facts,
    };
  }

  async function registerEvaluation(observations) {
    const receipt = evaluationReceipt(observations);
    const stored = casStore(receipt, "runtime evaluation");
    let response;
    try {
      response = await m3.roleInternal("runtime", "/internal/v1/runtime/evaluations", { method: "POST", body: { evidence_digest: stored.digest } });
    } catch (error) {
      persistRuntimeEvaluation({
        recorded_at_unix_ms: Date.now(),
        evidence_digest: stored.digest,
        receipt: {
          allocation_id: UUID.test(receipt.allocation_id ?? "") ? receipt.allocation_id : null,
          generation: receipt.generation,
          fence: receipt.fence,
          artifact_digest: DIGEST.test(receipt.artifact_digest ?? "") ? receipt.artifact_digest : null,
          runtime_binary_digest: DIGEST.test(receipt.runtime_binary_digest ?? "") ? receipt.runtime_binary_digest : null,
          policy_digest: DIGEST.test(receipt.policy_digest ?? "") ? receipt.policy_digest : null,
          operation: receipt.operation,
          result: receipt.result,
          status: receipt.status,
          reason_code: receipt.reason_code,
          profile: receipt.profile,
        },
        response: { status: null, accepted: false, transport_error: error instanceof Error },
      });
      throw error;
    }
    const responsePayload = response.payload ?? {};
    persistRuntimeEvaluation({
      recorded_at_unix_ms: Date.now(),
      evidence_digest: stored.digest,
      receipt: {
        allocation_id: UUID.test(receipt.allocation_id ?? "") ? receipt.allocation_id : null,
        generation: receipt.generation,
        fence: receipt.fence,
        artifact_digest: DIGEST.test(receipt.artifact_digest ?? "") ? receipt.artifact_digest : null,
        runtime_binary_digest: DIGEST.test(receipt.runtime_binary_digest ?? "") ? receipt.runtime_binary_digest : null,
        policy_digest: DIGEST.test(receipt.policy_digest ?? "") ? receipt.policy_digest : null,
        operation: receipt.operation,
        result: receipt.result,
        status: receipt.status,
        reason_code: receipt.reason_code,
        profile: receipt.profile,
      },
      response: {
        status: response.status,
        accepted: response.status === 201 && responsePayload.result === "passed" && responsePayload.reason_code === "runtime_capability_verified",
        transport_error: false,
        error_code: typeof responsePayload.error?.code === "string" && /^[a-z0-9_.:-]{1,96}$/.test(responsePayload.error.code) ? responsePayload.error.code : null,
        error_message_present: typeof responsePayload.error?.message === "string" && responsePayload.error.message.length > 0,
        evaluation_id: UUID.test(responsePayload.id ?? "") ? responsePayload.id : null,
        evaluation_subject_id: UUID.test(responsePayload.evaluation_subject_id ?? "") ? responsePayload.evaluation_subject_id : null,
        evaluation_generation: Number.isInteger(responsePayload.evaluation_generation) ? responsePayload.evaluation_generation : null,
        evaluation_fence: Number.isInteger(responsePayload.evaluation_fence) ? responsePayload.evaluation_fence : null,
        capability_digest: DIGEST.test(responsePayload.capability_digest ?? "") ? responsePayload.capability_digest : null,
        result: typeof responsePayload.result === "string" && /^[a-z0-9_.:-]{1,96}$/.test(responsePayload.result) ? responsePayload.result : null,
        reason_code: typeof responsePayload.reason_code === "string" && /^[a-z0-9_.:-]{1,96}$/.test(responsePayload.reason_code) ? responsePayload.reason_code : null,
      },
    });
    assertStatus(response, 201, "runtime capability evaluation registration");
    if (response.payload?.result !== "passed" || response.payload?.reason_code !== "runtime_capability_verified") throw new Error("runtime capability evaluation did not pass control recomputation");
    const registered = { ...response.payload, evidenceDigest: stored.digest, receipt };
    for (const pattern of observations.patterns) evaluatedCapabilities.set(pattern.artifact_digest, registered);
    return registered;
  }

  async function registerEvaluationVariant({ buildOutput, templateReceipt, omitPerformance = false, performance, compatibility } = {}) {
    const build = requireBuildOutput("runtime evaluation variant", buildOutput);
    if (!templateReceipt || templateReceipt.schema !== "hostlet.runtime.executor-receipt/v1" || !UUID.test(templateReceipt.allocation_id ?? "") || !Number.isInteger(templateReceipt.generation) || templateReceipt.generation <= 0 || !Number.isInteger(templateReceipt.fence) || templateReceipt.fence <= 0) throw new Error("runtime evaluation variant template identity is invalid");
    const templatePatterns = templateReceipt.evaluation?.patterns;
    if (!Array.isArray(templatePatterns) || !templatePatterns.some((pattern) =>
      pattern?.artifact_digest === build.archiveDigest && pattern.manifest_digest === build.manifestDigest &&
      pattern.build_profile_digest === build.buildProfileDigest && pattern.source_commit === build.sourceCommit &&
      pattern.framework === build.framework && pattern.node_major === build.nodeMajor)) throw new Error("runtime evaluation variant template does not contain the exact succeeded artifact tuple");
    const receipt = structuredClone(templateReceipt);
    if (compatibility !== undefined) receipt.evaluation.compatibility = structuredClone(compatibility);
    if (omitPerformance) delete receipt.evaluation.performance;
    else if (performance !== undefined) receipt.evaluation.performance = structuredClone(performance);
    const stored = casStore(receipt, "runtime evaluation variant");
    return m3.roleInternal("runtime", "/internal/v1/runtime/evaluations", { method: "POST", body: { evidence_digest: stored.digest } });
  }

  async function evaluateRelease(buildOutput, databasePeer, nodeBaseRoots) {
    const build = requireBuildOutput("release", buildOutput);
    // Control matches the entire artifact tuple, not just its archive digest.
    // A rebuilt artifact can retain bytes while changing another bound field.
    const matchingCapability = (candidate) => {
      const patterns = candidate?.receipt?.evaluation?.patterns;
      return Array.isArray(patterns) && patterns.some((pattern) =>
        pattern?.artifact_digest === build.archiveDigest && pattern.manifest_digest === build.manifestDigest &&
        pattern.build_profile_digest === build.buildProfileDigest && pattern.source_commit === build.sourceCommit &&
        pattern.framework === build.framework && pattern.node_major === build.nodeMajor) ? candidate : null;
    };
    let existing = matchingCapability(evaluatedCapabilities.get(build.archiveDigest));
    if (existing && Date.parse(existing.expires_at) <= Date.parse(m3.policyClock.current().now)) {
      for (const [digest, evaluation] of evaluatedCapabilities) if (evaluation.id === existing.id) evaluatedCapabilities.delete(digest);
      if (!lastRuntimeInputs) throw new Error("expired runtime capability cannot be refreshed without the original real evaluation inputs");
      const refreshedRaw = await exerciseRuntimeEvaluation(lastRuntimeInputs);
      const refreshed = finalizeObservedEvaluation(refreshedRaw);
      await registerEvaluation(refreshed);
      existing = matchingCapability(evaluatedCapabilities.get(build.archiveDigest));
    }
    if (existing) return existing;
    if (!lastRuntimeEvaluation) throw new Error("release evaluation requires the completed runtime isolation evaluation");
    const assembled = await assembleArtifacts(new Map([["release_exact", build]]), nodeBaseRoots ?? evaluatedNodeBaseRoots);
    const measured = await exercisePattern(assembled, "release_exact", 45, databasePeer);
    const identity = measured.evaluationIdentities.at(-1);
    if (!identity) throw new Error("exact release evaluation did not create a control-bound evaluator intent");
    const raw = {
      ...lastRuntimeEvaluation,
      buildOutputs: new Map([...outputsMap(lastRuntimeEvaluation.buildOutputs), ["release_exact", build]]),
      patterns: [
        ...lastRuntimeEvaluation.patterns.filter((pattern) => pattern.key !== "release_exact"),
        { ...measured.pattern, receipt_digests: measured.receiptDigests },
      ],
      evaluationIdentity: identity,
      spareEvaluationIdentities: measured.evaluationIdentities.slice(0, -1),
      evaluationObservedAtUnixMs: Date.now(),
    };
    const observed = finalizeObservedEvaluation(raw);
    return registerEvaluation(observed);
  }

  async function exerciseRestoredDatabaseProbe({ buildOutput, databasePeer, expectedProjectId, index = 42 }) {
    const recoveryId = replacementRecoveryId(expectedProjectId, databasePeer);
    if (!lastRuntimeEvaluation) throw new Error("restored database probe requires the completed runtime isolation evaluation");
    if (lastRuntimeEvaluation.evaluationObservedAtUnixMs < Date.now() - 25 * 60 * 1000) {
      if (!lastRuntimeInputs) throw new Error("stale real-time runtime isolation evidence cannot support the restored database probe");
      const refreshedRaw = await exerciseRuntimeEvaluation(lastRuntimeInputs);
      await registerEvaluation(finalizeObservedEvaluation(refreshedRaw));
    }
    const assembled = await assembleArtifacts(new Map([["restore_exact", buildOutput]]), evaluatedNodeBaseRoots);
    const measured = await exercisePattern(assembled, "restore_exact", index, databasePeer, { recoveryId, databaseAssertions: true });
    const identity = measured.evaluationIdentities.at(-1);
    if (!identity || measured.pattern.assertions_passed !== measured.pattern.assertions_total) throw new Error("restored database application probe did not pass every actual read/write assertion");
    const raw = {
      ...lastRuntimeEvaluation,
      buildOutputs: new Map([...outputsMap(lastRuntimeEvaluation.buildOutputs), ["restore_exact", oneApplicationOutput(assembled, "restore_exact")]]),
      patterns: [...lastRuntimeEvaluation.patterns.filter((pattern) => pattern.key !== "restore_exact"), { ...measured.pattern, receipt_digests: measured.receiptDigests }],
      evaluationIdentity: identity,
      spareEvaluationIdentities: measured.evaluationIdentities.slice(0, -1),
      evaluationObservedAtUnixMs: Date.now(),
    };
    const observed = finalizeObservedEvaluation(raw);
    const evaluation = await registerEvaluation(observed);
    const executorReceiptDigest = requireDigest(measured.receiptDigests.at(-1), "restored runtime database probe executor receipt digest");
    return { allocationId: identity.allocation_id, evaluationId: evaluation.id, readObserved: true, writeObserved: true, executorReceiptDigest, peerReceiptDigest: measured.peerReceiptDigests.at(-1), recoveryId };
  }

  function finalizeObservedEvaluation(raw) {
    const builds = outputsMap(raw.buildOutputs);
    const patterns = raw.patterns.map((pattern) => {
      const build = oneApplicationOutput(builds, pattern.key);
      const deferredNext = pattern.key === "next16" && pattern.admission_rejected === true && pattern.assertions_passed < pattern.assertions_total && pattern.cold_start_ms.length === pattern.cold_starts_total && pattern.cold_starts_total >= 3;
      const minimumReceipts = deferredNext ? 1 : 2;
      if (!Array.isArray(pattern.receipt_digests) || pattern.receipt_digests.length < minimumReceipts || pattern.receipt_digests.some((digest) => !executorReceiptDigests.has(digest))) throw new Error(`${pattern.key} measurements are not backed by this run's executor receipts`);
      const supported = pattern.cold_start_ms.length >= 3 && pattern.cold_starts_healthy >= 3 && pattern.cold_starts_healthy === pattern.cold_starts_total && pattern.warm_idle_seconds >= 60 && pattern.assertions_passed === pattern.assertions_total && pattern.assertions_total >= 1;
      if (!supported && !deferredNext) throw new Error(`${pattern.key} lacks measured compatibility or an observed fail-closed Next deferral`);
      return { key: pattern.key, framework: build.framework, node_major: build.nodeMajor, artifact_digest: build.archiveDigest, manifest_digest: build.manifestDigest, build_profile_digest: build.buildProfileDigest, source_commit: build.sourceCommit, assertions_passed: pattern.assertions_passed, assertions_total: pattern.assertions_total, cold_starts_healthy: pattern.cold_starts_healthy, cold_starts_total: pattern.cold_starts_total, cold_start_ms: pattern.cold_start_ms, warm_idle_seconds: pattern.warm_idle_seconds, admission_rejected: pattern.admission_rejected === true, unmet_requirements: Array.isArray(pattern.unmet_requirements) ? pattern.unmet_requirements : [] };
    });
    const baseline = raw.benchmark.baseline_request_samples_ms;
    const sandbox = raw.benchmark.sandbox_request_samples_ms;
    const supportedPatterns = patterns.filter((p) => p.assertions_passed === p.assertions_total && p.cold_starts_healthy === p.cold_starts_total && p.cold_starts_total >= 3 && p.warm_idle_seconds >= 60);
    const startup = supportedPatterns.flatMap((p) => p.cold_start_ms);
    const compatibility = {
      warm_run_seconds: Math.min(...supportedPatterns.map((p) => p.warm_idle_seconds)), p95_startup_ms: percentile95(startup),
      baseline_samples: baseline.length, sandbox_samples: sandbox.length,
      baseline_p95_request_ms: percentile95(baseline), sandbox_p95_request_ms: percentile95(sandbox),
      baseline_throughput_rps: raw.compatibility.baseline_throughput_rps, sandbox_throughput_rps: raw.compatibility.sandbox_throughput_rps,
    };
    if (typeof compatibility.baseline_throughput_rps !== "number" || !Number.isFinite(compatibility.baseline_throughput_rps) || compatibility.baseline_throughput_rps <= 0 || typeof compatibility.sandbox_throughput_rps !== "number" || !Number.isFinite(compatibility.sandbox_throughput_rps) || compatibility.sandbox_throughput_rps <= 0) throw new Error("runtime throughput measurements must be positive finite numbers");
    const performance = {
      decision: "owned_fixture_only",
      throughput_target_ratio: 0.5,
      throughput_target_met: compatibility.sandbox_throughput_rps >= compatibility.baseline_throughput_rps * 0.5,
      production_ready: false,
    };
    const reasonSet = new Set(raw.resources.enforced_reason_codes);
    if (REQUIRED_REASONS.some((reason) => !reasonSet.has(reason))) throw new Error("runtime resource evaluation lacks one or more observed enforcement reasons");
    for (const [label, digests] of [["network", raw.network.executor_receipt_digests], ["resources", raw.resources.executor_receipt_digests]]) {
      if (!Array.isArray(digests) || digests.length === 0 || digests.some((digest) => !executorReceiptDigests.has(digest))) throw new Error(`runtime ${label} observations are not backed by this run's executor receipts`);
    }
    const requiredProbeKinds = ["platform_ipv4", "platform_ipv6", "tenant_peer_ipv4", "tenant_peer_ipv6", "docker_socket", "host_path", "builder_ipv4", "builder_ipv6", "metadata_ipv4", "metadata_ipv6", "dns_forbidden", "dns_allowed", "dns_forbidden_ipv6", "dns_allowed_ipv6", "tenant_database_ipv4", "tenant_database_ipv6", "public_http_ipv4", "public_http_ipv6"];
    if (!raw.network.independent_observation || raw.network.forbidden_total < 1 || raw.network.forbidden_passed !== raw.network.forbidden_total || raw.network.allowed_total < 1 || raw.network.allowed_passed !== raw.network.allowed_total || requiredProbeKinds.some((kind) => !raw.network.probe_kinds?.includes(kind))) throw new Error("runtime IPv4, IPv6, DNS and independent isolation observations are incomplete");
    const network = { forbidden_passed: raw.network.forbidden_passed, forbidden_total: raw.network.forbidden_total, allowed_passed: raw.network.allowed_passed, allowed_total: raw.network.allowed_total, independent_observation: raw.network.independent_observation };
    const resources = {
      cpu_max: raw.resources.cpu_max, memory_max_bytes: raw.resources.memory_max_bytes,
      memory_swap_max_bytes: raw.resources.memory_swap_max_bytes, pids_max: raw.resources.pids_max,
      scratch_max_bytes: raw.resources.scratch_max_bytes, max_connections: raw.resources.max_connections,
      new_connections_per_second: raw.resources.new_connections_per_second,
      new_connections_burst: raw.resources.new_connections_burst,
      enforced_reason_codes: raw.resources.enforced_reason_codes,
      restart_delays_seconds: raw.resources.restart_delays_seconds, restart_limit: raw.resources.restart_limit,
      restart_window_seconds: raw.resources.restart_window_seconds, healthy_reset_seconds: raw.resources.healthy_reset_seconds,
      idle_stop_observed: raw.resources.idle_stop_observed,
    };
    const benchmark = {
      baseline_cpu_usec: raw.benchmark.baseline_cpu_usec, sandbox_cpu_usec: raw.benchmark.sandbox_cpu_usec,
      baseline_peak_memory_bytes: raw.benchmark.baseline_peak_memory_bytes,
      sandbox_peak_memory_bytes: raw.benchmark.sandbox_peak_memory_bytes,
      baseline_request_samples_ms: baseline, sandbox_request_samples_ms: sandbox, startup_samples_ms: startup,
    };
    if (!UUID.test(raw.evaluationIdentity?.allocation_id ?? "") || raw.evaluationIdentity.generation !== 1 || raw.evaluationIdentity.fence !== 1) throw new Error("runtime evaluation lacks the control-issued bootstrap subject identity");
    return { patterns, compatibility, network, resources, benchmark, performance, evaluatorDigests: raw.evaluatorDigests, evaluationIdentity: raw.evaluationIdentity, spareEvaluationIdentities: raw.spareEvaluationIdentities, policyEvaluationIdentities: raw.policyEvaluationIdentities, evaluationObservedAtUnixMs: raw.evaluationObservedAtUnixMs };
  }

  const api = Object.freeze({ initialize, assembleArtifacts, runNativeBaseline, exerciseRuntimeEvaluation, exerciseAdmittedEnforcement, exercisePostCapability, invoke, launch, launchDiagnosticBootstrap, launchRelease, launchProbeAgainstDatabase, stopRelease, startRelay, stopAndCleanup, allocate, attachPostgres, registerEvaluation, registerEvaluationVariant, evaluateRelease, finalizeObservedEvaluation, runtimeDatabaseProbe, runtimeReadOnlyDatabaseProbe, pauseDatabasePeer, withEndpointsPaused, stateRoot, artifactRoot, relaysRoot, runsc, runtimeBinary, active });
  return api;
}
