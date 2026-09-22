import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";

export const M2_UPGRADE_REQUIRED_ASSERTIONS = Object.freeze([
  "M2-UPGRADE-01",
  "M2-UPGRADE-02",
]);

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function upgradeStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M2 populated schema-4 upgrade and retained M1 compatibility", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M2 populated schema-4 upgrade and retained M1 compatibility",
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

export function registerM2UpgradeFixtures(context) {
  context.registerFixture("M2 upgrade scenario module", "e2e/scenarios/m2-upgrade.mjs");
  context.registerFixture("M2 schema-4 project population contract", "contracts/v1/projects/valid-standard.json");
  context.registerFixture("M2 schema-4 portfolio population contract", "contracts/v1/portfolio/draft-valid.json");
  return Object.freeze({
    schema_version: 1,
    source_schema_version: 4,
    target_migration: 5,
    target_minimum_reader_version: 4,
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
  const countPairs = relationNames
    .map((name) => `'${name}',(SELECT COUNT(*)::int FROM public."${name}")`)
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
       'relation_counts', json_build_object(${countPairs}),
       'account_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM accounts),
       'project_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM projects),
       'configuration_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM configuration_revisions),
       'service_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM services),
       'portfolio_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM portfolio_draft_revisions),
       'secret_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM secrets),
       'secret_version_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM secret_versions),
       'job_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM jobs),
       'relationship_violations', (
         (SELECT COUNT(*) FROM configuration_revisions c LEFT JOIN projects p ON p.id=c.project_id AND p.account_id=c.account_id WHERE p.id IS NULL) +
         (SELECT COUNT(*) FROM service_configurations sc LEFT JOIN services s ON s.id=sc.service_id AND s.account_id=sc.account_id AND s.project_id=sc.project_id WHERE s.id IS NULL) +
         (SELECT COUNT(*) FROM portfolio_project_references r LEFT JOIN portfolio_draft_revisions p ON p.id=r.portfolio_revision_id AND p.account_id=r.account_id WHERE p.id IS NULL) +
         (SELECT COUNT(*) FROM secret_versions v LEFT JOIN secrets s ON s.id=v.secret_id AND s.account_id=v.account_id AND s.project_id=v.project_id AND s.service_id=v.service_id WHERE s.id IS NULL) +
         (SELECT COUNT(*) FROM job_secret_refs r LEFT JOIN jobs j ON j.id=r.job_id AND j.account_id=r.account_id AND j.project_id=r.project_id WHERE j.id IS NULL)
       )::int
     );`,
  );
  durable.relation_ids = relationIds;
  return durable;
}

async function populateSchema4(m2) {
  const { context, call, callInternal, credentials, state } = m2;
  const accountFixtures = [
    { email: "owner@m2-upgrade.hostlet.test", display_name: "M2 Upgrade Owner", password: credentials.ownerPassword },
    { email: "other@m2-upgrade.hostlet.test", display_name: "M2 Upgrade Other", password: credentials.otherPassword },
  ];
  const accounts = [];
  for (const fixture of accountFixtures) {
    const created = await call("/v1/accounts", { method: "POST", body: fixture });
    assertStatus(created, 201, `schema-4 account ${fixture.email}`);
    const session = await call("/v1/sessions", {
      method: "POST",
      body: { email: fixture.email, password: fixture.password },
    });
    assertStatus(session, 201, `schema-4 session ${fixture.email}`);
    context.registerSensitiveValues([session.payload.token]);
    accounts.push({ record: created.payload, token: session.payload.token });
  }
  [state.owner, state.other] = accounts;

  const projectConfiguration = JSON.parse(
    readFileSync(join(context.repo, "contracts/v1/projects/valid-standard.json"), "utf8"),
  );
  const project = await call("/v1/projects", {
    method: "POST",
    token: state.owner.token,
    headers: { "Idempotency-Key": "m2-upgrade-schema4-project" },
    body: { name: "M2 populated schema-4 project", configuration: projectConfiguration },
  });
  assertStatus(project, 201, "schema-4 project graph population");
  state.graph = project.payload;
  const application = state.graph.services.find(({ configuration }) => configuration.kind === "application");
  expectScenario(Boolean(application), "schema-4 application service exists", { application_service: false });

  const deployment = await call(`/v1/projects/${state.graph.project.id}/deployment-intents`, {
    method: "POST",
    token: state.owner.token,
    headers: {
      "Idempotency-Key": "m2-upgrade-schema4-deployment",
      "If-Match": `"${state.graph.project.revision}"`,
    },
    body: {
      configuration_revision_id: state.graph.configuration.id,
      source_commit: "4444444444444444444444444444444444444444",
    },
  });
  assertStatus(deployment, 201, "schema-4 deployment intent population");

  const rawDraft = JSON.parse(
    readFileSync(join(context.repo, "contracts/v1/portfolio/draft-valid.json"), "utf8"),
  );
  const portfolio = await call("/v1/portfolio/draft-revisions", {
    method: "POST",
    token: state.owner.token,
    headers: { "Idempotency-Key": "m2-upgrade-schema4-portfolio" },
    body: { draft: adaptPortfolioDraft(rawDraft, state.graph.project.id) },
  });
  assertStatus(portfolio, 201, "schema-4 portfolio population");

  const secret = await call(
    `/v1/projects/${state.graph.project.id}/services/${application.id}/secrets`,
    {
      method: "POST",
      token: state.owner.token,
      headers: { "Idempotency-Key": "m2-upgrade-schema4-secret" },
      body: { name: "m2-upgrade-source-read", operation: "build", credential_kind: "source_repository_read" },
    },
  );
  assertStatus(secret, 201, "schema-4 secret metadata population");
  const secretValue = `m2-upgrade-secret-${context.state.runId}`;
  context.registerSensitiveValues([secretValue]);
  const version = await call(
    `/v1/projects/${state.graph.project.id}/services/${application.id}/secrets/${secret.payload.id}/versions`,
    {
      method: "POST",
      token: state.owner.token,
      headers: {
        "Idempotency-Key": "m2-upgrade-schema4-secret-version",
        "If-Match": `"${secret.payload.revision}"`,
      },
      body: { value: secretValue },
    },
  );
  assertStatus(version, 201, "schema-4 secret version population");

  const job = await call(`/v1/projects/${state.graph.project.id}/jobs`, {
    method: "POST",
    token: state.owner.token,
    headers: { "Idempotency-Key": "m2-upgrade-schema4-job" },
    body: {
      kind: "foundation_bookkeeping",
      operation: "build",
      service_id: application.id,
      source_commit: "5555555555555555555555555555555555555555",
      secret_version_refs: [{ service_id: application.id, secret_version_id: version.payload.id }],
    },
  });
  assertStatus(job, 201, "schema-4 job population");
  const lease = await callInternal("/internal/v1/jobs/lease", {
    method: "POST",
    body: { worker_id: "m2-upgrade-worker", kinds: ["foundation_bookkeeping"] },
  });
  assertStatus(lease, 200, "schema-4 job lease population");
  const completed = await callInternal(`/internal/v1/jobs/${job.payload.id}/complete`, {
    method: "POST",
    body: {
      worker_id: "m2-upgrade-worker",
      attempt_id: lease.payload.attempt.id,
      fence: lease.payload.attempt.fence,
      outcome: { state: "succeeded", code: "bookkeeping_complete" },
    },
  });
  assertStatus(completed, 200, "schema-4 job completion population");
  state.jobs = { job: completed.payload.job, secret: secret.payload, secretVersion: version.payload };
  return { portfolio: portfolio.payload, deployment: deployment.payload };
}

export async function runM2PostUpgradeRecovery(m2) {
  const {
    context, postgres, currentApiBinary, call, stopApi, startApi,
    environmentForProbe, state,
  } = m2;
  const repository = join(context.tempDir, "m2-populated-schema5-backup");
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  const runCli = async (label, args, { environmentOverrides = {}, removeEnvironment = [] } = {}) => {
    const result = await context.runCommand(`M2 recovery ${label}`, currentApiBinary, args, {
      env: environmentForProbe(environmentOverrides, removeEnvironment),
      timeoutMs: 150_000,
      logName: `m2-recovery-${label}.log`,
    });
    expectScenario(result.code === 0, `${label}: recovery command succeeds`, { exit_status: result.code });
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new ScenarioExpectationError(`${label}: recovery JSON receipt`, { parsed_json: false });
    }
  };

  await stopApi("quiesce populated schema-5 database for recovery proof");
  const source = await readDurableState(postgres, "m2-populated-schema5-source");
  const receipt = await runCli("create", ["backup", "create", "--repository", repository]);
  const verified = await runCli("verify", [
    "backup", "verify", "--repository", repository, "--backup-id", receipt.manifest.backup_id,
  ]);
  expectScenario(
    JSON.stringify(verified) === JSON.stringify(receipt) &&
      receipt.manifest.schema_version === 5 &&
      receipt.manifest.minimum_reader_version === 4 &&
      JSON.stringify(receipt.manifest.relation_counts) === JSON.stringify(source.relation_counts),
    "schema-5 backup is verified and covers every public relation",
    {
      exact_verified_receipt: JSON.stringify(verified) === JSON.stringify(receipt),
      schema_version: receipt.manifest.schema_version,
      relation_count_entries: Object.keys(receipt.manifest.relation_counts).length,
    },
  );
  await postgres.createRecoveryDatabase();
  const restoredReceipt = await runCli(
    "restore",
    ["restore", "--repository", repository, "--backup-id", receipt.manifest.backup_id],
    {
      environmentOverrides: { HOSTLET_RESTORE_DATABASE_URL: postgres.recoveryDatabaseUrl },
      removeEnvironment: ["DATABASE_URL"],
    },
  );
  const restored = await readDurableState(
    postgres,
    "m2-populated-schema5-restored",
    postgres.recoveryDatabaseName,
  );
  expectScenario(
    restoredReceipt.backup_id === receipt.manifest.backup_id &&
      restored.database_identity === source.database_identity &&
      restored.schema_version === source.schema_version &&
      restored.minimum_reader_version === source.minimum_reader_version &&
      JSON.stringify(restored.relation_counts) === JSON.stringify(source.relation_counts) &&
      JSON.stringify(restored.relation_ids) === JSON.stringify(source.relation_ids) &&
      restored.relationship_violations === 0,
    "distinct empty owned database restores every schema-5 count, ID, and relationship",
    {
      backup_id_match: restoredReceipt.backup_id === receipt.manifest.backup_id,
      schema_version: restored.schema_version,
      relation_count_entries: Object.keys(restored.relation_counts).length,
      id_relation_entries: Object.keys(restored.relation_ids).length,
      relationship_violations: restored.relationship_violations,
    },
  );

  await startApi({
    binary: currentApiBinary,
    environmentOverrides: { DATABASE_URL: postgres.recoveryDatabaseUrl },
    label: "current schema-5 restored database",
  });
  const account = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
  const project = await call(`/v1/projects/${state.graph.project.id}`, { token: state.owner.token });
  assertStatus(account, 200, "restored owner account read");
  assertStatus(project, 200, "restored owner project read");
  for (const check of state.restoreReadChecks) {
    expectScenario(
      check && typeof check.name === "string" && typeof check.run === "function",
      "registered restored-data read check shape",
      { valid: false },
    );
    await check.run(m2);
  }
  await stopApi("finish distinct restored schema-5 API proof");
  await postgres.dropRecoveryDatabase();
  await startApi({ binary: currentApiBinary, label: "return to populated schema-5 source database" });
  context.state.productOutputs.m2Recovery = {
    backupId: receipt.manifest.backup_id,
    schemaVersion: restored.schema_version,
    relationCountEntries: Object.keys(restored.relation_counts).length,
    idRelationEntries: Object.keys(restored.relation_ids).length,
    registeredReadChecks: state.restoreReadChecks.map(({ name }) => name),
  };
  return { receipt, source, restored };
}

export async function runM2UpgradeScenarios(
  m2,
  { preparePostUpgrade = async () => {}, runPostUpgrade = async () => {} } = {},
) {
  const {
    context, postgres, fixtures, currentApiBinary, retainedM1Binary,
    call, switchApi, environmentForProbe, state,
  } = m2;
  const manifest = fixtures.upgradeManifest;
  expectScenario(
    manifest.source_schema_version === 4 && manifest.target_migration === 5 && manifest.target_minimum_reader_version === 4,
    "M2 upgrade harness version contract",
    manifest,
  );
  const repository = join(context.tempDir, "m2-upgrade-backups");
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  let cliSequence = 0;
  const runCli = async (
    label,
    args,
    { binary = currentApiBinary, expectedErrorCode, environmentOverrides = {}, removeEnvironment = [] } = {},
  ) => {
    cliSequence += 1;
    const result = await context.runCommand(`M2 upgrade ${label}`, binary, args, {
      env: environmentForProbe(environmentOverrides, removeEnvironment),
      timeoutMs: 150_000,
      logName: `m2-upgrade-${String(cliSequence).padStart(2, "0")}-${label}.log`,
    });
    if (expectedErrorCode) {
      expectScenario(
        result.code !== 0 && result.stderr.includes(`migration failed: ${expectedErrorCode}`),
        `${label}: exact safe migration failure`,
        { exit_status: result.code, expected_error_code_observed: false },
      );
      return null;
    }
    expectScenario(result.code === 0, `${label}: command succeeds`, { exit_status: result.code });
    if (!result.stdout.trim()) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new ScenarioExpectationError(`${label}: JSON receipt`, { parsed_json: false });
    }
  };

  await upgradeStep(
    context,
    "M2-UPGRADE-01",
    "a meaningful schema-4 M1 database is backed up and cryptographically verified by the current binary before one additive schema-5 migration preserves IDs, counts, and relationships",
    async () => {
      const currentInitName = `hostlet_m2_init_${context.state.runId.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(-28)}`;
      await postgres.createDatabase(currentInitName);
      let currentInit;
      try {
        await runCli("initialize-empty-schema5", ["migrate"], {
          environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(currentInitName) },
        });
        currentInit = await postgres.psqlJsonDatabase(
          "m2-current-empty-initialization",
          currentInitName,
          `SELECT json_build_object(
             'schema_version', (SELECT current_version::int FROM platform_schema_compatibility WHERE singleton=true),
             'minimum_reader_version', (SELECT min_reader_version::int FROM platform_schema_compatibility WHERE singleton=true),
             'ledger_versions', (SELECT json_agg(version::int ORDER BY version) FROM _sqlx_migrations),
             'ledger_rows', (SELECT COUNT(*)::int FROM _sqlx_migrations),
             'public_tables', (
               SELECT COUNT(*)::int FROM pg_catalog.pg_tables
                WHERE schemaname='public' AND tablename <> '_sqlx_migrations'
             )
           );`,
        );
        expectScenario(
          currentInit.schema_version === 5 &&
            currentInit.minimum_reader_version === 4 &&
            currentInit.ledger_rows === 5 &&
            JSON.stringify(currentInit.ledger_versions) === JSON.stringify([1, 2, 3, 4, 5]) &&
            currentInit.public_tables > 26,
          "current binary initializes one complete contiguous schema-5 database",
          currentInit,
        );
      } finally {
        await postgres.dropDatabase(currentInitName);
      }
      await runCli("initialize-schema4", ["migrate"], { binary: retainedM1Binary });
      await m2.startApi({ binary: retainedM1Binary, label: "retained M1 schema-4 population" });
      await populateSchema4(m2);
      state.baselineSchema4 = await readDurableState(postgres, "m2-schema4-baseline");
      expectScenario(
        state.baselineSchema4.schema_version === 4 &&
          state.baselineSchema4.minimum_reader_version === 3 &&
          state.baselineSchema4.relation_counts.accounts === 2 &&
          state.baselineSchema4.relation_counts.projects >= 1 &&
          state.baselineSchema4.relation_counts.configuration_revisions >= 1 &&
          state.baselineSchema4.relation_counts.services >= 1 &&
          state.baselineSchema4.relation_counts.portfolio_draft_revisions >= 1 &&
          state.baselineSchema4.relation_counts.secret_versions >= 1 &&
          state.baselineSchema4.relation_counts.job_effects >= 1 &&
          state.baselineSchema4.relationship_violations === 0,
        "meaningful populated schema-4 M1 baseline",
        state.baselineSchema4,
      );
      await m2.stopApi("quiesce populated schema-4 database for backup");
      await runCli("refuse-upgrade-without-backup", ["migrate"], {
        expectedErrorCode: "populated_upgrade_requires_verified_backup",
      });
      state.backupReceipt = await runCli("create-current-binary-backup", [
        "backup", "create", "--repository", repository,
        "--intended-migration", String(manifest.target_migration),
      ]);
      const verified = await runCli("verify-current-binary-backup", [
        "backup", "verify", "--repository", repository,
        "--backup-id", state.backupReceipt.manifest.backup_id,
      ]);
      expectScenario(
        JSON.stringify(verified) === JSON.stringify(state.backupReceipt) &&
          state.backupReceipt.manifest.schema_version === 4 &&
          state.backupReceipt.manifest.intended_migration === 5 &&
          state.backupReceipt.manifest.database_identity_id === state.baselineSchema4.database_identity &&
          JSON.stringify(state.backupReceipt.manifest.relation_counts) ===
            JSON.stringify(state.baselineSchema4.relation_counts),
        "fresh verified backup covers every pre-upgrade public relation",
        {
          exact_verified_receipt: JSON.stringify(verified) === JSON.stringify(state.backupReceipt),
          schema_version: state.backupReceipt.manifest.schema_version,
          intended_migration: state.backupReceipt.manifest.intended_migration,
          relation_count_entries: Object.keys(state.backupReceipt.manifest.relation_counts).length,
        },
      );
      await runCli("migrate-with-verified-backup", [
        "migrate", "--repository", repository,
        "--backup-id", state.backupReceipt.manifest.backup_id,
      ]);
      state.postUpgradeSchema5 = await readDurableState(postgres, "m2-schema5-after-upgrade");
      const beforeCounts = { ...state.baselineSchema4.relation_counts };
      const afterCounts = { ...state.postUpgradeSchema5.relation_counts };
      delete beforeCounts.platform_backup_receipts;
      delete afterCounts.platform_backup_receipts;
      for (const name of Object.keys(afterCounts)) {
        if (!(name in beforeCounts)) delete afterCounts[name];
      }
      expectScenario(
        state.postUpgradeSchema5.schema_version === 5 &&
          state.postUpgradeSchema5.minimum_reader_version === 4 &&
          state.postUpgradeSchema5.database_identity === state.baselineSchema4.database_identity &&
          JSON.stringify(state.postUpgradeSchema5.account_ids) === JSON.stringify(state.baselineSchema4.account_ids) &&
          JSON.stringify(state.postUpgradeSchema5.project_ids) === JSON.stringify(state.baselineSchema4.project_ids) &&
          JSON.stringify(state.postUpgradeSchema5.configuration_ids) === JSON.stringify(state.baselineSchema4.configuration_ids) &&
          JSON.stringify(state.postUpgradeSchema5.service_ids) === JSON.stringify(state.baselineSchema4.service_ids) &&
          JSON.stringify(state.postUpgradeSchema5.portfolio_ids) === JSON.stringify(state.baselineSchema4.portfolio_ids) &&
          JSON.stringify(state.postUpgradeSchema5.secret_version_ids) === JSON.stringify(state.baselineSchema4.secret_version_ids) &&
          JSON.stringify(state.postUpgradeSchema5.job_ids) === JSON.stringify(state.baselineSchema4.job_ids) &&
          Object.entries(state.baselineSchema4.relation_ids).every(([name, ids]) =>
            JSON.stringify(state.postUpgradeSchema5.relation_ids[name]) === JSON.stringify(ids)
          ) &&
          JSON.stringify(afterCounts) === JSON.stringify(beforeCounts) &&
          state.postUpgradeSchema5.relationship_violations === 0,
        "additive schema-5 migration preserves M1 rows, IDs, and relationships",
        state.postUpgradeSchema5,
      );
      return {
        source_schema_version: state.baselineSchema4.schema_version,
        current_empty_schema_version: currentInit.schema_version,
        current_empty_ledger_versions: currentInit.ledger_versions,
        target_schema_version: state.postUpgradeSchema5.schema_version,
        target_minimum_reader_version: state.postUpgradeSchema5.minimum_reader_version,
        backup_id: state.backupReceipt.manifest.backup_id,
        verified_backup_required: true,
        retained_account_ids: state.postUpgradeSchema5.account_ids.length,
        retained_project_ids: state.postUpgradeSchema5.project_ids.length,
        retained_job_ids: state.postUpgradeSchema5.job_ids.length,
        relationship_violations: state.postUpgradeSchema5.relationship_violations,
      };
    },
  );

  await preparePostUpgrade(m2);
  await m2.startApi({ binary: currentApiBinary, label: "current schema-5 feature scenarios" });
  await runPostUpgrade(m2);
  await runM2PostUpgradeRecovery(m2);

  await upgradeStep(
    context,
    "M2-UPGRADE-02",
    "current and retained M1 binaries read and write M1 state after schema 5; retained restart preserves M2 rows and current resumes without a database rewind",
    async () => {
      const projectBefore = await call(`/v1/projects/${state.graph.project.id}`, { token: state.owner.token });
      assertStatus(projectBefore, 200, "current binary reads M1 project after schema 5");
      const currentAccount = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(currentAccount, 200, "current binary reads M1 account after schema 5");
      const currentWrite = await call(`/v1/accounts/${state.owner.record.id}`, {
        method: "PATCH",
        token: state.owner.token,
        headers: { "Idempotency-Key": "m2-upgrade-current-write", "If-Match": `"${currentAccount.payload.revision}"` },
        body: { display_name: "M2 current schema-5 write" },
      });
      assertStatus(currentWrite, 200, "current binary writes M1 state after schema 5");
      const beforeRollback = await readDurableState(postgres, "m2-before-retained-rollback");

      await switchApi(retainedM1Binary, "retained M1 reads schema 5");
      const retainedProject = await call(`/v1/projects/${state.graph.project.id}`, { token: state.owner.token });
      assertStatus(retainedProject, 200, "retained M1 reads project after schema 5");
      const retainedAccount = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(retainedAccount, 200, "retained M1 reads current write");
      expectScenario(
        retainedAccount.payload.display_name === currentWrite.payload.display_name,
        "retained M1 observes current schema-5 write",
        { display_name_match: false },
      );
      const retainedWrite = await call(`/v1/accounts/${state.owner.record.id}`, {
        method: "PATCH",
        token: state.owner.token,
        headers: { "Idempotency-Key": "m2-upgrade-retained-write", "If-Match": `"${retainedAccount.payload.revision}"` },
        body: { display_name: "M2 retained M1 write after schema 5" },
      });
      assertStatus(retainedWrite, 200, "retained M1 writes after schema 5");
      await switchApi(retainedM1Binary, "retained M1 restart after schema-5 write");
      const retainedRestartRead = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(retainedRestartRead, 200, "retained M1 restart reads retained write");

      const afterRollback = await readDurableState(postgres, "m2-after-retained-rollback");
      expectScenario(
        afterRollback.schema_version === 5 &&
          afterRollback.database_identity === beforeRollback.database_identity &&
          JSON.stringify(afterRollback.project_ids) === JSON.stringify(beforeRollback.project_ids) &&
          Object.entries(beforeRollback.relation_counts).every(([name, count]) =>
            name === "audit_events" || name === "idempotency_records" || name === "sessions" ||
            afterRollback.relation_counts[name] === count
          ) &&
          Object.keys(afterRollback.relation_counts).every((name) =>
            name in beforeRollback.relation_counts || afterRollback.relation_counts[name] >= 0
          ) &&
          Object.entries(beforeRollback.relation_ids).every(([name, ids]) =>
            name === "audit_events" || name === "idempotency_records" ||
            JSON.stringify(afterRollback.relation_ids[name]) === JSON.stringify(ids)
          ) &&
          afterRollback.relationship_violations === 0,
        "retained M1 restart preserves M1 and M2 relation state",
        afterRollback,
      );
      await switchApi(currentApiBinary, "current schema-5 resumes after retained M1");
      const currentRead = await call(`/v1/accounts/${state.owner.record.id}`, { token: state.owner.token });
      assertStatus(currentRead, 200, "current binary reads retained M1 write");
      expectScenario(
        currentRead.payload.display_name === retainedWrite.payload.display_name &&
          currentRead.payload.revision === retainedWrite.payload.revision,
        "current binary observes retained M1 write",
        { stable_account: false },
      );
      return {
        schema_version: afterRollback.schema_version,
        current_project_read_status: projectBefore.status,
        retained_project_read_status: retainedProject.status,
        current_write_revision: currentWrite.payload.revision,
        retained_write_revision: retainedWrite.payload.revision,
        retained_restart_read_status: retainedRestartRead.status,
        current_resume_read_status: currentRead.status,
        database_rewinds: 0,
        relationship_violations: afterRollback.relationship_violations,
      };
    },
  );
}
