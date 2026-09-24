#!/usr/bin/env node
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";
import { readFileSync, openSync, closeSync, unlinkSync, existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadM3FixtureRepositories, createM3StandardProjectConfiguration } from "../../e2e/support/m3-fixtures.mjs";
import { loadPreviewConfig, createPreviewContext, readPreviewSecret } from "./preview-context.mjs";
import { ensurePreviewDraft } from "./portfolio.mjs";
import { startGitHubFixture } from "../../e2e/support/github-provider.mjs";
import { ensurePlatformDatabase, ensureProjectTarget, inspectProjectTarget, bindProjectPeerCredential } from "./database.mjs";
import { loadPreviewBuilds } from "./build.mjs";
import { createPreviewM3 } from "./preview-context.mjs";
import { ensurePreviewRuntime } from "./runtime.mjs";
import { activateManagedRelay } from "./managed-services.mjs";

const PROJECT_NAME = "Hostlet owned journal preview";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const databaseStateDir = (context) => context.config.postgres.stateDir ?? join(context.config.stateDir, "databases");
const opaque = (bytes) => randomBytes(bytes).toString("base64url");
function providerCredentials(context, create) {
  const path = context.config.provider.credentialsFile;
  if (existsSync(path)) {
    const value = JSON.parse(readPreviewSecret(path));
    if (value.schema !== "hostlet.beta.provider-credentials/v1" || value.appId !== 31001 ||
        !/^Iv1\.hostlet-[A-Za-z0-9_-]+$/.test(value.clientId ?? "") ||
        !/^[A-Za-z0-9_-]{40,}$/.test(value.clientSecret ?? "") ||
        !/^[A-Za-z0-9_-]{40,}$/.test(value.webhookSecret ?? "") ||
        !String(value.privateKeyPem ?? "").includes("-----BEGIN PRIVATE KEY-----")) throw new Error("invalid provider credentials file");
    return value;
  }
  if (!create) throw new Error("provider credentials have not been initialized");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const value = { schema: "hostlet.beta.provider-credentials/v1", appId: 31001,
    clientId: `Iv1.hostlet-${opaque(9)}`, clientSecret: opaque(36), webhookSecret: opaque(40), privateKeyPem: privateKey };
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return value;
}
async function providerService(context) {
  const catalog = loadM3FixtureRepositories();
  const credentials = providerCredentials(context, false);
  const callbackUrl = `${context.apiUrl}/github/callback`;
  const fixture = await startGitHubFixture({ registerSensitiveValues() {}, registerCleanup() {} }, {
    callbackUrl, fixtureData: catalog.fixtureData, gitBlobSha1: true,
    stableCredentials: credentials, stateFile: context.config.provider.stateFile, listenPort: context.config.provider.port,
    previewOAuthUsers: {
      [context.config.owner.githubLogin]: catalog.fixtureData.oauth_users.primary,
      [context.config.operator.githubLogin]: catalog.fixtureData.oauth_users.secondary,
      [context.config.otherOwner.githubLogin]: { id: 22003, login: context.config.otherOwner.githubLogin },
    },
  });
  fixture.controls.setGrant({ installationId: catalog.fixtureData.installation.id,
    repositoryIds: catalog.fixtureData.repositories.map(({ id }) => id), contentsPermission: "read", suspended: false });
  process.stdout.write(`${JSON.stringify({ providerOrigin: fixture.baseUrl, fixture: catalog.fixtureData.fixture_name })}\n`);
  await new Promise((resolveService) => {
    process.once("SIGTERM", resolveService);
    process.once("SIGINT", resolveService);
  });
  await fixture.close();
}
function requireStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label} failed (${response.status}: ${response.payload?.error?.code ?? "unknown"})`);
  return response.payload;
}
function command(binary, args, environment) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (bytes) => { output += bytes; });
    child.stderr.on("data", (bytes) => { output += bytes; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveCommand(output) : reject(new Error(`${binary} exited ${code}: ${output.slice(-500)}`)));
  });
}
async function migrate(context) {
  const platform = await ensurePlatformDatabase({ stateDir: databaseStateDir(context),
    port: context.config.postgres.platform.port,
    connectionUrlFile: context.config.postgres.platform.connectionUrlFile });
  const url = readPreviewSecret(context.config.postgres.platform.connectionUrlFile);
  const parsed = new URL(url);
  const databaseEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
    PGPASSWORD: decodeURIComponent(parsed.password) };
  const query = (sql) => command("docker", ["exec", "--env", "PGPASSWORD", platform.containerId,
    "psql", "--no-psqlrc", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-Atqc", sql], databaseEnv);
  const sql = "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public') THEN 'populated' ELSE 'empty' END";
  const condition = (await query(sql)).trim();
  if (condition === "populated") {
    const version = (await query("SELECT current_version FROM platform_schema_compatibility WHERE singleton=true")).trim();
    if (version !== "6") throw new Error(`existing platform schema ${version} requires a separate verified upgrade`);
    return { migrated: false, schemaVersion: 6 };
  }
  if (condition !== "empty") throw new Error("could not prove owned platform database is empty");
  await command(context.config.binaries.control, ["migrate"], { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url });
  const version = (await query("SELECT current_version FROM platform_schema_compatibility WHERE singleton=true")).trim();
  if (version !== "6") throw new Error(`initial schema migration did not reach schema 6 (observed ${version})`);
  return { migrated: true, schemaVersion: 6 };
}

async function platformQuery(context, sql) {
  const platform = await ensurePlatformDatabase({ stateDir: databaseStateDir(context),
    port: context.config.postgres.platform.port,
    connectionUrlFile: context.config.postgres.platform.connectionUrlFile });
  const url = new URL(readPreviewSecret(platform.connectionUrlFile));
  const result = await command("docker", ["exec", "--env", "PGPASSWORD", platform.containerId,
    "psql", "--no-psqlrc", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-Atqc", sql],
  { PATH: process.env.PATH, HOME: process.env.HOME, PGPASSWORD: decodeURIComponent(url.password) });
  return result.trim();
}

function bootstrapSql(context) {
  const bytes = readFileSync(resolve(import.meta.dirname, "../../scripts/database/fixture-bootstrap.sql"));
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const directory = join(databaseStateDir(context), "database-fixtures", "sha256", digest.slice(7, 9));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest.slice(9)}.sql`);
  if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  if (!readFileSync(path).equals(bytes)) throw new Error("private tenant bootstrap SQL differs from pinned fixture digest");
  return digest;
}

export async function ensurePreviewProjectDatabase(context, { drainWorker } = {}) {
  const manifest = context.readManifest();
  const projectId = manifest.identity.projectId;
  const ownerId = manifest.identity.ownerId;
  const deploymentId = manifest.identity.deploymentId;
  const reservation = manifest.build.reservation;
  if (!UUID.test(ownerId ?? "") || !UUID.test(projectId ?? "") || !UUID.test(deploymentId ?? "") || !UUID.test(reservation?.id ?? "")) {
    throw new Error("project database requires exact admitted preview project/deployment/reservation");
  }
  const graph = requireStatus(await context.ownerHTTP(`/v1/projects/${projectId}`), 200, "project database graph");
  const service = graph.services.find((entry) => entry.configuration.kind === "postgres");
  if (!service?.id) throw new Error("preview project has no declared PostgreSQL service");
  const path = `/v1/projects/${projectId}/services/${service.id}/tenant-database`;
  let read = await context.ownerHTTP(path);
  let record;
  if (read.status === 200) record = read.payload;
  else if (read.status === 404) {
    const created = await context.ownerHTTP(`/v1/projects/${projectId}/deployments/${deploymentId}/tenant-databases`, {
      method: "POST", headers: { "Idempotency-Key": "m35-owned-project-database", "If-Match": `"${graph.project.revision}"` },
      body: { configuration_revision_id: graph.configuration.id, service_id: service.id,
        reservation_id: reservation.id, reservation_epoch: reservation.reservation_epoch },
    });
    record = requireStatus(created, 201, "project database intent");
  } else throw new Error(`project database read failed (${read.status})`);
  if (!UUID.test(record.id ?? "") || !UUID.test(record.generation ?? "")) throw new Error("project database intent lacks durable identity");
  if (manifest.database?.id && (manifest.database.id !== record.id || manifest.database.generation !== record.generation)) {
    throw new Error("project database differs from private identity manifest");
  }
  context.updateManifest({ database: { id: record.id, generation: record.generation, serviceId: service.id } });
  const target = await ensureProjectTarget({ stateDir: databaseStateDir(context), tenantDatabaseId: record.id,
    databaseGeneration: record.generation,
    endpointIpv4: context.config.postgres.project.endpointIpv4,
    endpointIpv6: context.config.postgres.project.endpointIpv6 });
  if (record.state !== "ready") {
    if (drainWorker) await drainWorker();
    else {
      const digest = bootstrapSql(context);
      const recoveryKey = readPreviewSecret(context.config.roles.tenantRecoveryKeyFile);
      context.registerSensitiveValues([recoveryKey]);
      const environment = context.componentEnvironment("database", {
        HOSTLET_M3_STATE_DIR: databaseStateDir(context),
        HOSTLET_TENANT_RECOVERY_KEY: recoveryKey,
        HOSTLET_TENANT_RECOVERY_KEY_ID: "preview-v1",
        HOSTLET_M3_FIXTURE_BOOTSTRAP_SHA256: digest,
      });
      const result = await context.runCommand("preview project database provision", context.config.binaries.database,
        ["worker", "--control-url", context.workerUrl, "--worker-id", "m35-owned-project-database", "--once", "--kind", "provision"],
        { env: environment, timeoutMs: 180_000, logName: "preview-project-database-provision.log" });
      if (result.code !== 0) throw new Error("real project database worker failed; inspect private worker log");
    }
    for (let attempt = 0; attempt < 80; attempt++) {
      read = await context.ownerHTTP(path);
      if (read.status === 200 && read.payload?.state === "ready") break;
      await context.delay(250);
    }
    if (read.status !== 200 || read.payload?.state !== "ready") throw new Error(`project database did not reach ready (${read.status}/${read.payload?.state ?? "unknown"})`);
    record = read.payload;
  }
  if (record.id !== target.databaseId || record.generation !== target.databaseGeneration || record.state !== "ready") {
    throw new Error("ready project database identity differs from exact owned target");
  }
  const metadataText = await platformQuery(context, `SELECT json_build_object('databaseRef',d.database_ref,'roleRef',c.role_ref,'credentialVersionId',c.id::text)
    FROM tenant_databases d JOIN tenant_database_credentials c ON c.tenant_database_id=d.id AND c.database_generation=d.generation
      AND c.account_id=d.account_id AND c.project_id=d.project_id
    WHERE d.account_id='${ownerId}'::uuid AND d.project_id='${projectId}'::uuid
      AND d.id='${record.id}'::uuid AND d.generation='${record.generation}'::uuid
      AND d.state='ready' AND c.purpose='runtime' AND c.status='active'`);
  if (!metadataText) throw new Error("real ready project database has no active runtime credential metadata");
  const metadata = JSON.parse(metadataText);
  const peer = bindProjectPeerCredential(target.databasePeer, metadata);
  context.updateManifest({ database: { id: record.id, generation: record.generation,
    databaseRef: metadata.databaseRef, roleRef: metadata.roleRef, credentialVersionId: metadata.credentialVersionId } });
  return { record, peer, target, tenantPeers: new Map([[projectId, peer]]) };
}

export async function composePreview(context, { activateRelay } = {}) {
  const manifest = context.readManifest();
  if (!UUID.test(manifest.identity.projectId ?? "") || !UUID.test(manifest.identity.deploymentId ?? "")) {
    throw new Error("preview seed must complete before composition");
  }
  const builds = await loadPreviewBuilds(context);
  if (builds.main?.projectId !== manifest.identity.projectId || builds.main?.deploymentId !== manifest.identity.deploymentId) {
    throw new Error("registered owner build differs from seeded project/deployment");
  }
  const database = await ensurePreviewProjectDatabase(context);
  const m3 = { ...(await createPreviewM3(context)), postgres: {
    psqlJson: async (_label, sql) => JSON.parse(await platformQuery(context, sql)),
  } };
  m3.state.buildOutputs = builds.buildOutputs;
  m3.state.tenantPeers = database.tenantPeers;
  const commit = context.config.releaseCommit;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("exact installed release commit is required for managed relay activation");
  if (context.config.services.projectId !== manifest.identity.projectId) throw new Error("managed service project identity differs from seeded project");
  const relayActivator = activateRelay ?? ((tuplePath) => activateManagedRelay({ config: context.config,
    commit, tuplePath, outputDir: join(context.stateDir, "rendered-units") }));
  const runtime = await ensurePreviewRuntime({ context, m3, buildOutputs: builds.buildOutputs,
    tenantPeers: database.tenantPeers, nodeBaseRoots: context.config.runtimeNodeBases,
    projectId: manifest.identity.projectId, deploymentId: manifest.identity.deploymentId,
    databasePeer: database.peer, databaseRecord: database.record,
    stateRoot: join(context.stateDir, "runtime-state"), artifactRoot: join(context.stateDir, "runtime-artifacts"),
    manifest: context.readManifest(), updateManifest: context.updateManifest,
    demoOrigin: context.config.origins.demo, localHostname: context.config.services.demoHostname,
    localPort: context.config.services.ports.demoGateway,
    certificate: context.config.services.paths.demoCertificate,
    privateKey: context.config.services.paths.demoPrivateKey,
    activateRelay: relayActivator,
  });
  return { projectId: manifest.identity.projectId, deploymentId: manifest.identity.deploymentId,
    databaseId: database.record.id, releaseId: runtime.release.id,
    routeDigest: runtime.route.digest, demoStatus: runtime.demo.status, reused: runtime.reused };
}

export async function recoverPreview(context, options = {}) {
  const manifest = context.readManifest();
  if (!UUID.test(manifest.identity?.projectId ?? "") || !UUID.test(manifest.database?.id ?? "") ||
      !UUID.test(manifest.database?.generation ?? "") || !UUID.test(manifest.runtime?.releaseId ?? "") ||
      !manifest.runtime?.evaluationRef) throw new Error("preview recovery requires a fully seeded real release and database");
  const database = await context.ownerHTTP(`/v1/projects/${manifest.identity.projectId}/services/${manifest.database.serviceId}/tenant-database`);
  if (database.status !== 200 || database.payload?.state !== "ready" ||
      database.payload.id !== manifest.database.id || database.payload.generation !== manifest.database.generation) {
    throw new Error("preview recovery database intent is not the exact ready owned record");
  }
  await inspectProjectTarget({ stateDir: databaseStateDir(context), tenantDatabaseId: manifest.database.id,
    databaseGeneration: manifest.database.generation,
    endpointIpv4: context.config.postgres.project.endpointIpv4,
    endpointIpv6: context.config.postgres.project.endpointIpv6 });
  return composePreview(context, options);
}

async function seed(context, stopAfter) {
  const manifest = context.readManifest();
  const accountSession = async (config, label) => {
    const password = readPreviewSecret(config.passwordFile);
    let active = await context.call("/v1/sessions", { method: "POST", body: { email: config.email, password } });
    if (active.status !== 201) {
      const created = await context.call("/v1/accounts", { method: "POST", body: { email: config.email, display_name: config.displayName, password } });
      requireStatus(created, 201, `${label} account creation`);
      active = await context.call("/v1/sessions", { method: "POST", body: { email: config.email, password } });
    }
    return requireStatus(active, 201, `${label} sign-in`);
  };
  const session = { payload: await accountSession(context.config.owner, "owner") };
  const ownerId = session.payload.account_id;
  if (manifest.identity.ownerId && manifest.identity.ownerId !== ownerId) throw new Error("owner identity mismatch with private manifest");
  context.updateManifest({ identity: { ownerId } });
  if (stopAfter === "account") throw new Error("deliberate interruption after account");
  const operator = await accountSession(context.config.operator, "operator");
  if (manifest.identity.operatorId && manifest.identity.operatorId !== operator.account_id) throw new Error("operator identity mismatch with private manifest");
  context.updateManifest({ identity: { operatorId: operator.account_id } });
  context.state.operator = { record: { id: operator.account_id }, token: operator.token };
  const other = await accountSession(context.config.otherOwner, "other owner");
  if (manifest.identity.otherOwnerId && manifest.identity.otherOwnerId !== other.account_id) throw new Error("other owner identity mismatch with private manifest");
  context.updateManifest({ identity: { otherOwnerId: other.account_id } });

  const list = requireStatus(await context.ownerHTTP("/v1/projects"), 200, "owner project list");
  const projects = list.projects ?? list.items ?? [];
  let graph;
  if (manifest.identity.projectId) {
    graph = requireStatus(await context.ownerHTTP(`/v1/projects/${manifest.identity.projectId}`), 200, "owned project read");
  } else {
    const match = projects.find((entry) => entry.name === PROJECT_NAME);
    if (match) graph = requireStatus(await context.ownerHTTP(`/v1/projects/${match.id}`), 200, "owned project recovery");
    else {
      const created = await context.ownerHTTP("/v1/projects", { method: "POST", headers: { "Idempotency-Key": "m35-owned-preview-project" },
        body: { name: PROJECT_NAME, configuration: createM3StandardProjectConfiguration("fullstack_v1") } });
      graph = requireStatus(created, 201, "owned project creation");
    }
  }
  const projectId = graph.project.id;
  context.updateManifest({ identity: { projectId } });
  context.state.owner = { record: { id: ownerId }, token: session.payload.token };
  context.state.graph = graph;
  if (stopAfter === "project") throw new Error("deliberate interruption after project");

  const selected = loadM3FixtureRepositories().commits.fullstack_v1;
  const savedSource = context.readManifest().source;
  if (savedSource.sourceRevisionId && (savedSource.commitSha !== selected.commitSha || savedSource.treeSha !== selected.treeSha ||
      savedSource.repositoryId !== selected.repositoryId || !UUID.test(savedSource.configurationRevisionId ?? "") ||
      !UUID.test(savedSource.compatibilityReportId ?? ""))) throw new Error("seeded exact source manifest is incomplete or drifted");
  let source = savedSource.sourceRevisionId ? { id: savedSource.sourceRevisionId,
    resolved_commit: savedSource.commitSha, tree_sha: savedSource.treeSha } : null;
  let report = savedSource.sourceRevisionId ? { id: savedSource.compatibilityReportId,
    source_revision_id: savedSource.sourceRevisionId, status: "candidate" } : null;
  if (!source) {
  let sourceResponse = await context.ownerHTTP(`/v1/projects/${projectId}/github-source`);
  if (sourceResponse.status === 404) {
    const attempt = requireStatus(await context.ownerHTTP("/v1/github/oauth-attempts", { method: "POST" }), 201, "owned OAuth attempt");
    const authorizationUrl = new URL(attempt.authorization_url);
    if (authorizationUrl.protocol !== "http:" || authorizationUrl.hostname !== "127.0.0.1" ||
        authorizationUrl.port !== String(context.config.provider.port) ||
        authorizationUrl.pathname !== "/login/oauth/authorize") {
      throw new Error("owned authorization URL is outside the configured synthetic provider");
    }
    authorizationUrl.searchParams.set("hostlet_preview_login", context.config.owner.githubLogin);
    const authorization = await fetch(authorizationUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (authorization.status !== 302) throw new Error(`owned provider authorization failed (${authorization.status})`);
    const callback = new URL(authorization.headers.get("location"));
    requireStatus(await context.ownerHTTP("/v1/github/oauth-completions", { method: "POST", body: {
      code: callback.searchParams.get("code"), state: callback.searchParams.get("state"),
    } }), 200, "owned OAuth completion");
    const bind = await context.ownerHTTP(`/v1/projects/${projectId}/github-source`, { method: "PUT",
      headers: { "Idempotency-Key": "m35-owned-exact-source", "If-Match": `"${graph.project.revision}"` },
      body: { installation_id: 42001, repository_id: selected.repositoryId, ref: `refs/heads/${selected.branch}` } });
    sourceResponse = { status: 200, payload: requireStatus(bind, 200, "exact source binding") };
  }
  requireStatus(sourceResponse, 200, "exact source read");
  source = sourceResponse.payload.source_revision;
  if (source?.resolved_commit !== selected.commitSha || source?.tree_sha !== selected.treeSha) throw new Error("bound source does not match selected exact owned revision");
  if (!source.id) throw new Error("bound source lacks durable revision identity");
  if (!context.readManifest().source.sourceRevisionId && source.source !== "owner_resolve") {
    const resolved = await context.ownerHTTP(`/v1/projects/${projectId}/github-source/resolve`, {
      method: "POST", headers: { "Idempotency-Key": "m35-owned-source-resolve", "If-Match": `"${sourceResponse.payload.revision}"` },
    });
    source = requireStatus(resolved, 200, "explicit exact source resolution").source_revision;
    if (source?.resolved_commit !== selected.commitSha || source?.tree_sha !== selected.treeSha) throw new Error("resolved source does not match selected exact owned revision");
  }
  graph = requireStatus(await context.ownerHTTP(`/v1/projects/${projectId}`), 200, "project graph after source binding");
  const latestReport = await context.ownerHTTP(`/v1/projects/${projectId}/compatibility-reports/latest?source_revision_id=${encodeURIComponent(source.id)}&configuration_revision_id=${encodeURIComponent(graph.configuration.id)}`);
  if (latestReport.status === 200) report = latestReport.payload;
  else if (latestReport.status === 404) {
    const created = await context.ownerHTTP(`/v1/projects/${projectId}/compatibility-reports`, { method: "POST",
      headers: { "Idempotency-Key": "m35-owned-exact-compatibility", "If-Match": `"${graph.project.revision}"` },
      body: { source_revision_id: source.id, configuration_revision_id: graph.configuration.id } });
    report = requireStatus(created, 201, "exact source advisory");
  } else throw new Error(`compatibility read failed (${latestReport.status})`);
  if (report.status !== "candidate" || report.source_revision_id !== source.id) throw new Error("exact source advisory was not a candidate");
  context.updateManifest({ source: { sourceRevisionId: source.id, configurationRevisionId: graph.configuration.id,
    compatibilityReportId: report.id, commitSha: selected.commitSha, treeSha: selected.treeSha,
    repositoryId: selected.repositoryId } });
  }
  if (stopAfter === "source") throw new Error("deliberate interruption after source");

  let deployment;
  const priorDeploymentId = context.readManifest().identity.deploymentId;
  if (priorDeploymentId) {
    deployment = requireStatus(await context.ownerHTTP(`/v1/projects/${projectId}/deployments/${priorDeploymentId}`), 200, "owned deployment read");
  } else {
    if (graph.configuration.id !== context.readManifest().source.configurationRevisionId) {
      throw new Error("project configuration changed before initial deployment intent; owner review required");
    }
    const created = await context.ownerHTTP(`/v1/projects/${projectId}/deployment-intents`, { method: "POST",
      headers: { "Idempotency-Key": "m35-owned-preview-deployment", "If-Match": `"${graph.project.revision}"` },
      body: { configuration_revision_id: graph.configuration.id, source_commit: selected.commitSha } });
    deployment = requireStatus(created, 201, "exact deployment intent");
  }
  if (deployment.source_commit !== selected.commitSha || deployment.configuration_revision_id !== context.readManifest().source.configurationRevisionId) throw new Error("deployment intent differs from selected source/configuration");
  context.updateManifest({ identity: { deploymentId: deployment.id } });
  const priorBuildDeployment = context.readManifest().build.deploymentId;
  if (priorBuildDeployment && priorBuildDeployment !== deployment.id) throw new Error("build manifest deployment differs from owned seed deployment");
  context.updateManifest({ build: { projectId, deploymentId: deployment.id } });
  graph = requireStatus(await context.ownerHTTP(`/v1/projects/${projectId}`), 200, "project graph after deployment intent");

  const draft = await ensurePreviewDraft(context, { projectId, configurationRevisionId: context.readManifest().source.configurationRevisionId,
    sourceRevisionId: source.id, compatibilityReportId: report.id });
  if (stopAfter === "draft") throw new Error("deliberate interruption after draft");
  return { ownerId, projectId, deploymentId: deployment.id, sourceRevisionId: source.id, commitSha: selected.commitSha,
    treeSha: selected.treeSha, compatibilityReportId: report.id, draftRevisionId: draft.id, existingDraft: draft.existing };
}

export async function runBootstrap(action, configPath, { stopAfter } = {}) {
  const context = createPreviewContext(loadPreviewConfig(configPath));
  if (action === "init-provider") {
    providerCredentials(context, true);
    return { credentialsFile: context.config.provider.credentialsFile, providerPort: context.config.provider.port };
  }
  if (action === "provider-service") return providerService(context);
  const lockPath = `${context.manifestPath}.lock`;
  let lock;
  let failure;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    if (action === "migrate") return await migrate(context);
    if (action === "seed") return await seed(context, stopAfter);
    if (action === "compose") return await composePreview(context);
    if (action === "recover") return await recoverPreview(context);
    throw new Error(`unknown bootstrap action: ${action}`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await context.runCleanups();
    } catch (error) {
      if (!failure) failure = error;
      else process.stderr.write(`preview cleanup also failed: ${error.message}\n`);
    } finally {
      if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
    }
    if (failure) throw failure;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...argv] = process.argv.slice(2);
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  runBootstrap(action, option("--config"), { stopAfter: option("--stop-after") })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
