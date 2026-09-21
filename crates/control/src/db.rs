use std::{collections::HashMap, time::Duration};

use sqlx::{
    ConnectOptions, Connection, PgConnection, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};

pub const READER_SCHEMA_VERSION: i64 = 4;
pub(crate) const HOSTLET_MIGRATION_LOCK: i64 = 0x484f_5354_4c45_5401;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

const REQUIRED_RELATIONS: &[&str] = &[
    "public.database_identity",
    "public.platform_schema_compatibility",
    "public.accounts",
    "public.password_identities",
    "public.sessions",
    "public.audit_events",
    "public.idempotency_records",
    "public.projects",
    "public.configuration_revisions",
    "public.repositories",
    "public.repository_configurations",
    "public.services",
    "public.service_configurations",
    "public.deployments",
    "public.deployment_artifact_refs",
    "public.hosting_state_events",
    "public.project_lifecycle_intents",
    "public.portfolio_draft_revisions",
    "public.portfolio_project_references",
    "public.secrets",
    "public.secret_versions",
    "public.jobs",
    "public.job_attempts",
    "public.job_secret_refs",
    "public.job_effects",
    "public.platform_backup_receipts",
];

pub fn lazy_pool(database_url: &str) -> Result<PgPool, sqlx::Error> {
    let options = database_url
        .parse::<PgConnectOptions>()?
        .disable_statement_logging();
    Ok(PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(2))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET search_path = public, pg_temp")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET statement_timeout = '5s'")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET lock_timeout = '5s'")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect_lazy_with(options))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaProblem {
    DatabaseUnavailable,
    MissingMigrationLedger,
    PendingMigration,
    ChangedMigration,
    FailedMigration,
    MissingCompatibility,
    IncompatibleReader,
    InvalidCompatibility,
    InvalidMigrationOrder,
    IncompleteSchema,
}

impl SchemaProblem {
    pub fn readiness_reason(self) -> &'static str {
        match self {
            Self::DatabaseUnavailable => "database_unavailable",
            Self::MissingMigrationLedger => "schema_uninitialized",
            Self::PendingMigration => "schema_migration_pending",
            Self::ChangedMigration => "schema_checksum_changed",
            Self::FailedMigration => "schema_migration_failed",
            Self::MissingCompatibility => "schema_compatibility_missing",
            Self::IncompatibleReader => "schema_reader_incompatible",
            Self::InvalidCompatibility => "schema_compatibility_invalid",
            Self::InvalidMigrationOrder => "schema_migration_order_invalid",
            Self::IncompleteSchema => "schema_objects_missing",
        }
    }
}

pub struct SchemaPrefix {
    pub database_identity_id: uuid::Uuid,
    pub current_version: i64,
    pub minimum_reader_version: i64,
    pub pending_versions: Vec<i64>,
}

pub async fn check_schema(pool: &PgPool) -> Result<(), SchemaProblem> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| SchemaProblem::DatabaseUnavailable)?;
    let prefix = inspect_prefix(&mut connection).await?;
    if !prefix.pending_versions.is_empty() {
        return Err(SchemaProblem::PendingMigration);
    }
    Ok(())
}

/// Inspect an existing, contiguous migration prefix without requiring pending
/// additive migrations. Recovery uses this on the same snapshot connection.
pub(crate) async fn inspect_schema_prefix(
    connection: &mut PgConnection,
) -> Result<SchemaPrefix, MigrationCommandError> {
    inspect_prefix(connection)
        .await
        .map_err(|problem| MigrationCommandError::new(problem.readiness_reason()))
}

async fn inspect_prefix(connection: &mut PgConnection) -> Result<SchemaPrefix, SchemaProblem> {
    if !embedded_migrations_are_ordered() {
        return Err(SchemaProblem::InvalidMigrationOrder);
    }
    let ledger_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| SchemaProblem::DatabaseUnavailable)?;
    if !ledger_exists {
        return Err(SchemaProblem::MissingMigrationLedger);
    }
    let applied: Vec<(i64, Vec<u8>, bool)> = sqlx::query_as(
        "SELECT version, checksum, success FROM public._sqlx_migrations ORDER BY version",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| SchemaProblem::DatabaseUnavailable)?;
    if applied.is_empty() || !applied_migrations_are_ordered(&applied) {
        return Err(SchemaProblem::InvalidMigrationOrder);
    }
    if applied.iter().any(|(_, _, success)| !success) {
        return Err(SchemaProblem::FailedMigration);
    }
    let applied_by_version: HashMap<_, _> = applied
        .iter()
        .map(|(version, checksum, _)| (*version, checksum.as_slice()))
        .collect();
    let mut pending_versions = Vec::new();
    for migration in MIGRATOR.iter() {
        match applied_by_version.get(&migration.version) {
            Some(checksum) if *checksum == migration.checksum.as_ref() => {}
            Some(_) => return Err(SchemaProblem::ChangedMigration),
            None => pending_versions.push(migration.version),
        }
    }
    let compatibility: Option<(i64, i64)> = sqlx::query_as(
        "SELECT current_version, min_reader_version FROM public.platform_schema_compatibility WHERE singleton = true"
    ).fetch_optional(&mut *connection).await.map_err(|error| if error.as_database_error().and_then(|db| db.code()).as_deref() == Some("42P01") { SchemaProblem::MissingCompatibility } else { SchemaProblem::DatabaseUnavailable })?;
    let Some((current_version, minimum_reader_version)) = compatibility else {
        return Err(SchemaProblem::MissingCompatibility);
    };
    let maximum_applied = applied
        .last()
        .map(|(version, _, _)| *version)
        .unwrap_or_default();
    if current_version != maximum_applied
        || minimum_reader_version <= 0
        || minimum_reader_version > current_version
    {
        return Err(SchemaProblem::InvalidCompatibility);
    }
    if minimum_reader_version > READER_SCHEMA_VERSION {
        return Err(SchemaProblem::IncompatibleReader);
    }
    let relation_count = match current_version {
        1 => 7,
        2 => 19,
        3 => 25,
        _ => REQUIRED_RELATIONS.len(),
    };
    let relations_present: bool = sqlx::query_scalar(
        "SELECT bool_and(to_regclass(name) IS NOT NULL) FROM unnest($1::text[]) AS name",
    )
    .bind(&REQUIRED_RELATIONS[..relation_count])
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| SchemaProblem::DatabaseUnavailable)?;
    if !relations_present {
        return Err(SchemaProblem::IncompleteSchema);
    }
    let database_identity_id: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM public.database_identity WHERE singleton = true")
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| {
                if error
                    .as_database_error()
                    .and_then(|db| db.code())
                    .as_deref()
                    == Some("42P01")
                {
                    SchemaProblem::IncompleteSchema
                } else {
                    SchemaProblem::DatabaseUnavailable
                }
            })?;
    Ok(SchemaPrefix {
        database_identity_id: database_identity_id.ok_or(SchemaProblem::IncompleteSchema)?,
        current_version,
        minimum_reader_version,
        pending_versions,
    })
}

pub struct MigrationCommandError {
    code: &'static str,
}

impl std::fmt::Debug for MigrationCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MigrationCommandError")
            .field("code", &self.code)
            .finish()
    }
}

impl std::fmt::Display for MigrationCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "migration failed: {}", self.code)
    }
}

impl std::error::Error for MigrationCommandError {}

impl MigrationCommandError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

pub struct UpgradeBackup<'a> {
    pub selection: crate::recovery::BackupSelection<'a>,
    pub key: &'a crate::recovery::RecoveryKey,
    pub maximum_age: Duration,
}

/// Initialize an explicitly selected empty database, or perform a serialized
/// additive upgrade only after authenticating a fresh backup of this database.
pub async fn run_migrations(
    database_url: &str,
    upgrade_backup: Option<UpgradeBackup<'_>>,
) -> Result<(), MigrationCommandError> {
    if !embedded_migrations_are_ordered() {
        return Err(MigrationCommandError::new(
            "embedded_migration_order_invalid",
        ));
    }
    let options = database_url
        .parse::<PgConnectOptions>()
        .map_err(|_| MigrationCommandError::new("invalid_database_configuration"))?
        .disable_statement_logging();
    let mut connection = tokio::time::timeout(
        Duration::from_secs(10),
        PgConnection::connect_with(&options),
    )
    .await
    .map_err(|_| MigrationCommandError::new("database_connect_timeout"))?
    .map_err(|_| MigrationCommandError::new("database_unavailable"))?;
    sqlx::raw_sql("SET search_path = public, pg_temp; SET statement_timeout = '120s'; SET lock_timeout = '30s'")
        .execute(&mut connection)
        .await
        .map_err(|_| MigrationCommandError::new("database_configuration_failed"))?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(HOSTLET_MIGRATION_LOCK)
        .execute(&mut connection)
        .await
        .map_err(|_| MigrationCommandError::new("migration_lock_failed"))?;
    let ledger_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(&mut connection)
            .await
            .map_err(|_| MigrationCommandError::new("schema_inspection_failed"))?;
    if !ledger_exists {
        if database_has_user_objects(&mut connection).await? {
            return Err(MigrationCommandError::new("initial_database_not_empty"));
        }
        let mut transaction = connection
            .begin()
            .await
            .map_err(|_| MigrationCommandError::new("migration_transaction_failed"))?;
        MIGRATOR
            .run(&mut *transaction)
            .await
            .map_err(|_| MigrationCommandError::new("migration_apply_failed"))?;
        inspect_schema_prefix(&mut transaction).await?;
        transaction
            .commit()
            .await
            .map_err(|_| MigrationCommandError::new("migration_commit_failed"))?;
        return Ok(());
    }
    let prefix = inspect_schema_prefix(&mut connection).await?;
    if prefix.pending_versions.is_empty() {
        return Ok(());
    }
    // Each populated upgrade has one explicit intended migration and backup.
    if prefix.pending_versions != [prefix.current_version + 1] {
        return Err(MigrationCommandError::new(
            "populated_upgrade_requires_single_additive_step",
        ));
    }
    let backup = upgrade_backup
        .ok_or_else(|| MigrationCommandError::new("populated_upgrade_requires_verified_backup"))?;
    let verified = crate::recovery::verify_upgrade_for_locked_database(
        &mut connection,
        backup.selection,
        backup.key,
        crate::recovery::UpgradeExpectation {
            source_schema_version: prefix.current_version,
            intended_migration: prefix.pending_versions[0],
            maximum_age: chrono::Duration::from_std(backup.maximum_age)
                .map_err(|_| MigrationCommandError::new("backup_maximum_age_invalid"))?,
        },
    )
    .await
    .map_err(|error| MigrationCommandError::new(error.code()))?;
    // SQLx migrations are transactional. There is no reset, schema rollback,
    // automatic restore, or destructive retry path.
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| MigrationCommandError::new("migration_transaction_failed"))?;
    MIGRATOR
        .run(&mut *transaction)
        .await
        .map_err(|_| MigrationCommandError::new("migration_apply_failed"))?;
    crate::recovery::record_verified_upgrade(&mut transaction, &verified)
        .await
        .map_err(|error| MigrationCommandError::new(error.code()))?;
    inspect_schema_prefix(&mut transaction).await?;
    transaction
        .commit()
        .await
        .map_err(|_| MigrationCommandError::new("migration_commit_failed"))?;
    Ok(())
}

fn embedded_migrations_are_ordered() -> bool {
    let mut expected = 1;
    for migration in MIGRATOR.iter() {
        if migration.version != expected || !migration.migration_type.is_up_migration() {
            return false;
        }
        expected += 1;
    }
    expected - 1 == READER_SCHEMA_VERSION && READER_SCHEMA_VERSION > 0
}

fn applied_migrations_are_ordered(applied: &[(i64, Vec<u8>, bool)]) -> bool {
    applied
        .iter()
        .enumerate()
        .all(|(index, (version, _, _))| *version == index as i64 + 1)
}

pub(crate) async fn database_has_user_objects(
    connection: &mut PgConnection,
) -> Result<bool, MigrationCommandError> {
    sqlx::query_scalar(
        "SELECT EXISTS (\
            SELECT 1 FROM pg_class c \
            JOIN pg_namespace n ON n.oid = c.relnamespace \
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
              AND n.nspname !~ '^pg_(toast|temp)' \
              AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')\
        ) OR EXISTS (\
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
              AND n.nspname !~ '^pg_(toast|temp)'\
        ) OR EXISTS (\
            SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
              AND n.nspname !~ '^pg_(toast|temp)'\
        )",
    )
    .fetch_one(connection)
    .await
    .map_err(|_| MigrationCommandError::new("schema_inspection_failed"))
}
