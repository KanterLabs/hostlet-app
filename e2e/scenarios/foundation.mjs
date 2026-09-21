import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scrubArtifactCredentials, scanArtifactForCredentials } from "../support/artifact-safety.mjs";
import { createFoundationCredentials, credentialValues, productEnvironment } from "../support/credentials.mjs";
import { OwnedPostgres } from "../support/docker-postgres.mjs";
import {
  GRAPH_REQUIRED_ASSERTIONS,
  registerGraphFixtures,
  runGraphScenarios,
} from "./graph.mjs";
import {
  assertAccountRecord,
  assertErrorShape,
  assertNoCredentialValue,
  assertSessionResponse,
  assertStatus,
  expectScenario,
  requestJson,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

const REQUIRED_ASSERTIONS = Object.freeze([
  "M1-AUTH-01",
  "M1-AUTH-02",
  "M1-AUTH-03",
  "M1-AUTH-04",
  "M1-AUTH-05",
  "M1-AUTH-06",
  ...GRAPH_REQUIRED_ASSERTIONS,
]);

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function step(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M1 accounts, authentication and durable ownership", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M1 accounts, authentication and durable ownership",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "scenario setup or process boundary failed",
    );
    throw error;
  }
}

function ifMatch(revision) {
  return `"${revision}"`;
}

function idempotencyHeaders(key, revision) {
  return { "Idempotency-Key": key, "If-Match": ifMatch(revision) };
}

async function waitForStatus(context, call, expectedStatus, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    try {
      const response = await call();
      lastStatus = response.status;
      if (response.status === expectedStatus) return response;
    } catch {
      lastStatus = null;
    }
    await context.delay(150);
  }
  throw new ScenarioExpectationError(label, { status: lastStatus, timeout: true });
}

function assertReady(response, check) {
  assertStatus(response, 200, check);
  const body = response.payload;
  expectScenario(
    body?.status === "ready" &&
      body?.scope === "control_foundation" &&
      body?.customer_admission === false &&
      body?.workload_execution === false &&
      body?.dependencies?.postgres === "ready" &&
      body?.dependencies?.schema === "ready" &&
      body?.dependencies?.secret_keyring === "ready" &&
      body?.dependencies?.worker_auth === "ready",
    `${check}: dependency readiness shape`,
    { status: response.status, ready_shape_valid: false },
  );
}

function profilePath(accountId) {
  return `/v1/accounts/${accountId}`;
}

async function runFoundation(context) {
  const fixturePath = join(context.repo, "e2e", "support", "foundation-fixtures.json");
  const imagePath = join(context.repo, "e2e", "postgres-image.txt");
  context.registerFixture("M1 identity and ownership inputs", "e2e/support/foundation-fixtures.json");
  context.registerFixture("M1 PostgreSQL image pin", "e2e/postgres-image.txt");
  const graphManifest = registerGraphFixtures(context);
  for (const support of [
    "artifact-safety.mjs",
    "credentials.mjs",
    "docker-postgres.mjs",
    "http-client.mjs",
  ]) {
    context.registerFixture(`M1 foundation harness support: ${support}`, `e2e/support/${support}`);
  }

  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
  const image = readFileSync(imagePath, "utf8").trim();
  expectScenario(fixtures.schema_version === 1, "foundation fixture schema version", {
    fixture_schema_version: fixtures.schema_version,
  });
  expectScenario(
    image ===
      "postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650",
    "PostgreSQL 18 image digest pin",
    { image_pin_matches: false },
  );

  const credentials = createFoundationCredentials();
  context.registerSensitiveValues(Object.values(credentials));
  const postgresPort = await context.allocatePort();
  const apiPort = await context.allocatePort();
  const workerPort = await context.allocatePort();
  const postgres = new OwnedPostgres(context, {
    image,
    password: credentials.postgresPassword,
    hostPort: postgresPort,
  });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const apiBinary = join(context.repo, "target", "debug", "hostlet-control");
  const configuration = {
    databaseUrl: postgres.databaseUrl,
    apiBind: `127.0.0.1:${apiPort}`,
    workerBind: `127.0.0.1:${workerPort}`,
  };
  const apiEnvironment = productEnvironment(process.env, configuration, credentials);
  context.state.configuration.foundation = {
    postgresImage: image,
    database: "run-owned PostgreSQL 18 container with named persistent volume",
    publicBind: configuration.apiBind,
    workerBind: configuration.workerBind,
    credentials: "generated per run, environment-only, never retained",
  };

  let api = null;
  let apiSequence = 0;
  let owner = null;
  let other = null;
  let currentOwnerProfile = null;
  let ownerToken = null;
  let otherToken = null;
  const issuedSessionTokens = [];
  const responsePayloads = [];

  const call = async (path, options = {}) => {
    const response = await requestJson(apiUrl, path, {
      ...options,
      abortSignal: context.abortSignal,
    });
    responsePayloads.push({ path, status: response.status, payload: response.payload });
    return response;
  };

  const startApi = async () => {
    apiSequence += 1;
    const processHandle = context.spawnManaged(
      `hostlet-control foundation ${apiSequence}`,
      apiBinary,
      [],
      { env: apiEnvironment },
      `foundation-api-${apiSequence}.log`,
    );
    await context.waitForHttp(`${apiUrl}/healthz`, 200, "stateful foundation API");
    const ready = await call("/readyz");
    assertReady(ready, "stateful foundation startup readiness");
    return processHandle;
  };

  let primaryError = null;
  try {
    await postgres.prepare();
    const postgresVersion = await postgres.psqlJson(
      "postgres-version",
      `SELECT json_build_object(
         'server_version', current_setting('server_version'),
         'server_version_num', current_setting('server_version_num')
       );`,
    );
    context.state.toolchains.postgres = postgresVersion;

    const migration = await context.runCommand(
      "Hostlet foundation migration",
      apiBinary,
      ["migrate"],
      {
        env: apiEnvironment,
        timeoutMs: 30_000,
        logName: "foundation-migrate.log",
      },
    );
    expectScenario(migration.code === 0, "explicit hostlet-control migrate command", {
      exit_status: migration.code,
    });
    api = await startApi();

    await step(
      context,
      "M1-AUTH-01",
      "two accounts and valid sessions succeed; duplicate, wrong, absent, malformed, unknown, expired, and revoked credentials are rejected",
      async () => {
        const ownerPayload = {
          ...fixtures.accounts[0],
          password: credentials.ownerPassword,
        };
        const duplicateCreates = await Promise.all([
          call("/v1/accounts", { method: "POST", body: ownerPayload }),
          call("/v1/accounts", { method: "POST", body: ownerPayload }),
        ]);
        const createStatuses = duplicateCreates.map(({ status }) => status).sort((a, b) => a - b);
        expectScenario(
          JSON.stringify(createStatuses) === JSON.stringify([201, 409]),
          "concurrent duplicate account creation uses email uniqueness",
          { statuses: createStatuses },
        );
        const ownerCreate = duplicateCreates.find(({ status }) => status === 201);
        const ownerDuplicate = duplicateCreates.find(({ status }) => status === 409);
        assertAccountRecord(ownerCreate?.payload, "owner create returns top-level AccountRecord");
        assertErrorShape(ownerDuplicate, 409, "duplicate normalized email conflict");
        owner = ownerCreate.payload;
        currentOwnerProfile = owner;

        const otherCreate = await call("/v1/accounts", {
          method: "POST",
          body: { ...fixtures.accounts[1], password: credentials.otherPassword },
        });
        assertStatus(otherCreate, 201, "second account creation");
        assertAccountRecord(otherCreate.payload, "second create returns top-level AccountRecord");
        other = otherCreate.payload;

        const wrongPassword = await call("/v1/sessions", {
          method: "POST",
          body: { email: fixtures.accounts[0].email, password: `${credentials.ownerPassword}x` },
        });
        assertErrorShape(wrongPassword, 401, "wrong credentials");

        const ownerSession = await call("/v1/sessions", {
          method: "POST",
          body: { email: fixtures.accounts[0].email, password: credentials.ownerPassword },
        });
        assertStatus(ownerSession, 201, "owner session creation");
        assertSessionResponse(ownerSession.payload, owner.id, "owner session response");
        ownerToken = ownerSession.payload.token;
        issuedSessionTokens.push(ownerToken);
        context.registerSensitiveValues([ownerToken]);

        const otherSession = await call("/v1/sessions", {
          method: "POST",
          body: { email: fixtures.accounts[1].email, password: credentials.otherPassword },
        });
        assertStatus(otherSession, 201, "other session creation");
        assertSessionResponse(otherSession.payload, other.id, "other session response");
        otherToken = otherSession.payload.token;
        issuedSessionTokens.push(otherToken);
        context.registerSensitiveValues([otherToken]);

        const missing = await call("/v1/me");
        assertErrorShape(missing, 401, "missing bearer token");
        const malformed = await call("/v1/me", { headers: { Authorization: "Basic invalid" } });
        assertErrorShape(malformed, 401, "malformed bearer token");
        const unknown = await call("/v1/me", { token: credentials.unknownSessionToken });
        assertErrorShape(unknown, 401, "unknown bearer token");

        const ownerMe = await call("/v1/me", { token: ownerToken });
        assertStatus(ownerMe, 200, "owner bearer token");
        expectScenario(ownerMe.payload?.account?.id === owner.id, "GET /v1/me owner identity", {
          status: ownerMe.status,
          account_match: false,
        });

        const expiringSession = await call("/v1/sessions", {
          method: "POST",
          body: { email: fixtures.accounts[0].email, password: credentials.ownerPassword },
        });
        assertStatus(expiringSession, 201, "session fixture for expiry");
        assertSessionResponse(expiringSession.payload, owner.id, "expiring session response");
        const expiringToken = expiringSession.payload.token;
        issuedSessionTokens.push(expiringToken);
        context.registerSensitiveValues([expiringToken]);
        const expired = await postgres.psqlJson(
          "expire-session",
          `WITH updated AS (
             UPDATE sessions
                SET expires_at = created_at + INTERVAL '1 microsecond'
              WHERE id = (
                SELECT id FROM sessions
                 WHERE account_id = '${owner.id}' AND revoked_at IS NULL
                 ORDER BY created_at DESC LIMIT 1
              )
              RETURNING 1
           ) SELECT json_build_object('updated', COUNT(*)::int) FROM updated;`,
        );
        expectScenario(expired.updated === 1, "explicit SQL expired-session fixture", {
          updated_rows: expired.updated,
        });
        const expiredUse = await call("/v1/me", { token: expiringToken });
        assertErrorShape(expiredUse, 401, "expired bearer token");

        const revokingSession = await call("/v1/sessions", {
          method: "POST",
          body: { email: fixtures.accounts[0].email, password: credentials.ownerPassword },
        });
        assertStatus(revokingSession, 201, "session fixture for revocation");
        assertSessionResponse(revokingSession.payload, owner.id, "revoking session response");
        const revokingToken = revokingSession.payload.token;
        issuedSessionTokens.push(revokingToken);
        context.registerSensitiveValues([revokingToken]);
        const revoke = await call("/v1/sessions/current", {
          method: "DELETE",
          token: revokingToken,
        });
        assertStatus(revoke, 204, "current session revocation");
        const revokedUse = await call("/v1/me", { token: revokingToken });
        assertErrorShape(revokedUse, 401, "revoked bearer token");

        return {
          accounts_created: 2,
          duplicate_create_statuses: createStatuses,
          valid_sessions: 4,
          rejected_credential_states: 5,
        };
      },
    );

    await step(
      context,
      "M1-AUTH-02",
      "owner-scoped profile reads and revisioned writes succeed; cross-owner access is hidden; replay and concurrency semantics preserve one committed intent",
      async () => {
        const ownerRead = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(ownerRead, 200, "owner account read");
        assertAccountRecord(ownerRead.payload, "owner account read shape");

        const hiddenRead = await call(profilePath(owner.id), { token: otherToken });
        assertErrorShape(hiddenRead, 404, "non-owner account read");
        const hiddenWrite = await call(profilePath(owner.id), {
          method: "PATCH",
          token: otherToken,
          headers: idempotencyHeaders("m1-owner-crosswrite", ownerRead.payload.revision),
          body: { display_name: "Cross-owner mutation must not commit" },
        });
        assertErrorShape(hiddenWrite, 404, "non-owner account write");

        const replayKey = "m1-profile-replay";
        const replayBody = { display_name: fixtures.profile_updates.replayed };
        const replayed = await Promise.all([
          call(profilePath(owner.id), {
            method: "PATCH",
            token: ownerToken,
            headers: idempotencyHeaders(replayKey, ownerRead.payload.revision),
            body: replayBody,
          }),
          call(profilePath(owner.id), {
            method: "PATCH",
            token: ownerToken,
            headers: idempotencyHeaders(replayKey, ownerRead.payload.revision),
            body: replayBody,
          }),
        ]);
        expectScenario(
          replayed.every(({ status }) => status === 200),
          "same-key concurrent profile replay statuses",
          { statuses: replayed.map(({ status }) => status) },
        );
        replayed.forEach(({ payload }) => assertAccountRecord(payload, "replayed profile response"));
        expectScenario(
          replayed[0].payload.id === replayed[1].payload.id &&
            replayed[0].payload.revision === replayed[1].payload.revision &&
            replayed[0].payload.display_name === replayed[1].payload.display_name,
          "same-key concurrent profile replay stable result",
          { stable_results: false },
        );
        currentOwnerProfile = replayed[0].payload;

        const changedReplay = await call(profilePath(owner.id), {
          method: "PATCH",
          token: ownerToken,
          headers: idempotencyHeaders(replayKey, ownerRead.payload.revision),
          body: { display_name: fixtures.profile_updates.conflicting },
        });
        assertErrorShape(changedReplay, 409, "same key changed payload conflict");

        const concurrentRevision = currentOwnerProfile.revision;
        const contenders = await Promise.all([
          call(profilePath(owner.id), {
            method: "PATCH",
            token: ownerToken,
            headers: idempotencyHeaders("m1-profile-contender-a", concurrentRevision),
            body: { display_name: fixtures.profile_updates.contender_a },
          }),
          call(profilePath(owner.id), {
            method: "PATCH",
            token: ownerToken,
            headers: idempotencyHeaders("m1-profile-contender-b", concurrentRevision),
            body: { display_name: fixtures.profile_updates.contender_b },
          }),
        ]);
        const contenderStatuses = contenders.map(({ status }) => status).sort((a, b) => a - b);
        expectScenario(
          JSON.stringify(contenderStatuses) === JSON.stringify([200, 412]),
          "different-key same-revision contention",
          { statuses: contenderStatuses },
        );
        const winner = contenders.find(({ status }) => status === 200);
        const stale = contenders.find(({ status }) => status === 412);
        assertAccountRecord(winner?.payload, "profile contention winner");
        assertErrorShape(stale, 412, "profile contention stale loser");
        currentOwnerProfile = winner.payload;

        const committed = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(committed, 200, "committed profile read");
        expectScenario(
          committed.payload.revision === currentOwnerProfile.revision &&
            committed.payload.display_name === currentOwnerProfile.display_name,
          "one profile contender committed without lost update",
          { committed_results: 0 },
        );

        return {
          owner_reads: 2,
          cross_owner_statuses: [hiddenRead.status, hiddenWrite.status],
          replay_statuses: replayed.map(({ status }) => status),
          changed_replay_status: changedReplay.status,
          contender_statuses: contenderStatuses,
          committed_profile_rows: 1,
        };
      },
    );

    await step(
      context,
      "M1-AUTH-03",
      "API and PostgreSQL restart against the same named-volume data while accounts, sessions, profile intent, database identity, and audit rows persist",
      async () => {
        const beforeRestart = await postgres.psqlJson(
          "identity-before-restart",
          `SELECT json_build_object(
             'database_identity', (SELECT id::text FROM database_identity LIMIT 1),
             'accounts', (SELECT COUNT(*)::int FROM accounts),
             'audit_events', (SELECT COUNT(*)::int FROM audit_events)
           );`,
        );
        expectScenario(beforeRestart.accounts === 2, "pre-restart account count", {
          account_rows: beforeRestart.accounts,
        });

        await context.stopManaged(api, "foundation API restart persistence scenario");
        api = await startApi();
        const afterApiRestart = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(afterApiRestart, 200, "profile survives API restart");
        expectScenario(
          afterApiRestart.payload.revision === currentOwnerProfile.revision &&
            afterApiRestart.payload.display_name === currentOwnerProfile.display_name,
          "profile intent survives API restart",
          { persisted_profile_rows: 0 },
        );

        await postgres.stop();
        await postgres.start();
        const readiness = await waitForStatus(
          context,
          () => call("/readyz"),
          200,
          "readiness after PostgreSQL restart",
        );
        assertReady(readiness, "readiness after PostgreSQL restart");
        const afterPostgresRestart = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(afterPostgresRestart, 200, "profile survives PostgreSQL restart");
        assertAccountRecord(afterPostgresRestart.payload, "profile shape after PostgreSQL restart");
        expectScenario(
          afterPostgresRestart.payload.id === currentOwnerProfile.id &&
            afterPostgresRestart.payload.email === currentOwnerProfile.email &&
            afterPostgresRestart.payload.revision === currentOwnerProfile.revision &&
            afterPostgresRestart.payload.display_name === currentOwnerProfile.display_name,
          "exact profile intent survives PostgreSQL restart",
          { persisted_profile_rows: 0 },
        );
        const afterRestart = await postgres.psqlJson(
          "identity-after-restart",
          `SELECT json_build_object(
             'database_identity', (SELECT id::text FROM database_identity LIMIT 1),
             'accounts', (SELECT COUNT(*)::int FROM accounts),
             'audit_events', (SELECT COUNT(*)::int FROM audit_events)
           );`,
        );
        expectScenario(
          afterRestart.database_identity === beforeRestart.database_identity &&
            afterRestart.accounts === beforeRestart.accounts &&
            afterRestart.audit_events >= beforeRestart.audit_events,
          "named-volume PostgreSQL restart preserved durable relationships",
          {
            identity_stable: afterRestart.database_identity === beforeRestart.database_identity,
            account_rows: afterRestart.accounts,
            audit_rows_non_decreasing: afterRestart.audit_events >= beforeRestart.audit_events,
          },
        );

        return {
          api_restart_status: afterApiRestart.status,
          postgres_restart_status: afterPostgresRestart.status,
          persisted_accounts: afterRestart.accounts,
          database_identity_stable: true,
          audit_rows_non_decreasing: true,
        };
      },
    );

    await step(
      context,
      "M1-AUTH-04",
      "malformed, oversized, injection-shaped, and unknown-field input receives stable safe errors with no partial account row",
      async () => {
        const profileBeforeInvalidRequests = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(profileBeforeInvalidRequests, 200, "profile before invalid mutation preconditions");
        const invalidRevision = profileBeforeInvalidRequests.payload.revision;
        const missingIdempotency = await call(profilePath(owner.id), {
          method: "PATCH",
          token: ownerToken,
          headers: { "If-Match": ifMatch(invalidRevision) },
          body: { display_name: "Missing idempotency key must not commit" },
        });
        assertErrorShape(missingIdempotency, 400, "missing Idempotency-Key");
        const missingIfMatch = await call(profilePath(owner.id), {
          method: "PATCH",
          token: ownerToken,
          headers: { "Idempotency-Key": "m1-profile-missing-if-match" },
          body: { display_name: "Missing revision precondition must not commit" },
        });
        assertErrorShape(missingIfMatch, 428, "missing If-Match");
        const malformedIfMatch = await call(profilePath(owner.id), {
          method: "PATCH",
          token: ownerToken,
          headers: {
            "Idempotency-Key": "m1-profile-malformed-if-match",
            "If-Match": '"not-a-revision"',
          },
          body: { display_name: "Malformed revision must not commit" },
        });
        assertErrorShape(malformedIfMatch, 400, "malformed quoted revision");
        const staleIfMatch = await call(profilePath(owner.id), {
          method: "PATCH",
          token: ownerToken,
          headers: idempotencyHeaders("m1-profile-stale-if-match", invalidRevision - 1),
          body: { display_name: "Stale revision must not commit" },
        });
        assertErrorShape(staleIfMatch, 412, "stale valid revision");

        const malformed = await call("/v1/accounts", {
          method: "POST",
          rawBody: '{"email":',
        });
        assertErrorShape(malformed, 400, "malformed account JSON");
        const unknown = await call("/v1/accounts", {
          method: "POST",
          body: {
            email: "unknown-field@foundation.hostlet.test",
            password: credentials.ownerPassword,
            display_name: "Unknown field fixture",
            unexpected: true,
          },
        });
        assertErrorShape(unknown, 400, "unknown account field");
        const oversized = await call("/v1/accounts", {
          method: "POST",
          body: {
            email: "oversized@foundation.hostlet.test",
            password: credentials.ownerPassword,
            display_name: "x".repeat(128 * 1024),
          },
        });
        assertErrorShape(oversized, 413, "account body over 128 KiB");
        const injectionShaped = await call("/v1/accounts", {
          method: "POST",
          body: {
            email: "' OR 1=1 --",
            password: credentials.ownerPassword,
            display_name: "Injection-shaped invalid email",
          },
        });
        assertErrorShape(injectionShaped, 400, "injection-shaped invalid email");

        const counts = await postgres.psqlJson(
          "invalid-input-counts",
          `SELECT json_build_object(
             'accounts', (SELECT COUNT(*)::int FROM accounts),
             'password_identities', (SELECT COUNT(*)::int FROM password_identities)
           );`,
        );
        expectScenario(
          counts.accounts === 2 && counts.password_identities === 2,
          "invalid account requests persist no partial identity rows",
          { account_rows: counts.accounts, password_identity_rows: counts.password_identities },
        );
        const profileAfterInvalidRequests = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(profileAfterInvalidRequests, 200, "profile after invalid mutation preconditions");
        expectScenario(
          profileAfterInvalidRequests.payload.revision === invalidRevision &&
            profileAfterInvalidRequests.payload.display_name === profileBeforeInvalidRequests.payload.display_name,
          "invalid mutation preconditions persist no partial profile update",
          { unchanged_profile_rows: 0 },
        );

        return {
          input_statuses: [malformed.status, unknown.status, oversized.status, injectionShaped.status],
          precondition_statuses: [
            missingIdempotency.status,
            missingIfMatch.status,
            malformedIfMatch.status,
            staleIfMatch.status,
          ],
          account_rows: counts.accounts,
          password_identity_rows: counts.password_identities,
          unchanged_profile_rows: 1,
        };
      },
    );

    await step(
      context,
      "M1-AUTH-05",
      "database loss or required-table drift changes readiness to 503 and profile writes cannot report success or commit; recovery preserves state and permits a later write",
      async () => {
        const before = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(before, 200, "profile before database outage");
        const beforeRevision = before.payload.revision;

        await postgres.stop();
        const unavailable = await waitForStatus(
          context,
          () => call("/readyz", { timeoutMs: 5_000 }),
          503,
          "readiness when PostgreSQL is offline",
        );
        expectScenario(
          unavailable.payload?.status === "not_ready" &&
            typeof unavailable.payload?.reason === "string" &&
            unavailable.payload.reason.length > 0,
          "safe not-ready response when PostgreSQL is offline",
          { status: unavailable.status, not_ready_shape_valid: false },
        );
        const refusedWrite = await call(profilePath(owner.id), {
          method: "PATCH",
          token: ownerToken,
          headers: idempotencyHeaders("m1-profile-database-offline", beforeRevision),
          body: { display_name: "Must not commit while PostgreSQL is offline" },
          timeoutMs: 10_000,
        });
        assertErrorShape(refusedWrite, 503, "profile write while PostgreSQL is offline");

        await postgres.start();
        const recoveredReady = await waitForStatus(
          context,
          () => call("/readyz"),
          200,
          "readiness after PostgreSQL recovery",
        );
        assertReady(recoveredReady, "readiness after PostgreSQL recovery");
        const unchanged = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(unchanged, 200, "profile read after database recovery");
        expectScenario(
          unchanged.payload.revision === beforeRevision &&
            unchanged.payload.display_name === before.payload.display_name,
          "offline write did not commit from memory",
          { unchanged_profile_rows: 0 },
        );

        let accountsRenamed = false;
        try {
          await postgres.psqlCommand(
            "schema-drift-rename-accounts",
            "ALTER TABLE accounts RENAME TO accounts_e2e_temporarily_unavailable;",
          );
          accountsRenamed = true;
          const driftedReady = await waitForStatus(
            context,
            () => call("/readyz"),
            503,
            "readiness with required accounts table renamed",
          );
          expectScenario(
            driftedReady.payload?.status === "not_ready",
            "required-table drift returns safe not-ready response",
            { status: driftedReady.status, not_ready_shape_valid: false },
          );
          const driftedWrite = await call(profilePath(owner.id), {
            method: "PATCH",
            token: ownerToken,
            headers: idempotencyHeaders("m1-profile-schema-drift", beforeRevision),
            body: { display_name: "Must not commit while a required table is unavailable" },
          });
          assertErrorShape(driftedWrite, 503, "profile write during required-table schema drift");
        } finally {
          if (accountsRenamed) {
            await postgres.psqlCommand(
              "schema-drift-restore-accounts",
              "ALTER TABLE accounts_e2e_temporarily_unavailable RENAME TO accounts;",
            );
          }
        }
        const schemaRecoveredReady = await waitForStatus(
          context,
          () => call("/readyz"),
          200,
          "readiness after required-table restoration",
        );
        assertReady(schemaRecoveredReady, "readiness after required-table restoration");
        const schemaUnchanged = await call(profilePath(owner.id), { token: ownerToken });
        assertStatus(schemaUnchanged, 200, "profile after required-table restoration");
        expectScenario(
          schemaUnchanged.payload.revision === beforeRevision &&
            schemaUnchanged.payload.display_name === before.payload.display_name,
          "schema-drift write did not partially commit",
          { unchanged_profile_rows: 0 },
        );

        const recoveredWrite = await call(profilePath(owner.id), {
          method: "PATCH",
          token: ownerToken,
          headers: idempotencyHeaders("m1-profile-after-recovery", beforeRevision),
          body: { display_name: fixtures.profile_updates.after_database_recovery },
        });
        assertStatus(recoveredWrite, 200, "profile write after database recovery");
        assertAccountRecord(recoveredWrite.payload, "recovered profile write response");
        expectScenario(
          recoveredWrite.payload.revision > beforeRevision,
          "recovered write commits a new revision",
          { committed_rows: 0 },
        );
        currentOwnerProfile = recoveredWrite.payload;

        return {
          offline_readiness_status: unavailable.status,
          offline_write_status: refusedWrite.status,
          schema_drift_readiness_status: 503,
          schema_drift_write_status: 503,
          unchanged_profile_rows: 1,
          recovered_readiness_status: recoveredReady.status,
          schema_recovered_readiness_status: schemaRecoveredReady.status,
          recovered_write_status: recoveredWrite.status,
        };
      },
    );

    await runGraphScenarios({
      context,
      manifest: graphManifest,
      postgres,
      call,
      restartApi: async (reason) => {
        await context.stopManaged(api, reason);
        api = await startApi();
      },
      owner: { record: owner, token: ownerToken },
      other: { record: other, token: otherToken },
    });

    await step(
      context,
      "M1-AUTH-06",
      "audit events remain queryable; PostgreSQL stores Argon2id password hashes and SHA-256 token hashes only; auth requests create no idempotency cache; responses and artifacts retain no credentials",
      async () => {
        const audit = await call("/v1/audit", { token: ownerToken });
        assertStatus(audit, 200, "owner audit query");
        expectScenario(
          Array.isArray(audit.payload?.events) && audit.payload.events.length > 0,
          "owner audit events queryable",
          { status: audit.status, audit_event_count: audit.payload?.events?.length ?? 0 },
        );

        const sql = await postgres.psqlJson(
          "credential-storage",
          `SELECT json_build_object(
             'accounts', (SELECT COUNT(*)::int FROM accounts),
             'password_identities', (SELECT COUNT(*)::int FROM password_identities),
             'argon2id_hashes', (
               SELECT COUNT(*)::int FROM password_identities
                WHERE password_hash LIKE '$argon2id$%'
             ),
             'sessions', (SELECT COUNT(*)::int FROM sessions),
             'sha256_token_hashes', (
               SELECT COUNT(*)::int FROM sessions WHERE octet_length(token_hash) = 32
             ),
             'audit_events', (SELECT COUNT(*)::int FROM audit_events),
             'unexpected_idempotency_operations', (
               SELECT COUNT(*)::int FROM idempotency_records
                WHERE NOT (
                  operation LIKE 'account.profile.update/%' OR
                  operation = 'project.create' OR
                  operation LIKE 'project.update/%' OR
                  operation LIKE 'project.configuration.create/%' OR
                  operation LIKE 'project.deployment_intent.create/%' OR
                  operation LIKE 'project.rollback_intent.create/%' OR
                  operation LIKE 'project.removal_intent.create/%' OR
                  operation = 'portfolio.draft_revision.create'
                )
             ),
             'credential_fields_in_replay_rows', (
               SELECT COUNT(*)::int FROM idempotency_records
                WHERE row_to_json(idempotency_records)::text ~* '"(password|token|secret)"[[:space:]]*:'
             )
           );`,
        );
        expectScenario(
          sql.accounts === 2 &&
            sql.password_identities === 2 &&
            sql.argon2id_hashes === sql.password_identities &&
            sql.sessions >= 4 &&
            sql.sha256_token_hashes === sql.sessions &&
            sql.audit_events > 0 &&
            sql.unexpected_idempotency_operations === 0 &&
            sql.credential_fields_in_replay_rows === 0,
          "independent credential, replay, and audit SQL checks",
          {
            account_rows: sql.accounts,
            password_identity_rows: sql.password_identities,
            argon2id_hash_rows: sql.argon2id_hashes,
            session_rows: sql.sessions,
            sha256_token_hash_rows: sql.sha256_token_hashes,
            audit_event_rows: sql.audit_events,
            unexpected_idempotency_rows: sql.unexpected_idempotency_operations,
            credential_bearing_replay_rows: sql.credential_fields_in_replay_rows,
          },
        );

        const allCredentials = credentialValues(credentials, issuedSessionTokens);
        const nonSessionCredentials = credentialValues(credentials);
        for (const response of responsePayloads) {
          assertNoCredentialValue(
            response.payload,
            nonSessionCredentials,
            "HTTP response does not echo configured or password credentials",
          );
        }
        for (const token of issuedSessionTokens) {
          const occurrences = responsePayloads.filter((response) =>
            JSON.stringify(response.payload).includes(token),
          );
          expectScenario(
            occurrences.length === 1 &&
              occurrences[0].path === "/v1/sessions" &&
              occurrences[0].status === 201 &&
              occurrences[0].payload?.token === token,
            "session token appears only in its one-time creation response",
            { response_occurrences: occurrences.length },
          );
        }

        await context.stopManaged(api, "foundation credential-artifact scan");
        api = null;
        const scrubbed = scrubArtifactCredentials(context.artifactDir, allCredentials);
        const scan = scanArtifactForCredentials(context.artifactDir, allCredentials);
        expectScenario(
          scrubbed.credentialMatches === 0 && scan.credentialMatches === 0,
          "credential-free retained artifact payloads",
          {
            files_scanned: scan.filesScanned,
            credential_matches: scrubbed.credentialMatches + scan.credentialMatches,
            files_rewritten: scrubbed.filesRewritten,
          },
        );

        return {
          audit_http_status: audit.status,
          audit_event_rows: sql.audit_events,
          argon2id_hash_rows: sql.argon2id_hashes,
          sha256_token_hash_rows: sql.sha256_token_hashes,
          unexpected_idempotency_rows: sql.unexpected_idempotency_operations,
          credential_matches_in_artifacts: 0,
          files_scanned: scan.filesScanned,
        };
      },
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (api) await context.stopManaged(api, "foundation scenario finalization");

    const allCredentials = credentialValues(credentials, issuedSessionTokens);
    const scrubbed = scrubArtifactCredentials(context.artifactDir, allCredentials);
    const scan = scanArtifactForCredentials(context.artifactDir, allCredentials);
    context.state.cleanup.push({
      resource: "foundation artifact credential scrub",
      action: "scan all current run payloads for in-memory credential values and redact any match",
      result:
        scrubbed.credentialMatches === 0 && scan.credentialMatches === 0
          ? "0 credential matches"
          : `${scrubbed.credentialMatches} matches redacted; scenario failed`,
    });
    await postgres.cleanup(primaryError ? "foundation scenario failure" : "foundation scenario completion");
    if (!primaryError && (scrubbed.credentialMatches !== 0 || scan.credentialMatches !== 0)) {
      throw new Error("foundation artifact credential scan found and redacted a credential value");
    }
  }
}

export const scenario = Object.freeze({
  id: "m1-foundation-identity",
  description: "Real PostgreSQL 18, migration, API, authentication, ownership, restart, and outage scenarios",
  requiredAssertions: REQUIRED_ASSERTIONS,
  run: runFoundation,
});
