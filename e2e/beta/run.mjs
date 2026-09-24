#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./browser.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCENARIOS = ["M35-PLACE-01", "M35-ACCESS-01", "M35-COMPOSE-01", "M35-DB-CLOCK-01", "M35-EDIT-01", "M35-APPROVAL-01", "M35-STATIC-01", "M35-SEED-01", "M35-RECOVER-01", "M35-START-01", "M35-CLEAN-01"];
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => { if (item.startsWith("--")) pairs.push([item.slice(2), all[index + 1]?.startsWith("--") ? true : all[index + 1] ?? true]); return pairs; }, []));
const requestedRunId = args["run-id"] || new Date().toISOString().replace(/[:.]/g, "-");
const invalidRunId = !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(requestedRunId);
const collidedRunId = !invalidRunId && existsSync(join(ROOT, "artifacts/e2e/M3.5", requestedRunId));
const runId = invalidRunId ? `invalid-id-${Date.now()}` : collidedRunId ? `${requestedRunId}-collision-${Date.now()}` : requestedRunId;
const artifact = join(ROOT, "artifacts/e2e/M3.5", runId);
mkdirSync(dirname(artifact), { recursive: true, mode: 0o700 });
mkdirSync(artifact, { recursive: false, mode: 0o700 });
chmodSync(artifact, 0o700);
const state = { schema: "hostlet.e2e.m3.5/v1", runId, status: "incomplete", startedAt: new Date().toISOString(), source: {}, inputs: {}, prerequisites: {}, assertions: [], observations: {}, cleanup: [], errors: [], retained: [] };
const md = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaFile = (path) => hash(readFileSync(path));
const privateJson = (path) => {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error(`private input must be a mode-0600 regular file: ${basename(path)}`);
  return JSON.parse(readFileSync(absolute, "utf8"));
};
const secret = (path) => {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error(`secret input must be mode 0600: ${basename(path)}`);
  return readFileSync(path, "utf8").trim();
};
const childEnvironment = () => Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const run = (program, argv, { timeout = 60000, env } = {}) => {
  const result = spawnSync(program, argv, { cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 1024 * 1024, env: env ?? childEnvironment() });
  if (result.error || result.status !== 0) throw new Error(`${basename(program)} operation failed (${result.status ?? result.error?.code ?? "unknown"})`);
  return result.stdout.trim();
};
const git = (...argv) => run("git", argv);
const check = (id, description, observed, passed) => {
  const record = { id, description, passed: Boolean(passed), observed };
  state.assertions.push(record);
  if (!record.passed) throw new Error(`${id}: ${description}`);
  return record;
};
const publicValue = (value) => typeof value === "string" ? value.replaceAll(/(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/g, "[REDACTED]") : value;
const progress = () => {
  writeFileSync(join(artifact, "manifest.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  const lines = [`# M3.5 deployed gate ${runId}`, "", `Status: **${state.status}**`, "", `Source: ${state.source.commit ?? "unavailable"}`, `Started: ${state.startedAt}`, `Ended: ${state.endedAt ?? "incomplete"}`, `Rerun: ${state.inputs.rerun ?? "unavailable"}`, "", "| Assertion | Result | Observation |", "| --- | --- | --- |", ...state.assertions.map((item) => `| ${item.id} | ${item.passed ? "PASS" : "FAIL"} | ${md(JSON.stringify(item.observed))} |`), "", "## Errors", "", ...state.errors.map((item) => `- ${md(item.kind)}: ${md(item.message)}`), "", "## Retained preview resources", "", ...state.retained.map((item) => `- ${md(JSON.stringify(item))}`), "", "## Cleanup", "", ...state.cleanup.map((item) => `- ${md(item.resource)}: ${md(item.result)}`), "", "SHA256SUMS is an external receipt and excludes itself.", ""];
  writeFileSync(join(artifact, "REPORT.md"), lines.join("\n"), { mode: 0o600 });
};
progress(); // Artifact exists even if parsing, inventory, or setup fails.

let browser;
let config;
let edge;
let cutoverActive = false;
let temporaryRestore;
let interrupted = false;
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; });
const assertLive = () => { if (interrupted) throw new Error("gate interrupted by signal"); };
const basic = () => `Basic ${Buffer.from(`${edge.username}:${edge.password}`).toString("base64")}`;
const request = async (origin, path, { method = "GET", body, token, authorized = true, timeout = 20000 } = {}) => {
  const response = await fetch(new URL(path, origin), { method, headers: { ...(authorized ? { Authorization: basic() } : {}), ...(token ? { "X-Hostlet-Authorization": `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(timeout) });
  const content = await response.text();
  let payload; try { payload = JSON.parse(content); } catch { payload = null; }
  return { status: response.status, payload, text: content.slice(0, 12000), headers: Object.fromEntries(["content-type", "location"].map((key) => [key, response.headers.get(key)])) };
};
const safe = ({ status, payload, text, headers }) => ({ status, payload: payload && typeof payload === "object" ? { ...payload, token: undefined } : undefined, textLength: text?.length ?? 0, headers });
const stoppedUnits = new Set();
let outageStarted = false;
const service = (verb, unit) => {
  const output = run("node", ["scripts/beta/managed-services.mjs", verb, ...(verb === "ready" ? [args["services-manifest"], unit, "30000"] : [unit])], { timeout: 45000 });
  if (verb === "stop") stoppedUnits.add(unit);
  if (verb === "start" || verb === "restart") stoppedUnits.delete(unit);
  return output;
};
const provider = (verb, extra = []) => run("python3", ["scripts/beta/cloudflare.py", verb, "--config", args["cloudflare-config"], ...extra], {
  timeout: 180000,
  env: { ...childEnvironment(), M35_CF_DNS_TOKEN: process.env.M35_CF_DNS_TOKEN, M35_CF_TUNNEL_TOKEN: process.env.M35_CF_TUNNEL_TOKEN },
});
const routeOperation = (name) => {
  const cf = privateJson(args["cloudflare-config"]);
  const journalPath = join(cf.workDir, "cloudflare-journal.json");
  const journal = () => privateJson(journalPath);
  const status = () => {
    const result = JSON.parse(provider("status"));
    const exactPriorTarget = hash(JSON.stringify(journal().beforeDns?.["beta.hostlet.cloud"]?.[0]?.content ?? ""));
    return { ...result, exactPriorTarget };
  };
  if (name === "routeInventoryBefore") {
    if (!existsSync(journalPath)) provider("inventory", ["--before", args["cloudflare-before"]]);
    const before = journal();
    const observed = status();
    if (before.phase === "inventoried") provider("prepare");
    if (before.beforeSnapshotSha256 !== shaFile(args["cloudflare-before"])) throw new Error("provider before-state digest drift");
    if (!["prepared", "reversed", "inventoried"].includes(observed.phase)) throw new Error("preview route already cut over before gate");
    return { owned: true, exactPriorTarget: observed.exactPriorTarget, siblingRecords: (observed.exactRecordCounts?.["beta-demo.hostlet.cloud"] ?? -1) + (observed.exactRecordCounts?.["beta-portfolio.hostlet.cloud"] ?? -1), phase: observed.phase };
  }
  if (name === "routeCutover") { privateJson(args["ready-proof"]); provider("cutover", ["--ready-proof", args["ready-proof"]]); return status(); }
  if (name === "routeReverse") { provider("reverse"); return status(); }
  if (name === "routeStatus") return status();
  throw new Error("unknown exact route operation");
};
const op = (name, replacements = {}) => {
  if (name.startsWith("route")) return routeOperation(name);
  const output = run("node", ["e2e/beta/operations.mjs", name, "--config", args.config, "--edge-credentials", args["edge-credentials"], "--cloudflare-config", args["cloudflare-config"], "--cloudflare-before", args["cloudflare-before"], "--ready-proof", args["ready-proof"], "--services-manifest", args["services-manifest"], "--run-id", runId, "--params", JSON.stringify(replacements)], { timeout: 180000 });
  let result; try { result = JSON.parse(output); } catch { throw new Error(`owned operation ${name} did not return JSON`); }
  return result;
};
const owner = async (path, settings = {}) => request(config.origins.dashboard, path, { ...settings, token: state.privateOwnerToken });
const identity = () => privateJson(join(config.stateDir, "identity-manifest.json"));
const route = async () => {
  const id = identity().identity.projectId;
  const response = await owner(`/v1/projects/${id}/releases`);
  check("release-history-readable", "owner can read durable release history", { status: response.status }, response.status === 200 && Boolean(response.payload?.current_route?.release_id));
  return response.payload;
};
const browserStep = async (url, expression) => {
  const page = await browser.navigate(url);
  await browser.wait(expression);
  return page;
};

async function execute() {
  assertLive();
  state.source = { commit: git("rev-parse", "HEAD"), clean: git("status", "--porcelain=v1", "--untracked-files=all") === "", harnessSha256: hash(Buffer.concat([readFileSync(fileURLToPath(import.meta.url)), readFileSync(new URL("./operations.mjs", import.meta.url)), readFileSync(new URL("./browser.mjs", import.meta.url)), readFileSync(new URL("./restore-app.mjs", import.meta.url))])), nodeVersion: process.version, postgresImagePin: readFileSync(join(ROOT, "e2e/postgres-image.txt"), "utf8").trim(), fixtureDigests: { demoServer: shaFile(join(ROOT, "e2e/fixtures/m3/fullstack-v1/apps/api/src/server.mjs")), demoBrowser: shaFile(join(ROOT, "e2e/fixtures/m3/fullstack-v1/apps/web/src/main.js")) } };
  if (invalidRunId) throw new Error("invalid run id");
  if (collidedRunId) throw new Error("requested run id already has an artifact; original preserved");
  check("source-clean", "gate source tree is clean", { clean: state.source.clean }, !args["require-clean"] || state.source.clean);
  config = privateJson(args.config);
  const edgeInput = privateJson(args["edge-credentials"]);
  edge = { username: edgeInput.username, password: secret(edgeInput.passwordFile) };
  if (!edge.username || !edge.password || config.schema !== "hostlet.beta.config/v1") throw new Error("invalid private preview inputs");
  for (const key of ["dashboard", "demo", "portfolio"]) if (new URL(config.origins[key]).protocol !== "https:") throw new Error(`configured ${key} origin is not HTTPS`);
  state.inputs = { configDigest: shaFile(args.config), edgeCredentialFileDigest: shaFile(args["edge-credentials"]), origins: config.origins, rerun: `node e2e/beta/run.mjs --config ${args.config} --edge-credentials ${args["edge-credentials"]} --cloudflare-config ${args["cloudflare-config"]} --cloudflare-before ${args["cloudflare-before"]} --ready-proof ${args["ready-proof"]} --services-manifest ${args["services-manifest"]} --require-clean` };
  state.source.installedReleaseCommit = config.releaseCommit;
  state.source.installedBinaryDigests = Object.fromEntries(Object.entries(config.binaries ?? {}).map(([name, path]) => [name, shaFile(path)]));
  state.source.toolDigests = Object.fromEntries(["scripts/beta/bootstrap.mjs", "scripts/beta/database.mjs", "scripts/beta/managed-services.mjs", "scripts/beta/cloudflare.py", "scripts/beta/runtime.mjs"].map((path) => [path, shaFile(join(ROOT, path))]));
  state.inputs.servicesManifestDigest = shaFile(args["services-manifest"]);
  state.inputs.runtimeBaseManifestDigest = shaFile(config.runtimeNodeBases["24"].manifest);
  check("source-installed", "installed release and exact product binaries belong to the clean gate commit", { releaseCommit: config.releaseCommit, binaries: state.source.installedBinaryDigests }, config.releaseCommit === state.source.commit && Object.keys(state.source.installedBinaryDigests).sort().join(",") === "builder,control,database,publisher,runtime" && Object.values(config.binaries).every((path) => path.includes(`/releases/${config.releaseCommit}/target/debug/`)));
  state.source.chromiumVersion = run(args.chromium || "/snap/bin/chromium", ["--version"]);
  const before = op("routeInventoryBefore");
  check("M35-PLACE-01-before", "exact original route and ownership are inventoried before mutation", { owned: before.owned, exactPriorTargetRecorded: Boolean(before.exactPriorTarget), siblingRecords: before.siblingRecords }, before.owned === true && Boolean(before.exactPriorTarget) && before.siblingRecords === 0);
  for (const unit of ["dashboard", "control", "gateway", "publisher-static", "tunnel", "demo-gateway", "provider"]) {
    state.prerequisites[unit] = JSON.parse(service("ready", unit));
  }
  state.prerequisites.providerInventoryPhase = before.phase;
  cutoverActive = true; // A failed command can already have changed one record.
  op("routeCutover");
  const stagedStatus = op("routeStatus");
  check("M35-PLACE-01-cutover", "all three HTTPS hosts reach the exact staged preview route", { staged: stagedStatus.phase, exactRecords: stagedStatus.exactRecordCounts }, stagedStatus.phase === "cutover" && Object.values(stagedStatus.exactRecordCounts ?? {}).length === 3 && Object.values(stagedStatus.exactRecordCounts).every((value) => value === 1));
  state.observations.placement = { before, staged: stagedStatus };

  const hosts = Object.entries(config.origins);
  for (const [name, origin] of hosts) {
    const denied = await request(origin, "/", { authorized: false });
    check(`M35-ACCESS-01-anonymous-${name}`, "anonymous host request has no private content", safe(denied), denied.status === 401 && !denied.text.includes(config.owner.email));
    if (name === "dashboard") {
      const malformed = await request(origin, "/v1/me", { authorized: true, token: "malformed" });
      check("M35-ACCESS-01-malformed", "malformed application session cannot read owner account", safe(malformed), malformed.status === 401 && !malformed.text.includes(config.owner.email));
    }
  }
  const signup = await request(config.origins.dashboard, "/v1/accounts", { method: "POST", body: { email: "unwanted@preview.invalid", password: "unwanted-password-123" } });
  check("M35-ACCESS-01-signup", "public account creation is rejected at edge", safe(signup), signup.status === 403);
  const bareApi = await request(config.origins.dashboard, "/v1/me", { authorized: false });
  check("M35-ACCESS-01-direct-api", "network-accessible control API also requires edge access", safe(bareApi), bareApi.status === 401);
  const login = await request(config.origins.dashboard, "/v1/sessions", { method: "POST", body: { email: config.owner.email, password: secret(config.owner.passwordFile) } });
  check("M35-ACCESS-01-owner-login", "owner signs in through deployed HTTPS entry", { status: login.status, hasToken: Boolean(login.payload?.token) }, login.status === 201 && Boolean(login.payload?.token));
  const revoked = await request(config.origins.dashboard, "/v1/sessions/current", { method: "DELETE", token: login.payload.token });
  const expired = await request(config.origins.dashboard, "/v1/me", { token: login.payload.token });
  check("M35-ACCESS-01-expired", "revoked owner session cannot read private data", { revokeStatus: revoked.status, accountStatus: expired.status }, revoked.status < 300 && expired.status === 401);
  const freshLogin = await request(config.origins.dashboard, "/v1/sessions", { method: "POST", body: { email: config.owner.email, password: secret(config.owner.passwordFile) } });
  check("M35-ACCESS-01-fresh-session", "owner can sign in again after session revocation", { status: freshLogin.status }, freshLogin.status === 201 && Boolean(freshLogin.payload?.token));
  state.privateOwnerToken = freshLogin.payload.token;
  const manifestBefore = identity();
  check("M35-COMPOSE-01-identities", "owned account, project and exact source are durable", { ownerId: manifestBefore.identity.ownerId, projectId: manifestBefore.identity.projectId, sourceRevisionId: manifestBefore.source.sourceRevisionId }, Boolean(manifestBefore.identity.ownerId && manifestBefore.identity.projectId && manifestBefore.source.sourceRevisionId));
  const released = await route();
  const releaseId = released.current_route.release_id;
  const demoBefore = await request(config.origins.demo, "/api/items");
  check("M35-COMPOSE-01-demo", "isolated Node demo serves database-backed items", { status: demoBefore.status, apiVersion: demoBefore.payload?.api_version, items: demoBefore.payload?.items?.length }, demoBefore.status === 200 && Array.isArray(demoBefore.payload?.items));
  check("M35-COMPOSE-01-release", "control reports routed release and distinct project database", { releaseId, tenantDatabaseId: released.releases?.find((entry) => entry.id === releaseId)?.tenant_database_id }, Boolean(released.releases?.find((entry) => entry.id === releaseId)?.tenant_database_id));
  const clockBefore = op("realClockProvision");
  check("M35-DB-CLOCK-01-provision", "real generation-zero database scheduler accepts advancing time and exact provision receipt", clockBefore, clockBefore.clockGeneration === 0 && clockBefore.clockSchema === 1 && clockBefore.nondecreasing === true && clockBefore.exactProvision === true && clockBefore.ready === true && /^[a-f0-9]{64}$/.test(clockBefore.containerId));

  const requests = [];
  browser = await openBrowser({ chromiumPath: args.chromium || "/snap/bin/chromium", username: edge.username, password: edge.password, origins: Object.values(config.origins), onRequest: (requestEvent) => requests.push(requestEvent) });
  await browserStep(config.origins.dashboard, "Boolean(document.querySelector('[data-testid=auth-form]'))");
  await browser.fill('[data-testid="auth-form"] input[name="email"]', config.owner.email);
  await browser.fill('[data-testid="auth-form"] input[name="password"]', secret(config.owner.passwordFile));
  await browser.click('[data-testid="auth-form"] button[type="submit"]');
  await browser.wait("Boolean(document.querySelector('[data-testid=signed-in-user]'))", 30000);
  await browser.wait("Boolean(document.querySelector('[data-testid=preview-editor]'))", 30000);
  check("M35-ACCESS-01-browser", "fresh Chromium owner session reaches persisted editor", { url: config.origins.dashboard, signedIn: true }, true);
  await browser.wait(`Boolean(document.querySelector('[data-testid="preview-project-editor"][data-project-id=${JSON.stringify(manifestBefore.identity.projectId)}]'))`, 30000);
  check("M35-COMPOSE-01-browser-project", "Chromium editor shows the seeded durable project", { projectId: manifestBefore.identity.projectId }, true);
  const intro = `M3.5 owner edit ${runId}`;
  await browser.fill('textarea[name="profile.introduction"]', intro);
  await browser.click('[data-testid="preview-save"]');
  await browser.wait(`document.querySelector('[data-testid=preview-editor-notice]')?.textContent?.includes('saved') === true`, 30000);
  const saved = await owner("/v1/portfolio/draft-revisions/latest");
  check("M35-EDIT-01-narrative", "browser edit is committed to control PostgreSQL", { revisionId: saved.payload?.id, introductionMatches: saved.payload?.draft?.profile?.introduction === intro }, saved.status === 200 && saved.payload?.draft?.profile?.introduction === intro);
  const itemName = `M3.5 item ${runId}`.slice(0, 80);
  const demoPage = await browserStep(config.origins.demo, "Boolean(document.querySelector('#item-form'))");
  check("M35-COMPOSE-01-browser-demo", "Chromium loaded routed demo frontend", { url: demoPage.url, title: demoPage.title }, demoPage.url === config.origins.demo + "/");
  await browser.fill("#item-name", itemName);
  await browser.click("#item-form button");
  await browser.wait(`Array.from(document.querySelectorAll('#items li')).some(e=>e.textContent===${JSON.stringify(itemName)})`, 30000);
  const itemAfterWrite = await request(config.origins.demo, "/api/items");
  const item = itemAfterWrite.payload?.items?.find((entry) => entry.name === itemName);
  check("M35-EDIT-01-demo-write", "browser-created row is returned by real demo API", { id: item?.id, name: item?.name }, itemAfterWrite.status === 200 && Boolean(item?.id));
  const directRow = op("queryProjectRow", { itemId: item.id });
  check("M35-EDIT-01-db-query", "independent project PostgreSQL query agrees with demo", { id: directRow.id, name: directRow.name }, String(directRow.id) === String(item.id) && directRow.name === itemName);
  const pointersBefore = { route: releaseId, publication: (await owner("/v1/portfolio/publications/latest")).payload?.id ?? null };
  service("restart", "control"); service("restart", "runtime"); service("restart", "demo-gateway");
  service("ready", "control"); service("ready", "runtime"); service("ready", "demo-gateway");
  await browserStep(config.origins.dashboard, "Boolean(document.querySelector('[data-testid=preview-editor]'))");
  const browserEditAfter = await browser.evaluate(`document.querySelector('textarea[name="profile.introduction"]')?.value === ${JSON.stringify(intro)}`);
  const itemAfterRestart = await request(config.origins.demo, "/api/items");
  const pointerAfterRestart = await route();
  const publicationAfterRestart = await owner("/v1/portfolio/publications/latest");
  check("M35-EDIT-01-restart", "owner edit, tenant row, release and publication pointer survive managed restart", { browserEditAfter, rowFound: itemAfterRestart.payload?.items?.some((entry) => entry.id === item.id && entry.name === itemName), route: pointerAfterRestart.current_route.release_id, publicationId: publicationAfterRestart.payload?.id ?? null }, browserEditAfter && itemAfterRestart.payload?.items?.some((entry) => entry.id === item.id && entry.name === itemName) && pointerAfterRestart.current_route.release_id === releaseId && (publicationAfterRestart.payload?.id ?? null) === pointersBefore.publication);

  await browser.click('[data-testid="publication-load-review"]');
  await browser.wait("Boolean(document.querySelector('[data-testid=publication-review]'))");
  await browser.click('[data-testid="publication-entire-confirm"]');
  await browser.click('[data-testid="publication-approve"]');
  await browser.wait("Boolean(document.querySelector('[data-testid=publication-approved-state]'))");
  const approval = await owner("/v1/portfolio/approved-revisions/latest");
  check("M35-APPROVAL-01-exact", "browser approves exact saved owner revision", { draftId: saved.payload.id, approvedDraftId: approval.payload?.source_draft_revision_id }, approval.status === 200 && approval.payload?.source_draft_revision_id === saved.payload.id);
  await browser.fill('[data-testid="publication-slug"]', `m35-${runId}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-"));
  await browser.click('[data-testid="publication-publish"]');
  await browser.wait("Boolean(document.querySelector('[data-testid=publication-job][data-publication-state=published]'))", 60000);
  const published = await owner("/v1/portfolio/publications/latest");
  check("M35-APPROVAL-01-published", "approved revision becomes durable published pointer", { id: published.payload?.id, approvedRevisionId: published.payload?.approved_revision_id }, published.status === 200 && published.payload?.approved_revision_id === approval.payload.id && published.payload?.state === "published");
  const portfolioUrl = new URL(`/${published.payload.slug}/`, config.origins.portfolio).href;
  const site = await browserStep(portfolioUrl, `document.body?.innerText?.includes(${JSON.stringify(intro)})`);
  check("M35-APPROVAL-01-site", "restricted independently served site contains approved text", { url: site.url, introductionPresent: site.text.includes(intro) }, site.text.includes(intro));
  const siteLinks = await browser.evaluate("Array.from(document.querySelectorAll('a[href]')).map(a=>a.href)");
  const projectPageUrl = siteLinks.find((link) => link.startsWith(portfolioUrl + "projects/"));
  check("M35-APPROVAL-01-project-link", "approved homepage links to its project detail", { projectLinkPresent: Boolean(projectPageUrl) }, Boolean(projectPageUrl));
  const projectPage = await browserStep(projectPageUrl, "Boolean(document.body?.innerText)");
  const projectLinks = await browser.evaluate("Array.from(document.querySelectorAll('a[href]')).map(a=>a.href)");
  check("M35-APPROVAL-01-links", "approved project detail links to configured HTTPS demo", { projectUrl: projectPage.url, demoLinkPresent: projectLinks.some((link) => link.startsWith(config.origins.demo + "/")) }, projectLinks.some((link) => link.startsWith(config.origins.demo + "/")));
  await browserStep(config.origins.dashboard, "Boolean(document.querySelector('[data-testid=preview-editor]'))");
  const unapproved = `Unapproved ${runId}`;
  await browser.fill('textarea[name="profile.introduction"]', unapproved);
  const unpublishedSite = await browserStep(portfolioUrl, `document.body?.innerText?.includes(${JSON.stringify(intro)})`);
  check("M35-APPROVAL-01-unapproved", "unsaved narrative cannot replace approved static content", { approvedPresent: unpublishedSite.text.includes(intro), unapprovedPresent: unpublishedSite.text.includes(unapproved) }, unpublishedSite.text.includes(intro) && !unpublishedSite.text.includes(unapproved));
  const stale = op("staleApprovalProbe", { draftId: saved.payload.id, approvedId: approval.payload.id, releaseId });
  check("M35-APPROVAL-01-stale", "stale, unapproved and other-owner writes preserve last good publication", stale, stale.staleRejected === true && stale.unapprovedRejected === true && stale.otherOwnerRejected === true && stale.publicationId === published.payload.id);

  outageStarted = true;
  service("stop", "dashboard"); service("stop", "control"); service("stop", "demo-gateway"); service("stop", "runtime"); service("stop", "provider");
  const offlineRequests = [];
  const offlineResponses = [];
  await browser.close(); browser = await openBrowser({ chromiumPath: args.chromium || "/snap/bin/chromium", username: edge.username, password: edge.password, origins: Object.values(config.origins), onRequest: (event) => offlineRequests.push(event), onResponse: (event) => offlineResponses.push(event) });
  const staticHome = await browserStep(portfolioUrl, `document.body?.innerText?.includes(${JSON.stringify(intro)})`);
  const detailLink = await browser.evaluate("document.querySelector('a[href*=" + JSON.stringify("/projects/") + "]')?.getAttribute('href')");
  check("M35-STATIC-01-detail-link", "approved site links to a project detail", { path: detailLink }, typeof detailLink === "string" && new URL(detailLink, portfolioUrl).href.startsWith(portfolioUrl + "projects/"));
  const detail = await browserStep(new URL(detailLink, portfolioUrl).href, "Boolean(document.body?.innerText)");
  const dependent = offlineRequests.filter((event) => event.origin !== new URL(config.origins.portfolio).origin);
  const staticResponses = offlineResponses.filter((event) => event.origin === new URL(config.origins.portfolio).origin && event.path.startsWith(new URL(portfolioUrl).pathname));
  const staticAssets = staticResponses.filter((event) => event.path.endsWith("/assets/site.css"));
  check("M35-STATIC-01-independent", "fresh browser loads home, detail and CSS with HTTP 200 while dashboard/control/demo/runtime/provider are stopped", { home: staticHome.url, detail: detail.url, dependentRequests: dependent, staticResponses, unapprovedHeadlinePresent: staticHome.text.includes(`Post approval private change ${runId}`) }, staticHome.text.includes(intro) && !staticHome.text.includes(`Post approval private change ${runId}`) && detail.text.length > 0 && dependent.length === 0 && staticResponses.some((event) => event.path === new URL(portfolioUrl).pathname && event.status === 200) && staticResponses.some((event) => event.path === new URL(detailLink, portfolioUrl).pathname && event.status === 200) && staticAssets.length > 0 && staticResponses.every((event) => event.status === 200));
  const anonymousStatic = await request(config.origins.portfolio, new URL(portfolioUrl).pathname, { authorized: false });
  check("M35-STATIC-01-private", "published static content still denies anonymous access", safe(anonymousStatic), anonymousStatic.status === 401);
  service("start", "provider"); service("start", "control"); service("start", "runtime"); service("start", "demo-gateway"); service("start", "dashboard");
  service("ready", "control"); service("ready", "runtime"); service("ready", "demo-gateway"); service("ready", "dashboard");

  const seedBefore = identity();
  run("node", ["scripts/beta/bootstrap.mjs", "seed", "--config", args.config], { timeout: 180000 });
  const seedAfter = identity();
  const draftAfterSeed = await owner("/v1/portfolio/draft-revisions/latest");
  check("M35-SEED-01-idempotent", "bootstrap preserves IDs, latest owner edit, approval and publication", { stableIds: JSON.stringify(seedBefore.identity) === JSON.stringify(seedAfter.identity), draftId: draftAfterSeed.payload?.id, publicationId: (await owner("/v1/portfolio/publications/latest")).payload?.id }, JSON.stringify(seedBefore.identity) === JSON.stringify(seedAfter.identity) && draftAfterSeed.payload?.id === stale.newerPrivateDraftId && draftAfterSeed.payload?.draft?.profile?.introduction === intro && (await owner("/v1/portfolio/publications/latest")).payload?.id === published.payload.id);
  const interruptedSeed = op("partialBootstrapAndRepair");
  check("M35-SEED-01-repair", "separate owned partial seed converges without duplicate project or release", interruptedSeed, interruptedSeed.interrupted === true && interruptedSeed.repaired === true && interruptedSeed.duplicateProjects === 0 && interruptedSeed.duplicateReleases === 0);
  state.observations.retainedIdentities = { ownerId: seedAfter.identity.ownerId, projectId: seedAfter.identity.projectId, secondaryOwnerId: interruptedSeed.ownerId, secondaryProjectId: interruptedSeed.projectId, releaseId, publicationId: published.payload.id };

  const backup = op("backupPopulated", { itemId: item.id });
  check("M35-RECOVER-01-backup", "both populated stores produced verified private backups", { platformSha256: backup.platformSha256, projectSha256: backup.projectSha256 }, /^[a-f0-9]{64}$/.test(backup.platformSha256) && /^[a-f0-9]{64}$/.test(backup.projectSha256));
  const restored = op("restoreIsolated", { platformSha256: backup.platformSha256, projectSha256: backup.projectSha256, itemId: item.id }); temporaryRestore = restored.restoreId;
  check("M35-RECOVER-01-restore", "isolated restores preserve relationships and permit real application read/write", restored, restored.ownerId === seedAfter.identity.ownerId && restored.projectId === seedAfter.identity.projectId && String(restored.itemId) === String(item.id) && restored.platformAppReadWrite === true && restored.projectAppReadWrite === true && restored.platformApp?.observed?.loginStatus === 201 && restored.platformApp?.checkerRemoved === true && restored.projectApp?.observed?.writeStatus === 201 && restored.projectApp?.checkerRemoved === true && restored.isolated === true);
  const retainedRelease = op("retainedM3ReleaseEvidence");
  check("M35-RECOVER-01-retained-release", "unchanged release failure and rollback policy has verified accepted M3 receipts", retainedRelease, retainedRelease.verified === true && retainedRelease.receiptCount === 2 && retainedRelease.releaseAssertionsPresent === true);
  const schema = op("schemaVersion");
  check("M35-RECOVER-01-schema", "migration checks are N/A only for unchanged schema-6 storage", schema, schema.before === 6 && schema.after === 6 && schema.storageChanged === false);

  const failure = op("boundedStartupFailure", { publicationId: published.payload.id, itemId: item.id, slug: published.payload.slug });
  check("M35-START-01-bounded", "observed readiness failure, systemd restart budget and two restarts preserve owner-visible state and last good data", failure, failure.observedReadinessAttempts === 1 && failure.readinessExitStatus !== 0 && failure.readinessElapsedMs <= failure.readinessDeadlineMs && failure.observedManagedRestarts === 2 && Number(failure.restartTimestamps?.[1]) > Number(failure.restartTimestamps?.[0]) && failure.restartPolicy?.before === "on-failure" && failure.restartPolicy?.after === "on-failure" && failure.restartPolicy?.startLimitBurst === 3 && failure.ownerVisibleReason === true && failure.unhealthyAdvertised === false && failure.staticStatusWhilePublisherDown === 200 && failure.publicationId === published.payload.id && String(failure.itemId) === String(item.id));
  const clockAfter = op("realClockProvision");
  check("M35-DB-CLOCK-01-restart", "real scheduler and ready provision retain exact database identity after managed restarts", clockAfter, clockAfter.nondecreasing === true && clockAfter.exactProvision === true && clockAfter.ready === true && clockAfter.databaseId === clockBefore.databaseId && clockAfter.databaseGeneration === clockBefore.databaseGeneration && clockAfter.containerId === clockBefore.containerId);
  service("ready", "control"); service("ready", "runtime"); service("ready", "publisher-static");

  op("routeReverse"); cutoverActive = false;
  const reversed = op("routeStatus");
  check("M35-PLACE-01-reversal", "exact prior target is restored by provider readback", { phase: reversed.phase, exactPriorTarget: reversed.exactPriorTarget }, reversed.phase === "reversed" && reversed.exactPriorTarget === before.exactPriorTarget);
  op("routeCutover"); cutoverActive = true;
  const reapplied = op("routeStatus");
  check("M35-PLACE-01-reapply", "preview target is reapplied after exact reversal", { phase: reapplied.phase }, reapplied.phase === "cutover");
  state.observations.placement.reversed = reversed; state.observations.placement.reapplied = reapplied;
  const after = await request(config.origins.portfolio, new URL(portfolioUrl).pathname);
  check("M35-PLACE-01-final", "HTTPS portfolio still resolves through staged preview", { status: after.status, approvedTextPresent: after.text.includes(intro) }, after.status === 200 && after.text.includes(intro));
  op("routeReverse"); cutoverActive = false;
  const finalReversal = op("routeStatus");
  check("M35-PLACE-01-final-reversal", "clean gate restores exact legacy route until both runs pass", { phase: finalReversal.phase, exactPriorTarget: finalReversal.exactPriorTarget }, finalReversal.phase === "reversed" && finalReversal.exactPriorTarget === before.exactPriorTarget);
  state.observations.placement.finalReversal = finalReversal;
  state.observations.browser = { requestedOrigins: [...new Set(requests.map((event) => event.origin))], pageCount: 4 };
  delete state.privateOwnerToken;
}

try {
  await execute();
  state.status = interrupted ? "interrupted" : "passed";
} catch (error) {
  delete state.privateOwnerToken;
  state.status = interrupted ? "interrupted" : "failed";
  state.errors.push({ kind: "gate", message: publicValue(error.message) });
} finally {
  try { await browser?.close(); state.cleanup.push({ resource: "run-owned Chromium profile", result: "removed" }); } catch { state.cleanup.push({ resource: "run-owned Chromium profile", result: "removal failed" }); state.status = "failed"; }
  for (const unit of ["provider", "control", "runtime", "demo-gateway", "dashboard"]) {
    if (!stoppedUnits.has(unit) && !(outageStarted && state.status !== "passed")) continue;
    try { service("start", unit); service("ready", unit); state.cleanup.push({ resource: `managed ${unit}`, result: "restarted and ready" }); }
    catch (error) { state.cleanup.push({ resource: `managed ${unit}`, result: `restart failed: ${publicValue(error.message)}` }); state.status = "failed"; }
  }
  if (temporaryRestore) {
    try { const result = op("removeIsolatedRestore", { restoreId: temporaryRestore }); check("M35-CLEAN-01-restore", "exact isolated restore removed after ownership check", result, result.removed === true && result.restoreId === temporaryRestore); state.cleanup.push({ resource: `isolated restore ${temporaryRestore}`, result: "removed" }); } catch (error) { state.cleanup.push({ resource: `isolated restore ${temporaryRestore}`, result: `failed: ${publicValue(error.message)}` }); state.status = "failed"; }
  }
  if (cutoverActive && state.status !== "passed") {
    try { op("routeReverse"); const result = op("routeStatus"); check("M35-PLACE-01-failed-run-reversal", "failed gate restores exact prior route", { phase: result.phase }, result.phase === "reversed"); state.cleanup.push({ resource: "temporary Cloudflare route", result: "exact prior target restored" }); } catch (error) { state.cleanup.push({ resource: "temporary Cloudflare route", result: `restore failed: ${publicValue(error.message)}` }); state.status = "failed"; }
  } else if (cutoverActive) state.cleanup.push({ resource: "preview Cloudflare route", result: "retained only pending two clean gate runs and parent final route decision" });
  try { const result = op("temporaryCleanup", state.observations.retainedIdentities ?? {}); check("M35-CLEAN-01-exact", "all run-owned temporary resources are removed after exact identity checks", result, result.exactOwnedOnly === true && result.temporaryRemaining === 0 && Array.isArray(result.retainedPreview)); state.cleanup.push({ resource: "temporary run resources", result: "exact cleanup complete" }); state.retained = result.retainedPreview; } catch (error) { state.cleanup.push({ resource: "temporary run resources", result: `failed: ${publicValue(error.message)}` }); state.status = "failed"; }
  const missing = SCENARIOS.filter((id) => !state.assertions.some((entry) => entry.id.startsWith(id) && entry.passed));
  if (missing.length) { state.errors.push({ kind: "coverage", message: `missing passing scenario evidence: ${missing.join(", ")}` }); state.status = "failed"; }
  if (state.assertions.some((entry) => !entry.passed)) state.status = "failed";
  state.endedAt = new Date().toISOString();
  state.source.endingCommit = git("rev-parse", "HEAD");
  state.source.endingClean = git("status", "--porcelain=v1", "--untracked-files=all") === "";
  if (args["require-clean"] && (!state.source.endingClean || state.source.endingCommit !== state.source.commit)) state.status = "failed";
  progress();
  const availableSecret = (path) => { try { return path ? secret(path) : null; } catch { return null; } };
  const credentialBytes = [edge?.username, edge?.password, availableSecret(config?.owner?.passwordFile), availableSecret(config?.otherOwner?.passwordFile), process.env.M35_CF_DNS_TOKEN, process.env.M35_CF_TUNNEL_TOKEN].filter((value) => typeof value === "string" && value.length > 3).map((value) => Buffer.from(value));
  const scanCredentials = () => ["manifest.json", "REPORT.md"].flatMap((name) => credentialBytes.filter((value) => readFileSync(join(artifact, name)).includes(value)).map(() => name));
  const credentialMatches = scanCredentials();
  if (credentialMatches.length) {
    const original = JSON.stringify(state);
    let scrubbed = original;
    for (const value of credentialBytes) scrubbed = scrubbed.replaceAll(value.toString(), "[REDACTED]");
    Object.assign(state, JSON.parse(scrubbed));
    state.status = "failed";
    state.errors.push({ kind: "artifact", message: `credential bytes were scrubbed from ${[...new Set(credentialMatches)].join(", ")}` });
    progress();
  }
  if (scanCredentials().length) {
    process.stderr.write(`M3.5 artifact credential scan failed: ${relative(ROOT, artifact)}\n`);
    process.exitCode = 1;
  } else {
  const files = readdirSync(artifact).filter((name) => name !== "SHA256SUMS").sort();
  writeFileSync(join(artifact, "SHA256SUMS"), files.map((name) => `${shaFile(join(artifact, name))}  ${name}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`M3.5 gate ${state.status}: ${relative(ROOT, artifact)}\nSHA256SUMS sha256: ${shaFile(join(artifact, "SHA256SUMS"))}\n`);
  process.exitCode = state.status === "passed" ? 0 : 1;
  }
}
