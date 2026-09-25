#!/usr/bin/env node
// Focused real-API compensation exercise. The primary runs this before M3.5 gates.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { requestJson } from "../support/http-client.mjs";
import { loadPreviewConfig, readPreviewSecret } from "../../scripts/beta/preview-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(import.meta.dirname, "preserve-owner.mjs");
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--") || options[key.slice(2)]) throw new Error("expected unique --name value options");
  options[key.slice(2)] = value;
}
const runId = options["run-id"] ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) throw new Error("invalid preservation run ID");
const artifact = join(ROOT, "artifacts/e2e/M3.5", `preservation-${runId}`);
if (existsSync(artifact)) throw new Error("preservation artifact already exists; choose a fresh run ID");
mkdirSync(dirname(artifact), { recursive: true, mode: 0o700 });
mkdirSync(artifact, { mode: 0o700 });
chmodSync(artifact, 0o700);

const sha = (value) => createHash("sha256").update(value).digest("hex");
const shaFile = (path) => sha(readFileSync(path));
const privateJson = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("private mode-0600 input required");
  return JSON.parse(readFileSync(path, "utf8"));
};
const state = {
  schema: "hostlet.e2e.m3.5/v1", runId, scope: "focused", phase: "preservation-regression",
  status: "incomplete", startedAt: new Date().toISOString(), source: {}, inputs: {}, outputs: {},
  assertions: [], observations: {}, cleanup: [], errors: [],
};
function persist() {
  writeFileSync(join(artifact, "manifest.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const report = ["# M3.5 owner preservation regression", "", `Status: **${state.status}**`,
    "Scope: focused real API and protected HTTP exercise; not a full M3.5 gate.",
    `Run ID: ${runId}`, `Started: ${state.startedAt}`, `Ended: ${state.endedAt ?? "incomplete"}`,
    `Rerun: ${state.inputs.rerun ?? "unavailable"}`, "", "| Check | Result |", "| --- | --- |",
    ...state.assertions.map((item) => `| ${item.id} | ${item.passed ? "PASS" : "FAIL"} |`),
    "", "## Errors", ...state.errors.map((item) => `- ${item}`), "", "## Cleanup",
    ...state.cleanup.map((item) => `- ${item}`), "", "SHA256SUMS excludes itself.", ""].join("\n");
  writeFileSync(join(artifact, "REPORT.md"), report, { mode: 0o600 });
  const names = readdirSync(artifact).filter((name) => name !== "SHA256SUMS").sort();
  writeFileSync(join(artifact, "SHA256SUMS"), names.map((name) => `${shaFile(join(artifact, name))}  ${name}`).join("\n") + "\n", { mode: 0o600 });
}
function check(id, passed, observed = {}) {
  state.assertions.push({ id, passed: Boolean(passed), observed });
  persist();
  if (!passed) throw new Error(`${id} failed`);
}
persist(); // Artifact and external checksum exist before any service call.

let config, edge, edgePassword, ownerPassword, ownerToken, snapshotPath, receiptPath, gatePath, baseline;
let mutationId = null;
const secrets = [];
const child = (mode, extra, expectedStatus = 0) => {
  // Local API requests explicitly close their connections before this blocking child.
  const result = spawnSync(process.execPath, [script, mode, "--config", options.config, ...extra],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 8192 });
  const parsed = result.status === 0 ? JSON.parse(result.stdout.trim().split("\n").at(-1)) : null;
  if (result.status !== expectedStatus) throw new Error(`${mode} helper exited ${result.status ?? "unknown"}`);
  return parsed;
};
async function owner(path, request = {}) {
  const response = await requestJson(config.apiUrl, path, {
    ...request, token: ownerToken, headers: { Connection: "close", ...request.headers }, timeoutMs: 20000,
  });
  return response;
}
async function required(path) {
  const response = await owner(path);
  if (response.status !== 200) throw new Error(`owner read failed (${response.status})`);
  return response.payload;
}
async function currentHeads() {
  const draft = await required("/v1/portfolio/draft-revisions/latest");
  const approval = await required("/v1/portfolio/approved-revisions/latest");
  const publication = await required("/v1/portfolio/publications/latest");
  return { draft, approval, publication };
}
async function protectedHome(slug) {
  const url = new URL(`/${slug}/`, config.origins.portfolio);
  const response = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${edge.username}:${edgePassword}`).toString("base64")}`,
    Connection: "close", Accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) throw new Error(`protected portfolio failed (${response.status})`);
  return body;
}
function safeRunIdPath() {
  const path = join(config.stateDir, "diagnostics", `preservation-${runId}`);
  if (existsSync(path)) throw new Error("private preservation directory already exists");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
async function execute() {
  if (!options.config || !options["edge-credentials"]) throw new Error("config and edge credentials are required");
  config = loadPreviewConfig(options.config);
  edge = privateJson(options["edge-credentials"]);
  edgePassword = readPreviewSecret(edge.passwordFile);
  ownerPassword = readPreviewSecret(config.owner.passwordFile);
  secrets.push(edgePassword, ownerPassword);
  if (!edge.username || !config.origins?.portfolio || new URL(config.origins.portfolio).protocol !== "https:") throw new Error("invalid protected portfolio configuration");
  state.source = { installedReleaseCommit: config.releaseCommit, harnessHead: spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
    harnessSha256: sha(readFileSync(fileURLToPath(import.meta.url))), helperSha256: shaFile(script), nodeVersion: process.version };
  state.inputs = { configSha256: shaFile(options.config), edgeCredentialsSha256: shaFile(options["edge-credentials"]),
    rerun: `node e2e/beta/preservation-regression.mjs --config ${resolve(options.config)} --edge-credentials ${resolve(options["edge-credentials"])} --run-id <fresh-id>` };
  persist();
  const privateDir = safeRunIdPath();
  snapshotPath = join(privateDir, "entry.json");
  receiptPath = join(privateDir, "restore-receipt.json");
  gatePath = join(artifact, "manifest.json");
  state.observations.privateSnapshotSha256 = null;
  state.cleanup.push(`Private preservation files retained under ${privateDir}`); persist();

  const snap = child("snapshot", ["--output", snapshotPath]);
  check("PRESERVE-SNAPSHOT", snap.status === "captured" && snap.sessionRevoked === true);
  baseline = privateJson(snapshotPath);
  state.observations.privateSnapshotSha256 = shaFile(snapshotPath);
  state.outputs.entryDraftId = baseline.draft.id;
  state.outputs.entryApprovalId = baseline.approval.id;
  state.outputs.entryPublicationId = baseline.publication.id;
  persist();
  const originalHtml = await protectedHome(baseline.publication.slug);
  state.observations.entryHtmlSha256 = sha(originalHtml);
  check("PRESERVE-ENTRY-PUBLIC", originalHtml.includes(baseline.approval.snapshot.profile.display_name), { htmlSha256: sha(originalHtml) });

  const signed = await requestJson(config.apiUrl, "/v1/sessions", { method: "POST", headers: { Connection: "close" },
    body: { email: config.owner.email, password: ownerPassword } });
  check("PRESERVE-OWNER-SESSION", signed.status === 201 && Boolean(signed.payload?.token), { status: signed.status });
  ownerToken = signed.payload.token; secrets.push(ownerToken);
  const before = await currentHeads();
  check("PRESERVE-EXACT-ENTRY", before.draft.id === baseline.draft.id && before.approval.id === baseline.approval.id &&
    before.publication.id === baseline.publication.id);
  const changed = structuredClone(before.draft.draft);
  changed.profile.introduction = `M3.5 preservation regression ${runId}`;
  const saved = await owner("/v1/portfolio/preview-revisions", { method: "POST",
    headers: { "If-Match": `"${before.draft.revision}"`, "Idempotency-Key": `m35-preservation-${randomUUID()}` },
    body: { draft: changed, preview: before.draft.preview } });
  mutationId = saved.payload?.id ?? null;
  state.outputs.draftId = mutationId; // The helper reads this exact API-returned ID from this genuine manifest.
  state.observations.saveStatus = saved.status;
  persist();
  check("PRESERVE-REAL-WRITE", saved.status === 201 && typeof mutationId === "string" &&
    mutationId !== baseline.draft.id && saved.payload?.draft?.profile?.introduction === changed.profile.introduction,
  { status: saved.status, returnedDraftId: mutationId });

  const restored = child("restore", ["--snapshot", snapshotPath, "--gate-manifest", gatePath, "--output", receiptPath]);
  const receipt = privateJson(receiptPath);
  check("PRESERVE-COMPENSATED", restored.status === "restored" && restored.sessionRevoked === true && receipt.status === "restored" &&
    Object.values(receipt.checks).every(Boolean), { restoredDraftId: restored.draftId, restoredPublicationId: restored.publicationId });
  state.outputs.restoredDraftId = restored.draftId;
  state.outputs.restoredApprovalId = restored.approvalId;
  state.outputs.restoredPublicationId = restored.publicationId;
  state.observations.restoreReceiptSha256 = shaFile(receiptPath);
  persist();

  const final = await currentHeads();
  check("PRESERVE-PRIVATE-EQUAL", isDeepStrictEqual(final.draft.draft, baseline.draft.draft) &&
    isDeepStrictEqual(final.draft.preview, baseline.draft.preview) && final.draft.id === restored.draftId,
  { draftId: final.draft.id, revision: final.draft.revision });
  check("PRESERVE-APPROVED-EQUAL", isDeepStrictEqual(final.approval.snapshot, baseline.approval.snapshot) &&
    isDeepStrictEqual(final.approval.preview_context, baseline.approval.preview_context) && final.approval.id === restored.approvalId,
  { approvalId: final.approval.id });
  check("PRESERVE-PUBLISHED-IDENTITY", final.publication.id === restored.publicationId &&
    final.publication.approved_revision_id === final.approval.id && final.publication.slug === baseline.publication.slug &&
    final.publication.state === "published", { publicationId: final.publication.id });
  const restoredHtml = await protectedHome(baseline.publication.slug);
  check("PRESERVE-HTML-BYTE-EQUAL", restoredHtml === originalHtml, { beforeSha256: sha(originalHtml), afterSha256: sha(restoredHtml) });

  const replay = child("restore", ["--snapshot", snapshotPath, "--gate-manifest", gatePath, "--output", receiptPath]);
  const afterReplay = await currentHeads();
  check("PRESERVE-IDEMPOTENT-REPLAY", replay.status === "restored" && replay.sessionRevoked === true &&
    afterReplay.draft.id === final.draft.id && afterReplay.approval.id === final.approval.id &&
    afterReplay.publication.id === final.publication.id);

  // Labeled negative fixture: an invented manifest has no authority over the new real heads.
  const fakeGate = join(privateDir, "negative-fixture-manifest.json");
  const fakeReceipt = join(privateDir, "negative-fixture-receipt.json");
  writeFileSync(fakeGate, `${JSON.stringify({ schema: "hostlet.e2e.m3.5/v1", runId: `${runId}-negative-fixture`,
    outputs: { draftId: randomUUID() }, observations: {} })}\n`, { flag: "wx", mode: 0o600 });
  child("restore", ["--snapshot", snapshotPath, "--gate-manifest", fakeGate, "--output", fakeReceipt], 1);
  const afterNegative = await currentHeads();
  check("PRESERVE-UNKNOWN-HEAD-REJECTED", afterNegative.draft.id === final.draft.id &&
    afterNegative.approval.id === final.approval.id && afterNegative.publication.id === final.publication.id,
  { negativeFixture: true, ownerHeadsUnchanged: true });
  state.cleanup.push("Real owner content restored by new API revisions; prior history retained; negative fixture made no owner write");
}

try {
  await execute();
  state.status = "passed";
} catch (error) {
  state.status = "failed";
  state.errors.push(/^[A-Za-z0-9 -]+$/.test(error.message) ? error.message : "focused preservation step failed");
  if (mutationId && snapshotPath && receiptPath && gatePath) {
    try {
      const recovery = child("restore", ["--snapshot", snapshotPath, "--gate-manifest", gatePath, "--output", receiptPath]);
      state.cleanup.push(`Compensating API restore ${recovery.status}; session revoked ${recovery.sessionRevoked === true}`);
    } catch { state.cleanup.push("Compensating API restore failed; private snapshot and receipt retained for guarded retry"); }
  }
} finally {
  if (ownerToken) {
    try {
      const revoke = await owner("/v1/sessions/current", { method: "DELETE" });
      state.cleanup.push(`Runner owner session revoke HTTP ${revoke.status}`);
      if (revoke.status !== 204) state.status = "failed";
    } catch { state.cleanup.push("Runner owner session revoke failed"); state.status = "failed"; }
  }
  if (secrets.length) {
    const visible = ["manifest.json", "REPORT.md"].some((name) => secrets.some((secret) =>
      secret && readFileSync(join(artifact, name)).includes(Buffer.from(secret))));
    if (visible) { state.errors.push("credential scan failed"); state.status = "failed"; }
  }
  state.endedAt = new Date().toISOString();
  persist();
  process.stdout.write(`M3.5 preservation ${state.status}: ${relative(ROOT, artifact)}\nSHA256SUMS sha256: ${shaFile(join(artifact, "SHA256SUMS"))}\n`);
  if (state.status !== "passed") process.exitCode = 1;
}
