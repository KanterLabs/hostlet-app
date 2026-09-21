import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertErrorShape,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

export const JOB_REQUIRED_ASSERTIONS = Object.freeze([
  "M1-JOB-01",
  "M1-JOB-02",
  "M1-JOB-03",
  "M1-JOB-04",
  "M1-JOB-05",
  "M1-JOB-06",
]);

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function jobStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M1 durable jobs and scoped credentials", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M1 durable jobs and scoped credentials",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "job process or persistence boundary failed",
    );
    throw error;
  }
}

function headers(key, revision) {
  const value = { "Idempotency-Key": key };
  if (revision !== undefined) value["If-Match"] = `"${revision}"`;
  return value;
}

function assertJob(job, projectId, serviceId, check) {
  expectScenario(
    typeof job?.id === "string" &&
      job.project_id === projectId &&
      job.service_id === serviceId &&
      job.kind === "foundation_bookkeeping" &&
      job.operation === "build" &&
      /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(job.source_commit) &&
      ["queued", "running", "succeeded", "failed", "canceled", "retriable"].includes(job.state) &&
      Number.isInteger(job.revision) &&
      Number.isInteger(job.attempt_count) &&
      Number.isInteger(job.current_fence) &&
      Array.isArray(job.secret_version_refs),
    check,
    { job_shape_valid: false },
  );
}

function assertCode(response, status, code, check) {
  assertErrorShape(response, status, check);
  expectScenario(response.payload.error.code === code, `${check}: stable code`, {
    status: response.status,
    error_code: response.payload.error.code,
  });
}

function workerEnvironment(token) {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.HOSTLET_WORKER_TOKEN = token;
  return environment;
}

export function registerJobFixtures(context) {
  context.registerFixture("M1 job scenario module", "e2e/scenarios/jobs.mjs");
  context.registerFixture("M1 job and secret scenario inventory", "e2e/support/jobs-fixtures.json");
  return JSON.parse(readFileSync(join(context.repo, "e2e/support/jobs-fixtures.json"), "utf8"));
}

export async function runJobScenarios({
  context,
  manifest,
  postgres,
  call,
  callInternal,
  callInternalSensitive,
  restartApi,
  environmentForProbe,
  workerUrl,
  workerToken,
  graph,
  owner,
  other,
}) {
  expectScenario(manifest.schema_version === 1, "job fixture schema version", {
    fixture_schema_version: manifest.schema_version,
  });
  const project = graph.mainGraph.project;
  const services = graph.mainGraph.services;
  const service = services.find(({ configuration }) => configuration.kind === "application");
  const otherService = services.find(({ configuration }) => configuration.kind === "static_frontend");
  expectScenario(service && otherService, "job fixtures require standard application and static services", {
    application_services: service ? 1 : 0,
    static_services: otherService ? 1 : 0,
  });
  const builder = join(context.repo, "target", "debug", "hostlet-builder");
  const state = { secrets: {}, versions: {}, values: {}, jobs: {} };
  const secretValues = [];

  const secretPath = (projectId, serviceId) => `/v1/projects/${projectId}/services/${serviceId}/secrets`;
  const jobPath = `/v1/projects/${project.id}/jobs`;
  const makeValue = () => {
    const value = `m1-e2e-secret-${randomBytes(36).toString("base64url")}`;
    secretValues.push(value);
    context.registerSensitiveValues([value]);
    return value;
  };
  const createSecret = async (
    key,
    fixture,
    serviceId = service.id,
    token = owner.token,
    projectId = project.id,
  ) => {
    const response = await call(secretPath(projectId, serviceId), {
      method: "POST",
      token,
      headers: headers(key),
      body: fixture,
    });
    assertStatus(response, 201, `secret metadata ${fixture.name}`);
    expectScenario(
      response.payload?.project_id === projectId &&
        response.payload.service_id === serviceId &&
        response.payload.operation === fixture.operation &&
        response.payload.credential_kind === fixture.credential_kind &&
        response.payload.status === "active" &&
        response.payload.revision === 1 &&
        response.payload.value === undefined &&
        response.payload.ciphertext === undefined,
      `metadata-only secret response ${fixture.name}`,
      { secret_metadata_valid: false },
    );
    return response.payload;
  };
  const createVersion = async (key, metadata, value, token = owner.token) => {
    const path = `${secretPath(metadata.project_id, metadata.service_id)}/${metadata.id}/versions`;
    const response = await call(path, {
      method: "POST",
      token,
      headers: headers(key, metadata.revision),
      body: { value },
    });
    assertStatus(response, 201, `secret version ${metadata.name}`);
    expectScenario(
      response.payload?.secret_id === metadata.id &&
        response.payload.version === 1 &&
        response.payload.value === undefined &&
        response.payload.nonce === undefined &&
        response.payload.auth_tag === undefined &&
        response.payload.ciphertext === undefined,
      `metadata-only secret version response ${metadata.name}`,
      { secret_version_metadata_valid: false },
    );
    return response.payload;
  };
  const enqueue = async (key, refs = [], sourceCommit = manifest.source_commits.primary) => {
    const response = await call(jobPath, {
      method: "POST",
      token: owner.token,
      headers: headers(key),
      body: {
        kind: "foundation_bookkeeping",
        operation: "build",
        service_id: service.id,
        source_commit: sourceCommit,
        secret_version_refs: refs.map((secret_version_id) => ({
          service_id: service.id,
          secret_version_id,
        })),
      },
    });
    assertStatus(response, 201, `enqueue ${key}`);
    assertJob(response.payload, project.id, service.id, `enqueue ${key} JobRecord`);
    return response.payload;
  };
  const lease = (workerId) =>
    callInternal("/internal/v1/jobs/lease", {
      method: "POST",
      body: { worker_id: workerId, kinds: ["foundation_bookkeeping"] },
    });
  const complete = (jobId, workerId, attempt, outcome) =>
    callInternal(`/internal/v1/jobs/${jobId}/complete`, {
      method: "POST",
      body: {
        worker_id: workerId,
        attempt_id: attempt.id,
        fence: attempt.fence,
        outcome,
      },
    });
  const waitForState = async (jobId, expected, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const response = await call(`${jobPath}/${jobId}`, { token: owner.token });
      if (response.status === 200) {
        last = response.payload;
        if (expected.includes(last.state)) return last;
      }
      await context.delay(100);
    }
    throw new ScenarioExpectationError("job state polling", { expected, state: last?.state ?? null });
  };
  const spawnBuilder = (workerId, suffix, extra = []) =>
    context.spawnManaged(
      `hostlet-builder ${workerId}`,
      builder,
      ["worker", "--control-url", workerUrl, "--worker-id", workerId, ...extra],
      { env: workerEnvironment(workerToken) },
      `foundation-builder-${suffix}.log`,
    );

  await jobStep(
    context,
    "M1-JOB-04",
    "secret versions are encrypted with scope-bound authenticated context; metadata excludes values; missing or wrong keys and ciphertext/context tamper fail closed and recover without leakage",
    async () => {
      const contextBoundSharedValue = makeValue();
      for (const [name, fixture] of Object.entries(manifest.secrets)) {
        const targetService = name === "other_service" ? otherService.id : service.id;
        state.secrets[name] = await createSecret(`m1-secret-${name}`, fixture, targetService);
        const value = ["allowed", "same_scope_undeclared"].includes(name)
          ? contextBoundSharedValue
          : makeValue();
        state.values[name] = value;
        if (name === "allowed") {
          const path = `${secretPath(project.id, service.id)}/${state.secrets[name].id}/versions`;
          const request = {
            method: "POST",
            token: owner.token,
            headers: headers("m1-secret-version-allowed", state.secrets[name].revision),
            body: { value },
          };
          const replayed = await Promise.all([call(path, request), call(path, request)]);
          expectScenario(
            replayed.every(({ status }) => status === 201) &&
              JSON.stringify(replayed[0].payload) === JSON.stringify(replayed[1].payload),
            "concurrent same-key secret version returns one stable metadata record",
            { statuses: replayed.map(({ status }) => status), stable_results: false },
          );
          state.versions[name] = replayed[0].payload;
          const changedValue = makeValue();
          const changed = await call(path, {
            ...request,
            body: { value: changedValue },
          });
          assertCode(changed, 409, "idempotency_payload_changed", "changed-value secret replay");
          const staleValue = makeValue();
          const stale = await call(path, {
            method: "POST",
            token: owner.token,
            headers: headers("m1-secret-version-allowed-stale", state.secrets[name].revision),
            body: { value: staleValue },
          });
          assertStatus(stale, 412, "distinct-key stale secret revision");
        } else {
          state.versions[name] = await createVersion(
            `m1-secret-version-${name}`,
            state.secrets[name],
            value,
          );
        }
      }

      const sql = await postgres.psqlJson(
        "encrypted-secret-storage",
        `SELECT json_build_object(
           'secret_rows', (SELECT COUNT(*)::int FROM secrets WHERE account_id='${owner.record.id}'),
           'version_rows', (SELECT COUNT(*)::int FROM secret_versions WHERE account_id='${owner.record.id}'),
           'valid_nonce_rows', (SELECT COUNT(*)::int FROM secret_versions WHERE account_id='${owner.record.id}' AND octet_length(nonce)=24),
           'valid_tag_rows', (SELECT COUNT(*)::int FROM secret_versions WHERE account_id='${owner.record.id}' AND octet_length(auth_tag)=16),
           'plaintext_matches', (SELECT COUNT(*)::int FROM secret_versions WHERE account_id='${owner.record.id}' AND encode(ciphertext,'escape') LIKE '%m1-e2e-secret-%'),
           'allowed_version_rows', (SELECT COUNT(*)::int FROM secret_versions WHERE secret_id='${state.secrets.allowed.id}'),
           'keyed_replay_rows', (SELECT COUNT(*)::int FROM idempotency_records WHERE key='m1-secret-version-allowed' AND request_key_version IS NOT NULL AND octet_length(request_hash)=32)
         );`,
      );
      expectScenario(
        sql.secret_rows === 6 &&
          sql.version_rows === 6 &&
          sql.valid_nonce_rows === 6 &&
          sql.valid_tag_rows === 6 &&
          sql.plaintext_matches === 0 &&
          sql.allowed_version_rows === 1 &&
          sql.keyed_replay_rows === 1,
        "independent encrypted-at-rest storage checks",
        sql,
      );

      const keyProbe = await enqueue("m1-job-key-probe", [state.versions.allowed.id]);
      const leaseResponse = await lease("e2e-worker-key-probe");
      assertStatus(leaseResponse, 200, "key probe lease");
      const leaseAttempt = leaseResponse.payload.attempt;
      const resolve = await callInternalSensitive(`/internal/v1/jobs/${keyProbe.id}/credentials:resolve`, {
        method: "POST",
        body: {
          worker_id: "e2e-worker-key-probe",
          attempt_id: leaseAttempt.id,
          fence: leaseAttempt.fence,
          secret_version_ids: [state.versions.allowed.id],
        },
      });
      assertStatus(resolve, 200, "live lease credential resolution");
      expectScenario(
        resolve.payload?.credentials?.length === 1 &&
          resolve.payload.credentials[0].secret_version_id === state.versions.allowed.id &&
          resolve.payload.credentials[0].value === state.values.allowed,
        "resolved credential equals the in-memory fixture",
        { credential_count: resolve.payload?.credentials?.length ?? 0, exact_value_match: false },
      );

      let swapInstalled = false;
      try {
        await postgres.psqlCommand(
          "install-secret-context-swap",
          `CREATE TABLE e2e_secret_restore AS
             SELECT id,nonce,ciphertext,auth_tag FROM secret_versions WHERE id='${state.versions.allowed.id}';
           UPDATE secret_versions target
              SET nonce=source.nonce,ciphertext=source.ciphertext,auth_tag=source.auth_tag
             FROM secret_versions source
            WHERE target.id='${state.versions.allowed.id}' AND source.id='${state.versions.same_scope_undeclared.id}';`,
        );
        swapInstalled = true;
        const tampered = await callInternalSensitive(
          `/internal/v1/jobs/${keyProbe.id}/credentials:resolve`,
          {
            method: "POST",
            body: {
              worker_id: "e2e-worker-key-probe",
              attempt_id: leaseAttempt.id,
              fence: leaseAttempt.fence,
              secret_version_ids: [state.versions.allowed.id],
            },
          },
        );
        assertCode(tampered, 503, "foundation_unavailable", "scope-bound ciphertext swap");
      } finally {
        if (swapInstalled) {
          await postgres.psqlCommand(
            "restore-secret-context-swap",
            `UPDATE secret_versions target SET nonce=restore.nonce,ciphertext=restore.ciphertext,auth_tag=restore.auth_tag
               FROM e2e_secret_restore restore WHERE target.id=restore.id;
             DROP TABLE e2e_secret_restore;`,
          );
        }
      }

      const terminal = await complete(keyProbe.id, "e2e-worker-key-probe", leaseAttempt, {
        state: "succeeded",
        code: "bookkeeping_complete",
      });
      assertStatus(terminal, 200, "key probe completion");

      const wrongKey = randomBytes(32).toString("hex");
      context.registerSensitiveValues([wrongKey]);
      await restartApi("wrong secret-key fail-closed check", {
        environmentOverrides: { HOSTLET_SECRET_KEY: wrongKey },
        expectReady: false,
      });
      const wrongReady = await call("/readyz");
      assertStatus(wrongReady, 503, "readiness with wrong secret key");
      expectScenario(wrongReady.payload?.reason === "key_material_unavailable", "wrong-key readiness reason", {
        reason: wrongReady.payload?.reason ?? null,
      });
      await restartApi("correct secret-key recovery");
      const recoveredReady = await call("/readyz");
      assertStatus(recoveredReady, 200, "readiness after correct key restoration");

      await restartApi("missing recovery-key fail-closed check", {
        removeEnvironment: ["HOSTLET_RECOVERY_KEY"],
        expectReady: false,
      });
      const missingRecovery = await call("/readyz");
      assertStatus(missingRecovery, 503, "readiness with missing recovery key");
      await restartApi("recovery-key restoration");
      assertStatus(await call("/readyz"), 200, "readiness after recovery key restoration");
      return {
        secret_metadata_rows: sql.secret_rows,
        encrypted_version_rows: sql.version_rows,
        plaintext_rows: sql.plaintext_matches,
        live_resolution_status: resolve.status,
        exact_in_memory_value_match: true,
        context_swap_status: 503,
        wrong_key_readiness_status: wrongReady.status,
        missing_recovery_key_readiness_status: missingRecovery.status,
        recovered_readiness_status: recoveredReady.status,
      };
    },
  );

  await jobStep(
    context,
    "M1-JOB-01",
    "authorized idempotent enqueue exposes durable queued, running, succeeded, failed, canceled, and retriable states with immutable attempts",
    async () => {
      const failed = await enqueue("m1-job-failed");
      expectScenario(failed.state === "queued" && failed.attempt_count === 0, "new job queued", failed);
      const failedLease = await lease("e2e-worker-failed");
      assertStatus(failedLease, 200, "failed-state job lease");
      expectScenario(failedLease.payload.job.state === "running", "leased job running", {
        state: failedLease.payload.job.state,
      });
      const failedResult = await complete(failed.id, "e2e-worker-failed", failedLease.payload.attempt, {
        state: "failed",
        code: "bookkeeping_failed",
      });
      assertStatus(failedResult, 200, "failed job completion");
      expectScenario(failedResult.payload.job.state === "failed" && failedResult.payload.effect, "failed terminal effect", {
        state: failedResult.payload.job.state,
        effect_count: failedResult.payload.effect ? 1 : 0,
      });

      const retriable = await enqueue("m1-job-retriable");
      const retryLease = await lease("e2e-worker-retriable");
      const retryResult = await complete(retriable.id, "e2e-worker-retriable", retryLease.payload.attempt, {
        state: "retriable",
        code: "retry_requested",
      });
      assertStatus(retryResult, 200, "retriable job completion");
      expectScenario(retryResult.payload.job.state === "retriable" && retryResult.payload.effect === null, "retriable has no effect", {
        state: retryResult.payload.job.state,
        effect_count: retryResult.payload.effect ? 1 : 0,
      });
      state.jobs.retriable = retryResult.payload.job;
      const retryReplay = await complete(retriable.id, "e2e-worker-retriable", retryLease.payload.attempt, {
        state: "retriable",
        code: "retry_requested",
      });
      assertStatus(retryReplay, 200, "lost-response retriable completion replay");
      expectScenario(
        JSON.stringify(retryReplay.payload) === JSON.stringify(retryResult.payload),
        "retriable completion replay is byte-stable before a newer claim",
        { stable_replay: false },
      );

      const canceled = await enqueue("m1-job-canceled");
      const canceledResult = await call(`${jobPath}/${canceled.id}/cancel`, {
        method: "POST",
        token: owner.token,
        headers: headers("m1-job-cancel", canceled.revision),
        body: {},
      });
      assertStatus(canceledResult, 200, "queued job cancellation");
      expectScenario(canceledResult.payload.state === "canceled", "canceled state", {
        state: canceledResult.payload.state,
      });
      const attempts = await postgres.psqlJson(
        "job-state-attempts",
        `SELECT json_build_object(
           'failed_attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${failed.id}' AND state='failed'),
           'retriable_attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${retriable.id}' AND state='retriable'),
           'canceled_effects', (SELECT COUNT(*)::int FROM job_effects WHERE job_id='${canceled.id}')
         );`,
      );
      expectScenario(
        attempts.failed_attempts === 1 && attempts.retriable_attempts === 1 && attempts.canceled_effects === 0,
        "immutable attempt state and no canceled effect",
        attempts,
      );
      const retryAgain = await lease("e2e-worker-retriable-drain");
      assertStatus(retryAgain, 200, "drain observed retriable job");
      const oldRetryAfterClaim = await complete(
        retriable.id,
        "e2e-worker-retriable",
        retryLease.payload.attempt,
        { state: "retriable", code: "retry_requested" },
      );
      assertCode(oldRetryAfterClaim, 409, "job_fenced", "old retriable completion after newer claim");
      const retrySuccess = await complete(retriable.id, "e2e-worker-retriable-drain", retryAgain.payload.attempt, {
        state: "succeeded",
        code: "bookkeeping_complete",
      });
      assertStatus(retrySuccess, 200, "drained retriable job completion");

      const exhausted = await enqueue("m1-job-attempts-exhausted");
      let exhaustedResult = null;
      for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
        const claimed = await lease(`e2e-worker-exhaust-${attemptNumber}`);
        assertStatus(claimed, 200, `attempt-exhaustion lease ${attemptNumber}`);
        exhaustedResult = await complete(
          exhausted.id,
          `e2e-worker-exhaust-${attemptNumber}`,
          claimed.payload.attempt,
          { state: "retriable", code: "retry_requested" },
        );
        assertStatus(exhaustedResult, 200, `attempt-exhaustion outcome ${attemptNumber}`);
        if (attemptNumber < 3) {
          expectScenario(exhaustedResult.payload.job.state === "retriable", "pre-limit retry remains retriable", {
            attempt_number: attemptNumber,
            state: exhaustedResult.payload.job.state,
          });
        }
      }
      expectScenario(
        exhaustedResult.payload.job.state === "failed" &&
          exhaustedResult.payload.job.attempt_count === 3 &&
          exhaustedResult.payload.effect?.outcome_state === "failed" &&
          exhaustedResult.payload.effect?.outcome_code === "attempts_exhausted",
        "third retriable outcome terminalizes with one attempts-exhausted effect",
        {
          state: exhaustedResult.payload.job.state,
          attempt_count: exhaustedResult.payload.job.attempt_count,
          effect_code: exhaustedResult.payload.effect?.outcome_code ?? null,
        },
      );
      const exhaustedEffects = await postgres.psqlJson(
        "attempt-exhaustion-effects",
        `SELECT json_build_object('effects',(SELECT COUNT(*)::int FROM job_effects WHERE job_id='${exhausted.id}'));`,
      );
      expectScenario(exhaustedEffects.effects === 1, "attempt exhaustion commits exactly one effect", exhaustedEffects);
      return {
        states_observed: ["queued", "running", "failed", "retriable", "canceled"],
        immutable_attempt_rows: attempts.failed_attempts + attempts.retriable_attempts + 1,
        canceled_effect_rows: attempts.canceled_effects,
        retriable_replay_status: retryReplay.status,
        stale_retriable_replay_status: oldRetryAfterClaim.status,
        exhausted_attempt_count: exhaustedResult.payload.job.attempt_count,
        exhausted_effect_rows: exhaustedEffects.effects,
      };
    },
  );

  await jobStep(
    context,
    "M1-JOB-02",
    "a real killed worker loses its database-clock lease; a replacement claims a higher fence, while stale renew, credential resolution, and completion fail and terminal duplicate completion creates one effect",
    async () => {
      const raceJob = await enqueue("m1-job-lock-clock-race");
      const raceLease = await lease("e2e-worker-lock-clock");
      assertStatus(raceLease, 200, "lock-clock race lease");
      const lockHolder = postgres.spawnPsql(
        "job-lock-clock-race",
        `SET application_name='hostlet_e2e_job_lock_holder';
         BEGIN;
         SELECT id FROM jobs WHERE id='${raceJob.id}' FOR UPDATE;
         SELECT pg_sleep(2.6);
         COMMIT;`,
      );
      const lockDeadline = Date.now() + 5_000;
      let lockObserved = false;
      while (Date.now() < lockDeadline) {
        const lockState = await postgres.psqlJson(
          "job-lock-clock-observer",
          `SELECT json_build_object('holding',EXISTS(
             SELECT 1 FROM pg_stat_activity
              WHERE application_name='hostlet_e2e_job_lock_holder'
                AND state='active' AND wait_event='PgSleep'
           ));`,
        );
        if (lockState.holding) {
          lockObserved = true;
          break;
        }
        await context.delay(50);
      }
      expectScenario(lockObserved, "deterministic job row-lock holder observation", { lock_observed: false });
      const blockedRenew = callInternal(`/internal/v1/jobs/${raceJob.id}/renew`, {
        method: "POST",
        body: {
          worker_id: "e2e-worker-lock-clock",
          attempt_id: raceLease.payload.attempt.id,
          fence: raceLease.payload.attempt.fence,
        },
      });
      const lockExit = await lockHolder.exited;
      expectScenario(lockExit.code === 0, "job row-lock holder exits cleanly", { exit_status: lockExit.code });
      const expiredWhileBlocked = await blockedRenew;
      assertCode(expiredWhileBlocked, 409, "job_fenced", "lease expiry while renew waits on row lock");
      await waitForState(raceJob.id, ["retriable"]);
      const raceReplacement = spawnBuilder("e2e-worker-lock-clock-replacement", "lock-clock-replacement", ["--once"]);
      const raceReplacementExit = await raceReplacement.exited;
      expectScenario(raceReplacementExit.code === 0, "lock-clock replacement worker", {
        exit_status: raceReplacementExit.code,
      });
      await waitForState(raceJob.id, ["succeeded"]);

      const job = await enqueue("m1-job-kill-replace", [state.versions.allowed.id]);
      const killed = spawnBuilder(manifest.workers.killed, "killed", ["--once", "--hold-after-claim-ms", "10000"]);
      const running = await waitForState(job.id, ["running"]);
      const oldAttempt = { id: running.current_attempt_id, fence: running.current_fence };
      await context.stopManaged(killed, "intentional E2E worker death after lease claim");
      await waitForState(job.id, ["retriable"]);
      const replacement = spawnBuilder(manifest.workers.replacement, "replacement", ["--once"]);
      const replacementExit = await replacement.exited;
      expectScenario(replacementExit.code === 0, "replacement worker exits successfully", {
        exit_status: replacementExit.code,
      });
      const succeeded = await waitForState(job.id, ["succeeded"]);
      expectScenario(succeeded.current_fence > oldAttempt.fence && succeeded.attempt_count === 2, "replacement higher fence", {
        old_fence: oldAttempt.fence,
        replacement_fence: succeeded.current_fence,
        attempt_count: succeeded.attempt_count,
      });

      const staleBody = {
        worker_id: manifest.workers.killed,
        attempt_id: oldAttempt.id,
        fence: oldAttempt.fence,
      };
      const staleRenew = await callInternal(`/internal/v1/jobs/${job.id}/renew`, {
        method: "POST",
        body: staleBody,
      });
      assertCode(staleRenew, 409, "job_fenced", "stale renew");
      const staleResolve = await callInternalSensitive(`/internal/v1/jobs/${job.id}/credentials:resolve`, {
        method: "POST",
        body: { ...staleBody, secret_version_ids: [state.versions.allowed.id] },
      });
      assertCode(staleResolve, 409, "job_fenced", "stale credential resolution");
      const staleComplete = await callInternal(`/internal/v1/jobs/${job.id}/complete`, {
        method: "POST",
        body: { ...staleBody, outcome: { state: "succeeded", code: "bookkeeping_complete" } },
      });
      assertCode(staleComplete, 409, "job_fenced", "stale completion");

      const attempt = await postgres.psqlJson(
        "replacement-attempt",
        `SELECT json_build_object('id',id::text,'fence',fence,'worker_id',worker_id)
           FROM job_attempts WHERE job_id='${job.id}' ORDER BY attempt_number DESC LIMIT 1;`,
      );
      const duplicateBody = {
        worker_id: attempt.worker_id,
        attempt_id: attempt.id,
        fence: Number(attempt.fence),
        outcome: { state: "succeeded", code: "bookkeeping_complete" },
      };
      const duplicate = await callInternal(`/internal/v1/jobs/${job.id}/complete`, {
        method: "POST",
        body: duplicateBody,
      });
      assertStatus(duplicate, 200, "exact duplicate terminal completion");
      const changed = await callInternal(`/internal/v1/jobs/${job.id}/complete`, {
        method: "POST",
        body: { ...duplicateBody, outcome: { state: "failed", code: "bookkeeping_failed" } },
      });
      assertCode(changed, 409, "completion_conflict", "changed terminal completion");
      const counts = await postgres.psqlJson(
        "kill-replace-effects",
        `SELECT json_build_object(
           'attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${job.id}'),
           'expired_attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${job.id}' AND state='expired'),
           'effects', (SELECT COUNT(*)::int FROM job_effects WHERE job_id='${job.id}')
         );`,
      );
      expectScenario(counts.attempts === 2 && counts.expired_attempts === 1 && counts.effects === 1, "lease recovery rows", counts);
      return {
        killed_worker_cleanup: "SIGTERM process group",
        lock_holder_observed: true,
        blocked_expired_renew_status: expiredWhileBlocked.status,
        old_fence: oldAttempt.fence,
        replacement_fence: succeeded.current_fence,
        stale_statuses: [staleRenew.status, staleResolve.status, staleComplete.status],
        duplicate_completion_status: duplicate.status,
        changed_completion_status: changed.status,
        immutable_attempt_rows: counts.attempts,
        committed_effect_rows: counts.effects,
      };
    },
  );

  await jobStep(
    context,
    "M1-JOB-03",
    "competing real workers cannot own one current lease; retry keeps one durable job and produces at most one committed effect; API restart preserves jobs, attempts, fences, and effects",
    async () => {
      const enqueued = await enqueue("m1-job-competing-retry");
      const initialLease = await lease("e2e-worker-retry-seed");
      assertStatus(initialLease, 200, "competing retry seed lease");
      const retry = await complete(enqueued.id, "e2e-worker-retry-seed", initialLease.payload.attempt, {
        state: "retriable",
        code: "retry_requested",
      });
      assertStatus(retry, 200, "competing retry seed outcome");
      const job = retry.payload.job;
      const a = spawnBuilder(manifest.workers.competitor_a, "competitor-a", ["--once"]);
      const b = spawnBuilder(manifest.workers.competitor_b, "competitor-b", ["--once"]);
      const exits = await Promise.all([a.exited, b.exited]);
      expectScenario(exits.every(({ code }) => code === 0), "competing workers exit cleanly", {
        exit_statuses: exits.map(({ code }) => code),
      });
      const succeeded = await waitForState(job.id, ["succeeded"]);
      const before = await postgres.psqlJson(
        "competing-worker-counts-before-restart",
        `SELECT json_build_object(
           'jobs', (SELECT COUNT(*)::int FROM jobs WHERE id='${job.id}'),
           'attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${job.id}'),
           'running_attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${job.id}' AND state='running'),
           'effects', (SELECT COUNT(*)::int FROM job_effects WHERE job_id='${job.id}'),
           'max_fence', (SELECT MAX(fence) FROM job_attempts WHERE job_id='${job.id}')
         );`,
      );
      expectScenario(
        before.jobs === 1 && before.attempts === 2 && before.running_attempts === 0 && before.effects === 1,
        "competing workers preserve one intent and effect",
        before,
      );
      await restartApi("M1 job durability restart");
      const afterRead = await call(`${jobPath}/${job.id}`, { token: owner.token });
      assertStatus(afterRead, 200, "job after API restart");
      expectScenario(
        afterRead.payload.id === job.id &&
          afterRead.payload.state === "succeeded" &&
          afterRead.payload.current_fence === succeeded.current_fence,
        "job state and fence survive API restart",
        { stable_job: false },
      );
      const after = await postgres.psqlJson(
        "competing-worker-counts-after-restart",
        `SELECT json_build_object(
           'jobs', (SELECT COUNT(*)::int FROM jobs WHERE id='${job.id}'),
           'attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${job.id}'),
           'running_attempts', (SELECT COUNT(*)::int FROM job_attempts WHERE job_id='${job.id}' AND state='running'),
           'effects', (SELECT COUNT(*)::int FROM job_effects WHERE job_id='${job.id}'),
           'max_fence', (SELECT MAX(fence) FROM job_attempts WHERE job_id='${job.id}')
         );`,
      );
      expectScenario(JSON.stringify(after) === JSON.stringify(before), "job rows stable across API restart", {
        stable_counts: false,
      });
      return {
        competitor_exit_statuses: exits.map(({ code }) => code),
        durable_job_rows: after.jobs,
        immutable_attempt_rows: after.attempts,
        current_running_attempts: after.running_attempts,
        committed_effect_rows: after.effects,
        stable_fence: after.max_fence,
      };
    },
  );

  await jobStep(
    context,
    "M1-JOB-05",
    "credential resolution requires the selected commit's declarations and a live owner/fence tuple; undeclared, cross-service, cross-owner, production-database, and management credentials are denied",
    async () => {
      const prohibited = [];
      for (const [name, code] of [
        ["production_database", "credential_kind_not_allowed"],
        ["platform_management", "credential_kind_not_allowed"],
        ["runtime_operation", "secret_operation_mismatch"],
      ]) {
        const response = await call(jobPath, {
          method: "POST",
          token: owner.token,
          headers: headers(`m1-job-prohibited-${name}`),
          body: {
            kind: "foundation_bookkeeping",
            operation: "build",
            service_id: service.id,
            source_commit: manifest.source_commits.secondary,
            secret_version_refs: [{ service_id: service.id, secret_version_id: state.versions[name].id }],
          },
        });
        assertCode(response, 422, code, `prohibited ${name} enqueue`);
        prohibited.push(response.status);
      }
      const job = await enqueue(
        "m1-job-scope-policy",
        [state.versions.allowed.id],
        manifest.source_commits.secondary,
      );
      const leased = await lease(manifest.workers.manual);
      assertStatus(leased, 200, "scope-policy job lease");
      const attempt = leased.payload.attempt;
      const resolveIds = async (ids) =>
        callInternalSensitive(`/internal/v1/jobs/${job.id}/credentials:resolve`, {
          method: "POST",
          body: {
            worker_id: manifest.workers.manual,
            attempt_id: attempt.id,
            fence: attempt.fence,
            secret_version_ids: ids,
          },
        });
      const allowed = await resolveIds([state.versions.allowed.id]);
      assertStatus(allowed, 200, "declared source credential");
      expectScenario(
        allowed.payload.credentials?.length === 1 &&
          allowed.payload.credentials[0].value === state.values.allowed,
        "declared source credential exact in-memory value",
        { credential_count: allowed.payload.credentials?.length ?? 0, exact_value_match: false },
      );
      const undeclared = await resolveIds([state.versions.same_scope_undeclared.id]);
      assertCode(undeclared, 404, "not_found", "undeclared secret version");
      const crossService = await resolveIds([state.versions.other_service.id]);
      assertCode(crossService, 404, "not_found", "other service secret version");
      const production = await resolveIds([state.versions.production_database.id]);
      assertCode(production, 404, "not_found", "undeclared production database credential");
      const management = await resolveIds([state.versions.platform_management.id]);
      assertCode(management, 404, "not_found", "undeclared platform management credential");
      const otherOwnedSecret = await createSecret(
        "m1-secret-other-owner",
        { name: "e2e-other-owner", operation: "build", credential_kind: "source_repository_read" },
        graph.otherGraph.services[0].id,
        other.token,
        graph.otherGraph.project.id,
      );
      const otherValue = makeValue();
      const otherOwnedVersion = await createVersion(
        "m1-secret-version-other-owner",
        otherOwnedSecret,
        otherValue,
        other.token,
      );
      const crossOwner = await resolveIds([otherOwnedVersion.id]);
      assertCode(crossOwner, 404, "not_found", "other owner secret version");
      await complete(job.id, manifest.workers.manual, attempt, {
        state: "succeeded",
        code: "bookkeeping_complete",
      });
      const noProhibitedJobs = await postgres.psqlJson(
        "prohibited-credential-job-counts",
        `SELECT json_build_object(
           'prohibited_jobs', (SELECT COUNT(*)::int FROM jobs WHERE id IN (
             SELECT job_id FROM job_secret_refs WHERE secret_version_id IN (
               '${state.versions.production_database.id}',
               '${state.versions.platform_management.id}',
               '${state.versions.runtime_operation.id}'
             )
           )),
           'prohibited_effects', (SELECT COUNT(*)::int FROM job_effects WHERE job_id IN (
             SELECT job_id FROM job_secret_refs WHERE secret_version_id IN (
               '${state.versions.production_database.id}',
               '${state.versions.platform_management.id}',
               '${state.versions.runtime_operation.id}'
             )
           ))
         );`,
      );
      expectScenario(
        noProhibitedJobs.prohibited_jobs === 0 && noProhibitedJobs.prohibited_effects === 0,
        "prohibited credential jobs create no intent or effect",
        noProhibitedJobs,
      );
      return {
        selected_source_commit: job.source_commit,
        allowed_resolution_status: allowed.status,
        exact_in_memory_value_match: true,
        denied_statuses: [undeclared.status, crossService.status, crossOwner.status, production.status, management.status],
        denied_scope_count: 5,
        prohibited_enqueue_statuses: prohibited,
        prohibited_job_rows: noProhibitedJobs.prohibited_jobs,
        prohibited_effect_rows: noProhibitedJobs.prohibited_effects,
      };
    },
  );

  await jobStep(
    context,
    "M1-JOB-06",
    "M1 workers perform bookkeeping only; execution kinds fail closed, public and internal listeners stay separated, worker auth is required, and unsafe binds or lease durations refuse startup",
    async () => {
      const unsupported = [];
      for (const kind of ["build", "runtime", "release"]) {
        const response = await call(jobPath, {
          method: "POST",
          token: owner.token,
          headers: headers(`m1-job-unsupported-${kind}`),
          body: {
            kind,
            operation: "build",
            service_id: service.id,
            source_commit: manifest.source_commits.primary,
            secret_version_refs: [],
          },
        });
        assertCode(response, 422, "unsupported_job_kind", `unsupported ${kind} job`);
        unsupported.push(response.status);
      }
      const publicInternal = await call("/internal/v1/jobs/lease", {
        method: "POST",
        body: { worker_id: "public-boundary-probe", kinds: ["foundation_bookkeeping"] },
      });
      assertStatus(publicInternal, 404, "internal path absent from public listener");
      const missingAuth = await callInternal("/internal/v1/jobs/lease", {
        method: "POST",
        omitToken: true,
        body: { worker_id: "missing-auth", kinds: ["foundation_bookkeeping"] },
      });
      assertErrorShape(missingAuth, 401, "internal missing bearer token");
      const wrongAuth = await callInternal("/internal/v1/jobs/lease", {
        method: "POST",
        token: (() => {
          const value = randomBytes(32).toString("base64url");
          context.registerSensitiveValues([value]);
          return value;
        })(),
        body: { worker_id: "wrong-auth", kinds: ["foundation_bookkeeping"] },
      });
      assertErrorShape(wrongAuth, 401, "internal wrong bearer token");

      const startupFailures = [];
      for (const [label, environmentOverrides] of [
        ["non-loopback-worker-bind", { HOSTLET_WORKER_BIND: "0.0.0.0:1" }],
        ["lease-too-short", { HOSTLET_WORKER_LEASE_SECONDS: "1" }],
        ["lease-too-long", { HOSTLET_WORKER_LEASE_SECONDS: "301" }],
      ]) {
        const result = await context.runCommand(`Hostlet rejected config ${label}`, join(context.repo, "target", "debug", "hostlet-control"), [], {
          env: environmentForProbe(environmentOverrides),
          timeoutMs: 5_000,
          allowFailure: true,
          logName: `foundation-rejected-${label}.log`,
        });
        expectScenario(result.code !== 0, `invalid startup config ${label} fails`, { exit_status: result.code });
        startupFailures.push(result.code);
      }
      const counts = await postgres.psqlJson(
        "unsupported-work-counts",
        `SELECT json_build_object(
           'unsupported_jobs', (SELECT COUNT(*)::int FROM jobs WHERE kind <> 'foundation_bookkeeping'),
           'bookkeeping_effects', (SELECT COUNT(*)::int FROM job_effects)
         );`,
      );
      expectScenario(counts.unsupported_jobs === 0, "no customer execution job persisted", counts);
      return {
        unsupported_kind_statuses: unsupported,
        public_internal_path_status: publicInternal.status,
        internal_auth_statuses: [missingAuth.status, wrongAuth.status],
        invalid_startup_exit_statuses: startupFailures,
        customer_workloads_executed: 0,
        platform_bookkeeping_effect_rows: counts.bookkeeping_effects,
      };
    },
  );
}
