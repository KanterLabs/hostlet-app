import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertErrorShape, assertStatus, expectScenario, ScenarioExpectationError,
} from "../support/http-client.mjs";
import {
  M3_BUILD_PROFILE_ID, installM3BuildControlProfiles, registerM3BuildFixtures, resolveM3BuildSetup,
  verifyM3BuildBroker,
} from "../support/m3-build.mjs";

export const M3_BUILD_REQUIRED_ASSERTIONS = Object.freeze([
  "M3-BUILD-01", "M3-BUILD-02", "M3-BUILD-03", "M3-BUILD-04",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const POOL = "m3-upgrade-pool";

function safeObserved(error) {
  return error instanceof ScenarioExpectationError ? error.observed : { failed_checks: 1 };
}

async function buildStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M3 disposable VM builds", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id, "M3 disposable VM builds", expected, safeObserved(error), false,
      error instanceof ScenarioExpectationError ? error.check : "build HTTP, VM, or PostgreSQL boundary failed",
    );
    throw error;
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function quoted(revision) { return `"${revision}"`; }
function headers(key, revision) { return { "Idempotency-Key": key, "If-Match": quoted(revision) }; }
function fixtureRecord(payload, name) { return payload?.[name] ?? payload; }
function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function writeCasJson(m3, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const objectDigest = digest(bytes);
  const path = casPath(m3, objectDigest);
  mkdirSync(join(m3.policyClock.stateDir, "private-cas", "sha256"), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return objectDigest;
}

function parseCapturedJson(value) {
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

function readCompletionCapture(path) {
  expectScenario(existsSync(path), "builder completion capture is present", { capture_path_present: false });
  const raw = parseCapturedJson(readFileSync(path, "utf8"));
  const request = parseCapturedJson(raw?.request_body ?? raw?.request ?? raw?.body ?? raw?.payload);
  const requestBody = parseCapturedJson(request?.body ?? request);
  const response = parseCapturedJson(raw?.response_body ?? raw?.response ?? raw?.responseBody ?? raw?.response_payload);
  const responseBody = parseCapturedJson(response?.body ?? response);
  expectScenario(
    raw?.schema === "hostlet.build-completion-capture/v1" && raw?.authenticated === true &&
      request?.method === "POST" && typeof request?.path === "string" &&
      request?.path.endsWith("/complete") && request?.content_type === "application/json",
    "builder completion capture records the authenticated completion exchange",
    { schema: raw?.schema ?? null, authenticated: raw?.authenticated ?? null, request_method: request?.method ?? null, request_path: request?.path ?? null },
  );
  expectScenario(
    requestBody && typeof requestBody === "object" && typeof requestBody.worker_id === "string" &&
      typeof requestBody.attempt_id === "string" && Number.isSafeInteger(requestBody.fence) && requestBody.outcome,
    "builder completion capture contains the authenticated request body",
    { capture_keys: raw && typeof raw === "object" ? Object.keys(raw) : [], request_body_present: false },
  );
  expectScenario(response?.status === 200 && typeof response?.content_type === "string" && response.content_type.startsWith("application/json"), "builder completion capture contains a successful completion response", {
    response_status: response?.status ?? null, response_content_type: response?.content_type ?? null,
  });
  expectScenario(responseBody && typeof responseBody === "object", "builder completion capture contains the authenticated response body", {
    response_body_present: false,
  });
  return Object.freeze({ raw, body: requestBody, response: responseBody, request, responseEnvelope: response });
}

function assertCode(response, status, code, check) {
  assertErrorShape(response, status, check);
  expectScenario(response.payload.error.code === code, `${check}: stable code`, {
    status: response.status, error_code: response.payload.error.code,
  });
}

function assertBuildEnqueued(response, check) {
  expectScenario(response.status === 201, check, {
    status: response.status,
    error_code: response.payload?.error?.code ?? null,
    error_message: response.payload?.error?.message ?? null,
  });
}

function assertCreated(response, check) {
  expectScenario(response.status === 201, check, {
    status: response.status,
    error_code: response.payload?.error?.code ?? null,
    error_message: response.payload?.error?.message ?? null,
  });
}

function fixtureConfiguration(m3, key) {
  const services = m3.fixtureCatalog.buildServices[key];
  if (!services?.length) throw new Error(`M3 build fixture has no declared services: ${key}`);
  const configuration = clone(m3.fixtureCatalog.standardProjectConfiguration);
  const postgres = configuration.services.find(({ kind }) => kind === "postgres");
  configuration.services = services.map((service) => ({
    name: service.service_id,
    kind: service.kind,
    root: service.root,
    framework: service.framework,
    node: { major: service.node_major },
    build_command: service.build_command,
    output_directory: service.output_directory,
    start_command: service.start_command ?? null,
    health_check: service.health_path ? { protocol: "http", path: service.health_path } : null,
    uses_durable_data: service.kind === "application",
  }));
  if (postgres && services.some(({ kind }) => kind === "application")) configuration.services.push(postgres);
  configuration.repositories[0].lockfile_path = services[0].lockfile_path;
  return configuration;
}

function casPath(m3, sha) {
  expectScenario(SHA256.test(sha), "CAS identity is a SHA-256 digest", { digest: sha });
  return join(m3.policyClock.stateDir, "private-cas", "sha256", sha.slice(7));
}

function take(buffer, cursor, bytes) {
  if (cursor.offset + bytes > buffer.length) throw new Error("canonical artifact is truncated");
  const value = buffer.subarray(cursor.offset, cursor.offset + bytes);
  cursor.offset += bytes;
  return value;
}

function u16(buffer, cursor) { return take(buffer, cursor, 2).readUInt16BE(); }
function u32(buffer, cursor) { return take(buffer, cursor, 4).readUInt32BE(); }
function u64(buffer, cursor) {
  const value = take(buffer, cursor, 8).readBigUInt64BE();
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("canonical artifact entry is too large");
  return Number(value);
}
function string(buffer, cursor, maximum) {
  const length = u16(buffer, cursor);
  if (length < 1 || length > maximum) throw new Error("canonical artifact string is invalid");
  return take(buffer, cursor, length).toString("utf8");
}

function presentStagePath(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function ownedStageFile(path, label) {
  const info = presentStagePath(path);
  if (!info || info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not an owned regular file`);
  return readFileSync(path);
}

function verifyExistingCanonicalArtifact(destination, manifestBytes, markerBytes, entries) {
  const directory = presentStagePath(destination);
  if (!directory || directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("canonical artifact stage identity collision");
  const allowed = new Set([".hostlet-artifact-owned", "manifest.json", "rootfs"]);
  const names = readdirSync(destination, { withFileTypes: true }).map((entry) => entry.name);
  if (names.length !== allowed.size || names.some((name) => !allowed.has(name))) throw new Error("canonical artifact stage contains unexpected files");
  if (!ownedStageFile(join(destination, "manifest.json"), "canonical artifact manifest").equals(manifestBytes)) throw new Error("canonical artifact stage manifest identity collision");
  if (!ownedStageFile(join(destination, ".hostlet-artifact-owned"), "canonical artifact ownership marker").equals(markerBytes)) throw new Error("canonical artifact stage ownership collision");
  const rootfs = join(destination, "rootfs");
  const rootfsInfo = presentStagePath(rootfs);
  if (!rootfsInfo || rootfsInfo.isSymbolicLink() || !rootfsInfo.isDirectory()) throw new Error("canonical artifact stage rootfs is invalid");
  const expected = new Map();
  for (const entry of entries) {
    if (expected.has(entry.relative)) throw new Error("canonical artifact contains a duplicate path");
    expected.set(entry.relative, entry);
  }
  const observed = new Set();
  function inspect(current, prefix = "") {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("canonical artifact stage contains a symlink");
      if (entry.isDirectory()) inspect(path, relative);
      else if (!entry.isFile()) throw new Error("canonical artifact stage contains a special file");
      else {
        const expectedEntry = expected.get(relative);
        if (!expectedEntry) throw new Error("canonical artifact stage contains an unexpected file");
        const info = statSync(path);
        if ((info.mode & 0o777) !== expectedEntry.mode || !readFileSync(path).equals(expectedEntry.content)) throw new Error("canonical artifact stage bytes do not match the immutable archive");
        observed.add(relative);
      }
    }
  }
  inspect(rootfs);
  if (observed.size !== expected.size) throw new Error("canonical artifact stage is missing an archive entry");
  return destination;
}

function stageCanonicalArtifact(m3, detail, artifact, artifactRoot) {
  const source = casPath(m3, artifact.archive_digest);
  const bytes = readFileSync(source);
  if (digest(bytes) !== artifact.archive_digest) throw new Error("canonical artifact digest mismatch");
  const cursor = { offset: 0 };
  if (!take(bytes, cursor, 4).equals(Buffer.from("HCA1"))) throw new Error("canonical artifact magic mismatch");
  const kindByte = take(bytes, cursor, 1)[0];
  const serviceId = string(bytes, cursor, 128);
  const count = u32(bytes, cursor);
  const unpacked = u64(bytes, cursor);
  if (serviceId !== artifact.service_id || count !== artifact.entry_count || unpacked !== artifact.unpacked_bytes ||
      (kindByte === 1 ? "static" : kindByte === 2 ? "application" : null) !== artifact.kind) {
    throw new Error("canonical artifact header does not match durable metadata");
  }
  if (!UUID.test(artifact.id)) throw new Error("canonical artifact is missing a valid immutable artifact identity");
  const entries = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const relative = string(bytes, cursor, 1024);
    if (relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("canonical artifact contains an unsafe path");
    }
    const mode = u32(bytes, cursor);
    if (![0o644, 0o755].includes(mode)) throw new Error("canonical artifact contains an unsafe mode");
    const length = u64(bytes, cursor);
    const content = take(bytes, cursor, length);
    total += length;
    entries.push(Object.freeze({ relative, mode, content }));
  }
  if (cursor.offset !== bytes.length || total !== unpacked) throw new Error("canonical artifact byte total mismatch");
  const manifest = {
    schema: "hostlet.e2e-staged-build-artifact/v1",
    build_job_id: detail.build.id,
    artifact_id: artifact.id,
    service_id: artifact.service_id,
    kind: artifact.kind,
    archive_digest: artifact.archive_digest,
    manifest_digest: artifact.manifest_digest,
    source_commit: detail.build.source_commit,
    entry_count: count,
    unpacked_bytes: total,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const markerBytes = Buffer.from(`${artifact.archive_digest}\n`);
  const destination = join(artifactRoot, `artifact-${artifact.id}`);
  if (presentStagePath(destination)) return verifyExistingCanonicalArtifact(destination, manifestBytes, markerBytes, entries);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const { relative, mode, content } of entries) {
      const target = join(temporary, "rootfs", relative);
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { mode, flag: "wx" });
      chmodSync(target, mode);
    }
    writeFileSync(join(temporary, "manifest.json"), manifestBytes, { mode: 0o600, flag: "wx" });
    writeFileSync(join(temporary, ".hostlet-artifact-owned"), markerBytes, { mode: 0o600, flag: "wx" });
    if (presentStagePath(destination)) {
      rmSync(temporary, { recursive: true, force: true });
      return verifyExistingCanonicalArtifact(destination, manifestBytes, markerBytes, entries);
    }
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (presentStagePath(destination)) return verifyExistingCanonicalArtifact(destination, manifestBytes, markerBytes, entries);
    throw error;
  }
  return destination;
}

async function configureAdmission(m3) {
  const current = await m3.ownerHTTP("/v1/entitlements/current");
  assertStatus(current, 200, "M3 inherited entitlement fixture");
  // The full journey can retain ten rollout holds: three populated build
  // replacements, one isolated probe build, and six release/approval rebuilds.
  // Keep two bounded fixture slots for deterministic replay/setup attempts.
  const rolloutHeadroomLimit = 12;
  const capacity = await m3.callInternal("/internal/v1/admission/capacity", {
    method: "POST",
    body: { event_id: randomUUID(), pool_key: POOL, profile: "m3-upgrade-standard", hosted_slot_limit: 32, rollout_headroom_limit: rolloutHeadroomLimit },
  });
  assertStatus(capacity, 200, "M3 build capacity fixture");
  const entitlement = await m3.callInternal("/internal/v1/admission/entitlements", {
    method: "POST",
    body: {
      event_id: randomUUID(), account_id: m3.state.owner.record.id, capacity_pool_key: POOL,
      hosted_slot_limit: 24, build_seconds_limit: 20_000,
      period_starts_at: current.payload.period_starts_at,
      period_ends_at: current.payload.period_ends_at, state: "active",
    },
  });
  assertStatus(entitlement, 200, "M3 build entitlement fixture");
}

async function createBuildEnvironmentSecret(m3) {
  const application = m3.state.graph.services.find(({ configuration }) => configuration.kind === "application");
  expectScenario(Boolean(application?.id), "M3 main project has an owned API build service", {
    application_service_id_present: Boolean(application?.id),
  });
  const name = "M3_BUILD_SENTINEL";
  const secret = await m3.ownerHTTP(
    `/v1/projects/${m3.state.graph.project.id}/services/${application.id}/secrets`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `m3-build-environment-secret-${m3.context.state.runId}` },
      body: { name, operation: "build", credential_kind: "build_environment" },
    },
  );
  assertStatus(secret, 201, "M3 build environment secret metadata");
  const value = `m3-build-secret-${m3.context.state.runId}-${randomUUID()}`;
  m3.context.registerSensitiveValues([value]);
  const version = await m3.ownerHTTP(
    `/v1/projects/${m3.state.graph.project.id}/services/${application.id}/secrets/${secret.payload.id}/versions`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": `m3-build-environment-secret-version-${m3.context.state.runId}`,
        "If-Match": `"${secret.payload.revision}"`,
      },
      body: { value },
    },
  );
  assertStatus(version, 201, "M3 build environment secret version");
  return Object.freeze({
    projectId: m3.state.graph.project.id,
    serviceId: application.id,
    secretId: secret.payload.id,
    secretVersionId: version.payload.id,
    name,
    value,
    secretVersionRefs: Object.freeze([{ service_id: application.id, secret_version_id: version.payload.id }]),
  });
}

async function replaceBuildEntitlement(m3, current, state, buildSecondsLimit = current.build_seconds_limit) {
  const response = await m3.callInternal("/internal/v1/admission/entitlements", {
    method: "POST",
    body: {
      event_id: randomUUID(), account_id: m3.state.owner.record.id,
      capacity_pool_key: current.capacity_pool_key ?? POOL,
      hosted_slot_limit: current.hosted_slot_limit,
      build_seconds_limit: buildSecondsLimit,
      period_starts_at: current.period_starts_at,
      period_ends_at: current.period_ends_at,
      state,
    },
  });
  assertStatus(response, 200, `M3 build entitlement ${state}`);
  return response.payload;
}

async function prepareFixture(m3, key, sequence, existingPrepared = null, { proofTtlMs = 3_600_000 } = {}) {
  const source = m3.fixtureCatalog.commits[key];
  if (!source) throw new Error(`unknown M3 source fixture: ${key}`);
  let projectPayload;
  if (existingPrepared) {
    const existing = await m3.ownerHTTP(`/v1/projects/${existingPrepared.project.project.id}`);
    assertStatus(existing, 200, `${key} replacement project graph`);
    projectPayload = existing.payload;
    const actualBuildServices = projectPayload.services
      .filter(({ configuration }) => configuration.kind === "static_frontend" || configuration.kind === "application")
      .map(({ configuration }) => ({ kind: configuration.kind, root: configuration.root }))
      .sort((left, right) => `${left.kind}:${left.root}`.localeCompare(`${right.kind}:${right.root}`));
    const expectedBuildServices = m3.fixtureCatalog.buildServices[key]
      .map(({ kind, root }) => ({ kind, root }))
      .sort((left, right) => `${left.kind}:${left.root}`.localeCompare(`${right.kind}:${right.root}`));
    expectScenario(
      isDeepStrictEqual(actualBuildServices, expectedBuildServices),
      `${key} reuses a project with the exact declared service kinds and roots`,
      { actual_build_services: actualBuildServices, expected_build_services: expectedBuildServices },
    );
  } else {
    const project = await m3.ownerHTTP("/v1/projects", {
      method: "POST", headers: { "Idempotency-Key": `m3-build-${key}-project-${sequence}` },
      body: { name: `M3 build ${key} ${sequence}`, configuration: fixtureConfiguration(m3, key) },
    });
    assertStatus(project, 201, `${key} project creation`);
    projectPayload = project.payload;
  }
  const binding = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}/github-source`, {
    method: "PUT", headers: headers(`m3-build-${key}-bind-${sequence}`, projectPayload.project.revision),
    body: { installation_id: m3.fixtureCatalog.fixtureData.installation.id, repository_id: source.repositoryId, ref: `refs/heads/${source.branch}` },
  });
  assertStatus(binding, 200, `${key} source binding`);
  const resolved = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}/github-source/resolve`, {
    method: "POST", headers: headers(`m3-build-${key}-resolve-${sequence}`, binding.payload.revision), body: {},
  });
  assertStatus(resolved, 200, `${key} exact source resolution`);
  expectScenario(
    resolved.payload.source_revision.resolved_commit === source.commitSha && resolved.payload.source_revision.tree_sha === source.treeSha,
    `${key} exact owned commit and tree`, { source_commit: resolved.payload.source_revision.resolved_commit, source_tree: resolved.payload.source_revision.tree_sha },
  );
  let graph = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}`);
  assertStatus(graph, 200, `${key} project graph`);
  const report = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}/compatibility-reports`, {
    method: "POST", headers: headers(`m3-build-${key}-compat-${sequence}`, graph.payload.project.revision),
    body: { source_revision_id: resolved.payload.source_revision.id, configuration_revision_id: graph.payload.configuration.id },
  });
  assertStatus(report, 201, `${key} compatibility report`);
  expectScenario(
    report.payload.status === "candidate" && report.payload.source_revision_id === resolved.payload.source_revision.id,
    `${key} compatibility admits only the exact candidate source (status=${report.payload.status}; reasons=${(report.payload.facts?.reasons ?? []).map(({ code }) => code).join(",")})`,
    {
      status: report.payload.status,
      source_revision_match: report.payload.source_revision_id === resolved.payload.source_revision.id,
      reason_codes: report.payload.facts?.reasons?.map(({ code }) => code) ?? [],
    },
  );
  graph = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}`);
  const deployment = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}/deployment-intents`, {
    method: "POST", headers: headers(`m3-build-${key}-deployment-${sequence}`, graph.payload.project.revision),
    body: { configuration_revision_id: graph.payload.configuration.id, source_commit: source.commitSha },
  });
  assertCreated(deployment, `${key} deployment intent`);
  graph = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}`);
  const proofResponse = await m3.callInternal("/internal/v1/admission/source-proofs", {
    method: "POST", body: {
      event_id: randomUUID(), account_id: m3.state.owner.record.id, project_id: projectPayload.project.id,
      deployment_id: deployment.payload.id, configuration_revision_id: graph.payload.configuration.id,
      source_commit: source.commitSha, inventory_revision: sequence,
      expires_at: new Date(Date.now() + proofTtlMs).toISOString(),
    },
  });
  expectScenario(proofResponse.status === 200, `${key} exact-source proof`, {
    status: proofResponse.status,
    error_code: proofResponse.payload?.error?.code ?? null,
    error_message: proofResponse.payload?.error?.message ?? null,
  });
  const proof = fixtureRecord(proofResponse.payload, "proof");
  const hold = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}/deployments/${deployment.payload.id}/capacity-holds`, {
    method: "POST", headers: headers(`m3-build-${key}-hold-${sequence}`, graph.payload.project.revision),
    body: { source_proof_id: proof.id, ttl_seconds: 120 },
  });
  assertStatus(hold, 201, `${key} capacity hold`);
  const admission = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}/deployments/${deployment.payload.id}/admissions`, {
    method: "POST", headers: headers(`m3-build-${key}-admit-${sequence}`, graph.payload.project.revision),
    body: { capacity_hold_id: hold.payload.hold.id },
  });
  expectScenario([200, 201].includes(admission.status), `${key} admitted reservation`, { status: admission.status });
  const admittedGraph = await m3.ownerHTTP(`/v1/projects/${projectPayload.project.id}`);
  assertStatus(admittedGraph, 200, `${key} admitted project graph`);
  expectScenario(
    admittedGraph.payload.configuration.id === graph.payload.configuration.id,
    `${key} admission preserves the exact prepared configuration`,
    {
      prepared_configuration_id: graph.payload.configuration.id,
      admitted_configuration_id: admittedGraph.payload.configuration.id,
    },
  );
  return Object.freeze({ key, source, graph: admittedGraph.payload, project: projectPayload, resolved: resolved.payload, report: report.payload, deployment: deployment.payload, proof, admission: admission.payload });
}

function enqueueBody(prepared, secretVersionRefs = []) {
  return {
    source_revision_id: prepared.resolved.source_revision.id,
    compatibility_report_id: prepared.report.id,
    source_proof_id: prepared.proof.id,
    reservation_id: prepared.admission.reservation.id,
    reservation_epoch: prepared.admission.reservation.reservation_epoch,
    build_profile: prepared.source.toolchainProfile,
    secret_version_refs: secretVersionRefs,
  };
}

async function enqueue(m3, prepared, sequence, overrides = {}) {
  const buildSecret = m3.state.m3BuildEnvironmentSecret;
  const secretVersionRefs = overrides.secret_version_refs ??
    (buildSecret?.projectId === prepared.project.project.id ? buildSecret.secretVersionRefs : []);
  const body = { ...enqueueBody(prepared, secretVersionRefs), ...overrides };
  const key = `m3-build-${prepared.key}-enqueue-${sequence}`;
  const response = await m3.ownerHTTP(`/v1/projects/${prepared.project.project.id}/deployments/${prepared.deployment.id}/builds`, {
    method: "POST", headers: headers(key, prepared.graph.project.revision), body,
  });
  return { response, body, key };
}

async function runWorker(m3, setup, guard, profileId, jobId, label, timeoutMs = 720_000, { completionCapture = null } = {}) {
  const workRoot = join(m3.context.tempDir, "m3-build-work");
  const casRoot = join(m3.policyClock.stateDir, "private-cas");
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  mkdirSync(casRoot, { recursive: true, mode: 0o700 });
  const workerId = `m3-builder-${label}-${randomUUID().slice(0, 8)}`;
  const profile = setup.profile(profileId);
  guard.track(jobId, profileId, workRoot);
  const workerArgs = [
    "project-build-worker", "--control-url", m3.workerUrl, "--worker-id", workerId,
    "--profile", profile.path, "--cas-root", casRoot, "--work-root", workRoot, "--once",
  ];
  if (completionCapture) workerArgs.push("--completion-capture", completionCapture);
  let result;
  let unitCleanup;
  try {
    result = await m3.context.runCommand(
      `M3 project build worker ${label}`, setup.builderBinary,
      workerArgs,
      { env: m3.componentEnvironment("build"), timeoutMs, logName: `m3-build-${label}.log` },
    );
  } finally {
    unitCleanup = await guard.cleanupJob(jobId);
  }
  expectScenario(result.code === 0, `${label} real build worker exits successfully`, { exit_code: result.code, signal: result.signal });
  expectScenario(
    unitCleanup.active === 0 && unitCleanup.socketsRemaining === 0,
    `${label} leaves no run-owned VM unit or socket directory`,
    { active_units: unitCleanup.active, socket_directories_remaining: unitCleanup.socketsRemaining, socket_directories_removed_by_guard: unitCleanup.socketsRemoved },
  );
  const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const claims = events.filter(({ event }) => event === "build_job_claimed");
  const cleanups = events.filter(({ event }) => event === "build_vm_cleaned");
  expectScenario(claims.length === 1, `${label} real worker reports one durable claim`, { claim_count: claims.length, event_types: events.map(({ event }) => event) });
  expectScenario(
    cleanups.length <= 1 && cleanups.every((cleanup) => cleanup.qemu_exited && cleanup.sockets_removed && cleanup.workspace_removed),
    `${label} worker cleanup event is complete when a VM launched`,
    { cleanup_event_count: cleanups.length, cleanup: cleanups[0] ?? null },
  );
  return { ...result, claim: claims[0], cleanup: cleanups[0] ?? null, events, unitCleanup, workerId };
}

async function interruptLiveWorker(m3, setup, guard, prepared, queued, label) {
  const workRoot = join(m3.context.tempDir, "m3-build-work");
  const casRoot = join(m3.policyClock.stateDir, "private-cas");
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  mkdirSync(casRoot, { recursive: true, mode: 0o700 });
  const profile = setup.profile(prepared.source.toolchainProfile);
  const workerId = `m3-builder-${label}-${randomUUID().slice(0, 8)}`;
  const jobId = queued.response.payload.build.id;
  guard.track(jobId, profile.id, workRoot);
  const worker = m3.context.spawnManaged(
    `M3 interrupted build worker ${label}`, setup.builderBinary,
    ["project-build-worker", "--control-url", m3.workerUrl, "--worker-id", workerId, "--profile", profile.path, "--cas-root", casRoot, "--work-root", workRoot, "--once"],
    { env: m3.componentEnvironment("build") }, `m3-build-${label}.log`,
  );
  let workerStopped = false;
  let guardCleaned = false;
  const stopAndClean = async () => {
    if (!workerStopped) {
      await m3.context.stopManaged(worker, `${label} interrupted worker cleanup`);
      workerStopped = true;
    }
    if (!guardCleaned) {
      await guard.cleanupJob(jobId);
      guardCleaned = true;
    }
  };
  let running;
  let attemptDirectory;
  let socketDirectory;
  let unit;
  let supervisorProbe;
  let supervisor;
  let workspaceBytes;
  let unitCleanup;
  let exited;
  let terminal;
  let unitProbe;
  try {
  await m3.context.withTimeout(`${label} launch boundary`, async () => {
    while (true) {
      running = await detail(m3, prepared, jobId);
      if (running.build.state === "running") {
        const launched = await m3.postgres.psqlJson(`${label}-launch-boundary`, `SELECT json_build_object(
          'launched',EXISTS(SELECT 1 FROM build_attempts WHERE job_id=${sqlString(jobId)} AND id=${sqlString(running.build.current_attempt_id)} AND launched_at IS NOT NULL)
        );`);
        if (launched.launched) break;
      }
      await m3.context.delay(250);
    }
  }, 30_000);
  attemptDirectory = join(workRoot, jobId, running.build.current_attempt_id);
  socketDirectory = join("/tmp", `hostlet-build-${running.build.current_attempt_id}`);
  unit = `hostlet-build-${jobId}-${running.build.current_attempt_id}.service`;
  await m3.context.withTimeout(`${label} workspace and systemd readiness`, async () => {
    while (true) {
      const activeProbe = await m3.context.runCommand(
        `${label} systemd readiness`, profile.systemctl,
        ["show", unit, "--property=ActiveState"],
        { env: m3.componentEnvironment("build"), timeoutMs: 10_000, logName: `m3-build-${label}-readiness.log` },
      );
      let workspaceReady = false;
      try {
        const metadata = lstatSync(join(attemptDirectory, "workspace.ext4"));
        workspaceReady = metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === 4_294_967_296;
      } catch {
        workspaceReady = false;
      }
      const active = activeProbe.code === 0 && activeProbe.stdout.trim().split("\n").some((line) => line === "ActiveState=active");
      if (active && workspaceReady) break;
      await m3.context.delay(100);
    }
  }, 30_000);
  supervisorProbe = await m3.context.runCommand(
    `${label} live systemd resource policy`, profile.systemctl,
    ["show", unit, "--property=CPUQuotaPerSecUSec", "--property=MemoryMax", "--property=TasksMax", "--property=NoNewPrivileges", "--property=PrivateTmp", "--property=ProtectSystem", "--property=ProtectHome", "--property=RestrictAddressFamilies", "--property=DevicePolicy", "--property=ActiveState"],
    { env: m3.componentEnvironment("build"), timeoutMs: 10_000, logName: `m3-build-${label}-live-unit.log` },
  );
  supervisor = Object.fromEntries(supervisorProbe.stdout.trim().split("\n").map((line) => {
    const split = line.indexOf("=");
    return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
  }));
  workspaceBytes = statSync(join(attemptDirectory, "workspace.ext4")).size;
  expectScenario(
    supervisorProbe.code === 0 && supervisor.ActiveState === "active" &&
      new Set(["2s", "2000000"]).has(supervisor.CPUQuotaPerSecUSec) &&
      supervisor.MemoryMax === "2684354560" && supervisor.TasksMax === "64" &&
      supervisor.NoNewPrivileges === "yes" && supervisor.PrivateTmp === "yes" &&
      supervisor.ProtectSystem === "strict" && supervisor.ProtectHome === "tmpfs" &&
      supervisor.RestrictAddressFamilies === "AF_UNIX" && supervisor.DevicePolicy === "closed" &&
      workspaceBytes === 4_294_967_296,
    `${label} live supervisor enforces the exact CPU, RAM, process, device, address-family, and workspace bounds`,
    { ...supervisor, workspace_bytes: workspaceBytes },
  );
  const canceled = await m3.ownerHTTP(`/v1/projects/${prepared.project.project.id}/builds/${running.build.id}/cancel`, {
    method: "POST", headers: headers(`m3-build-${label}-cancel`, running.build.revision), body: {},
  });
  assertStatus(canceled, 200, `${label} live cancellation`);
  expectScenario(canceled.payload.build.state === "canceled" && canceled.payload.build.cleanup_status === "pending", `${label} cancellation remains blocked until worker cleanup acknowledgement`, { state: canceled.payload.build.state, cleanup_status: canceled.payload.build.cleanup_status });
  exited = await m3.context.withTimeout(`${label} fenced worker exit`, () => worker.exited, 30_000);
  await m3.context.stopManaged(worker, `${label} fenced interruption observed`);
  workerStopped = true;
  unitCleanup = await guard.cleanupJob(jobId);
  guardCleaned = true;
  terminal = await detail(m3, prepared, jobId);
  unitProbe = await m3.context.runCommand(
    `${label} systemd unit cleanup`, profile.systemctl, ["is-active", unit],
    { env: m3.componentEnvironment("build"), timeoutMs: 10_000, logName: `m3-build-${label}-unit.log` },
  );
  expectScenario(
    terminal.build.state === "canceled" && terminal.build.cleanup_status === "confirmed" && terminal.artifacts.length === 0 && !existsSync(attemptDirectory) && !existsSync(socketDirectory) && exited.code !== null && unitProbe.code !== 0,
    `${label} fences the live worker and removes its disposable attempt`,
    { state: terminal.build.state, cleanup_status: terminal.build.cleanup_status, artifact_count: terminal.artifacts.length, attempt_directory_present: existsSync(attemptDirectory), socket_directory_present: existsSync(socketDirectory), worker_exit_code: exited.code, systemd_unit_active: unitProbe.code === 0 },
  );
  return { terminal, exited, attemptDirectory, unitActive: unitProbe.code === 0, unitCleanup, supervisor: Object.freeze({ ...supervisor, workspaceBytes }) };
  } finally {
    await stopAndClean();
  }
}

async function restartPrelaunchBuilder(m3, setup, guard, prepared, queued, label) {
  const workRoot = join(m3.context.tempDir, "m3-build-work");
  const casRoot = join(m3.policyClock.stateDir, "private-cas");
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  mkdirSync(casRoot, { recursive: true, mode: 0o700 });
  const profile = setup.profile(prepared.source.toolchainProfile);
  const jobId = queued.response.payload.build.id;
  const firstWorkerId = `m3-builder-${label}-stopped-${randomUUID().slice(0, 8)}`;
  guard.track(jobId, profile.id, workRoot);
  m3.state.githubFixture.controls.failNext("tree", "timeout");
  const firstWorker = m3.context.spawnManaged(
    `M3 prelaunch interrupted builder ${label}`, setup.builderBinary,
    ["project-build-worker", "--control-url", m3.workerUrl, "--worker-id", firstWorkerId, "--profile", profile.path, "--cas-root", casRoot, "--work-root", workRoot, "--once"],
    { env: m3.componentEnvironment("build") }, `m3-build-${label}-stopped.log`,
  );
  let first;
  try {
    await m3.context.withTimeout(`${label} prelaunch claim`, async () => {
      while (true) {
        const current = await detail(m3, prepared, jobId);
        if (current.build.state === "running" && current.build.current_attempt_id) {
          first = await m3.postgres.psqlJson(`${label}-prelaunch-attempt`, `SELECT json_build_object(
            'attempt_id',id::text,'fence',fence,'worker_id',worker_id,'launched',launched_at IS NOT NULL
          ) FROM build_attempts WHERE job_id=${sqlString(jobId)} AND id=${sqlString(current.build.current_attempt_id)};`);
          if (first.worker_id === firstWorkerId && first.launched === false) break;
        }
        await m3.context.delay(100);
      }
    }, 15_000);
  } finally {
    await m3.context.stopManaged(firstWorker, `${label} intentional prelaunch builder interruption`);
  }
  const firstExit = await firstWorker.exited;
  await m3.context.delay(12_000);
  const expired = await detail(m3, prepared, jobId);
  expectScenario(
    expired.build.state === "retriable" && expired.build.attempt_count === 1,
    `${label} real interrupted builder loses its prelaunch lease without execution`,
    { state: expired.build.state, attempt_count: expired.build.attempt_count, first_worker_exit_code: firstExit.code, launched: first.launched },
  );
  const restarted = await runWorker(m3, setup, guard, profile.id, jobId, `${label}-restarted`);
  const terminal = await detail(m3, prepared, jobId);
  expectScenario(
    terminal.build.state === "succeeded" && terminal.build.terminal_code === "build_succeeded" &&
      restarted.workerId !== firstWorkerId && restarted.claim.attempt_id !== first.attempt_id,
    `${label} a new real builder process completes a new fenced attempt`,
    { state: terminal.build.state, code: terminal.build.terminal_code, first_attempt_id: first.attempt_id, restarted_attempt_id: restarted.claim.attempt_id },
  );
  return Object.freeze({ first: Object.freeze(first), firstExit, restarted, terminal });
}

async function detail(m3, prepared, jobId) {
  const response = await m3.ownerHTTP(`/v1/projects/${prepared.project.project.id}/builds/${jobId}`);
  assertStatus(response, 200, `${prepared.key} build detail`);
  return response.payload;
}

async function wrongIdentityManifestProbe(m3, setup, prepared, queued, label) {
  const profile = setup.profile(prepared.source.toolchainProfile);
  const workerId = `m3-manifest-${label}-${randomUUID().slice(0, 8)}`;
  const lease = await m3.roleInternal("build", "/internal/v1/build-jobs/lease", {
    method: "POST",
    body: { worker_id: workerId, kinds: ["project_build"], profiles: [{ id: profile.id, digest: profile.digest }] },
  });
  assertStatus(lease, 200, `${label} authenticated manifest probe lease`);
  const identity = {
    worker_id: workerId,
    attempt_id: lease.payload.attempt.id,
    fence: lease.payload.attempt.fence,
  };
  const materialized = await m3.roleInternal("build", `/internal/v1/build-jobs/${queued.response.payload.build.id}/source:materialize`, {
    method: "POST", body: identity,
  });
  assertStatus(materialized, 200, `${label} authenticated source materialization`);
  const credentials = await m3.roleInternal("build", `/internal/v1/build-jobs/${queued.response.payload.build.id}/credentials:resolve`, {
    method: "POST", body: { ...identity, secret_version_ids: [] },
  });
  assertStatus(credentials, 200, `${label} authenticated empty build credential resolution`);
  expectScenario(credentials.payload.credentials.length === 0, `${label} has no build credentials bound to the fixture`, {
    credential_count: credentials.payload.credentials.length,
  });

  const wrongResultDigest = writeCasJson(m3, {
    schema: "hostlet.build-result/v1",
    job_id: randomUUID(),
    attempt_id: identity.attempt_id,
    fence: identity.fence,
    input_manifest_digest: queued.response.payload.build.input_manifest_digest,
    state: "failed",
    code: "source_policy_rejected",
    elapsed_seconds: 0,
    artifacts: [],
  });
  const cleanupReceiptDigest = writeCasJson(m3, {
    schema: "hostlet.build-cleanup/v1",
    job_id: queued.response.payload.build.id,
    attempt_id: identity.attempt_id,
    fence: identity.fence,
    status: "confirmed",
  });
  const completion = {
    ...identity,
    outcome: {
      state: "failed", code: "source_policy_rejected", result_manifest_digest: wrongResultDigest,
      cleanup_receipt_digest: cleanupReceiptDigest, elapsed_seconds: 0, artifacts: [],
    },
  };
  const before = await m3.postgres.psqlJson(`${label}-wrong-manifest-before`, `SELECT json_build_object(
    'artifacts',(SELECT COUNT(*)::int FROM build_artifacts WHERE job_id=${sqlString(queued.response.payload.build.id)}),
    'effects',(SELECT COUNT(*)::int FROM build_effects WHERE job_id=${sqlString(queued.response.payload.build.id)}),
    'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id=${sqlString(identity.attempt_id)} AND kind='debit')
  );`);
  const rejected = await m3.roleInternal("build", `/internal/v1/build-jobs/${queued.response.payload.build.id}/complete`, {
    method: "POST", body: completion,
  });
  assertCode(rejected, 422, "build_result_invalid", `${label} wrong-identity result manifest rejects before terminal effects`);
  const after = await m3.postgres.psqlJson(`${label}-wrong-manifest-after`, `SELECT json_build_object(
    'state',(SELECT state FROM build_jobs WHERE id=${sqlString(queued.response.payload.build.id)}),
    'artifacts',(SELECT COUNT(*)::int FROM build_artifacts WHERE job_id=${sqlString(queued.response.payload.build.id)}),
    'effects',(SELECT COUNT(*)::int FROM build_effects WHERE job_id=${sqlString(queued.response.payload.build.id)}),
    'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id=${sqlString(identity.attempt_id)} AND kind='debit')
  );`);
  expectScenario(
    before.artifacts === after.artifacts && before.effects === after.effects && before.debits === after.debits && after.state === "running",
    `${label} wrong-identity manifest has no durable effect`, { before, after },
  );

  const running = await detail(m3, prepared, queued.response.payload.build.id);
  const canceled = await m3.ownerHTTP(`/v1/projects/${prepared.project.project.id}/builds/${queued.response.payload.build.id}/cancel`, {
    method: "POST", headers: headers(`${label}-cancel`, running.build.revision), body: {},
  });
  assertStatus(canceled, 200, `${label} cleanup cancellation`);
  const acknowledged = await m3.roleInternal("build", `/internal/v1/build-jobs/${queued.response.payload.build.id}/cancel:ack`, {
    method: "POST", body: { ...identity, cleanup_receipt_digest: cleanupReceiptDigest, elapsed_seconds: 0 },
  });
  assertStatus(acknowledged, 200, `${label} cleanup acknowledgment`);
  expectScenario(acknowledged.payload.cleanup_status === "confirmed" && acknowledged.payload.finalized_seconds === 0, `${label} rejected completion leaves confirmed zero-time cleanup`, acknowledged.payload);
  return Object.freeze({ rejectedCode: rejected.payload.error.code, before, after, finalState: acknowledged.payload.cleanup_status });
}

function createBuildUnitGuard(m3, setup) {
  const jobs = new Map();
  let probeSequence = 0;
  const maxSocketMarkerBytes = 512;
  const command = (name, executable, args) => m3.context.runCommand(name, executable, args, {
    env: m3.componentEnvironment("build"), timeoutMs: 15_000,
    logName: `m3-build-unit-guard-${++probeSequence}.log`, cleanup: true,
  });
  const cleanupSocketDirectory = (jobId, attemptId) => {
    if (!UUID.test(jobId) || !UUID.test(attemptId)) {
      throw new Error("refusing cleanup of invalid build socket identity");
    }
    const directory = join("/tmp", `hostlet-build-${attemptId}`);
    if (!existsSync(directory)) return false;
    const directoryMetadata = lstatSync(directory);
    const marker = join(directory, ".hostlet-owned");
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
        directoryMetadata.uid !== process.getuid() || (directoryMetadata.mode & 0o777) !== 0o700 || !existsSync(marker)) {
      throw new Error(`refusing cleanup of unowned build socket directory: ${directory}`);
    }
    const markerMetadata = lstatSync(marker);
    const expectedMarker = `hostlet-build-sockets/v1\njob=${jobId}\nattempt=${attemptId}\n`;
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink() || markerMetadata.uid !== process.getuid() ||
        (markerMetadata.mode & 0o777) !== 0o600 || markerMetadata.size > maxSocketMarkerBytes || readFileSync(marker, "utf8") !== expectedMarker) {
      throw new Error(`refusing cleanup of build socket directory with invalid marker: ${directory}`);
    }
    const socketNames = new Set(["input.sock", "output.sock", "console.sock"]);
    const entries = readdirSync(directory);
    if (entries.some((entry) => entry !== ".hostlet-owned" && !socketNames.has(entry))) {
      throw new Error(`refusing cleanup of build socket directory with unexpected contents: ${directory}`);
    }
    const sockets = entries.filter((entry) => socketNames.has(entry)).map((entry) => join(directory, entry));
    for (const socket of sockets) {
      const metadata = lstatSync(socket);
      if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()) {
        throw new Error(`refusing cleanup of invalid build socket: ${socket}`);
      }
    }
    for (const socket of sockets) {
      unlinkSync(socket);
    }
    unlinkSync(marker);
    rmdirSync(directory);
    if (existsSync(directory)) throw new Error(`run-owned build socket directory remains: ${directory}`);
    return true;
  };
  const discoverOwnedSocketAttempts = (jobId) => {
    const attempts = new Set();
    for (const entry of readdirSync("/tmp")) {
      const matched = /^hostlet-build-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(entry);
      if (!matched) continue;
      const attemptId = matched[1];
      const directory = join("/tmp", entry);
      let directoryMetadata;
      try {
        directoryMetadata = lstatSync(directory);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
          directoryMetadata.uid !== process.getuid()) continue;
      const marker = join(directory, ".hostlet-owned");
      let markerMetadata;
      try {
        markerMetadata = lstatSync(marker);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink() || markerMetadata.uid !== process.getuid() || markerMetadata.size > maxSocketMarkerBytes) continue;
      const expectedMarker = `hostlet-build-sockets/v1\njob=${jobId}\nattempt=${attemptId}\n`;
      const markerValue = readFileSync(marker, "utf8");
      if (markerValue === expectedMarker) {
        attempts.add(attemptId);
      } else if (markerValue.startsWith(`hostlet-build-sockets/v1\njob=${jobId}\n`)) {
        throw new Error(`refusing cleanup of build socket directory with invalid marker: ${directory}`);
      }
    }
    return attempts;
  };
  const runCleanupJob = async (jobId, tracked) => {
    if (!tracked.attemptsCached) {
      if (m3.context.abortSignal.aborted) {
        // The M3 context tears down PostgreSQL in its own finally block before
        // runner-registered cleanups run after an abort. Unit and marker
        // discovery below remain independent exact ownership boundaries.
        tracked.attemptsCached = true;
      } else {
        const durable = await m3.postgres.psqlJson(`m3-build-attempt-discovery-${jobId}`, `SELECT json_build_object(
          'attempt_ids',COALESCE(json_agg(id::text ORDER BY id),'[]'::json)
        ) FROM build_attempts WHERE job_id=${sqlString(jobId)};`);
        for (const attemptId of durable.attempt_ids ?? []) {
          if (!UUID.test(attemptId)) throw new Error("refusing to cache invalid durable build attempt identity");
          tracked.attemptIds.add(attemptId);
        }
        tracked.attemptsCached = true;
      }
    }
    const attemptIds = new Set(tracked.attemptIds);
    for (const attemptId of discoverOwnedSocketAttempts(jobId)) attemptIds.add(attemptId);
    const listed = await command(
      `M3 build unit discovery ${jobId}`, tracked.profile.systemctl,
      ["list-units", `hostlet-build-${jobId}-*.service`, "--all", "--plain", "--no-legend"],
    );
    if (listed.code !== 0) throw new Error(`failed to discover exact run-owned systemd units for job ${jobId}`);
    const names = listed.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    let stopped = 0;
    for (const unit of names) {
      const matched = new RegExp(`^hostlet-build-${jobId}-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.service$`, "i").exec(unit);
      if (!matched) throw new Error(`refusing cleanup of unexpected systemd unit identity: ${unit}`);
      const attemptId = matched[1];
      attemptIds.add(attemptId);
      tracked.attemptIds.add(attemptId);
      const attemptDir = join(tracked.workRoot, jobId, attemptId);
      const socketDir = join("/tmp", `hostlet-build-${attemptId}`);
      const proveVanishedUnit = async () => {
        const vanished = await command(
          `M3 build unit vanished proof ${jobId} ${attemptId}`, tracked.profile.systemctl,
          ["show", unit, "--property=LoadState", "--property=ActiveState", "--property=ControlGroup"],
        );
        const vanishedProperties = Object.fromEntries(vanished.stdout.trim().split("\n").filter(Boolean).map((line) => {
          const split = line.indexOf("=");
          return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
        }));
        let cgroupAbsent;
        try {
          lstatSync(join("/sys/fs/cgroup/system.slice", unit));
          cgroupAbsent = false;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          cgroupAbsent = true;
        }
        return vanished.code === 0 && vanishedProperties.LoadState === "not-found" &&
          vanishedProperties.ActiveState === "inactive" &&
          vanishedProperties.ControlGroup === "" && cgroupAbsent;
      };
      const shown = await command(
        `M3 build unit ownership ${jobId} ${attemptId}`, tracked.profile.systemctl,
        ["show", unit, "--property=LoadState", "--property=Description", "--property=BindPaths", "--property=ActiveState", "--property=KillMode", "--property=RuntimeMaxUSec", "--property=TimeoutStopUSec"],
      );
      const properties = Object.fromEntries(shown.stdout.trim().split("\n").map((line) => {
        const split = line.indexOf("=");
        return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
      }));
      if (shown.code !== 0 || properties.LoadState === "not-found") {
        if (await proveVanishedUnit()) continue;
        throw new Error(`failed to inspect exact run-owned systemd unit: ${unit}`);
      }
      const bindPaths = properties.BindPaths?.trim().split(/\s+/).filter(Boolean) ?? [];
      const expectedBindPaths = [attemptDir, socketDir];
      const bindPathsMatch = bindPaths.length === expectedBindPaths.length && bindPaths.every((value, index) => {
        if (value === expectedBindPaths[index]) return true;
        const fields = value.split(":");
        return fields.length === 3 && fields[0] === expectedBindPaths[index] &&
          fields[1] === expectedBindPaths[index] && fields[2] === "rbind";
      });
      if (properties.Description !== `Hostlet build job ${jobId} attempt ${attemptId}` ||
          !bindPathsMatch ||
          properties.KillMode !== "control-group" ||
          !new Set(["615000000", "10min 15s"]).has(properties.RuntimeMaxUSec) ||
          !new Set(["5000000", "5s"]).has(properties.TimeoutStopUSec)) {
        throw new Error(`refusing cleanup of systemd unit without exact run ownership: ${unit}`);
      }
      if (["active", "activating", "deactivating"].includes(properties.ActiveState)) {
        const stoppedResult = await command(
          `M3 build unit stop ${jobId} ${attemptId}`, tracked.profile.sudo,
          ["-n", tracked.profile.systemctl, "stop", unit],
        );
        if (stoppedResult.code !== 0) {
          if (await proveVanishedUnit()) continue;
          throw new Error(`failed to stop exact run-owned systemd unit: ${unit}`);
        }
        stopped += 1;
      }
      await command(
        `M3 build unit reset ${jobId} ${attemptId}`, tracked.profile.sudo,
        ["-n", tracked.profile.systemctl, "reset-failed", unit],
      );
    }
    const remaining = await command(
      `M3 build unit absence ${jobId}`, tracked.profile.systemctl,
      ["list-units", `hostlet-build-${jobId}-*.service`, "--state=active,activating,deactivating", "--plain", "--no-legend"],
    );
    const active = remaining.stdout.split("\n").filter((line) => line.trim()).length;
    if (remaining.code !== 0) throw new Error(`failed to prove run-owned systemd unit absence for job ${jobId}`);
    if (active !== 0) throw new Error(`run-owned build systemd unit remains active for job ${jobId}`);
    let socketsRemoved = 0;
    for (const attemptId of attemptIds) {
      if (cleanupSocketDirectory(jobId, attemptId)) socketsRemoved += 1;
    }
    const socketsRemaining = [...attemptIds].filter((attemptId) =>
      existsSync(join("/tmp", `hostlet-build-${attemptId}`))).length;
    if (socketsRemaining !== 0) throw new Error(`run-owned build socket directory remains for job ${jobId}`);
    return { discovered: names.length, stopped, active, socketsRemoved, socketsRemaining };
  };
  const cleanupJob = (jobId) => {
    const tracked = jobs.get(jobId);
    if (!tracked) return Promise.resolve({ discovered: 0, stopped: 0, active: 0, socketsRemoved: 0, socketsRemaining: 0 });
    if (tracked.cleanupPromise) return tracked.cleanupPromise;
    const result = runCleanupJob(jobId, tracked).catch((error) => {
      if (tracked.cleanupPromise === result) tracked.cleanupPromise = null;
      throw error;
    });
    tracked.cleanupPromise = result;
    return result;
  };
  const guard = {
    track(jobId, profileId, workRoot) {
      if (!UUID.test(jobId)) throw new Error("refusing to track invalid build job identity");
      jobs.set(jobId, { profile: setup.profile(profileId), workRoot, attemptIds: new Set(), attemptsCached: false, cleanupPromise: null });
    },
    cleanupJob,
  };
  m3.context.registerCleanup("M3 exact run-owned external build units", async () => {
    for (const jobId of jobs.keys()) await cleanupJob(jobId);
  });
  return guard;
}

function safeOutput(m3, prepared, buildDetail, setup, artifactRoot) {
  const declared = m3.fixtureCatalog.buildServices[prepared.key];
  const servicesByKind = new Map(declared.map((service) => [service.kind === "static_frontend" ? "static" : "application", service]));
  const outputs = buildDetail.artifacts.map((artifact) => {
    const service = servicesByKind.get(artifact.kind);
    expectScenario(Boolean(service), `${prepared.key} artifact maps to its declared service`, { artifact_kind: artifact.kind });
    const directory = stageCanonicalArtifact(m3, buildDetail, artifact, artifactRoot);
    return Object.freeze({
      buildJobId: buildDetail.build.id, artifactId: artifact.id, serviceId: artifact.service_id,
      kind: artifact.kind, archiveDigest: artifact.archive_digest, manifestDigest: artifact.manifest_digest,
      buildProfileDigest: buildDetail.build.build_profile_digest, sourceCommit: buildDetail.build.source_commit,
      framework: service.framework, nodeMajor: service.node_major, root: service.root,
      outputDirectory: service.output_directory, startCommand: service.start_command ?? null, healthPath: service.health_path ?? null,
      entrypointArgv: artifact.entrypoint_argv ?? null,
      artifactDirectory: directory, outputRoot: join(directory, "rootfs"), rootfs: null,
    });
  });
  return Object.freeze(outputs);
}

export async function runM3BuildScenarios(m3, options = {}) {
  const { context } = m3;
  const setup = resolveM3BuildSetup(m3, options);
  installM3BuildControlProfiles(m3, setup, m3.fixtureCatalog.commits.dependency_failure.commitSha);
  const broker = await verifyM3BuildBroker(m3, setup);
  const unitGuard = createBuildUnitGuard(m3, setup);
  const defaultProfile = setup.profile(M3_BUILD_PROFILE_ID);
  const artifactRoot = join(context.tempDir, "m3-build-artifacts");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  context.state.configuration.m3Build = {
    mode: "owned_fixture_real_qemu_kvm", profileIds: Object.keys(setup.profiles),
    profileDigests: Object.fromEntries(Object.values(setup.profiles).map(({ id, digest: value }) => [id, value])),
    qemuDigest: defaultProfile.qemuDigest, kernelDigest: defaultProfile.kernelDigest, initrdDigest: defaultProfile.initrdDigest,
    rootfsDigest: defaultProfile.rootfsDigest, dependencyCacheDigest: defaultProfile.dependencyCacheDigest,
    sourceCredentialsInGuest: false, organizationCI: false, artifactRoot: "private run-owned staged artifacts",
  };
  await configureAdmission(m3);
  const buildEnvironmentSecret = await createBuildEnvironmentSecret(m3);
  m3.state.m3BuildEnvironmentSecret = Object.freeze({
    projectId: buildEnvironmentSecret.projectId,
    serviceId: buildEnvironmentSecret.serviceId,
    secretId: buildEnvironmentSecret.secretId,
    secretVersionId: buildEnvironmentSecret.secretVersionId,
    name: buildEnvironmentSecret.name,
    secretVersionRefs: buildEnvironmentSecret.secretVersionRefs,
  });
  let sequence = 0;
  const prepared = new Map();
  const jobs = new Map();
  m3.state.buildOutputs = {};

  const buildFixture = async (key, { expectedState = "succeeded", expectedCode = "build_succeeded", timeoutMs, beforeWorker, afterWorker, existingPrepared, proofTtlMs, captureCompletion = false, storeAs = key } = {}) => {
    const fixture = await prepareFixture(m3, key, ++sequence, existingPrepared, { proofTtlMs });
    prepared.set(`${key}:${sequence}`, fixture);
    const queued = await enqueue(m3, fixture, sequence);
    assertBuildEnqueued(queued.response, `${key} build enqueue`);
    if (beforeWorker) await beforeWorker({ fixture, queued });
    const completionCapture = captureCompletion
      ? join(context.tempDir, `m3-build-${key}-${sequence}-completion.json`)
      : null;
    let worker;
    try {
      worker = await runWorker(m3, setup, unitGuard, fixture.source.toolchainProfile, queued.response.payload.build.id, `${key}-${sequence}`, timeoutMs, { completionCapture });
    } finally {
      if (afterWorker) await afterWorker({ fixture, queued });
    }
    const result = await detail(m3, fixture, queued.response.payload.build.id);
    expectScenario(
      result.build.state === expectedState && result.build.terminal_code === expectedCode,
      `${key} reaches its honest terminal outcome`,
      { state: result.build.state, code: result.build.terminal_code },
    );
    if (buildEnvironmentSecret.projectId === fixture.project.project.id) {
      const secretEvidence = await m3.postgres.psqlJson(`m3-build-secret-binding-${result.build.id}`, `SELECT json_build_object(
        'refs',COALESCE(json_agg(json_build_object(
          'service_id',service_id::text,'secret_id',secret_id::text,'secret_version_id',secret_version_id::text,
          'name',name,'credential_kind',credential_kind) ORDER BY service_id,secret_version_id),'[]'::json)
      ) FROM build_job_secret_refs WHERE job_id=${sqlString(result.build.id)};`);
      const publicEvidence = JSON.stringify({ request: queued.body, detail: result, stdout: worker.stdout, stderr: worker.stderr });
      const artifactContainsSecret = result.artifacts.some(({ archive_digest: archiveDigest }) =>
        readFileSync(casPath(m3, archiveDigest)).includes(Buffer.from(buildEnvironmentSecret.value)));
      const refs = secretEvidence.refs ?? [];
      expectScenario(
        refs.length === 1 && refs[0].service_id === buildEnvironmentSecret.serviceId &&
          refs[0].secret_id === buildEnvironmentSecret.secretId &&
          refs[0].secret_version_id === buildEnvironmentSecret.secretVersionId &&
          refs[0].name === buildEnvironmentSecret.name && refs[0].credential_kind === "build_environment" &&
          !publicEvidence.includes(buildEnvironmentSecret.value) && !artifactContainsSecret,
        `${key} binds the exact build_environment version without exposing its sentinel`,
        {
          secret_ref_count: refs.length,
          service_id: refs[0]?.service_id ?? null,
          secret_version_id: refs[0]?.secret_version_id ?? null,
          credential_kind: refs[0]?.credential_kind ?? null,
          public_secret_matches: publicEvidence.includes(buildEnvironmentSecret.value) ? 1 : 0,
          artifact_secret_matches: artifactContainsSecret ? 1 : 0,
        },
      );
    }
    if (expectedState === "succeeded") {
      expectScenario(
        result.artifacts.length === m3.fixtureCatalog.buildServices[key].length && result.artifacts.every((artifact) => UUID.test(artifact.id) && SHA256.test(artifact.archive_digest) && SHA256.test(artifact.manifest_digest)),
        `${key} registers every immutable digest-addressed output`, { artifact_count: result.artifacts.length },
      );
      const outputs = safeOutput(m3, fixture, result, setup, artifactRoot);
      m3.state.buildOutputs[storeAs] = outputs.length === 1 ? outputs[0] : outputs;
    } else {
      expectScenario(result.artifacts.length === 0, `${key} failure registers no artifact`, { artifact_count: result.artifacts.length });
    }
    if (expectedCode !== "source_policy_rejected") {
      expectScenario(Boolean(worker.cleanup), `${key} real VM emits an explicit cleanup receipt`, { cleanup_event_present: Boolean(worker.cleanup) });
    }
    const record = Object.freeze({ fixtureKey: key, prepared: fixture, enqueue: queued, worker, detail: result, outputs: m3.state.buildOutputs[storeAs] ?? null, completionCapture });
    jobs.set(storeAs, record);
    return record;
  };
  const exhaustAllowanceProbe = async ({ key = "unhealthy_runtime" } = {}) => {
    const before = await m3.ownerHTTP("/v1/entitlements/current");
    assertStatus(before, 200, "build allowance probe entitlement baseline");
    const netUsed = before.payload.build_seconds_debited - before.payload.build_seconds_credited;
    const temporaryLimit = netUsed + 599;
    const update = (limit) => m3.callInternal("/internal/v1/admission/entitlements", {
      method: "POST", body: {
        event_id: randomUUID(), account_id: m3.state.owner.record.id,
        capacity_pool_key: before.payload.capacity_pool_key ?? POOL,
        hosted_slot_limit: before.payload.hosted_slot_limit,
        build_seconds_limit: limit,
        period_starts_at: before.payload.period_starts_at,
        period_ends_at: before.payload.period_ends_at,
        state: "active",
      },
    });
    let response;
    let preparedProbe;
    try {
      const reduced = await update(temporaryLimit);
      assertStatus(reduced, 200, "temporary exact owned build allowance reduction");
      preparedProbe = await prepareFixture(m3, key, ++sequence);
      ({ response } = await enqueue(m3, preparedProbe, ++sequence));
      assertCode(response, 409, "build_allowance_exhausted", "build allowance rejects a real admitted enqueue");
    } finally {
      const restored = await update(before.payload.build_seconds_limit);
      assertStatus(restored, 200, "restore exact owned build allowance");
    }
    const after = await m3.ownerHTTP("/v1/entitlements/current");
    assertStatus(after, 200, "build allowance probe restored entitlement");
    expectScenario(after.payload.build_seconds_limit === before.payload.build_seconds_limit, "build allowance probe restores the original entitlement limit", { before_limit: before.payload.build_seconds_limit, after_limit: after.payload.build_seconds_limit });
    return Object.freeze({
      response,
      projectId: preparedProbe.project.project.id,
      deploymentId: preparedProbe.deployment.id,
      buildSecondsLimitBefore: before.payload.build_seconds_limit,
      buildSecondsNetUsed: netUsed,
      temporaryBuildSecondsLimit: temporaryLimit,
      buildSecondsLimitAfter: after.payload.build_seconds_limit,
    });
  };
  const sourcePolicyProbes = async () => {
    const controls = m3.state.githubFixture.controls;
    const cases = [
      ["traversal", "malformed path"],
      ["symlink", "120000 symlink"],
      ["submodule", "160000 submodule"],
      ["special_file", "special file mode"],
      ["duplicate", "duplicate path"],
      ["case_collision", "case-colliding paths"],
    ];
    const observations = [];
    for (const [kind, description] of cases) {
      const fixture = await prepareFixture(m3, "unhealthy_runtime", ++sequence);
      let queued;
      try {
        controls.setUnsafeTreeCase(kind);
        queued = await enqueue(m3, fixture, sequence);
        assertBuildEnqueued(queued.response, `${description} source fixture enqueue`);
        const worker = await runWorker(m3, setup, unitGuard, fixture.source.toolchainProfile, queued.response.payload.build.id, `source-${kind}-${sequence}`);
        const result = await detail(m3, fixture, queued.response.payload.build.id);
        const durable = await m3.postgres.psqlJson(`m3-build-source-policy-${kind}`, `SELECT json_build_object(
          'launched',EXISTS(SELECT 1 FROM build_attempts WHERE job_id=${sqlString(result.build.id)} AND launched_at IS NOT NULL),
          'artifacts',(SELECT COUNT(*)::int FROM build_artifacts WHERE job_id=${sqlString(result.build.id)}),
          'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id=${sqlString(worker.claim.attempt_id)} AND kind='debit')
        );`);
        expectScenario(
          result.build.state === "failed" && result.build.terminal_code === "source_policy_rejected" &&
            durable.launched === false && durable.artifacts === 0 && durable.debits === 0,
          `${description} source is rejected before guest launch and metering`,
          { state: result.build.state, code: result.build.terminal_code, durable },
        );
        observations.push({ kind, state: result.build.state, code: result.build.terminal_code, durable });
      } finally {
        controls.clearExtraTreeEntries();
      }
    }
    return Object.freeze(observations);
  };
  m3.state.m3Build = {
    setup, artifactRoot, jobs, buildFixture, exhaustAllowanceProbe, sourcePolicyProbes,
    buildEnvironmentSecret: Object.freeze({
      projectId: buildEnvironmentSecret.projectId,
      serviceId: buildEnvironmentSecret.serviceId,
      secretId: buildEnvironmentSecret.secretId,
      secretVersionId: buildEnvironmentSecret.secretVersionId,
      name: buildEnvironmentSecret.name,
      secretVersionRefs: buildEnvironmentSecret.secretVersionRefs,
    }),
  };

  await buildStep(context, "M3-BUILD-01", "an exact selected commit runs in the pinned no-NIC disposable VM and yields immutable bounded outputs", async () => {
    const retainedProject = Object.freeze({ project: m3.state.graph });
    const v1 = await buildFixture("fullstack_v1", {
      existingPrepared: retainedProject,
      captureCompletion: true,
      beforeWorker: ({ fixture }) => m3.state.githubFixture.controls.moveBranch(
        fixture.source.repositoryId, fixture.source.branch, m3.fixtureCatalog.commits.fullstack_v2.commitSha,
      ),
    });
    expectScenario(
      v1.prepared.project.project.id === m3.state.graph.project.id &&
        v1.prepared.graph.configuration.id === m3.state.graph.configuration.id,
      "full-stack v1 builds the retained preview-backed project and configuration",
      {
        retained_project_id: m3.state.graph.project.id,
        build_project_id: v1.prepared.project.project.id,
        retained_configuration_id: m3.state.graph.configuration.id,
        build_configuration_id: v1.prepared.graph.configuration.id,
      },
    );
    const stillExact = await detail(m3, v1.prepared, v1.detail.build.id);
    expectScenario(
      stillExact.build.source_commit === v1.prepared.source.commitSha && stillExact.build.source_tree_sha === v1.prepared.source.treeSha,
      "moving the branch cannot mutate the completed build source", { source_commit: stillExact.build.source_commit, source_tree: stillExact.build.source_tree_sha },
    );
    m3.state.githubFixture.controls.moveBranch(v1.prepared.source.repositoryId, v1.prepared.source.branch, v1.prepared.source.commitSha);
    return {
      job_id: v1.detail.build.id, attempt_id: v1.worker.claim.attempt_id, fence: v1.worker.claim.fence,
      source_commit: v1.detail.build.source_commit, source_tree_sha: v1.detail.build.source_tree_sha,
      input_manifest_digest: v1.detail.build.input_manifest_digest,
      artifact_ids: v1.detail.artifacts.map(({ id }) => id), artifact_digests: v1.detail.artifacts.map(({ archive_digest }) => archive_digest),
      profile_digest: defaultProfile.digest, qemu_digest: defaultProfile.qemuDigest, rootfs_digest: defaultProfile.rootfsDigest,
      dependency_cache_digest: defaultProfile.dependencyCacheDigest, cleanup_status: v1.detail.build.cleanup_status,
      broker_uid: broker.uid, broker_kvm_opened_read_write: broker.openedReadWrite,
      external_units_active_after_worker: v1.worker.unitCleanup.active,
      build_secret_service_id: buildEnvironmentSecret.serviceId,
      build_secret_version_id: buildEnvironmentSecret.secretVersionId,
    };
  });

  await buildStep(context, "M3-BUILD-02", "the real offline VM denies undeclared access, keeps source credentials outside the guest, and reports an offline cache miss honestly", async () => {
    const policy = await buildFixture("policy_probes");
    const dependency = await buildFixture("dependency_failure", { expectedState: "failed", expectedCode: "dependency_not_available_offline" });
    const policyOutput = Array.isArray(policy.outputs) ? policy.outputs[0] : policy.outputs;
    const isolationPath = join(policyOutput.outputRoot, policyOutput.outputDirectory, "build-isolation.json");
    expectScenario(
      policyOutput.kind === "application" && policyOutput.outputDirectory === "dist" &&
        isDeepStrictEqual(policyOutput.entrypointArgv, ["node", "dist/server.mjs"]) && existsSync(isolationPath),
      "policy probe HCA preserves its declared application output directory",
      {
        artifact_kind: policyOutput.kind,
        output_directory: policyOutput.outputDirectory,
        entrypoint_argv: policyOutput.entrypointArgv,
        isolation_evidence_path: `${policyOutput.outputDirectory}/build-isolation.json`,
        isolation_evidence_present: existsSync(isolationPath),
      },
    );
    const isolation = JSON.parse(readFileSync(isolationPath, "utf8"));
    expectScenario(
      isolation.schema === "hostlet.owned-build-isolation/v1" &&
        isolation.network.length >= 4 && isolation.network.every(({ connected }) => connected === false) &&
        isolation.paths.length >= 3 && isolation.paths.every(({ readable }) => readable === false),
      "owned code inside the real build guest cannot reach management networks or host paths",
      {
        schema: isolation.schema,
        network: isolation.network.map(({ name, connected, code }) => ({ name, connected, code })),
        paths: isolation.paths.map(({ path, readable, code }) => ({ path, readable, code })),
      },
    );
    const sourceCredentialSentinel = `m3-upgrade-secret-${context.state.runId}`;
    const issuedProviderCredential = m3.state.githubFixture.controls.issuedInstallationToken(policy.prepared.source.repositoryId);
    expectScenario(issuedProviderCredential.useCount > 0, "the real provider issued and used a repository-scoped installation credential", {
      repository_id: issuedProviderCredential.repositoryId,
      provider_credential_use_count: issuedProviderCredential.useCount,
    });
    const providerSourceObservations = m3.state.githubFixture.safeObservations().filter(({ path }) => /\/git\/(trees|blobs)\//.test(path));
    expectScenario(providerSourceObservations.length > 0 && providerSourceObservations.every(({ authKind }) => authKind === "installation"), "source materialization probes the provider with the issued installation credential", {
      source_provider_requests: providerSourceObservations.length,
      non_installation_source_requests: providerSourceObservations.filter(({ authKind }) => authKind !== "installation").length,
    });
    const artifactEvidence = policy.detail.artifacts
      .map(({ archive_digest: archiveDigest }) => readFileSync(casPath(m3, archiveDigest)).toString("utf8"))
      .join("\n");
    const publicEvidence = JSON.stringify([policy.detail, dependency.detail, policy.worker.stdout, policy.worker.stderr, isolation]) + artifactEvidence;
    expectScenario(
      !publicEvidence.includes(sourceCredentialSentinel) && !publicEvidence.includes(issuedProviderCredential.value),
      "issued source/provider credentials are absent from guest output, artifacts, reports, and public responses",
      { source_credential_matches: publicEvidence.includes(sourceCredentialSentinel) ? 1 : 0, provider_credential_matches: publicEvidence.includes(issuedProviderCredential.value) ? 1 : 0 },
    );
    expectScenario(policy.prepared.source.metrics.fileCount > 0 && policy.detail.artifacts.length === 1, "policy probe executes as an owned source artifact", { source_files: policy.prepared.source.metrics.fileCount, artifact_count: policy.detail.artifacts.length });
    return {
      policy_job_id: policy.detail.build.id, policy_artifact_digest: policy.detail.artifacts[0].archive_digest,
      denied_network_probes: isolation.network.filter(({ connected }) => !connected).length,
      denied_host_path_probes: isolation.paths.filter(({ readable }) => !readable).length,
      cache_miss_job_id: dependency.detail.build.id, cache_miss_code: dependency.detail.build.terminal_code,
      cache_digest: setup.profile(m3.fixtureCatalog.commits.dependency_failure.toolchainProfile).dependencyCacheDigest, network_mode: "QEMU profile no NIC", source_credentials_in_guest: 0,
      provider_credential_use_count: issuedProviderCredential.useCount, provider_source_requests: providerSourceObservations.length, public_credential_matches: 0, organization_ci_jobs: 0,
    };
  });

  if (options.developmentBuildsOnly === true) {
    const v1 = jobs.get("fullstack_v1");
    const v2 = await buildFixture("fullstack_v2", { existingPrepared: v1.prepared });
    expectScenario(
      v2.prepared.project.project.id === v1.prepared.project.project.id,
      "development full-stack v2 is a fresh replacement build for the v1 project",
      { v1_project_id: v1.prepared.project.project.id, v2_project_id: v2.prepared.project.project.id },
    );
    m3.state.m3Build.fullstackV1 = v1;
    m3.state.m3Build.fullstackV2 = v2;
    context.state.configuration.m3Build.developmentSubset = true;
    return m3.state.m3Build;
  }

  await buildStep(context, "M3-BUILD-03", "admission fails closed and durable lease fencing, retry, restart, replay, and metering allow one current effect", async () => {
    const inactive = await prepareFixture(m3, "unhealthy_runtime", ++sequence);
    const entitlementBefore = await m3.ownerHTTP("/v1/entitlements/current");
    assertStatus(entitlementBefore, 200, "inactive entitlement rejection baseline");
    let inactiveResponse;
    try {
      await replaceBuildEntitlement(m3, entitlementBefore.payload, "revoked");
      ({ response: inactiveResponse } = await enqueue(m3, inactive, ++sequence));
    } finally {
      await replaceBuildEntitlement(m3, entitlementBefore.payload, "active");
    }
    assertCode(inactiveResponse, 409, "build_admission_invalid", "inactive entitlement rejects before execution");

    const exhausted = await exhaustAllowanceProbe({ key: "unhealthy_runtime" });

    const expiredSource = await prepareFixture(m3, "unhealthy_runtime", ++sequence, null, { proofTtlMs: 5_000 });
    await context.delay(6_000);
    const expiredEnqueue = await enqueue(m3, expiredSource, ++sequence);
    assertCode(expiredEnqueue.response, 409, "build_source_stale", "expired source proof rejects before an admitted build is created");
    const sourcePolicies = await sourcePolicyProbes();

    const revoked = await buildFixture("unhealthy_runtime", {
      expectedState: "failed", expectedCode: "source_policy_rejected",
      beforeWorker: () => m3.state.githubFixture.controls.revokeInstallation(),
      afterWorker: () => m3.state.githubFixture.controls.restoreInstallation(),
    });
    const revokedLaunch = await m3.postgres.psqlJson("m3-build-revoked-authority-launch", `SELECT json_build_object(
      'launched',(SELECT launched_at IS NOT NULL FROM build_attempts WHERE id=${sqlString(revoked.worker.claim.attempt_id)}),
      'artifacts',(SELECT COUNT(*)::int FROM build_artifacts WHERE job_id=${sqlString(revoked.detail.build.id)}),
      'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id=${sqlString(revoked.worker.claim.attempt_id)} AND kind='debit')
    );`);
    expectScenario(
      revokedLaunch.launched === false && revokedLaunch.artifacts === 0 && revokedLaunch.debits === 0,
      "revoked exact source authority rejects before VM launch, artifact registration, or usage debit",
      revokedLaunch,
    );

    const retry = await prepareFixture(m3, "build_timeout", ++sequence);
    const wrong = await enqueue(m3, retry, sequence, { compatibility_report_id: randomUUID() });
    assertErrorShape(wrong.response, 404, "unknown compatibility evidence rejects before execution");
    const wrongReservation = await enqueue(m3, retry, ++sequence, { reservation_epoch: randomUUID() });
    assertCode(wrongReservation.response, 409, "build_admission_invalid", "conflicting reservation generation rejects before execution");
    const queued = await enqueue(m3, retry, ++sequence);
    assertBuildEnqueued(queued.response, "retry fixture enqueue");
    const retryProfile = setup.profile(retry.source.toolchainProfile);
    const leaseBody = { worker_id: "m3-fence-a", kinds: ["project_build"], profiles: [{ id: retryProfile.id, digest: retryProfile.digest }] };
    const claims = await Promise.all([
      m3.roleInternal("build", "/internal/v1/build-jobs/lease", { method: "POST", body: leaseBody }),
      m3.roleInternal("build", "/internal/v1/build-jobs/lease", { method: "POST", body: { ...leaseBody, worker_id: "m3-fence-b" } }),
    ]);
    expectScenario(claims.filter(({ status }) => status === 200).length === 1 && claims.filter(({ status }) => status === 204).length === 1, "concurrent workers produce one live claim", { statuses: claims.map(({ status }) => status) });
    const first = claims.find(({ status }) => status === 200).payload;
    await context.delay(12_000);
    let afterExpiry = await detail(m3, retry, queued.response.payload.build.id);
    expectScenario(afterExpiry.build.state === "retriable" && afterExpiry.build.attempt_count === 1, "prelaunch lease expiry is retriable without an effect", { state: afterExpiry.build.state, attempt_count: afterExpiry.build.attempt_count });
    await m3.switchApi(m3.currentApiBinary, "M3 build retry API restart");
    const second = await m3.roleInternal("build", "/internal/v1/build-jobs/lease", { method: "POST", body: { ...leaseBody, worker_id: "m3-fence-c" } });
    assertStatus(second, 200, "post-restart retry lease");
    await context.delay(12_000);
    afterExpiry = await detail(m3, retry, queued.response.payload.build.id);
    expectScenario(afterExpiry.build.state === "retriable" && afterExpiry.build.attempt_count === 2, "second prelaunch lease expiry remains retriable across API restart", { state: afterExpiry.build.state, attempt_count: afterExpiry.build.attempt_count });
    const stale = await m3.roleInternal("build", `/internal/v1/build-jobs/${first.job.id}/renew`, {
      method: "POST", body: { worker_id: first.attempt.worker_id, attempt_id: first.attempt.id, fence: first.attempt.fence },
    });
    assertCode(stale, 409, "build_job_fenced", "stale attempt cannot renew after retry and restart");
    const fencedCleanup = await interruptLiveWorker(m3, setup, unitGuard, retry, queued, `fence-current-${sequence}`);

    const restartPrepared = await prepareFixture(m3, "node22_api", ++sequence);
    const restartQueue = await enqueue(m3, restartPrepared, sequence);
    assertBuildEnqueued(restartQueue.response, "real builder restart fixture enqueue");
    const restartedBuild = await restartPrelaunchBuilder(m3, setup, unitGuard, restartPrepared, restartQueue, `restart-${sequence}`);
    const restartOutputs = safeOutput(m3, restartPrepared, restartedBuild.terminal, setup, artifactRoot);
    m3.state.buildOutputs.node22_api = restartOutputs[0];
    jobs.set("node22_api", Object.freeze({
      prepared: restartPrepared, enqueue: restartQueue, worker: restartedBuild.restarted,
      detail: restartedBuild.terminal, outputs: restartOutputs[0],
    }));
    const restartEffects = await m3.postgres.psqlJson("m3-build-real-restart-effects", `SELECT json_build_object(
      'attempts',(SELECT COUNT(*)::int FROM build_attempts WHERE job_id=${sqlString(restartedBuild.terminal.build.id)}),
      'launched_attempts',(SELECT COUNT(*)::int FROM build_attempts WHERE job_id=${sqlString(restartedBuild.terminal.build.id)} AND launched_at IS NOT NULL),
      'effects',(SELECT COUNT(*)::int FROM build_effects WHERE job_id=${sqlString(restartedBuild.terminal.build.id)}),
      'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id IN (SELECT id FROM build_attempts WHERE job_id=${sqlString(restartedBuild.terminal.build.id)}) AND kind='debit')
    );`);
    expectScenario(
      restartEffects.attempts === 2 && restartEffects.launched_attempts === 1 && restartEffects.effects === 1 && restartEffects.debits === 1,
      "real builder interruption and new-process restart produce one launched effect and debit",
      restartEffects,
    );

    const v1 = jobs.get("fullstack_v1");
    const capturedCompletion = readCompletionCapture(v1.completionCapture);
    const completionBefore = await m3.postgres.psqlJson("m3-build-completion-replay-before", `SELECT json_build_object(
      'effects',(SELECT COUNT(*)::int FROM build_effects WHERE job_id=${sqlString(v1.detail.build.id)}),
      'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id=${sqlString(capturedCompletion.body.attempt_id)} AND kind='debit'),
      'artifacts',(SELECT COUNT(*)::int FROM build_artifacts WHERE job_id=${sqlString(v1.detail.build.id)})
    );`);
    const completionReplay = await m3.roleInternal("build", `/internal/v1/build-jobs/${v1.detail.build.id}/complete`, {
      method: "POST", body: capturedCompletion.body,
    });
    assertStatus(completionReplay, 200, "authenticated unchanged completion replay");
    expectScenario(
      isDeepStrictEqual(completionReplay.payload, capturedCompletion.response),
      "authenticated unchanged completion replay returns the original receipt exactly",
      { response_matches_capture: isDeepStrictEqual(completionReplay.payload, capturedCompletion.response) },
    );
    const changedCompletion = {
      ...capturedCompletion.body,
      outcome: {
        ...capturedCompletion.body.outcome,
        elapsed_seconds: capturedCompletion.body.outcome.elapsed_seconds === 600
          ? capturedCompletion.body.outcome.elapsed_seconds - 1
          : capturedCompletion.body.outcome.elapsed_seconds + 1,
      },
    };
    const changedReplay = await m3.roleInternal("build", `/internal/v1/build-jobs/${v1.detail.build.id}/complete`, {
      method: "POST", body: changedCompletion,
    });
    assertCode(changedReplay, 409, "build_completion_conflict", "changed authenticated completion replay conflicts");
    const staleCompletion = {
      ...capturedCompletion.body,
      fence: capturedCompletion.body.fence + 1,
    };
    const staleCompletionReplay = await m3.roleInternal("build", `/internal/v1/build-jobs/${v1.detail.build.id}/complete`, {
      method: "POST", body: staleCompletion,
    });
    assertCode(staleCompletionReplay, 409, "build_job_fenced", "stale-fence completion replay is rejected");
    const completionAfter = await m3.postgres.psqlJson("m3-build-completion-replay-after", `SELECT json_build_object(
      'effects',(SELECT COUNT(*)::int FROM build_effects WHERE job_id=${sqlString(v1.detail.build.id)}),
      'debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id=${sqlString(capturedCompletion.body.attempt_id)} AND kind='debit'),
      'artifacts',(SELECT COUNT(*)::int FROM build_artifacts WHERE job_id=${sqlString(v1.detail.build.id)})
    );`);
    expectScenario(isDeepStrictEqual(completionBefore, completionAfter), "completion replay and stale fence attempts have no additional durable effects", { before: completionBefore, after: completionAfter });
    const wrongProfile = await m3.ownerHTTP(`/v1/projects/${v1.prepared.project.project.id}/deployments/${v1.prepared.deployment.id}/builds`, {
      method: "POST",
      headers: headers("m3-build-unadmitted-cache-profile", v1.prepared.graph.project.revision),
      body: { ...v1.enqueue.body, build_profile: "m3-owned-node24-cache-miss-v1" },
    });
    assertCode(wrongProfile, 422, "build_profile_not_admitted", "unadmitted cache-miss profile rejects before execution");
    const enqueueReplay = await m3.ownerHTTP(`/v1/projects/${v1.prepared.project.project.id}/deployments/${v1.prepared.deployment.id}/builds`, {
      method: "POST", headers: headers(v1.enqueue.key, v1.prepared.graph.project.revision), body: v1.enqueue.body,
    });
    assertStatus(enqueueReplay, 200, "exact enqueue replay");
    expectScenario(enqueueReplay.payload.build.id === v1.detail.build.id, "enqueue replay returns the same immutable build", { replay_job_id: enqueueReplay.payload.build.id });
    const sql = await m3.postgres.psqlJson("m3-build-fencing-meter", `SELECT json_build_object(
      'success_effects',(SELECT COUNT(*)::int FROM build_effects WHERE job_id=${sqlString(v1.detail.build.id)}),
      'success_debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id=${sqlString(v1.worker.claim.attempt_id)} AND kind='debit'),
      'retry_receipts',(SELECT COUNT(*)::int FROM build_attempts WHERE job_id=${sqlString(first.job.id)} AND state='retriable'),
      'registered_artifacts',(SELECT COUNT(*)::int FROM build_artifacts WHERE job_id=${sqlString(v1.detail.build.id)} AND cas_state='registered')
    );`);
    expectScenario(sql.success_effects === 1 && sql.success_debits === 1 && sql.retry_receipts === 2 && sql.registered_artifacts === v1.detail.artifacts.length && fencedCleanup.terminal.build.cleanup_status === "confirmed", "one terminal effect, one debit, immutable artifacts, and acknowledged fenced cleanup survive retry/restart", { ...sql, fenced_cleanup_status: fencedCleanup.terminal.build.cleanup_status });
    return { inactive_entitlement_code: inactiveResponse.payload.error.code, exhausted_allowance_code: exhausted.response.payload.error.code, expired_source_code: expiredEnqueue.response.payload.error.code, source_policy_cases: sourcePolicies, revoked_authority_code: revoked.detail.build.terminal_code, revoked_authority_launched: revokedLaunch.launched, conflicting_reservation_code: wrongReservation.response.payload.error.code, concurrent_claim_statuses: claims.map(({ status }) => status), first_fence: first.attempt.fence, second_fence: second.payload.attempt.fence, final_fence: fencedCleanup.terminal.build.current_fence, stale_code: stale.payload.error.code, fenced_cleanup_status: fencedCleanup.terminal.build.cleanup_status, real_builder_restart: restartEffects, unadmitted_profile_code: wrongProfile.payload.error.code, exact_replay_job_id: enqueueReplay.payload.build.id, completion_replay: { changed_code: changedReplay.payload.error.code, stale_code: staleCompletionReplay.payload.error.code, before: completionBefore, after: completionAfter }, ...sql };
  });

  await buildStep(context, "M3-BUILD-04", "real dependency, command, timeout, workspace/output, source-policy, corruption, and interruption failures leave safe terminal evidence and no promoted artifact", async () => {
    const releaseBefore = await m3.postgres.psqlJson("m3-build-release-preservation-before", `SELECT json_build_object(
      'release_count',(SELECT COUNT(*)::int FROM application_releases WHERE account_id=${sqlString(m3.state.owner.record.id)}),
      'route_count',(SELECT COUNT(*)::int FROM project_release_routes WHERE account_id=${sqlString(m3.state.owner.record.id)}),
      'route_identity',(SELECT COALESCE(string_agg(project_id::text || ':' || release_id::text || ':' || route_manifest_digest, ',' ORDER BY project_id),'') FROM project_release_routes WHERE account_id=${sqlString(m3.state.owner.record.id)})
    );`);
    const command = await buildFixture("build_failure", { expectedState: "failed", expectedCode: "build_failed" });
    const oversized = await buildFixture("oversized_output", { expectedState: "failed", expectedCode: "static_output_too_large" });
    const workspace = await buildFixture("workspace_exhaustion", { expectedState: "failed", expectedCode: "workspace_limit" });
    const outputSymlink = await buildFixture("unsafe_output_symlink", { expectedState: "failed", expectedCode: "output_invalid" });
    const outputSpecial = await buildFixture("unsafe_output_special", { expectedState: "failed", expectedCode: "output_invalid" });
    const malformed = await buildFixture("incompatible_api", {
      expectedState: "failed", expectedCode: "source_policy_rejected",
      beforeWorker: () => m3.state.githubFixture.controls.setBlobShaMismatch(true),
      afterWorker: () => m3.state.githubFixture.controls.setBlobShaMismatch(false),
      storeAs: "incompatible_api_source_corrupt",
    });
    const incompatible = await buildFixture("incompatible_api", {
      existingPrepared: jobs.get("fullstack_v1").prepared,
    });
    const wrongManifestFixture = await prepareFixture(m3, "unhealthy_runtime", ++sequence);
    const wrongManifestQueue = await enqueue(m3, wrongManifestFixture, ++sequence);
    assertBuildEnqueued(wrongManifestQueue.response, "wrong-identity manifest fixture enqueue");
    const wrongManifest = await wrongIdentityManifestProbe(m3, setup, wrongManifestFixture, wrongManifestQueue, `wrong-manifest-${sequence}`);
    const interruptedFixture = await prepareFixture(m3, "build_timeout", ++sequence);
    const interruptedQueue = await enqueue(m3, interruptedFixture, sequence);
    assertBuildEnqueued(interruptedQueue.response, "interrupted timeout fixture enqueue");
    const interrupted = await interruptLiveWorker(m3, setup, unitGuard, interruptedFixture, interruptedQueue, `interrupted-${sequence}`);
    const timed = await buildFixture("build_timeout", { expectedState: "failed", expectedCode: "build_timeout", timeoutMs: options.longFailureTimeoutMs ?? 720_000 });
    const corruptProbe = jobs.get("policy_probes");
    const corruptArtifact = corruptProbe.detail.artifacts[0];
    const corruptPath = casPath(m3, corruptArtifact.archive_digest);
    const original = readFileSync(corruptPath);
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 0xff;
    writeFileSync(corruptPath, changed, { mode: 0o600 });
    let corruptionRejected = false;
    try { stageCanonicalArtifact(m3, corruptProbe.detail, corruptArtifact, artifactRoot); } catch { corruptionRejected = true; }
    writeFileSync(corruptPath, original, { mode: 0o600 });
    expectScenario(corruptionRejected && digest(readFileSync(corruptPath)) === corruptArtifact.archive_digest, "corrupted immutable artifact is rejected and owned CAS is restored", { corruption_rejected: corruptionRejected, restored_digest_match: digest(readFileSync(corruptPath)) === corruptArtifact.archive_digest });
    const v2 = await buildFixture("fullstack_v2", { existingPrepared: jobs.get("fullstack_v1").prepared });
    expectScenario(v2.prepared.project.project.id === jobs.get("fullstack_v1").prepared.project.project.id, "full-stack v2 is a replacement build for the v1 project", { v1_project_id: jobs.get("fullstack_v1").prepared.project.project.id, v2_project_id: v2.prepared.project.project.id });
    const dependency = jobs.get("dependency_failure");
    const failed = [dependency, command, oversized, workspace, outputSymlink, outputSpecial, malformed, timed];
    const positiveMeters = failed.filter(({ detail: value }) => Number(value.report?.meter?.finalized_seconds) > 0).length;
    const sensitiveValues = Object.values(m3.credentials).filter((value) => typeof value === "string" && value.length >= 8);
    const reportsBounded = failed.every(({ detail: value }) => Buffer.byteLength(JSON.stringify(value.report)) <= 131_072);
    const reportsRedacted = failed.every(({ detail: value }) => {
      const report = JSON.stringify(value.report);
      return sensitiveValues.every((secret) => !report.includes(secret));
    });
    const sql = await m3.postgres.psqlJson("m3-build-failure-cleanup", `SELECT json_build_object(
      'failed_artifacts',(SELECT COUNT(*)::int FROM build_artifacts a JOIN build_jobs j ON j.id=a.job_id WHERE j.id IN (${failed.map((item) => sqlString(item.detail.build.id)).join(",")})),
      'failed_effects',(SELECT COUNT(*)::int FROM build_effects WHERE job_id IN (${failed.map((item) => sqlString(item.detail.build.id)).join(",")})),
      'failed_debits',(SELECT COUNT(*)::int FROM build_usage_events WHERE attempt_id IN (${failed.map((item) => sqlString(item.worker.claim.attempt_id)).join(",")})),
      'debited_seconds',(SELECT COALESCE(SUM(seconds),0)::int FROM build_usage_events WHERE attempt_id IN (${failed.map((item) => sqlString(item.worker.claim.attempt_id)).join(",")})),
      'unfinalized_usage',(SELECT COUNT(*)::int FROM build_usage_reservations WHERE job_id IN (${failed.map((item) => sqlString(item.detail.build.id)).join(",")} ) AND state='reserved'),
      'release_rows',(SELECT COUNT(*)::int FROM application_releases WHERE build_job_id IN (${failed.map((item) => sqlString(item.detail.build.id)).join(",")}))
    );`);
    const reportedSeconds = failed.reduce((sum, { detail: value }) => sum + Number(value.report?.meter?.finalized_seconds ?? 0), 0);
    const releaseAfter = await m3.postgres.psqlJson("m3-build-release-preservation-after", `SELECT json_build_object(
      'release_count',(SELECT COUNT(*)::int FROM application_releases WHERE account_id=${sqlString(m3.state.owner.record.id)}),
      'route_count',(SELECT COUNT(*)::int FROM project_release_routes WHERE account_id=${sqlString(m3.state.owner.record.id)}),
      'route_identity',(SELECT COALESCE(string_agg(project_id::text || ':' || release_id::text || ':' || route_manifest_digest, ',' ORDER BY project_id),'') FROM project_release_routes WHERE account_id=${sqlString(m3.state.owner.record.id)})
    );`);
    expectScenario(isDeepStrictEqual(releaseBefore, releaseAfter), "build failures preserve existing release and route rows", { before: releaseBefore, after: releaseAfter });
    expectScenario(sql.failed_artifacts === 0 && sql.failed_effects === failed.length && sql.failed_debits === positiveMeters && sql.debited_seconds === reportedSeconds && sql.unfinalized_usage === 0 && sql.release_rows === 0 && reportsBounded && reportsRedacted && failed.every(({ detail: value }) => value.build.cleanup_status === "confirmed"), "failure effects meter once, expose only bounded redacted reports, register no artifact or release, and confirm cleanup", { ...sql, positive_meters: positiveMeters, reported_seconds: reportedSeconds, reports_bounded: reportsBounded, reports_redacted: reportsRedacted, release_before: releaseBefore, release_after: releaseAfter });
    return { dependency_failure_code: dependency.detail.build.terminal_code, command_failure_code: command.detail.build.terminal_code, output_failure_code: oversized.detail.build.terminal_code, workspace_failure_code: workspace.detail.build.terminal_code, symlink_output_code: outputSymlink.detail.build.terminal_code, special_output_code: outputSpecial.detail.build.terminal_code, malformed_source_code: malformed.detail.build.terminal_code, incompatible_api_job_id: incompatible.detail.build.id, wrong_identity_manifest: wrongManifest, timeout_code: timed.detail.build.terminal_code, interruption_state: interrupted.terminal.build.state, interruption_cleanup_status: interrupted.terminal.build.cleanup_status, interruption_artifacts: interrupted.terminal.artifacts.length, interruption_attempt_directory_present: existsSync(interrupted.attemptDirectory), interruption_unit_active: interrupted.unitActive, interruption_units_stopped_by_guard: interrupted.unitCleanup.stopped, live_supervisor: interrupted.supervisor, corruption_rejected: true, prior_fullstack_job_id: jobs.get("fullstack_v1").detail.build.id, next_fullstack_job_id: v2.detail.build.id, ...sql };
  });

  m3.state.m3Build.fullstackV1 = jobs.get("fullstack_v1");
  m3.state.m3Build.fullstackV2 = jobs.get("fullstack_v2");
  return m3.state.m3Build;
}

export { registerM3BuildFixtures };
