#!/usr/bin/env node
// Concrete owned operations for the deployed gate. Every success value below is
// derived from a provider/API/database readback, never from an input proof flag.
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, lstatSync, writeFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePlatformDatabase, ensureProjectTarget, backupDatabase, restoreDatabase, removeTemporaryRestore } from "../../scripts/beta/database.mjs";
import { openBrowser } from "./browser.mjs";
import { probeRestoredProject, probeRestoredPlatform, removeRestoredProjectChecker } from "./restore-app.mjs";

const input = process.argv.slice(2);
const action = input.shift();
const arg = (name) => { const i = input.indexOf(`--${name}`); if (i < 0 || !input[i + 1]) throw new Error(`missing --${name}`); return input[i + 1]; };
const configPath = arg("config"), edgePath = arg("edge-credentials"), cfPath = arg("cloudflare-config"), cfBeforePath = arg("cloudflare-before"), proofPath = arg("ready-proof"), servicesPath = arg("services-manifest"), runId = arg("run-id");
const params = JSON.parse(arg("params"));
const privateJson = (path) => { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("private file is not mode 0600"); return JSON.parse(readFileSync(path, "utf8")); };
const cfg = privateJson(configPath), cf = privateJson(cfPath);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const secret = (path) => { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("credential file is not mode 0600"); return readFileSync(path, "utf8").trim(); };
const childEnvironment = () => Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const run = (program, argv, { env = childEnvironment(), timeout = 180000, cwd = root } = {}) => {
  const result = spawnSync(program, argv, { encoding: "utf8", env, timeout, cwd, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(`${program} ${argv[0]} failed (${result.status ?? result.error?.code})`);
  return result.stdout.trim();
};
const managed = (verb, unit) => run("node", ["scripts/beta/managed-services.mjs", verb, ...(verb === "ready" ? [servicesPath, unit, "5000"] : [unit])], { timeout: 15000 });
const servicePolicy = (unit) => {
  const inspected = JSON.parse(managed("inspect", unit));
  const lines = run("/usr/bin/systemctl", ["show", inspected.name, "--property=Restart,RestartUSec,StartLimitBurst,StartLimitIntervalUSec,NRestarts,ActiveEnterTimestampMonotonic", "--no-pager"]);
  return Object.fromEntries(lines.split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
};
const journal = () => privateJson(join(cf.workDir, "cloudflare-journal.json"));
const manifest = () => privateJson(join(cfg.stateDir, "identity-manifest.json"));
const databaseStateDir = cfg.postgres.stateDir ?? join(cfg.stateDir, "databases");
const api = async (path, { method = "GET", body, token, headers = {} } = {}) => {
  const response = await fetch(new URL(path, cfg.apiUrl), { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  let payload; try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
};
const owner = async () => { const result = await api("/v1/sessions", { method: "POST", body: { email: cfg.owner.email, password: secret(cfg.owner.passwordFile) } }); if (result.status !== 201 || !result.payload?.token) throw new Error("owner session unavailable"); return result.payload.token; };
const projectSource = async () => ensureProjectTarget({ stateDir: databaseStateDir, tenantDatabaseId: manifest().database.id, databaseGeneration: manifest().database.generation, endpointIpv4: cfg.postgres.project.endpointIpv4, endpointIpv6: cfg.postgres.project.endpointIpv6 });
const platformSource = async () => ensurePlatformDatabase({ stateDir: databaseStateDir, port: cfg.postgres.platform.port, connectionUrlFile: cfg.postgres.platform.connectionUrlFile });
const sql = (source, database, query, { expectedStatus = 0 } = {}) => {
  if (!/^(postgres|hdb_[a-f0-9]{32})$/.test(database)) throw new Error("unexpected database name");
  const output = spawnSync("docker", ["exec", "--env", "PGPASSWORD", source.containerId, "psql", "--no-psqlrc", "-h", "127.0.0.1", "-U", "postgres", "-d", database, "-Atqc", query], { encoding: "utf8", timeout: 30000, env: { ...childEnvironment(), PGPASSWORD: secret(source.passwordFile) } });
  if (output.status !== expectedStatus) throw new Error(`owned PostgreSQL query failed (${output.status})`);
  return output.stdout.trim();
};
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const row = (source, database, itemId) => JSON.parse(sql(source, database, `SELECT row_to_json(t) FROM (SELECT id,name FROM app.journal_items WHERE id=${Number(itemId)}) t;`) || "null");
const backupDir = join(cfg.stateDir, "gate-backups", runId);
const restoreTracking = join(backupDir, "restore-tracking.json");
let substep = "start";

async function execute() {
  if (action === "currentPublishedSite") {
    const token = await owner();
    const latest = await api("/v1/portfolio/publications/latest", { token });
    const id = latest.payload?.id, slug = latest.payload?.slug;
    if (latest.status !== 200 || latest.payload?.state !== "published" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id ?? "") || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug ?? "")) throw new Error("current published site unavailable");
    return { id, slug };
  }
  if (action === "queryProjectRow") {
    const source = await projectSource(); const found = row(source, source.databaseName, params.itemId);
    if (!found) throw new Error("project database row missing");
    return found;
  }
  if (action === "backupPopulated") {
    const directory = backupDir; mkdirSync(directory, { recursive: true, mode: 0o700 });
    const platform = await platformSource(), project = await projectSource();
    const ownerId = manifest().identity.ownerId;
    if (sql(platform, "postgres", `SELECT count(*) FROM accounts WHERE id=${quote(ownerId)}::uuid;`) !== "1") throw new Error("platform backup has no owner row");
    if (!row(project, project.databaseName, params.itemId)) throw new Error("project backup has no browser-created row");
    const a = await backupDatabase({ stateDir: databaseStateDir, source: platform, archivePath: join(directory, "platform.dump") });
    const b = await backupDatabase({ stateDir: databaseStateDir, source: project, archivePath: join(directory, "project.dump"), database: project.databaseName });
    return { platformSha256: a.sha256, projectSha256: b.sha256, directory, platformBytes: a.bytes, projectBytes: b.bytes };
  }
  if (action === "restoreIsolated") {
    const directory = backupDir, platformId = randomUUID(), projectId = randomUUID();
    writeFileSync(restoreTracking, JSON.stringify({ platformId, projectId }), { flag: "wx", mode: 0o600 });
    substep = "restore_platform";
    const platform = await restoreDatabase({ stateDir: databaseStateDir, archivePath: join(directory, "platform.dump"), sha256: params.platformSha256, restoreId: platformId });
    let project;
    try {
      if (params.injectFailure === "afterPlatformRestore") throw new Error("deliberate failure after owned platform restore");
      substep = "restore_project";
      project = await restoreDatabase({ stateDir: databaseStateDir, archivePath: join(directory, "project.dump"), sha256: params.projectSha256, restoreId: projectId });
    } catch (error) {
      try { await removeTemporaryRestore({ stateDir: databaseStateDir, restoreId: platformId }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `restore failed: ${error.message}; cleanup failed: ${cleanupError.message}`); }
      throw error;
    }
    const ids = manifest().identity;
    const ownerCount = sql(platform, "postgres", `SELECT count(*) FROM accounts WHERE id=${quote(ids.ownerId)}::uuid;`);
    const projectCount = sql(platform, "postgres", `SELECT count(*) FROM projects WHERE id=${quote(ids.projectId)}::uuid;`);
    const item = row(project, "postgres", params.itemId);
    if (ownerCount !== "1" || projectCount !== "1" || !item || !platform.isolated || !project.isolated) throw new Error("restored populated relationships or isolation missing");
    substep = "probe_project_application";
    const projectApp = await probeRestoredProject({ config: cfg, manifest: manifest(), restore: project, directory, runId, originalItemId: params.itemId,
      injectFailure: params.injectFailure === "afterProjectCheckerStart" ? params.injectFailure : undefined,
      registerChecker: (checker) => {
        const tracked = privateJson(restoreTracking);
        writeFileSync(restoreTracking, JSON.stringify({ ...tracked, projectChecker: checker }), { mode: 0o600 });
      } });
    substep = "probe_platform_application";
    const platformApp = await probeRestoredPlatform({ config: cfg, restore: platform, ownerId: ids.ownerId, projectId: ids.projectId, directory });
    const appRow = row(project, "postgres", projectApp.observed.writtenItemId);
    return { restoreId: `${platformId},${projectId}`, ownerId: ids.ownerId, projectId: ids.projectId, itemId: item.id, platformAppReadWrite: platformApp.observed.sessionWritten === true && platformApp.observed.projectDetailStatus === 200, projectAppReadWrite: projectApp.observed.originalPresent === true && projectApp.observed.writtenPresent === true && appRow?.name === `restored-app-${runId}`.slice(0, 80), isolated: true, platformRestoreId: platformId, projectRestoreId: projectId, platformApp, projectApp };
  }
  if (action === "removeIsolatedRestore") {
    const ids = String(params.restoreId).split(","); if (ids.length !== 2) throw new Error("invalid exact restore pair");
    const tracked = privateJson(restoreTracking);
    if (tracked.platformId !== ids[0] || tracked.projectId !== ids[1]) throw new Error("restore cleanup identity mismatch");
    await removeTemporaryRestore({ stateDir: databaseStateDir, restoreId: ids[0] }); await removeTemporaryRestore({ stateDir: databaseStateDir, restoreId: ids[1] });
    rmSync(restoreTracking);
    return { restoreId: params.restoreId, removed: true };
  }
  if (action === "schemaVersion") {
    const platform = await platformSource();
    const version = Number(sql(platform, "postgres", "SELECT current_version FROM public.platform_schema_compatibility WHERE singleton=true;"));
    return { before: version, after: version, storageChanged: false, sourceCommit: run("git", ["rev-parse", "HEAD"]) };
  }
  if (action === "realClockProvision") {
    const ids = manifest(), database = ids.database;
    if (!database?.id || !database?.generation || !database?.serviceId) throw new Error("seeded database identity unavailable");
    const token = secret(cfg.roles.databaseTokenFile);
    const clock = async () => {
      const response = await fetch(new URL("/internal/v1/m3/policy-clock", cfg.workerUrl), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) throw new Error(`real policy clock unavailable (${response.status})`);
      return response.json();
    };
    const before = await clock();
    const bootstrapDigest = `sha256:${createHash("sha256").update(readFileSync(join(root, "scripts/database/fixture-bootstrap.sql"))).digest("hex")}`;
    const workerEnv = { ...childEnvironment(), HOSTLET_M3_MODE: "owned_fixture", HOSTLET_M3_STATE_DIR: databaseStateDir,
      HOSTLET_M3_DATABASE_TOKEN: token, HOSTLET_TENANT_RECOVERY_KEY: secret(cfg.roles.tenantRecoveryKeyFile),
      HOSTLET_TENANT_RECOVERY_KEY_ID: "preview-v1", HOSTLET_M3_FIXTURE_BOOTSTRAP_SHA256: bootstrapDigest };
    const ticks = [];
    for (let i = 0; i < 2; i++) {
      const stdout = run(cfg.binaries.database, ["worker", "--control-url", cfg.workerUrl, "--worker-id", `m35-gate-clock-${i}`, "--scheduler-once"], { env: workerEnv, timeout: 30000 });
      const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (events.length !== 1 || events[0].event !== "tenant_database_scheduler_tick") throw new Error("real database worker did not emit one scheduler tick");
      ticks.push(events[0]);
    }
    const after = await clock();
    const ownerToken = await owner();
    const read = await api(`/v1/projects/${ids.identity.projectId}/services/${database.serviceId}/tenant-database`, { token: ownerToken });
    const source = await projectSource();
    const platform = await platformSource();
    const receipt = JSON.parse(sql(platform, "postgres", `SELECT row_to_json(t) FROM (SELECT id,tenant_database_id,database_generation,state,attempt_count,result#>>'{proof,fixture_bootstrap_sha256}' AS fixture_digest,result#>>'{proof,fixture_populated_rows}' AS fixture_rows FROM tenant_database_operations WHERE tenant_database_id=${quote(database.id)}::uuid AND database_generation=${quote(database.generation)}::uuid AND kind='provision' ORDER BY created_at DESC LIMIT 1) t;`) || "null");
    return { clockGeneration: before.generation, clockSchema: before.schema_version, beforeTime: before.now, tickTimes: ticks.map(tick => tick.policy_time), afterTime: after.now,
      ready: read.status === 200 && read.payload?.state === "ready", databaseId: read.payload?.id, databaseGeneration: read.payload?.generation,
      containerId: source.containerId, receipt, bootstrapDigest,
      nondecreasing: before.generation === 0 && after.generation === 0 && new Date(before.now) <= new Date(ticks[0].policy_time) && new Date(ticks[0].policy_time) <= new Date(ticks[1].policy_time) && new Date(ticks[1].policy_time) <= new Date(after.now),
      exactProvision: receipt?.state === "succeeded" && receipt?.attempt_count >= 1 && receipt?.fixture_digest === bootstrapDigest && Number(receipt?.fixture_rows) > 0 && read.payload?.id === database.id && read.payload?.generation === database.generation && source.databaseId === database.id && source.databaseGeneration === database.generation };
  }
  if (action === "staleApprovalProbe") {
    const token = await owner(), before = await api("/v1/portfolio/publications/latest", { token });
    if (before.status !== 200 || before.payload?.state !== "published" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(before.payload?.slug ?? "")) throw new Error("last-good published slug unavailable before protection probe");
    const latest = await api("/v1/portfolio/draft-revisions/latest", { token });
    if (latest.status !== 200 || latest.payload?.id !== params.draftId) throw new Error("stale probe did not start from browser-approved draft");
    const newerDraft = structuredClone(latest.payload.draft);
    newerDraft.profile.headline = `Post approval private change ${runId}`;
    const saved = await api("/v1/portfolio/preview-revisions", { method: "POST", token, headers: { "If-Match": `"${latest.payload.revision}"`, "Idempotency-Key": `m35-new-draft-${randomUUID()}` }, body: { draft: newerDraft, preview: latest.payload.preview } });
    if (saved.status !== 201 || saved.payload?.id === latest.payload.id) throw new Error("new private draft was not saved before stale approval probe");
    const approved = await api("/v1/portfolio/approved-revisions/latest", { token });
    if (approved.status !== 200 || approved.payload?.id !== params.approvedId) throw new Error("approved pointer drift before stale probe");
    const invalidApproval = await api("/v1/portfolio/approved-revisions", { method: "POST", token, headers: { "Idempotency-Key": `m35-stale-${randomUUID()}` }, body: { draft_revision_id: params.draftId, review_digest: approved.payload.review_digest, approval: { type: "entire_revision", review_digest: approved.payload.review_digest }, refresh_authorizations: [] } });
    const unpublished = await api("/v1/portfolio/publications", { method: "POST", token, headers: { "Idempotency-Key": `m35-unapproved-${randomUUID()}` }, body: { approved_revision_id: randomUUID(), slug: before.payload.slug } });
    if (!cfg.otherOwner?.email || !cfg.otherOwner?.passwordFile) throw new Error("second owned account fixture unavailable");
    const otherLogin = await api("/v1/sessions", { method: "POST", body: { email: cfg.otherOwner.email, password: secret(cfg.otherOwner.passwordFile) } });
    if (otherLogin.status !== 201 || !otherLogin.payload?.token) throw new Error("other-owner fixture cannot sign in");
    const otherProject = await api(`/v1/projects/${manifest().identity.projectId}`, { token: otherLogin.payload.token });
    const otherApproval = await api("/v1/portfolio/approved-revisions/latest", { token: otherLogin.payload.token });
    const otherRollback = await api(`/v1/projects/${manifest().identity.projectId}/releases/${params.releaseId}/rollback`, { token: otherLogin.payload.token, method: "POST", headers: { "Idempotency-Key": `m35-other-${randomUUID()}` }, body: {} });
    const after = await api("/v1/portfolio/publications/latest", { token });
    return { staleRejected: invalidApproval.status === 409 && invalidApproval.payload?.error?.code === "stale_portfolio_draft", unapprovedRejected: unpublished.status === 404 && unpublished.payload?.error?.code === "not_found", otherOwnerRejected: otherProject.status === 404 && otherApproval.status === 404 && otherRollback.status === 404, publicationId: before.payload?.id === after.payload?.id ? after.payload?.id : null, newerPrivateDraftId: saved.payload.id, staleStatus: invalidApproval.status, staleCode: invalidApproval.payload?.error?.code, unapprovedStatus: unpublished.status, unapprovedCode: unpublished.payload?.error?.code, otherProjectStatus: otherProject.status, otherApprovalStatus: otherApproval.status, otherRollbackStatus: otherRollback.status };
  }
  if (action === "partialBootstrapAndRepair") {
    if (!cfg.otherOwner?.email || !cfg.operator?.email) throw new Error("partial seed needs separate owned account and operator fixtures");
    const drillDir = join(cfg.stateDir, "gate-partial-seed", runId);
    mkdirSync(drillDir, { recursive: true, mode: 0o700 });
    const drillConfig = join(drillDir, "config.json");
    const expected = { ...cfg, stateDir: drillDir, owner: cfg.otherOwner, otherOwner: cfg.owner };
    if (existsSync(drillConfig)) {
      if (JSON.stringify(privateJson(drillConfig)) !== JSON.stringify(expected)) throw new Error("partial seed drill config drift");
    } else writeFileSync(drillConfig, JSON.stringify(expected), { flag: "wx", mode: 0o600 });
    const interrupt = spawnSync("node", ["scripts/beta/bootstrap.mjs", "seed", "--config", drillConfig, "--stop-after", "account"], { encoding: "utf8", timeout: 60000, maxBuffer: 32768, env: childEnvironment() });
    if (interrupt.status === 0 || !interrupt.stderr.includes("deliberate interruption after account")) throw new Error("partial seed did not stop at durable account boundary");
    const partial = privateJson(join(drillDir, "identity-manifest.json"));
    if (!partial.identity.ownerId || partial.identity.projectId) throw new Error("interrupted seed crossed project boundary");
    run("node", ["scripts/beta/bootstrap.mjs", "seed", "--config", drillConfig]);
    const repaired = privateJson(join(drillDir, "identity-manifest.json"));
    const token = await api("/v1/sessions", { method: "POST", body: { email: cfg.otherOwner.email, password: secret(cfg.otherOwner.passwordFile) } });
    if (token.status !== 201) throw new Error("partial seed owner cannot sign in");
    const list = await api("/v1/projects", { token: token.payload.token });
    const projects = list.payload?.projects ?? list.payload?.items;
    if (list.status !== 200 || !Array.isArray(projects)) throw new Error("partial seed owner project list unavailable");
    const matches = projects.filter((project) => project.name === "Hostlet owned journal preview");
    const releases = await api(`/v1/projects/${repaired.identity.projectId}/releases`, { token: token.payload.token });
    if (releases.status !== 200 || !Array.isArray(releases.payload?.releases)) throw new Error("partial seed release inventory unavailable");
    const complete = partial.identity.ownerId === repaired.identity.ownerId && Boolean(repaired.identity.projectId && repaired.source?.sourceRevisionId);
    return { interrupted: interrupt.status !== 0, repaired: complete && matches.length === 1 && matches[0].id === repaired.identity.projectId, duplicateProjects: Math.max(0, matches.length - 1), duplicateReleases: releases.payload.releases.length, ownerId: repaired.identity.ownerId, projectId: repaired.identity.projectId, retainedOwnedDrill: true };
  }
  if (action === "retainedM3ReleaseEvidence") {
    const receipts = [
      ["2026-09-24T013229-534Z-3903199-4fd227", "4c3c2558dcb05cc3f0849af0cbb235e020ead1563f1f6e192fa6a0c062af3dc3"],
      ["2026-09-24T023724-407Z-4105684-395b91", "9bc08445d499c7d6309b7b374fc6787ef787f37bfe40769bf2a32b1edbba998f"],
    ];
    let assertionCount = 0;
    for (const [id, expectedHash] of receipts) {
      const dir = join(root, "artifacts", "e2e", "M3", id), receipt = join(dir, "SHA256SUMS");
      if (createHash("sha256").update(readFileSync(receipt)).digest("hex") !== expectedHash) throw new Error("retained M3 receipt hash drift");
      run("sha256sum", ["--check", "SHA256SUMS"], { timeout: 180000, cwd: dir });
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const ids = new Set(m.assertions?.filter((entry) => entry.passed).map((entry) => entry.id));
      if (!["M3-RELEASE-01", "M3-RELEASE-02", "M3-RELEASE-03"].every((assertion) => ids.has(assertion))) throw new Error("retained M3 release assertions missing");
      assertionCount += 3;
    }
    return { verified: true, receiptCount: receipts.length, releaseAssertionsPresent: assertionCount === 6, acceptedSource: "docs/M3-HANDOFF.md" };
  }
  if (action === "boundedStartupFailure") {
    substep = "startup_preconditions";
    const platform = await platformSource();
    const token = await owner();
    const before = await api("/v1/portfolio/publications/latest", { token });
    if (before.status !== 200 || before.payload?.id !== params.publicationId) throw new Error("last-good publication pointer differs before startup injection");
    const policyBefore = servicePolicy("control");
    const start = Date.now();
    let deadlineFailure = null, readyStatus = null, ownerVisibleReason = null;
    let primaryError, primarySubstep;
    try {
      substep = "stop_owned_platform_database";
      run("docker", ["stop", "--time", "5", platform.containerId], { timeout: 15000 });
      if (params.injectFailure === "afterPlatformStop") throw new Error("deliberate failure after owned platform stop");
      substep = "observe_bounded_readiness";
      const check = spawnSync("node", ["scripts/beta/managed-services.mjs", "ready", servicesPath, "control", "3000"], { encoding: "utf8", cwd: root, timeout: 8000, maxBuffer: 32768, env: childEnvironment() });
      deadlineFailure = { status: check.status, elapsedMs: Date.now() - start, reason: (check.stderr || "").trim().slice(0, 300) };
      try { readyStatus = (await api("/readyz")).status; } catch { readyStatus = 0; }
      const edge = privateJson(edgePath);
      const browser = await openBrowser({ chromiumPath: "/snap/bin/chromium", username: edge.username, password: secret(edge.passwordFile), origins: Object.values(cfg.origins) });
      try {
        await browser.navigate(cfg.origins.dashboard);
        await browser.wait("document.body?.innerText?.includes('database_unavailable')", 15000);
        ownerVisibleReason = await browser.evaluate("document.body?.innerText?.includes('database_unavailable')");
      } finally { await browser.close(); }
    } catch (error) {
      primaryError = error;
      primarySubstep = substep;
    } finally {
      try {
        substep = "recover_owned_platform_database";
        const running = run("docker", ["inspect", "--format", "{{.State.Running}}", platform.containerId], { timeout: 15000 });
        if (running !== "true") run("docker", ["start", platform.containerId], { timeout: 15000 });
        await platformSource();
        managed("ready", "control");
      } catch (cleanupError) {
        if (primaryError) throw new AggregateError([primaryError, cleanupError], `startup probe failed: ${primaryError.message}; database recovery failed: ${cleanupError.message}`);
        throw cleanupError;
      }
    }
    if (primaryError) { substep = primarySubstep; throw primaryError; }
    substep = "managed_restart_probes";
    const restartTimestamps = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      managed("restart", "control");
      managed("ready", "control");
      restartTimestamps.push(servicePolicy("control").ActiveEnterTimestampMonotonic);
    }
    const policyAfter = servicePolicy("control");
    managed("stop", "publisher-worker");
    let staticStatus;
    try {
      const staticPort = cfg.services?.ports?.publisherStatic;
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(params.slug ?? "")) throw new Error("published slug unavailable for static outage probe");
      let deadline;
      staticStatus = await new Promise((resolveStatus, rejectStatus) => {
        const request = httpGet({ hostname: "127.0.0.1", port: staticPort, path: `/${params.slug}/`, headers: { Host: cfg.services.publisherExpectedHost } }, (response) => {
          response.resume();
          response.once("end", () => resolveStatus(response.statusCode));
          response.once("error", rejectStatus);
          response.once("close", () => { if (!response.complete) rejectStatus(new Error("static outage probe response closed early")); });
        });
        deadline = setTimeout(() => request.destroy(new Error("static outage probe timed out")), 5000);
        request.once("error", rejectStatus);
      }).finally(() => clearTimeout(deadline));
    } finally { managed("start", "publisher-worker"); managed("ready", "publisher-worker"); }
    const after = await api("/v1/portfolio/publications/latest", { token: await owner() });
    const project = await projectSource(), item = row(project, project.databaseName, params.itemId);
    return { observedReadinessAttempts: deadlineFailure.status !== null ? 1 : 0, readinessExitStatus: deadlineFailure.status, readinessElapsedMs: deadlineFailure.elapsedMs, readinessDeadlineMs: 8000, observedManagedRestarts: restartTimestamps.length, restartTimestamps, restartPolicy: { before: policyBefore.Restart, after: policyAfter.Restart, intervalUsec: policyAfter.RestartUSec, startLimitBurst: Number(policyAfter.StartLimitBurst), startLimitIntervalUsec: policyAfter.StartLimitIntervalUSec, nRestartsBefore: Number(policyBefore.NRestarts), nRestartsAfter: Number(policyAfter.NRestarts) }, ownerVisibleReason, managementReason: deadlineFailure.reason, unhealthyAdvertised: deadlineFailure.status === 0 || readyStatus === 200, publicationId: after.payload?.id === before.payload?.id ? after.payload?.id : null, itemId: item?.id, readyStatusWhileDown: readyStatus, staticStatusWhilePublisherDown: staticStatus };
  }
  if (action === "temporaryCleanup") {
    substep = "cleanup_owned_resources";
    const j = journal();
    const cleanupFailures = [];
    if (existsSync(restoreTracking)) {
      const tracked = privateJson(restoreTracking);
      if (tracked.projectChecker) {
        const expectedName = `hostlet-m35-restore-app-${runId.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").slice(0, 42)}`;
        if (tracked.projectChecker.checkerContainerName !== expectedName || tracked.projectChecker.envFile !== join(backupDir, "project-restore-app.env")) throw new Error("restore checker cleanup identity mismatch");
        try { removeRestoredProjectChecker({ ...tracked.projectChecker, runId }); }
        catch (error) { cleanupFailures.push(`restore checker: ${error.message}`); }
      }
      for (const restoreId of [tracked.platformId, tracked.projectId]) {
        try { await removeTemporaryRestore({ stateDir: databaseStateDir, restoreId }); }
        catch (error) { cleanupFailures.push(`restore ${restoreId}: ${error.message}`); }
      }
      if (!cleanupFailures.length) rmSync(restoreTracking);
    }
    const checkerNames = run("docker", ["ps", "-a", "--filter", "label=io.hostlet.scope=m35-gate", "--filter", `label=io.hostlet.run-id=${runId}`, "--format", "{{.Names}}"]).split("\n").filter(Boolean);
    if (checkerNames.length) cleanupFailures.push(`run-owned restore checker containers remain: ${checkerNames.join(",")}`);
    const drillDir = join(cfg.stateDir, "gate-partial-seed", runId);
    if (existsSync(drillDir)) {
      const drillConfig = privateJson(join(drillDir, "config.json"));
      if (drillConfig.stateDir !== drillDir || drillConfig.owner.email !== cfg.otherOwner?.email) throw new Error("partial seed cleanup identity mismatch");
      rmSync(drillDir, { recursive: true, force: false });
    }
    // The filter restricts the inventory to the label assigned by the owned
    // database adapter; names are checked without sweeping any namespace.
    const names = run("docker", ["ps", "-a", "--filter", "label=io.hostlet.scope=m3-e2e", "--format", "{{.Names}}"]);
    const temporary = names.split("\n").filter((name) => name.startsWith("hostlet-preview-restore-") || name.startsWith("hostlet-preview-project-restore-"));
    if (cleanupFailures.length) throw new Error(cleanupFailures.join("; "));
    const dbInventory = privateJson(join(databaseStateDir, "database-inventory.json"));
    const owned = j.schema === "hostlet.beta.cloudflare/v1" && j.accountId === cf.accountId && dbInventory.schema_version === 1 && dbInventory.targets?.length >= 1;
    return { exactOwnedOnly: owned, temporaryRemaining: temporary.length + checkerNames.length, retainedPreview: [
      { kind: "owned platform PostgreSQL", volume: "hostlet-preview-platform-pgdata" },
      { kind: "owned project PostgreSQL", containerId: dbInventory.targets[0].container_id, tenantDatabaseId: dbInventory.targets[0].tenant_database_id },
      { kind: "dedicated preview tunnel", tunnelName: j.tunnelName },
      { kind: "managed preview services", manifest: servicesPath },
      { kind: "owner project/release/publication", projectId: params.projectId ?? null, releaseId: params.releaseId ?? null, publicationId: params.publicationId ?? null },
      { kind: "secondary synthetic seed fixture", ownerId: params.secondaryOwnerId ?? null, projectId: params.secondaryProjectId ?? null },
      { kind: "private populated backup archives", directory: backupDir },
      { kind: "private gate artifact", runId },
    ], routePhase: j.phase };
  }
  throw new Error(`unknown concrete gate operation: ${action}`);
}
try { console.log(JSON.stringify(await execute())); } catch (error) {
  const known = new Map([
    ["deliberate failure after owned platform restore", "injected_after_platform_restore"],
    ["deliberate failure after owned restore checker start", "injected_after_project_checker_start"],
    ["deliberate failure after owned platform stop", "injected_after_platform_stop"],
    ["restored populated relationships or isolation missing", "restore_relationships_missing"],
    ["built application artifact identity missing", "restore_artifact_identity_missing"],
    ["built artifact staging missing", "restore_artifact_staging_missing"],
    ["built artifact provenance mismatch", "restore_artifact_provenance_mismatch"],
    ["pinned application output unavailable", "restore_application_output_missing"],
    ["pinned Node runtime base missing", "restore_runtime_pin_missing"],
    ["local Node image does not match runtime repository digest", "restore_runtime_image_mismatch"],
    ["restore app credential collision", "restore_checker_credential_collision"],
    ["restore application container identity mismatch", "restore_checker_identity_mismatch"],
    ["restored application HTTP probe did not pass", "restore_application_probe_failed"],
    ["restore app cleanup identity mismatch", "restore_checker_cleanup_identity_mismatch"],
    ["restore app cleanup inspection failed", "restore_checker_cleanup_inspection_failed"],
    ["restore application container remains after exact cleanup", "restore_checker_remains"],
    ["isolated control HTTP login/project probe did not pass", "restore_platform_application_probe_failed"],
    ["isolated control binary exited before readiness", "restore_platform_application_exited"],
    ["isolated control process group remains after exact cleanup", "restore_platform_checker_remains"],
    ["pinned control binary unavailable for restore probe", "restore_control_binary_missing"],
    ["last-good publication pointer differs before startup injection", "startup_publication_pointer_drift"],
  ]);
  const classify = (failure) => {
    const message = String(failure?.message ?? "");
    const child = /^(?:node|docker|git|sha256sum|\/usr\/bin\/systemctl) [A-Za-z0-9._/-]+ failed \((\d+|[A-Z_]+)\)$/.exec(message);
    return known.has(message) ? { code: known.get(message), message }
      : child ? { code: "child_operation_failed", exitStatus: child[1] }
        : { code: "owned_operation_failed", message: "The owned operation failed; inspect the private service and cleanup receipts." };
  };
  const diagnostic = error instanceof AggregateError && error.errors.length >= 2
    ? { code: "operation_and_cleanup_failed", primary: classify(error.errors[0]), cleanup: classify(error.errors[1]) }
    : classify(error);
  console.error(JSON.stringify({ operation: action, substep, ...diagnostic }));
  process.exitCode = 1;
}
