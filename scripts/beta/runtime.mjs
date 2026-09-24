import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createM3RuntimeHarness } from "../../e2e/support/m3-runtime.mjs";
import { createReleaseClient, readActiveRoute, startReleaseGateway, startReleaseWorker } from "../../e2e/support/m3-release.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_BUILDS = ["node22_api", "fullstack_v1", "fullstack_v2", "next16", "policy_probes", "crash_runtime"];

function requireUuid(value, label) {
  if (!UUID.test(value ?? "")) throw new Error(`${label} requires an exact UUID`);
  return value;
}

function outputFor(outputs, key) {
  const raw = outputs instanceof Map ? outputs.get(key) : outputs?.[key];
  const application = (Array.isArray(raw) ? raw : [raw]).find((value) => value?.kind === "application" || value?.framework === "node_http" || value?.framework === "nextjs16_standalone");
  if (!application || !UUID.test(application.buildJobId ?? "") || !UUID.test(application.artifactId ?? "") ||
      !DIGEST.test(application.archiveDigest ?? "") || !DIGEST.test(application.manifestDigest ?? "") ||
      !DIGEST.test(application.buildProfileDigest ?? "")) throw new Error(`${key} has no actual succeeded application output`);
  return application;
}

function exactOwnedFile(path, label) {
  const full = resolve(path);
  if (!existsSync(full) || lstatSync(full).isSymbolicLink() || !statSync(full).isFile() || realpathSync(full) !== full ||
      (statSync(full).mode & 0o077) !== 0) throw new Error(`${label} is missing or not private`);
  return full;
}

function evaluationDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function storeEvaluation(stateDir, evaluation) {
  const bytes = Buffer.from(`${JSON.stringify(evaluation)}\n`);
  const digest = evaluationDigest(bytes);
  const root = join(stateDir, "preview-runtime-evaluations");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, `${digest.slice(7)}.json`);
  if (existsSync(path)) {
    if (evaluationDigest(readFileSync(exactOwnedFile(path, "preview runtime evaluation"))) !== digest) {
      throw new Error("preview runtime evaluation artifact differs from previously persisted evidence");
    }
  } else {
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
  }
  return { id: evaluation.id, evidenceDigest: evaluation.evidenceDigest, capabilityDigest: evaluation.capability_digest,
    expiresAt: evaluation.expires_at, path, digest };
}

function loadEvaluation(reference, stateDir) {
  if (!UUID.test(reference?.id ?? "") || !DIGEST.test(reference?.evidenceDigest ?? "") ||
      !DIGEST.test(reference?.capabilityDigest ?? "") || !DIGEST.test(reference?.digest ?? "") ||
      reference?.path !== join(stateDir, "preview-runtime-evaluations", `${reference?.digest?.slice(7)}.json`)) {
    throw new Error("preview runtime evaluation reference is malformed");
  }
  const bytes = readFileSync(exactOwnedFile(reference.path, "preview runtime evaluation"));
  if (evaluationDigest(bytes) !== reference.digest) throw new Error("preview runtime evaluation artifact digest changed");
  const evaluation = JSON.parse(bytes);
  if (evaluation.id !== reference.id || evaluation.evidenceDigest !== reference.evidenceDigest ||
      evaluation.capability_digest !== reference.capabilityDigest || evaluation.expires_at !== reference.expiresAt) {
    throw new Error("preview runtime evaluation artifact does not match its manifest reference");
  }
  return evaluation;
}

function storeAllocation(stateDir, launched) {
  const allocation = launched.allocation;
  requireUuid(allocation?.id, "runtime allocation");
  const data = { schema: "hostlet.preview.runtime-allocation/v1", allocation,
    secretVersionRefs: launched.entry.secretVersionRefs,
    environment: launched.entry.environment };
  const bytes = Buffer.from(`${JSON.stringify(data)}\n`);
  const digest = evaluationDigest(bytes);
  const root = join(stateDir, "preview-runtime-allocations");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, `${allocation.id}.json`);
  if (existsSync(path)) {
    if (evaluationDigest(readFileSync(exactOwnedFile(path, "preview runtime allocation"))) !== digest) {
      throw new Error("preview allocation artifact differs from its prior exact identity");
    }
  } else {
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
  }
  return { id: allocation.id, generation: allocation.generation, fence: allocation.fence,
    buildJobId: allocation.build_job_id ?? null, artifactId: allocation.artifact_id ?? null, path, digest };
}

function loadAllocation(reference, stateDir) {
  if (!UUID.test(reference?.id ?? "") || !Number.isSafeInteger(reference?.generation) || reference.generation <= 0 ||
      !Number.isSafeInteger(reference?.fence) || reference.fence <= 0 || !DIGEST.test(reference?.digest ?? "") ||
      reference.path !== join(stateDir, "preview-runtime-allocations", `${reference.id}.json`)) {
    throw new Error("preview allocation reference is malformed");
  }
  const bytes = readFileSync(exactOwnedFile(reference.path, "preview runtime allocation"));
  if (evaluationDigest(bytes) !== reference.digest) throw new Error("preview allocation artifact digest changed");
  const value = JSON.parse(bytes);
  if (value.schema !== "hostlet.preview.runtime-allocation/v1" || value.allocation?.id !== reference.id ||
      value.allocation.generation !== reference.generation || value.allocation.fence !== reference.fence ||
      !Array.isArray(value.secretVersionRefs) || !Array.isArray(value.environment)) {
    throw new Error("preview allocation artifact differs from its manifest identity");
  }
  return value;
}

function activeHistory(history, route) {
  if (history?.current_route?.release_id !== route.manifest.release_id ||
      history.current_route.generation !== route.manifest.generation) throw new Error("control release route differs from exact immutable route pointer");
  const release = history.releases?.find((item) => item.id === route.manifest.release_id);
  if (release?.state !== "healthy" || !release.promoted_at) throw new Error("persisted route points to an unpromoted or unhealthy release");
  return release;
}

async function historyFor(m3, projectId) {
  const response = await m3.ownerHTTP(`/v1/projects/${projectId}/releases`);
  if (response.status !== 200 || !Array.isArray(response.payload?.releases)) throw new Error("control release history unavailable");
  return response.payload;
}

async function requireDemoDatabaseResponse(gateway, signal) {
  if (!gateway) throw new Error("preview release cannot be claimed healthy without an owned HTTPS demo gateway");
  const response = await createReleaseClient(gateway, signal).request("/api/items");
  const payload = response.status === 200 ? response.json() : null;
  if (response.status !== 200 || !Array.isArray(payload?.items) || !/^api-v[12]$/.test(payload.api_version ?? "")) {
    throw new Error(`preview demo did not answer through its real Node and project database (HTTP ${response.status})`);
  }
  return { status: response.status, apiVersion: payload.api_version, rows: payload.items.length };
}

async function waitForPromotion(m3, projectId, releaseId, { deadlineMs = 120_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const history = await historyFor(m3, projectId);
    const release = history.releases.find((item) => item.id === releaseId);
    if (release?.state === "failed" || release?.state === "retired") throw new Error(`release ${releaseId} ended ${release.state}: ${release.failure_code ?? "unknown"}`);
    if (release?.state === "healthy" && release.promoted_at && history.current_route?.release_id === releaseId) {
      const route = readActiveRoute(m3.policyClock.stateDir, projectId);
      activeHistory(history, route);
      return { release, history, route };
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(`release ${releaseId} did not promote within ${deadlineMs}ms`);
}

async function handoffManagedRelay(m3, runtime, projectId, launched, activateRelay) {
  if (typeof activateRelay !== "function") throw new Error("managed relay activation is required");
  const allocation = launched.allocation;
  const relayTupleRoot = join(m3.policyClock.stateDir, "preview-relays");
  mkdirSync(relayTupleRoot, { recursive: true, mode: 0o700 });
  chmodSync(relayTupleRoot, 0o700);
  const relayTuplePath = join(relayTupleRoot, `${allocation.id}.json`);
  const tuple = { schema: "hostlet.preview.relay-unit/v1", project_id: projectId,
    allocation_id: allocation.id, generation: allocation.generation, fence: allocation.fence,
    target_address: launched.entry.network.application_ipv4, target_port: allocation.application_port,
    listen_port: launched.relay.port, runtime_root: runtime.stateRoot, map_path: launched.relay.mapPath };
  if (existsSync(relayTuplePath)) throw new Error("managed relay tuple already exists for this allocation");
  const temporaryPath = `${relayTuplePath}.new`;
  writeFileSync(temporaryPath, `${JSON.stringify(tuple)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, relayTuplePath);
  await runtime.stopRelay(launched.entry, "preview relay handoff to managed unit");
  launched.entry.relay = null;
  await activateRelay(relayTuplePath);
  if (!existsSync(tuple.map_path)) throw new Error("managed preview relay emitted no exact ownership map");
  const managedMap = JSON.parse(readFileSync(tuple.map_path, "utf8"));
  if (managedMap.allocation_id !== allocation.id || managedMap.generation !== allocation.generation ||
      managedMap.fence !== allocation.fence || managedMap.port !== tuple.listen_port) {
    throw new Error("managed preview relay identity differs from allocation tuple");
  }
  return { tuple, relayTuplePath };
}

async function reattachPartialAllocation({ m3, runtime, manifest, application, projectId, databaseRecord, activateRelay }) {
  const persisted = loadAllocation(manifest.runtime.allocationRef, m3.policyClock.stateDir);
  const allocation = persisted.allocation;
  if (allocation.project_id !== projectId || allocation.artifact_digest !== application.archiveDigest ||
      allocation.artifact_manifest_digest !== application.manifestDigest ||
      allocation.build_profile_digest !== application.buildProfileDigest || allocation.source_commit !== application.sourceCommit ||
      allocation.tenant_database_id && allocation.tenant_database_id !== databaseRecord.id) {
    throw new Error("partial allocation differs from the exact preview project, build or database");
  }
  if (!allocation.network || !manifest.runtime.relay || !Number.isSafeInteger(manifest.runtime.relay.port)) {
    throw new Error(`partial allocation ${allocation.id} lacks its exact network/relay recovery identity`);
  }
  const options = { network: allocation.network, secret_version_refs: persisted.secretVersionRefs,
    environment: persisted.environment };
  let inspected = await runtime.invoke(allocation, "inspect", options);
  if (inspected.receipt.health?.passing !== true) {
    const reconciled = await runtime.invoke(allocation, "reconcile", options);
    if (!["restart_scheduled", "running"].includes(reconciled.receipt.status)) {
      throw new Error(`partial allocation ${allocation.id} could not reconcile: ${reconciled.receipt.reason_code ?? reconciled.receipt.status}`);
    }
    const deadline = Date.now() + 10_000;
    do {
      await new Promise((done) => setTimeout(done, 250));
      inspected = await runtime.invoke(allocation, "inspect", options);
      if (inspected.receipt.health?.passing === true) break;
    } while (Date.now() < deadline);
    if (inspected.receipt.health?.passing !== true) {
      throw new Error(`partial allocation ${allocation.id} remained unhealthy after bounded real reconcile`);
    }
  }
  const relay = manifest.runtime.relay;
  const relayTupleRoot = join(m3.policyClock.stateDir, "preview-relays");
  mkdirSync(relayTupleRoot, { recursive: true, mode: 0o700 });
  chmodSync(relayTupleRoot, 0o700);
  const relayTuplePath = join(relayTupleRoot, `${allocation.id}.json`);
  const expected = { schema: "hostlet.preview.relay-unit/v1", project_id: projectId,
    allocation_id: allocation.id, generation: allocation.generation, fence: allocation.fence,
    target_address: allocation.network.application_ipv4, target_port: allocation.application_port,
    listen_port: relay.port, runtime_root: runtime.stateRoot, map_path: relay.mapPath };
  if (relay.mapPath !== join(runtime.relaysRoot, allocation.id, String(allocation.generation), `${allocation.fence}.json`) ||
      relay.generation !== allocation.generation || relay.fence !== allocation.fence || relay.allocationId !== allocation.id) {
    throw new Error(`partial allocation ${allocation.id} relay identity is inconsistent`);
  }
  if (existsSync(relayTuplePath)) {
    const existing = JSON.parse(readFileSync(exactOwnedFile(relayTuplePath, "preview relay tuple")));
    if (JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error(`partial allocation ${allocation.id} relay tuple differs from exact identity`);
  } else {
    writeFileSync(relayTuplePath, `${JSON.stringify(expected)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(relayTuplePath, 0o600);
  }
  try { await activateRelay(relayTuplePath); }
  catch (error) {
    const failure = new Error(`partial allocation ${allocation.id} remains healthy but exact managed relay activation failed for ${relayTuplePath}: ${error.message}`);
    failure.repair = { allocationId: allocation.id, generation: allocation.generation,
      fence: allocation.fence, relayTuplePath, relayMapPath: expected.map_path,
      action: "inspect exact relay owner and retry managed activation; preserve allocation and project database" };
    throw failure;
  }
  const map = JSON.parse(readFileSync(exactOwnedFile(expected.map_path, "managed relay map")));
  if (map.allocation_id !== allocation.id || map.generation !== allocation.generation ||
      map.fence !== allocation.fence || map.port !== relay.port) {
    throw new Error(`partial allocation ${allocation.id} managed relay identity differs from allocation`);
  }
  return { allocation, allocationRef: manifest.runtime.allocationRef, executorReceiptDigest: inspected.digest,
    relayTuplePath };
}

// This adapter is deliberately separate from runM3Context. That runner owns
// ephemeral cleanup and must never be pointed at populated preview roots.
export async function ensurePreviewRuntime({
  context, m3, buildOutputs, tenantPeers, nodeBaseRoots, projectId, deploymentId,
  databasePeer, databaseRecord, stateRoot, artifactRoot, manifest, updateManifest,
  demoOrigin, localHostname = "demo.localowned.test",
  localPort, certificate, privateKey, startManagedServices = true, activateRelay,
} = {}) {
  requireUuid(projectId, "preview project");
  requireUuid(deploymentId, "preview deployment");
  if (!context || !m3 || typeof updateManifest !== "function" || !manifest || !databasePeer || !databaseRecord) {
    throw new Error("preview runtime needs durable context, exact project database and manifest writer");
  }
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) throw new Error("preview demo gateway needs a fixed loopback port");
  if (typeof activateRelay !== "function") throw new Error("preview runtime requires exact managed relay activation");
  let demoUrl;
  try { demoUrl = new URL(demoOrigin); } catch { throw new Error("preview managed demo URL is invalid"); }
  if (demoUrl.protocol !== "https:" || !demoUrl.hostname || demoUrl.username || demoUrl.password ||
      demoUrl.pathname !== "/" || demoUrl.search || demoUrl.hash || demoUrl.origin !== demoOrigin) {
    throw new Error("preview managed demo URL must be an exact credential-free HTTPS origin");
  }
  if (startManagedServices && context.config?.services?.managedProcessDispatch !== true) {
    throw new Error("preview gateway and release worker require managed service dispatch before runtime composition");
  }
  if (startManagedServices) {
    exactOwnedFile(certificate, "preview gateway certificate");
    exactOwnedFile(privateKey, "preview gateway key");
  }
  for (const key of REQUIRED_BUILDS) outputFor(buildOutputs, key);
  const application = outputFor(buildOutputs, "fullstack_v1");
  if (manifest.identity?.projectId !== projectId || manifest.identity?.deploymentId !== deploymentId) throw new Error("preview runtime project/deployment identity differs from seed manifest");
  if (databaseRecord.id !== databasePeer.tenantDatabaseId || databaseRecord.generation !== databasePeer.databaseGeneration) {
    throw new Error("preview runtime database record differs from exact isolated peer");
  }
  const runtime = createM3RuntimeHarness(context, m3, { persistent: true, stateRoot, artifactRoot });
  const marker = join(runtime.stateRoot, ".hostlet-runtime-owned");
  if (existsSync(marker)) await runtime.initializeExisting();
  else if (!manifest.runtime?.evaluationRef && !manifest.runtime?.allocationRef && !manifest.runtime?.releaseId) await runtime.initialize();
  else throw new Error("preview runtime manifest exists but its owned runtime root is missing");
  m3.state.runtime = runtime;
  m3.state.runtimeEvaluationInputs = { buildOutputs, tenantPeers, nodeBaseRoots };
  if (manifest.runtime?.allocationRef) {
    const retained = loadAllocation(manifest.runtime.allocationRef, m3.policyClock.stateDir).allocation;
    if (retained.project_id !== projectId || retained.artifact_digest !== application.archiveDigest ||
        retained.artifact_manifest_digest !== application.manifestDigest ||
        retained.build_profile_digest !== application.buildProfileDigest || retained.source_commit !== application.sourceCommit) {
      throw new Error("persisted preview allocation differs from exact project and build tuple");
    }
  }

  const existingHistory = await historyFor(m3, projectId);
  let evaluation = manifest.runtime?.evaluationRef ? loadEvaluation(manifest.runtime.evaluationRef, m3.policyClock.stateDir) : null;
  let evaluationRef = manifest.runtime?.evaluationRef ?? null;
  if (evaluation) {
    runtime.attachRegisteredEvaluation(evaluation, buildOutputs, { allowExpired: Boolean(existingHistory.current_route?.release_id) });
  } else {
    if (existingHistory.current_route?.release_id) throw new Error("active preview route has no persisted real capability evidence");
    if (manifest.runtime?.releaseId || manifest.runtime?.allocationRef) throw new Error("runtime has a release without recorded real capability evaluation");
    const raw = await runtime.exerciseRuntimeEvaluation({ buildOutputs, tenantPeers, nodeBaseRoots });
    const observed = runtime.finalizeObservedEvaluation(raw);
    evaluation = await runtime.registerEvaluation(observed);
    evaluationRef = storeEvaluation(m3.policyClock.stateDir, evaluation);
    await updateManifest({ runtime: { ...(manifest.runtime ?? {}), evaluationRef, evaluatedAt: new Date().toISOString() } });
  }
  m3.state.runtimeEvidence = { evaluation };

  let gateway = null;
  if (startManagedServices) {
    gateway = await startReleaseGateway(m3, { projectId, hostname: localHostname,
      certificate, privateKey, port: localPort, runtimeRoot: runtime.stateRoot });
  }

  // An existing healthy route is authoritative. Ordinary restarts inspect it
  // and never call launchRelease, stage another release or replay evaluation.
  if (existingHistory.current_route?.release_id) {
    const route = readActiveRoute(m3.policyClock.stateDir, projectId);
    const release = activeHistory(existingHistory, route);
    if (manifest.runtime?.releaseId && manifest.runtime.releaseId !== release.id) throw new Error("preview manifest and control disagree on promoted release");
    if (release.build_job_id !== application.buildJobId || release.runtime_allocation_id !== manifest.runtime?.allocationRef?.id ||
        release.tenant_database_id !== databaseRecord.id || release.database_generation !== databaseRecord.generation ||
        release.managed_demo_url !== demoOrigin) throw new Error("preview live release differs from exact build, allocation, database or demo URL");
    if (!manifest.runtime?.releaseId) await updateManifest({ runtime: { ...(manifest.runtime ?? {}), releaseId: release.id,
      routeDigest: route.digest, routeGeneration: route.manifest.generation } });
    const demo = await requireDemoDatabaseResponse(gateway, context.abortSignal);
    return Object.freeze({ runtime, evaluation, release, route, gateway, demo, reused: true });
  }
  if (manifest.runtime?.releaseId) {
    const stagedRelease = existingHistory.releases.find((item) => item.id === manifest.runtime.releaseId);
    if (!stagedRelease || !["staged", "healthy"].includes(stagedRelease.state) ||
        stagedRelease.build_job_id !== application.buildJobId ||
        stagedRelease.runtime_allocation_id !== manifest.runtime?.allocationRef?.id ||
        stagedRelease.tenant_database_id !== databaseRecord.id ||
        stagedRelease.database_generation !== databaseRecord.generation) {
      throw new Error("partial preview release differs from its exact owned build, allocation or database");
    }
    const worker = startManagedServices ? startReleaseWorker(m3, { workerId: "m35-owned-release-worker",
      runtimeRoot: runtime.stateRoot, runtimeArtifactRoot: runtime.artifactRoot }) : null;
    const promoted = await waitForPromotion(m3, projectId, stagedRelease.id);
    const demo = await requireDemoDatabaseResponse(gateway, context.abortSignal);
    await updateManifest({ runtime: { ...manifest.runtime, routeDigest: promoted.route.digest,
      routeGeneration: promoted.route.manifest.generation } });
    return Object.freeze({ runtime, evaluation, release: promoted.release, route: promoted.route, gateway, worker, demo, reused: true });
  }
  let allocation;
  let allocationRef;
  let executorReceiptDigest;
  if (manifest.runtime?.allocationRef) {
    const recovered = await reattachPartialAllocation({ m3, runtime, manifest, application, projectId,
      databaseRecord, activateRelay });
    allocation = recovered.allocation;
    allocationRef = recovered.allocationRef;
    executorReceiptDigest = recovered.executorReceiptDigest;
  } else {
    const launched = await runtime.launchRelease({ buildOutput: application, evaluationId: evaluation.id,
      databasePeer, index: 35 });
    allocation = launched.allocation;
    if (!UUID.test(allocation?.id ?? "") || launched.entry?.inspected?.receipt?.health?.passing !== true || !launched.relay) {
      throw new Error("preview runtime did not return a healthy real allocation and relay");
    }
    allocationRef = storeAllocation(m3.policyClock.stateDir, launched);
    executorReceiptDigest = launched.executorReceiptDigest;
    await updateManifest({ runtime: { ...(manifest.runtime ?? {}), evaluationRef, allocationRef,
      relay: { mapPath: launched.relay.mapPath, port: launched.relay.port, allocationId: allocation.id,
        generation: allocation.generation, fence: allocation.fence },
      executorReceiptDigest } });
    await handoffManagedRelay(m3, runtime, projectId, launched, activateRelay);
  }
  const staged = await m3.ownerHTTP(`/v1/projects/${projectId}/deployments/${deploymentId}/releases`, {
    method: "POST", headers: { "Idempotency-Key": `m35-preview-initial-${application.buildJobId}` },
    body: { build_job_id: application.buildJobId, runtime_allocation_id: allocation.id,
      tenant_database_id: databaseRecord.id, database_generation: databaseRecord.generation,
      migration_revision: null, migration_digest: null, migration_artifact_path: null,
      managed_demo_url: demoOrigin },
  });
  if (![200, 201].includes(staged.status) || !UUID.test(staged.payload?.release?.id ?? "")) {
    throw new Error(`preview release staging rejected: HTTP ${staged.status}`);
  }
  const releaseId = staged.payload.release.id;
  await updateManifest({ runtime: { ...(manifest.runtime ?? {}), evaluationRef, allocationRef,
    releaseId, reconciliationId: staged.payload.reconciliation?.id ?? null } });
  const worker = startManagedServices ? startReleaseWorker(m3, { workerId: "m35-owned-release-worker",
    runtimeRoot: runtime.stateRoot, runtimeArtifactRoot: runtime.artifactRoot }) : null;
  const promoted = await waitForPromotion(m3, projectId, releaseId);
  const demo = await requireDemoDatabaseResponse(gateway, context.abortSignal);
  await updateManifest({ runtime: { ...(manifest.runtime ?? {}), evaluationRef, allocationRef,
    releaseId, routeDigest: promoted.route.digest, routeGeneration: promoted.route.manifest.generation,
    executorReceiptDigest } });
  return Object.freeze({ runtime, evaluation, release: promoted.release, route: promoted.route, gateway, worker, demo, reused: false });
}

export async function observePreviewRelease(m3, projectId) {
  requireUuid(projectId, "preview project");
  const history = await historyFor(m3, projectId);
  const route = readActiveRoute(m3.policyClock.stateDir, projectId);
  return Object.freeze({ release: activeHistory(history, route), route });
}
