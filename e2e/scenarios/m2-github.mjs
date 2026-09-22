import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertErrorShape,
  assertNoCredentialValue,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";
import { startGitHubFixture } from "../support/github-provider.mjs";

export const M2_GITHUB_REQUIRED_ASSERTIONS = Object.freeze([
  "M2-GITHUB-01",
  "M2-GITHUB-02",
  "M2-GITHUB-03",
  "M2-GITHUB-04",
  "M2-GITHUB-05",
]);

const INITIAL_COMMIT = "1111111111111111111111111111111111111111";
const MOVED_COMMIT = "1111111111111111111111111111111111111112";
const MOVED_TREE = "a111111111111111111111111111111111111112";

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function githubStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M2 GitHub connection, immutable source, and signed events", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M2 GitHub connection, immutable source, and signed events",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "GitHub HTTP or persistence boundary failed",
    );
    throw error;
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function mutationHeaders(key, revision) {
  return { "Idempotency-Key": key, "If-Match": `"${revision}"` };
}

function assertErrorCode(response, status, code, check) {
  assertErrorShape(response, status, check);
  expectScenario(response.payload.error.code === code, `${check}: stable safe error`, {
    status: response.status,
    error_code: response.payload.error.code,
  });
}

function assertSource(response, projectId, repositoryId, ref, commit, check) {
  assertStatus(response, 200, check);
  const source = response.payload;
  expectScenario(
    typeof source?.binding_id === "string" &&
      source.project_id === projectId &&
      source.repository?.id === repositoryId &&
      source.repository?.private === true &&
      source.ref === ref &&
      source.status === "active" &&
      Number.isInteger(source.revision) &&
      source.revision > 0 &&
      source.source_revision?.resolved_commit === commit &&
      /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(source.source_revision?.tree_sha ?? "") &&
      source.source_revision?.source === "owner_resolve" &&
      source.configuration_fresh === true,
    `${check}: safe immutable source response`,
    { source_shape_valid: false },
  );
  return source;
}

function fixtureMethod(fixture, name) {
  const method = fixture.controls?.[name];
  expectScenario(typeof method === "function", `GitHub fixture exposes ${name}`, {
    missing_fixture_control: name,
  });
  return method.bind(fixture.controls);
}

async function followAuthorization(context, fixture, authorizationUrl, mode = "success") {
  fixtureMethod(fixture, "authorizeNext")({ mode });
  const response = await fetch(authorizationUrl, {
    redirect: "manual",
    signal: AbortSignal.any([AbortSignal.timeout(10_000), context.abortSignal]),
  });
  expectScenario(response.status >= 300 && response.status < 400, "provider authorization redirects to callback", {
    provider_authorization_status: response.status,
  });
  const location = response.headers.get("location");
  expectScenario(typeof location === "string", "provider authorization supplies callback location", {
    callback_location_present: false,
  });
  return new URL(location);
}

async function oauthAttempt(m2, token) {
  const response = await m2.call("/v1/github/oauth-attempts", { method: "POST", token });
  assertStatus(response, 201, "GitHub OAuth attempt");
  expectScenario(
    typeof response.payload?.authorization_url === "string" &&
      Number.isFinite(Date.parse(response.payload?.expires_at)),
    "OAuth attempt returns safe authorization URL and expiry",
    { oauth_attempt_shape_valid: false },
  );
  return response.payload;
}

async function authorizeAndComplete(m2, token, mode = "success") {
  const attempt = await oauthAttempt(m2, token);
  const callback = await followAuthorization(m2.context, m2.state.githubFixture, attempt.authorization_url, mode);
  const state = callback.searchParams.get("state");
  const code = callback.searchParams.get("code");
  if (state) m2.context.registerSensitiveValues([state]);
  if (code) m2.context.registerSensitiveValues([code]);
  return { attempt, callback, state, code };
}

async function githubCounts(postgres, label) {
  return postgres.psqlJson(
    label,
    `SELECT json_build_object(
       'oauth_attempts', (SELECT COUNT(*)::int FROM github_oauth_attempts),
       'pending_oauth_attempts', (SELECT COUNT(*)::int FROM github_oauth_attempts WHERE status='pending'),
       'authorizations', (SELECT COUNT(*)::int FROM github_user_authorizations),
       'active_authorizations', (SELECT COUNT(*)::int FROM github_user_authorizations WHERE status='active'),
       'bindings', (SELECT COUNT(*)::int FROM github_repository_bindings),
       'active_bindings', (SELECT COUNT(*)::int FROM github_repository_bindings WHERE status='active'),
       'source_revisions', (SELECT COUNT(*)::int FROM github_source_revisions),
       'webhook_deliveries', (SELECT COUNT(*)::int FROM github_webhook_deliveries),
       'jobs', (SELECT COUNT(*)::int FROM jobs),
       'deployments', (SELECT COUNT(*)::int FROM deployments),
       'hosted_slots', (SELECT COALESCE(SUM(hosted_slots),0)::int FROM projects),
       'hosting_events', (SELECT COUNT(*)::int FROM hosting_state_events),
       'lifecycle_intents', (SELECT COUNT(*)::int FROM project_lifecycle_intents)
     );`,
  );
}

async function sourceRows(postgres, projectId, label, databaseName = null) {
  const sql = `SELECT COALESCE(json_agg(json_build_object(
       'binding_id', binding_id::text,
       'commit', commit_sha,
       'tree', tree_sha,
       'source', source,
       'delivery_id', webhook_delivery_id
     ) ORDER BY observed_at,id),'[]'::json)
       FROM github_source_revisions
      WHERE project_id=${sqlString(projectId)}::uuid;`;
  return databaseName
    ? postgres.psqlJsonDatabase(label, databaseName, sql)
    : postgres.psqlJson(label, sql);
}

async function latestBinding(postgres, projectId, label, databaseName = null) {
  const sql = `SELECT json_build_object(
      'id',id::text,'status',status,'revision',revision::int,
      'github_repository_id',github_repository_id
    ) FROM github_repository_bindings
    WHERE project_id=${sqlString(projectId)}::uuid
    ORDER BY created_at DESC,id DESC LIMIT 1;`;
  return databaseName
    ? postgres.psqlJsonDatabase(label, databaseName, sql)
    : postgres.psqlJson(label, sql);
}

async function bindingById(postgres, bindingId, label, databaseName = null) {
  const sql = `SELECT json_build_object(
      'id',id::text,'status',status,'revision',revision::int,
      'github_repository_id',github_repository_id
    ) FROM github_repository_bindings
    WHERE id=${sqlString(bindingId)}::uuid;`;
  return databaseName
    ? postgres.psqlJsonDatabase(label, databaseName, sql)
    : postgres.psqlJson(label, sql);
}

function webhookHeaders(secret, deliveryId, event, rawBody, signatureBody = rawBody) {
  const signature = createHmac("sha256", secret).update(signatureBody).digest("hex");
  return {
    "X-Hub-Signature-256": `sha256=${signature}`,
    "X-GitHub-Delivery": deliveryId,
    "X-GitHub-Event": event,
    "Content-Type": "application/json",
  };
}

async function deliverWebhook(m2, { deliveryId = randomUUID(), event = "push", payload, signatureBody }) {
  const rawBody = JSON.stringify(payload);
  const secret = fixtureMethod(m2.state.githubFixture, "webhookSecret")();
  return m2.call("/v1/github/webhooks", {
    method: "POST",
    rawBody,
    headers: webhookHeaders(secret, deliveryId, event, rawBody, signatureBody),
  });
}

function pushPayload(repositoryId, ref, after, installationId) {
  return {
    ref,
    after,
    repository: { id: repositoryId },
    installation: { id: installationId },
  };
}

export function registerM2GitHubFixtures(context) {
  context.registerFixture("M2 GitHub HTTP scenario module", "e2e/scenarios/m2-github.mjs");
  context.registerFixture("M2 synthetic GitHub provider", "e2e/support/github-provider.mjs");
  context.registerFixture("M2 owned synthetic repository graph", "e2e/fixtures/m2-repositories.json");
  context.registerFixture("M2 GitHub acceptance inventory", "docs/M2-SCENARIOS.md");
  return Object.freeze({
    schema_version: 1,
    provider_boundary: "owned synthetic loopback GitHub HTTP provider; no Hostlet internal is mocked",
  });
}

export async function prepareM2GitHubFixture(m2) {
  if (m2.state.githubFixture) throw new Error("M2 GitHub fixture already prepared");
  const callbackUrl = `${m2.apiUrl}/github/callback`;
  const fixture = await startGitHubFixture(m2.context, { callbackUrl });
  const environment = fixture.controls?.environment
    ? fixture.controls.environment(callbackUrl)
    : fixture.environment;
  expectScenario(environment && typeof environment === "object", "GitHub fixture environment contract", {
    fixture_environment_present: false,
  });
  Object.assign(m2.extraEnvironment, environment);
  fixture.controls.setGrant({
    repositoryIds: [61001, 61002],
    contentsPermission: "read",
    suspended: false,
  });
  m2.state.githubFixture = fixture;
  m2.context.state.configuration.m2GitHub = {
    provider: "owned synthetic loopback GitHub HTTP fixture",
    providerOrigin: fixture.baseUrl,
    callbackOrigin: new URL(callbackUrl).origin,
    retainedCredentials: 0,
  };
  return fixture;
}

export async function runM2GitHubScenarios(m2) {
  const { context, postgres, call, currentApiBinary, switchApi, state } = m2;
  const fixture = state.githubFixture;
  expectScenario(Boolean(fixture), "M2 GitHub fixture prepared before API startup", {
    github_fixture_prepared: false,
  });
  const manifest = JSON.parse(
    readFileSync(join(context.repo, "e2e", "fixtures", "m2-repositories.json"), "utf8"),
  );
  expectScenario(manifest.schema_version === 1, "M2 GitHub fixture schema", {
    fixture_schema_version: manifest.schema_version,
  });
  const installationId = manifest.installation.id;
  const primaryRepository = manifest.repositories.find(({ id }) => id === 61001);
  const unboundRepository = manifest.repositories.find(({ id }) => id === 61002);
  expectScenario(Boolean(primaryRepository && unboundRepository), "M2 GitHub named repository fixtures", {
    named_repository_fixtures: false,
  });
  const projectId = state.graph.project.id;
  const repositoryRecordId = state.graph.repositories[0].id;
  const baseline = await githubCounts(postgres, "m2-github-baseline");

  await githubStep(
    context,
    "M2-GITHUB-01",
    "OAuth state is session-bound, expiring and single-use; provider denial leaves no partial connection; least-privilege discovery is owner-isolated and credential-free",
    async () => {
      const denied = await authorizeAndComplete(m2, state.owner.token, "deny");
      expectScenario(
        denied.callback.searchParams.get("error") === "access_denied" && denied.code === null,
        "provider denial returns no authorization code",
        { provider_denial: denied.callback.searchParams.get("error"), authorization_code_present: Boolean(denied.code) },
      );
      const beforeConnection = await call("/v1/github/connection", { token: state.owner.token });
      assertErrorCode(beforeConnection, 409, "github_connection_required", "denied OAuth leaves no connection");

      const providerExpired = await authorizeAndComplete(m2, state.owner.token, "expired");
      const expiredToken = await call("/v1/github/oauth-completions", {
        method: "POST",
        token: state.owner.token,
        body: { code: providerExpired.code, state: providerExpired.state },
      });
      expectScenario(expiredToken.status >= 400 && expiredToken.status < 600, "expired provider token is rejected", {
        expired_provider_token_status: expiredToken.status,
      });

      const flow = await authorizeAndComplete(m2, state.owner.token);
      const otherSession = await call("/v1/github/oauth-completions", {
        method: "POST",
        token: state.other.token,
        body: { code: flow.code, state: flow.state },
      });
      assertErrorCode(otherSession, 400, "github_oauth_state_invalid", "OAuth attempt rejects another Hostlet session");
      const mismatched = await call("/v1/github/oauth-completions", {
        method: "POST",
        token: state.owner.token,
        body: { code: flow.code, state: `${flow.state}-mismatch` },
      });
      assertErrorCode(mismatched, 400, "github_oauth_state_invalid", "OAuth attempt rejects mismatched state");
      const completed = await call("/v1/github/oauth-completions", {
        method: "POST",
        token: state.owner.token,
        body: { code: flow.code, state: flow.state },
      });
      assertStatus(completed, 200, "owner completes OAuth once");
      expectScenario(
        completed.payload?.github_user?.id === manifest.owner.id &&
          completed.payload.github_user.login === manifest.owner.login &&
          Number.isInteger(completed.payload.revision),
        "OAuth completion exposes safe identity only",
        { oauth_completion_shape_valid: false },
      );
      const replay = await call("/v1/github/oauth-completions", {
        method: "POST",
        token: state.owner.token,
        body: { code: flow.code, state: flow.state },
      });
      assertErrorCode(replay, 409, "github_oauth_state_replayed", "OAuth state replay");

      const ownerInstallations = await call("/v1/github/installations", { token: state.owner.token });
      assertStatus(ownerInstallations, 200, "owner installation discovery");
      expectScenario(
        ownerInstallations.payload?.installations?.length === 1 &&
          ownerInstallations.payload.installations[0].id === installationId &&
          ownerInstallations.payload.installations[0].contents_permission === "read" &&
          ownerInstallations.payload.installations[0].suspended === false,
        "least-privilege installation discovery",
        { installations: ownerInstallations.payload?.installations?.length ?? null },
      );
      const repositories = await call(`/v1/github/installations/${installationId}/repositories`, {
        token: state.owner.token,
      });
      assertStatus(repositories, 200, "owner repository discovery");
      const repositoryIds = repositories.payload.repositories.map(({ id }) => id).sort((a, b) => a - b);
      expectScenario(
        repositoryIds.includes(primaryRepository.id) && repositoryIds.includes(unboundRepository.id) &&
          repositories.payload.repositories.every((repository) => repository.readable === true && repository.private === true),
        "provider lists only readable granted repositories",
        { repository_count: repositoryIds.length, expected_named_repositories_present: false },
      );
      const otherConnection = await call("/v1/github/connection", { token: state.other.token });
      assertErrorCode(otherConnection, 409, "github_connection_required", "second account cannot inspect owner connection");

      await switchApi(currentApiBinary, "M2 OAuth expiry probe", {
        environmentOverrides: { HOSTLET_GITHUB_OAUTH_ATTEMPT_TTL_SECONDS: "1" },
      });
      const expiring = await authorizeAndComplete(m2, state.other.token);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const expired = await call("/v1/github/oauth-completions", {
        method: "POST",
        token: state.other.token,
        body: { code: expiring.code, state: expiring.state },
      });
      assertErrorCode(expired, 400, "github_oauth_state_expired", "OAuth attempt expiry");
      await switchApi(currentApiBinary, "M2 OAuth expiry probe restore");

      const counts = await githubCounts(postgres, "m2-github-oauth-counts");
      expectScenario(
        counts.authorizations === baseline.authorizations + 1 && counts.active_authorizations === 1,
        "denial and invalid state create no partial connection",
        counts,
      );
      const encryptedStorage = await postgres.psqlJson(
        "m2-github-encrypted-credential-storage",
        `SELECT json_build_object(
           'state_digests_only', (SELECT bool_and(octet_length(state_digest)=32) FROM github_oauth_attempts),
           'pkce_encrypted', (SELECT bool_and(octet_length(pkce_nonce)=24 AND octet_length(pkce_ciphertext)>0 AND octet_length(pkce_auth_tag)=16) FROM github_oauth_attempts),
           'user_token_encrypted', (SELECT bool_and(octet_length(token_nonce)=24 AND octet_length(token_ciphertext)>0 AND octet_length(token_auth_tag)=16) FROM github_user_authorizations WHERE status='active')
         );`,
      );
      expectScenario(
        encryptedStorage.state_digests_only === true &&
          encryptedStorage.pkce_encrypted === true &&
          encryptedStorage.user_token_encrypted === true,
        "OAuth state is digested and retained provider credentials are encrypted",
        encryptedStorage,
      );
      const observations = fixture.safeObservations();
      assertNoCredentialValue(observations, Object.values(m2.credentials), "safe provider observations omit Hostlet credentials");
      return {
        provider_boundary: "synthetic external HTTP",
        connected_github_user_id: completed.payload.github_user.id,
        installation_count: ownerInstallations.payload.installations.length,
        readable_repository_count: repositoryIds.length,
        rejected_cross_session: true,
        rejected_mismatched_state: true,
        rejected_replay: true,
        rejected_expired_state: true,
        rejected_expired_provider_token: true,
        partial_connections: 0,
        encrypted_credential_storage: true,
        provider_observation_count: observations.length,
        retained_credentials: 0,
      };
    },
  );

  let binding;
  await githubStep(
    context,
    "M2-GITHUB-02",
    "only an owner-authorized installation, repository and listed branch can bind; idempotency and optimistic concurrency hold; exact commits remain immutable across branch movement and rebind",
    async () => {
      const branches = await call(
        `/v1/github/installations/${installationId}/repositories/${primaryRepository.id}/branches`,
        { token: state.owner.token },
      );
      assertStatus(branches, 200, "provider-listed branches");
      expectScenario(
        branches.payload.branches.some(({ ref, commit_sha }) => ref === "refs/heads/main" && commit_sha === INITIAL_COMMIT),
        "listed main branch resolves to initial exact commit",
        { initial_main_branch_present: false },
      );

      fixture.controls.renameRepository(unboundRepository.id, primaryRepository.name);
      const collidingNames = await call(`/v1/github/installations/${installationId}/repositories`, {
        token: state.owner.token,
      });
      assertStatus(collidingNames, 200, "repository discovery with colliding display names");
      expectScenario(
        collidingNames.payload.repositories.filter(({ name }) => name === primaryRepository.name).length === 2 &&
          new Set(collidingNames.payload.repositories.map(({ id }) => id)).size ===
            collidingNames.payload.repositories.length,
        "numeric provider identities remain distinct across display-name collision",
        { distinct_repository_ids: false },
      );
      fixture.controls.renameRepository(unboundRepository.id, unboundRepository.name);

      fixture.controls.setGrant({
        installationId,
        repositoryIds: [primaryRepository.id, unboundRepository.id],
        contentsPermission: "none",
        suspended: false,
      });
      const insufficientPermission = await call(
        `/v1/github/installations/${installationId}/repositories/${primaryRepository.id}/branches`,
        { token: state.owner.token },
      );
      assertErrorCode(insufficientPermission, 422, "github_access_denied", "insufficient installation permission");
      fixture.controls.setGrant({
        installationId,
        repositoryIds: [primaryRepository.id, unboundRepository.id],
        contentsPermission: "read",
        suspended: false,
      });

      const currentProject = await call(`/v1/projects/${projectId}`, { token: state.owner.token });
      assertStatus(currentProject, 200, "current project revision before GitHub rejection matrix");
      const bindProjectRevision = currentProject.payload.project.revision;

      for (const [name, body, expectedCode] of [
        ["wrong installation", { installation_id: installationId + 99, repository_id: primaryRepository.id, ref: "refs/heads/main" }, "github_access_denied"],
        ["ungranted repository", { installation_id: installationId, repository_id: 999999, ref: "refs/heads/main" }, "github_access_denied"],
        ["unlisted branch", { installation_id: installationId, repository_id: primaryRepository.id, ref: "refs/heads/not-granted" }, "github_access_denied"],
        ["arbitrary URL", { installation_id: installationId, repository_id: primaryRepository.id, ref: "https://example.test/repository.git" }, "github_ref_invalid"],
      ]) {
        const rejected = await call(`/v1/projects/${projectId}/github-source`, {
          method: "PUT",
          token: state.owner.token,
          headers: mutationHeaders(`m2-github-reject-${name.replaceAll(" ", "-")}`, bindProjectRevision),
          body,
        });
        assertErrorCode(rejected, 422, expectedCode, name);
      }

      const bindBody = {
        installation_id: installationId,
        repository_id: primaryRepository.id,
        ref: "refs/heads/main",
      };
      const first = await call(`/v1/projects/${projectId}/github-source`, {
        method: "PUT",
        token: state.owner.token,
        headers: mutationHeaders("m2-github-bind-primary", bindProjectRevision),
        body: bindBody,
      });
      binding = assertSource(first, projectId, primaryRepository.id, "refs/heads/main", INITIAL_COMMIT, "initial exact source binding");
      const replay = await call(`/v1/projects/${projectId}/github-source`, {
        method: "PUT",
        token: state.owner.token,
        headers: mutationHeaders("m2-github-bind-primary", bindProjectRevision),
        body: bindBody,
      });
      assertStatus(replay, 200, "binding idempotency replay");
      expectScenario(JSON.stringify(replay.payload) === JSON.stringify(first.payload), "binding replay is stable", {
        stable_binding_replay: false,
      });
      const changedReplay = await call(`/v1/projects/${projectId}/github-source`, {
        method: "PUT",
        token: state.owner.token,
        headers: mutationHeaders("m2-github-bind-primary", bindProjectRevision),
        body: { ...bindBody, repository_id: unboundRepository.id },
      });
      assertErrorShape(changedReplay, 409, "binding key with changed payload");

      const otherRead = await call(`/v1/projects/${projectId}/github-source`, { token: state.other.token });
      assertErrorCode(otherRead, 404, "not_found", "binding owner isolation read");
      const otherWrite = await call(`/v1/projects/${projectId}/github-source`, {
        method: "PUT",
        token: state.other.token,
        headers: mutationHeaders("m2-github-cross-owner-bind", bindProjectRevision),
        body: bindBody,
      });
      assertErrorCode(otherWrite, 404, "not_found", "binding owner isolation write");

      fixtureMethod(fixture, "moveBranch")(primaryRepository.id, "main", MOVED_COMMIT);
      const unchanged = await call(`/v1/projects/${projectId}/github-source`, { token: state.owner.token });
      assertSource(unchanged, projectId, primaryRepository.id, "refs/heads/main", INITIAL_COMMIT, "saved source after provider branch movement");
      const resolved = await call(`/v1/projects/${projectId}/github-source/resolve`, {
        method: "POST",
        token: state.owner.token,
        headers: mutationHeaders("m2-github-resolve-moved-main", binding.revision),
      });
      const moved = assertSource(resolved, projectId, primaryRepository.id, "refs/heads/main", MOVED_COMMIT, "explicit moved-branch candidate");
      expectScenario(moved.source_revision.tree_sha === MOVED_TREE, "moved candidate has its own immutable tree", {
        moved_tree: moved.source_revision.tree_sha,
      });
      binding = moved;

      const project = await call(`/v1/projects/${projectId}`, { token: state.owner.token });
      assertStatus(project, 200, "project revision before optimistic-concurrency probe");
      const renamed = await call(`/v1/projects/${projectId}`, {
        method: "PATCH",
        token: state.owner.token,
        headers: mutationHeaders("m2-github-project-revision-bump", project.payload.project.revision),
        body: { name: "M2 GitHub concurrency project" },
      });
      assertStatus(renamed, 200, "project revision bump");
      const staleRebind = await call(`/v1/projects/${projectId}/github-source`, {
        method: "PUT",
        token: state.owner.token,
        headers: mutationHeaders("m2-github-stale-rebind", project.payload.project.revision),
        body: bindBody,
      });
      assertErrorCode(staleRebind, 412, "stale_revision", "stale optimistic rebind");

      const rows = await sourceRows(postgres, projectId, "m2-github-immutable-source-rows");
      expectScenario(
        rows.some(({ commit, source }) => commit === INITIAL_COMMIT && source === "owner_resolve") &&
          rows.some(({ commit, source }) => commit === MOVED_COMMIT && source === "owner_resolve"),
        "branch movement appends and never mutates source revisions",
        { source_revision_count: rows.length, immutable_commits_present: false },
      );
      return {
        rejected_installation_repository_permission_ref_cases: 5,
        binding_id: binding.binding_id,
        immutable_commits: [INITIAL_COMMIT, MOVED_COMMIT],
        durable_source_revision_count: rows.length,
        idempotent_replay: true,
        changed_payload_rejected: true,
        stale_rebind_rejected: true,
        cross_owner_read_write_rejected: true,
      };
    },
  );

  await githubStep(
    context,
    "M2-GITHUB-03",
    "provider reads use a live token narrowed to one installation, repository and contents-read permission; provider denials and expiry fail closed without changing the exact selection",
    async () => {
      const before = await sourceRows(postgres, projectId, "m2-github-token-before");
      const observationsBefore = fixture.safeObservations().length;
      fixtureMethod(fixture, "expireInstallationTokens")();
      const branches = await call(
        `/v1/github/installations/${installationId}/repositories/${primaryRepository.id}/branches`,
        { token: state.owner.token },
      );
      assertStatus(branches, 200, "expired installation token is replaced once");
      const afterRefreshObservations = fixture.safeObservations().slice(observationsBefore);
      const tokenRequests = afterRefreshObservations.filter(({ path, method }) =>
        method === "POST" && path.includes(`/app/installations/${installationId}/access_tokens`)
      );
      expectScenario(
        tokenRequests.length === 1 &&
          tokenRequests[0].requestedScopes?.repositoryIds?.length === 1 &&
          tokenRequests[0].requestedScopes.repositoryIds[0] === primaryRepository.id &&
          tokenRequests[0].requestedScopes.permissions?.contents === "read" &&
          Object.keys(tokenRequests[0].requestedScopes.permissions).length === 1,
        "replacement token exchange is bounded and contents-read only",
        { replacement_token_requests: tokenRequests.length, scopes: tokenRequests[0]?.requestedScopes ?? {} },
      );

      fixtureMethod(fixture, "expireInstallationTokens")();
      fixtureMethod(fixture, "failNext")("installation_token", "deny");
      const denied = await call(
        `/v1/github/installations/${installationId}/repositories/${primaryRepository.id}/branches`,
        { token: state.owner.token },
      );
      expectScenario(denied.status >= 400 && denied.status < 500, "provider token denial is actionable non-success", {
        provider_denial_status: denied.status,
      });
      fixtureMethod(fixture, "failNext")("repositories", "rate_limit");
      const limited = await call(
        `/v1/github/installations/${installationId}/repositories/${primaryRepository.id}/branches`,
        { token: state.owner.token },
      );
      expectScenario(limited.status >= 400 && limited.status < 600, "provider rate limit is non-success", {
        provider_rate_limit_status: limited.status,
      });
      fixtureMethod(fixture, "failNext")("repositories", "timeout");
      const timedOut = await call(
        `/v1/github/installations/${installationId}/repositories/${primaryRepository.id}/branches`,
        { token: state.owner.token, timeoutMs: 20_000 },
      );
      expectScenario(timedOut.status >= 400 && timedOut.status < 600, "provider timeout is bounded non-success", {
        provider_timeout_status: timedOut.status,
      });

      const after = await sourceRows(postgres, projectId, "m2-github-token-after");
      expectScenario(JSON.stringify(after) === JSON.stringify(before), "provider failures fabricate no source revision", {
        stable_source_revisions: false,
      });
      const observations = fixture.safeObservations();
      assertNoCredentialValue(observations, Object.values(m2.credentials), "provider summaries contain no Hostlet credential");
      expectScenario(
        observations.every((item) => !Object.hasOwn(item, "headers") && !Object.hasOwn(item, "body") && !Object.hasOwn(item, "token")),
        "provider summaries retain no headers, bodies, private source, or tokens",
        { unsafe_observation_fields: true },
      );
      return {
        replacement_token_requests: tokenRequests.length,
        requested_scope: "contents:read",
        selected_repository_id: primaryRepository.id,
        provider_failure_cases: 3,
        fabricated_source_revisions: 0,
        retained_credentials: 0,
      };
    },
  );

  const acceptedDelivery = randomUUID();
  const acceptedPayload = pushPayload(primaryRepository.id, "refs/heads/main", INITIAL_COMMIT, installationId);
  await githubStep(
    context,
    "M2-GITHUB-04",
    "a raw-byte HMAC-authenticated matching push commits one delivery and one exact candidate before 202; identical, concurrent and post-restart redelivery is durably idempotent",
    async () => {
      const before = await githubCounts(postgres, "m2-github-webhook-before");
      const accepted = await deliverWebhook(m2, { deliveryId: acceptedDelivery, payload: acceptedPayload });
      assertStatus(accepted, 202, "signed matching push accepted");
      expectScenario(
        accepted.payload?.status === "accepted" && accepted.payload.delivery_id === acceptedDelivery,
        "accepted webhook response",
        { webhook_status: accepted.payload?.status },
      );
      const committed = await githubCounts(postgres, "m2-github-webhook-committed");
      expectScenario(
        committed.webhook_deliveries === before.webhook_deliveries + 1 &&
          committed.source_revisions === before.source_revisions + 1,
        "202 follows durable delivery and source commit",
        committed,
      );
      const duplicate = await deliverWebhook(m2, { deliveryId: acceptedDelivery, payload: acceptedPayload });
      assertStatus(duplicate, 200, "identical webhook duplicate");
      expectScenario(duplicate.payload?.status === "duplicate", "duplicate is explicitly acknowledged", {
        webhook_status: duplicate.payload?.status,
      });

      const concurrentDelivery = randomUUID();
      const concurrent = await Promise.all([
        deliverWebhook(m2, { deliveryId: concurrentDelivery, payload: acceptedPayload }),
        deliverWebhook(m2, { deliveryId: concurrentDelivery, payload: acceptedPayload }),
      ]);
      expectScenario(
        concurrent.map(({ status }) => status).sort().join(",") === "200,202",
        "concurrent duplicate has one acceptance and one duplicate acknowledgement",
        { statuses: concurrent.map(({ status }) => status) },
      );
      const beforeRestart = await githubCounts(postgres, "m2-github-webhook-before-restart");
      await switchApi(currentApiBinary, "M2 webhook durable replay restart");
      const afterRestartReplay = await deliverWebhook(m2, { deliveryId: acceptedDelivery, payload: acceptedPayload });
      assertStatus(afterRestartReplay, 200, "post-restart duplicate acknowledgement");
      const afterRestart = await githubCounts(postgres, "m2-github-webhook-after-restart");
      expectScenario(
        afterRestart.webhook_deliveries === beforeRestart.webhook_deliveries &&
          afterRestart.source_revisions === beforeRestart.source_revisions,
        "restart preserves replay protection without duplicate effects",
        afterRestart,
      );
      return {
        accepted_status: accepted.status,
        duplicate_status: duplicate.status,
        concurrent_statuses: concurrent.map(({ status }) => status).sort(),
        durable_delivery_delta: afterRestart.webhook_deliveries - before.webhook_deliveries,
        durable_candidate_delta: afterRestart.source_revisions - before.source_revisions,
        post_restart_duplicate_effects: 0,
      };
    },
  );

  await githubStep(
    context,
    "M2-GITHUB-05",
    "invalid raw signatures and semantically unauthorized events fail with stable safe reasons; conflicting delivery IDs, wrong branches, unbound repositories, disabled bindings and revocation create no candidate or job",
    async () => {
      const before = await githubCounts(postgres, "m2-github-rejection-before");
      const raw = JSON.stringify(acceptedPayload);
      const missingSignature = await call("/v1/github/webhooks", {
        method: "POST",
        rawBody: raw,
        headers: { "X-GitHub-Delivery": randomUUID(), "X-GitHub-Event": "push", "Content-Type": "application/json" },
      });
      assertErrorCode(missingSignature, 401, "github_signature_invalid", "missing webhook signature");
      const invalidSignature = await call("/v1/github/webhooks", {
        method: "POST",
        rawBody: raw,
        headers: {
          "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
          "X-GitHub-Delivery": randomUUID(),
          "X-GitHub-Event": "push",
          "Content-Type": "application/json",
        },
      });
      assertErrorCode(invalidSignature, 401, "github_signature_invalid", "invalid webhook signature");
      const malformedSignature = await call("/v1/github/webhooks", {
        method: "POST",
        rawBody: raw,
        headers: {
          "X-Hub-Signature-256": "sha256=not-a-digest",
          "X-GitHub-Delivery": randomUUID(),
          "X-GitHub-Event": "push",
          "Content-Type": "application/json",
        },
      });
      assertErrorCode(malformedSignature, 401, "github_signature_invalid", "malformed webhook signature");
      const differentBytes = await deliverWebhook(m2, {
        payload: acceptedPayload,
        signatureBody: `${raw}\n`,
      });
      assertErrorCode(differentBytes, 401, "github_signature_invalid", "signature over different raw bytes");

      const wrongBranch = await deliverWebhook(m2, {
        payload: pushPayload(primaryRepository.id, "refs/heads/not-authorized", MOVED_COMMIT, installationId),
      });
      assertErrorCode(wrongBranch, 422, "github_push_rejected", "signed wrong-branch push");
      const unbound = await deliverWebhook(m2, {
        payload: pushPayload(unboundRepository.id, "refs/heads/main", unboundRepository.branches.main, installationId),
      });
      assertErrorCode(unbound, 422, "github_push_rejected", "signed granted but unbound repository push");

      const secondaryConfiguration = JSON.parse(
        readFileSync(join(context.repo, "contracts", "v1", "projects", "valid-standard.json"), "utf8"),
      );
      const secondaryProject = await call("/v1/projects", {
        method: "POST",
        token: state.owner.token,
        headers: { "Idempotency-Key": "m2-github-disabled-binding-project" },
        body: { name: "M2 disabled GitHub binding", configuration: secondaryConfiguration },
      });
      assertStatus(secondaryProject, 201, "secondary project for disabled-binding rejection");
      const secondaryProjectId = secondaryProject.payload.project.id;
      const secondaryBindingResponse = await call(`/v1/projects/${secondaryProjectId}/github-source`, {
        method: "PUT",
        token: state.owner.token,
        headers: mutationHeaders(
          "m2-github-bind-secondary",
          secondaryProject.payload.project.revision,
        ),
        body: {
          installation_id: installationId,
          repository_id: unboundRepository.id,
          ref: "refs/heads/main",
        },
      });
      const secondaryBinding = assertSource(
        secondaryBindingResponse,
        secondaryProjectId,
        unboundRepository.id,
        "refs/heads/main",
        unboundRepository.branches.main,
        "secondary binding before owner deletion",
      );
      const disabled = await call(`/v1/projects/${secondaryProjectId}/github-source`, {
        method: "DELETE",
        token: state.owner.token,
        headers: { "If-Match": `"${secondaryBinding.revision}"` },
      });
      assertStatus(disabled, 204, "owner disables secondary source binding");
      const disabledBinding = await latestBinding(postgres, secondaryProjectId, "m2-github-disabled-binding");
      expectScenario(disabledBinding.status === "disabled", "deleted binding is durably disabled", disabledBinding);
      const disabledPush = await deliverWebhook(m2, {
        payload: pushPayload(unboundRepository.id, "refs/heads/main", unboundRepository.branches.main, installationId),
      });
      assertErrorCode(disabledPush, 422, "github_push_rejected", "push after binding deletion");

      const unsupported = await deliverWebhook(m2, {
        event: "issues",
        payload: { action: "opened", installation: { id: installationId }, repository: { id: primaryRepository.id } },
      });
      assertErrorCode(unsupported, 422, "github_event_unsupported", "signed unsupported event");
      const conflict = await deliverWebhook(m2, {
        deliveryId: acceptedDelivery,
        payload: { ...acceptedPayload, after: MOVED_COMMIT },
      });
      assertErrorCode(conflict, 409, "github_delivery_conflict", "delivery ID with changed payload");

      const suspended = await deliverWebhook(m2, {
        event: "installation",
        payload: { action: "suspend", installation: { id: installationId } },
      });
      assertStatus(suspended, 202, "signed installation suspension");
      const suspendedBinding = await latestBinding(postgres, projectId, "m2-github-suspended-binding");
      expectScenario(
        suspendedBinding.id === binding.binding_id && suspendedBinding.status === "installation_suspended",
        "suspension durably denies the active binding",
        suspendedBinding,
      );
      const revokedPush = await deliverWebhook(m2, {
        payload: pushPayload(primaryRepository.id, "refs/heads/main", MOVED_COMMIT, installationId),
      });
      assertErrorCode(revokedPush, 422, "github_push_rejected", "push after installation suspension");

      const unsuspended = await deliverWebhook(m2, {
        event: "installation",
        payload: { action: "unsuspend", installation: { id: installationId } },
      });
      assertStatus(unsuspended, 202, "signed installation unsuspension");
      const revalidationBinding = await bindingById(
        postgres,
        binding.binding_id,
        "m2-github-unsuspended-binding",
      );
      expectScenario(
        revalidationBinding.status === "revalidation_required" &&
          revalidationBinding.revision === suspendedBinding.revision + 1,
        "unsuspension requires explicit binding revalidation",
        revalidationBinding,
      );

      const discoveredInstallations = await call("/v1/github/installations", { token: state.owner.token });
      assertStatus(discoveredInstallations, 200, "installation discovery after unsuspension");
      const discoveredRepositories = await call(`/v1/github/installations/${installationId}/repositories`, {
        token: state.owner.token,
      });
      assertStatus(discoveredRepositories, 200, "repository discovery after unsuspension");
      const afterDiscovery = await bindingById(
        postgres,
        binding.binding_id,
        "m2-github-discovery-does-not-reactivate",
      );
      expectScenario(
        afterDiscovery.status === "revalidation_required" &&
          afterDiscovery.revision === revalidationBinding.revision,
        "discovery alone cannot reactivate a denied binding",
        afterDiscovery,
      );
      const deniedSource = await call(`/v1/projects/${projectId}/github-source`, {
        token: state.owner.token,
      });
      assertStatus(deniedSource, 200, "owner reads denied source after discovery");
      expectScenario(
        deniedSource.payload.binding_id === binding.binding_id &&
          deniedSource.payload.status === "revalidation_required",
        "public source status remains denied until an explicit bind",
        {
          binding_id_match: deniedSource.payload.binding_id === binding.binding_id,
          binding_status: deniedSource.payload.status,
        },
      );

      const projectForFreshBind = await call(`/v1/projects/${projectId}`, { token: state.owner.token });
      assertStatus(projectForFreshBind, 200, "project revision before explicit source rebind");
      const freshBindResponse = await call(`/v1/projects/${projectId}/github-source`, {
        method: "PUT",
        token: state.owner.token,
        headers: mutationHeaders(
          "m2-github-explicit-rebind-after-unsuspend",
          projectForFreshBind.payload.project.revision,
        ),
        body: {
          installation_id: installationId,
          repository_id: primaryRepository.id,
          ref: "refs/heads/main",
        },
      });
      const freshBinding = assertSource(
        freshBindResponse,
        projectId,
        primaryRepository.id,
        "refs/heads/main",
        MOVED_COMMIT,
        "explicit rebind after unsuspension",
      );
      expectScenario(
        freshBinding.binding_id !== binding.binding_id && freshBinding.revision === 1,
        "fresh bind creates a new active selection while preserving denied history",
        {
          distinct_binding: freshBinding.binding_id !== binding.binding_id,
          fresh_binding_revision: freshBinding.revision,
        },
      );
      const preservedDeniedBinding = await bindingById(
        postgres,
        binding.binding_id,
        "m2-github-preserved-denied-binding",
      );
      expectScenario(
        preservedDeniedBinding.status === "revalidation_required" &&
          preservedDeniedBinding.revision === revalidationBinding.revision,
        "fresh bind preserves the denied historical binding",
        preservedDeniedBinding,
      );

      const authorizationRevoked = await deliverWebhook(m2, {
        event: "github_app_authorization",
        payload: { action: "revoked", sender: { id: manifest.owner.id } },
      });
      assertStatus(authorizationRevoked, 202, "signed user authorization revocation");
      const connection = await call("/v1/github/connection", { token: state.owner.token });
      assertStatus(connection, 200, "revoked connection remains safely inspectable");
      expectScenario(connection.payload.status === "revoked", "authorization revocation is durable", {
        connection_status: connection.payload.status,
      });
      const revokedBinding = await latestBinding(postgres, projectId, "m2-github-revoked-binding");
      expectScenario(
        revokedBinding.id === freshBinding.binding_id && revokedBinding.status === "user_revalidation_required",
        "authorization revocation durably denies the binding",
        revokedBinding,
      );
      state.github = Object.freeze({
        projectId,
        repositoryRecordId,
        historicalBindingId: binding.binding_id,
        currentBindingId: freshBinding.binding_id,
        currentBindingStatus: revokedBinding.status,
        sourceRevisionId: freshBinding.source_revision.id,
        sourceCommit: freshBinding.source_revision.resolved_commit,
        configurationRevisionId: freshBinding.source_revision.configuration_revision_id,
      });

      const after = await githubCounts(postgres, "m2-github-rejection-after");
      expectScenario(
        after.jobs === before.jobs &&
          after.deployments === before.deployments &&
          after.hosted_slots === before.hosted_slots &&
          after.hosting_events === before.hosting_events &&
          after.lifecycle_intents === before.lifecycle_intents,
        "GitHub source and webhook handling creates no execution, deployment, slot, or job",
        after,
      );
      const finalRows = await sourceRows(postgres, projectId, "m2-github-final-source-rows");
      expectScenario(
        finalRows.every(({ commit }) => commit === INITIAL_COMMIT || commit === MOVED_COMMIT),
        "rejection matrix fabricates no source commit",
        { source_revision_count: finalRows.length, unexpected_source_commits: true },
      );
      const observations = fixture.safeObservations();
      assertNoCredentialValue(observations, Object.values(m2.credentials), "final provider evidence contains no credential");
      assertNoCredentialValue(
        observations,
        [fixture.controls.webhookSecret()],
        "final provider evidence contains no webhook secret",
      );
      fixture.controls.assertNoUnexpectedRequests();
      context.state.productOutputs.m2GitHubProvider = {
        boundary: "owned synthetic loopback GitHub HTTP provider",
        requestCount: observations.length,
        requests: observations,
        retainedCredentials: 0,
        retainedPrivateSourceBodies: 0,
      };
      fixture.controls.setGrant({
        installationId,
        repositoryIds: manifest.repositories.map(({ id }) => id),
        contentsPermission: "read",
        suspended: false,
      });
      state.restoreReadChecks.push({
        name: "GitHub immutable source and disabled binding",
        run: async (restored) => {
          const restoredSources = await sourceRows(
            restored.postgres,
            projectId,
            "m2-restored-github-sources",
            restored.postgres.recoveryDatabaseName,
          );
          expectScenario(
            restoredSources.some(({ binding_id: restoredBindingId, commit, source }) =>
              restoredBindingId === binding.binding_id && commit === INITIAL_COMMIT && source === "owner_resolve"
            ) &&
              restoredSources.some(({ binding_id: restoredBindingId, commit, source }) =>
                restoredBindingId === binding.binding_id && commit === MOVED_COMMIT && source === "owner_resolve"
              ),
            "restored GitHub source retains both immutable owner-resolved commits",
            {
              restored_source_revision_count: restoredSources.length,
              immutable_owner_commits_present: false,
            },
          );
          const restoredDisabled = await latestBinding(
            restored.postgres,
            secondaryProjectId,
            "m2-restored-disabled-github-binding",
            restored.postgres.recoveryDatabaseName,
          );
          expectScenario(
            restoredDisabled.id === disabledBinding.id && restoredDisabled.status === "disabled",
            "restored owner-disabled binding stays disabled",
            restoredDisabled,
          );
        },
      });
      return {
        raw_signature_rejections: 4,
        semantic_rejections: 5,
        changed_delivery_rejected: true,
        suspended_binding_status: suspendedBinding.status,
        unsuspended_binding_status: revalidationBinding.status,
        discovery_reactivated_bindings: 0,
        fresh_rebind_status: freshBinding.status,
        final_binding_status: disabledBinding.status,
        revoked_connection_status: connection.payload.status,
        jobs_created: after.jobs - before.jobs,
        deployments_created: after.deployments - before.deployments,
        hosted_slots_created: after.hosted_slots - before.hosted_slots,
        retained_credentials: 0,
        retained_private_source_bodies: 0,
      };
    },
  );
}
