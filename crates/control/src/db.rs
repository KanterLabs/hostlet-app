use std::{collections::HashMap, time::Duration};

use sqlx::{
    ConnectOptions, Connection, PgConnection, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};

pub const READER_SCHEMA_VERSION: i64 = 2;
const HOSTLET_MIGRATION_LOCK: i64 = 0x484f_5354_4c45_5401;

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

pub async fn check_schema(pool: &PgPool) -> Result<(), SchemaProblem> {
    if !embedded_migrations_are_ordered() {
        return Err(SchemaProblem::InvalidMigrationOrder);
    }
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| SchemaProblem::DatabaseUnavailable)?;

    let ledger_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| SchemaProblem::DatabaseUnavailable)?;
    if !ledger_exists {
        return Err(SchemaProblem::MissingMigrationLedger);
    }

    let applied: Vec<(i64, Vec<u8>, bool)> =
        sqlx::query_as("SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| SchemaProblem::DatabaseUnavailable)?;
    if !applied_migrations_are_ordered(&applied) {
        return Err(SchemaProblem::InvalidMigrationOrder);
    }
    if applied.iter().any(|(_, _, success)| !success) {
        return Err(SchemaProblem::FailedMigration);
    }
    let applied_by_version: HashMap<_, _> = applied
        .iter()
        .map(|(version, checksum, _)| (*version, checksum.as_slice()))
        .collect();
    for migration in MIGRATOR.iter() {
        let Some(checksum) = applied_by_version.get(&migration.version) else {
            return Err(SchemaProblem::PendingMigration);
        };
        if *checksum != migration.checksum.as_ref() {
            return Err(SchemaProblem::ChangedMigration);
        }
    }

    let compatibility: Option<(i64, i64)> = sqlx::query_as(
        "SELECT current_version, min_reader_version \
         FROM platform_schema_compatibility WHERE singleton = true",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| SchemaProblem::MissingCompatibility)?;
    let Some((current_version, minimum_reader)) = compatibility else {
        return Err(SchemaProblem::MissingCompatibility);
    };
    let maximum_applied = applied
        .last()
        .map(|(version, _, _)| *version)
        .unwrap_or_default();
    if current_version != maximum_applied || minimum_reader <= 0 || minimum_reader > current_version
    {
        return Err(SchemaProblem::InvalidCompatibility);
    }
    if minimum_reader > READER_SCHEMA_VERSION {
        return Err(SchemaProblem::IncompatibleReader);
    }
    // A ledger alone is not proof that a partial restore or manual operation
    // left the application's relations and immutable identity intact.
    let relations_present: bool = sqlx::query_scalar(
        "SELECT bool_and(to_regclass(name) IS NOT NULL) FROM unnest($1::text[]) AS name",
    )
    .bind(REQUIRED_RELATIONS)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| SchemaProblem::DatabaseUnavailable)?;
    if !relations_present {
        return Err(SchemaProblem::IncompleteSchema);
    }
    let identity_present: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM database_identity WHERE singleton = true AND id IS NOT NULL)",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| SchemaProblem::IncompleteSchema)?;
    if !identity_present {
        return Err(SchemaProblem::IncompleteSchema);
    }
    Ok(())
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
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

/// Initialize an explicitly selected empty database, or verify an already
/// initialized compatible database. Populated upgrades remain closed until
/// HOST-218 provides a verified encrypted backup receipt.
pub async fn run_migrations(database_url: &str) -> Result<(), MigrationCommandError> {
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
    sqlx::raw_sql("SET statement_timeout = '120s'; SET lock_timeout = '30s'")
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
        MIGRATOR
            .run(&mut connection)
            .await
            .map_err(|_| MigrationCommandError::new("migration_apply_failed"))?;
        return Ok(());
    }

    let applied: Vec<(i64, Vec<u8>, bool)> =
        sqlx::query_as("SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut connection)
            .await
            .map_err(|_| MigrationCommandError::new("schema_inspection_failed"))?;
    if !applied_migrations_are_ordered(&applied) {
        return Err(MigrationCommandError::new("migration_order_invalid"));
    }
    if applied.iter().any(|(_, _, success)| !success) {
        return Err(MigrationCommandError::new("failed_migration_present"));
    }
    let applied_by_version: HashMap<_, _> = applied
        .iter()
        .map(|(version, checksum, _)| (*version, checksum.as_slice()))
        .collect();
    let mut pending = false;
    for migration in MIGRATOR.iter() {
        match applied_by_version.get(&migration.version) {
            Some(checksum) if *checksum == migration.checksum.as_ref() => {}
            Some(_) => return Err(MigrationCommandError::new("migration_checksum_changed")),
            None => pending = true,
        }
    }
    if pending {
        return Err(MigrationCommandError::new(
            "populated_upgrade_requires_verified_backup",
        ));
    }

    let current: Option<(i64, i64)> = sqlx::query_as(
        "SELECT current_version, min_reader_version \
         FROM platform_schema_compatibility WHERE singleton = true",
    )
    .fetch_optional(&mut connection)
    .await
    .map_err(|_| MigrationCommandError::new("schema_compatibility_missing"))?;
    let Some((current_version, minimum_reader)) = current else {
        return Err(MigrationCommandError::new("schema_compatibility_missing"));
    };
    let maximum_applied = applied
        .last()
        .map(|(version, _, _)| *version)
        .unwrap_or_default();
    if current_version != maximum_applied
        || minimum_reader <= 0
        || minimum_reader > current_version
        || minimum_reader > READER_SCHEMA_VERSION
    {
        return Err(MigrationCommandError::new("schema_reader_incompatible"));
    }
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

async fn database_has_user_objects(
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
