#!/usr/bin/env node
// Private M3.5 seed builds. This is deliberately separate from the ephemeral M3
// scenario runner: every mutation is recoverable by an exact durable identity.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createM3StandardProjectConfiguration, loadM3FixtureRepositories } from "../../e2e/support/m3-fixtures.mjs";
import { createPreviewContext, loadPreviewConfig } from "./preview-context.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUIRED = Object.freeze(["fullstack_v1", "node22_api", "fullstack_v2", "next16", "policy_probes", "crash_runtime"]);
const POOL = "m35-preview-evaluation";
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const exact = (response, statuses, label) => {
  if (!statuses.includes(response.status)) throw new Error(`${label}: HTTP ${response.status} (${response.payload?.error?.code ?? "unknown"})`);
  return response.payload;
};
const quote = (revision) => `"${revision}"`;
const headers = (key, revision) => ({ "Idempotency-Key": key, "If-Match": quote(revision) });
const fixedEvent = (label) => {
  const h = createHash("sha256").update(`hostlet-m35-preview:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function privateFile(path, label) {
  const full = resolve(path ?? "");
  if (!path || !existsSync(full) || lstatSync(full).isSymbolicLink() || !statSync(full).isFile() || realpathSync(full) !== full) throw new Error(`${label} is not an exact regular file`);
  return full;
}
function regularReadable(path, label) {
  if (!path || !existsSync(path) || !statSync(realpathSync(path)).isFile()) throw new Error(`${label} is unavailable`);
  return realpathSync(path);
}

function profiles(context) {
  const mapped = context.config.services?.paths?.buildProfiles;
  if (!mapped || typeof mapped !== "object") throw new Error("configured pinned buildProfiles map is required");
  const directory = join(context.stateDir, "profiles");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = {};
  for (const id of ["m3-owned-node24-v1", "m3-owned-node22-v1"]) {
    const path = privateFile(mapped[id], `build profile ${id}`);
    const bytes = readFileSync(path);
    const profile = JSON.parse(bytes);
    if (profile.schema !== "hostlet.build-profile/v1" || profile.id !== id) throw new Error(`configured build profile ${id} has wrong identity`);
    for (const component of [profile.qemu_binary, profile.kernel?.path, profile.initrd?.path, profile.rootfs?.path, profile.dependency_cache?.path, profile.mkfs_ext4, profile.sudo, profile.systemd_run, profile.systemctl]) regularReadable(component, `${id} component`);
    const controlCopy = join(directory, `${id}.json`);
    if (!existsSync(controlCopy)) { copyFileSync(path, controlCopy, 1); chmodSync(controlCopy, 0o600); }
    if (sha256(readFileSync(controlCopy)) !== sha256(bytes)) throw new Error(`protected control profile ${id} differs from worker profile`);
    result[id] = { id, path, digest: sha256(bytes) };
  }
  return result;
}

async function operatorClient(context) {
  const operator = context.config.operator;
  if (!operator?.email || !operator?.passwordFile) throw new Error("separate evaluator account credentials are required");
  let token = context.state.operator?.token;
  let accountId = context.state.operator?.record?.id;
  const signIn = async () => {
    const password = readFileSync(privateFile(operator.passwordFile, "operator password"), "utf8").trim();
    const session = exact(await context.call("/v1/sessions", { method: "POST", body: { email: operator.email, password } }), [201], "operator sign-in");
    if (!UUID.test(session.account_id) || !session.token) throw new Error("operator session lacks exact identity");
    token = session.token;
    accountId = session.account_id;
    const known = context.readManifest().identity.operatorId;
    if (known && known !== accountId) throw new Error("operator identity differs from seed manifest");
    return session;
  };
  if (!token || !accountId) await signIn();
  return { accountId, async request(path, options = {}) {
    let response = await context.call(path, { ...options, token });
    if (response.status === 401) { await signIn(); response = await context.call(path, { ...options, token }); }
    return response;
  } };
}

function configuration(catalog, key) {
  const services = catalog.buildServices[key];
  if (!services?.length) throw new Error(`missing declared build services: ${key}`);
  const value = createM3StandardProjectConfiguration("fullstack_v1");
  const postgres = value.services.find((service) => service.kind === "postgres");
  value.services = services.map((service) => ({ name: service.service_id, kind: service.kind, root: service.root,
    framework: service.framework, node: { major: service.node_major }, build_command: service.build_command,
    output_directory: service.output_directory, start_command: service.start_command ?? null,
    health_check: service.health_path ? { protocol: "http", path: service.health_path } : null,
    uses_durable_data: service.kind === "application" }));
  if (postgres && services.some((service) => service.kind === "application")) value.services.push(postgres);
  value.repositories[0].lockfile_path = services[0].lockfile_path;
  return value;
}

function verifyGraph(graph, catalog, key) {
  const actual = graph.services.filter((s) => ["application", "static_frontend"].includes(s.configuration.kind))
    .map((s) => `${s.configuration.kind}:${s.configuration.root}`).sort();
  const wanted = catalog.buildServices[key].map((s) => `${s.kind}:${s.root}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${key} project graph differs from its declared build services`);
}

async function listAllProjects(client) {
  const projects = [];
  let after;
  do {
    const response = exact(await client.request(`/v1/projects${after ? `?after=${encodeURIComponent(after)}` : ""}`), [200], "evaluator project list");
    projects.push(...(response.projects ?? response.items ?? []));
    after = response.next_cursor ?? null;
  } while (after);
  return projects;
}

async function evaluatorProject(context, client, catalog, key) {
  const name = `Hostlet M3.5 evaluator ${key}`;
  const record = context.readManifest().evaluators?.[key];
  let projectId = record?.projectId;
  if (!projectId) {
    const existing = (await listAllProjects(client)).find((project) => project.name === name);
    if (existing) projectId = existing.id;
    else {
      const created = exact(await client.request("/v1/projects", { method: "POST", headers: { "Idempotency-Key": `m35-evaluator-${key}-project` },
        body: { name, configuration: configuration(catalog, key) } }), [201], `${key} evaluator project creation`);
      projectId = created.project.id;
    }
    context.updateManifest({ evaluators: { [key]: { projectId, owner: "operator" } } });
  }
  if (!UUID.test(projectId)) throw new Error(`${key} evaluator project ID is invalid`);
  const graph = exact(await client.request(`/v1/projects/${projectId}`), [200], `${key} evaluator graph`);
  verifyGraph(graph, catalog, key);
  return graph;
}

async function ensureSource(context, client, catalog, key, graph, section, { ownerRollout = false } = {}) {
  const selected = catalog.commits[key];
  const projectId = graph.project.id;
  const path = `/v1/projects/${projectId}/github-source`;
  let read = await client.request(path);
  if (ownerRollout && read.status === 200) {
    const current = read.payload;
    const initial = context.readManifest().source;
    const isInitial = current.source_revision?.id === initial.sourceRevisionId &&
      current.source_revision?.resolved_commit === initial.commitSha && current.source_revision?.tree_sha === initial.treeSha;
    const isRollout = current.source_revision?.resolved_commit === selected.commitSha &&
      current.source_revision?.tree_sha === selected.treeSha && current.repository?.id === selected.repositoryId &&
      current.ref === `refs/heads/${selected.branch}`;
    if (!isInitial && !isRollout) throw new Error(`${key} owner source was changed outside the exact owned rollout`);
    if (isInitial) {
      const bound = exact(await client.request(path, { method: "PUT", headers: headers(`m35-${key}-bind`, graph.project.revision),
        body: { installation_id: catalog.fixtureData.installation.id, repository_id: selected.repositoryId,
          ref: `refs/heads/${selected.branch}` } }), [200], `${key} owner rollout source binding`);
      read = { status: 200, payload: bound };
    }
  }
  if (read.status === 404) {
    const attempt = exact(await client.request("/v1/github/oauth-attempts", { method: "POST" }), [201], `${key} OAuth attempt`);
    const login = context.config.operator?.githubLogin;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login ?? "")) throw new Error("configured operator GitHub fixture login is missing or invalid");
    const authorizationUrl = new URL(attempt.authorization_url);
    if (authorizationUrl.protocol !== "http:" || authorizationUrl.hostname !== "127.0.0.1" ||
        authorizationUrl.pathname !== "/login/oauth/authorize") throw new Error("operator authorization is outside the owned loopback provider");
    authorizationUrl.searchParams.set("hostlet_preview_login", login);
    const authorization = await fetch(authorizationUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (authorization.status !== 302) throw new Error(`${key} provider authorization failed (${authorization.status})`);
    const callback = new URL(authorization.headers.get("location"));
    exact(await client.request("/v1/github/oauth-completions", { method: "POST", body: {
      code: callback.searchParams.get("code"), state: callback.searchParams.get("state"),
    } }), [200], `${key} OAuth completion`);
    const bound = exact(await client.request(path, { method: "PUT", headers: headers(`m35-${key}-bind`, graph.project.revision),
      body: { installation_id: catalog.fixtureData.installation.id, repository_id: selected.repositoryId, ref: `refs/heads/${selected.branch}` } }), [200], `${key} exact source binding`);
    read = { status: 200, payload: bound };
  }
  const sourceRead = exact(read, [200], `${key} source read`);
  let source = sourceRead.source_revision;
  if (!source?.id) throw new Error(`${key} source lacks durable revision`);
  if (sourceRead.status !== "active" || sourceRead.repository?.id !== selected.repositoryId ||
      sourceRead.ref !== `refs/heads/${selected.branch}` || !sourceRead.configuration_fresh ||
      source.resolved_commit !== selected.commitSha || source.tree_sha !== selected.treeSha ||
      source.configuration_revision_id !== graph.configuration.id) {
    throw new Error(`${key} source repository/ref/status/configuration or exact commit/tree drift`);
  }
  const saved = section.sourceRevisionId;
  if (saved && saved !== source.id) throw new Error(`${key} exact source revision differs from private manifest`);
  if (!saved && source.source !== "owner_resolve") {
    source = exact(await client.request(`${path}/resolve`, { method: "POST", headers: headers(`m35-${key}-resolve`, sourceRead.revision), body: {} }), [200], `${key} explicit source resolution`).source_revision;
    if (source.resolved_commit !== selected.commitSha || source.tree_sha !== selected.treeSha ||
        source.configuration_revision_id !== graph.configuration.id) throw new Error(`${key} resolved source drift`);
  }
  return source;
}

async function ensureReport(client, projectId, graph, source, key) {
  const path = `/v1/projects/${projectId}/compatibility-reports`;
  const query = `?source_revision_id=${encodeURIComponent(source.id)}&configuration_revision_id=${encodeURIComponent(graph.configuration.id)}`;
  const read = await client.request(`${path}/latest${query}`);
  let report;
  if (read.status === 200) report = read.payload;
  else if (read.status === 404) report = exact(await client.request(path, { method: "POST", headers: headers(`m35-${key}-compat`, graph.project.revision),
    body: { source_revision_id: source.id, configuration_revision_id: graph.configuration.id } }), [201], `${key} compatibility report`);
  else exact(read, [200], `${key} compatibility report lookup`);
  if (report?.status !== "candidate" || report.source_revision_id !== source.id ||
      report.configuration_revision_id !== graph.configuration.id) throw new Error(`${key} exact source/configuration is not a build candidate`);
  return report;
}

async function configureAdmission(context, accountId, client, pool, limits) {
  const currentResponse = await client.request("/v1/entitlements/current");
  if (![200, 409].includes(currentResponse.status)) exact(currentResponse, [200], `${pool} current entitlement`);
  const current = currentResponse.status === 200 ? currentResponse.payload : null;
  const saved = context.readManifest().admission?.[pool];
  if (current && current.source === "synthetic_internal" && current.hosted_slot_limit >= limits.slots && current.build_seconds_limit >= limits.seconds && saved?.accountId === accountId) return;
  if (current && saved?.accountId !== accountId) throw new Error(`${pool} entitlement already exists without matching private seed identity`);
  const period = saved ?? { accountId, periodStartsAt: current?.period_starts_at ?? new Date().toISOString(),
    periodEndsAt: current?.period_ends_at ?? new Date(Date.now() + 30 * 86400_000).toISOString() };
  if (!saved) context.updateManifest({ admission: { ...context.readManifest().admission, [pool]: period } });
  const capacity = await context.admissionInternal("/internal/v1/admission/capacity", { method: "POST", body: {
    event_id: fixedEvent(`${pool}-capacity`), pool_key: pool, profile: "m3-upgrade-standard",
    hosted_slot_limit: limits.capacity, rollout_headroom_limit: 12,
  } });
  exact(capacity, [200], `${pool} capacity`);
  exact(await context.admissionInternal("/internal/v1/admission/entitlements", { method: "POST", body: {
    event_id: fixedEvent(`${pool}-${accountId}-entitlement`), account_id: accountId, capacity_pool_key: pool,
    hosted_slot_limit: limits.slots, build_seconds_limit: limits.seconds,
    period_starts_at: period.periodStartsAt, period_ends_at: period.periodEndsAt, state: "active",
  } }), [200], `${pool} entitlement`);
}

async function ensureDeployment(context, client, key, graph, selected, section, update) {
  const projectId = graph.project.id;
  let deployment = null;
  if (section.deploymentId) deployment = exact(await client.request(`/v1/projects/${projectId}/deployments/${section.deploymentId}`), [200], `${key} deployment read`);
  else {
    deployment = exact(await client.request(`/v1/projects/${projectId}/deployment-intents`, { method: "POST",
      headers: headers(`m35-${key}-deployment`, graph.project.revision),
      body: { configuration_revision_id: graph.configuration.id, source_commit: selected.commitSha } }), [201], `${key} deployment intent`);
    update({ deploymentId: deployment.id });
  }
  if (deployment.configuration_revision_id !== graph.configuration.id || deployment.source_commit !== selected.commitSha) throw new Error(`${key} deployment differs from selected exact source/configuration`);
  return deployment;
}

async function ensureReservation(context, client, key, ownerId, graph, deployment, section, update, retries = 0) {
  const projectId = graph.project.id;
  const holdPath = `/v1/projects/${projectId}/deployments/${deployment.id}/capacity-holds`;
  const reservationPath = `/v1/projects/${projectId}/slot-reservation`;
  const persistedReservation = await client.request(reservationPath);
  if (![200, 404].includes(persistedReservation.status)) exact(persistedReservation, [200], `${key} slot reservation read`);
  if (section.reservation?.id) {
    const actual = exact(persistedReservation, [200], `${key} persisted reservation`);
    const firstDeployment = key === "fullstack_v2" ? context.readManifest().identity.deploymentId : deployment.id;
    if (actual.id !== section.reservation.id || actual.reservation_epoch !== section.reservation.reservation_epoch ||
        actual.project_id !== projectId || actual.first_deployment_id !== firstDeployment ||
        !["reserved", "resources_retained"].includes(actual.state)) {
      throw new Error(`${key} persisted reservation changed; bounded repair requires owner review`);
    }
    const holdRead = await client.request(holdPath);
    const hold = exact(holdRead, [200], `${key} admitted hold read`);
    if (hold.id !== section.holdId || hold.state !== "consumed" || hold.source_proof_id !== section.proofId ||
        hold.project_id !== projectId || hold.deployment_id !== deployment.id) {
      throw new Error(`${key} persisted hold/proof tuple changed; bounded repair requires owner review`);
    }
    if (!section.buildJobId && Date.parse(section.proofExpiresAt ?? "") <= Date.now() + 30_000) {
      throw new Error(`${key} admitted source proof expired before build enqueue; bounded repair requires a fresh exact proof`);
    }
    return section;
  }
  let holdRead = await client.request(holdPath);
  if (![200, 404].includes(holdRead.status)) exact(holdRead, [200], `${key} hold read`);
  if (holdRead.status === 200 && holdRead.payload.state === "consumed") {
    const hold = holdRead.payload;
    if (hold.project_id !== projectId || hold.deployment_id !== deployment.id ||
        (section.holdId && hold.id !== section.holdId) ||
        (section.proofId && hold.source_proof_id !== section.proofId)) {
      throw new Error(`${key} consumed hold identity differs from private manifest`);
    }
    if (!section.proofGeneration || !section.proofExpiresAt) throw new Error(`${key} consumed hold lacks saved proof replay tuple`);
    const replay = exact(await client.request(`/v1/projects/${projectId}/deployments/${deployment.id}/admissions`, {
      method: "POST", headers: headers(`m35-${key}-admit-${section.proofGeneration}`, graph.project.revision),
      body: { capacity_hold_id: hold.id },
    }), [200, 201], `${key} consumed admission replay`);
    const actual = exact(await client.request(reservationPath), [200], `${key} replayed reservation read`);
    if (replay.reservation?.id !== actual.id || replay.reservation?.reservation_epoch !== actual.reservation_epoch ||
        !["reserved", "resources_retained"].includes(actual.state)) throw new Error(`${key} admission replay differs from durable reservation`);
    update({ holdId: hold.id, proofId: hold.source_proof_id, reservation: actual });
    return ensureReservation(context, client, key, ownerId, graph, deployment,
      { ...section, holdId: hold.id, proofId: hold.source_proof_id, reservation: actual }, update, retries);
  }
  if (holdRead.status === 200 && (holdRead.payload.state !== "active" || Date.parse(holdRead.payload.expires_at) <= Date.now() + 5000)) {
    if (retries >= 2) throw new Error(`${key} expired hold needs bounded repair after repeated attempts`);
    section = { ...section, proofExpiresAt: new Date(0).toISOString(), holdId: null };
    holdRead = { status: 404 };
  }
  let proofGeneration = section.proofGeneration ?? 1;
  let proofExpiresAt = section.proofExpiresAt;
  if (!proofExpiresAt || Date.parse(proofExpiresAt) <= Date.now() + 180_000) {
    if (proofExpiresAt) proofGeneration += 1;
    proofExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    update({ proofGeneration, proofExpiresAt, proofId: null });
  }
  const proofResponse = exact(await context.admissionInternal("/internal/v1/admission/source-proofs", { method: "POST", body: {
    event_id: fixedEvent(`${key}-${projectId}-source-proof-${proofGeneration}`), account_id: ownerId, project_id: projectId,
    deployment_id: deployment.id, configuration_revision_id: graph.configuration.id,
    source_commit: deployment.source_commit, inventory_revision: proofGeneration,
    expires_at: proofExpiresAt,
  } }), [200], `${key} exact source proof`);
  const proof = proofResponse.proof ?? proofResponse;
  if (!UUID.test(proof.id)) throw new Error(`${key} proof identity missing`);
  update({ proofId: proof.id });
  let hold = holdRead.status === 200 ? holdRead.payload : null;
  if (hold && (hold.project_id !== projectId || hold.deployment_id !== deployment.id || hold.source_proof_id !== proof.id ||
      (section.holdId && hold.id !== section.holdId))) throw new Error(`${key} existing hold differs from exact proof`);
  if (!hold || hold.state !== "active") {
    hold = exact(await client.request(holdPath, { method: "POST",
      headers: headers(`m35-${key}-hold-${proofGeneration}`, graph.project.revision),
      body: { source_proof_id: proof.id, ttl_seconds: 120 },
    }), [201], `${key} capacity hold`).hold;
  }
  update({ holdId: hold.id });
  if (hold.state !== "active" || Date.parse(hold.expires_at) <= Date.now() + 5000) {
    if (retries >= 2) throw new Error(`${key} capacity hold expired during bounded admission recovery`);
    return ensureReservation(context, client, key, ownerId, graph, deployment,
      { ...section, proofGeneration, proofExpiresAt: new Date(0).toISOString() }, update, retries + 1);
  }
  const admissionResponse = await client.request(`/v1/projects/${projectId}/deployments/${deployment.id}/admissions`, {
    method: "POST", headers: headers(`m35-${key}-admit-${proofGeneration}`, graph.project.revision), body: { capacity_hold_id: hold.id },
  });
  if (admissionResponse.status === 409 && admissionResponse.payload?.error?.code === "capacity_hold_expired" && retries < 2) {
    return ensureReservation(context, client, key, ownerId, graph, deployment,
      { ...section, proofGeneration, proofExpiresAt: new Date(0).toISOString() }, update, retries + 1);
  }
  const admission = exact(admissionResponse, [200, 201], `${key} admitted reservation`);
  if (!UUID.test(admission.reservation?.id)) throw new Error(`${key} admission lacks durable reservation`);
  update({ reservation: admission.reservation });
  return { ...section, holdId: hold.id, proofId: proof.id, proofGeneration, proofExpiresAt, reservation: admission.reservation };
}

async function workerOnce(context, profile, key, jobId) {
  const binary = privateFile(context.config.binaries?.builder, "hostlet-builder");
  const cas = join(context.stateDir, "private-cas");
  const work = join(context.stateDir, "build-work");
  mkdirSync(cas, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const args = ["project-build-worker", "--control-url", context.workerUrl, "--worker-id", `m35-${key}-${randomUUID().slice(0, 8)}`,
    "--profile", profile.path, "--cas-root", cas, "--work-root", work, "--once"];
  const environment = context.componentEnvironment("build");
  context.registerSensitiveValues([environment.HOSTLET_M3_BUILD_TOKEN]);
  const result = await context.runCommand(`preview disposable VM build ${key}`, binary, args,
    { env: environment, timeoutMs: 900_000, logName: `m35-build-${key}-${jobId}.log` });
  if (result.code !== 0) throw new Error(`${key} real disposable-VM worker exited ${result.code}; inspect protected log ${result.logPath}`);
  const events = result.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  if (!events.some((event) => event.event === "build_job_claimed" && event.job_id === jobId) ||
      !events.some((event) => event.event === "build_vm_cleaned" && event.job_id === jobId &&
        event.qemu_exited && event.sockets_removed && event.workspace_removed)) {
    throw new Error(`${key} worker did not report a claimed, cleaned disposable VM for job ${jobId}; inspect protected log ${result.logPath}`);
  }
}

function casObject(context, digest, label) {
  if (!DIGEST.test(digest ?? "")) throw new Error(`${label} lacks SHA-256 identity`);
  const path = join(context.stateDir, "private-cas", "sha256", digest.slice(7));
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || sha256(readFileSync(path)) !== digest) throw new Error(`${label} private CAS object is missing or changed`);
  return path;
}

function take(bytes, cursor, length) {
  if (length < 0 || cursor.at + length > bytes.length) throw new Error("canonical artifact truncated");
  const out = bytes.subarray(cursor.at, cursor.at + length); cursor.at += length; return out;
}
function unpackArtifact(context, detail, artifact, root) {
  const bytes = readFileSync(casObject(context, artifact.archive_digest, "artifact archive"));
  const cursor = { at: 0 };
  if (!take(bytes, cursor, 4).equals(Buffer.from("HCA1"))) throw new Error("canonical archive magic mismatch");
  const kind = take(bytes, cursor, 1)[0];
  const serviceLength = take(bytes, cursor, 2).readUInt16BE();
  const serviceId = take(bytes, cursor, serviceLength).toString("utf8");
  const count = take(bytes, cursor, 4).readUInt32BE();
  const unpacked = Number(take(bytes, cursor, 8).readBigUInt64BE());
  if (serviceId !== artifact.service_id || count !== artifact.entry_count || unpacked !== artifact.unpacked_bytes || (kind === 1 ? "static" : kind === 2 ? "application" : null) !== artifact.kind) throw new Error("canonical artifact header differs from control metadata");
  const files = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const pathLength = take(bytes, cursor, 2).readUInt16BE();
    const relative = take(bytes, cursor, pathLength).toString("utf8");
    const mode = take(bytes, cursor, 4).readUInt32BE();
    const size = Number(take(bytes, cursor, 8).readBigUInt64BE());
    if (!relative || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..") || ![0o644, 0o755].includes(mode) || !Number.isSafeInteger(size)) throw new Error("canonical archive has unsafe entry");
    const content = take(bytes, cursor, size); total += size;
    files.push({ relative, mode, content });
  }
  if (cursor.at !== bytes.length || total !== unpacked) throw new Error("canonical archive length mismatch");
  if (new Set(files.map((entry) => entry.relative)).size !== files.length) throw new Error("canonical archive contains duplicate paths");
  const manifest = {
    schema: "hostlet.e2e-staged-build-artifact/v1", build_job_id: detail.build.id,
    artifact_id: artifact.id, service_id: artifact.service_id, kind: artifact.kind,
    archive_digest: artifact.archive_digest, manifest_digest: artifact.manifest_digest,
    source_commit: detail.build.source_commit, entry_count: count, unpacked_bytes: total,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const dest = join(root, `artifact-${artifact.id}`);
  const marker = `${artifact.archive_digest}\n`;
  if (existsSync(dest)) {
    if (lstatSync(dest).isSymbolicLink() || !statSync(dest).isDirectory() ||
        JSON.stringify(readdirSync(dest).sort()) !== JSON.stringify([".hostlet-artifact-owned", "manifest.json", "rootfs"].sort()) ||
        lstatSync(join(dest, ".hostlet-artifact-owned")).isSymbolicLink() ||
        lstatSync(join(dest, "manifest.json")).isSymbolicLink() ||
        lstatSync(join(dest, "rootfs")).isSymbolicLink() ||
        readFileSync(join(dest, ".hostlet-artifact-owned"), "utf8") !== marker ||
        !readFileSync(join(dest, "manifest.json")).equals(manifestBytes)) throw new Error("staged artifact ownership/provenance collision");
    const expected = new Set(files.map((entry) => entry.relative));
    const expectedDirectories = new Set(files.flatMap((entry) => entry.relative.split("/").slice(0, -1)
      .map((_, index, all) => all.slice(0, index + 1).join("/"))));
    const inspect = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error("staged artifact contains a symlink");
        if (entry.isDirectory()) {
          if (!expectedDirectories.has(relative)) throw new Error("staged artifact contains an unexpected directory");
          inspect(join(directory, entry.name), relative);
        }
        else if (!entry.isFile() || !expected.has(relative)) throw new Error("staged artifact contains an unexpected file");
      }
    };
    inspect(join(dest, "rootfs"));
    for (const entry of files) {
      const path = join(dest, "rootfs", entry.relative);
      if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() ||
          (statSync(path).mode & 0o777) !== entry.mode || !readFileSync(path).equals(entry.content)) throw new Error("staged artifact bytes/mode drift");
    }
    return dest;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = `${dest}.tmp-${randomUUID()}`;
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const entry of files) {
      const path = join(temporary, "rootfs", entry.relative);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, entry.content, { flag: "wx", mode: entry.mode });
      chmodSync(path, entry.mode);
    }
    writeFileSync(join(temporary, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(join(temporary, ".hostlet-artifact-owned"), marker, { flag: "wx", mode: 0o600 });
    renameSync(temporary, dest);
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
  return dest;
}

function outputs(context, catalog, key, detail) {
  if (detail.build.state !== "succeeded" || detail.build.terminal_code !== "build_succeeded") throw new Error(`${key} build did not succeed (${detail.build.state}/${detail.build.terminal_code})`);
  const declared = catalog.buildServices[key];
  if (detail.artifacts.length !== declared.length) throw new Error(`${key} registered artifact count differs from declared services`);
  return detail.artifacts.map((artifact) => {
    casObject(context, artifact.archive_digest, `${key} archive`);
    casObject(context, artifact.manifest_digest, `${key} manifest`);
    const service = declared.find((entry) => (entry.kind === "application" ? "application" : "static") === artifact.kind && entry.service_id === detail.serviceNames?.[artifact.service_id])
      ?? declared.find((entry) => (entry.kind === "application" ? "application" : "static") === artifact.kind);
    if (!service || !UUID.test(artifact.id) || !UUID.test(artifact.service_id) || !DIGEST.test(detail.build.build_profile_digest)) throw new Error(`${key} artifact has invalid durable identity`);
    const directory = unpackArtifact(context, detail, artifact, join(context.stateDir, "staged-build-artifacts"));
    return { buildJobId: detail.build.id, artifactId: artifact.id, serviceId: artifact.service_id,
      kind: artifact.kind, archiveDigest: artifact.archive_digest, manifestDigest: artifact.manifest_digest,
      buildProfileDigest: detail.build.build_profile_digest, sourceCommit: detail.build.source_commit,
      sourceTreeSha: detail.build.source_tree_sha, framework: service.framework, nodeMajor: service.node_major,
      root: service.root, outputDirectory: service.output_directory, startCommand: service.start_command ?? null,
      healthPath: service.health_path ?? null, entrypointArgv: artifact.entrypoint_argv ?? null,
      artifactDirectory: directory, outputRoot: join(directory, "rootfs"), rootfs: null };
  });
}

async function buildOne(context, client, catalog, profileMap, key, initialGraph, initialSection, update, { ownerRollout = false } = {}) {
  const selected = catalog.commits[key];
  const projectId = initialGraph.project.id;
  let section = initialSection;
  let graph = initialGraph;
  const source = await ensureSource(context, client, catalog, key, graph, section, { ownerRollout });
  update({ sourceRevisionId: source.id, commitSha: selected.commitSha, treeSha: selected.treeSha, repositoryId: selected.repositoryId });
  graph = exact(await client.request(`/v1/projects/${projectId}`), [200], `${key} source graph`);
  const report = await ensureReport(client, projectId, graph, source, key);
  update({ configurationRevisionId: graph.configuration.id, compatibilityReportId: report.id });
  section = { ...section, sourceRevisionId: source.id, configurationRevisionId: graph.configuration.id, compatibilityReportId: report.id };
  const deployment = await ensureDeployment(context, client, key, graph, selected, section, update);
  section = { ...section, deploymentId: deployment.id };
  graph = exact(await client.request(`/v1/projects/${projectId}`), [200], `${key} deployment graph`);
  section = await ensureReservation(context, client, key, client.accountId, graph, deployment, section, update);
  // Admission changes the project's hosted-slot revision. Enqueue must use the
  // current revision while keeping the exact admitted source/configuration.
  graph = exact(await client.request(`/v1/projects/${projectId}`), [200], `${key} admitted project graph`);
  if (graph.configuration.id !== section.configurationRevisionId ||
      graph.project.id !== projectId) throw new Error(`${key} project graph changed after exact admission`);
  if (!section.buildJobId) {
    const body = { source_revision_id: source.id, compatibility_report_id: report.id, source_proof_id: section.proofId,
      reservation_id: section.reservation.id, reservation_epoch: section.reservation.reservation_epoch,
      build_profile: selected.toolchainProfile, secret_version_refs: [] };
    const response = exact(await client.request(`/v1/projects/${projectId}/deployments/${deployment.id}/builds`, { method: "POST",
      headers: headers(`m35-${key}-build`, graph.project.revision), body }), [201], `${key} build enqueue`);
    section = { ...section, buildJobId: response.build.id };
    update({ buildJobId: response.build.id });
  }
  let detail = exact(await client.request(`/v1/projects/${projectId}/builds/${section.buildJobId}`), [200], `${key} build read`);
  if (detail.build.source_commit !== selected.commitSha || detail.build.source_tree_sha !== selected.treeSha || detail.build.configuration_revision_id !== graph.configuration.id || detail.build.build_profile_digest !== profileMap[selected.toolchainProfile]?.digest) throw new Error(`${key} queued build exact identity differs from source/profile`);
  if (detail.build.state === "running") {
    const deadline = Date.now() + 30_000;
    while (detail.build.state === "running" && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 500));
      detail = exact(await client.request(`/v1/projects/${projectId}/builds/${section.buildJobId}`), [200], `${key} interrupted lease read`);
    }
  }
  if (["queued", "retriable"].includes(detail.build.state) && detail.build.cleanup_status !== "pending") {
    await workerOnce(context, profileMap[selected.toolchainProfile], key, detail.build.id);
    detail = exact(await client.request(`/v1/projects/${projectId}/builds/${section.buildJobId}`), [200], `${key} completed build read`);
  }
  if (detail.build.state === "running" || detail.build.state === "retriable" || detail.build.cleanup_status === "pending") {
    throw new Error(`${key} build requires bounded owned-VM repair: job=${detail.build.id} state=${detail.build.state} attempt=${detail.build.current_attempt_id ?? "none"} lease=${detail.build.lease_expires_at ?? "none"} cleanup=${detail.build.cleanup_status}`);
  }
  const result = outputs(context, catalog, key, detail);
  update({ buildProfileDigest: detail.build.build_profile_digest, archiveDigests: result.map((item) => item.archiveDigest), artifactIds: result.map((item) => item.artifactId), buildState: "succeeded" });
  return { projectId, deploymentId: deployment.id, buildJobId: detail.build.id, outputs: result };
}

/** Real owned VM builds; call serially after account/provider/bootstrap readiness. */
export async function ensurePreviewBuilds(context, { keys = REQUIRED } = {}) {
  const wanted = [...new Set(keys)];
  if (wanted.some((key) => !REQUIRED.includes(key) && key !== "incompatible_api")) throw new Error("unsupported private build fixture requested");
  const catalog = loadM3FixtureRepositories();
  const profileMap = profiles(context);
  const manifest = context.readManifest();
  const ownerId = manifest.identity.ownerId;
  const ownerProjectId = manifest.identity.projectId;
  if (!UUID.test(ownerId ?? "") || !UUID.test(ownerProjectId ?? "")) throw new Error("owner seed identity is incomplete");
  const operator = await operatorClient(context);
  if (manifest.identity.operatorId && manifest.identity.operatorId !== operator.accountId) throw new Error("operator seed identity drift");
  if (!manifest.identity.operatorId) context.updateManifest({ identity: { operatorId: operator.accountId } });
  await configureAdmission(context, ownerId, { request: context.ownerHTTP }, "m35-preview-owner", { slots: 1, capacity: 2, seconds: 4000 });
  await configureAdmission(context, operator.accountId, operator, POOL, { slots: 8, capacity: 10, seconds: 12000 });
  const owner = { accountId: ownerId, request: context.ownerHTTP };
  const buildOutputs = {};
  const projects = {};
  for (const key of wanted) {
    const isMain = key === "fullstack_v1";
    const ownerScoped = isMain || key === "fullstack_v2";
    const client = ownerScoped ? owner : operator;
    const graph = ownerScoped
      ? exact(await client.request(`/v1/projects/${ownerProjectId}`), [200], "owner preview project graph")
      : await evaluatorProject(context, client, catalog, key);
    verifyGraph(graph, catalog, key);
    const sectionName = isMain ? "build" : "evaluators";
    const current = context.readManifest()[sectionName] ?? {};
    const section = isMain ? {
      ...current,
      projectId: current.projectId ?? manifest.identity.projectId,
      deploymentId: current.deploymentId ?? manifest.identity.deploymentId,
      sourceRevisionId: current.sourceRevisionId ?? manifest.source.sourceRevisionId,
      configurationRevisionId: current.configurationRevisionId ?? manifest.source.configurationRevisionId,
      compatibilityReportId: current.compatibilityReportId ?? manifest.source.compatibilityReportId,
    } : current[key] ?? {};
    const update = (patch) => context.updateManifest(isMain ? { build: patch } : { evaluators: { ...context.readManifest().evaluators, [key]: { ...context.readManifest().evaluators?.[key], ...patch, owner: ownerScoped ? "preview_owner" : "operator" } } });
    if (isMain) {
      if (!UUID.test(section.deploymentId ?? "") || section.projectId !== ownerProjectId) throw new Error("seeded owner build lacks exact initial deployment");
      update({ projectId: section.projectId, deploymentId: section.deploymentId,
        sourceRevisionId: section.sourceRevisionId, configurationRevisionId: section.configurationRevisionId,
        compatibilityReportId: section.compatibilityReportId });
    }
    if (!section.projectId) update({ projectId: graph.project.id });
    if (isMain && (section.sourceRevisionId && section.sourceRevisionId !== manifest.source.sourceRevisionId)) throw new Error("owner build source differs from seeded source");
    if (section.buildState === "succeeded") {
      const loaded = await loadPreviewBuilds(context, { keys: [key] });
      buildOutputs[key] = loaded.buildOutputs[key];
      projects[key] = loaded.projects[key];
      continue;
    }
    const result = await buildOne(context, client, catalog, profileMap, key, graph, section, update, { ownerRollout: key === "fullstack_v2" });
    buildOutputs[key] = result.outputs.length === 1 ? result.outputs[0] : result.outputs;
    projects[key] = { projectId: result.projectId, deploymentId: result.deploymentId, buildJobId: result.buildJobId, owner: ownerScoped ? "preview_owner" : "operator" };
  }
  return { buildOutputs, projects, main: projects.fullstack_v1 ?? null, profileDigests: Object.fromEntries(Object.entries(profileMap).map(([key, value]) => [key, value.digest])) };
}

/** Reattach to registered outputs after a managed restart; never enqueues work. */
export async function loadPreviewBuilds(context, { keys = REQUIRED } = {}) {
  const catalog = loadM3FixtureRepositories();
  const profileMap = profiles(context);
  const manifest = context.readManifest();
  const operator = await operatorClient(context);
  const buildOutputs = {};
  const projects = {};
  for (const key of [...new Set(keys)]) {
    if (!REQUIRED.includes(key) && key !== "incompatible_api") throw new Error(`unknown registered preview build: ${key}`);
    const isMain = key === "fullstack_v1";
    const ownerScoped = isMain || key === "fullstack_v2";
    const section = isMain ? manifest.build : manifest.evaluators?.[key];
    if (!UUID.test(section?.projectId ?? (isMain ? manifest.identity.projectId : "")) ||
        !UUID.test(section?.deploymentId ?? "") || !UUID.test(section?.buildJobId ?? "")) {
      throw new Error(`${key} registered build identity is incomplete`);
    }
    const projectId = section.projectId ?? manifest.identity.projectId;
    const client = ownerScoped ? { request: context.ownerHTTP } : operator;
    const detail = exact(await client.request(`/v1/projects/${projectId}/builds/${section.buildJobId}`), [200], `${key} registered build read`);
    const selected = catalog.commits[key];
    if (detail.build.project_id !== projectId || detail.build.deployment_id !== section.deploymentId ||
        detail.build.source_commit !== selected.commitSha || detail.build.source_tree_sha !== selected.treeSha ||
        detail.build.build_profile_digest !== profileMap[selected.toolchainProfile]?.digest ||
        detail.build.configuration_revision_id !== section.configurationRevisionId ||
        detail.build.source_revision_id !== section.sourceRevisionId ||
        detail.build.compatibility_report_id !== section.compatibilityReportId) {
      throw new Error(`${key} registered build identity drift`);
    }
    const result = outputs(context, catalog, key, detail);
    if (JSON.stringify(result.map((item) => item.archiveDigest)) !== JSON.stringify(section.archiveDigests) ||
        JSON.stringify(result.map((item) => item.artifactId)) !== JSON.stringify(section.artifactIds)) {
      throw new Error(`${key} registered output tuple differs from private seed manifest`);
    }
    buildOutputs[key] = result.length === 1 ? result[0] : result;
    projects[key] = { projectId, deploymentId: section.deploymentId, buildJobId: section.buildJobId,
      owner: ownerScoped ? "preview_owner" : "operator" };
  }
  return { buildOutputs, projects, main: projects.fullstack_v1 ?? null,
    profileDigests: Object.fromEntries(Object.entries(profileMap).map(([key, value]) => [key, value.digest])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const configPath = argv[argv.indexOf("--config") + 1];
  const keys = argv.includes("--key") ? argv.filter((arg, index) => argv[index - 1] === "--key") : REQUIRED;
  ensurePreviewBuilds(createPreviewContext(loadPreviewConfig(configPath)), { keys })
    .then((result) => process.stdout.write(`${JSON.stringify({ projects: result.projects, profileDigests: result.profileDigests })}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
