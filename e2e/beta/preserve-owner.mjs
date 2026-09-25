#!/usr/bin/env node
// Guarded, owner-API-only compensation for the synthetic M3.5 preview.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requestJson } from "../support/http-client.mjs";
import { loadPreviewConfig, readPreviewSecret } from "../../scripts/beta/preview-context.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const args = process.argv.slice(2);
const mode = args.shift();
const options = {};
for (let i = 0; i < args.length; i += 2) {
  requireThat(args[i]?.startsWith("--") && args[i + 1] && !options[args[i].slice(2)], "invalid command options");
  options[args[i].slice(2)] = args[i + 1];
}
requireThat(["snapshot", "restore"].includes(mode), "expected snapshot or restore");
requireThat(options.config && options.output && (mode === "snapshot" || (options.snapshot && options["gate-manifest"])), "missing required path");
const config = loadPreviewConfig(options.config);

function privateRead(path) {
  const stat = lstatSync(path);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, "private input must be a mode-0600 regular file");
  return JSON.parse(readFileSync(path, "utf8"));
}

function privateWrite(path, value) {
  const target = resolve(path);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, "private output must be a mode-0600 regular file");
  }
  const directory = lstatSync(dirname(target));
  requireThat(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0, "private output directory must be mode 0700");
  const temporary = `${target}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

let sessionToken;
let signInPromise;
async function call(path, options = {}) {
  if (!sessionToken) {
    signInPromise ??= (async () => {
      const signed = await requestJson(config.apiUrl, "/v1/sessions", {
        method: "POST", body: { email: config.owner.email, password: readPreviewSecret(config.owner.passwordFile) },
      });
      requireThat(signed.status === 201 && typeof signed.payload?.token === "string", `owner sign-in failed (${signed.status})`);
      sessionToken = signed.payload.token;
    })();
    await signInPromise;
  }
  return requestJson(config.apiUrl, path, { ...options, token: sessionToken });
}
async function required(path) {
  const response = await call(path);
  requireThat(response.status === 200, `owner read failed (${response.status})`);
  return response.payload;
}
async function heads() {
  const [draft, approval, publication] = await Promise.all([
    required("/v1/portfolio/draft-revisions/latest"),
    required("/v1/portfolio/approved-revisions/latest"),
    required("/v1/portfolio/publications/latest"),
  ]);
  return { draft, approval, publication };
}
function headIds(value) { return { draftId: value.draft.id, approvalId: value.approval.id, publicationId: value.publication.id }; }
function sameHead(a, b) { return a.draft.id === b.draft.id && a.approval.id === b.approval.id && a.publication.id === b.publication.id; }
function matchingRequirements(a, b) {
  return isDeepStrictEqual(a.map(({ target, value_digest }) => ({ target, value_digest })),
    b.map(({ target, value_digest }) => ({ target, value_digest })));
}
function refreshScopes(approval) {
  return approval.deployment_facts.flatMap((fact) => fact.refresh_scope.length
    ? [{ project_reference_id: fact.project_reference_id, fields: fact.refresh_scope }] : []);
}
function reproducible(snapshot, review) {
  const approval = snapshot.approval;
  requireThat(isDeepStrictEqual(review.snapshot, approval.snapshot), "source review differs from original approved snapshot");
  requireThat(isDeepStrictEqual(review.preview_context, approval.preview_context), "source review appearance differs from original approval");
  requireThat(matchingRequirements(review.requirements, approval.requirements), "displayed approved fields or trusted facts have drifted");
  requireThat(approval.readiness.every((item) => item.state === "needs_recheck" && item.reason === "never_checked" && item.attestation === null), "prior readiness cannot be reproduced without a new attestation");
  requireThat(approval.deployment_facts.length === review.deployment_facts.length, "trusted deployment facts changed");
  for (const fact of approval.deployment_facts) {
    const current = review.deployment_facts.find((item) => item.project_reference_id === fact.project_reference_id);
    requireThat(current?.source_release_id === fact.source_release_id && current?.source_deployment_id === fact.source_deployment_id, "trusted deployment source changed");
  }
}

function allowedGateIds(manifest) {
  requireThat(manifest.schema === "hostlet.e2e.m3.5/v1" && typeof manifest.runId === "string", "invalid M3.5 gate manifest");
  const drafts = new Set([manifest.outputs?.draftId, manifest.outputs?.newerPrivateDraftId, manifest.outputs?.winnerDraftId]);
  for (const save of [manifest.observations?.browserSave, ...(manifest.observations?.browserSaves ?? [])]) {
    for (const response of save?.responses ?? []) if (response.status === 201) drafts.add(response.safeBody?.id);
  }
  const approvals = new Set([manifest.outputs?.approvedId]);
  const publications = new Set([manifest.outputs?.publicationId]);
  for (const action of manifest.observations?.publicationActions ?? []) {
    if (action.status !== 201 || !UUID.test(action.returnedId ?? "")) continue;
    if (action.name === "approve") approvals.add(action.returnedId);
    if (action.name === "publish") publications.add(action.returnedId);
  }
  return Object.fromEntries(Object.entries({ drafts, approvals, publications }).map(([kind, ids]) =>
    [kind, new Set([...ids].filter((id) => UUID.test(id ?? "")))]));
}

async function writeStep(receipt, name, path, body, expectedIds, expectedRevision) {
  const current = await heads();
  requireThat(Object.entries(expectedIds).every(([key, value]) => headIds(current)[key] === value), `unknown owner head before ${name}`);
  let intent = receipt.pending;
  if (intent) {
    requireThat(intent.name === name && intent.bodyDigest === digest(body), `unresolved different preservation intent before ${name}`);
  } else {
    intent = { name, key: `m35-preserve-${name}-${randomUUID()}`, bodyDigest: digest(body), expectedRevision: expectedRevision ?? null };
    receipt.pending = intent;
    privateWrite(options.output, receipt);
  }
  const headers = { "Idempotency-Key": intent.key };
  if (intent.expectedRevision !== null) headers["If-Match"] = `"${intent.expectedRevision}"`;
  const response = await call(path, { method: "POST", headers, body, timeoutMs: 30000 });
  requireThat(response.status === 201 && UUID.test(response.payload?.id ?? ""), `${name} rejected (${response.status}, ${response.payload?.error?.code ?? "unknown"})`);
  receipt.ids[name] = response.payload.id;
  receipt.pending = null;
  privateWrite(options.output, receipt);
  return response.payload;
}

async function resumePending(receipt, snapshot) {
  if (!receipt.pending) return;
  const { name } = receipt.pending;
  const current = await heads();
  const body = name === "publicDraft" ? publicDraftBody(snapshot)
    : name === "approval" ? approvalBody(receipt)
      : name === "publication" ? { approved_revision_id: receipt.ids.approval, slug: snapshot.publication.slug }
        : name === "privateDraft" ? { draft: snapshot.draft.draft, preview: snapshot.draft.preview } : null;
  requireThat(body && digest(body) === receipt.pending.bodyDigest, "pending preservation body changed");
  const headers = { "Idempotency-Key": receipt.pending.key };
  if (receipt.pending.expectedRevision !== null) headers["If-Match"] = `"${receipt.pending.expectedRevision}"`;
  const path = name === "approval" ? "/v1/portfolio/approved-revisions"
    : name === "publication" ? "/v1/portfolio/publications" : "/v1/portfolio/preview-revisions";
  for (const [key, expected] of Object.entries(receipt.expectedDuringPending)) {
    if (key !== (name === "publicDraft" || name === "privateDraft" ? "draftId" : name === "approval" ? "approvalId" : "publicationId")) {
      requireThat(headIds(current)[key] === expected, `concurrent owner head before pending ${name} replay`);
    }
  }
  const response = await call(path, { method: "POST", headers, body, timeoutMs: 30000 });
  requireThat(response.status === 201 && UUID.test(response.payload?.id ?? ""), `pending ${name} could not be recovered (${response.status})`);
  const key = name === "publicDraft" || name === "privateDraft" ? "draftId" : name === "approval" ? "approvalId" : "publicationId";
  const after = await heads();
  requireThat(headIds(after)[key] === response.payload.id, `unknown owner head after pending ${name}`);
  for (const [other, expected] of Object.entries(receipt.expectedDuringPending)) {
    if (other !== key) requireThat(headIds(after)[other] === expected, `concurrent owner head after pending ${name}`);
  }
  receipt.ids[name] = response.payload.id;
  receipt.pending = null;
  delete receipt.expectedDuringPending;
  privateWrite(options.output, receipt);
}

function publicDraftBody(snapshot) {
  const approved = snapshot.approval;
  const hosted = new Set(approved.snapshot.projects.filter((project) => project.kind.type === "hosted_project")
    .map((project) => `${project.project_reference_id}:${project.kind.project_id}`));
  const project_contexts = snapshot.draft.preview.project_contexts.filter((context) =>
    hosted.has(`${context.project_reference_id}:${context.project_id}`));
  return { draft: approved.snapshot, preview: { ...approved.preview_context, project_contexts } };
}
function approvalBody(receipt) {
  return { draft_revision_id: receipt.ids.publicDraft, review_digest: receipt.reviewDigest,
    approval: { type: "entire_revision", review_digest: receipt.reviewDigest },
    refresh_authorizations: receipt.refreshScopes };
}

async function snapshotMode() {
  requireThat(!existsSync(options.output), "snapshot output already exists");
  const value = await heads();
  requireThat(value.publication.state === "published" && value.publication.approved_revision_id === value.approval.id,
    "current publication does not match the latest approved revision");
  const source = await required(`/v1/portfolio/draft-revisions/${value.approval.source_draft_revision_id}`);
  requireThat(isDeepStrictEqual(source.draft, value.approval.snapshot), "original approved source draft differs from approval snapshot");
  const review = await required(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(source.id)}`);
  reproducible(value, review);
  privateWrite(options.output, { schema: "hostlet.beta.owner-preservation/v1", capturedAt: new Date().toISOString(),
    configDigest: digest({ apiUrl: config.apiUrl, ownerEmail: config.owner.email, stateDir: config.stateDir }), ...value });
  return { status: "captured", ...headIds(value), output: resolve(options.output) };
}

async function restoreMode() {
  const snapshot = privateRead(options.snapshot);
  requireThat(snapshot.schema === "hostlet.beta.owner-preservation/v1" &&
    snapshot.configDigest === digest({ apiUrl: config.apiUrl, ownerEmail: config.owner.email, stateDir: config.stateDir }), "snapshot or configuration mismatch");
  const manifest = privateRead(options["gate-manifest"]);
  const allowed = allowedGateIds(manifest);
  let receipt = existsSync(options.output) ? privateRead(options.output) : null;
  if (receipt) requireThat(receipt.schema === "hostlet.beta.owner-preservation-receipt/v1" &&
    receipt.snapshotDigest === digest(snapshot) && receipt.gateRunId === manifest.runId, "preservation receipt does not match inputs");
  else {
    receipt = { schema: "hostlet.beta.owner-preservation-receipt/v1", snapshotDigest: digest(snapshot),
      gateRunId: manifest.runId, status: "incomplete", ids: {}, checks: {}, pending: null };
    privateWrite(options.output, receipt);
  }
  const original = await heads();
  if (receipt.status === "restored") {
    requireThat(original.draft.id === receipt.ids.privateDraft && original.approval.id === receipt.ids.approval &&
      original.publication.id === receipt.ids.publication &&
      isDeepStrictEqual(original.draft.draft, snapshot.draft.draft) &&
      isDeepStrictEqual(original.draft.preview, snapshot.draft.preview) &&
      isDeepStrictEqual(original.approval.snapshot, snapshot.approval.snapshot) &&
      isDeepStrictEqual(original.approval.preview_context, snapshot.approval.preview_context) &&
      matchingRequirements(original.approval.requirements, snapshot.approval.requirements) &&
      original.publication.state === "published" && original.publication.approved_revision_id === original.approval.id,
    "completed preservation receipt no longer matches owner state");
    return { status: receipt.status, ...headIds(original), output: resolve(options.output) };
  }
  if (sameHead(original, snapshot) && Object.keys(receipt.ids).length === 0) {
    receipt.status = "unchanged"; receipt.checks = { public: true, private: true, identity: true };
    privateWrite(options.output, receipt);
    return { status: receipt.status, ...headIds(original), output: resolve(options.output) };
  }
  const originalIds = headIds(snapshot);
  const permitted = {
    draftId: new Set([originalIds.draftId, ...allowed.drafts, receipt.ids.publicDraft, receipt.ids.privateDraft]),
    approvalId: new Set([originalIds.approvalId, ...allowed.approvals, receipt.ids.approval]),
    publicationId: new Set([originalIds.publicationId, ...allowed.publications, receipt.ids.publication]),
  };
  for (const [key, id] of Object.entries(headIds(original))) {
    if (!receipt.pending) requireThat(permitted[key].has(id), `unknown ${key} after gate`);
  }
  requireThat([...allowed.drafts, ...allowed.approvals, ...allowed.publications].length > 0 || Object.keys(receipt.ids).length > 0,
    "gate manifest has no exact content-write IDs");
  const source = await required(`/v1/portfolio/draft-revisions/${snapshot.approval.source_draft_revision_id}`);
  const sourceReview = await required(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(source.id)}`);
  reproducible(snapshot, sourceReview);
  await resumePending(receipt, snapshot);
  let current = await heads();
  if (!receipt.ids.privateDraft) {
  if (!receipt.ids.publicDraft) {
    requireThat(permitted.draftId.has(current.draft.id) && permitted.approvalId.has(current.approval.id) && permitted.publicationId.has(current.publication.id), "unknown gate content head");
    receipt.expectedDuringPending = { approvalId: current.approval.id, publicationId: current.publication.id };
    privateWrite(options.output, receipt);
    await writeStep(receipt, "publicDraft", "/v1/portfolio/preview-revisions", publicDraftBody(snapshot), headIds(current), current.draft.revision);
  }
  current = await heads();
  requireThat(current.draft.id === receipt.ids.publicDraft, "public restoration draft is no longer latest");
  if (!receipt.ids.approval) {
    requireThat(permitted.approvalId.has(current.approval.id) && permitted.publicationId.has(current.publication.id), "unknown approval/publication before restore");
    const review = await required(`/v1/portfolio/publication-review?draft_revision_id=${encodeURIComponent(receipt.ids.publicDraft)}`);
    reproducible(snapshot, review);
    receipt.reviewDigest = review.review_digest;
    receipt.refreshScopes = refreshScopes(snapshot.approval);
    receipt.expectedDuringPending = { draftId: receipt.ids.publicDraft, publicationId: current.publication.id };
    privateWrite(options.output, receipt);
    await writeStep(receipt, "approval", "/v1/portfolio/approved-revisions", approvalBody(receipt), headIds(current));
  }
  current = await heads();
  requireThat(current.draft.id === receipt.ids.publicDraft && current.approval.id === receipt.ids.approval,
    "owner changed draft or approval after restoration review");
  if (!receipt.ids.publication) {
    requireThat(permitted.publicationId.has(current.publication.id), "unknown publication before restore");
    receipt.expectedDuringPending = { draftId: receipt.ids.publicDraft, approvalId: receipt.ids.approval };
    privateWrite(options.output, receipt);
    await writeStep(receipt, "publication", "/v1/portfolio/publications",
      { approved_revision_id: receipt.ids.approval, slug: snapshot.publication.slug }, headIds(current));
  }
  const deadline = Date.now() + 90_000;
  let published;
  while (Date.now() < deadline) {
    published = await required(`/v1/portfolio/publications/${receipt.ids.publication}`);
    requireThat(!["failed", "superseded"].includes(published.state), "restoration publication failed");
    const latest = await heads();
    requireThat(latest.draft.id === receipt.ids.publicDraft && latest.approval.id === receipt.ids.approval && latest.publication.id === receipt.ids.publication,
      "owner head changed while restoration publication was pending");
    if (published.state === "published") break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  requireThat(published?.state === "published" && published.approved_revision_id === receipt.ids.approval &&
    published.slug === snapshot.publication.slug && published.artifact_digest && published.pointer_generation !== null,
  "restoration publication did not become the current served identity before deadline");
  receipt.checks.publicationIdentity = true; privateWrite(options.output, receipt);
  current = await heads();
  if (!receipt.ids.privateDraft) {
    receipt.expectedDuringPending = { approvalId: receipt.ids.approval, publicationId: receipt.ids.publication };
    privateWrite(options.output, receipt);
    await writeStep(receipt, "privateDraft", "/v1/portfolio/preview-revisions",
      { draft: snapshot.draft.draft, preview: snapshot.draft.preview }, headIds(current), current.draft.revision);
  }
  }
  const final = await heads();
  requireThat(final.draft.id === receipt.ids.privateDraft && final.approval.id === receipt.ids.approval && final.publication.id === receipt.ids.publication,
    "restored owner heads changed before verification");
  requireThat(isDeepStrictEqual(final.draft.draft, snapshot.draft.draft) && isDeepStrictEqual(final.draft.preview, snapshot.draft.preview),
    "restored private content differs from entry snapshot");
  requireThat(isDeepStrictEqual(final.approval.snapshot, snapshot.approval.snapshot) &&
    isDeepStrictEqual(final.approval.preview_context, snapshot.approval.preview_context) &&
    matchingRequirements(final.approval.requirements, snapshot.approval.requirements) &&
    isDeepStrictEqual(refreshScopes(final.approval), refreshScopes(snapshot.approval)),
  "restored approved public content differs from entry snapshot");
  requireThat(final.publication.state === "published" && final.publication.approved_revision_id === final.approval.id &&
    final.publication.slug === snapshot.publication.slug, "restored public pointer differs from approved content");
  receipt.status = "restored";
  receipt.checks = { public: true, private: true, identity: true, publicationIdentity: true };
  receipt.completedAt = new Date().toISOString();
  privateWrite(options.output, receipt);
  return { status: receipt.status, ...headIds(final), output: resolve(options.output) };
}

let result;
let sessionRevoked = false;
try {
  result = mode === "snapshot" ? await snapshotMode() : await restoreMode();
} catch (error) {
  // Diagnostic output contains only fixed error labels and statuses, never API bodies.
  process.stderr.write(`owner preservation failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (sessionToken) {
    try {
      const revoked = await requestJson(config.apiUrl, "/v1/sessions/current", { method: "DELETE", token: sessionToken });
      sessionRevoked = revoked.status === 204;
      if (!sessionRevoked) {
        process.stderr.write(`owner session cleanup failed (${revoked.status})\n`);
        process.exitCode = 1;
      }
    } catch {
      process.stderr.write("owner session cleanup failed (transport)\n");
      process.exitCode = 1;
    }
  }
}
if (result && process.exitCode !== 1) process.stdout.write(`${JSON.stringify({ ...result, sessionRevoked })}\n`);
