import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

export const M3_UPGRADE_REQUIRED_ASSERTIONS = Object.freeze([
  "M3-UPGRADE-01",
  "M3-UPGRADE-02",
]);

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function upgradeStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M3 populated schema-5 upgrade and retained M2 compatibility", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M3 populated schema-5 upgrade and retained M2 compatibility",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError ? error.check : "upgrade process or persistence boundary failed",
    );
    throw error;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mismatchKeys(left, right) {
  return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])]
    .filter((key) => !isDeepStrictEqual(left?.[key], right?.[key]))
    .sort();
}

function adaptPortfolioDraft(rawDraft, hostedProjectId) {
  const draft = clone(rawDraft);
  for (const project of draft.projects) {
    if (project.kind.type === "hosted_project") project.kind.project_id = hostedProjectId;
    project.authorized_deployment_facts_id = null;
    project.displayed_status = {
      deployment_timestamp: false,
      availability: false,
      release_identifier: false,
      source_commit: false,
      demo_readiness: false,
    };
    project.demo_readiness = {
      state: "needs_recheck",
      previous_attestation: null,
      reason: "never_checked",
    };
  }
  return draft;
}

export function registerM3UpgradeFixtures(context) {
  context.registerFixture("M3 upgrade scenario module", "e2e/scenarios/m3-upgrade.mjs");
  context.registerFixture("M3 upgrade acceptance inventory", "docs/M3-SCENARIOS.md");
  context.registerFixture("M3 retained M2 project population contract", "contracts/v1/projects/valid-standard.json");
  context.registerFixture("M3 retained M2 portfolio population contract", "contracts/v1/portfolio/draft-valid.json");
  return Object.freeze({
    schema_version: 1,
    source_schema_version: 5,
    target_migration: 6,
    target_minimum_reader_version: 5,
  });
}

async function readDurableState(postgres, label, databaseName = null) {
  const query = (suffix, sql) => databaseName
    ? postgres.psqlJsonDatabase(`${label}-${suffix}`, databaseName, sql)
    : postgres.psqlJson(`${label}-${suffix}`, sql);
  const relationNames = await query(
    "relations",
    `SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]'::json)
       FROM pg_catalog.pg_tables
      WHERE schemaname='public' AND tablename <> '_sqlx_migrations';`,
  );
  expectScenario(
    Array.isArray(relationNames) && relationNames.every((name) => /^[a-z][a-z0-9_]*$/.test(name)),
    `${label}: safe public relation names`,
    { relation_name_count: Array.isArray(relationNames) ? relationNames.length : null },
  );
  const countRows = relationNames
    .map((name) => `('${name}',(SELECT COUNT(*)::bigint FROM public."${name}"))`)
    .join(",");
  const hashRows = relationNames
    .map((name) => `('${name}',(
      SELECT encode(sha256(convert_to(
        COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,
        'UTF8'
      )),'hex') FROM public."${name}" t
    ))`)
    .join(",");
  const idRelations = await query(
    "id-relations",
    `SELECT COALESCE(json_agg(table_name ORDER BY table_name),'[]'::json)
       FROM information_schema.columns
      WHERE table_schema='public' AND column_name='id';`,
  );
  const relationIds = {};
  for (const name of idRelations) {
    expectScenario(/^[a-z][a-z0-9_]*$/.test(name), `${label}: safe ID relation name`, { name });
    relationIds[name] = await query(
      `ids-${name}`,
      `SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM public."${name}";`,
    );
  }
  const durable = await query(
    "state",
    `SELECT json_build_object(
       'database_identity', (SELECT id::text FROM database_identity WHERE singleton=true),
       'schema_version', (SELECT current_version::int FROM platform_schema_compatibility WHERE singleton=true),
       'minimum_reader_version', (SELECT min_reader_version::int FROM platform_schema_compatibility WHERE singleton=true),
       'migration_ledger_hash', (
         SELECT encode(sha256(convert_to(
           COALESCE(jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text),'[]'::jsonb)::text,
           'UTF8'
         )),'hex') FROM public._sqlx_migrations m
       ),
       'relation_counts', (
         SELECT COALESCE(json_object_agg(name,n ORDER BY name),'{}'::json)
           FROM (VALUES ${countRows}) AS counts(name,n)
       ),
       'relation_hashes', (
         SELECT COALESCE(json_object_agg(name,digest ORDER BY name),'{}'::json)
           FROM (VALUES ${hashRows}) AS hashes(name,digest)
       ),
       'account_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM accounts),
       'project_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM projects),
       'configuration_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM configuration_revisions),
       'service_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM services),
       'portfolio_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM portfolio_draft_revisions),
       'secret_version_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM secret_versions),
       'job_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM jobs),
       'account_values', (SELECT COALESCE(json_agg(json_build_object('id',id::text,'email',email,'display_name',display_name,'revision',revision) ORDER BY id::text),'[]'::json) FROM accounts),
       'project_values', (SELECT COALESCE(json_agg(json_build_object('id',id::text,'account_id',account_id::text,'name',name,'mode',mode,'hosted_slots',hosted_slots,'slot_state',slot_state,'revision',revision) ORDER BY id::text),'[]'::json) FROM projects),
       'deployment_values', (SELECT COALESCE(json_agg(json_build_object('id',id::text,'project_id',project_id::text,'configuration_revision_id',configuration_revision_id::text,'source_commit',source_commit,'lifecycle',lifecycle) ORDER BY id::text),'[]'::json) FROM deployments),
       'admission_values', (SELECT COALESCE(json_agg(json_build_object('id',id::text,'project_id',project_id::text,'state',state,'reservation_epoch',reservation_epoch::text) ORDER BY id::text),'[]'::json) FROM slot_reservations),
       'preview_values', (SELECT COALESCE(json_agg(json_build_object('portfolio_revision_id',portfolio_revision_id::text,'account_id',account_id::text,'layout',layout,'typography',typography,'accent',accent) ORDER BY portfolio_revision_id::text),'[]'::json) FROM portfolio_preview_contexts),
       'relation_owners', (SELECT COALESCE(json_agg(json_build_object('table',tablename,'owner',tableowner) ORDER BY tablename),'[]'::json) FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename <> '_sqlx_migrations'),
       'foreign_key_count', (SELECT COUNT(*)::int FROM pg_catalog.pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace),
       'unvalidated_foreign_keys', (SELECT COUNT(*)::int FROM pg_catalog.pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace AND NOT convalidated),
       'relationship_violations', (
         (SELECT COUNT(*) FROM configuration_revisions c LEFT JOIN projects p ON p.id=c.project_id AND p.account_id=c.account_id WHERE p.id IS NULL) +
         (SELECT COUNT(*) FROM service_configurations sc LEFT JOIN services s ON s.id=sc.service_id AND s.account_id=sc.account_id AND s.project_id=sc.project_id WHERE s.id IS NULL) +
         (SELECT COUNT(*) FROM secret_versions v LEFT JOIN secrets s ON s.id=v.secret_id AND s.account_id=v.account_id AND s.project_id=v.project_id AND s.service_id=v.service_id WHERE s.id IS NULL) +
         (SELECT COUNT(*) FROM job_secret_refs r LEFT JOIN jobs j ON j.id=r.job_id AND j.account_id=r.account_id AND j.project_id=r.project_id WHERE j.id IS NULL) +
         (SELECT COUNT(*) FROM admission_source_proofs p LEFT JOIN deployments d ON d.id=p.deployment_id AND d.project_id=p.project_id AND d.account_id=p.account_id WHERE d.id IS NULL) +
         (SELECT COUNT(*) FROM slot_reservations r LEFT JOIN projects p ON p.id=r.project_id AND p.account_id=r.account_id WHERE p.id IS NULL) +
         (SELECT COUNT(*) FROM github_source_revisions r LEFT JOIN github_repository_bindings b ON b.id=r.binding_id AND b.project_id=r.project_id AND b.account_id=r.account_id WHERE b.id IS NULL) +
         (SELECT COUNT(*) FROM compatibility_reports r LEFT JOIN github_source_revisions s ON s.id=r.source_revision_id AND s.project_id=r.project_id AND s.account_id=r.account_id WHERE s.id IS NULL) +
         (SELECT COUNT(*) FROM portfolio_preview_contexts c LEFT JOIN portfolio_draft_revisions d ON d.id=c.portfolio_revision_id AND d.account_id=c.account_id WHERE d.id IS NULL)
       )::int
     );`,
  );
  durable.relation_ids = relationIds;
  return durable;
}

async function populateRetainedM2(context, m3) {
  const { call, callInternal, credentials, state } = m3;
  const accountFixtures = [
    { email: "owner@m3-upgrade.hostlet.test", display_name: "M3 Upgrade Owner", password: credentials.ownerPassword },
    { email: "other@m3-upgrade.hostlet.test", display_name: "M3 Upgrade Other", password: credentials.otherPassword },
  ];
  const accounts = [];
  for (const fixture of accountFixtures) {
    const created = await call("/v1/accounts", { method: "POST", body: fixture });
    assertStatus(created, 201, `schema-5 account ${fixture.email}`);
    const session = await call("/v1/sessions", {
      method: "POST",
      body: { email: fixture.email, password: fixture.password },
    });
    assertStatus(session, 201, `schema-5 session ${fixture.email}`);
    context.registerSensitiveValues([session.payload.token]);
    accounts.push({ record: created.payload, token: session.payload.token });
  }
  [state.owner, state.other] = accounts;

  // Seed through retained M2 with the exact owned fullstack configuration that
  // the M3 build stage will later admit.  The generic contract example omits
  // the application's output directory and is therefore not a buildable graph.
  const configuration = clone(m3.fixtureCatalog.standardProjectConfiguration);
  const project = await call("/v1/projects", {
    method: "POST",
    token: state.owner.token,
    headers: { "Idempotency-Key": "m3-upgrade-schema5-project" },
    body: { name: "M3 populated schema-5 project", configuration },
  });
  assertStatus(project, 201, "schema-5 project graph population");
  state.graph = project.payload;
  const application = state.graph.services.find(({ configuration: value }) => value.kind === "application");
  expectScenario(Boolean(application), "schema-5 application service exists", { application_service: false });
  const sourceCommit = "5555555555555555555555555555555555555555";
  const deployment = await call(`/v1/projects/${state.graph.project.id}/deployment-intents`, {
    method: "POST",
    token: state.owner.token,
    headers: {
      "Idempotency-Key": "m3-upgrade-schema5-deployment",
      "If-Match": `"${state.graph.project.revision}"`,
    },
    body: { configuration_revision_id: state.graph.configuration.id, source_commit: sourceCommit },
  });
  assertStatus(deployment, 201, "schema-5 deployment intent population");
  state.graph = (await call(`/v1/projects/${state.graph.project.id}`, { token: state.owner.token })).payload;

  const draft = adaptPortfolioDraft(
    JSON.parse(readFileSync(join(context.repo, "contracts/v1/portfolio/draft-valid.json"), "utf8")),
    state.graph.project.id,
  );
  const portfolio = await call("/v1/portfolio/draft-revisions", {
    method: "POST",
    token: state.owner.token,
    headers: { "Idempotency-Key": "m3-upgrade-schema5-portfolio" },
    body: { draft },
  });
  assertStatus(portfolio, 201, "schema-5 portfolio population");

  const secret = await call(`/v1/projects/${state.graph.project.id}/services/${application.id}/secrets`, {
    method: "POST",
    token: state.owner.token,
    headers: { "Idempotency-Key": "m3-upgrade-schema5-secret" },
    body: { name: "m3-upgrade-source-read", operation: "build", credential_kind: "source_repository_read" },
  });
  assertStatus(secret, 201, "schema-5 secret metadata population");
  const secretValue = `m3-upgrade-secret-${context.state.runId}`;
  context.registerSensitiveValues([secretValue]);
  const version = await call(
    `/v1/projects/${state.graph.project.id}/services/${application.id}/secrets/${secret.payload.id}/versions`,
    {
      method: "POST",
      token: state.owner.token,
      headers: {
        "Idempotency-Key": "m3-upgrade-schema5-secret-version",
        "If-Match": `"${secret.payload.revision}"`,
      },
      body: { value: secretValue },
    },
  );
  assertStatus(version, 201, "schema-5 secret version population");
  const job = await call(`/v1/projects/${state.graph.project.id}/jobs`, {
    method: "POST",
    token: state.owner.token,
    headers: { "Idempotency-Key": "m3-upgrade-schema5-job" },
    body: {
      kind: "foundation_bookkeeping",
      operation: "build",
      service_id: application.id,
      source_commit: sourceCommit,
      secret_version_refs: [{ service_id: application.id, secret_version_id: version.payload.id }],
    },
  });
  assertStatus(job, 201, "schema-5 job population");
  const lease = await callInternal("/internal/v1/jobs/lease", {
    method: "POST",
    body: { worker_id: "m3-upgrade-worker", kinds: ["foundation_bookkeeping"] },
  });
  assertStatus(lease, 200, "schema-5 job lease population");
  const completed = await callInternal(`/internal/v1/jobs/${job.payload.id}/complete`, {
    method: "POST",
    body: {
      worker_id: "m3-upgrade-worker",
      attempt_id: lease.payload.attempt.id,
      fence: lease.payload.attempt.fence,
      outcome: { state: "succeeded", code: "bookkeeping_complete" },
    },
  });
  assertStatus(completed, 200, "schema-5 job completion population");
  state.jobs = { job: completed.payload.job, secret: secret.payload, secretVersion: version.payload };

  const periodStart = new Date(Date.now() - 86_400_000).toISOString();
  const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const poolKey = "m3-upgrade-pool";
  const capacity = await callInternal("/internal/v1/admission/capacity", {
    method: "POST",
    body: {
      event_id: randomUUID(), pool_key: poolKey, profile: "m3-upgrade-standard",
      hosted_slot_limit: 2, rollout_headroom_limit: 1,
    },
  });
  assertStatus(capacity, 200, "schema-5 admission capacity population");
  const entitlement = await callInternal("/internal/v1/admission/entitlements", {
    method: "POST",
    body: {
      event_id: randomUUID(), account_id: state.owner.record.id, capacity_pool_key: poolKey,
      hosted_slot_limit: 1, build_seconds_limit: 600, period_starts_at: periodStart,
      period_ends_at: periodEnd, state: "active",
    },
  });
  assertStatus(entitlement, 200, "schema-5 admission entitlement population");
  const proofResponse = await callInternal("/internal/v1/admission/source-proofs", {
    method: "POST",
    body: {
      event_id: randomUUID(), account_id: state.owner.record.id, project_id: state.graph.project.id,
      deployment_id: deployment.payload.id, configuration_revision_id: deployment.payload.configuration_revision_id,
      source_commit: sourceCommit, inventory_revision: 1,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    },
  });
  assertStatus(proofResponse, 200, "schema-5 exact-source admission proof population");
  const proof = proofResponse.payload?.proof ?? proofResponse.payload;
  const hold = await call(
    `/v1/projects/${state.graph.project.id}/deployments/${deployment.payload.id}/capacity-holds`,
    {
      method: "POST", token: state.owner.token,
      headers: { "Idempotency-Key": "m3-upgrade-schema5-hold", "If-Match": `"${state.graph.project.revision}"` },
      body: { source_proof_id: proof.id, ttl_seconds: 120 },
    },
  );
  assertStatus(hold, 201, "schema-5 capacity hold population");
  const admission = await call(
    `/v1/projects/${state.graph.project.id}/deployments/${deployment.payload.id}/admissions`,
    {
      method: "POST", token: state.owner.token,
      headers: { "Idempotency-Key": "m3-upgrade-schema5-admission", "If-Match": `"${state.graph.project.revision}"` },
      body: { capacity_hold_id: hold.payload.hold.id },
    },
  );
  assertStatus(admission, 201, "schema-5 reservation population");

  const inherited = await call("/v1/portfolio/draft-revisions/latest", { token: state.owner.token });
  assertStatus(inherited, 200, "schema-5 inherited preview population base");
  const previewDraft = clone(inherited.payload.draft);
  previewDraft.profile.display_name = "M3 Upgrade Preview Owner";
  previewDraft.profile.headline = "Retained M2 private preview state";
  previewDraft.projects = [];
  const preview = await call("/v1/portfolio/preview-revisions", {
    method: "POST",
    token: state.other.token,
    headers: { "Idempotency-Key": "m3-upgrade-schema5-preview", "If-Match": '"0"' },
    body: {
      draft: previewDraft,
      preview: { layout: "layout_1", typography: "editorial_serif", accent: "indigo", project_contexts: [] },
    },
  });
  assertStatus(preview, 201, "schema-5 private preview population");
  state.m3UpgradeSeed = {
    deployment: deployment.payload,
    admission: admission.payload,
    preview: preview.payload,
    sourceCommit,
  };
  return state.m3UpgradeSeed;
}

async function populateSelectedSourcePreview(context, m3, selectedSource) {
  const required = ["projectId", "configurationRevisionId", "sourceRevisionId", "compatibilityReportId"];
  expectScenario(
    selectedSource && selectedSource.status === "candidate" &&
      required.every((name) => typeof selectedSource[name] === "string" && selectedSource[name].length > 0),
    "selected-source hook returns the exact preview relationship identifiers",
    { required_identifiers: required, required_status: "candidate", selected_source_shape_valid: false },
  );
  const draft = adaptPortfolioDraft(
    JSON.parse(readFileSync(join(context.repo, "contracts/v1/portfolio/draft-valid.json"), "utf8")),
    selectedSource.projectId,
  );
  draft.profile.headline = "Selected retained M2 source preview";
  const project = draft.projects.find(({ kind }) => kind.type === "hosted_project");
  expectScenario(Boolean(project), "selected-source preview contract has a hosted project", {
    hosted_project_present: false,
  });
  const latest = await m3.call("/v1/portfolio/draft-revisions/latest", { token: m3.state.owner.token });
  assertStatus(latest, 200, "selected-source preview base revision");
  const preview = await m3.call("/v1/portfolio/preview-revisions", {
    method: "POST",
    token: m3.state.owner.token,
    headers: {
      "Idempotency-Key": "m3-upgrade-schema5-selected-preview",
      "If-Match": `"${latest.payload.revision}"`,
    },
    body: {
      draft,
      preview: {
        layout: "layout_1",
        typography: "system_sans",
        accent: "forest",
        project_contexts: [{
          project_reference_id: project.project_reference_id,
          project_id: selectedSource.projectId,
          configuration_revision_id: selectedSource.configurationRevisionId,
          source_revision_id: selectedSource.sourceRevisionId,
          compatibility_report_id: selectedSource.compatibilityReportId,
          placeholder: "gradient_1",
          configuration_answers: [],
        }],
      },
    },
  });
  assertStatus(preview, 201, "schema-5 selected-source private preview population");
  return preview.payload;
}

function stablePreUpgradeState(state) {
  const relationCounts = { ...state.relation_counts };
  const relationHashes = { ...state.relation_hashes };
  delete relationCounts.platform_schema_compatibility;
  delete relationCounts.platform_backup_receipts;
  delete relationHashes.platform_schema_compatibility;
  delete relationHashes.platform_backup_receipts;
  return {
    database_identity: state.database_identity,
    account_ids: state.account_ids,
    project_ids: state.project_ids,
    configuration_ids: state.configuration_ids,
    service_ids: state.service_ids,
    portfolio_ids: state.portfolio_ids,
    secret_version_ids: state.secret_version_ids,
    job_ids: state.job_ids,
    account_values: state.account_values,
    project_values: state.project_values,
    deployment_values: state.deployment_values,
    admission_values: state.admission_values,
    preview_values: state.preview_values,
    relation_counts: relationCounts,
    relation_hashes: relationHashes,
    relation_ids: state.relation_ids,
    relation_owners: state.relation_owners,
  };
}

function hashesWithout(state, excluded) {
  const hashes = { ...state.relation_hashes };
  for (const name of excluded) delete hashes[name];
  return hashes;
}

export async function runM3UpgradeScenarios(
  context,
  m3,
  {
    prepareRetainedM2 = async () => {},
    seedSelectedSource = null,
    runPostUpgrade = async () => {},
  } = {},
) {
  const {
    postgres, fixtures, currentApiBinary, retainedM2Binary,
    call, switchApi, environmentForProbe, state,
  } = m3;
  const manifest = fixtures.upgradeManifest;
  expectScenario(
    manifest.source_schema_version === 5 &&
      manifest.target_migration === 6 &&
      manifest.target_minimum_reader_version === 5,
    "M3 upgrade harness version contract",
    manifest,
  );
  expectScenario(typeof seedSelectedSource === "function", "M3 retained selected-source population hook is configured", {
    selected_source_hook_present: false,
  });
  const repository = join(context.tempDir, "m3-upgrade-backups");
  const wrongRepository = join(context.tempDir, "m3-upgrade-wrong-target-backups");
  const finalRepository = join(context.tempDir, "m3-populated-schema6-backup");
  for (const path of [repository, wrongRepository, finalRepository]) mkdirSync(path, { recursive: true, mode: 0o700 });
  let cliSequence = 0;
  const runCli = async (
    label,
    args,
    { binary = currentApiBinary, expectedErrorCode, environmentOverrides = {}, removeEnvironment = [] } = {},
  ) => {
    cliSequence += 1;
    const result = await context.runCommand(`M3 upgrade ${label}`, binary, args, {
      env: environmentForProbe(environmentOverrides, removeEnvironment),
      timeoutMs: 150_000,
      logName: `m3-upgrade-${String(cliSequence).padStart(2, "0")}-${label}.log`,
    });
    if (expectedErrorCode) {
      expectScenario(
        result.code !== 0 && result.stderr.includes(`migration failed: ${expectedErrorCode}`),
        `${label}: exact safe migration failure`,
        { exit_status: result.code, expected_error_code: expectedErrorCode },
      );
      return null;
    }
    expectScenario(result.code === 0, `${label}: command succeeds`, { exit_status: result.code });
    if (!result.stdout.trim()) return null;
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new ScenarioExpectationError(`${label}: JSON receipt`, { parsed_json: false });
    }
  };

  await upgradeStep(
    context,
    "M3-UPGRADE-01",
    "a meaningful schema-5 M2 database with selected source, compatibility, admission, preview, jobs, and scoped secrets refuses absent and wrong-target evidence before one verified additive schema-6 migration preserves values, IDs, ownership, counts, and relationships",
    async () => {
      const emptyName = `hostlet_m3_init_${context.state.runId.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(-28)}`;
      await postgres.createDatabase(emptyName);
      let currentInit;
      try {
        await runCli("initialize-empty-schema6", ["migrate"], {
          environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(emptyName) },
        });
        currentInit = await postgres.psqlJsonDatabase(
          "m3-current-empty-initialization",
          emptyName,
          `SELECT json_build_object(
             'schema_version',(SELECT current_version::int FROM platform_schema_compatibility WHERE singleton=true),
             'minimum_reader_version',(SELECT min_reader_version::int FROM platform_schema_compatibility WHERE singleton=true),
             'ledger_versions',(SELECT json_agg(version::int ORDER BY version) FROM _sqlx_migrations),
             'ledger_rows',(SELECT COUNT(*)::int FROM _sqlx_migrations)
           );`,
        );
        expectScenario(
          currentInit.schema_version === 6 && currentInit.minimum_reader_version === 5 &&
            currentInit.ledger_rows === 6 &&
            JSON.stringify(currentInit.ledger_versions) === JSON.stringify([1, 2, 3, 4, 5, 6]),
          "current binary initializes one complete contiguous schema-6 database",
          currentInit,
        );
      } finally {
        await postgres.dropDatabase(emptyName);
      }

      await runCli("initialize-schema5", ["migrate"], { binary: retainedM2Binary });
      await prepareRetainedM2(m3);
      await m3.startApi({ binary: retainedM2Binary, label: "retained M2 schema-5 population" });
      const seeded = await populateRetainedM2(context, m3);
      state.selectedSource = await seedSelectedSource(m3, seeded);
      expectScenario(Boolean(state.selectedSource), "selected source and compatibility population returns durable identifiers", {
        selected_source_population: false,
      });
      state.selectedSourcePreview = await populateSelectedSourcePreview(context, m3, state.selectedSource);
      state.baselineSchema5 = await readDurableState(postgres, "m3-schema5-baseline");
      expectScenario(
        state.baselineSchema5.schema_version === 5 &&
          state.baselineSchema5.minimum_reader_version === 4 &&
          state.baselineSchema5.relation_counts.accounts >= 2 &&
          state.baselineSchema5.relation_counts.projects >= 1 &&
          state.baselineSchema5.relation_counts.github_source_revisions >= 1 &&
          state.baselineSchema5.relation_counts.compatibility_reports >= 1 &&
          state.baselineSchema5.relation_counts.admission_source_proofs >= 1 &&
          state.baselineSchema5.relation_counts.slot_reservations >= 1 &&
          state.baselineSchema5.relation_counts.portfolio_preview_contexts >= 1 &&
          state.baselineSchema5.relation_counts.secret_versions >= 1 &&
          state.baselineSchema5.relation_counts.job_effects >= 1 &&
          state.baselineSchema5.foreign_key_count > 0 &&
          state.baselineSchema5.unvalidated_foreign_keys === 0 &&
          state.baselineSchema5.relationship_violations === 0,
        "meaningful populated schema-5 M2 baseline",
        state.baselineSchema5,
      );
      await m3.stopApi("quiesce populated schema-5 database for backup");
      await runCli("refuse-upgrade-without-backup", ["migrate"], {
        expectedErrorCode: "populated_upgrade_requires_verified_backup",
      });

      const wrongName = `hostlet_m3_wrong_${context.state.runId.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(-27)}`;
      await postgres.createDatabase(wrongName);
      try {
        const wrongUrl = postgres.databaseUrlFor(wrongName);
        await runCli("initialize-wrong-target-schema5", ["migrate"], {
          binary: retainedM2Binary,
          environmentOverrides: { DATABASE_URL: wrongUrl },
        });
        const wrongReceipt = await runCli(
          "create-wrong-target-backup",
          ["backup", "create", "--repository", wrongRepository, "--intended-migration", "6"],
          { environmentOverrides: { DATABASE_URL: wrongUrl } },
        );
        await runCli(
          "refuse-wrong-target-backup",
          ["migrate", "--repository", wrongRepository, "--backup-id", wrongReceipt.manifest.backup_id],
          { expectedErrorCode: "backup_database_identity_mismatch" },
        );
      } finally {
        await postgres.dropDatabase(wrongName);
      }

      state.backupReceipt = await runCli("create-schema5-backup", [
        "backup", "create", "--repository", repository, "--intended-migration", "6",
      ]);
      const verified = await runCli("verify-schema5-backup", [
        "backup", "verify", "--repository", repository,
        "--backup-id", state.backupReceipt.manifest.backup_id,
      ]);
      expectScenario(
        isDeepStrictEqual(verified, state.backupReceipt) &&
          state.backupReceipt.manifest.schema_version === 5 &&
          state.backupReceipt.manifest.minimum_reader_version === 4 &&
          state.backupReceipt.manifest.intended_migration === 6 &&
          state.backupReceipt.manifest.database_identity_id === state.baselineSchema5.database_identity &&
          isDeepStrictEqual(state.backupReceipt.manifest.relation_counts, state.baselineSchema5.relation_counts),
        "fresh verified schema-5 backup covers every public relation",
        {
          exact_verified_receipt: isDeepStrictEqual(verified, state.backupReceipt),
          schema_version: state.backupReceipt.manifest.schema_version,
          intended_migration: state.backupReceipt.manifest.intended_migration,
          relation_count_entries: Object.keys(state.backupReceipt.manifest.relation_counts).length,
          relation_count_mismatch_keys: mismatchKeys(
            state.backupReceipt.manifest.relation_counts,
            state.baselineSchema5.relation_counts,
          ),
        },
      );
      await runCli("migrate-with-verified-backup", [
        "migrate", "--repository", repository, "--backup-id", state.backupReceipt.manifest.backup_id,
      ]);
      state.postUpgradeSchema6 = await readDurableState(postgres, "m3-schema6-after-upgrade");
      const expectedStable = stablePreUpgradeState(state.baselineSchema5);
      const actualStable = stablePreUpgradeState(state.postUpgradeSchema6);
      for (const name of Object.keys(actualStable.relation_counts)) {
        if (!(name in expectedStable.relation_counts)) delete actualStable.relation_counts[name];
      }
      for (const name of Object.keys(actualStable.relation_ids)) {
        if (!(name in expectedStable.relation_ids)) delete actualStable.relation_ids[name];
      }
      for (const name of Object.keys(actualStable.relation_hashes)) {
        if (!(name in expectedStable.relation_hashes)) delete actualStable.relation_hashes[name];
      }
      actualStable.relation_owners = actualStable.relation_owners.filter(({ table }) =>
        expectedStable.relation_owners.some(({ table: expected }) => expected === table)
      );
      expectScenario(
        state.postUpgradeSchema6.schema_version === 6 &&
          state.postUpgradeSchema6.minimum_reader_version === 5 &&
          isDeepStrictEqual(actualStable, expectedStable) &&
          state.postUpgradeSchema6.foreign_key_count >= state.baselineSchema5.foreign_key_count &&
          state.postUpgradeSchema6.unvalidated_foreign_keys === 0 &&
          state.postUpgradeSchema6.relationship_violations === 0,
        "additive schema-6 migration preserves schema-5 values, IDs, ownership, counts, and relationships",
        {
          schema_version: state.postUpgradeSchema6.schema_version,
          minimum_reader_version: state.postUpgradeSchema6.minimum_reader_version,
          stable_state_match: isDeepStrictEqual(actualStable, expectedStable),
          relation_count_mismatch_keys: mismatchKeys(actualStable.relation_counts, expectedStable.relation_counts),
          relation_hash_mismatch_keys: mismatchKeys(actualStable.relation_hashes, expectedStable.relation_hashes),
          foreign_key_count: state.postUpgradeSchema6.foreign_key_count,
          unvalidated_foreign_keys: state.postUpgradeSchema6.unvalidated_foreign_keys,
          relationship_violations: state.postUpgradeSchema6.relationship_violations,
        },
      );
      return {
        source_schema_version: state.baselineSchema5.schema_version,
        current_empty_schema_version: currentInit.schema_version,
        target_schema_version: state.postUpgradeSchema6.schema_version,
        target_minimum_reader_version: state.postUpgradeSchema6.minimum_reader_version,
        backup_id: state.backupReceipt.manifest.backup_id,
        absent_backup_refused: true,
        wrong_target_backup_refused: true,
        selected_source_rows: state.baselineSchema5.relation_counts.github_source_revisions,
        compatibility_rows: state.baselineSchema5.relation_counts.compatibility_reports,
        relationship_violations: state.postUpgradeSchema6.relationship_violations,
      };
    },
  );

  await m3.startApi({ binary: currentApiBinary, label: "current schema-6 post-upgrade scenarios" });
  await runPostUpgrade(m3);

  await upgradeStep(
    context,
    "M3-UPGRADE-02",
    "current and actual retained M2 binaries read and write the upgraded database without rewind; repeated migration is idempotent and a final verified schema-6 backup restores exact populated state only into a separate empty owned target",
    async () => {
      const currentProject = await call(`/v1/projects/${state.graph.project.id}`, { token: state.owner.token });
      assertStatus(currentProject, 200, "current binary reads M2 project after schema 6");
      const currentAccount = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(currentAccount, 200, "current binary reads M2 account after schema 6");
      const currentWrite = await call(`/v1/accounts/${state.owner.record.id}`, {
        method: "PATCH", token: state.owner.token,
        headers: { "Idempotency-Key": "m3-upgrade-current-write", "If-Match": `"${currentAccount.payload.revision}"` },
        body: { display_name: "M3 current schema-6 write" },
      });
      assertStatus(currentWrite, 200, "current binary writes M2 state after schema 6");
      const beforeRetained = await readDurableState(postgres, "m3-before-retained-m2");

      await switchApi(retainedM2Binary, "retained M2 reads schema 6");
      const retainedProject = await call(`/v1/projects/${state.graph.project.id}`, { token: state.owner.token });
      assertStatus(retainedProject, 200, "retained M2 reads project after schema 6");
      const retainedAccount = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(retainedAccount, 200, "retained M2 reads current write");
      expectScenario(
        retainedAccount.payload.display_name === currentWrite.payload.display_name,
        "retained M2 observes current schema-6 write",
        { display_name_match: false },
      );
      const retainedWrite = await call(`/v1/accounts/${state.owner.record.id}`, {
        method: "PATCH", token: state.owner.token,
        headers: { "Idempotency-Key": "m3-upgrade-retained-write", "If-Match": `"${retainedAccount.payload.revision}"` },
        body: { display_name: "M3 retained M2 write after schema 6" },
      });
      assertStatus(retainedWrite, 200, "retained M2 writes after schema 6");
      await switchApi(retainedM2Binary, "retained M2 restart after schema-6 write");
      const retainedRestart = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(retainedRestart, 200, "retained M2 restart reads retained write");
      const afterRetained = await readDurableState(postgres, "m3-after-retained-m2");
      const retainedHashExclusions = new Set(["accounts", "audit_events", "idempotency_records", "sessions"]);
      const beforeRetainedHashes = hashesWithout(beforeRetained, retainedHashExclusions);
      const afterRetainedHashes = hashesWithout(afterRetained, retainedHashExclusions);
      expectScenario(
        afterRetained.schema_version === 6 &&
          afterRetained.database_identity === beforeRetained.database_identity &&
          afterRetained.migration_ledger_hash === beforeRetained.migration_ledger_hash &&
          isDeepStrictEqual(afterRetained.project_ids, beforeRetained.project_ids) &&
          isDeepStrictEqual(afterRetainedHashes, beforeRetainedHashes) &&
          Object.entries(beforeRetained.relation_ids).every(([name, ids]) =>
            name === "audit_events" || name === "idempotency_records" ||
            isDeepStrictEqual(afterRetained.relation_ids[name], ids)
          ) &&
          afterRetained.unvalidated_foreign_keys === 0 &&
          afterRetained.relationship_violations === 0,
        "retained M2 restart preserves populated M2 and M3 relation state",
        {
          schema_version: afterRetained.schema_version,
          database_identity_match: afterRetained.database_identity === beforeRetained.database_identity,
          migration_ledger_hash_match:
            afterRetained.migration_ledger_hash === beforeRetained.migration_ledger_hash,
          unchanged_relation_hashes_match: isDeepStrictEqual(afterRetainedHashes, beforeRetainedHashes),
          relation_hash_mismatch_keys: mismatchKeys(afterRetainedHashes, beforeRetainedHashes),
          unchanged_relation_hash_count: Object.keys(afterRetainedHashes).length,
          unvalidated_foreign_keys: afterRetained.unvalidated_foreign_keys,
          relationship_violations: afterRetained.relationship_violations,
        },
      );
      await switchApi(currentApiBinary, "current schema-6 resumes after retained M2");
      const currentRead = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(currentRead, 200, "current binary reads retained M2 write");
      expectScenario(
        currentRead.payload.display_name === retainedWrite.payload.display_name &&
          currentRead.payload.revision === retainedWrite.payload.revision,
        "current binary observes retained M2 write",
        { stable_account: false },
      );

      await m3.stopApi("quiesce schema-6 database for idempotence and final recovery proof");
      const beforeRepeatedMigration = await readDurableState(postgres, "m3-before-repeat-migration");
      await runCli("repeat-schema6-migration", ["migrate"]);
      const afterRepeatedMigration = await readDurableState(postgres, "m3-after-repeat-migration");
      expectScenario(
          afterRepeatedMigration.schema_version === 6 &&
          afterRepeatedMigration.migration_ledger_hash === beforeRepeatedMigration.migration_ledger_hash &&
          isDeepStrictEqual(afterRepeatedMigration.relation_hashes, beforeRepeatedMigration.relation_hashes) &&
          isDeepStrictEqual(afterRepeatedMigration.relation_ids, beforeRepeatedMigration.relation_ids) &&
          afterRepeatedMigration.unvalidated_foreign_keys === 0 &&
          afterRepeatedMigration.relationship_violations === 0,
        "repeated schema-6 migration is idempotent",
        {
          schema_version: afterRepeatedMigration.schema_version,
          migration_ledger_hash_match:
            afterRepeatedMigration.migration_ledger_hash === beforeRepeatedMigration.migration_ledger_hash,
          stable_relation_hashes: isDeepStrictEqual(afterRepeatedMigration.relation_hashes, beforeRepeatedMigration.relation_hashes),
          relation_hash_mismatch_keys: mismatchKeys(afterRepeatedMigration.relation_hashes, beforeRepeatedMigration.relation_hashes),
          relation_hash_count: Object.keys(afterRepeatedMigration.relation_hashes).length,
          stable_ids: isDeepStrictEqual(afterRepeatedMigration.relation_ids, beforeRepeatedMigration.relation_ids),
          relation_id_mismatch_keys: mismatchKeys(afterRepeatedMigration.relation_ids, beforeRepeatedMigration.relation_ids),
          unvalidated_foreign_keys: afterRepeatedMigration.unvalidated_foreign_keys,
          relationship_violations: afterRepeatedMigration.relationship_violations,
        },
      );
      const finalReceipt = await runCli("create-final-schema6-backup", [
        "backup", "create", "--repository", finalRepository,
      ]);
      const finalVerified = await runCli("verify-final-schema6-backup", [
        "backup", "verify", "--repository", finalRepository,
        "--backup-id", finalReceipt.manifest.backup_id,
      ]);
      expectScenario(
        isDeepStrictEqual(finalVerified, finalReceipt) &&
          finalReceipt.manifest.schema_version === 6 &&
          finalReceipt.manifest.minimum_reader_version === 5,
        "final populated schema-6 backup is verified",
        {
          exact_verified_receipt: isDeepStrictEqual(finalVerified, finalReceipt),
          schema_version: finalReceipt.manifest.schema_version,
        },
      );
      await postgres.createRecoveryDatabase();
      const restoredReceipt = await runCli(
        "restore-final-schema6-backup",
        ["restore", "--repository", finalRepository, "--backup-id", finalReceipt.manifest.backup_id],
        {
          environmentOverrides: { HOSTLET_RESTORE_DATABASE_URL: postgres.recoveryDatabaseUrl },
          removeEnvironment: ["DATABASE_URL"],
        },
      );
      const restored = await readDurableState(
        postgres,
        "m3-final-schema6-restored",
        postgres.recoveryDatabaseName,
      );
      expectScenario(
        restoredReceipt.backup_id === finalReceipt.manifest.backup_id &&
          isDeepStrictEqual(restored, afterRepeatedMigration) &&
          restored.database_identity === afterRepeatedMigration.database_identity &&
          restored.migration_ledger_hash === afterRepeatedMigration.migration_ledger_hash &&
          restored.unvalidated_foreign_keys === 0 &&
          restored.relationship_violations === 0,
        "separate empty owned target restores every populated schema-6 value, ID, owner, count, and relationship",
        {
          backup_id_match: restoredReceipt.backup_id === finalReceipt.manifest.backup_id,
          exact_state_match: isDeepStrictEqual(restored, afterRepeatedMigration),
          relation_count_mismatch_keys: mismatchKeys(restored.relation_counts, afterRepeatedMigration.relation_counts),
          relation_hash_mismatch_keys: mismatchKeys(restored.relation_hashes, afterRepeatedMigration.relation_hashes),
          database_identity_match: restored.database_identity === afterRepeatedMigration.database_identity,
          migration_ledger_hash_match:
            restored.migration_ledger_hash === afterRepeatedMigration.migration_ledger_hash,
          relation_hash_count: Object.keys(restored.relation_hashes).length,
          foreign_key_count: restored.foreign_key_count,
          unvalidated_foreign_keys: restored.unvalidated_foreign_keys,
          relationship_violations: restored.relationship_violations,
        },
      );
      await m3.startApi({
        binary: currentApiBinary,
        environmentOverrides: { DATABASE_URL: postgres.recoveryDatabaseUrl },
        label: "current schema-6 restored database",
      });
      assertStatus(
        await call(`/v1/projects/${state.graph.project.id}`, { token: state.owner.token }),
        200,
        "current binary reads project from restored schema-6 target",
      );
      await m3.stopApi("finish distinct restored schema-6 API proof");
      await postgres.dropRecoveryDatabase();
      await m3.startApi({ binary: currentApiBinary, label: "return to populated schema-6 source database" });
      context.state.productOutputs.m3Upgrade = {
        sourceSchemaVersion: 5,
        targetSchemaVersion: 6,
        preUpgradeBackupId: state.backupReceipt.manifest.backup_id,
        finalBackupId: finalReceipt.manifest.backup_id,
        retainedM2SourceCommit: m3.fixtures.retainedManifest.source_commit,
        selectedSource: state.selectedSource,
      };
      return {
        schema_version: restored.schema_version,
        minimum_reader_version: restored.minimum_reader_version,
        current_project_read_status: currentProject.status,
        retained_project_read_status: retainedProject.status,
        current_write_revision: currentWrite.payload.revision,
        retained_write_revision: retainedWrite.payload.revision,
        retained_restart_read_status: retainedRestart.status,
        current_resume_read_status: currentRead.status,
        repeat_migration_idempotent: true,
        final_backup_id: finalReceipt.manifest.backup_id,
        restored_exact_state: true,
        restored_relation_hash_count: Object.keys(restored.relation_hashes).length,
        restored_database_identity_match: true,
        unvalidated_foreign_keys: restored.unvalidated_foreign_keys,
        database_rewinds: 0,
        relationship_violations: restored.relationship_violations,
      };
    },
  );
}
