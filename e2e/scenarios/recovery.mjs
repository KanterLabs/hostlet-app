import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertAccountRecord,
  assertErrorShape,
  assertStatus,
  expectScenario,
  ScenarioExpectationError,
} from "../support/http-client.mjs";
import { runRetentionScenarios } from "./recovery-retention.mjs";

export const RECOVERY_REQUIRED_ASSERTIONS = Object.freeze([
  "M1-RECOVERY-01",
  "M1-RECOVERY-02",
  "M1-RECOVERY-03",
  "M1-RECOVERY-04",
  "M1-RECOVERY-05",
  "M1-RECOVERY-06",
  "M1-RECOVERY-07",
  "M1-RECOVERY-08",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COUNTED_RELATIONS = Object.freeze([
  "accounts",
  "audit_events",
  "configuration_revisions",
  "database_identity",
  "deployment_artifact_refs",
  "deployments",
  "hosting_state_events",
  "idempotency_records",
  "job_attempts",
  "job_effects",
  "job_secret_refs",
  "jobs",
  "password_identities",
  "platform_schema_compatibility",
  "portfolio_draft_revisions",
  "portfolio_project_references",
  "projects",
  "project_lifecycle_intents",
  "repositories",
  "repository_configurations",
  "secret_versions",
  "secrets",
  "service_configurations",
  "services",
  "sessions",
]);

function safeObserved(error) {
  if (error instanceof ScenarioExpectationError) return error.observed;
  return { failed_checks: 1 };
}

async function recoveryStep(context, id, expected, run) {
  try {
    const observed = await run();
    context.assertion(id, "M1 additive upgrades, backup and recovery", expected, observed, true);
    return observed;
  } catch (error) {
    context.assertion(
      id,
      "M1 additive upgrades, backup and recovery",
      expected,
      safeObserved(error),
      false,
      error instanceof ScenarioExpectationError
        ? error.check
        : "recovery command or persistence boundary failed",
    );
    throw error;
  }
}

export function registerRecoveryFixtures(context) {
  context.registerFixture("M1 recovery scenario module", "e2e/scenarios/recovery.mjs");
  context.registerFixture("M1 recovery retention scenario module", "e2e/scenarios/recovery-retention.mjs");
  context.registerFixture("M1 recovery scenario inventory", "e2e/support/recovery-fixtures.json");
  return JSON.parse(
    readFileSync(join(context.repo, "e2e", "support", "recovery-fixtures.json"), "utf8"),
  );
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function assertBackupReceipt(receipt, intendedMigration, check) {
  const manifest = receipt?.manifest;
  expectScenario(
    exactKeys(receipt, ["manifest", "encrypted_payload_sha256", "encrypted_payload_bytes"]) &&
      exactKeys(manifest, [
        "format",
        "backup_id",
        "database_identity_id",
        "schema_version",
        "minimum_reader_version",
        "source_revision",
        "source_dirty",
        "source_binary_sha256",
        "source_target_fingerprint",
        "snapshot_at",
        "scheduled_for",
        "intended_migration",
        "recovery_key_id",
        "relation_counts",
        "plaintext_sha256",
        "plaintext_bytes",
        "postgres_server_major",
        "pg_dump_major",
      ]) &&
      manifest.format === "hostlet.platform-backup/v1" &&
      UUID.test(manifest.backup_id) &&
      UUID.test(manifest.database_identity_id) &&
      manifest.schema_version === 3 &&
      manifest.minimum_reader_version === 1 &&
      /^[0-9a-f]{40}$/.test(manifest.source_revision) &&
      typeof manifest.source_dirty === "boolean" &&
      SHA256.test(manifest.source_binary_sha256) &&
      SHA256.test(manifest.source_target_fingerprint) &&
      Number.isFinite(Date.parse(manifest.snapshot_at)) &&
      manifest.scheduled_for === null &&
      manifest.intended_migration === intendedMigration &&
      /^v1-[A-Za-z0-9_-]{43}$/.test(manifest.recovery_key_id) &&
      Object.keys(manifest.relation_counts).sort().join(",") === [...COUNTED_RELATIONS].sort().join(",") &&
      Object.values(manifest.relation_counts).every(Number.isInteger) &&
      SHA256.test(manifest.plaintext_sha256) &&
      Number.isInteger(manifest.plaintext_bytes) &&
      manifest.plaintext_bytes > 0 &&
      manifest.postgres_server_major === 18 &&
      manifest.pg_dump_major === 18 &&
      SHA256.test(receipt.encrypted_payload_sha256) &&
      Number.isInteger(receipt.encrypted_payload_bytes) &&
      receipt.encrypted_payload_bytes > 0,
    check,
    { receipt_shape_valid: false },
  );
}

function backupPaths(repository, backupId) {
  return {
    artifact: join(repository, `${backupId}.hostlet-backup`),
    receipt: join(repository, `${backupId}.receipt.json`),
  };
}

function tamperCiphertext(bytes) {
  const envelope = JSON.parse(bytes.toString("utf8"));
  expectScenario(
    typeof envelope.ciphertext === "string" && envelope.ciphertext.length > 0,
    "owned encrypted backup fixture contains ciphertext",
    { ciphertext_present: false },
  );
  const replacement = envelope.ciphertext[0] === "A" ? "B" : "A";
  envelope.ciphertext = `${replacement}${envelope.ciphertext.slice(1)}`;
  return Buffer.from(JSON.stringify(envelope));
}

function headers(key) {
  return { "Idempotency-Key": key };
}

async function readDurableState(postgres, databaseName, label) {
  return postgres.psqlJsonDatabase(
    label,
    databaseName,
    `SELECT json_build_object(
       'database_identity', (SELECT id::text FROM database_identity WHERE singleton=true),
       'schema_version', (SELECT current_version::int FROM platform_schema_compatibility WHERE singleton=true),
       'minimum_reader_version', (SELECT min_reader_version::int FROM platform_schema_compatibility WHERE singleton=true),
       'accounts', (SELECT COUNT(*)::int FROM accounts),
       'projects', (SELECT COUNT(*)::int FROM projects),
       'configurations', (SELECT COUNT(*)::int FROM configuration_revisions),
       'services', (SELECT COUNT(*)::int FROM services),
       'deployments', (SELECT COUNT(*)::int FROM deployments),
       'portfolio_revisions', (SELECT COUNT(*)::int FROM portfolio_draft_revisions),
       'portfolio_references', (SELECT COUNT(*)::int FROM portfolio_project_references),
       'secrets', (SELECT COUNT(*)::int FROM secrets),
       'secret_versions', (SELECT COUNT(*)::int FROM secret_versions),
       'jobs', (SELECT COUNT(*)::int FROM jobs),
       'job_attempts', (SELECT COUNT(*)::int FROM job_attempts),
       'job_effects', (SELECT COUNT(*)::int FROM job_effects),
       'audit_events', (SELECT COUNT(*)::int FROM audit_events),
       'account_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM accounts),
       'project_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM projects),
       'configuration_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM configuration_revisions),
       'deployment_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM deployments),
       'portfolio_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM portfolio_draft_revisions),
       'secret_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM secrets),
       'secret_version_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM secret_versions),
       'job_ids', (SELECT COALESCE(json_agg(id::text ORDER BY id::text),'[]'::json) FROM jobs),
       'relationship_violations', (
         (SELECT COUNT(*) FROM configuration_revisions c LEFT JOIN projects p ON p.id=c.project_id AND p.account_id=c.account_id WHERE p.id IS NULL) +
         (SELECT COUNT(*) FROM service_configurations sc LEFT JOIN services s ON s.id=sc.service_id AND s.account_id=sc.account_id AND s.project_id=sc.project_id WHERE s.id IS NULL) +
         (SELECT COUNT(*) FROM deployments d LEFT JOIN configuration_revisions c ON c.id=d.configuration_revision_id AND c.account_id=d.account_id AND c.project_id=d.project_id WHERE c.id IS NULL) +
         (SELECT COUNT(*) FROM portfolio_project_references r LEFT JOIN portfolio_draft_revisions p ON p.id=r.portfolio_revision_id AND p.account_id=r.account_id WHERE p.id IS NULL) +
         (SELECT COUNT(*) FROM secret_versions v LEFT JOIN secrets s ON s.id=v.secret_id AND s.account_id=v.account_id AND s.project_id=v.project_id AND s.service_id=v.service_id WHERE s.id IS NULL) +
         (SELECT COUNT(*) FROM job_secret_refs r LEFT JOIN jobs j ON j.id=r.job_id AND j.account_id=r.account_id AND j.project_id=r.project_id WHERE j.id IS NULL)
       )::int
     );`,
  );
}

export async function runRecoveryScenarios({
  context,
  manifest,
  postgres,
  call,
  callInternal,
  callInternalSensitive,
  switchApi,
  environmentForProbe,
  currentApiBinary,
  retainedApiBinary,
  graph,
  jobs,
  owner,
  other,
  workerToken,
}) {
  expectScenario(
    manifest.schema_version === 1 && manifest.target_migration === 4,
    "recovery fixture schema and target migration",
    { fixture_schema_version: manifest.schema_version, target_migration: manifest.target_migration },
  );
  const repository = join(context.tempDir, "recovery-repository");
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  chmodSync(repository, 0o700);
  const baseEnvironment = environmentForProbe();
  const recoveryKey = baseEnvironment.HOSTLET_RECOVERY_KEY;
  expectScenario(typeof recoveryKey === "string" && /^[0-9a-f]{64}$/.test(recoveryKey), "recovery key fixture", {
    recovery_key_present: false,
  });
  const cliEnvironment = (overrides = {}, removeEnvironment = []) =>
    environmentForProbe(
      {
        DATABASE_URL: postgres.databaseUrl,
        HOSTLET_RECOVERY_KEY: recoveryKey,
        HOSTLET_PG_CONTAINER: postgres.containerName,
        ...overrides,
      },
      removeEnvironment,
    );
  let cliSequence = 0;
  const runCli = async (
    label,
    args,
    {
      binary = currentApiBinary,
      allowFailure = false,
      expectedErrorCode,
      environmentOverrides = {},
      removeEnvironment = [],
      timeoutMs = 150_000,
    } = {},
  ) => {
    cliSequence += 1;
    const result = await context.runCommand(`Hostlet recovery ${label}`, binary, args, {
      env: cliEnvironment(environmentOverrides, removeEnvironment),
      timeoutMs,
      allowFailure: allowFailure || expectedErrorCode !== undefined,
      logName: `foundation-recovery-${String(cliSequence).padStart(3, "0")}-${label}.log`,
    });
    if (expectedErrorCode !== undefined) {
      expectScenario(
        result.code !== 0 &&
          (result.stderr.includes(`recovery failed: ${expectedErrorCode}`) ||
            result.stderr.includes(`migration failed: ${expectedErrorCode}`)),
        `${label}: exact safe recovery failure`,
        { exit_status: result.code, expected_error_code_observed: false },
      );
      return { code: result.code, payload: null };
    }
    expectScenario(result.code === 0, `${label}: recovery command succeeds`, {
      exit_status: result.code,
    });
    const stdout = result.stdout.trim();
    let payload = null;
    if (stdout) {
      try {
        payload = JSON.parse(stdout);
      } catch {
        throw new ScenarioExpectationError(`${label}: safe JSON stdout receipt`, {
          parsed_json: false,
        });
      }
    }
    return { code: result.code, payload };
  };

  let baseline = null;
  let staleBackup = null;
  let upgradeBackup = null;
  let restoreDurationMs = null;
  let restoredState = null;

  await recoveryStep(
    context,
    "M1-RECOVERY-01",
    "initial migration accepts only an empty selected database; retained and current binaries refuse missing, changed, or pending migration state without resetting data",
    async () => {
      await switchApi(currentApiBinary, postgres.databaseUrl, "current binary pending-schema readiness", {
        expectReady: false,
      });
      const pending = await call("/readyz");
      assertStatus(pending, 503, "current binary before additive migration");
      expectScenario(pending.payload?.reason === "schema_migration_pending", "pending schema reason", {
        readiness_status: pending.status,
        reason: pending.payload?.reason ?? null,
      });
      await switchApi(retainedApiBinary, postgres.databaseUrl, "retained binary schema-3 read", {});
      const retainedReady = await call("/readyz");
      assertStatus(retainedReady, 200, "retained schema-3 binary readiness");

      let ledgerRenamed = false;
      try {
        await postgres.psqlCommand(
          "recovery-ledger-rename",
          "ALTER TABLE _sqlx_migrations RENAME TO _sqlx_migrations_e2e_temporarily_unavailable;",
        );
        ledgerRenamed = true;
        const missingLedger = await call("/readyz");
        assertStatus(missingLedger, 503, "missing migration ledger readiness");
      } finally {
        if (ledgerRenamed) {
          await postgres.psqlCommand(
            "recovery-ledger-restore",
            "ALTER TABLE _sqlx_migrations_e2e_temporarily_unavailable RENAME TO _sqlx_migrations;",
          );
        }
      }
      const ledgerRecovered = await call("/readyz");
      assertStatus(ledgerRecovered, 200, "restored migration ledger readiness");

      let checksumChanged = false;
      try {
        await postgres.psqlCommand(
          "recovery-checksum-change",
          "UPDATE _sqlx_migrations SET checksum=set_byte(checksum,0,get_byte(checksum,0)#1) WHERE version=3;",
        );
        checksumChanged = true;
        const changedLedger = await call("/readyz");
        assertStatus(changedLedger, 503, "changed migration checksum readiness");
      } finally {
        if (checksumChanged) {
          await postgres.psqlCommand(
            "recovery-checksum-restore",
            "UPDATE _sqlx_migrations SET checksum=set_byte(checksum,0,get_byte(checksum,0)#1) WHERE version=3;",
          );
        }
      }
      const checksumRecovered = await call("/readyz");
      assertStatus(checksumRecovered, 200, "restored migration checksum readiness");

      let migrationVersionChanged = false;
      try {
        await postgres.psqlCommand(
          "recovery-ledger-version-change",
          "UPDATE _sqlx_migrations SET version=20 WHERE version=2;",
        );
        migrationVersionChanged = true;
        const outOfOrderLedger = await call("/readyz");
        assertStatus(outOfOrderLedger, 503, "out-of-order migration ledger readiness");
      } finally {
        if (migrationVersionChanged) {
          await postgres.psqlCommand(
            "recovery-ledger-version-restore",
            "UPDATE _sqlx_migrations SET version=2 WHERE version=20;",
          );
        }
      }
      const orderRecovered = await call("/readyz");
      assertStatus(orderRecovered, 200, "restored migration order readiness");

      const nonemptyName = `hostlet_nonempty_${context.state.runId.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(-28)}`;
      await postgres.createDatabase(nonemptyName);
      try {
        await postgres.psqlCommandDatabase(
          "recovery-nonempty-marker",
          nonemptyName,
          "CREATE TABLE e2e_existing_data(id integer PRIMARY KEY); INSERT INTO e2e_existing_data VALUES (1);",
        );
        await runCli("initial-nonempty-refused", ["migrate"], {
          binary: retainedApiBinary,
          expectedErrorCode: "initial_database_not_empty",
          environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(nonemptyName) },
        });
        await runCli("current-initial-nonempty-refused", ["migrate"], {
          binary: currentApiBinary,
          expectedErrorCode: "initial_database_not_empty",
          environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(nonemptyName) },
        });
      } finally {
        await postgres.dropDatabase(nonemptyName);
      }

      const currentInitName = `hostlet_current_init_${context.state.runId.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(-24)}`;
      await postgres.createDatabase(currentInitName);
      let initialized = null;
      let afterNoop = null;
      try {
        await runCli("current-empty-initial-migration", ["migrate"], {
          binary: currentApiBinary,
          environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(currentInitName) },
        });
        initialized = await postgres.psqlJsonDatabase(
          "recovery-current-initialized-schema",
          currentInitName,
          `SELECT json_build_object(
             'identity', (SELECT id::text FROM database_identity WHERE singleton=true),
             'current_version', (SELECT current_version::int FROM platform_schema_compatibility WHERE singleton=true),
             'minimum_reader_version', (SELECT min_reader_version::int FROM platform_schema_compatibility WHERE singleton=true),
             'ledger_versions', (SELECT json_agg(version::int ORDER BY version) FROM _sqlx_migrations),
             'ledger_rows', (SELECT COUNT(*)::int FROM _sqlx_migrations)
           );`,
        );
        expectScenario(
          UUID.test(initialized.identity) &&
            initialized.current_version === 4 &&
            initialized.minimum_reader_version === 3 &&
            initialized.ledger_rows === 4 &&
            JSON.stringify(initialized.ledger_versions) === JSON.stringify([1, 2, 3, 4]),
          "current binary initializes one complete contiguous schema-4 transaction",
          {
            current_version: initialized.current_version,
            minimum_reader_version: initialized.minimum_reader_version,
            ledger_rows: initialized.ledger_rows,
            ledger_versions: initialized.ledger_versions,
          },
        );
        await runCli("current-initial-migration-noop", ["migrate"], {
          binary: currentApiBinary,
          environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(currentInitName) },
        });
        afterNoop = await postgres.psqlJsonDatabase(
          "recovery-current-initialized-noop",
          currentInitName,
          `SELECT json_build_object(
             'identity', (SELECT id::text FROM database_identity WHERE singleton=true),
             'ledger_rows', (SELECT COUNT(*)::int FROM _sqlx_migrations)
           );`,
        );
        expectScenario(
          afterNoop.identity === initialized.identity && afterNoop.ledger_rows === initialized.ledger_rows,
          "second current migration is an identity-preserving no-op",
          { identity_stable: false, ledger_rows: afterNoop.ledger_rows },
        );
      } finally {
        await postgres.dropDatabase(currentInitName);
      }
      return {
        current_pending_status: pending.status,
        retained_ready_status: retainedReady.status,
        missing_ledger_status: 503,
        changed_checksum_status: 503,
        out_of_order_ledger_status: 503,
        recovered_statuses: [ledgerRecovered.status, checksumRecovered.status, orderRecovered.status],
        retained_and_current_nonempty_initial_migration_refused: true,
        current_empty_initial_schema_version: initialized.current_version,
        current_empty_initial_minimum_reader_version: initialized.minimum_reader_version,
        current_empty_initial_ledger_versions: initialized.ledger_versions,
        current_empty_second_migration_identity_stable: afterNoop.identity === initialized.identity,
      };
    },
  );

  await recoveryStep(
    context,
    "M1-RECOVERY-02",
    "the schema-3 source is populated through normal account, graph, portfolio, secret, and job APIs and independent SQL confirms owned relationships before backup",
    async () => {
      baseline = await readDurableState(postgres, "hostlet_e2e", "recovery-source-baseline");
      expectScenario(
        baseline.schema_version === 3 &&
          baseline.accounts === 2 &&
          baseline.projects >= 2 &&
          baseline.configurations >= 2 &&
          baseline.services >= 4 &&
          baseline.deployments >= 2 &&
          baseline.portfolio_revisions >= 1 &&
          baseline.secrets >= 1 &&
          baseline.secret_versions >= 1 &&
          baseline.jobs >= 1 &&
          baseline.job_attempts >= 1 &&
          baseline.job_effects >= 1 &&
          baseline.audit_events >= 1 &&
          baseline.relationship_violations === 0 &&
          baseline.project_ids.includes(graph.mainGraph.project.id) &&
          baseline.portfolio_ids.includes(graph.portfolio.id) &&
          baseline.secret_ids.includes(jobs.secretMetadata.allowed.id) &&
          baseline.secret_version_ids.includes(jobs.secretVersions.allowed.id),
        "populated schema-3 durable graph and relationships",
        {
          schema_version: baseline.schema_version,
          accounts: baseline.accounts,
          projects: baseline.projects,
          services: baseline.services,
          deployments: baseline.deployments,
          portfolio_revisions: baseline.portfolio_revisions,
          secrets: baseline.secrets,
          secret_versions: baseline.secret_versions,
          jobs: baseline.jobs,
          job_effects: baseline.job_effects,
          audit_events: baseline.audit_events,
          relationship_violations: baseline.relationship_violations,
        },
      );
      return {
        schema_version: baseline.schema_version,
        accounts: baseline.accounts,
        projects: baseline.projects,
        services: baseline.services,
        deployments: baseline.deployments,
        portfolio_revisions: baseline.portfolio_revisions,
        secrets: baseline.secrets,
        secret_versions: baseline.secret_versions,
        jobs: baseline.jobs,
        job_effects: baseline.job_effects,
        audit_events: baseline.audit_events,
        relationship_violations: baseline.relationship_violations,
      };
    },
  );

  await recoveryStep(
    context,
    "M1-RECOVERY-03",
    "a real PostgreSQL-18 pre-upgrade dump is encrypted and independently verified; missing, stale, wrong-key, wrong-target, corrupt, or symlinked evidence fails closed",
    async () => {
      await switchApi(null, null, "quiesce API for pre-upgrade recovery commands", { stopOnly: true });
      const createArgs = [
        "backup",
        "create",
        "--repository",
        repository,
        "--intended-migration",
        String(manifest.target_migration),
      ];
      staleBackup = (await runCli("create-stale-preupgrade", createArgs)).payload;
      assertBackupReceipt(staleBackup, manifest.target_migration, "stale pre-upgrade receipt shape");
      const verified = await runCli(
        "verify-offline-config-independent",
        ["backup", "verify", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
        {
          environmentOverrides: {
            HOSTLET_API_BIND: "invalid-unused-bind",
            HOSTLET_WORKER_BIND: "invalid-unused-bind",
          },
          removeEnvironment: ["DATABASE_URL"],
        },
      );
      expectScenario(
        JSON.stringify(verified.payload) === JSON.stringify(staleBackup),
        "verified receipt equals created receipt",
        { exact_receipt_match: false },
      );
      await runCli("upgrade-without-selected-backup", ["migrate"], {
        expectedErrorCode: "populated_upgrade_requires_verified_backup",
      });

      const wrongKey = randomBytes(32).toString("hex");
      context.registerSensitiveValues([wrongKey]);
      await runCli(
        "verify-wrong-recovery-key",
        ["backup", "verify", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
        {
          expectedErrorCode: "backup_recovery_key_mismatch",
          environmentOverrides: { HOSTLET_RECOVERY_KEY: wrongKey },
          removeEnvironment: ["DATABASE_URL"],
        },
      );

      const paths = backupPaths(repository, staleBackup.manifest.backup_id);
      const originalArtifact = readFileSync(paths.artifact);
      const originalReceipt = readFileSync(paths.receipt);
      try {
        writeFileSync(paths.artifact, tamperCiphertext(originalArtifact), { mode: 0o600 });
        await runCli(
          "verify-corrupt-ciphertext",
          ["backup", "verify", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
          { expectedErrorCode: "backup_encrypted_digest_mismatch", removeEnvironment: ["DATABASE_URL"] },
        );
        await runCli(
          "restore-corrupt-ciphertext",
          ["restore", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
          {
            expectedErrorCode: "backup_encrypted_digest_mismatch",
            environmentOverrides: { HOSTLET_RESTORE_DATABASE_URL: postgres.recoveryDatabaseUrl },
            removeEnvironment: ["DATABASE_URL"],
          },
        );
      } finally {
        writeFileSync(paths.artifact, originalArtifact, { mode: 0o600 });
      }
      try {
        const tampered = JSON.parse(originalReceipt.toString("utf8"));
        tampered.manifest.plaintext_sha256 = "0".repeat(64);
        writeFileSync(paths.receipt, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
        await runCli(
          "verify-tampered-manifest",
          ["backup", "verify", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
          { expectedErrorCode: "backup_metadata_mismatch", removeEnvironment: ["DATABASE_URL"] },
        );
      } finally {
        writeFileSync(paths.receipt, originalReceipt, { mode: 0o600 });
      }

      const sentinel = join(context.tempDir, "recovery-symlink-sentinel");
      const sentinelValue = "owned-e2e-sentinel-unchanged\n";
      writeFileSync(sentinel, sentinelValue, { mode: 0o600 });
      const heldReceipt = `${paths.receipt}.e2e-original`;
      renameSync(paths.receipt, heldReceipt);
      try {
        symlinkSync(sentinel, paths.receipt);
        await runCli(
          "verify-symlinked-receipt",
          ["backup", "verify", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
          { expectedErrorCode: "backup_receipt_invalid", removeEnvironment: ["DATABASE_URL"] },
        );
        expectScenario(readFileSync(sentinel, "utf8") === sentinelValue, "receipt symlink sentinel unchanged", {
          sentinel_unchanged: false,
        });
      } finally {
        try { unlinkSync(paths.receipt); } catch {}
        renameSync(heldReceipt, paths.receipt);
      }
      const heldArtifact = `${paths.artifact}.e2e-original`;
      renameSync(paths.artifact, heldArtifact);
      try {
        symlinkSync(sentinel, paths.artifact);
        await runCli(
          "verify-symlinked-artifact",
          ["backup", "verify", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
          { expectedErrorCode: "backup_artifact_invalid", removeEnvironment: ["DATABASE_URL"] },
        );
        expectScenario(readFileSync(sentinel, "utf8") === sentinelValue, "artifact symlink sentinel unchanged", {
          sentinel_unchanged: false,
        });
      } finally {
        try { unlinkSync(paths.artifact); } catch {}
        renameSync(heldArtifact, paths.artifact);
      }

      await context.delay((manifest.backup_max_age_seconds + 0.5) * 1000);
      await runCli(
        "stale-preupgrade-refused",
        ["migrate", "--repository", repository, "--backup-id", staleBackup.manifest.backup_id],
        {
          expectedErrorCode: "backup_stale",
          environmentOverrides: {
            HOSTLET_BACKUP_MAX_AGE_SECONDS: String(manifest.backup_max_age_seconds),
          },
        },
      );

      const wrongDatabase = `hostlet_wrong_${context.state.runId.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(-30)}`;
      const wrongRepository = join(context.tempDir, "wrong-target-repository");
      mkdirSync(wrongRepository, { recursive: true, mode: 0o700 });
      await postgres.createDatabase(wrongDatabase);
      try {
        await runCli("wrong-target-initialize", ["migrate"], {
          binary: retainedApiBinary,
          environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(wrongDatabase) },
        });
        const wrongReceipt = (
          await runCli(
            "wrong-target-backup",
            [
              "backup",
              "create",
              "--repository",
              wrongRepository,
              "--intended-migration",
              String(manifest.target_migration),
            ],
            { environmentOverrides: { DATABASE_URL: postgres.databaseUrlFor(wrongDatabase) } },
          )
        ).payload;
        await runCli(
          "wrong-target-upgrade-refused",
          ["migrate", "--repository", wrongRepository, "--backup-id", wrongReceipt.manifest.backup_id],
          { expectedErrorCode: "backup_database_identity_mismatch" },
        );
      } finally {
        await postgres.dropDatabase(wrongDatabase);
      }

      upgradeBackup = (await runCli("create-fresh-preupgrade", createArgs)).payload;
      assertBackupReceipt(upgradeBackup, manifest.target_migration, "fresh pre-upgrade receipt shape");
      return {
        schema_version: upgradeBackup.manifest.schema_version,
        database_identity_matches: upgradeBackup.manifest.database_identity_id === baseline.database_identity,
        relation_count_entries: Object.keys(upgradeBackup.manifest.relation_counts).length,
        encrypted_payload_bytes: upgradeBackup.encrypted_payload_bytes,
        postgres_server_major: upgradeBackup.manifest.postgres_server_major,
        pg_dump_major: upgradeBackup.manifest.pg_dump_major,
        missing_backup_refused: true,
        stale_backup_refused: true,
        wrong_key_refused: true,
        wrong_target_refused: true,
        corrupt_and_tampered_refused: true,
        symlink_sentinels_preserved: true,
      };
    },
  );

  await recoveryStep(
    context,
    "M1-RECOVERY-04",
    "concurrent real additive migrations serialize around one verified fresh backup and produce schema 4 exactly once without changing populated relationships",
    async () => {
      const args = ["migrate", "--repository", repository, "--backup-id", upgradeBackup.manifest.backup_id];
      const [first, second] = await Promise.all([
        runCli("concurrent-migrate-a", args),
        runCli("concurrent-migrate-b", args),
      ]);
      expectScenario(first.code === 0 && second.code === 0, "concurrent migrations serialize", {
        exit_statuses: [first.code, second.code],
      });
      const upgraded = await readDurableState(postgres, "hostlet_e2e", "recovery-upgraded-state");
      const receiptRows = await postgres.psqlJson(
        "recovery-upgrade-receipt-count",
        `SELECT json_build_object(
           'rows', (SELECT COUNT(*)::int FROM platform_backup_receipts),
           'matching', (SELECT COUNT(*)::int FROM platform_backup_receipts WHERE backup_id='${upgradeBackup.manifest.backup_id}')
         );`,
      );
      expectScenario(
        upgraded.schema_version === 4 &&
          upgraded.minimum_reader_version === 3 &&
          receiptRows.rows === 1 &&
          receiptRows.matching === 1 &&
          upgraded.database_identity === baseline.database_identity &&
          upgraded.relationship_violations === 0 &&
          JSON.stringify(upgraded.account_ids) === JSON.stringify(baseline.account_ids) &&
          JSON.stringify(upgraded.project_ids) === JSON.stringify(baseline.project_ids) &&
          JSON.stringify(upgraded.deployment_ids) === JSON.stringify(baseline.deployment_ids) &&
          JSON.stringify(upgraded.portfolio_ids) === JSON.stringify(baseline.portfolio_ids) &&
          JSON.stringify(upgraded.secret_version_ids) === JSON.stringify(baseline.secret_version_ids) &&
          JSON.stringify(upgraded.job_ids) === JSON.stringify(baseline.job_ids),
        "one additive schema-4 commit preserves populated IDs and relationships",
        {
          schema_version: upgraded.schema_version,
          minimum_reader_version: upgraded.minimum_reader_version,
          recorded_backup_rows: receiptRows.rows,
          relationship_violations: upgraded.relationship_violations,
          stable_selected_ids: false,
        },
      );
      return {
        migration_exit_statuses: [first.code, second.code],
        schema_version: upgraded.schema_version,
        minimum_reader_version: upgraded.minimum_reader_version,
        recorded_backup_rows: receiptRows.rows,
        stable_selected_ids: true,
        relationship_violations: upgraded.relationship_violations,
      };
    },
  );

  await recoveryStep(
    context,
    "M1-RECOVERY-05",
    "current and retained schema-3 binaries read the populated schema-4 database; recovery-key mismatch fails readiness, and writes made by either remain readable after binary rollback without database rewind",
    async () => {
      await switchApi(currentApiBinary, postgres.databaseUrl, "current binary after schema-4 migration", {});
      const currentProject = await call(`/v1/projects/${graph.mainGraph.project.id}`, { token: owner.token });
      assertStatus(currentProject, 200, "current binary reads migrated project");
      const wrongRecoveryKey = randomBytes(32).toString("hex");
      context.registerSensitiveValues([wrongRecoveryKey]);
      await switchApi(currentApiBinary, postgres.databaseUrl, "wrong recovery key readiness probe", {
        expectReady: false,
        environmentOverrides: { HOSTLET_RECOVERY_KEY: wrongRecoveryKey },
      });
      const wrongKeyReady = await call("/readyz");
      assertStatus(wrongKeyReady, 503, "wrong recovery key after verified upgrade");
      await switchApi(currentApiBinary, postgres.databaseUrl, "missing recovery key readiness probe", {
        expectReady: false,
        removeEnvironment: ["HOSTLET_RECOVERY_KEY"],
      });
      const missingKeyReady = await call("/readyz");
      assertStatus(missingKeyReady, 503, "missing recovery key after verified upgrade");
      await switchApi(currentApiBinary, postgres.databaseUrl, "restore recovery key readiness", {});
      const before = await call(`/v1/accounts/${owner.record.id}`, { token: owner.token });
      assertStatus(before, 200, "current binary reads owner before compatibility write");
      const currentWrite = await call(`/v1/accounts/${owner.record.id}`, {
        method: "PATCH",
        token: owner.token,
        headers: { "Idempotency-Key": "m1-recovery-current-write", "If-Match": `"${before.payload.revision}"` },
        body: { display_name: "M1 recovery current-binary write" },
      });
      assertStatus(currentWrite, 200, "current binary compatibility write");

      await switchApi(retainedApiBinary, postgres.databaseUrl, "retained binary rollback compatibility", {});
      const retainedRead = await call(`/v1/accounts/${owner.record.id}`, { token: owner.token });
      assertStatus(retainedRead, 200, "retained binary reads current write");
      expectScenario(
        retainedRead.payload.display_name === currentWrite.payload.display_name &&
          retainedRead.payload.revision === currentWrite.payload.revision,
        "retained binary observes current-binary write",
        { stable_profile: false },
      );
      const retainedProject = await call(`/v1/projects/${graph.mainGraph.project.id}`, { token: owner.token });
      assertStatus(retainedProject, 200, "retained binary reads migrated project");
      const retainedWrite = await call(`/v1/accounts/${owner.record.id}`, {
        method: "PATCH",
        token: owner.token,
        headers: {
          "Idempotency-Key": "m1-recovery-retained-write",
          "If-Match": `"${retainedRead.payload.revision}"`,
        },
        body: { display_name: "M1 recovery retained-binary write" },
      });
      assertStatus(retainedWrite, 200, "retained binary compatibility write");

      await switchApi(currentApiBinary, postgres.databaseUrl, "current binary resumes after rollback probe", {});
      const currentRead = await call(`/v1/accounts/${owner.record.id}`, { token: owner.token });
      assertStatus(currentRead, 200, "current binary reads retained write");
      expectScenario(
        currentRead.payload.display_name === retainedWrite.payload.display_name &&
          currentRead.payload.revision === retainedWrite.payload.revision,
        "current binary observes retained-binary write",
        { stable_profile: false },
      );
      return {
        current_project_status: currentProject.status,
        wrong_recovery_key_readiness_status: wrongKeyReady.status,
        missing_recovery_key_readiness_status: missingKeyReady.status,
        retained_project_status: retainedProject.status,
        current_write_revision: currentWrite.payload.revision,
        retained_write_revision: retainedWrite.payload.revision,
        current_read_after_rollback_status: currentRead.status,
        database_rewinds: 0,
      };
    },
  );

  await recoveryStep(
    context,
    "M1-RECOVERY-06",
    "the verified schema-3 backup restores only into a distinct empty selected database; SQL and owner-scoped APIs recover exact relationships and a restored scoped secret resolves for a fresh live job",
    async () => {
      await switchApi(null, null, "quiesce source API for restore", { stopOnly: true });
      await postgres.createRecoveryDatabase();
      await postgres.psqlCommandDatabase(
        "recovery-occupied-marker",
        postgres.recoveryDatabaseName,
        "CREATE TABLE e2e_occupied(id integer PRIMARY KEY);",
      );
      const restoreArgs = ["restore", "--repository", repository, "--backup-id", upgradeBackup.manifest.backup_id];
      await runCli("occupied-restore-refused", restoreArgs, {
        expectedErrorCode: "restore_target_not_empty",
        environmentOverrides: { HOSTLET_RESTORE_DATABASE_URL: postgres.recoveryDatabaseUrl },
        removeEnvironment: ["DATABASE_URL"],
      });
      await postgres.dropRecoveryDatabase();
      await postgres.createRecoveryDatabase();
      const restoreStarted = Date.now();
      const restore = await runCli("restore-offline-config-independent", restoreArgs, {
        environmentOverrides: {
          HOSTLET_RESTORE_DATABASE_URL: postgres.recoveryDatabaseUrl,
          HOSTLET_API_BIND: "invalid-unused-bind",
          HOSTLET_WORKER_BIND: "invalid-unused-bind",
        },
        removeEnvironment: ["DATABASE_URL"],
      });
      restoreDurationMs = Date.now() - restoreStarted;
      expectScenario(
        exactKeys(restore.payload, [
          "backup_id",
          "database_identity_id",
          "source_target_fingerprint",
          "restored_target_fingerprint",
          "schema_version",
          "restored_at",
        ]) &&
          restore.payload.backup_id === upgradeBackup.manifest.backup_id &&
          restore.payload.database_identity_id === baseline.database_identity &&
          restore.payload.source_target_fingerprint === upgradeBackup.manifest.source_target_fingerprint &&
          restore.payload.restored_target_fingerprint !== restore.payload.source_target_fingerprint &&
          restore.payload.schema_version === 3 &&
          Number.isFinite(Date.parse(restore.payload.restored_at)),
        "restore receipt identifies source and distinct selected target",
        { restore_receipt_valid: false },
      );
      restoredState = await readDurableState(
        postgres,
        postgres.recoveryDatabaseName,
        "recovery-restored-state",
      );
      expectScenario(
        JSON.stringify(restoredState) === JSON.stringify(baseline),
        "restored schema-3 counts, IDs, ownership, and relationships equal backup source",
        {
          schema_version: restoredState.schema_version,
          relationship_violations: restoredState.relationship_violations,
          exact_baseline_match: false,
        },
      );

      await switchApi(retainedApiBinary, postgres.recoveryDatabaseUrl, "retained API against restored database", {});
      const ownerProject = await call(`/v1/projects/${graph.mainGraph.project.id}`, { token: owner.token });
      assertStatus(ownerProject, 200, "owner reads restored project");
      const hiddenProject = await call(`/v1/projects/${graph.mainGraph.project.id}`, { token: other.token });
      assertErrorShape(hiddenProject, 404, "cross-owner restored project hidden");
      const ownerPortfolio = await call(`/v1/portfolio/draft-revisions/${graph.portfolio.id}`, {
        token: owner.token,
      });
      assertStatus(ownerPortfolio, 200, "owner reads restored portfolio");
      const secretPath = `/v1/projects/${jobs.project.id}/services/${jobs.service.id}/secrets/${jobs.secretMetadata.allowed.id}`;
      const ownerSecret = await call(secretPath, { token: owner.token });
      assertStatus(ownerSecret, 200, "owner reads restored secret metadata");
      const hiddenSecret = await call(secretPath, { token: other.token });
      assertErrorShape(hiddenSecret, 404, "cross-owner restored secret hidden");

      const enqueue = await call(`/v1/projects/${jobs.project.id}/jobs`, {
        method: "POST",
        token: owner.token,
        headers: headers(manifest.restored_job.idempotency_key),
        body: {
          kind: "foundation_bookkeeping",
          operation: "build",
          service_id: jobs.service.id,
          source_commit: manifest.restored_job.source_commit,
          secret_version_refs: [
            { service_id: jobs.service.id, secret_version_id: jobs.secretVersions.allowed.id },
          ],
        },
      });
      assertStatus(enqueue, 201, "fresh restored bookkeeping job");
      const workerId = "recovery-restored-worker";
      const lease = await callInternal("/internal/v1/jobs/lease", {
        method: "POST",
        body: { worker_id: workerId, kinds: ["foundation_bookkeeping"] },
      });
      assertStatus(lease, 200, "fresh restored job lease");
      expectScenario(lease.payload?.job?.id === enqueue.payload.id, "fresh restored job selected", {
        selected_expected_job: false,
      });
      const resolved = await callInternalSensitive(
        `/internal/v1/jobs/${enqueue.payload.id}/credentials:resolve`,
        {
          method: "POST",
          body: {
            worker_id: workerId,
            attempt_id: lease.payload.attempt.id,
            fence: lease.payload.attempt.fence,
            secret_version_ids: [jobs.secretVersions.allowed.id],
          },
        },
      );
      assertStatus(resolved, 200, "restored job scoped secret resolution");
      expectScenario(
        resolved.payload?.credentials?.length === 1 &&
          resolved.payload.credentials[0].secret_version_id === jobs.secretVersions.allowed.id &&
          resolved.payload.credentials[0].value === jobs.allowedSecretValue,
        "restored secret exact in-memory value",
        { credential_count: resolved.payload?.credentials?.length ?? 0, exact_value_match: false },
      );
      const complete = await callInternal(`/internal/v1/jobs/${enqueue.payload.id}/complete`, {
        method: "POST",
        body: {
          worker_id: workerId,
          attempt_id: lease.payload.attempt.id,
          fence: lease.payload.attempt.fence,
          outcome: { state: "succeeded", code: "bookkeeping_complete" },
        },
      });
      assertStatus(complete, 200, "restored job bookkeeping completion");
      await switchApi(currentApiBinary, postgres.databaseUrl, "return to upgraded source database", {});
      return {
        occupied_restore_refused: true,
        restored_schema_version: restore.payload.schema_version,
        database_identity_stable: true,
        source_and_target_distinct: true,
        restored_counts_and_ids_match: true,
        relationship_violations: restoredState.relationship_violations,
        owner_read_statuses: [ownerProject.status, ownerPortfolio.status, ownerSecret.status],
        cross_owner_statuses: [hiddenProject.status, hiddenSecret.status],
        restored_job_status: enqueue.status,
        restored_secret_exact_in_memory_match: true,
      };
    },
  );

  await recoveryStep(
    context,
    "M1-RECOVERY-07",
    "the real hourly scheduler deduplicates a scheduling hour and enforces 48-hour plus seven-daily retention only after authenticating repository inputs while preserving manual backups",
    async () => {
      const base = new Date();
      base.setUTCHours(0, 0, 0, 0);
      return runRetentionScenarios({
        context,
        repository,
        manualBackupIds: [staleBackup.manifest.backup_id, upgradeBackup.manifest.backup_id],
        runCli,
        effectiveBase: base.toISOString(),
        fixture: manifest,
      });
    },
  );

  await recoveryStep(
    context,
    "M1-RECOVERY-08",
    "observed snapshot data age and real restore duration are recorded against the one-hour loss and four-hour recovery targets without claiming an availability guarantee",
    async () => {
      const snapshotAt = Date.parse(upgradeBackup.manifest.snapshot_at);
      const observedAt = Date.parse(new Date().toISOString());
      const dataAgeSeconds = Math.max(0, Math.floor((observedAt - snapshotAt) / 1000));
      const restoreSeconds = restoreDurationMs / 1000;
      expectScenario(
        Number.isFinite(dataAgeSeconds) &&
          dataAgeSeconds <= 3600 &&
          Number.isFinite(restoreSeconds) &&
          restoreSeconds <= 4 * 3600,
        "observed recovery objectives within M1 targets",
        {
          observed_data_age_seconds: dataAgeSeconds,
          observed_restore_seconds: restoreSeconds,
          data_age_target_seconds: 3600,
          restore_target_seconds: 14400,
        },
      );
      return {
        observed_data_age_seconds: dataAgeSeconds,
        observed_restore_seconds: restoreSeconds,
        data_age_target_seconds: 3600,
        restore_target_seconds: 14400,
        accelerated_scheduler_clock: true,
        availability_guarantee_claimed: false,
        restored_schema_version: restoredState.schema_version,
      };
    },
  );
}
