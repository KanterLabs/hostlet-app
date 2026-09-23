import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createFoundationCredentials, credentialValues, productEnvironment } from "./credentials.mjs";
import { OwnedPostgres } from "./docker-postgres.mjs";
import {
  createM3StandardProjectConfiguration,
  loadM3FixtureRepositories,
  registerM3FixtureSources,
} from "./m3-fixtures.mjs";
import { startGitHubFixture } from "./github-provider.mjs";
import { assertStatus, expectScenario, requestJson } from "./http-client.mjs";
import { registerRetainedM2Fixtures, resolveRetainedM2Binary } from "./retained-m2.mjs";
import { registerM3UpgradeFixtures, runM3UpgradeScenarios } from "../scenarios/m3-upgrade.mjs";

const ROLE_ENVIRONMENT = Object.freeze({
  build: "HOSTLET_M3_BUILD_TOKEN",
  database: "HOSTLET_M3_DATABASE_TOKEN",
  runtime: "HOSTLET_M3_RUNTIME_TOKEN",
  publisher: "HOSTLET_M3_PUBLISHER_TOKEN",
});

function opaque(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function hostProcessEnvironment() {
  const environment = {};
  for (const name of [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "RUST_BACKTRACE",
    "RUSTUP_HOME", "CARGO_HOME", "RUSTC_WRAPPER",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function environmentWithout(base, names) {
  const result = { ...base };
  for (const name of names) delete result[name];
  return result;
}

function createPolicyClock(context) {
  const stateDir = join(context.tempDir, "m3-owned-state");
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const canonicalStateDir = realpathSync(stateDir);
  const path = join(canonicalStateDir, "policy-clock.json");
  let value = Object.freeze({
    schema_version: 1,
    generation: 1,
    now: new Date().toISOString(),
  });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  if ((statSync(canonicalStateDir).mode & 0o777) !== 0o700 || (statSync(path).mode & 0o777) !== 0o600) {
    throw new Error("M3 state directory and policy clock permissions are not private");
  }

  const write = (next) => {
    if (
      next?.schema_version !== 1 ||
      !Number.isSafeInteger(next.generation) || next.generation <= value.generation ||
      !Number.isFinite(Date.parse(next.now)) || Date.parse(next.now) < Date.parse(value.now)
    ) {
      throw new Error("M3 policy clock updates must advance generation and never regress UTC time");
    }
    const temporary = join(canonicalStateDir, `policy-clock-${next.generation}-${opaque(8)}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    value = Object.freeze({ ...next });
    context.state.configuration.m3PolicyClock.advances.push({
      generation: value.generation,
      now: value.now,
    });
    return value;
  };

  return Object.freeze({
    stateDir: canonicalStateDir,
    path,
    current: () => value,
    advance({ now, milliseconds } = {}) {
      if (now !== undefined && milliseconds !== undefined) {
        throw new Error("advance the M3 policy clock by an exact UTC value or milliseconds, not both");
      }
      if (milliseconds !== undefined && (!Number.isFinite(milliseconds) || milliseconds < 0)) {
        throw new Error("M3 policy clock milliseconds must be a finite non-negative number");
      }
      const epoch = now === undefined ? Date.parse(value.now) + (milliseconds ?? 1) : Date.parse(now);
      if (!Number.isFinite(epoch)) throw new Error("M3 policy clock requires a valid UTC value");
      const nextNow = new Date(epoch).toISOString();
      return write({ schema_version: 1, generation: value.generation + 1, now: nextNow });
    },
  });
}

async function prepareOwnedProvider(m3) {
  if (m3.state.githubFixture) throw new Error("M3 GitHub fixture is already prepared");
  const callbackUrl = `${m3.apiUrl}/github/callback`;
  const fixture = await startGitHubFixture(m3.context, {
    callbackUrl,
    fixtureData: m3.fixtureCatalog.fixtureData,
    gitBlobSha1: true,
  });
  fixture.controls.setGrant({
    installationId: m3.fixtureCatalog.fixtureData.installation.id,
    repositoryIds: m3.fixtureCatalog.fixtureData.repositories.map(({ id }) => id),
    contentsPermission: "read",
    suspended: false,
  });
  Object.assign(m3.extraEnvironment, fixture.controls.environment(callbackUrl));
  m3.state.githubFixture = fixture;
  m3.context.state.configuration.m3GitHub = {
    provider: "owned synthetic loopback GitHub HTTP fixture",
    providerOrigin: fixture.baseUrl,
    callbackOrigin: new URL(callbackUrl).origin,
    fixtureName: m3.fixtureCatalog.fixtureData.fixture_name,
    gitObjectIdentity: "SHA-1 fixture object IDs over owned source bytes",
    retainedCredentials: 0,
  };
  return fixture;
}

async function seedOwnedSelectedSource(m3) {
  const fixture = m3.state.githubFixture;
  if (!fixture) throw new Error("M3 selected source requires the prepared GitHub fixture");
  const selected = m3.fixtureCatalog.commits.fullstack_v1;
  expectScenario(Boolean(selected), "M3 owned full-stack v1 source is available", {
    fullstack_v1_source_present: false,
  });

  const attempt = await m3.call("/v1/github/oauth-attempts", {
    method: "POST",
    token: m3.state.owner.token,
  });
  assertStatus(attempt, 201, "M3 retained OAuth attempt");
  fixture.controls.authorizeNext({ mode: "success" });
  const authorization = await fetch(attempt.payload.authorization_url, {
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(10_000), m3.context.abortSignal]),
  });
  expectScenario(
    authorization.status >= 300 && authorization.status < 400,
    "M3 owned provider OAuth redirect",
    { provider_authorization_status: authorization.status },
  );
  const location = authorization.headers.get("location");
  expectScenario(typeof location === "string", "M3 owned provider supplies callback location", {
    callback_location_present: false,
  });
  const callback = new URL(location);
  const code = callback.searchParams.get("code");
  const oauthState = callback.searchParams.get("state");
  expectScenario(Boolean(code && oauthState), "M3 OAuth callback supplies code and state", {
    code_and_state_present: false,
  });
  m3.context.registerSensitiveValues([code, oauthState]);
  const connected = await m3.call("/v1/github/oauth-completions", {
    method: "POST",
    token: m3.state.owner.token,
    body: { code, state: oauthState },
  });
  assertStatus(connected, 200, "M3 retained OAuth completion");

  const current = await m3.call(`/v1/projects/${m3.state.graph.project.id}`, {
    token: m3.state.owner.token,
  });
  assertStatus(current, 200, "M3 selected-source project revision");
  const source = await m3.call(`/v1/projects/${m3.state.graph.project.id}/github-source`, {
    method: "PUT",
    token: m3.state.owner.token,
    headers: {
      "Idempotency-Key": "m3-upgrade-owned-source-bind",
      "If-Match": `"${current.payload.project.revision}"`,
    },
    body: {
      installation_id: m3.fixtureCatalog.fixtureData.installation.id,
      repository_id: selected.repositoryId,
      ref: `refs/heads/${selected.branch}`,
    },
  });
  assertStatus(source, 200, "M3 retained exact-source binding");
  expectScenario(
    source.payload?.source_revision?.resolved_commit === selected.commitSha &&
      source.payload?.source_revision?.tree_sha === selected.treeSha &&
      source.payload?.repository?.id === selected.repositoryId &&
      source.payload?.repository?.private === true,
    "M3 retained binding resolves the owned exact source and tree",
    {
      commit_match: source.payload?.source_revision?.resolved_commit === selected.commitSha,
      tree_match: source.payload?.source_revision?.tree_sha === selected.treeSha,
      repository_id: source.payload?.repository?.id ?? null,
    },
  );
  const resolved = await m3.call(`/v1/projects/${m3.state.graph.project.id}/github-source/resolve`, {
    method: "POST",
    token: m3.state.owner.token,
    headers: {
      "Idempotency-Key": "m3-upgrade-owned-source-resolve",
      "If-Match": `"${source.payload.revision}"`,
    },
  });
  assertStatus(resolved, 200, "M3 retained explicit source resolution");
  expectScenario(
    resolved.payload?.source_revision?.resolved_commit === selected.commitSha &&
      resolved.payload?.source_revision?.tree_sha === selected.treeSha,
    "M3 explicit resolution retains the exact owned commit and tree",
    {
      commit_match: resolved.payload?.source_revision?.resolved_commit === selected.commitSha,
      tree_match: resolved.payload?.source_revision?.tree_sha === selected.treeSha,
    },
  );

  const graph = await m3.call(`/v1/projects/${m3.state.graph.project.id}`, {
    token: m3.state.owner.token,
  });
  assertStatus(graph, 200, "M3 selected-source current graph");
  const report = await m3.call(
    `/v1/projects/${m3.state.graph.project.id}/compatibility-reports`,
    {
      method: "POST",
      token: m3.state.owner.token,
      headers: {
        "Idempotency-Key": "m3-upgrade-owned-compatibility",
        "If-Match": `"${graph.payload.project.revision}"`,
      },
      body: {
        source_revision_id: resolved.payload.source_revision.id,
        configuration_revision_id: graph.payload.configuration.id,
      },
    },
  );
  assertStatus(report, 201, "M3 retained compatibility analysis");
  expectScenario(
    report.payload?.status === "candidate" &&
      report.payload?.source_revision_id === resolved.payload.source_revision.id &&
      report.payload?.configuration_revision_id === graph.payload.configuration.id &&
      report.payload?.deployment_verified === false,
    "M3 retained compatibility is an advisory candidate for the exact source",
    {
      status: report.payload?.status ?? null,
      source_revision_match:
        report.payload?.source_revision_id === resolved.payload.source_revision.id,
      deployment_verified: report.payload?.deployment_verified ?? null,
      reason_codes: Array.isArray(report.payload?.facts?.reasons)
        ? report.payload.facts.reasons.map(({ code }) => code).filter((code) => typeof code === "string")
        : [],
      required_configuration_questions: Array.isArray(report.payload?.facts?.configuration_questions)
        ? report.payload.facts.configuration_questions
          .filter(({ required }) => required === true)
          .map(({ key, name, code }) => key ?? name ?? code ?? "unnamed")
        : [],
    },
  );
  fixture.controls.assertNoUnexpectedRequests();

  m3.state.graph = graph.payload;
  m3.state.m3OwnedSource = Object.freeze({
    fixture: selected,
    graph: graph.payload,
    source: resolved.payload,
    report: report.payload,
  });
  return Object.freeze({
    projectId: graph.payload.project.id,
    configurationRevisionId: graph.payload.configuration.id,
    sourceRevisionId: resolved.payload.source_revision.id,
    compatibilityReportId: report.payload.id,
    status: report.payload.status,
    commitSha: selected.commitSha,
    treeSha: selected.treeSha,
    repositoryId: selected.repositoryId,
  });
}

export async function runM3Context(context, runPostUpgrade = async () => {}) {
  context.registerFixture("M3 reusable E2E context", "e2e/support/m3-context.mjs");
  context.registerFixture("M3 PostgreSQL image pin", "e2e/postgres-image.txt");
  for (const support of ["credentials.mjs", "docker-postgres.mjs", "http-client.mjs", "github-provider.mjs"]) {
    context.registerFixture(`M3 context support: ${support}`, `e2e/support/${support}`);
  }
  const retainedManifest = registerRetainedM2Fixtures(context);
  const upgradeManifest = registerM3UpgradeFixtures(context);
  registerM3FixtureSources(context);
  const fixtureCatalog = Object.freeze({
    ...loadM3FixtureRepositories(),
    standardProjectConfiguration: createM3StandardProjectConfiguration("fullstack_v1"),
  });

  const image = readFileSync(join(context.repo, "e2e", "postgres-image.txt"), "utf8").trim();
  const credentials = createFoundationCredentials();
  const workerTokens = Object.freeze({
    build: opaque(),
    database: opaque(),
    runtime: opaque(),
    publisher: opaque(),
  });
  context.registerSensitiveValues([...credentialValues(credentials), ...Object.values(workerTokens)]);
  context.state.configuration.m3PolicyClock = { mode: "explicit_file", generation: 1, advances: [] };
  const policyClock = createPolicyClock(context);
  context.state.configuration.m3PolicyClock.initialNow = policyClock.current().now;

  const postgresPort = await context.allocatePort();
  const apiPort = await context.allocatePort();
  const workerPort = await context.allocatePort();
  const postgres = new OwnedPostgres(context, {
    image,
    password: credentials.postgresPassword,
    hostPort: postgresPort,
  });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const currentApiBinary = join(context.repo, "target", "debug", "hostlet-control");
  const retainedM2Binary = await resolveRetainedM2Binary(context, retainedManifest);
  const configuration = {
    databaseUrl: postgres.databaseUrl,
    apiBind: `127.0.0.1:${apiPort}`,
    workerBind: `127.0.0.1:${workerPort}`,
    workerLeaseSeconds: 10,
  };
  const baseEnvironment = productEnvironment(process.env, configuration, credentials);
  const extraEnvironment = {
    HOSTLET_M3_MODE: "owned_fixture",
    HOSTLET_M3_STATE_DIR: policyClock.stateDir,
    HOSTLET_M3_POLICY_CLOCK: policyClock.path,
    ...Object.fromEntries(
      Object.entries(ROLE_ENVIRONMENT).map(([role, name]) => [name, workerTokens[role]]),
    ),
  };
  const state = {
    owner: null,
    other: null,
    graph: null,
    jobs: null,
    githubFixture: null,
    m3OwnedSource: null,
    baselineSchema5: null,
    postUpgradeSchema6: null,
    backupReceipt: null,
  };
  let api = null;
  let apiSequence = 0;
  let activeBinary = retainedM2Binary;

  const environmentForProbe = (overrides = {}, removeEnvironment = []) =>
    environmentWithout({
      ...hostProcessEnvironment(),
      DATABASE_URL: configuration.databaseUrl,
      HOSTLET_RECOVERY_KEY: credentials.recoveryKey,
      HOSTLET_PG_CONTAINER: postgres.containerName,
      ...overrides,
    }, removeEnvironment);
  const environmentForApi = (overrides = {}, removeEnvironment = []) =>
    environmentWithout({
      ...baseEnvironment,
      HOSTLET_PG_CONTAINER: postgres.containerName,
      ...extraEnvironment,
      ...overrides,
    }, removeEnvironment);
  const componentEnvironment = (role, overrides = {}, removeEnvironment = []) => {
    const variable = ROLE_ENVIRONMENT[role];
    if (!variable) throw new Error(`unknown M3 worker role: ${role}`);
    return environmentWithout({
      ...hostProcessEnvironment(),
      HOSTLET_M3_MODE: "owned_fixture",
      HOSTLET_M3_STATE_DIR: policyClock.stateDir,
      HOSTLET_M3_POLICY_CLOCK: policyClock.path,
      [variable]: workerTokens[role],
      ...overrides,
    }, removeEnvironment);
  };
  const call = (path, options = {}) => requestJson(apiUrl, path, {
    ...options,
    abortSignal: context.abortSignal,
  });
  const ownerHTTP = (path, options = {}) => {
    if (!state.owner?.token) throw new Error("M3 owner HTTP is unavailable before retained owner seeding");
    return call(path, { ...options, token: state.owner.token });
  };
  const callInternal = (path, options = {}) => {
    const { omitToken = false, token = credentials.workerToken, ...requestOptions } = options;
    return requestJson(workerUrl, path, {
      ...requestOptions,
      token: omitToken ? undefined : token,
      abortSignal: context.abortSignal,
    });
  };
  const roleInternal = (role, path, options = {}) => {
    if (!Object.hasOwn(workerTokens, role)) throw new Error(`unknown M3 worker role: ${role}`);
    const { omitToken = false, ...requestOptions } = options;
    return requestJson(workerUrl, path, {
      ...requestOptions,
      token: omitToken ? undefined : workerTokens[role],
      abortSignal: context.abortSignal,
    });
  };
  const stopApi = async (reason = "M3 API stop") => {
    if (!api) return;
    await context.stopManaged(api, reason);
    api = null;
  };
  const startApi = async ({
    binary = activeBinary,
    environmentOverrides = {},
    removeEnvironment = [],
    expectReady = true,
    label = "M3 context",
  } = {}) => {
    if (api) throw new Error("M3 API is already running");
    activeBinary = binary;
    apiSequence += 1;
    api = context.spawnManaged(
      `hostlet-control ${label} ${apiSequence}`,
      binary,
      [],
      { env: environmentForApi(environmentOverrides, removeEnvironment) },
      `m3-api-${String(apiSequence).padStart(2, "0")}.log`,
    );
    await context.waitForHttp(`${apiUrl}/healthz`, 200, `${label} API`);
    if (expectReady) {
      const ready = await call("/readyz");
      if (ready.status !== 200 || ready.payload?.status !== "ready") {
        throw new Error(`${label} API did not report ready`);
      }
    }
    return api;
  };
  const switchApi = async (binary, reason, options = {}) => {
    await stopApi(reason);
    if (options.stopOnly) return null;
    return startApi({ ...options, binary, label: reason });
  };

  const m3 = Object.freeze({
    context,
    postgres,
    fixtures: Object.freeze({ retainedManifest, upgradeManifest }),
    fixtureCatalog,
    credentials,
    currentApiBinary,
    retainedM2Binary,
    apiUrl,
    workerUrl,
    policyClock,
    call,
    ownerHTTP,
    callInternal,
    roleInternal,
    startApi,
    stopApi,
    switchApi,
    environmentForProbe,
    environmentForApi,
    componentEnvironment,
    environmentForComponent: componentEnvironment,
    extraEnvironment,
    state,
  });
  context.state.configuration.m3 = {
    mode: "owned_fixture",
    postgresImage: image,
    database: "run-owned PostgreSQL 18 container with named persistent volume",
    publicBind: configuration.apiBind,
    workerBind: configuration.workerBind,
    stateDirectory: "private run-owned temporary directory, mode 0700",
    policyClock: "explicit generation-numbered UTC file, mode 0600",
    workerAuthentication: "four generated distinct role tokens, environment-only, never retained",
    retainedM2SourceCommit: retainedManifest.source_commit,
    retainedM2BinarySha256: retainedManifest.binary_sha256,
    fixtureSource: "owned M3 source bytes exposed through synthetic loopback GitHub HTTP",
  };

  let primaryError = null;
  try {
    await postgres.prepare();
    context.state.toolchains.postgres = await postgres.psqlJson(
      "m3-postgres-version",
      `SELECT json_build_object('server_version',current_setting('server_version'),'server_version_num',current_setting('server_version_num'));`,
    );
    await runM3UpgradeScenarios(context, m3, {
      prepareRetainedM2: prepareOwnedProvider,
      seedSelectedSource: seedOwnedSelectedSource,
      runPostUpgrade,
    });
    return m3;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await stopApi("M3 context finalization");
    if (state.githubFixture) await state.githubFixture.close();
    await postgres.cleanup(primaryError ? "M3 context failure" : "M3 context completion");
  }
}
