import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { beginBrowser } from "./interactive-browser.mjs";

export function releaseSha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RELEASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_WORKER_KINDS_WITHOUT_LIVE_APPLY = Object.freeze([
  "provision", "backup_daily", "backup_pre_migration", "export", "restore_drill",
  "observe_storage", "migration_trial", "archive_expire",
]);
const RELEASE_STATES = new Set(["staged", "healthy", "failed", "retired"]);
const RECONCILIATION_STATES = new Set(["queued", "running", "awaiting_trial", "awaiting_live_apply", "prepared", "retriable", "succeeded", "failed"]);
const ATTEMPT_STATES = new Set(["running", "succeeded", "failed", "retriable", "expired"]);

function validReleaseDigest(value) {
  return typeof value === "string" && RELEASE_DIGEST.test(value);
}

function alternateReleaseDigest(value) {
  if (!validReleaseDigest(value)) throw new Error("cannot derive an alternate release digest from malformed input");
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

function ensureReleaseStateRoot(m3) {
  chmodSync(m3.policyClock.stateDir, 0o700);
  const marker = join(m3.policyClock.stateDir, ".hostlet-release-owned");
  try { writeFileSync(marker, "hostlet-release-state-v1\n", { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || readFileSync(marker, "utf8").trim() !== "hostlet-release-state-v1") throw error;
  }
}

export function startReleaseWorker(m3, {
  binary = join(m3.context.repo, "target", "debug", "hostlet-runtime"),
  coordinator = join(m3.context.repo, "scripts", "release", "hostlet-release-coordinator.py"),
  probe = join(m3.context.repo, "scripts", "runtime", "hostlet-runtime-probe"),
  migrationProbe = join(m3.context.repo, "scripts", "runtime", "hostlet-runtime-migration-probe.py"),
  launcher = join(m3.context.repo, "scripts", "runtime", "hostlet-runtime-launcher"),
  peerHelper = join(m3.context.repo, "scripts", "runtime", "hostlet-runtime-peer"),
  runsc = m3.state.runtime?.runsc,
  runtimeArtifactRoot = m3.state.runtime?.artifactRoot,
  artifactRoot = join(m3.policyClock.stateDir, "private-cas"),
  runtimeRoot = m3.state.runtime?.stateRoot,
  workerId = "m3-owned-release-worker",
} = {}) {
  if (!runtimeRoot || !runsc || !runtimeArtifactRoot) throw new Error("release worker requires the actual initialized runtime state and artifact roots");
  ensureReleaseStateRoot(m3);
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  chmodSync(artifactRoot, 0o700);
  const canonicalArtifacts = realpathSync(artifactRoot);
  if (!canonicalArtifacts.startsWith(`${m3.policyClock.stateDir}/`)) {
    throw new Error("release artifact CAS must be inside the run-owned M3 state root");
  }
  const marker = join(canonicalArtifacts, ".hostlet-cas-owned");
  try { writeFileSync(marker, "hostlet-private-cas-v1\n", { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || readFileSync(marker, "utf8").trim() !== "hostlet-private-cas-v1") throw error;
  }
  const tokenFile = join(m3.policyClock.stateDir, "release-worker.token");
  const tokenValue = m3.workerTokens?.runtime ?? m3.extraEnvironment.HOSTLET_M3_RUNTIME_TOKEN;
  try { writeFileSync(tokenFile, `${tokenValue}\n`, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || readFileSync(tokenFile, "utf8").trim() !== tokenValue) throw error;
  }
  chmodSync(tokenFile, 0o600);
  const privileged = process.getuid?.() === 0 ? [] : ["--privileged-command", realpathSync("/usr/bin/sudo")];
  const child = m3.context.spawnManaged(
    "M3 coordinated release worker",
    binary,
    [
      "release-worker", "--control-url", m3.workerUrl, "--worker-id", workerId,
      "--token-file", tokenFile, "--coordinator", coordinator, "--probe", probe,
      "--migration-probe", migrationProbe, "--runtime-binary", binary,
      "--launcher", launcher, "--runsc", runsc, "--peer-helper", peerHelper,
      "--state-root", m3.policyClock.stateDir, "--runtime-root", runtimeRoot,
      "--artifact-root", artifactRoot, "--runtime-artifact-root", runtimeArtifactRoot, ...privileged,
    ],
    { env: m3.componentEnvironment("runtime") },
    "m3-release-worker.log",
  );
  return Object.freeze({ process: child, workerId, tokenFile, artifactRoot: canonicalArtifacts, runtimeRoot });
}

export async function startReleaseGateway(m3, {
  projectId,
  hostname,
  certificate,
  privateKey,
  runtimeRoot = m3.state.runtime?.stateRoot,
  port,
  gateway = join(m3.context.repo, "scripts", "release", "hostlet-release-gateway.py"),
} = {}) {
  if (!projectId || !hostname || !certificate || !privateKey || !runtimeRoot || !Number.isSafeInteger(port)) {
    throw new Error("release gateway requires an exact project, localowned.test hostname, TLS identity and port");
  }
  ensureReleaseStateRoot(m3);
  const tlsRoot = join(m3.policyClock.stateDir, "release-tls");
  mkdirSync(tlsRoot, { recursive: true, mode: 0o700 });
  chmodSync(tlsRoot, 0o700);
  const ownedCertificate = join(tlsRoot, `${hostname}.certificate.pem`);
  const ownedPrivateKey = join(tlsRoot, `${hostname}.private-key.pem`);
  copyFileSync(certificate, ownedCertificate, 0);
  copyFileSync(privateKey, ownedPrivateKey, 0);
  chmodSync(ownedCertificate, 0o600); chmodSync(ownedPrivateKey, 0o600);
  const process = m3.context.spawnManaged(
    "M3 owned TLS release gateway",
    gateway,
    ["--state-root", m3.policyClock.stateDir, "--runtime-root", runtimeRoot, "--project-id", projectId, "--hostname", hostname,
      "--listen-port", String(port), "--certificate", ownedCertificate, "--private-key", ownedPrivateKey],
    { env: m3.componentEnvironment("runtime") },
    "m3-release-gateway.log",
  );
  await waitForTls({ hostname, port, ca: ownedCertificate, signal: m3.context.abortSignal });
  return Object.freeze({ process, hostname, port, origin: `https://${hostname}:${port}`, certificate: ownedCertificate });
}

function tlsRequest({ hostname, port, ca, path = "/", method = "GET", headers = {}, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname, port, path, method, headers, ca: readFileSync(ca), servername: hostname,
      lookup: (_name, options, callback) => {
        if (options?.all === true) return callback(null, [{ address: "127.0.0.1", family: 4 }]);
        return callback(null, "127.0.0.1", 4);
      },
      timeout: 8_000,
    }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size <= 2 * 1024 * 1024) chunks.push(chunk); });
      response.on("end", () => {
        if (size > 2 * 1024 * 1024) return reject(new Error("release gateway response exceeded E2E bound"));
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, bytes,
          json: () => JSON.parse(bytes.toString("utf8")), text: () => bytes.toString("utf8") });
      });
    });
    request.once("timeout", () => request.destroy(new Error("release gateway timeout")));
    request.once("error", reject);
    if (signal) signal.addEventListener("abort", () => request.destroy(signal.reason), { once: true });
    if (body) request.write(body);
    request.end();
  });
}

async function waitForTls(options) {
  let last;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await tlsRequest(options); if (response.status) return; }
    catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`owned TLS release gateway did not become reachable: ${last?.message ?? "unknown failure"}`);
}

export function createReleaseClient(gateway, abortSignal) {
  let cookie = null;
  return Object.freeze({
    get cookie() { return cookie; },
    setCookie(value) { cookie = value; },
    async request(path, { method = "GET", json, headers = {} } = {}) {
      const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
      const response = await tlsRequest({ hostname: gateway.hostname, port: gateway.port,
        ca: gateway.certificate, path, method, signal: abortSignal,
        headers: { ...headers, ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body });
      const setCookie = response.headers["set-cookie"]?.find((value) => value.startsWith("__Host-hostlet_release="));
      if (setCookie) cookie = setCookie.split(";", 1)[0];
      return response;
    },
  });
}

export function readActiveRoute(stateRoot, projectId) {
  if (!RELEASE_UUID.test(projectId)) throw new Error("release route reader requires an exact project UUID");
  const routeRoot = join(stateRoot, "release-routes", projectId);
  const bytes = readFileSync(join(routeRoot, "current.json"));
  const digest = releaseSha256(bytes);
  const immutable = readFileSync(join(routeRoot, "manifests", `${digest.slice(7)}.json`));
  if (!immutable.equals(bytes) || releaseSha256(immutable) !== digest) {
    throw new Error("active release route pointer does not match its immutable manifest bytes");
  }
  const manifest = JSON.parse(bytes);
  if (manifest?.schema !== "hostlet.route-manifest/v1" || manifest.project_id !== projectId ||
      manifest.release_id === undefined || !RELEASE_UUID.test(manifest.release_id) ||
      !Number.isSafeInteger(manifest.generation) || manifest.generation <= 0) {
    throw new Error("active release route manifest is malformed");
  }
  return Object.freeze({ bytes, digest, manifest, immutableBytes: immutable });
}

export async function beginReleaseBrowser(context, gateway, certificateSpkiSha256, label) {
  if (!gateway?.origin || !gateway?.hostname || typeof certificateSpkiSha256 !== "string") {
    throw new Error("release browser requires the exact owned TLS gateway and certificate SPKI");
  }
  if (!Number.isSafeInteger(gateway.port) || gateway.port < 1 || gateway.port > 65_535) {
    throw new Error("release browser gateway port is invalid");
  }
  let origin;
  try { origin = new URL(gateway.origin); }
  catch { throw new Error("release browser gateway origin is invalid"); }
  if (origin.protocol !== "https:" || origin.hostname !== gateway.hostname || Number(origin.port) !== gateway.port ||
      origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("release browser gateway origin is not the exact owned HTTPS origin");
  }
  const browser = await beginBrowser(context, {
    url: gateway.origin, width: 1280, height: 900, label, timeoutMs: 40_000,
    ownedHttpsHostname: gateway.hostname, certificateSpkiSha256,
  });
  const selectRelease = async (releaseId) => {
    if (!RELEASE_UUID.test(releaseId ?? "")) throw new Error("release browser selection requires an exact release UUID");
    await browser.setHttpOnlyCookie("__Host-hostlet_release", releaseId, gateway.origin);
  };
  const observe = async (evidenceLabel) => {
    await browser.waitFor("#release", { waitTimeoutMs: 30_000 });
    await browser.waitFor(() => document.querySelector("#release")?.textContent?.includes("api-v"), { waitTimeoutMs: 30_000 });
    const product = await browser.evaluate(`(() => ({
      url: location.href,
      release: document.querySelector("#release")?.textContent ?? null,
      rows: [...document.querySelectorAll("#items li")].map((row) => ({ id: row.dataset.itemId ?? null, text: row.textContent ?? "" })),
      resources: performance.getEntriesByType("resource").map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType }))
        .filter((entry) => entry.name.startsWith(location.origin + "/"))
    }))()`);
    const safe = String(evidenceLabel).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
    const networkPath = join(context.artifactDir, "browser", `${safe}-network.json`);
    writeFileSync(networkPath, `${JSON.stringify(product, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const screenshot = await browser.screenshot(evidenceLabel);
    const dom = await browser.captureDom(evidenceLabel, { safe: true });
    return Object.freeze({ ...product, screenshot, dom, network: networkPath });
  };
  let writeSequence = 0;
  const createItem = async (name) => {
    const expectedName = String(name);
    if (expectedName.length === 0) throw new Error("release browser item name is empty");
    await browser.fill("#item-name", expectedName);
    await browser.click("#item-form button");
    const expectedNameLiteral = JSON.stringify(expectedName);
    const namedRowPredicate = new Function(`return [...document.querySelectorAll("#items li")]
      .some((row) => String(row.textContent ?? "").trim() === ${expectedNameLiteral});`);
    await browser.waitFor(namedRowPredicate, { waitTimeoutMs: 30_000 });
    return observe(`${label}-after-write-${++writeSequence}`);
  };
  return Object.freeze({ browser, observe, createItem, selectRelease, close: browser.close });
}

function applicationOutput(record) {
  const outputs = Array.isArray(record?.outputs) ? record.outputs : [record?.outputs];
  const output = outputs.find((value) => value?.kind === "application");
  if (!output) throw new Error("release build has no registered application artifact");
  return output;
}

function staticOutput(record) {
  const outputs = Array.isArray(record?.outputs) ? record.outputs : [record?.outputs];
  return outputs.find((value) => value?.kind === "static") ?? null;
}

class ReleaseWorkerExited extends Error {}
class TerminalReleaseWaitError extends Error {}

async function eventually(label, callback, { timeoutMs = 60_000, intervalMs = 125 } = {}) {
  const deadline = Date.now() + timeoutMs; let last;
  while (Date.now() < deadline) {
    try { const value = await callback(); if (value) return value; }
    catch (error) {
      if (error instanceof ReleaseWorkerExited || error instanceof TerminalReleaseWaitError) throw error;
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} did not reach its expected durable state${last ? `: ${last.message}` : ""}`);
}

export function createM3ReleaseHarness(context, m3, options = {}) {
  const runtime = options.runtime ?? m3.state.runtime;
  const evaluation = options.evaluation ?? m3.state.runtimeEvidence?.evaluation;
  const buildStage = options.buildStage ?? m3.state.m3Build;
  const databases = options.databases ?? m3.state.tenantDatabases;
  const dataStage = options.dataStage ?? m3.state.dataStage;
  const launchRelease = options.launchRelease ?? runtime?.launchRelease;
  if (!runtime || !evaluation?.id || !buildStage?.jobs || !Array.isArray(databases) || typeof launchRelease !== "function" ||
      typeof runtime?.evaluateRelease !== "function" || typeof dataStage?.drainWorker !== "function" || typeof dataStage?.syncReplacementTargets !== "function") {
    throw new Error("release harness requires actual build, runtime capability, tenant database and migration-stage objects");
  }
  if (!options.certificate || !options.privateKey || !options.hostname) throw new Error("release harness requires its run-owned localowned.test TLS identity");
  if (typeof options.spki !== "string") throw new Error("release harness requires its owned TLS certificate SPKI digest");
  let gateway = null; let worker = null; let sequence = 0; let releaseLaunchSequence = 0;
  const releaseNetworkFirst = 34;
  const releaseNetworkSpan = 17;
  let currentPrepared = null; let replacementPrepared = null;
  const live = new Map();
  const releaseRuntimes = new Map();
  const migrationFences = new Map();
  let failureEvidenceSequence = 0;

  function evidenceUuid(value) {
    return RELEASE_UUID.test(value ?? "") ? value : null;
  }
  function evidenceState(value, allowed) {
    return allowed.has(value) ? value : null;
  }
  function evidenceCode(value) {
    return typeof value === "string" && /^[a-z0-9_]{1,96}$/.test(value) ? value : null;
  }
  function evidenceInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
  }
  function workerProbeSubmission(reconciliationId, attemptId, fence) {
    if (!worker || !evidenceUuid(reconciliationId) || !evidenceUuid(attemptId) ||
        evidenceInteger(fence, { minimum: 1 }) === null) return null;
    const path = join(context.artifactDir, "logs", "m3-release-worker.log");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024 ||
        (metadata.mode & 0o077) !== 0 || realpathSync(path) !== path) return null;
    const bytes = readFileSync(path);
    if (bytes.length > 1024 * 1024) return null;
    const expectedKeys = ["attempt_id", "fence", "probe_receipt_digests", "reconciliation_id", "schema"];
    const matching = [];
    for (const line of bytes.toString("utf8").split(/\r?\n/)) {
      if (line.length < 2 || line.length > 4096 || line[0] !== "{") continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== expectedKeys.join(",") ||
          value.schema !== "hostlet.release-probe-submission/v1" ||
          value.reconciliation_id !== reconciliationId || value.attempt_id !== attemptId ||
          value.fence !== fence || !Array.isArray(value.probe_receipt_digests) ||
          value.probe_receipt_digests.length > 17 ||
          value.probe_receipt_digests.some((digest) => !validReleaseDigest(digest)) ||
          new Set(value.probe_receipt_digests).size !== value.probe_receipt_digests.length) continue;
      matching.push(value.probe_receipt_digests);
    }
    return matching.length === 1 ? matching[0] : null;
  }

  function safeReleaseReceipt(digest) {
    const root = join(m3.policyClock.stateDir, "evidence", "sha256");
    const path = join(root, digest.slice(7, 9), `${digest.slice(9)}.json`);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 ||
        (metadata.mode & 0o077) !== 0 || realpathSync(path) !== path) return null;
    const bytes = readFileSync(path);
    if (bytes.length > 64 * 1024 || releaseSha256(bytes) !== digest) return null;
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const uuid = (field) => evidenceUuid(value[field]);
    const code = (field) => evidenceCode(value[field]);
    const linked = [];
    const link = (field) => {
      if (validReleaseDigest(value[field])) linked.push(value[field]);
    };
    const base = { digest, schema: value.schema };
    if (value.schema === "hostlet.runtime.executor-receipt/v1") {
      return { summary: { ...base, allocation_id: uuid("allocation_id"),
        artifact_digest: validReleaseDigest(value.artifact_digest) ? value.artifact_digest : null,
        runtime_binary_digest: validReleaseDigest(value.runtime_binary_digest) ? value.runtime_binary_digest : null,
        policy_digest: validReleaseDigest(value.policy_digest) ? value.policy_digest : null,
        capability_digest: validReleaseDigest(value.capability_digest) ? value.capability_digest : null,
        generation: evidenceInteger(value.generation, { minimum: 1 }),
        fence: evidenceInteger(value.fence, { minimum: 1 }),
        operation: evidenceState(value.operation, new Set(["prepare", "start", "inspect", "stop", "cleanup", "reconcile", "validate"])),
        status: evidenceState(value.status, new Set(["prepared", "running", "stopped", "cleaned", "restart_scheduled", "backoff"])),
        result: evidenceState(value.result, new Set(["passed", "failed"])),
        reason_code: code("reason_code"),
        profile: evidenceState(value.profile, new Set(["evidence_gated_owned_fixture", "owned_fixture_evaluation"])),
        platform: evidenceState(value.platform, new Set(["systrap", "kvm"])),
        runsc_status: evidenceState(value.runsc_status, new Set(["created", "running", "stopped"])),
        observed_limits_present: value.observed_limits !== null && typeof value.observed_limits === "object" && !Array.isArray(value.observed_limits),
        health_passing: typeof value.health?.passing === "boolean" ? value.health.passing : null,
        cleanup: value.cleanup && typeof value.cleanup === "object" ? {
          sandbox_absent: typeof value.cleanup.sandbox_absent === "boolean" ? value.cleanup.sandbox_absent : null,
          application_namespace_absent: typeof value.cleanup.application_namespace_absent === "boolean" ? value.cleanup.application_namespace_absent : null,
          gateway_namespace_absent: typeof value.cleanup.gateway_namespace_absent === "boolean" ? value.cleanup.gateway_namespace_absent : null,
          cgroup_absent: typeof value.cleanup.cgroup_absent === "boolean" ? value.cleanup.cgroup_absent : null,
          state_retained: typeof value.cleanup.state_retained === "boolean" ? value.cleanup.state_retained : null,
        } : null }, linked };
    }
    if (value.schema === "hostlet.runtime.probe-receipt/v1" || value.schema === "hostlet.runtime.probe-receipt/v2") {
      for (const field of ["executor_receipt_digest", "application_probe_receipt_digest", "cleanup_receipt_digest"]) link(field);
      return { summary: { ...base, probe_execution_id: uuid("probe_execution_id"),
        reconciliation_id: uuid("reconciliation_id"), attempt_id: uuid("attempt_id"),
        release_fence: evidenceInteger(value.release_fence, { minimum: 1 }),
        release_id: uuid("release_id"), peer_release_id: uuid("peer_release_id"),
        source_allocation_id: uuid("source_allocation_id"),
        source_generation: evidenceInteger(value.source_generation, { minimum: 1 }),
        source_fence: evidenceInteger(value.source_fence, { minimum: 1 }),
        allocation_id: uuid("allocation_id"), generation: evidenceInteger(value.generation, { minimum: 1 }),
        fence: evidenceInteger(value.fence, { minimum: 1 }),
        artifact_digest: validReleaseDigest(value.artifact_digest) ? value.artifact_digest : null,
        database_generation: uuid("database_generation"), migration_id: uuid("migration_id"),
        target: evidenceState(value.target, new Set(["isolated"])), check_kind: code("check_kind"),
        result: evidenceState(value.result, new Set(["passed", "failed"])), reason_code: code("reason_code"),
        observed_at_unix_ms: evidenceInteger(value.observed_at_unix_ms, { minimum: 1 }),
        safe_status_code: evidenceInteger(value.http?.safe_status_code, { minimum: 100, maximum: 599 }),
        assertions_count: Array.isArray(value.assertions) ? Math.min(value.assertions.length, 64) : null,
        assertions_all_passed: Array.isArray(value.assertions) ? value.assertions.every((item) => item?.passed === true) : null,
        linked_digests: linked }, linked };
    }
    if (value.schema === "hostlet.runtime.application-probe-receipt/v1") {
      return { summary: { ...base, probe_execution_id: uuid("probe_execution_id"),
        allocation_id: uuid("allocation_id"), generation: evidenceInteger(value.generation, { minimum: 1 }),
        fence: evidenceInteger(value.fence, { minimum: 1 }),
        artifact_digest: validReleaseDigest(value.artifact_digest) ? value.artifact_digest : null,
        database_generation: uuid("database_generation"), migration_id: uuid("migration_id"),
        check_kind: code("check_kind"), target: evidenceState(value.target, new Set(["isolated"])),
        result: evidenceState(value.result, new Set(["passed", "failed"])), reason_code: code("reason_code"),
        observed_at_unix_ms: evidenceInteger(value.observed_at_unix_ms, { minimum: 1 }),
        write_status_code: evidenceInteger(value.http?.write_status_code, { minimum: 100, maximum: 599 }),
        read_status_code: evidenceInteger(value.http?.read_status_code, { minimum: 100, maximum: 599 }),
        response_digest_valid: validReleaseDigest(value.http?.response_sha256),
        elapsed_ms: evidenceInteger(value.http?.elapsed_ms, { minimum: 1 }),
        assertions_count: Array.isArray(value.assertions) ? Math.min(value.assertions.length, 64) : null,
        assertions_all_passed: Array.isArray(value.assertions) ? value.assertions.every((item) => item?.passed === true) : null }, linked };
    }
    if (value.schema === "hostlet.release-stage-receipt/v1") {
      return { summary: { ...base, release_id: uuid("release_id"),
        result: evidenceState(value.result, new Set(["staged", "failed"])) }, linked };
    }
    return null;
  }

  async function releaseReceiptEvidence(projectId, releaseId, reconciliationId, attemptId, fence, artifactSequence) {
    const empty = { expected_probes: [], submission: { matched: false, digest_count: 0 },
      database_links_available: false, seed_count: 0, entries: [], unavailable_count: 0, truncated: false };
    if (!evidenceUuid(projectId) || !evidenceUuid(releaseId) || !evidenceUuid(reconciliationId)) return empty;
    let observed = null;
    try { observed = await m3.postgres.psqlJson(`m3-release-failure-receipt-links-${artifactSequence}`, `SELECT json_build_object(
      'required',COALESCE((SELECT json_agg(json_build_object(
        'probe_execution_id',probe.value->>'probe_execution_id',
        'check_kind',probe.value->>'check_kind',
        'reconciliation_id',probe.value->>'reconciliation_id',
        'attempt_id',probe.value->>'attempt_id',
        'release_fence',probe.value->'release_fence',
        'release_id',probe.value->>'release_id',
        'peer_release_id',probe.value->>'peer_release_id',
        'source_allocation_id',probe.value->>'source_allocation_id',
        'source_generation',probe.value->'source_generation',
        'source_fence',probe.value->'source_fence',
        'artifact_digest',probe.value->>'artifact_digest',
        'database_generation',probe.value->>'database_generation',
        'migration_id',probe.value->>'migration_id',
        'target',probe.value->>'target',
        'executor_receipt_digest',probe.value->>'executor_receipt_digest',
        'executor_template_receipt_digest',probe.value->>'executor_template_receipt_digest') ORDER BY probe.ordinality)
        FROM release_reconciliations r, LATERAL jsonb_array_elements(COALESCE(r.requirements->'required_probes','[]'::jsonb))
          WITH ORDINALITY probe(value,ordinality)
        WHERE r.id='${reconciliationId}'::uuid AND r.project_id='${projectId}'::uuid
          AND r.release_id='${releaseId}'::uuid),'[]'::json),
      'result',(SELECT json_build_object(
        'probe_receipt_digests',r.result->'probe_receipt_digests',
        'isolated_probe_receipt_digests',r.result->'isolated_probe_receipt_digests',
        'migration_stage_receipt_digest',r.result->>'migration_stage_receipt_digest',
        'isolated_apply_receipt_digest',r.result->>'isolated_apply_receipt_digest')
        FROM release_reconciliations r WHERE r.id='${reconciliationId}'::uuid
          AND r.project_id='${projectId}'::uuid AND r.release_id='${releaseId}'::uuid));`);
      empty.database_links_available = true;
    } catch {
      // Exact worker submission can still seed receipt evidence when PostgreSQL is unavailable.
    }
    const seeds = [];
    let submitted = null;
    try { submitted = workerProbeSubmission(reconciliationId, attemptId, fence); } catch { submitted = null; }
    if (submitted) {
      empty.submission = { matched: true, digest_count: submitted.length };
      seeds.push(...submitted);
    }
    for (const probe of Array.isArray(observed?.required) ? observed.required.slice(0, 24) : []) {
      empty.expected_probes.push({ probe_execution_id: evidenceUuid(probe?.probe_execution_id),
        reconciliation_id: evidenceUuid(probe?.reconciliation_id), attempt_id: evidenceUuid(probe?.attempt_id),
        release_fence: evidenceInteger(probe?.release_fence, { minimum: 1 }),
        release_id: evidenceUuid(probe?.release_id), peer_release_id: evidenceUuid(probe?.peer_release_id),
        source_allocation_id: evidenceUuid(probe?.source_allocation_id),
        source_generation: evidenceInteger(probe?.source_generation, { minimum: 1 }),
        source_fence: evidenceInteger(probe?.source_fence, { minimum: 1 }),
        artifact_digest: validReleaseDigest(probe?.artifact_digest) ? probe.artifact_digest : null,
        database_generation: evidenceUuid(probe?.database_generation), migration_id: evidenceUuid(probe?.migration_id),
        target: evidenceState(probe?.target, new Set(["isolated"])), check_kind: evidenceCode(probe?.check_kind) });
      for (const field of ["executor_receipt_digest", "executor_template_receipt_digest"]) {
        if (validReleaseDigest(probe?.[field])) seeds.push(probe[field]);
      }
    }
    for (const field of ["probe_receipt_digests", "isolated_probe_receipt_digests"]) {
      for (const digest of Array.isArray(observed?.result?.[field]) ? observed.result[field].slice(0, 24) : []) {
        if (validReleaseDigest(digest)) seeds.push(digest);
      }
    }
    for (const field of ["migration_stage_receipt_digest", "isolated_apply_receipt_digest"]) {
      if (validReleaseDigest(observed?.result?.[field])) seeds.push(observed.result[field]);
    }
    const queue = [...new Set(seeds)].slice(0, 48);
    empty.seed_count = queue.length;
    empty.truncated = seeds.length > 48 || (Array.isArray(observed?.required) && observed.required.length > 24) ||
      ["probe_receipt_digests", "isolated_probe_receipt_digests"].some((field) =>
        Array.isArray(observed?.result?.[field]) && observed.result[field].length > 24);
    const visited = new Set();
    while (queue.length && visited.size < 96) {
      const digest = queue.shift();
      if (visited.has(digest)) continue;
      visited.add(digest);
      let receipt;
      try { receipt = safeReleaseReceipt(digest); } catch { receipt = null; }
      if (!receipt) { empty.unavailable_count += 1; continue; }
      empty.entries.push(receipt.summary);
      for (const linked of receipt.linked) if (!visited.has(linked) && !queue.includes(linked)) queue.push(linked);
    }
    if (queue.length) empty.truncated = true;
    for (const probe of empty.expected_probes) {
      const actual = probe.probe_execution_id === null ? null : empty.entries.find((entry) =>
        entry.schema === "hostlet.runtime.probe-receipt/v2" &&
        entry.probe_execution_id === probe.probe_execution_id);
      probe.receipt_linked = Boolean(actual);
      probe.mismatched_fields = actual ? ["reconciliation_id", "attempt_id", "release_fence", "release_id",
        "peer_release_id", "source_allocation_id", "source_generation", "source_fence", "artifact_digest",
        "database_generation", "migration_id", "target", "check_kind"].filter((field) =>
        probe[field] !== actual[field]) : [];
    }
    return empty;
  }

  function workerProcessEvidence() {
    const child = worker?.process?.child;
    if (!child) return { present: false, running: false, exit_code: null, signal: null };
    const exitCode = Number.isSafeInteger(child.exitCode) ? child.exitCode : null;
    const signal = typeof child.signalCode === "string" ? child.signalCode.slice(0, 32) : null;
    return { present: true, running: exitCode === null && signal === null, exit_code: exitCode, signal };
  }
  function assertOwnedReleaseWorkerRunning() {
    const child = worker?.process?.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new ReleaseWorkerExited(`owned release worker ${worker.workerId} exited before the expected durable release state ` +
        `(exit code ${child.exitCode ?? "none"}, signal ${child.signalCode ?? "none"})`);
    }
  }
  async function writeReleaseFailureEvidence({ projectId, releaseId, reconciliationId, waitKind }) {
    const artifactSequence = ++failureEvidenceSequence;
    const artifactReleaseId = evidenceUuid(releaseId);
    const artifactReconciliationId = evidenceUuid(reconciliationId);
    const evidence = {
      schema: "hostlet.release-failure-evidence/v1",
      wait_kind: waitKind,
      release: { id: artifactReleaseId, state: null, failure_code: null },
      reconciliation: { id: artifactReconciliationId, state: null, terminal_code: null,
        attempt_count: null, current_attempt_id: null, current_fence: null },
      attempts: { count: 0, entries: [] },
      worker_process: workerProcessEvidence(),
      current_route: { release_id: null, generation: null },
      receipts: { expected_probes: [], submission: { matched: false, digest_count: 0 },
        database_links_available: false, seed_count: 0, entries: [], unavailable_count: 0, truncated: false },
    };
    try {
      if (evidenceUuid(projectId) && artifactReleaseId && artifactReconciliationId) {
        const sqlUuid = (value) => `'${value}'::uuid`;
        const observed = await m3.postgres.psqlJson(`m3-release-failure-evidence-${artifactSequence}`, `SELECT json_build_object(
          'release',(SELECT json_build_object('id',release.id::text,'state',release.state,'failure_code',release.failure_code)
            FROM application_releases release WHERE release.id=${sqlUuid(releaseId)} AND release.project_id=${sqlUuid(projectId)}),
          'reconciliation',(SELECT json_build_object('id',reconciliation.id::text,'state',reconciliation.state,
            'terminal_code',reconciliation.terminal_code,'attempt_count',reconciliation.attempt_count,
            'current_attempt_id',reconciliation.current_attempt_id::text,'current_fence',reconciliation.current_fence)
            FROM release_reconciliations reconciliation
            WHERE reconciliation.id=${sqlUuid(reconciliationId)} AND reconciliation.project_id=${sqlUuid(projectId)}),
          'attempts',COALESCE((SELECT json_agg(json_build_object('id',attempt.id::text,'attempt_number',attempt.attempt_number,
            'state',attempt.state,'fence',attempt.fence,'terminal_code',attempt.terminal_code)
            ORDER BY attempt.attempt_number,attempt.id) FROM (
              SELECT id,attempt_number,state,fence,terminal_code FROM release_reconciliation_attempts
              WHERE reconciliation_id=${sqlUuid(reconciliationId)} AND project_id=${sqlUuid(projectId)}
              ORDER BY attempt_number,id LIMIT 6
            ) attempt),'[]'::json),
          'attempt_count',(SELECT count(*)::int FROM release_reconciliation_attempts
            WHERE reconciliation_id=${sqlUuid(reconciliationId)} AND project_id=${sqlUuid(projectId)}),
          'current_route',(SELECT json_build_object('release_id',route.release_id::text,'generation',route.generation)
            FROM project_release_routes route WHERE route.project_id=${sqlUuid(projectId)}));`);
        const release = observed?.release;
        const reconciliation = observed?.reconciliation;
        evidence.release.state = evidenceState(release?.state, RELEASE_STATES);
        evidence.release.failure_code = evidenceCode(release?.failure_code);
        evidence.reconciliation.state = evidenceState(reconciliation?.state, RECONCILIATION_STATES);
        evidence.reconciliation.terminal_code = evidenceCode(reconciliation?.terminal_code);
        evidence.reconciliation.attempt_count = evidenceInteger(reconciliation?.attempt_count, { minimum: 0, maximum: 6 });
        evidence.reconciliation.current_attempt_id = evidenceUuid(reconciliation?.current_attempt_id);
        evidence.reconciliation.current_fence = evidenceInteger(reconciliation?.current_fence);
        const attempts = Array.isArray(observed?.attempts) ? observed.attempts.slice(0, 6) : [];
        evidence.attempts = {
          count: evidenceInteger(observed?.attempt_count, { minimum: 0, maximum: 6 }) ?? attempts.length,
          entries: attempts.map((attempt) => ({
            id: evidenceUuid(attempt?.id), attempt_number: evidenceInteger(attempt?.attempt_number, { minimum: 1, maximum: 6 }),
            state: evidenceState(attempt?.state, ATTEMPT_STATES), fence: evidenceInteger(attempt?.fence, { minimum: 1 }),
            terminal_code: evidenceCode(attempt?.terminal_code),
          })),
        };
        evidence.current_route = {
          release_id: evidenceUuid(observed?.current_route?.release_id),
          generation: evidenceInteger(observed?.current_route?.generation, { minimum: 1 }),
        };
      }
    } catch {
      // Preserve the original wait failure. The bounded skeleton remains safe if evidence reads fail.
    }
    try {
      evidence.receipts = await releaseReceiptEvidence(projectId, releaseId, reconciliationId,
        evidence.reconciliation.current_attempt_id, evidence.reconciliation.current_fence, artifactSequence);
    } catch {
      // Keep the original wait failure and metadata if exact receipt traversal is unavailable.
    }
    evidence.worker_process = workerProcessEvidence();
    try {
      const releasePart = artifactReleaseId ?? "unknown";
      const path = join(context.artifactDir, `m3-release-failure-${String(artifactSequence).padStart(4, "0")}-${releasePart}.json`);
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Preserve the original wait failure if the artifact itself cannot be written.
    }
  }

  function nextReleaseNetworkIndex() {
    const preferred = releaseNetworkFirst + (releaseLaunchSequence % releaseNetworkSpan);
    releaseLaunchSequence += 1;
    return preferred;
  }

  async function buildRecord(key, rebuild) {
    const existing = buildStage.jobs.get(key);
    // Populated release candidates must reuse the fullstack project and its
    // tenant database. Rebuild a successful fixture only when its earlier
    // record belongs to a different project.
    const reusePopulatedProject = key === "incompatible_api" || key === "incompatible_migration";
    const populatedProjectId = buildStage.jobs.get("fullstack_v1")?.detail?.build?.project_id;
    const existingProjectId = existing?.detail?.build?.project_id;
    const needsPopulatedProject = reusePopulatedProject && populatedProjectId && existingProjectId !== populatedProjectId;
    if (rebuild || (reusePopulatedProject && (existing?.detail?.build?.state !== "succeeded" || needsPopulatedProject))) {
      const existingPrepared = buildStage.jobs.get("fullstack_v1")?.prepared;
      return buildStage.buildFixture(key, {
        existingPrepared,
        force: key === "incompatible_api",
        expectedState: "succeeded",
        expectedCode: "build_succeeded",
      });
    }
    const value = existing;
    return value ?? buildStage.buildFixture(key);
  }
  function databaseFor(projectId) {
    const value = databases.find((item) => item.project.projectId === projectId);
    if (!value?.record?.id || !value?.peer) throw new Error("release project has no live tenant database");
    return value;
  }
  async function ensureProcesses(projectId, startWorker = true) {
    if (!gateway) gateway = await startReleaseGateway(m3, { projectId, hostname: options.hostname,
      certificate: options.certificate, privateKey: options.privateKey, port: options.gatewayPort ?? await context.allocatePort(), runtimeRoot: runtime.stateRoot });
    if (startWorker && !worker) worker = startReleaseWorker(m3, { artifactRoot: join(m3.policyClock.stateDir, "private-cas"), runtimeRoot: runtime.stateRoot });
  }
  async function history(projectId) {
    const response = await m3.ownerHTTP(`/v1/projects/${projectId}/releases`);
    if (response.status !== 200) throw new Error(`release history returned HTTP ${response.status}`);
    return response.payload;
  }
  async function awaitRelease(projectId, releaseId, expected, reconciliationId = null) {
    try {
      return await eventually(`release ${releaseId}`, async () => {
        const value = await history(projectId);
        const release = value.releases.find(({ id }) => id === releaseId);
        if (release && expected.includes(release.state)) return { release, history: value };
        if (release && ["failed", "healthy", "retired"].includes(release.state)) {
          throw new TerminalReleaseWaitError(`release reached unexpected ${release.state}: ${release.failure_code ?? "no code"}`);
        }
        assertOwnedReleaseWorkerRunning();
        return null;
      }, { timeoutMs: options.promotionTimeoutMs ?? 120_000 });
    } catch (error) {
      await writeReleaseFailureEvidence({ projectId, releaseId, reconciliationId, waitKind: "await_release" });
      throw error;
    }
  }
  async function awaitReleaseAndDatabase(staged, expected) {
    if (!staged.migration.id) return awaitRelease(staged.projectId, staged.releaseId, expected, staged.reconciliationId);
    try {
      const terminal = async (value) => {
        const release = value.releases.find(({ id }) => id === staged.releaseId);
        if (release && expected.includes(release.state)) {
          if (release.state === "healthy" && !migrationFences.has(staged.migration.id)) {
            throw new TerminalReleaseWaitError("migration live apply reached a healthy release state before its exact stale lease was fenced");
          }
          const stale = migrationFences.get(staged.migration.id);
          if (release.state === "healthy" && stale && stale.rejected !== true) {
            const completion = await m3.roleInternal("database", `/internal/v1/tenant-database-operations/${stale.operationId}/complete`, {
              method: "POST", body: { worker_id: "m3-stale-migration-worker", attempt_id: stale.attempt.id,
                fence: stale.attempt.fence, outcome: { state: "failed", code: "stale_migration_attempt", proof: {} } },
            });
            if (completion.status !== 409) throw new TerminalReleaseWaitError("stale live-migration completion was not fenced");
            stale.rejected = true;
          }
          return { release, history: value };
        }
        if (release && ["failed", "healthy", "retired"].includes(release.state)) {
          throw new TerminalReleaseWaitError(`migration release reached unexpected ${release.state}: ${release.failure_code ?? "no code"}`);
        }
        return null;
      };
      return await eventually(`migration release ${staged.releaseId}`, async () => {
        const beforeDrain = await terminal(await history(staged.projectId));
        if (beforeDrain) return beforeDrain;
        assertOwnedReleaseWorkerRunning();
        if (!migrationFences.has(staged.migration.id)) {
          // Keep the live apply queued while the trial, backup, and any other
          // database work drains. This makes the stale-lease exercise a
          // deterministic handoff instead of a race with the normal worker.
          await dataStage.drainWorker(`release-pre-live-migration-${staged.migration.id}`, {
            kinds: DATABASE_WORKER_KINDS_WITHOUT_LIVE_APPLY,
          });
          const queued = await m3.postgres.psqlJson("m3-release-live-migration-queued", `SELECT COALESCE((SELECT json_build_object(
            'id',id::text,'state',state) FROM tenant_database_operations
            WHERE kind='migration_live_apply' AND operation_key='${staged.migration.id}' AND state='queued'),'null'::json);`);
          if (queued?.id) {
            const stale = await m3.roleInternal("database", "/internal/v1/tenant-database-operations/lease", {
              method: "POST", body: { worker_id: "m3-stale-migration-worker", kinds: ["migration_live_apply"] },
            });
            if (stale.status !== 200 || stale.payload.operation.id !== queued.id) throw new Error("could not acquire exact stale live-migration lease");
            const expiry = Date.parse(stale.payload.attempt.lease_expires_at);
            if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("stale live-migration lease omitted a future real expiry");
            await context.delay(Math.max(0, expiry - Date.now()) + 250);
            migrationFences.set(staged.migration.id, { operationId: queued.id, attempt: stale.payload.attempt });
          }
        }
        // Once the exact stale attempt has expired, let the real worker process
        // the queued live apply before checking release history. The release
        // cannot become terminal until this operation completes.
        if (migrationFences.has(staged.migration.id)) {
          await dataStage.drainWorker(`release-live-migration-${staged.migration.id}`);
        }
        const afterDrain = await terminal(await history(staged.projectId));
        if (afterDrain) return afterDrain;
        assertOwnedReleaseWorkerRunning();
        return null;
      }, { timeoutMs: options.promotionTimeoutMs ?? 180_000, intervalMs: 250 });
    } catch (error) {
      await writeReleaseFailureEvidence({ projectId: staged.projectId, releaseId: staged.releaseId,
        reconciliationId: staged.reconciliationId, waitKind: "await_release_and_database" });
      throw error;
    }
  }
  async function awaitFailedMigrationRelease(staged) {
    if (!RELEASE_UUID.test(staged.migration?.id ?? "")) throw new Error("failed migration release requires an exact migration identity");
    const expectedFailure = Object.freeze({ migrationId: staged.migration.id, kind: "migration_trial", code: "migration_sql_not_admitted" });
    return eventually(`failed migration release ${staged.releaseId}`, async () => {
      const operation = await m3.postgres.psqlJson("m3-release-expected-failure-operation", `SELECT COALESCE((SELECT json_build_object(
        'id',id::text,'kind',kind,'state',state,'operation_key',operation_key,'code',result->>'code')
        FROM tenant_database_operations WHERE kind='migration_trial' AND operation_key='${expectedFailure.migrationId}'
        ORDER BY created_at DESC,id DESC LIMIT 1),'null'::json);`);
      if (operation?.id && ["queued", "retriable"].includes(operation.state)) {
        await dataStage.drainWorker(`release-migration-trial-${expectedFailure.migrationId}`, { expectedFailure });
      }
      const value = await history(staged.projectId);
      const release = value.releases.find(({ id }) => id === staged.releaseId);
      if (!release) return null;
      if (release.state === "failed") return { release, history: value };
      if (["healthy", "retired"].includes(release.state)) {
        throw new TerminalReleaseWaitError(`incompatible migration release reached unexpected ${release.state}: ${release.failure_code ?? "no code"}`);
      }
      return null;
    }, { timeoutMs: options.promotionTimeoutMs ?? 180_000, intervalMs: 250 });
  }
  async function existingMigrationEvidence({ projectId, databaseId, databaseGeneration, migrationRevision, migrationDigest, appliedOnly = false }) {
    const accountId = m3.state.owner.record.id;
    if (![accountId, projectId, databaseId, databaseGeneration].every((value) => RELEASE_UUID.test(value ?? "")) ||
        (migrationDigest !== null && !validReleaseDigest(migrationDigest)) || typeof migrationRevision !== "string" || migrationRevision.length === 0) {
      throw new Error("existing migration evidence requires exact owner, project, database generation, revision and digest identities");
    }
    const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const digestClause = migrationDigest === null ? "" : ` AND m.migration_digest=${sqlString(migrationDigest)}`;
    const stateClause = appliedOnly ? " AND m.state='applied'" : "";
    return m3.postgres.psqlJson("m3-release-existing-migration-evidence", `SELECT COALESCE((SELECT json_build_object(
      'matching_row_count',(count(*) OVER ())::int,
      'migration_id',m.id::text,'account_id',m.account_id::text,'project_id',m.project_id::text,
      'tenant_database_id',m.tenant_database_id::text,'database_generation',m.database_generation::text,
      'migration_revision',m.migration_revision,'migration_digest',m.migration_digest,'state',m.state,
      'source_data_generation',m.source_data_generation,'database_source_data_generation',d.source_data_generation,
      'current_schema_revision',m.current_schema_revision,'candidate_schema_revision',m.candidate_schema_revision,
      'pre_migration_archive_id',m.pre_migration_archive_id::text,
      'validation_operation_id',m.validation_operation_id::text,'once_effect_id',m.once_effect_id::text,
      'applied_at',m.applied_at,
      'trial_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_trial' AND o.operation_key=m.id::text),
      'trial_succeeded_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_trial' AND o.operation_key=m.id::text AND o.state='succeeded'),
      'trial_attempt_succeeded_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a
        JOIN tenant_database_operations o ON o.id=a.operation_id
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_trial' AND o.operation_key=m.id::text AND a.state='succeeded'),
      'trial_operation_id',(SELECT o.id::text FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_trial' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1),
      'trial_operation_state',(SELECT o.state FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_trial' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1),
      'trial_operation_code',(SELECT o.result->>'code' FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_trial' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1),
      'live_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text),
      'live_succeeded_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text AND o.state='succeeded'),
      'live_attempt_succeeded_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a
        JOIN tenant_database_operations o ON o.id=a.operation_id
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text AND a.state='succeeded'),
      'live_operation_id',(SELECT o.id::text FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1),
      'live_operation_state',(SELECT o.state FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1),
      'live_operation_code',(SELECT o.result->>'code' FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1),
      'live_operation_result',(SELECT o.result FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1),
      'once_effect_matches',(m.once_effect_id IS NOT NULL AND m.once_effect_id=(SELECT o.id FROM tenant_database_operations o
        WHERE o.account_id=m.account_id AND o.project_id=m.project_id AND o.tenant_database_id=m.tenant_database_id
          AND o.database_generation=m.database_generation AND o.kind='migration_live_apply' AND o.operation_key=m.id::text
        ORDER BY o.created_at,o.id LIMIT 1)))
      FROM tenant_database_migrations m JOIN tenant_databases d
        ON d.account_id=m.account_id AND d.project_id=m.project_id AND d.id=m.tenant_database_id AND d.generation=m.database_generation
      WHERE m.account_id=${sqlString(accountId)}::uuid AND m.project_id=${sqlString(projectId)}::uuid
        AND m.tenant_database_id=${sqlString(databaseId)}::uuid AND m.database_generation=${sqlString(databaseGeneration)}::uuid
        AND m.migration_revision=${sqlString(migrationRevision)}${digestClause}${stateClause}
      ORDER BY m.created_at,m.id LIMIT 1),'null'::json);`);
  }

  function requireExistingMigrationEvidence(value, { projectId, databaseId, databaseGeneration, migrationRevision, migrationDigest, label }) {
    const liveProof = value?.live_operation_result?.proof;
    const validCounts = [value?.trial_operation_count, value?.trial_succeeded_count,
      value?.trial_attempt_succeeded_count, value?.live_operation_count,
      value?.live_succeeded_count, value?.live_attempt_succeeded_count].every(Number.isSafeInteger);
    const passed = value && value.account_id === m3.state.owner.record.id && value.project_id === projectId &&
      value.tenant_database_id === databaseId && value.database_generation === databaseGeneration &&
      value.matching_row_count === 1 &&
      value.migration_revision === migrationRevision && value.migration_digest === migrationDigest &&
      value.state === "applied" && value.migration_revision === "002_additive_client_compatibility" &&
      value.current_schema_revision === "1" && value.candidate_schema_revision === "2" &&
      RELEASE_UUID.test(value.migration_id ?? "") && RELEASE_UUID.test(value.pre_migration_archive_id ?? "") &&
      RELEASE_UUID.test(value.once_effect_id ?? "") && RELEASE_UUID.test(value.validation_operation_id ?? "") &&
      typeof value.applied_at === "string" &&
      Number.isSafeInteger(value.source_data_generation) && value.source_data_generation > 0 &&
      Number.isSafeInteger(value.database_source_data_generation) &&
      value.database_source_data_generation === value.source_data_generation + 1 &&
      value.trial_operation_count === 1 && value.trial_succeeded_count === 1 &&
      value.trial_attempt_succeeded_count === 1 && value.trial_operation_state === "succeeded" &&
      value.trial_operation_id === value.validation_operation_id && value.trial_operation_code === "migration_trial_prepared" &&
      value.live_operation_count === 1 && value.live_succeeded_count === 1 &&
      value.live_attempt_succeeded_count === 1 && value.live_operation_state === "succeeded" &&
      value.live_operation_id === value.once_effect_id && value.live_operation_code === "migration_live_applied" &&
      value.once_effect_matches === true && liveProof?.migration_id === value.migration_id &&
      liveProof?.migration_file_digest === value.migration_digest &&
      liveProof?.schema_revision === value.candidate_schema_revision &&
      liveProof?.source_data_generation_before === value.source_data_generation &&
      liveProof?.source_data_generation_after === value.source_data_generation + 1 &&
      ["applied", "already_applied"].includes(liveProof?.application_mode) && typeof liveProof?.applied_at === "string" &&
      validReleaseDigest(liveProof?.migration_apply_receipt_digest) && validCounts;
    if (!passed) throw new Error(`${label} did not find one exact applied migration with one successful trial and live apply`);
    return Object.freeze(value);
  }

  async function prepareMigration({ key, record, database, projectId, deploymentId, rebuild = false }) {
    const before = await history(projectId);
    const empty = (expectedRetainedReleaseIds = [], expectedRetainedBinaryDigests = [], existingSchema = null) => Object.freeze({
      id: null, revision: null, digest: null, artifactPath: null,
      backupVerified: false, backupArchiveDigest: null, backupPlaintextDigest: null,
      backupEncryptedDigest: null, preMigrationArchiveId: null, trialReceiptDigest: null,
      liveApplyReceiptDigest: null, applyCount: 0, trialOperationCount: 0,
      liveOperationCount: 0, expectedRetainedReleaseIds, expectedRetainedBinaryDigests,
      currentBinaryCompatible: true, retainedBinariesCompatible: true,
      retainedBinaryReceiptDigests: [], populatedTrialPassed: false,
      existingSchema, existingSchemaEvidence: existingSchema ? Object.freeze({ before: existingSchema, after: null, unchanged: false }) : null,
      existingSchemaUnchanged: false, existingSchemaMigrationId: existingSchema?.migration_id ?? null,
      existingSchemaTrialOperationCount: existingSchema?.trial_operation_count ?? null,
      existingSchemaLiveOperationCount: existingSchema?.live_operation_count ?? null,
      existingSchemaDataGenerationBefore: existingSchema?.database_source_data_generation ?? null,
      existingSchemaDataGenerationAfter: null,
    });
    if (!before.current_route) {
      return empty();
    }
    const noDdlRebuild = rebuild && key === "fullstack_v1";
    if (!new Set(["fullstack_v2", "incompatible_migration"]).has(key) && !noDdlRebuild) {
      return empty();
    }
    const expectedRetained = before.releases
      .filter((release) => release.id !== before.current_route.release_id &&
        release.state === "healthy" && release.promoted_at && validReleaseDigest(release.backend_digest))
      .slice(0, 2);
    const current = before.releases.find((release) => release.id === before.current_route.release_id);
    const expectedRetainedReleaseIds = [current, ...expectedRetained]
      .filter((release) => release?.id && validReleaseDigest(release.backend_digest))
      .map((release) => release.id);
    const expectedRetainedBinaryDigests = [current, ...expectedRetained]
      .filter((release) => validReleaseDigest(release?.backend_digest))
      .map((release) => release.backend_digest);
    if (!current || !RELEASE_UUID.test(current.id ?? "") || expectedRetainedReleaseIds.length === 0 ||
        expectedRetainedReleaseIds.length !== expectedRetainedBinaryDigests.length ||
        new Set(expectedRetainedReleaseIds).size !== expectedRetainedReleaseIds.length) {
      throw new Error("populated release migration requires an exact current and retained binary set");
    }
    const incompatibleMigration = key === "incompatible_migration";
    const migrationRevision = incompatibleMigration ? "003_destructive" : "002_additive_client_compatibility";
    if (noDdlRebuild) {
      const existing = await existingMigrationEvidence({ projectId, databaseId: database.record.id,
        databaseGeneration: database.record.generation, migrationRevision, migrationDigest: null, appliedOnly: true });
      if (!existing) throw new Error("v1 rebuild requires one exact applied 002_additive_client_compatibility migration");
      const baseline = requireExistingMigrationEvidence(existing, { projectId, databaseId: database.record.id,
        databaseGeneration: database.record.generation, migrationRevision, migrationDigest: existing.migration_digest,
        label: "v1 rebuild migration evidence" });
      return empty(expectedRetainedReleaseIds, expectedRetainedBinaryDigests, baseline);
    }
    const artifactPath = incompatibleMigration
      ? "dist/migrations/003_destructive.sql"
      : "dist/migrations/002_additive_client_compatibility.sql";
    const application = applicationOutput(record);
    const migrationBytes = readFileSync(join(application.outputRoot, artifactPath));
    const digest = releaseSha256(migrationBytes);
    const body = { build_job_id: record.detail.build.id, tenant_database_id: database.record.id,
      database_generation: database.record.generation,
      migration_revision: migrationRevision,
      migration_digest: digest, migration_artifact_path: artifactPath,
      current_schema_revision: incompatibleMigration ? "2" : "1",
      candidate_schema_revision: incompatibleMigration ? "3" : "2" };
    if (rebuild && !incompatibleMigration) {
      const existing = await existingMigrationEvidence({ projectId, databaseId: database.record.id,
        databaseGeneration: database.record.generation, migrationRevision: body.migration_revision, migrationDigest: digest });
      if (existing) {
        const baseline = requireExistingMigrationEvidence(existing, { projectId, databaseId: database.record.id,
          databaseGeneration: database.record.generation, migrationRevision: body.migration_revision,
          migrationDigest: digest, label: "rebuild migration evidence" });
        return empty(expectedRetainedReleaseIds, expectedRetainedBinaryDigests, baseline);
      }
    }
    const endpoint = `/v1/projects/${projectId}/deployments/${deploymentId}/migration-trial`;
    let response = await m3.ownerHTTP(endpoint, { method: "POST",
      headers: { "Idempotency-Key": `m3-migration-backup-${++sequence}` }, body });
    const queuedArchiveId = response.status === 202 ? evidenceUuid(response.payload?.archive_id) : null;
    if (response.status === 202) {
      await dataStage.drainWorker("release-pre-migration-backup");
      response = await m3.ownerHTTP(endpoint, { method: "POST",
        headers: { "Idempotency-Key": `m3-migration-trial-${++sequence}` }, body });
    }
    if (response.status !== 201 || response.payload?.phase !== "migration_planned" || !response.payload?.migration_id) {
      const diagnostic = { project_id: evidenceUuid(projectId), deployment_id: evidenceUuid(deploymentId),
        archive_id: queuedArchiveId, error_code: evidenceCode(response.payload?.error?.code) };
      throw new Error(`migration did not become planned after its fresh backup: HTTP ${response.status}; ${JSON.stringify(diagnostic)}`);
    }
    const evidence = await m3.postgres.psqlJson("m3-release-migration-plan", `SELECT json_build_object(
      'migration_id',m.id::text,'state',m.state,'archive_id',m.pre_migration_archive_id::text,
      'archive_verified',a.verified_at IS NOT NULL,'archive_state',a.state,'archive_kind',a.kind,
      'archive_plaintext_digest',a.plaintext_sha256,'archive_encrypted_digest',a.encrypted_sha256,
      'archive_source_generation',a.source_data_generation,'archive_snapshot_at',a.snapshot_at,
      'archive_expires_at',a.expires_at,'migration_digest',m.migration_digest,
      'backup_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='backup_pre_migration' AND o.spec->>'archive_id'=a.id::text AND o.state='succeeded'),
      'backup_attempt_succeeded_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a2
        JOIN tenant_database_operations o2 ON o2.id=a2.operation_id
        WHERE o2.kind='backup_pre_migration' AND o2.spec->>'archive_id'=a.id::text AND a2.state='succeeded'),
      'backup_operation',(SELECT o.result FROM tenant_database_operations o
        WHERE o.kind='backup_pre_migration' AND o.spec->>'archive_id'=a.id::text AND o.state='succeeded' ORDER BY o.updated_at DESC LIMIT 1),
      'trial_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='migration_trial' AND o.operation_key=m.id::text))
      FROM tenant_database_migrations m JOIN tenant_database_archives a ON a.id=m.pre_migration_archive_id
      WHERE m.id='${response.payload.migration_id}'::uuid;`);
    if (evidence?.state !== "planned" || evidence.archive_verified !== true || evidence.archive_state !== "usable" ||
        evidence.archive_kind !== "pre_migration" || !validReleaseDigest(`sha256:${evidence.archive_plaintext_digest ?? ""}`) ||
        !validReleaseDigest(`sha256:${evidence.archive_encrypted_digest ?? ""}`) || evidence.migration_digest !== digest ||
        evidence.backup_operation_count !== 1 || evidence.backup_attempt_succeeded_count !== 1 ||
        evidence.backup_operation?.proof?.archive_id !== evidence.archive_id ||
        evidence.backup_operation?.proof?.plaintext_sha256 !== evidence.archive_plaintext_digest ||
        evidence.backup_operation?.proof?.encrypted_sha256 !== evidence.archive_encrypted_digest ||
        evidence.trial_operation_count !== 0 || evidence.archive_id !== response.payload.archive_id) {
      throw new Error("control did not bind the exact planned migration to its verified fresh backup");
    }
    return Object.freeze({ id: response.payload.migration_id, revision: body.migration_revision, digest,
      artifactPath, backupVerified: true, backupArchiveDigest: `sha256:${evidence.archive_encrypted_digest}`,
      backupPlaintextDigest: `sha256:${evidence.archive_plaintext_digest}`,
      backupEncryptedDigest: `sha256:${evidence.archive_encrypted_digest}`,
      preMigrationArchiveId: evidence.archive_id, trialReceiptDigest: null, liveApplyReceiptDigest: null,
      applyCount: 0, trialOperationCount: 0, liveOperationCount: 0,
      expectedRetainedReleaseIds, expectedRetainedBinaryDigests,
      currentBinaryCompatible: false, retainedBinariesCompatible: false,
      retainedBinaryReceiptDigests: [], populatedTrialPassed: false });
  }
  async function stage(key, { rebuild = false, startWorker = true, beforeStage = null } = {}) {
    if (beforeStage !== null && typeof beforeStage !== "function") {
      throw new Error("release stage barrier must be a function when provided");
    }
    const record = await buildRecord(key, rebuild);
    const projectId = record.detail.build.project_id;
    const deploymentId = record.detail.build.deployment_id;
    if (key === "incompatible_api" || key === "incompatible_migration") {
      const baselineProjectId = buildStage.jobs.get("fullstack_v1")?.detail?.build?.project_id;
      if (!RELEASE_UUID.test(baselineProjectId ?? "") || projectId !== baselineProjectId) {
        throw new Error(`${key} release candidate must be a succeeded build for the populated fullstack project`);
      }
    }
    const database = databaseFor(projectId);
    await ensureProcesses(projectId, startWorker);
    const application = applicationOutput(record);
    const exactEvaluation = await runtime.evaluateRelease(application, database.peer, m3.state.runtimeEvaluationInputs?.nodeBaseRoots);
    if (!exactEvaluation?.id) throw new Error("runtime omitted exact release capability evaluation");
    ++sequence;
    const launched = await launchRelease({ buildOutput: application, evaluationId: exactEvaluation.id,
      databasePeer: database.peer, index: nextReleaseNetworkIndex() });
    if (!launched?.allocation?.id || !launched?.entry?.relay) throw new Error("runtime release launch omitted allocation or protected relay");
    live.set(launched.allocation.id, launched);
    const migration = await prepareMigration({ key, record, database, allocation: launched.allocation,
      projectId, deploymentId, rebuild, currentReleases: (await history(projectId)).releases });
    if (beforeStage) {
      await beforeStage({ key, record, database, launched, migration, projectId, deploymentId });
    }
    const response = await m3.ownerHTTP(`/v1/projects/${projectId}/deployments/${deploymentId}/releases`, {
      method: "POST", headers: { "Idempotency-Key": `m3-release-${key}-${sequence}` },
      body: { build_job_id: record.detail.build.id, runtime_allocation_id: launched.allocation.id,
        tenant_database_id: database.record.id, database_generation: database.record.generation,
        migration_revision: migration.revision, migration_digest: migration.digest,
        migration_artifact_path: migration.artifactPath,
        managed_demo_url: gateway.origin },
    });
    if (![200, 201].includes(response.status)) throw new Error(`release stage returned HTTP ${response.status}`);
    releaseRuntimes.set(response.payload.release.id, launched);
    return { key, record, database, launched, migration, projectId, deploymentId,
      releaseId: response.payload.release.id, reconciliationId: response.payload.reconciliation.id };
  }
  async function migrationEvidence(migration) {
    if (!migration.id) {
      if (!migration.existingSchema) return migration;
      const baseline = migration.existingSchema;
      const observed = await existingMigrationEvidence({ projectId: baseline.project_id,
        databaseId: baseline.tenant_database_id, databaseGeneration: baseline.database_generation,
        migrationRevision: baseline.migration_revision, migrationDigest: baseline.migration_digest });
      const after = requireExistingMigrationEvidence(observed, { projectId: baseline.project_id,
        databaseId: baseline.tenant_database_id, databaseGeneration: baseline.database_generation,
        migrationRevision: baseline.migration_revision, migrationDigest: baseline.migration_digest,
        label: "rebuilt release migration evidence" });
      const unchangedFields = [
        "migration_id", "account_id", "project_id", "tenant_database_id", "database_generation",
        "migration_revision", "migration_digest", "state", "source_data_generation",
        "database_source_data_generation", "validation_operation_id", "once_effect_id",
        "trial_operation_count", "trial_succeeded_count", "trial_attempt_succeeded_count",
        "trial_operation_id", "trial_operation_state", "trial_operation_code", "live_operation_count",
        "live_succeeded_count", "live_attempt_succeeded_count", "live_operation_id",
        "live_operation_state", "live_operation_code",
      ];
      const unchanged = unchangedFields.every((field) => baseline[field] === after[field]) &&
        baseline.live_operation_result?.proof?.migration_apply_receipt_digest === after.live_operation_result?.proof?.migration_apply_receipt_digest;
      if (!unchanged) throw new Error("rebuilt release changed the already-applied migration ledger or data generation");
      return Object.freeze({ ...migration,
        existingSchemaEvidence: Object.freeze({ before: baseline, after, unchanged: true }),
        existingSchemaUnchanged: true, existingSchemaMigrationId: after.migration_id,
        existingSchemaTrialOperationCount: after.trial_operation_count,
        existingSchemaLiveOperationCount: after.live_operation_count,
        existingSchemaDataGenerationBefore: baseline.database_source_data_generation,
        existingSchemaDataGenerationAfter: after.database_source_data_generation,
      });
    }
    const value = await m3.postgres.psqlJson("m3-release-live-migration-evidence", `SELECT json_build_object(
      'migration_id',m.id::text,'state',m.state,'migration_digest',m.migration_digest,
      'pre_migration_archive_id',m.pre_migration_archive_id::text,
      'validation_operation_id',m.validation_operation_id::text,'once_effect_id',m.once_effect_id::text,
      'archive',json_build_object('tenant_database_id',a.tenant_database_id::text,'state',a.state,'kind',a.kind,'verified',a.verified_at IS NOT NULL,
        'plaintext_digest',a.plaintext_sha256,'encrypted_digest',a.encrypted_sha256,
        'source_data_generation',a.source_data_generation,'snapshot_at',a.snapshot_at,'expires_at',a.expires_at,
        'manifest',a.manifest),
      'backup_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='backup_pre_migration' AND o.spec->>'archive_id'=a.id::text AND o.state='succeeded'),
      'backup_attempt_succeeded_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a2
        JOIN tenant_database_operations o2 ON o2.id=a2.operation_id
        WHERE o2.kind='backup_pre_migration' AND o2.spec->>'archive_id'=a.id::text AND a2.state='succeeded'),
      'backup_operation',(SELECT o.result FROM tenant_database_operations o
        WHERE o.kind='backup_pre_migration' AND o.spec->>'archive_id'=a.id::text AND o.state='succeeded' ORDER BY o.updated_at DESC LIMIT 1),
      'trial_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='migration_trial' AND o.operation_key=m.id::text),
      'trial_succeeded_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='migration_trial' AND o.operation_key=m.id::text AND o.state='succeeded'),
      'trial_attempt_succeeded_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a2
        JOIN tenant_database_operations o2 ON o2.id=a2.operation_id
        WHERE o2.kind='migration_trial' AND o2.operation_key=m.id::text AND a2.state='succeeded'),
      'trial_operation',(SELECT json_build_object('id',o.id::text,'state',o.state,'result',o.result)
        FROM tenant_database_operations o WHERE o.id=m.validation_operation_id),
      'live_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='migration_live_apply' AND o.operation_key=m.id::text),
      'live_succeeded_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='migration_live_apply' AND o.operation_key=m.id::text AND o.state='succeeded'),
      'live_attempt_succeeded_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a2
        JOIN tenant_database_operations o2 ON o2.id=a2.operation_id
        WHERE o2.kind='migration_live_apply' AND o2.operation_key=m.id::text AND a2.state='succeeded'),
      'live_operation',(SELECT json_build_object('id',o.id::text,'state',o.state,'result',o.result)
        FROM tenant_database_operations o WHERE o.id=m.once_effect_id),
      'retained_binary_evidence',m.retained_binary_evidence,
      'compatibility_evidence',m.compatibility_evidence)
      FROM tenant_database_migrations m JOIN tenant_database_archives a ON a.id=m.pre_migration_archive_id
      WHERE m.id='${migration.id}'::uuid;`);
    const trial = value?.trial_operation;
    const live = value?.live_operation;
    const trialProof = trial?.result?.proof;
    const liveProof = live?.result?.proof;
    const backupProof = value?.backup_operation?.proof;
    const trialReceiptDigest = value?.compatibility_evidence?.prepared?.migration_apply_receipt_digest ??
      value?.compatibility_evidence?.migration_apply_receipt_digest ?? trialProof?.migration_apply_receipt_digest;
    const liveApplyReceiptDigest = liveProof?.migration_apply_receipt_digest ?? null;
    const retained = Array.isArray(value?.retained_binary_evidence) ? value.retained_binary_evidence : [];
    const probes = Array.isArray(value?.compatibility_evidence?.probe_receipts)
      ? value.compatibility_evidence.probe_receipts : [];
    const cross = Array.isArray(value?.compatibility_evidence?.cross_version_receipts)
      ? value.compatibility_evidence.cross_version_receipts : [];
    const retainedIds = retained.map((item) => item?.application_release_id).filter((item) => typeof item === "string");
    const retainedDigests = retained.map((item) => item?.binary_digest);
    const retainedReceipts = retained.map((item) => item?.probe_receipt_digest);
    const probeReleaseIds = probes.map((item) => item?.application_release_id).filter((item) => typeof item === "string");
    const crossPairs = cross.map((item) => `${item?.frontend_release_id}:${item?.api_release_id}`);
    const expectedRetainedIds = migration.expectedRetainedReleaseIds ?? [];
    const expectedRetainedDigests = migration.expectedRetainedBinaryDigests ?? [];
    const candidateReleaseId = value.compatibility_evidence?.release_id;
    const expectedProbeIds = [candidateReleaseId, ...expectedRetainedIds];
    const uniqueProbeIds = new Set(probeReleaseIds);
    const uniqueRetainedIds = new Set(retainedIds);
    const expectedCrossPairCount = expectedProbeIds.length * Math.max(0, expectedProbeIds.length - 1);
    const retainedBinaryEvidencePassed = expectedRetainedIds.length > 0 && retained.length === expectedRetainedIds.length &&
      uniqueRetainedIds.size === retained.length && retainedIds.every((id) => expectedRetainedIds.includes(id)) &&
      retainedDigests.length === expectedRetainedDigests.length &&
      expectedRetainedIds.every((id, index) => retained.find((item) => item?.application_release_id === id)?.binary_digest === expectedRetainedDigests[index]) &&
      retainedReceipts.length === retained.length && retainedReceipts.every(validReleaseDigest) &&
      retained.every((item) => RELEASE_UUID.test(item?.application_release_id ?? "") && validReleaseDigest(item?.binary_digest) &&
        item?.read_ok === true && item?.write_ok === true);
    const populatedTrialPassed = value?.state === "applied" && trial?.state === "succeeded" &&
      value.trial_operation_count === 1 && value.trial_succeeded_count === 1 &&
      value.trial_attempt_succeeded_count === 1 && trialProof?.migration_id === migration.id &&
      trialProof?.archive_id === value.pre_migration_archive_id && trialProof?.migration_file_digest === migration.digest &&
      trialProof?.schema_revision === "2" && RELEASE_UUID.test(trialProof?.replacement_identity ?? "") &&
      trialProof?.replacement_ref === migration.id && typeof trialProof?.prepared_at === "string" && typeof trialProof?.applied_at === "string" &&
      validReleaseDigest(trialReceiptDigest) && value.compatibility_evidence?.populated === true &&
      value.compatibility_evidence?.source_unchanged === true;
    const compatibilityProbesPassed = RELEASE_UUID.test(candidateReleaseId ?? "") && probes.length === expectedProbeIds.length && uniqueProbeIds.size === probes.length &&
      probeReleaseIds.every((id) => expectedProbeIds.includes(id)) && probes.every((probe) =>
        validReleaseDigest(probe?.artifact_digest) && validReleaseDigest(probe?.probe_receipt_digest) &&
        probe?.migration_id === migration.id && probe?.migration_digest === migration.digest);
    const crossVersionPassed = cross.length === expectedCrossPairCount && new Set(crossPairs).size === cross.length &&
      expectedCrossPairCount > 0 && cross.every((item) => expectedProbeIds.includes(item?.frontend_release_id) &&
        expectedProbeIds.includes(item?.api_release_id) && item.frontend_release_id !== item.api_release_id && validReleaseDigest(item?.receipt_digest));
    const operationLedgerAtMostOnce = value?.live_operation_count === 1 && value?.live_succeeded_count === 1 &&
      value?.live_attempt_succeeded_count === 1 && value.once_effect_id === live?.id &&
      live?.state === "succeeded" && liveProof?.migration_id === migration.id &&
      liveProof?.migration_file_digest === migration.digest && liveProof?.schema_revision === "2" &&
      liveProof?.source_data_generation_before === value.archive?.source_data_generation &&
      liveProof?.source_data_generation_after === value.archive?.source_data_generation + 1 &&
      ["applied", "already_applied"].includes(liveProof?.application_mode) && typeof liveProof?.applied_at === "string" &&
      validReleaseDigest(liveApplyReceiptDigest);
    const backupReceiptPassed = value?.backup_operation_count === 1 && value?.backup_attempt_succeeded_count === 1 &&
      backupProof?.archive_id === value.pre_migration_archive_id &&
      backupProof?.object_ref === `tenant_${value.archive?.tenant_database_id?.replaceAll("-", "") ?? ""}/${value.pre_migration_archive_id}.htb` &&
      backupProof?.format === "hostlet.tenant-backup/v1" && typeof backupProof?.recovery_key_id === "string" &&
      backupProof.recovery_key_id.length > 0 && Number.isSafeInteger(backupProof?.plaintext_bytes) && backupProof.plaintext_bytes > 0 &&
      Number.isSafeInteger(backupProof?.encrypted_bytes) && backupProof.encrypted_bytes > 0 &&
      backupProof?.plaintext_sha256 === value.archive?.plaintext_digest &&
      backupProof?.encrypted_sha256 === value.archive?.encrypted_digest &&
      backupProof?.manifest?.archive_id === value.pre_migration_archive_id &&
      backupProof?.manifest?.archive_kind === "pre_migration" &&
      backupProof?.manifest?.source_data_generation === value.archive?.source_data_generation;
    if (!backupReceiptPassed || !populatedTrialPassed || !operationLedgerAtMostOnce || !retainedBinaryEvidencePassed ||
        !compatibilityProbesPassed || !crossVersionPassed || value?.archive?.verified !== true ||
        value.archive.state !== "usable" || value.archive.kind !== "pre_migration" ||
        !validReleaseDigest(`sha256:${value.archive.plaintext_digest ?? ""}`) ||
        !validReleaseDigest(`sha256:${value.archive.encrypted_digest ?? ""}`)) {
      throw new Error("release migration omitted exact populated trial, retained binaries, overlap probes, or once-only live ledger evidence");
    }
    const receipts = [
      ...retainedReceipts,
      ...probes.map((item) => item.probe_receipt_digest),
      ...cross.map((item) => item.receipt_digest),
    ];
    return Object.freeze({ ...migration,
      backupVerified: migration.backupVerified && value.archive.verified === true,
      backupArchiveDigest: migration.backupArchiveDigest,
      backupReceiptPassed, backupOperationCount: value.backup_operation_count,
      backupAttemptSucceededCount: value.backup_attempt_succeeded_count,
      trialReceiptDigest, isolatedApplyReceiptDigest: trialReceiptDigest,
      liveApplyReceiptDigest, trialState: value.state,
      trialOperationCount: value.trial_operation_count, trialSucceededCount: value.trial_succeeded_count,
      liveOperationCount: value.live_operation_count, liveSucceededCount: value.live_succeeded_count,
      applyCount: value.live_succeeded_count,
      currentBinaryCompatible: value.compatibility_evidence?.current_binary_read_ok === true && value.compatibility_evidence?.current_binary_write_ok === true,
      retainedBinariesCompatible: retainedBinaryEvidencePassed,
      retainedBinaryReceiptDigests: [...new Set(receipts)],
      populatedTrialPassed, duplicateSafe: operationLedgerAtMostOnce,
      competingWorkerFenced: migrationFences.get(migration.id)?.rejected === true });
  }
  async function failedReleaseEvidence(staged) {
    return m3.postgres.psqlJson("m3-release-failed-candidate-evidence", `SELECT json_build_object(
      'release',json_build_object('id',r.id::text,'state',r.state,'failure_code',r.failure_code,
        'source_commit',r.source_commit,'frontend_digest',r.frontend_digest,'backend_digest',r.backend_digest,
        'staged_health_observation_id',r.staged_health_observation_id::text,
        'staged_health_receipt_digest',r.staged_health_receipt_digest),
      'reconciliation',json_build_object('id',rr.id::text,'state',rr.state,'terminal_code',rr.terminal_code,
        'result',rr.result,'attempt_count',rr.attempt_count),
      'probe_receipt_count',jsonb_array_length(CASE WHEN jsonb_typeof(rr.result->'probe_receipt_digests')='array'
        THEN rr.result->'probe_receipt_digests' ELSE '[]'::jsonb END),
      'route_release_id',(SELECT release_id::text FROM project_release_routes WHERE project_id=r.project_id),
      'route_generation',(SELECT generation FROM project_release_routes WHERE project_id=r.project_id))
      FROM application_releases r JOIN release_reconciliations rr ON rr.release_id=r.id
      WHERE r.id='${staged.releaseId}'::uuid AND rr.id='${staged.reconciliationId}'::uuid;`);
  }
  async function failedMigrationEvidence(staged) {
    if (!RELEASE_UUID.test(staged.migration?.id ?? "")) {
      throw new Error("incompatible migration failure evidence requires an exact migration identity");
    }
    const migrationId = staged.migration.id;
    const value = await m3.postgres.psqlJson("m3-release-failed-migration-evidence", `SELECT json_build_object(
      'migration',json_build_object('id',m.id::text,'state',m.state,'migration_revision',m.migration_revision,
        'migration_digest',m.migration_digest,'source_data_generation',m.source_data_generation,
        'tenant_database_id',m.tenant_database_id::text,'database_generation',m.database_generation::text,
        'validation_operation_id',m.validation_operation_id::text),
      'trial_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='migration_trial' AND o.operation_key=m.id::text),
      'trial_attempt_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a
        JOIN tenant_database_operations o ON o.id=a.operation_id
        WHERE o.kind='migration_trial' AND o.operation_key=m.id::text),
      'trial_operation',(SELECT json_build_object('id',o.id::text,'state',o.state,'tenant_database_id',o.tenant_database_id::text,
        'database_generation',o.database_generation::text,'spec_migration_id',o.spec->>'migration_id','result',o.result)
        FROM tenant_database_operations o WHERE o.kind='migration_trial' AND o.operation_key=m.id::text
        ORDER BY o.created_at DESC LIMIT 1),
      'trial_attempt_failed_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a
        JOIN tenant_database_operations o ON o.id=a.operation_id
        WHERE o.kind='migration_trial' AND o.operation_key=m.id::text AND a.state='failed'),
      'live_operation_count',(SELECT count(*)::int FROM tenant_database_operations o
        WHERE o.kind='migration_live_apply' AND o.operation_key=m.id::text),
      'live_attempt_count',(SELECT count(*)::int FROM tenant_database_operation_attempts a
        JOIN tenant_database_operations o ON o.id=a.operation_id
        WHERE o.kind='migration_live_apply' AND o.operation_key=m.id::text),
      'source_data_generation_current',(SELECT d.source_data_generation FROM tenant_databases d
        WHERE d.id=m.tenant_database_id AND d.generation=m.database_generation))
      FROM tenant_database_migrations m WHERE m.id='${migrationId}'::uuid;`);
    const trialCode = value?.trial_operation?.result?.code ?? null;
    const passed = value?.migration?.state === "failed" && value.migration?.migration_revision === "003_destructive" &&
      value.migration?.migration_digest === staged.migration.digest && value.trial_operation_count === 1 &&
      value.trial_attempt_count === 1 && value.trial_operation?.state === "failed" &&
      value.trial_attempt_failed_count === 1 && trialCode === "migration_sql_not_admitted" &&
      value.migration?.validation_operation_id === value.trial_operation?.id &&
      value.trial_operation?.tenant_database_id === value.migration?.tenant_database_id &&
      value.trial_operation?.database_generation === value.migration?.database_generation &&
      value.trial_operation?.spec_migration_id === migrationId &&
      value.live_operation_count === 0 && value.live_attempt_count === 0 &&
      value.source_data_generation_current === value.migration?.source_data_generation;
    if (!passed) throw new Error("incompatible migration did not leave one failed isolated trial with no live apply");
    return Object.freeze({ ...value, trialFailureCode: trialCode, passed: true });
  }
  function corruptPrivateCasArtifact(staged) {
    const artifact = staticOutput(staged.record) ?? applicationOutput(staged.record);
    const expectedDigest = artifact.archiveDigest;
    if (!validReleaseDigest(expectedDigest)) throw new Error("candidate release artifact omitted an exact archive digest");
    const path = join(m3.policyClock.stateDir, "private-cas", "sha256", expectedDigest.slice(7));
    const original = readFileSync(path);
    if (releaseSha256(original) !== expectedDigest) throw new Error("candidate release artifact CAS bytes were not intact before corruption");
    if (original.length === 0) throw new Error("candidate release artifact CAS archive was empty");
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] ^= 0xff;
    const corruptedDigest = releaseSha256(corrupted);
    if (corruptedDigest === expectedDigest) throw new Error("candidate release artifact corruption did not change its digest");
    writeFileSync(path, corrupted);
    if (releaseSha256(readFileSync(path)) !== corruptedDigest) {
      writeFileSync(path, original);
      throw new Error("candidate release artifact corruption was not durably written");
    }
    let restored = false;
    return Object.freeze({
      expectedDigest,
      corruptedDigest,
      restore() {
        if (restored) return;
        writeFileSync(path, original);
        const restoredDigest = releaseSha256(readFileSync(path));
        if (restoredDigest !== expectedDigest) throw new Error("candidate release artifact CAS bytes were not restored after corruption test");
        restored = true;
      },
      evidence() {
        const restoredDigest = releaseSha256(readFileSync(path));
        return Object.freeze({
          artifact_kind: artifact.kind,
          artifact_digest: expectedDigest,
          corrupted_digest: corruptedDigest,
          restored_digest: restoredDigest,
          restored,
        });
      },
    });
  }
  async function promote(key, { expectFailure = false, rebuild = false, corruptArtifact = false, beforeStage = null } = {}) {
    if (expectFailure) {
      if (worker) { await context.stopManaged(worker.process, "release worker failed-candidate setup"); worker = null; }
      const staged = await stage(key, { rebuild, startWorker: false, beforeStage });
      let corruption = null;
      let result = null;
      try {
        if (corruptArtifact) corruption = corruptPrivateCasArtifact(staged);
        worker = startReleaseWorker(m3, { artifactRoot: join(m3.policyClock.stateDir, "private-cas"), runtimeRoot: runtime.stateRoot });
        const terminal = key === "incompatible_migration"
          ? await awaitFailedMigrationRelease(staged)
          : await awaitRelease(staged.projectId, staged.releaseId, ["failed"], staged.reconciliationId);
        const failureEvidence = await failedReleaseEvidence(staged);
        const migrationFailureEvidence = key === "incompatible_migration"
          ? await failedMigrationEvidence(staged) : null;
        result = Object.freeze({ ...staged, release: terminal.release, state: terminal.release.state,
          code: terminal.release.failure_code, failureEvidence, migrationFailureEvidence,
          gateway: { ...gateway, address: "127.0.0.1" } });
      } finally {
        if (corruption) corruption.restore();
        // Let the real incompatible candidate answer the worker's probes first;
        // clean its owned runtime only after the durable failure is observed.
        await runtime.stopRelease(staged.launched);
      }
      return Object.freeze({ ...result, artifactCorruptionEvidence: corruption?.evidence() ?? null });
    }
    const staged = await stage(key, { rebuild, beforeStage });
    const terminal = await awaitReleaseAndDatabase(staged, expectFailure ? ["failed"] : ["healthy"]);
    const verifiedMigration = await migrationEvidence(staged.migration);
    const route = terminal.history.current_route;
    const frontend = staticOutput(staged.record); const backend = applicationOutput(staged.record);
    const result = Object.freeze({ ...staged, migration: verifiedMigration, release: terminal.release, state: terminal.release.state,
      code: terminal.release.failure_code, sourceCommit: staged.record.detail.build.source_commit,
      frontendDigest: frontend?.archiveDigest ?? null, frontendManifestDigest: frontend?.manifestDigest ?? null,
      backendDigest: backend.archiveDigest, backendManifestDigest: backend.manifestDigest,
      routeManifestDigest: route?.route_manifest_digest ?? null, gateway: { ...gateway, address: "127.0.0.1" },
      backupVerified: verifiedMigration.backupVerified, backupArchiveDigest: verifiedMigration.backupArchiveDigest,
      backupReceiptPassed: verifiedMigration.backupReceiptPassed ?? false,
      backupOperationCount: verifiedMigration.backupOperationCount ?? 0,
      backupAttemptSucceededCount: verifiedMigration.backupAttemptSucceededCount ?? 0,
      backupPlaintextDigest: verifiedMigration.backupPlaintextDigest ?? null,
      backupEncryptedDigest: verifiedMigration.backupEncryptedDigest ?? null,
      preMigrationArchiveId: verifiedMigration.preMigrationArchiveId ?? null,
      migrationId: verifiedMigration.id, migrationApplyCount: verifiedMigration.applyCount,
      migrationApplyReceiptDigest: verifiedMigration.liveApplyReceiptDigest ?? null,
      migrationTrialReceiptDigest: verifiedMigration.trialReceiptDigest ?? null,
      migrationIsolatedApplyReceiptDigest: verifiedMigration.isolatedApplyReceiptDigest ?? null,
      migrationTrialState: verifiedMigration.trialState ?? null,
      migrationPopulatedTrialPassed: verifiedMigration.populatedTrialPassed ?? false,
      migrationTrialOperationCount: verifiedMigration.trialOperationCount ?? 0,
      migrationTrialSucceededCount: verifiedMigration.trialSucceededCount ?? 0,
      migrationLiveOperationCount: verifiedMigration.liveOperationCount ?? 0,
      migrationLiveSucceededCount: verifiedMigration.liveSucceededCount ?? 0,
      migrationDuplicateSafe: verifiedMigration.duplicateSafe ?? false,
      migrationCompetingWorkerFenced: verifiedMigration.competingWorkerFenced ?? false,
      currentBinaryCompatible: verifiedMigration.currentBinaryCompatible,
      retainedBinariesCompatible: verifiedMigration.retainedBinariesCompatible,
      retainedBinaryReceiptDigests: verifiedMigration.retainedBinaryReceiptDigests,
      existingSchemaEvidence: verifiedMigration.existingSchemaEvidence ?? null,
      existingSchemaUnchanged: verifiedMigration.existingSchemaUnchanged ?? false,
      existingSchemaMigrationId: verifiedMigration.existingSchemaMigrationId ?? null,
      existingSchemaTrialOperationCount: verifiedMigration.existingSchemaTrialOperationCount ?? null,
      existingSchemaLiveOperationCount: verifiedMigration.existingSchemaLiveOperationCount ?? null,
      existingSchemaDataGenerationBefore: verifiedMigration.existingSchemaDataGenerationBefore ?? null,
      existingSchemaDataGenerationAfter: verifiedMigration.existingSchemaDataGenerationAfter ?? null,
      databaseGeneration: staged.database.record.generation });
    if (!rebuild && key === "fullstack_v1") currentPrepared ??= result;
    if (!rebuild && key === "fullstack_v2") replacementPrepared ??= result;
    return result;
  }
  async function rollback(projectId, releaseId) {
    const before = await history(projectId);
    const previousGeneration = before.current_route?.generation;
    if (!Number.isSafeInteger(previousGeneration)) throw new Error("rollback requires an active durable route generation");
    const response = await m3.ownerHTTP(`/v1/projects/${projectId}/releases/${releaseId}/rollback`, {
      method: "POST", headers: { "Idempotency-Key": `m3-release-rollback-${++sequence}` }, body: {},
    });
    if (![200, 201].includes(response.status)) throw new Error(`release rollback returned HTTP ${response.status}`);
    const reconciliationId = response.payload.reconciliation?.id;
    if (!reconciliationId) throw new Error("rollback response omitted its reconciliation identity");
    const terminal = await eventually(`rollback ${reconciliationId}`, async () => {
      const [value, reconciliationState] = await Promise.all([
        history(projectId),
        m3.postgres.psqlJson("m3-release-rollback-activation", `SELECT state FROM release_reconciliations WHERE id='${reconciliationId}'::uuid;`),
      ]);
      const release = value.releases.find(({ id }) => id === releaseId);
      if (reconciliationState === "failed") {
        throw new TerminalReleaseWaitError(`rollback reconciliation reached ${reconciliationState}`);
      }
      if (reconciliationState === "retriable") {
        throw new Error(`rollback reconciliation reached ${reconciliationState}`);
      }
      if (release?.state === "healthy" && reconciliationState === "succeeded" &&
          value.current_route?.release_id === releaseId && value.current_route.generation > previousGeneration) {
        return { release, history: value };
      }
      return null;
    }, { timeoutMs: options.promotionTimeoutMs ?? 120_000 });
    const release = terminal.release;
    return Object.freeze({ releaseId, release, gateway: { ...gateway, address: "127.0.0.1" },
      reconciliationId, routeGeneration: terminal.history.current_route.generation,
      dataRestorePerformed: false, databaseGeneration: release.database_generation });
  }
  async function writeItem(client, value) {
    const response = await client.request("/api/items", { method: "POST", json: value });
    if (response.status !== 201) throw new Error(`release fixture write returned HTTP ${response.status}`);
    return response.json().item;
  }
  async function requestRetainedApi(_release, releaseId, path, requestOptions = {}) {
    const client = createReleaseClient(gateway, context.abortSignal);
    client.setCookie(`__Host-hostlet_release=${releaseId}`);
    return client.request(path, requestOptions);
  }
  async function exerciseNegativeReleaseCases(stable, targetReleaseId) {
    const projectId = stable.projectId;
    const database = stable.database?.record;
    const build = stable.record?.detail?.build;
    const allocation = stable.launched?.allocation;
    if (!RELEASE_UUID.test(projectId) || !RELEASE_UUID.test(database?.id ?? "") ||
        !RELEASE_UUID.test(database?.generation ?? "") || !RELEASE_UUID.test(build?.id ?? "") ||
        !RELEASE_UUID.test(allocation?.id ?? "") || !stable.migration?.digest || !stable.migration?.artifactPath) {
      throw new Error("release negative cases require the exact populated build, allocation, database, and migration identities");
    }
    const beforeRoute = readActiveRoute(m3.policyClock.stateDir, projectId);
    const stagePath = `/v1/projects/${projectId}/deployments/${build.deployment_id}/releases`;
    const migrationPath = `/v1/projects/${projectId}/deployments/${build.deployment_id}/migration-trial`;
    const stageBody = (overrides = {}) => ({
      build_job_id: build.id, runtime_allocation_id: allocation.id,
      tenant_database_id: database.id, database_generation: database.generation,
      migration_revision: stable.migration.revision,
      migration_digest: stable.migration.digest,
      migration_artifact_path: stable.migration.artifactPath,
      managed_demo_url: gateway.origin, ...overrides,
    });
    const migrationRevision = `m3_missing_backup_${++sequence}`;
    const queuedBackup = await m3.ownerHTTP(migrationPath, {
      method: "POST", headers: { "Idempotency-Key": `m3-release-missing-backup-${sequence}` },
      body: { build_job_id: build.id, tenant_database_id: database.id,
        database_generation: database.generation, migration_revision: migrationRevision,
        migration_digest: stable.migration.digest, migration_artifact_path: stable.migration.artifactPath,
        current_schema_revision: "1", candidate_schema_revision: "2" },
    });
    const missingBackupQueued = queuedBackup.status === 202 && queuedBackup.payload?.phase === "pre_migration_backup_queued";
    const missingBackupStage = await m3.ownerHTTP(stagePath, {
      method: "POST", headers: { "Idempotency-Key": `m3-release-missing-backup-stage-${sequence}` },
      body: stageBody({ migration_revision: migrationRevision }),
    });
    const missingBackupRejected = missingBackupStage.status === 409 &&
      missingBackupStage.payload?.error?.code === "release_migration_ineligible";
    if (missingBackupQueued) await dataStage.drainWorker("release-negative-missing-backup-cleanup");

    const artifactDigest = alternateReleaseDigest(stable.migration.digest);
    const artifactMismatch = await m3.ownerHTTP(stagePath, {
      method: "POST", headers: { "Idempotency-Key": `m3-release-artifact-mismatch-${++sequence}` },
      body: stageBody({ migration_digest: artifactDigest }),
    });
    const artifactDigestMismatchRejected = artifactMismatch.status === 409 &&
      artifactMismatch.payload?.error?.code === "release_migration_ineligible";
    const migrationMismatch = await m3.ownerHTTP(stagePath, {
      method: "POST", headers: { "Idempotency-Key": `m3-release-migration-mismatch-${++sequence}` },
      body: stageBody({ migration_revision: `m3_unplanned_revision_${sequence}`, migration_artifact_path: "dist/migrations/003_unplanned.sql" }),
    });
    const migrationReferenceMismatchRejected = migrationMismatch.status === 409 &&
      migrationMismatch.payload?.error?.code === "release_migration_ineligible";

    const historyBeforeSecret = await history(projectId);
    const secretTarget = historyBeforeSecret.releases.find((release) => release.id !== historyBeforeSecret.current_route?.release_id &&
      release.state === "healthy" && Array.isArray(release.secret_version_refs) && release.secret_version_refs.length > 0);
    let expiredSecretRejected = false;
    let expiredSecretEvidence = { target_release_id: null, secret_ref_count: 0, rollback_status: null, rollback_error_code: null };
    if (secretTarget) {
      const references = secretTarget.secret_version_refs;
      const secretIds = references.map((reference) => reference.secret_id).filter((id) => RELEASE_UUID.test(id));
      const allActive = references.length === secretIds.length && references.every((reference) => RELEASE_UUID.test(reference.secret_version_id));
      if (allActive) {
        const ownerId = m3.state.owner.record.id;
        await m3.postgres.psqlCommand("m3-release-expired-secret-revoke", `UPDATE secrets SET status='revoked',updated_at=clock_timestamp()
          WHERE account_id='${ownerId}'::uuid AND id IN (${secretIds.map((id) => `'${id}'::uuid`).join(",")});`);
        try {
          const rejected = await m3.ownerHTTP(`/v1/projects/${projectId}/releases/${secretTarget.id}/rollback`, {
            method: "POST", headers: { "Idempotency-Key": `m3-release-expired-secret-${++sequence}` }, body: {},
          });
          expiredSecretRejected = rejected.status === 409 && rejected.payload?.error?.code === "release_secret_version_expired";
          expiredSecretEvidence = { target_release_id: secretTarget.id, secret_ref_count: references.length,
            rollback_status: rejected.status, rollback_error_code: rejected.payload?.error?.code ?? null };
        } finally {
          await m3.postgres.psqlCommand("m3-release-expired-secret-restore", `UPDATE secrets SET status='active',updated_at=clock_timestamp()
            WHERE account_id='${ownerId}'::uuid AND id IN (${secretIds.map((id) => `'${id}'::uuid`).join(",")});`);
        }
      }
    }
    const afterRoute = readActiveRoute(m3.policyClock.stateDir, projectId);
    const routePreserved = afterRoute.digest === beforeRoute.digest;
    return Object.freeze({
      missingBackupQueued, missingBackupRejected,
      missingBackupStatus: missingBackupStage.status,
      missingBackupCode: missingBackupStage.payload?.error?.code ?? null,
      artifactDigestMismatchRejected, artifactMismatchStatus: artifactMismatch.status,
      artifactMismatchCode: artifactMismatch.payload?.error?.code ?? null,
      migrationReferenceMismatchRejected, migrationMismatchStatus: migrationMismatch.status,
      migrationMismatchCode: migrationMismatch.payload?.error?.code ?? null,
      expiredSecretRejected, expiredSecretEvidence, routePreserved,
      beforeRouteDigest: beforeRoute.digest, afterRouteDigest: afterRoute.digest,
      targetReleaseId: targetReleaseId ?? null,
    });
  }
  async function exerciseRestartAndStaleCompletion(projectId) {
    if (worker) { await context.stopManaged(worker.process, "release worker stale-fence exercise"); worker = null; }
    const staged = await stage("fullstack_v1", { rebuild: true, startWorker: false });
    const stale = await m3.roleInternal("runtime", "/internal/v1/release-reconciliations/lease", { method: "POST", body: { worker_id: "m3-stale-release-worker" } });
    if (stale.status !== 200 || stale.payload.reconciliation.id !== staged.reconciliationId) throw new Error("could not acquire exact stale release lease");
    await m3.switchApi(m3.currentApiBinary, "M3 release fence API restart");
    const expiry = Date.parse(stale.payload.attempt.lease_expires_at);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry - Date.now()) + 250));
    worker = startReleaseWorker(m3, { artifactRoot: join(m3.policyClock.stateDir, "private-cas"), runtimeRoot: runtime.stateRoot });
    const winner = await awaitRelease(projectId, staged.releaseId, ["healthy"], staged.reconciliationId);
    const staleCompletion = await m3.roleInternal("runtime", `/internal/v1/release-reconciliations/${staged.reconciliationId}/complete`, {
      method: "POST", body: { worker_id: "m3-stale-release-worker", attempt_id: stale.payload.attempt.id,
        fence: stale.payload.attempt.fence, outcome: { state: "failed", code: "stale_probe", probe_receipt_digests: [], migration_apply_receipt_digest: null } },
    });
    const current = await history(projectId);
    return { staleCompletionRejected: staleCompletion.status === 409, concurrentWinnerCount: current.releases.filter((item) => item.id === staged.releaseId && item.state === "healthy").length,
      winnerReleaseId: winner.release.id, routeAfterRestart: { release_id: current.current_route.release_id } };
  }
  async function exerciseConcurrentPromotion(projectId) {
    if (!RELEASE_UUID.test(projectId)) throw new Error("concurrent promotion requires the exact release project identity");
    if (worker) { await context.stopManaged(worker.process, "release worker concurrent promotion setup"); worker = null; }
    const before = await history(projectId);
    const beforeRoute = readActiveRoute(m3.policyClock.stateDir, projectId);
    const staged = await stage("fullstack_v1", { rebuild: true, startWorker: false });
    const workerA = startReleaseWorker(m3, {
      artifactRoot: join(m3.policyClock.stateDir, "private-cas"), runtimeRoot: runtime.stateRoot,
      workerId: `m3-concurrent-release-a-${++sequence}`,
    });
    try {
      const firstLease = await eventually(`concurrent release first lease ${staged.reconciliationId}`, async () => {
        const row = await m3.postgres.psqlJson("m3-release-concurrent-first-lease", `SELECT json_build_object(
          'state',r.state,'attempt_id',r.current_attempt_id::text,'fence',r.current_fence,
          'lease_expires_at',r.lease_expires_at,'worker_id',a.worker_id,'attempt_state',a.state)
          FROM release_reconciliations r LEFT JOIN release_reconciliation_attempts a
            ON a.reconciliation_id=r.id AND a.id=r.current_attempt_id AND a.fence=r.current_fence
          WHERE r.id='${staged.reconciliationId}'::uuid;`);
        return row?.state === "running" && row.attempt_id && row.worker_id === workerA.workerId && row.attempt_state === "running" ? row : null;
      }, { timeoutMs: options.promotionTimeoutMs ?? 120_000 });
      if (!workerA.process.child.kill("SIGSTOP")) throw new Error("could not pause the exact first concurrent release worker");
      const workerB = startReleaseWorker(m3, {
        artifactRoot: join(m3.policyClock.stateDir, "private-cas"), runtimeRoot: runtime.stateRoot,
        workerId: `m3-concurrent-release-b-${++sequence}`,
      });
      let winner;
      try {
        winner = await awaitRelease(projectId, staged.releaseId, ["healthy"], staged.reconciliationId);
      } finally {
        await context.stopManaged(workerB.process, "release worker concurrent promotion winner complete");
      }
      if (!workerA.process.child.kill("SIGCONT")) throw new Error("could not resume the first concurrent release worker for fenced cleanup");
      await eventually("first concurrent release worker exits after stale lease", async () => workerA.process.child.exitCode !== null ? { code: workerA.process.child.exitCode } : null,
        { timeoutMs: 30_000 });
      const evidence = await m3.postgres.psqlJson("m3-release-concurrent-promotion-evidence", `SELECT json_build_object(
        'reconciliation_id',r.id::text,'release_id',r.release_id::text,'state',r.state,'terminal_code',r.terminal_code,
        'attempt_count',r.attempt_count,'current_route_release_id',(SELECT release_id::text FROM project_release_routes WHERE project_id=r.project_id),
        'route_generation',(SELECT generation FROM project_release_routes WHERE project_id=r.project_id),
        'attempts',(SELECT COALESCE(json_agg(json_build_object('attempt_number',a.attempt_number,'fence',a.fence,
          'worker_id',a.worker_id,'state',a.state,'terminal_code',a.terminal_code) ORDER BY a.attempt_number),'[]'::json)
          FROM release_reconciliation_attempts a WHERE a.reconciliation_id=r.id),
        'promotions',(SELECT count(*)::int FROM application_release_events e WHERE e.release_id=r.release_id AND e.kind='promoted')
        ) FROM release_reconciliations r WHERE r.id='${staged.reconciliationId}'::uuid;`);
      const attempts = Array.isArray(evidence?.attempts) ? evidence.attempts : [];
      const workerIds = [...new Set(attempts.map((item) => item?.worker_id).filter(Boolean))];
      const succeeded = attempts.filter((item) => item?.state === "succeeded");
      const expired = attempts.filter((item) => item?.state === "expired");
      const route = readActiveRoute(m3.policyClock.stateDir, projectId);
      const passed = beforeRoute.digest !== route.digest && evidence?.state === "succeeded" &&
        evidence.current_route_release_id === staged.releaseId && evidence.route_generation > before.current_route.generation &&
        evidence.promotions === 1 && attempts.length >= 2 && workerIds.length >= 2 &&
        succeeded.length === 1 && expired.length >= 1 && succeeded[0]?.worker_id !== expired[0]?.worker_id &&
        winner.release.id === staged.releaseId;
      return Object.freeze({
        ...evidence, before_route_manifest_digest: beforeRoute.digest, after_route_manifest_digest: route.digest,
        first_attempt_id: firstLease.attempt_id, winner_release_id: winner.release.id, worker_ids: workerIds, attempt_count_observed: attempts.length,
        succeeded_attempt_count: succeeded.length, expired_attempt_count: expired.length, passed,
      });
    } finally {
      if (workerA.process.child.exitCode === null) {
        workerA.process.child.kill("SIGCONT");
        await context.stopManaged(workerA.process, "release worker concurrent promotion cleanup");
      }
    }
  }
  async function exerciseStoppedRetainedRollback() {
    if (!gateway) throw new Error("stopped retained rollback requires an active release gateway");
    const projectId = buildStage.jobs.get("fullstack_v1")?.detail?.build?.project_id;
    if (!projectId) throw new Error("stopped retained rollback requires the release project identity");
    const beforeHistory = await history(projectId);
    const beforeRoute = readActiveRoute(m3.policyClock.stateDir, projectId);
    const activeReleaseId = beforeHistory.current_route?.release_id;
    const target = beforeRoute.manifest.retained_assets
      ?.map(({ release_id: releaseId }) => ({ releaseId, release: beforeHistory.releases.find(({ id }) => id === releaseId), runtime: releaseRuntimes.get(releaseId) }))
      .find(({ releaseId, release, runtime: retainedRuntime }) => releaseId !== activeReleaseId && release?.state === "healthy" && retainedRuntime && !retainedRuntime.entry?.stopped);
    if (!target) throw new Error("no live retained non-current runtime is available for rollback denial");
    const client = createReleaseClient(gateway, context.abortSignal);
    const beforeDataResponse = await client.request("/api/items");
    if (beforeDataResponse.status !== 200) throw new Error("current data was unavailable before retained runtime stop");
    const historyIdentity = (value) => value.releases.map(({ id, state, promoted_at: promotedAt, failure_code: failureCode }) =>
      ({ id, state, promoted_at: promotedAt ?? null, failure_code: failureCode ?? null }));
    const beforeReleaseHistory = historyIdentity(beforeHistory);
    const itemIdentity = (payload) => (payload.items ?? []).map(({ id, name, client_release: clientRelease }) =>
      ({ id, name, client_release: clientRelease ?? null })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const beforeItems = itemIdentity(beforeDataResponse.json());
    await runtime.stopRelease(target.runtime);
    const stopDigest = target.runtime.entry?.stop?.digest;
    const cleanupDigest = target.runtime.entry?.cleanup?.digest;
    if (!stopDigest || !cleanupDigest || !target.runtime.entry?.stopped) {
      throw new Error("retained runtime stop omitted its exact stop or cleanup receipt");
    }
    const rejected = await m3.ownerHTTP(`/v1/projects/${projectId}/releases/${target.releaseId}/rollback`, {
      method: "POST", headers: { "Idempotency-Key": `m3-release-stopped-rollback-${++sequence}` }, body: {},
    });
    const afterHistory = await history(projectId);
    const afterRoute = readActiveRoute(m3.policyClock.stateDir, projectId);
    const afterDataResponse = await client.request("/api/items");
    const afterItems = afterDataResponse.status === 200 ? itemIdentity(afterDataResponse.json()) : [];
    const passed = rejected.status === 409 && rejected.payload?.error?.code === "rollback_target_ineligible" &&
      afterHistory.current_route?.release_id === activeReleaseId &&
      afterHistory.current_route?.generation === beforeHistory.current_route?.generation &&
      afterRoute.digest === beforeRoute.digest &&
      JSON.stringify(historyIdentity(afterHistory)) === JSON.stringify(beforeReleaseHistory) &&
      JSON.stringify(afterItems) === JSON.stringify(beforeItems);
    const evidence = Object.freeze({ target_release_id: target.releaseId,
      target_allocation_id: target.runtime.allocation.id, stop_receipt_digest: stopDigest,
      cleanup_receipt_digest: cleanupDigest, rollback_status: rejected.status,
      rollback_error_code: rejected.payload?.error?.code ?? null, active_release_id: activeReleaseId,
      route_generation: afterHistory.current_route?.generation ?? null, route_manifest_digest: afterRoute.digest,
      current_item_ids: afterItems.map(({ id }) => id) });
    context.assertion("M3-RELEASE-03-STOPPED", "M3 coordinated releases",
      "rollback admission rejects a retained release whose exact owned runtime was stopped and cleaned while preserving the active route and current data",
      evidence, passed);
    if (!passed) throw new Error("stopped retained rollback changed current state or was not rejected");
    return evidence;
  }
  async function withEndpointsPaused(run) {
    if (typeof run !== "function") throw new Error("release endpoint pause requires a callback");
    const handles = [worker?.process, gateway?.process].filter(Boolean);
    const paused = [];
    try {
      for (const handle of handles) {
        if (!handle.child || handle.child.exitCode !== null || !handle.child.kill("SIGSTOP")) {
          throw new Error("could not pause an exact owned release endpoint");
        }
        paused.push(handle);
      }
      return await run();
    }
    finally {
      const failures = [];
      for (const handle of [...paused].reverse()) {
        if (handle.child.exitCode === null && !handle.child.kill("SIGCONT")) failures.push(handle.label ?? "release endpoint");
      }
      if (failures.length) throw new Error(`could not resume owned release endpoints: ${failures.join(",")}`);
    }
  }
  const api = Object.freeze({ promote, rollback, client: (value = gateway) => createReleaseClient(value, context.abortSignal),
    openBrowser: async (label) => beginReleaseBrowser(context, gateway, options.spki, label),
    writeItem, requestRetainedApi, releaseHistory: async (projectId) => { const value = await history(projectId); return { ...value, successful: value.releases.filter(({ promoted_at }) => promoted_at) }; },
    exerciseRestartAndStaleCompletion, exerciseConcurrentPromotion, exerciseNegativeReleaseCases,
    exerciseStoppedRetainedRollback, withEndpointsPaused,
    getCurrentRelease: async () => {
      const projectId = buildStage.jobs.get("fullstack_v1").detail.build.project_id;
      const value = await history(projectId);
      return value.releases.find(({ id }) => id === value.current_route?.release_id) ?? null;
    },
    prepareCurrentRelease: async () => (await api.getCurrentRelease()) ?? (await promote("fullstack_v1")).release,
    promoteReplacementRelease: async () => (await promote("fullstack_v2", { rebuild: true })).release,
    migrationCompatibility: async () => {
      const result = replacementPrepared ?? await promote("fullstack_v2");
      const databaseSecrets = await m3.postgres.psqlJson("m3-release-build-database-secret-evidence", `SELECT count(*)::int
        FROM build_job_secret_refs r JOIN secrets s ON s.id=r.secret_id AND s.account_id=r.account_id AND s.project_id=r.project_id
        WHERE r.job_id='${result.record.detail.build.id}'::uuid AND (s.credential_kind LIKE '%database%' OR s.name='DATABASE_URL');`);
      return { freshBackupVerified: result.backupVerified && result.backupReceiptPassed === true,
        backupReceiptPassed: result.backupReceiptPassed, backupOperationCount: result.backupOperationCount,
        backupAttemptSucceededCount: result.backupAttemptSucceededCount,
        populatedTrialPassed: result.migrationPopulatedTrialPassed === true,
        applyCount: result.migrationApplyCount, trialOperationCount: result.migrationTrialOperationCount,
        trialSucceededCount: result.migrationTrialSucceededCount, liveOperationCount: result.migrationLiveOperationCount,
        liveSucceededCount: result.migrationLiveSucceededCount, trialState: result.migrationTrialState,
        trialReceiptDigest: result.migrationTrialReceiptDigest, liveApplyReceiptDigest: result.migrationApplyReceiptDigest,
        backupArchiveId: result.preMigrationArchiveId, backupPlaintextDigest: result.backupPlaintextDigest,
        backupEncryptedDigest: result.backupEncryptedDigest, duplicateSafe: result.migrationDuplicateSafe,
        competingWorkerFenced: result.migrationCompetingWorkerFenced,
        customerBuildDatabaseSecrets: Number(databaseSecrets), currentApplicationReadWrite: result.currentBinaryCompatible,
        retainedApplicationReadWrite: result.retainedBinariesCompatible,
        dataRewinds: result.databaseGeneration === result.database.record.generation ? 0 : 1 };
    },
    get gateway() { return gateway; }, get worker() { return worker; }, live });
  m3.state.releaseHarness = api;
  return api;
}
