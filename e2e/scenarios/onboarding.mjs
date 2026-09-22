import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createFoundationCredentials, credentialValues, productEnvironment } from "../support/credentials.mjs";
import { OwnedPostgres } from "../support/docker-postgres.mjs";
import { requestJson } from "../support/http-client.mjs";
import { registerRetainedM1Fixtures, resolveRetainedM1Binary } from "../support/retained-m1.mjs";
import {
  M2_UPGRADE_REQUIRED_ASSERTIONS,
  registerM2UpgradeFixtures,
  runM2UpgradeScenarios,
} from "./m2-upgrade.mjs";

import {
  M2_GITHUB_REQUIRED_ASSERTIONS,
  registerM2GitHubFixtures,
  prepareM2GitHubFixture,
  runM2GitHubScenarios,
} from "./m2-github.mjs";

import {
  M2_ADMISSION_REQUIRED_ASSERTIONS,
  registerM2AdmissionFixtures,
  runM2AdmissionScenarios,
} from "./m2-admission.mjs";

import {
  M2_BROWSER_REQUIRED_ASSERTIONS,
  registerM2BrowserFixtures,
  runM2BrowserScenarios,
} from "./m2-browser.mjs";

import {
  M2_COMPATIBILITY_REQUIRED_ASSERTIONS,
  registerM2CompatibilityFixtures,
  runM2CompatibilityScenarios,
} from "./m2-compatibility.mjs";

import {
  M2_PREVIEW_REQUIRED_ASSERTIONS,
  registerM2PreviewFixtures,
  runM2PreviewScenarios,
} from "./m2-preview.mjs";

const REQUIRED_ASSERTIONS = Object.freeze([
  ...M2_UPGRADE_REQUIRED_ASSERTIONS,
  ...M2_GITHUB_REQUIRED_ASSERTIONS,
  ...M2_BROWSER_REQUIRED_ASSERTIONS,
  ...M2_ADMISSION_REQUIRED_ASSERTIONS,
  ...M2_COMPATIBILITY_REQUIRED_ASSERTIONS,
  ...M2_PREVIEW_REQUIRED_ASSERTIONS,
]);

function environmentWithout(base, names) {
  const result = { ...base };
  for (const name of names) delete result[name];
  return result;
}

async function runOnboarding(context) {
  context.registerFixture("M2 onboarding scenario module", "e2e/scenarios/onboarding.mjs");
  context.registerFixture("M2 scenario inventory", "docs/M2-SCENARIOS.md");
  context.registerFixture("M2 PostgreSQL image pin", "e2e/postgres-image.txt");
  const retainedManifest = registerRetainedM1Fixtures(context);
  const upgradeManifest = registerM2UpgradeFixtures(context);
  registerM2GitHubFixtures(context);
  registerM2BrowserFixtures(context);
  const admissionManifest = registerM2AdmissionFixtures(context);
  registerM2CompatibilityFixtures(context);
  registerM2PreviewFixtures(context);
  for (const support of ["credentials.mjs", "docker-postgres.mjs", "http-client.mjs"]) {
    context.registerFixture(`M2 onboarding harness support: ${support}`, `e2e/support/${support}`);
  }

  const image = readFileSync(join(context.repo, "e2e", "postgres-image.txt"), "utf8").trim();
  const credentials = createFoundationCredentials();
  context.registerSensitiveValues(credentialValues(credentials));
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
  const retainedM1Binary = await resolveRetainedM1Binary(context, retainedManifest);
  const configuration = {
    databaseUrl: postgres.databaseUrl,
    apiBind: `127.0.0.1:${apiPort}`,
    workerBind: `127.0.0.1:${workerPort}`,
    workerLeaseSeconds: 10,
  };
  const baseEnvironment = productEnvironment(process.env, configuration, credentials);
  const extraEnvironment = {};
  const state = {
    owner: null,
    other: null,
    graph: null,
    jobs: null,
    baselineSchema4: null,
    postUpgradeSchema5: null,
    backupReceipt: null,
    restoreReadChecks: [],
  };
  let api = null;
  let apiSequence = 0;
  let activeBinary = retainedM1Binary;

  const environmentForProbe = (overrides = {}, removeEnvironment = []) =>
    environmentWithout({
      ...baseEnvironment,
      HOSTLET_PG_CONTAINER: postgres.containerName,
      ...extraEnvironment,
      ...overrides,
    }, removeEnvironment);
  const call = (path, options = {}) => requestJson(apiUrl, path, {
    ...options,
    abortSignal: context.abortSignal,
  });
  const callInternal = (path, options = {}) => {
    const { omitToken = false, token = credentials.workerToken, ...requestOptions } = options;
    return requestJson(workerUrl, path, {
      ...requestOptions,
      token: omitToken ? undefined : token,
      abortSignal: context.abortSignal,
    });
  };
  const callInternalSensitive = (path, options = {}) => requestJson(workerUrl, path, {
    ...options,
    token: options.token ?? credentials.workerToken,
    abortSignal: context.abortSignal,
  });
  const stopApi = async (reason = "M2 API stop") => {
    if (!api) return;
    await context.stopManaged(api, reason);
    api = null;
  };
  const startApi = async ({
    binary = activeBinary,
    environmentOverrides = {},
    removeEnvironment = [],
    expectReady = true,
    label = "M2 onboarding",
  } = {}) => {
    if (api) throw new Error("M2 API is already running");
    activeBinary = binary;
    apiSequence += 1;
    api = context.spawnManaged(
      `hostlet-control ${label} ${apiSequence}`,
      binary,
      [],
      { env: environmentForProbe(environmentOverrides, removeEnvironment) },
      `m2-api-${String(apiSequence).padStart(2, "0")}.log`,
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

  const m2 = Object.freeze({
    context,
    postgres,
    fixtures: Object.freeze({ retainedManifest, upgradeManifest, admissionManifest }),
    credentials,
    currentApiBinary,
    retainedM1Binary,
    apiUrl,
    workerUrl,
    call,
    callInternal,
    callInternalSensitive,
    startApi,
    stopApi,
    switchApi,
    environmentForProbe,
    extraEnvironment,
    state,
  });
  context.state.configuration.m2 = {
    postgresImage: image,
    database: "run-owned PostgreSQL 18 container with named persistent volume",
    publicBind: configuration.apiBind,
    workerBind: configuration.workerBind,
    retainedM1SourceCommit: retainedManifest.source_commit,
    retainedM1BinarySha256: retainedManifest.binary_sha256,
    credentials: "generated per run, environment-only, never retained",
  };

  let primaryError = null;
  try {
    await postgres.prepare();
    context.state.toolchains.postgres = await postgres.psqlJson(
      "m2-postgres-version",
      `SELECT json_build_object('server_version',current_setting('server_version'),'server_version_num',current_setting('server_version_num'));`,
    );
    await runM2UpgradeScenarios(m2, {
      preparePostUpgrade: async () => {
        await prepareM2GitHubFixture(m2);
      },
      runPostUpgrade: async () => {
        await runM2GitHubScenarios(m2);
        await runM2BrowserScenarios(m2);
        await runM2AdmissionScenarios(m2);
        await runM2CompatibilityScenarios(m2);
        await runM2PreviewScenarios(m2);
      },
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await stopApi("M2 onboarding scenario finalization");
    await postgres.cleanup(primaryError ? "M2 onboarding scenario failure" : "M2 onboarding scenario completion");
  }
}

export const scenario = Object.freeze({
  id: "m2-onboarding",
  description: "Populated M1 upgrade plus GitHub, compatibility, preview, and admission onboarding boundaries",
  requiredAssertions: REQUIRED_ASSERTIONS,
  run: runOnboarding,
});
