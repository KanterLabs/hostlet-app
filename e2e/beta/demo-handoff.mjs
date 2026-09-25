#!/usr/bin/env node
// Scoped private-preview demonstration. It is not an M3.5 acceptance gate.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./browser.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = fileURLToPath(import.meta.url);
const browserPath = fileURLToPath(new URL("./browser.mjs", import.meta.url));
const rawArgs = process.argv.slice(2);
const args = {};
for (let i = 0; i < rawArgs.length; i += 2) {
  if (!rawArgs[i]?.startsWith("--") || !rawArgs[i + 1] || rawArgs[i + 1].startsWith("--")) throw new Error("expected --name value arguments");
  args[rawArgs[i].slice(2)] = rawArgs[i + 1];
}
const requestedId = args["run-id"] ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
const validId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(requestedId);
const runId = validId ? requestedId : `invalid-${Date.now()}`;
const artifact = join(ROOT, "artifacts/e2e/M3.5", `demo-handoff-${runId}`);
const collided = existsSync(artifact);
if (collided) throw new Error("demo handoff run ID already has an artifact; choose a fresh ID");
mkdirSync(artifact, { recursive: false, mode: 0o700 });
chmodSync(artifact, 0o700);
copyFileSync(scriptPath, join(artifact, "demo-handoff.mjs"));
copyFileSync(browserPath, join(artifact, "browser.mjs"));
chmodSync(join(artifact, "demo-handoff.mjs"), 0o600);
chmodSync(join(artifact, "browser.mjs"), 0o600);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaFile = (path) => sha(readFileSync(path));
const shellArg = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const secrets = [];
const redact = (value) => {
  let text = String(value).replaceAll(/(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/g, "[REDACTED]");
  for (const secret of secrets) if (secret.length > 3) text = text.replaceAll(secret, "[REDACTED]");
  return text;
};
const state = { schema: "hostlet.e2e.m3.5.demo-handoff/v1", scope: "scoped-demo-handoff-not-acceptance", runId, status: "incomplete", startedAt: new Date().toISOString(), source: {}, inputs: {}, checks: [], observations: { readiness: null, browser: { requests: [], responses: [], failures: [], omitted: 0 } }, outputs: {}, cleanup: [], errors: [] };
const progress = () => {
  const safe = JSON.parse(redact(JSON.stringify(state)));
  writeFileSync(join(artifact, "manifest.json"), JSON.stringify(safe, null, 2) + "\n", { mode: 0o600 });
  const lines = ["# Restricted M3.5 demo handoff", "", `Status: **${safe.status}**`, "Scope: scoped demo handoff only; never M3.5 acceptance", `Started: ${safe.startedAt}`, `Ended: ${safe.endedAt ?? "incomplete"}`, `Rerun: ${safe.inputs.rerun ?? "unavailable"}`, "", "| Check | Result |", "| --- | --- |", ...safe.checks.map((entry) => `| ${entry.id} | ${entry.passed ? "PASS" : "FAIL"} |`), "", "## Errors", ...safe.errors.map((entry) => `- ${entry}`), "", "## Cleanup", ...safe.cleanup.map((entry) => `- ${entry}`), "", "SHA256SUMS excludes itself.", ""];
  writeFileSync(join(artifact, "REPORT.md"), lines.join("\n"), { mode: 0o600 });
};
const check = (id, observed, passed) => {
  state.checks.push({ id, passed: Boolean(passed), observed });
  progress();
  if (!passed) throw new Error(`${id} failed`);
};
const privateFile = (path) => {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error(`private input must be mode 0600: ${basename(path)}`);
  return readFileSync(path, "utf8");
};
const privateJson = (path) => JSON.parse(privateFile(path));
const secret = (path) => { const value = privateFile(path).trim(); secrets.push(value); return value; };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let config, edge, browser, ownerToken, browserSessionToken;
const basic = () => `Basic ${Buffer.from(`${edge.username}:${edge.password}`).toString("base64")}`;
const api = async (origin, path, { token, authorized = true, method = "GET", body } = {}) => {
  const response = await fetch(new URL(path, origin), { method, headers: { ...(authorized ? { Authorization: basic() } : {}), ...(token ? { "X-Hostlet-Authorization": `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20000) });
  let payload; try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
};
const localApi = async (path, { token, method = "GET", body } = {}) => {
  const response = await fetch(new URL(path, config.apiUrl), { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  let payload; try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
};
const transport = (error) => ({ name: String(error?.name ?? "Error").slice(0, 40), code: /^[A-Za-z0-9_:-]{1,80}$/.test(String(error?.code ?? "")) ? String(error.code) : null });
const ready = async (slug) => {
  const path = `/${slug}/`;
  const protectedHeaders = { Authorization: basic(), Accept: "application/json" };
  const probes = [
    ...Object.entries(config.origins).map(([name, origin]) => ({ name, url: new URL("/", origin), expected: 401 })),
    { name: "dashboardApi", url: new URL("/v1/me", config.origins.dashboard), headers: { ...protectedHeaders, "X-Hostlet-Authorization": "Bearer malformed" }, expected: 401, code: "authentication_required" },
    { name: "dashboardHtml", url: new URL("/", config.origins.dashboard), headers: protectedHeaders, expected: 200, mime: "text/html" },
    { name: "demoHtml", url: new URL("/", config.origins.demo), headers: protectedHeaders, expected: 200, mime: "text/html" },
    { name: "portfolioHtml", url: new URL(path, config.origins.portfolio), headers: protectedHeaders, expected: 200, mime: "text/html" },
  ];
  const observed = state.observations.readiness = { deadlineMs: 300000, stableRequiredMs: 20000, startedAt: new Date().toISOString(), probes: Object.fromEntries(probes.map((probe) => [probe.name, { path: probe.url.pathname, attempts: [] }])), stableElapsedMs: 0, elapsedMs: 0 };
  const started = Date.now(); let stableSince = null;
  while (Date.now() - started < observed.deadlineMs) {
    const timeout = Math.max(1, Math.min(5000, observed.deadlineMs - (Date.now() - started)));
    const round = await Promise.all(probes.map(async (probe) => {
      const attempt = { at: new Date().toISOString(), status: null, mime: null, code: null, cfRay: null, cfCacheStatus: null, ageSeconds: null, cf1033: false, transport: null };
      try {
        const response = await fetch(probe.url, { headers: probe.headers, redirect: "manual", signal: AbortSignal.timeout(timeout) });
        attempt.status = response.status;
        const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]{1,80}$/.test(mime)) attempt.mime = mime;
        const ray = response.headers.get("cf-ray"); if (ray && /^[A-Za-z0-9-]{1,64}$/.test(ray)) attempt.cfRay = ray;
        const cache = response.headers.get("cf-cache-status"); if (cache && /^[A-Za-z-]{1,40}$/.test(cache)) attempt.cfCacheStatus = cache;
        const age = response.headers.get("age"); if (age && /^(?:0|[1-9][0-9]{0,9})$/.test(age)) attempt.ageSeconds = Number(age);
        if (probe.code && response.status === 401) {
          let body; try { body = await response.json(); } catch { body = null; }
          const code = body?.error?.code; if (typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code)) attempt.code = code;
        } else if (response.status === 530 && response.body) {
          const reader = response.body.getReader();
          try { const chunk = await reader.read(); attempt.cf1033 = Boolean(chunk.value && /\b1033\b/.test(new TextDecoder().decode(chunk.value.subarray(0, 8192)))); }
          finally { await reader.cancel(); }
        } else await response.body?.cancel();
      } catch (error) { attempt.transport = transport(error); }
      observed.probes[probe.name].attempts.push(attempt);
      return attempt;
    }));
    if (round.every((attempt, index) => attempt.transport === null && attempt.status === probes[index].expected && (!probes[index].mime || attempt.mime === probes[index].mime) && (!probes[index].code || attempt.code === probes[index].code))) stableSince ??= Date.now();
    else stableSince = null;
    observed.stableElapsedMs = stableSince === null ? 0 : Date.now() - stableSince;
    observed.elapsedMs = Date.now() - started;
    progress();
    if (observed.stableElapsedMs >= observed.stableRequiredMs) return;
    await delay(Math.min(500, observed.deadlineMs - observed.elapsedMs));
  }
  throw new Error("seven-path public preview readiness timed out");
};
const recordBrowser = (kind, event) => {
  const timeline = state.observations.browser;
  const list = timeline[`${kind}s`];
  if (list.length >= 300) { timeline.omitted++; return; }
  const requestId = typeof event.requestId === "string" && /^[A-Za-z0-9.:-]{1,100}$/.test(event.requestId) ? event.requestId : null;
  if (kind === "failure") list.push({ requestId, at: event.at, code: /^[A-Za-z0-9_.:-]{1,100}$/.test(event.code ?? "") ? event.code : "network_failure" });
  else list.push({ requestId, at: event.at, origin: Object.values(config.origins).some((value) => new URL(value).origin === event.origin) ? event.origin : null, path: typeof event.path === "string" ? event.path.slice(0, 256) : null, ...(kind === "request" ? { method: /^[A-Z]{3,8}$/.test(event.method ?? "") ? event.method : null, expectedRevision: event.expectedRevision } : { status: event.status, mime: typeof event.mimeType === "string" && /^[A-Za-z0-9.+/-]{1,100}$/.test(event.mimeType) ? event.mimeType : null, type: /^[A-Za-z]{1,40}$/.test(event.type ?? "") ? event.type : null, ...(event.path === "/v1/portfolio/preview-revisions" ? { safeBody: event.safeBody ?? null } : {}) }) });
  progress();
};
const actionResponse = (path, method = "POST") => {
  const requests = state.observations.browser.requests.filter((event) => event.path === path && event.method === method);
  const request = requests.at(-1);
  const response = state.observations.browser.responses.filter((event) => event.requestId === request?.requestId && event.path === path).at(-1);
  const failure = state.observations.browser.failures.find((event) => event.requestId === request?.requestId);
  return { request, response, failure };
};
const editorState = async (value) => browser.evaluate(`(() => { const field = document.querySelector('textarea[name="profile.introduction"]'); const button = document.querySelector('[data-testid="preview-save"]'); const notice = document.querySelector('[data-testid="preview-editor-notice"]')?.textContent?.trim() ?? ''; return { fieldPresent: Boolean(field), valueMatches: field?.value === ${JSON.stringify(value)}, buttonPresent: Boolean(button), buttonEnabled: Boolean(button && !button.disabled), notice: notice === 'Private preview saved.' ? 'saved' : notice ? 'other' : 'none', conflict: Boolean(document.querySelector('[data-testid="preview-conflict"]')) }; })()`);

async function execute() {
  if (!validId) throw new Error("invalid demo handoff run ID");
  if (!args.config || !args["edge-credentials"]) throw new Error("--config and --edge-credentials are required");
  config = privateJson(args.config);
  const edgeInput = privateJson(args["edge-credentials"]);
  edge = { username: edgeInput.username, password: secret(edgeInput.passwordFile) };
  const ownerPassword = secret(config.owner.passwordFile);
  if (config.schema !== "hostlet.beta.config/v1" || !edge.username || !edge.password) throw new Error("invalid private preview configuration");
  for (const origin of Object.values(config.origins)) if (new URL(origin).protocol !== "https:") throw new Error("preview origin must use HTTPS");
  state.source = { harnessHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), harnessDirty: Boolean(execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" }).trim()), harnessSha256: sha(Buffer.concat([readFileSync(scriptPath), readFileSync(browserPath)])), installedReleaseCommit: config.releaseCommit, installedBinarySha256: Object.fromEntries(Object.entries(config.binaries ?? {}).map(([name, path]) => [name, shaFile(path)])), nodeVersion: process.version, chromiumVersion: execFileSync(args.chromium ?? "/snap/bin/chromium", ["--version"], { encoding: "utf8" }).trim(), fixtureEvidence: "N/A: unchanged installed release; no fixture rebuild in scoped walkthrough", toolchainBuildEvidence: "N/A: existing installed release; no build in scoped walkthrough" };
  const rerun = `node e2e/beta/demo-handoff.mjs --config ${shellArg(args.config)} --edge-credentials ${shellArg(args["edge-credentials"])}${args.chromium ? ` --chromium ${shellArg(args.chromium)}` : ""}${args["manual-credentials"] ? ` --manual-credentials ${shellArg(args["manual-credentials"])}` : ""}`;
  state.inputs = { configPath: resolve(args.config), configSha256: shaFile(args.config), edgeCredentialPath: resolve(args["edge-credentials"]), edgeCredentialSha256: shaFile(args["edge-credentials"]), rerun, manualCredentialFile: args["manual-credentials"] ? resolve(args["manual-credentials"]) : null };
  if (args["manual-credentials"]) privateFile(args["manual-credentials"]); // validate location; never retain contents
  state.outputs.manualCredentialFile = state.inputs.manualCredentialFile;
  progress();

  const localLogin = await localApi("/v1/sessions", { method: "POST", body: { email: config.owner.email, password: ownerPassword } });
  check("DEMO-OWNER-LOCAL", { status: localLogin.status, tokenPresent: Boolean(localLogin.payload?.token) }, localLogin.status === 201 && Boolean(localLogin.payload?.token));
  ownerToken = localLogin.payload.token;
  secrets.push(ownerToken);
  const latestPublication = await localApi("/v1/portfolio/publications/latest", { token: ownerToken });
  const publication = latestPublication.payload;
  check("DEMO-APPROVED-POINTER", { status: latestPublication.status, id: publication?.id ?? null, slug: publication?.slug ?? null, state: publication?.state ?? null }, latestPublication.status === 200 && publication?.state === "published" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(publication.id) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(publication.slug));
  state.outputs.approvedPublicationId = publication.id; state.outputs.approvedSlug = publication.slug; progress();
  await ready(publication.slug);
  check("DEMO-SEVEN-PATH-READY", { elapsedMs: state.observations.readiness.elapsedMs, stableElapsedMs: state.observations.readiness.stableElapsedMs }, true);
  for (const [name, origin] of Object.entries(config.origins)) {
    const denied = await api(origin, "/", { authorized: false });
    check(`DEMO-ANON-${name}`, { status: denied.status }, denied.status === 401);
  }
  const protectedPaths = [["dashboard", "/"], ["demo", "/"], ["portfolio", `/${publication.slug}/`]];
  for (const [name, path] of protectedPaths) {
    const response = await fetch(new URL(path, config.origins[name]), { headers: { Authorization: basic(), Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    await response.body?.cancel();
    check(`DEMO-PROTECTED-${name}`, { status: response.status, mime }, response.status === 200 && mime === "text/html");
  }

  browser = await openBrowser({ chromiumPath: args.chromium ?? "/snap/bin/chromium", username: edge.username, password: edge.password, origins: Object.values(config.origins), onRequest: (event) => recordBrowser("request", event), onResponse: (event) => recordBrowser("response", event), onFailure: (event) => recordBrowser("failure", event) });
  await browser.navigate(config.origins.dashboard);
  await browser.wait("Boolean(document.querySelector('[data-testid=auth-form]'))", 30000);
  await browser.fill('[data-testid="auth-form"] input[name="email"]', config.owner.email);
  await browser.fill('[data-testid="auth-form"] input[name="password"]', ownerPassword);
  await browser.click('[data-testid="auth-form"] button[type="submit"]');
  await browser.wait("Boolean(document.querySelector('[data-testid=signed-in-user]')) && Boolean(document.querySelector('[data-testid=preview-editor]'))", 30000);
  browserSessionToken = await browser.evaluate("window.sessionStorage.getItem('hostlet.session')");
  if (typeof browserSessionToken === "string") secrets.push(browserSessionToken);
  check("DEMO-BROWSER-SESSION", { tokenPresent: Boolean(browserSessionToken) }, typeof browserSessionToken === "string" && browserSessionToken.length > 0);
  const identity = privateJson(join(config.stateDir, "identity-manifest.json"));
  const projectId = identity.identity?.projectId;
  await browser.wait(`Boolean(document.querySelector('[data-testid="preview-project-editor"][data-project-id=${JSON.stringify(projectId)}]'))`, 30000);
  check("DEMO-BROWSER-OWNER-PROJECT", { signedIn: true, projectId }, Boolean(projectId));

  const before = await api(config.origins.dashboard, "/v1/portfolio/draft-revisions/latest", { token: ownerToken });
  check("DEMO-DRAFT-BASELINE", { status: before.status, revision: before.payload?.revision ?? null, id: before.payload?.id ?? null }, before.status === 200 && Number.isSafeInteger(before.payload?.revision));
  const introduction = `M3.5 handoff introduction ${runId}`;
  await browser.fill('textarea[name="profile.introduction"]', introduction);
  const editorBefore = await editorState(introduction);
  check("DEMO-EDIT-READY", editorBefore, editorBefore.valueMatches && editorBefore.buttonEnabled);
  await browser.click('[data-testid="preview-save"]');
  const saveDeadline = Date.now() + 30000; let save;
  while (Date.now() < saveDeadline) {
    save = actionResponse("/v1/portfolio/preview-revisions");
    const editor = await editorState(introduction);
    state.observations.save = { request: save.request ?? null, response: save.response ?? null, failure: save.failure ?? null, editor };
    progress();
    if (save.failure || (save.response?.status && save.response.status >= 400)) break;
    if (save.response?.status === 201 && Number.isSafeInteger(save.response.safeBody?.revision) && editor.notice === "saved") break;
    await delay(100);
  }
  check("DEMO-SAVE-POST", { requestOccurred: Boolean(save?.request), status: save?.response?.status ?? null, returnedRevision: save?.response?.safeBody?.revision ?? null, editor: state.observations.save?.editor }, save?.request?.expectedRevision === before.payload.revision && save?.response?.status === 201 && Number.isSafeInteger(save.response.safeBody?.revision) && state.observations.save.editor.valueMatches && state.observations.save.editor.notice === "saved");
  await browser.navigate(config.origins.dashboard);
  await browser.wait(`document.querySelector('textarea[name="profile.introduction"]')?.value === ${JSON.stringify(introduction)}`, 30000);
  const after = await api(config.origins.dashboard, "/v1/portfolio/draft-revisions/latest", { token: ownerToken });
  check("DEMO-SAVE-RELOAD", { browserValueMatches: true, apiStatus: after.status, revision: after.payload?.revision ?? null, returnedRevision: save.response.safeBody.revision }, after.status === 200 && after.payload?.revision === save.response.safeBody.revision && after.payload?.revision > before.payload.revision && after.payload?.draft?.profile?.introduction === introduction);
  state.outputs.savedDraftId = after.payload.id; state.outputs.savedRevision = after.payload.revision; state.outputs.syntheticIntroduction = introduction; progress();

  await browser.navigate(config.origins.demo);
  await browser.wait("Boolean(document.querySelector('#item-form'))", 30000);
  const itemName = `M3.5 handoff item ${sha(runId).slice(0, 16)} ${runId.slice(0, 35)}`;
  const demoBefore = await api(config.origins.demo, "/api/items");
  check("DEMO-ITEM-UNIQUE", { status: demoBefore.status, alreadyPresent: demoBefore.payload?.items?.some((item) => item.name === itemName) ?? null }, demoBefore.status === 200 && !demoBefore.payload?.items?.some((item) => item.name === itemName));
  await browser.fill("#item-name", itemName);
  await browser.click("#item-form button");
  await browser.wait(`Array.from(document.querySelectorAll('#items li')).some(e=>e.textContent===${JSON.stringify(itemName)})`, 30000);
  const demoPost = actionResponse("/api/items");
  const rowId = await browser.evaluate(`Array.from(document.querySelectorAll('#items li')).find(e=>e.textContent===${JSON.stringify(itemName)})?.dataset.itemId ?? null`);
  check("DEMO-ITEM-POST", { requestOccurred: Boolean(demoPost.request), status: demoPost.response?.status ?? null, rowId }, Boolean(demoPost.request) && demoPost.response?.status === 201 && /^[0-9]+$/.test(String(rowId ?? "")));
  await browser.navigate(config.origins.demo);
  await browser.wait(`Array.from(document.querySelectorAll('#items li')).some(e=>e.dataset.itemId===${JSON.stringify(String(rowId))} && e.textContent===${JSON.stringify(itemName)})`, 30000);
  const demoAfter = await api(config.origins.demo, "/api/items");
  check("DEMO-ITEM-RELOAD-API", { browserRowPresent: true, apiStatus: demoAfter.status, rowFound: demoAfter.payload?.items?.some((item) => String(item.id) === String(rowId) && item.name === itemName) ?? false }, demoAfter.status === 200 && demoAfter.payload?.items?.some((item) => String(item.id) === String(rowId) && item.name === itemName));
  state.outputs.demoItemId = rowId; state.outputs.demoItemName = itemName; progress();

  const portfolioUrl = new URL(`/${publication.slug}/`, config.origins.portfolio).href;
  const home = await browser.navigate(portfolioUrl);
  await browser.wait("Boolean(document.body?.innerText)", 30000);
  const projectLink = await browser.evaluate(`Array.from(document.querySelectorAll('a[href]')).map(a=>a.href).find(href=>href.startsWith(${JSON.stringify(portfolioUrl + "projects/")})) ?? null`);
  const homeResponse = state.observations.browser.responses.find((event) => event.origin === new URL(portfolioUrl).origin && event.path === new URL(portfolioUrl).pathname && event.type === "Document" && event.status === 200);
  check("DEMO-APPROVED-HOME", { publicationId: publication.id, url: home.url, status: homeResponse?.status ?? null, mime: homeResponse?.mime ?? null, projectLinkPresent: Boolean(projectLink) }, home.url === portfolioUrl && homeResponse?.status === 200 && homeResponse?.mime === "text/html" && Boolean(projectLink));
  const detail = await browser.navigate(projectLink);
  await browser.wait("Boolean(document.body?.innerText)", 30000);
  const detailResponse = state.observations.browser.responses.find((event) => event.origin === new URL(projectLink).origin && event.path === new URL(projectLink).pathname && event.type === "Document" && event.status === 200);
  const demoLink = await browser.evaluate(`Array.from(document.querySelectorAll('a[href]')).map(a=>a.href).find(href=>href.startsWith(${JSON.stringify(config.origins.demo + "/")})) ?? null`);
  check("DEMO-APPROVED-DETAIL-LINK", { url: detail.url, status: detailResponse?.status ?? null, mime: detailResponse?.mime ?? null, demoLinkPresent: Boolean(demoLink) }, detail.url === projectLink && detailResponse?.status === 200 && detailResponse?.mime === "text/html" && Boolean(demoLink));
  const linkedDemo = await browser.navigate(demoLink);
  await browser.wait("Boolean(document.querySelector('#item-form'))", 30000);
  const latestPublished = await api(config.origins.dashboard, "/v1/portfolio/publications/latest", { token: ownerToken });
  check("DEMO-APPROVED-LINK-LOAD", { demoUrl: linkedDemo.url, publicationStatus: latestPublished.status, publicationUnchanged: latestPublished.payload?.id === publication.id }, linkedDemo.url.startsWith(config.origins.demo + "/") && latestPublished.status === 200 && latestPublished.payload?.id === publication.id);
  state.outputs.urls = { dashboard: config.origins.dashboard, demo: config.origins.demo, portfolio: portfolioUrl, detail: projectLink };
  progress();
}

progress();
try { await execute(); state.status = "passed"; }
catch (error) {
  state.status = "failed";
  state.errors.push(redact(error?.message ?? "demo handoff failed"));
  if (browser) {
    try { state.observations.browser.failureSnapshot = await browser.evaluate("(() => ({ origin: location.origin, path: location.pathname, readyState: document.readyState, authFormPresent: Boolean(document.querySelector('[data-testid=auth-form]')), editorPresent: Boolean(document.querySelector('[data-testid=preview-editor]')), demoFormPresent: Boolean(document.querySelector('#item-form')), cf1033Present: Boolean(document.body?.innerText?.includes('1033')) }))()"); }
    catch { state.observations.browser.failureSnapshot = { unavailable: true }; }
  }
} finally {
  if (browser && !browserSessionToken) {
    try { browserSessionToken = await browser.evaluate("location.origin === " + JSON.stringify(config?.origins?.dashboard ?? "") + " ? window.sessionStorage.getItem('hostlet.session') : null"); if (typeof browserSessionToken === "string") secrets.push(browserSessionToken); }
    catch { /* failure snapshot already retained */ }
  }
  for (const [name, token] of [["browser", browserSessionToken], ["local", ownerToken]]) {
    if (!token || !config) continue;
    try { const revoked = await localApi("/v1/sessions/current", { token, method: "DELETE" }); state.cleanup.push(`${name} owner session revoke HTTP ${revoked.status}`); if (revoked.status >= 300) state.status = "failed"; }
    catch { state.cleanup.push(`${name} owner session revoke failed`); state.status = "failed"; }
  }
  try { if (browser) { await browser.close(); state.cleanup.push("run-owned Chromium profile removed"); } }
  catch { state.cleanup.push("run-owned Chromium profile removal failed"); state.status = "failed"; }
  state.endedAt = new Date().toISOString();
  progress();
  const credentialBytes = secrets.filter((value) => value.length > 3);
  const leaked = ["manifest.json", "REPORT.md", "demo-handoff.mjs", "browser.mjs"].some((name) => credentialBytes.some((value) => readFileSync(join(artifact, name)).includes(Buffer.from(value))));
  if (leaked) { state.status = "failed"; state.errors.push("credential scan found unsanitized bytes"); progress(); }
  const files = readdirSync(artifact).filter((name) => name !== "SHA256SUMS").sort();
  writeFileSync(join(artifact, "SHA256SUMS"), files.map((name) => `${shaFile(join(artifact, name))}  ${name}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`M3.5 scoped demo handoff ${state.status}: ${relative(ROOT, artifact)}\nSHA256SUMS sha256: ${shaFile(join(artifact, "SHA256SUMS"))}\n`);
  process.exitCode = state.status === "passed" ? 0 : 1;
}
