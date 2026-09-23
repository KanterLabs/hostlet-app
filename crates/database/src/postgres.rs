use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{control::Credential, worker::Failure};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_CAPTURE: usize = 1024 * 1024;
const OWNER_SCOPE: &str = "m3-e2e";

#[derive(Clone)]
pub struct DockerPostgres {
    state_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inventory {
    schema_version: u32,
    run_id: Uuid,
    targets: Vec<Target>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub recovery_id: Option<Uuid>,
    pub container_id: String,
    pub restore_target: bool,
    pub endpoint_ipv4: String,
    pub endpoint_ipv6: String,
}

#[derive(Debug, Serialize)]
pub struct EndpointProof {
    pub container_id: String,
    pub run_id: Uuid,
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub restore_target: bool,
    pub endpoint_ipv4: String,
    pub endpoint_ipv6: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy)]
pub struct RoleSet<'a> {
    pub runtime: &'a Credential,
    pub migration: &'a Credential,
    pub backup: &'a Credential,
}

impl DockerPostgres {
    pub fn from_environment() -> Result<Self, Failure> {
        let path = std::env::var_os("HOSTLET_M3_STATE_DIR")
            .map(PathBuf::from)
            .ok_or(Failure::Configuration)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| Failure::Configuration)?;
        if !path.is_absolute()
            || !metadata.is_dir()
            || metadata.permissions().mode() & 0o077 != 0
            || fs::canonicalize(&path).ok().as_ref() != Some(&path)
        {
            return Err(Failure::Configuration);
        }
        Ok(Self { state_dir: path })
    }

    pub fn primary(
        &self,
        database_id: Uuid,
        generation: Uuid,
    ) -> Result<(Target, EndpointProof), Failure> {
        self.target(database_id, generation, None, false)
    }

    pub fn replacement(
        &self,
        database_id: Uuid,
        generation: Uuid,
        recovery_id: Uuid,
    ) -> Result<(Target, EndpointProof), Failure> {
        self.target(database_id, generation, Some(recovery_id), true)
    }

    fn target(
        &self,
        database_id: Uuid,
        generation: Uuid,
        recovery_id: Option<Uuid>,
        restore: bool,
    ) -> Result<(Target, EndpointProof), Failure> {
        let inventory = self.inventory()?;
        let matches: Vec<_> = inventory
            .targets
            .iter()
            .filter(|item| {
                item.tenant_database_id == database_id
                    && item.database_generation == generation
                    && item.recovery_id == recovery_id
                    && item.restore_target == restore
            })
            .collect();
        if matches.len() != 1 {
            return Err(Failure::Postgres("tenant_target_unavailable"));
        }
        let target = matches[0].clone();
        self.verify_target(inventory.run_id, &target)?;
        let proof = EndpointProof {
            container_id: target.container_id.clone(),
            run_id: inventory.run_id,
            tenant_database_id: database_id,
            database_generation: generation,
            restore_target: restore,
            endpoint_ipv4: target.endpoint_ipv4.clone(),
            endpoint_ipv6: target.endpoint_ipv6.clone(),
            port: 5432,
        };
        Ok((target, proof))
    }

    fn inventory(&self) -> Result<Inventory, Failure> {
        let path = self.state_dir.join("database-inventory.json");
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| Failure::Postgres("tenant_inventory_unavailable"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.len() > 1024 * 1024
            || fs::canonicalize(&path).ok().as_ref() != Some(&path)
        {
            return Err(Failure::Postgres("tenant_inventory_invalid"));
        }
        let inventory: Inventory = serde_json::from_slice(
            &fs::read(path).map_err(|_| Failure::Postgres("tenant_inventory_unavailable"))?,
        )
        .map_err(|_| Failure::Postgres("tenant_inventory_invalid"))?;
        if inventory.schema_version != 1 || inventory.targets.len() > 128 {
            return Err(Failure::Postgres("tenant_inventory_invalid"));
        }
        let mut unique = std::collections::HashSet::new();
        for item in &inventory.targets {
            if !valid_container_id(&item.container_id)
                || !valid_ip(&item.endpoint_ipv4, false)
                || !valid_ip(&item.endpoint_ipv6, true)
                || !unique.insert((
                    item.tenant_database_id,
                    item.database_generation,
                    item.recovery_id,
                    item.restore_target,
                ))
                || item.restore_target != item.recovery_id.is_some()
            {
                return Err(Failure::Postgres("tenant_inventory_invalid"));
            }
        }
        Ok(inventory)
    }

    fn verify_target(&self, run_id: Uuid, target: &Target) -> Result<(), Failure> {
        let format = "{{.Id}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{index .Config.Labels \"io.hostlet.scope\"}}|{{index .Config.Labels \"io.hostlet.run-id\"}}|{{index .Config.Labels \"io.hostlet.resource\"}}|{{index .Config.Labels \"io.hostlet.database-id\"}}|{{index .Config.Labels \"io.hostlet.database-generation\"}}|{{index .Config.Labels \"io.hostlet.restore-target\"}}";
        let output = run_capture(
            Command::new("docker").args(["inspect", "--format", format, &target.container_id]),
            COMMAND_TIMEOUT,
        )?;
        let expected = format!(
            "{}|true|none|{}|{}|tenant-postgres|{}|{}|{}",
            target.container_id,
            OWNER_SCOPE,
            run_id,
            target.tenant_database_id,
            target.database_generation,
            target.restore_target
        );
        if output.trim() != expected {
            return Err(Failure::Postgres("tenant_target_identity_mismatch"));
        }
        let version = self.capture(target, ["postgres", "--version"], None)?;
        if !version.starts_with("postgres (PostgreSQL) 18.")
            && !version.starts_with("postgres (PostgreSQL) 18beta")
        {
            return Err(Failure::Postgres("postgres_major_mismatch"));
        }
        Ok(())
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the provisioning boundary binds every database, credential, limit, and grant identity explicitly"
    )]
    pub fn provision(
        &self,
        target: &Target,
        database_id: Uuid,
        generation: Uuid,
        roles: RoleSet<'_>,
        connection_limit: i32,
        storage_limit_bytes: u64,
        grant_plan: &str,
    ) -> Result<String, Failure> {
        if !(1..=100).contains(&connection_limit)
            || storage_limit_bytes != 1024 * 1024 * 1024
            || grant_plan != "hostlet.tenant-grants/v1"
        {
            return Err(Failure::Postgres("grant_plan_invalid"));
        }
        validate_role_set(database_id, &roles)?;
        let database = database_name(database_id);
        let runtime = role_name("app", roles.runtime.role_ref);
        let migration = role_name("migration", roles.migration.role_ref);
        let backup = role_name("backup", roles.backup.role_ref);
        self.assert_cluster_scope(target, Some(&database), [&runtime, &migration, &backup])?;
        let roles_sql = format!(
            r#"
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname={runtime_lit}) THEN CREATE ROLE {runtime} LOGIN PASSWORD {runtime_password}; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname={migration_lit}) THEN CREATE ROLE {migration} LOGIN PASSWORD {migration_password}; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname={backup_lit}) THEN CREATE ROLE {backup} LOGIN PASSWORD {backup_password}; END IF;
END $$;
ALTER ROLE {runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT {connection_limit};
ALTER ROLE {migration} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
ALTER ROLE {backup} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
ALTER ROLE {runtime} SET search_path=app,pg_catalog;
ALTER ROLE {migration} SET search_path=app,pg_catalog;
ALTER ROLE {backup} SET search_path=app,pg_catalog;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SELECT format('CREATE DATABASE %I OWNER %I', {database_lit}, {migration_lit})
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname={database_lit}) \gexec
REVOKE CONNECT ON DATABASE {database} FROM PUBLIC;
GRANT CONNECT ON DATABASE {database} TO {runtime}, {migration}, {backup};
"#,
            runtime_lit = literal(&runtime),
            migration_lit = literal(&migration),
            backup_lit = literal(&backup),
            database_lit = literal(&database),
            runtime_password = literal(&roles.runtime.value),
            migration_password = literal(&roles.migration.value),
            backup_password = literal(&roles.backup.value)
        );
        self.psql_admin(target, "postgres", &roles_sql)?;
        let identity = format!("{}:{}", database_id, generation);
        let grants_sql = format!(
            r#"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION {migration};
CREATE TABLE IF NOT EXISTS app.hostlet_migration_effects(migration_id uuid PRIMARY KEY,file_digest text NOT NULL,schema_revision text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE app.hostlet_migration_effects OWNER TO {migration};
CREATE TABLE IF NOT EXISTS app.hostlet_fixture_effects(file_digest text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE app.hostlet_fixture_effects OWNER TO {migration};
CREATE SCHEMA IF NOT EXISTS hostlet_control AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA hostlet_control FROM PUBLIC, {runtime}, {migration}, {backup};
CREATE TABLE IF NOT EXISTS hostlet_control.database_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), database_id uuid NOT NULL, generation uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS hostlet_control.storage_policy(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), limit_bytes bigint NOT NULL CHECK(limit_bytes > 0), growth_mode text NOT NULL CHECK(growth_mode IN ('writable','read_only_over_limit')), measured_bytes bigint CHECK(measured_bytes IS NULL OR measured_bytes >= 0), observed_at timestamptz);
REVOKE ALL ON hostlet_control.database_identity FROM PUBLIC, {runtime}, {migration}, {backup};
REVOKE ALL ON hostlet_control.storage_policy FROM PUBLIC, {runtime}, {migration}, {backup};
INSERT INTO hostlet_control.database_identity(singleton,database_id,generation) VALUES(true,{database_id_lit}::uuid,{generation_lit}::uuid)
ON CONFLICT(singleton) DO UPDATE SET database_id=EXCLUDED.database_id WHERE hostlet_control.database_identity.database_id=EXCLUDED.database_id AND hostlet_control.database_identity.generation=EXCLUDED.generation;
INSERT INTO hostlet_control.storage_policy(singleton,limit_bytes,growth_mode) VALUES(true,{storage_limit_bytes},'writable') ON CONFLICT(singleton) DO NOTHING;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM hostlet_control.database_identity WHERE database_id={database_id_lit}::uuid AND generation={generation_lit}::uuid) THEN RAISE EXCEPTION 'identity mismatch'; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM hostlet_control.storage_policy WHERE singleton AND limit_bytes={storage_limit_bytes}) THEN RAISE EXCEPTION 'storage policy mismatch'; END IF; END $$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO {runtime}, {backup};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app TO {runtime};
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA app TO {runtime};
GRANT SELECT ON ALL TABLES IN SCHEMA app TO {backup};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA app TO {backup};
REVOKE ALL ON app.hostlet_migration_effects FROM PUBLIC, {runtime};
GRANT SELECT ON app.hostlet_migration_effects TO {backup};
REVOKE ALL ON app.hostlet_fixture_effects FROM PUBLIC, {runtime};
GRANT SELECT ON app.hostlet_fixture_effects TO {backup};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO {runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO {runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app GRANT SELECT ON TABLES TO {backup};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app GRANT SELECT ON SEQUENCES TO {backup};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
"#,
            database_id_lit = literal(&database_id.to_string()),
            generation_lit = literal(&generation.to_string()),
            storage_limit_bytes = storage_limit_bytes,
        );
        self.psql_admin(target, &database, &grants_sql)?;
        self.assert_role_login(target, &database, &runtime, &roles.runtime.value)?;
        self.assert_role_login(target, &database, &migration, &roles.migration.value)?;
        self.assert_role_login(target, &database, &backup, &roles.backup.value)?;
        self.assert_role_denied(
            target,
            &database,
            &runtime,
            &roles.runtime.value,
            "CREATE TABLE app.hostlet_forbidden_probe(id integer)",
        )?;
        self.assert_role_denied(
            target,
            &database,
            &runtime,
            &roles.runtime.value,
            "SELECT * FROM hostlet_control.database_identity",
        )?;
        let observed_limit = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-c",
                &format!(
                    "SELECT rolconnlimit FROM pg_roles WHERE rolname={}",
                    literal(&runtime)
                ),
            ],
            None,
        )?;
        if observed_limit.trim() != connection_limit.to_string() {
            return Err(Failure::Postgres("grant_validation_failed"));
        }
        Ok(sha256(
            format!("{identity}|{runtime}|{migration}|{backup}|{connection_limit}|{storage_limit_bytes}|{grant_plan}")
                .as_bytes(),
        ))
    }

    pub fn apply_fixture_bootstrap(
        &self,
        target: &Target,
        database_id: Uuid,
        generation: Uuid,
        roles: RoleSet<'_>,
        sql: &[u8],
        file_digest: &str,
    ) -> Result<FixtureBootstrapResult, Failure> {
        validate_role_set(database_id, &roles)?;
        let database = database_name(database_id);
        let runtime = role_name("app", roles.runtime.role_ref);
        let migration = role_name("migration", roles.migration.role_ref);
        let backup = role_name("backup", roles.backup.role_ref);
        self.assert_cluster_scope(target, Some(&database), [&runtime, &migration, &backup])?;
        let identity = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                &database,
                "-c",
                &format!(
                    "SELECT count(*) FROM hostlet_control.database_identity WHERE singleton AND database_id={}::uuid AND generation={}::uuid",
                    literal(&database_id.to_string()),
                    literal(&generation.to_string())
                ),
            ],
            None,
        )?;
        if identity.trim() != "1" {
            return Err(Failure::Postgres("fixture_bootstrap_target_invalid"));
        }
        let lock_hex = file_digest
            .strip_prefix("sha256:")
            .filter(|value| value.len() == 64)
            .ok_or(Failure::Postgres("fixture_bootstrap_invalid"))?;
        let advisory_key = u64::from_str_radix(&lock_hex[..16], 16)
            .map_err(|_| Failure::Postgres("fixture_bootstrap_invalid"))?
            as i64;
        let mut input = format!(
            r#"\set QUIET 1
BEGIN;
SELECT pg_advisory_xact_lock({advisory_key}) AS hostlet_lock \gset
SELECT NOT EXISTS(SELECT 1 FROM app.hostlet_fixture_effects WHERE file_digest={file_digest}) AS hostlet_should_apply \gset
\if :hostlet_should_apply
"#,
            file_digest = literal(file_digest),
        )
        .into_bytes();
        input.extend_from_slice(sql);
        if !input.ends_with(b"\n") {
            input.push(b'\n');
        }
        input.extend_from_slice(
            format!(
                r#"INSERT INTO app.hostlet_fixture_effects(file_digest) VALUES({file_digest});
\echo HOSTLET_FIXTURE_APPLIED
\else
\echo HOSTLET_FIXTURE_ALREADY_APPLIED
\endif
COMMIT;
"#,
                file_digest = literal(file_digest),
            )
            .as_bytes(),
        );
        let env_file = self.password_file(&roles.migration.value)?;
        let mut command = Command::new("docker");
        command
            .args(["exec", "-i", "--env-file"])
            .arg(&env_file)
            .args([
                &target.container_id,
                "psql",
                "-X",
                "--quiet",
                "--file=-",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-U",
                &migration,
                "-d",
                &database,
            ]);
        let mode = run_migration_input(&mut command, &input, COMMAND_TIMEOUT)
            .map_err(|_| Failure::Postgres("fixture_bootstrap_failed"));
        let _ = fs::remove_file(env_file);
        if !matches!(
            mode?.trim(),
            "HOSTLET_FIXTURE_APPLIED" | "HOSTLET_FIXTURE_ALREADY_APPLIED"
        ) {
            return Err(Failure::Postgres("fixture_bootstrap_failed"));
        }
        let readback = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-U",
                &runtime,
                "-d",
                &database,
                "-c",
                "SELECT ((SELECT count(*)=1 FROM app.authors WHERE display_name='Owned Fixture Author') AND (SELECT count(*)=1 FROM app.entries e JOIN app.authors a ON a.id=e.author_id WHERE a.display_name='Owned Fixture Author' AND e.title='First owned entry' AND e.body='Populated relationship used by restore validation') AND (SELECT count(*)=1 FROM app.journal_items WHERE name='Owned populated journal item') AND (SELECT count(*)=1 FROM app.fixture_schema_migrations WHERE revision=1))::int::text||'|4'",
            ],
            Some(&roles.runtime.value),
        )?;
        if readback.trim() != "1|4" {
            return Err(Failure::Postgres("fixture_bootstrap_readback_failed"));
        }
        let applied_at = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                &database,
                "-c",
                &format!(
                    "SELECT to_char(applied_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM app.hostlet_fixture_effects WHERE file_digest={}",
                    literal(file_digest)
                ),
            ],
            None,
        )?;
        if applied_at.trim().is_empty() {
            return Err(Failure::Postgres("fixture_bootstrap_stamp_missing"));
        }
        Ok(FixtureBootstrapResult { populated_rows: 4 })
    }

    pub fn dump(
        &self,
        target: &Target,
        database_id: Uuid,
        backup: &Credential,
        destination: &Path,
    ) -> Result<(), Failure> {
        if backup.purpose != "backup" {
            return Err(Failure::Credential);
        }
        let role = role_name("backup", backup.role_ref);
        let database = database_name(database_id);
        let env_file = self.password_file(&backup.value)?;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(destination)
            .map_err(|_| Failure::Postgres("database_dump_failed"))?;
        let mut command = Command::new("docker");
        command.args(["exec", "--env-file"]).arg(&env_file).args([
            &target.container_id,
            "pg_dump",
            "--host=127.0.0.1",
            "--port=5432",
            "--username",
            &role,
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "--exclude-schema=hostlet_control",
            "--dbname",
            &database,
        ]);
        command.stdout(Stdio::from(file));
        let result = run_status_preserving_stdout(&mut command, COMMAND_TIMEOUT);
        let _ = fs::remove_file(env_file);
        result
    }

    pub fn enforce_storage_limit(
        &self,
        target: &Target,
        database_id: Uuid,
        generation: Uuid,
        roles: RoleSet<'_>,
        storage_limit_bytes: u64,
        observed_at: &str,
    ) -> Result<StorageResult, Failure> {
        if storage_limit_bytes != 1024 * 1024 * 1024 {
            return Err(Failure::Postgres("storage_policy_invalid"));
        }
        validate_role_set(database_id, &roles)?;
        let database = database_name(database_id);
        let runtime = role_name("app", roles.runtime.role_ref);
        let migration = role_name("migration", roles.migration.role_ref);
        let backup = role_name("backup", roles.backup.role_ref);
        self.assert_cluster_scope(target, Some(&database), [&runtime, &migration, &backup])?;
        let snapshot = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                &database,
                "-c",
                &format!(
                    "SELECT pg_database_size(current_database())::text||'|'||growth_mode FROM hostlet_control.storage_policy WHERE singleton AND limit_bytes={storage_limit_bytes} AND EXISTS(SELECT 1 FROM hostlet_control.database_identity WHERE singleton AND database_id={}::uuid AND generation={}::uuid)",
                    literal(&database_id.to_string()),
                    literal(&generation.to_string())
                ),
            ],
            None,
        )?;
        let (bytes, current_mode) = snapshot
            .trim()
            .split_once('|')
            .ok_or(Failure::Postgres("storage_policy_invalid"))?;
        let bytes: u64 = bytes
            .parse()
            .map_err(|_| Failure::Postgres("storage_observation_failed"))?;
        if current_mode != "writable" && current_mode != "read_only_over_limit" {
            return Err(Failure::Postgres("storage_policy_invalid"));
        }
        let frozen = bytes > storage_limit_bytes || current_mode == "read_only_over_limit";
        if frozen {
            self.psql_admin(
                target,
                &database,
                &format!(
                    r#"
BEGIN;
LOCK TABLE hostlet_control.storage_policy IN EXCLUSIVE MODE;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON ALL TABLES IN SCHEMA app FROM {runtime};
REVOKE USAGE,UPDATE ON ALL SEQUENCES IN SCHEMA app FROM {runtime};
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, {runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLES FROM {runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app REVOKE USAGE,UPDATE ON SEQUENCES FROM {runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, {runtime};
ALTER ROLE {migration} NOLOGIN;
UPDATE hostlet_control.storage_policy SET growth_mode='read_only_over_limit',measured_bytes=pg_database_size(current_database()),observed_at={observed_at}::timestamptz WHERE singleton AND limit_bytes={storage_limit_bytes};
COMMIT;
"#,
                    observed_at = literal(observed_at)
                ),
            )?;
            self.psql_admin(
                target,
                "postgres",
                &format!(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname={} AND usename IN ({},{}) AND pid<>pg_backend_pid();",
                    literal(&database),
                    literal(&runtime),
                    literal(&migration)
                ),
            )?;
            self.assert_storage_frozen(target, &database, &runtime, &migration)?;
            self.assert_application_read(target, &database, &runtime, &roles.runtime.value)?;
            self.assert_application_write_denied(
                target,
                &database,
                &runtime,
                &roles.runtime.value,
            )?;
            self.assert_role_denied(
                target,
                &database,
                &migration,
                &roles.migration.value,
                "SELECT 1",
            )?;
        } else {
            self.psql_admin(
                target,
                &database,
                &format!(
                    "UPDATE hostlet_control.storage_policy SET measured_bytes=pg_database_size(current_database()),observed_at={}::timestamptz WHERE singleton AND growth_mode='writable' AND limit_bytes={storage_limit_bytes};",
                    literal(observed_at)
                ),
            )?;
            self.assert_role_login(target, &database, &runtime, &roles.runtime.value)?;
            self.assert_role_login(target, &database, &migration, &roles.migration.value)?;
        }
        self.assert_backup_export(target, &database, &backup, &roles.backup.value)?;
        let final_snapshot = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                &database,
                "-c",
                "SELECT measured_bytes::text||'|'||growth_mode FROM hostlet_control.storage_policy WHERE singleton",
            ],
            None,
        )?;
        let (measured, growth_mode) = final_snapshot
            .trim()
            .split_once('|')
            .ok_or(Failure::Postgres("storage_policy_invalid"))?;
        Ok(StorageResult {
            storage_bytes: measured
                .parse()
                .map_err(|_| Failure::Postgres("storage_observation_failed"))?,
            growth_mode: growth_mode.to_owned(),
            write_denied: frozen,
        })
    }

    pub fn restore(
        &self,
        target: &Target,
        source_database_id: Uuid,
        recovery_id: Uuid,
        archive: &Path,
        roles: RoleSet<'_>,
    ) -> Result<RestoreResult, Failure> {
        if !target.restore_target || target.recovery_id != Some(recovery_id) {
            return Err(Failure::Postgres("restore_target_mismatch"));
        }
        let database = restore_database_name(recovery_id);
        let count = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-c",
                &format!(
                    "SELECT count(*) FROM pg_database WHERE datname={}",
                    literal(&database)
                ),
            ],
            None,
        )?;
        if count.trim() != "0" {
            return Err(Failure::Postgres("restore_target_nonempty"));
        }
        let source_name = database_name(source_database_id);
        if source_name == database {
            return Err(Failure::Postgres("restore_source_reuse"));
        }
        validate_role_set(source_database_id, &roles)?;
        let runtime = role_name("app", roles.runtime.role_ref);
        let migration = role_name("migration", roles.migration.role_ref);
        let backup = role_name("backup", roles.backup.role_ref);
        self.assert_cluster_scope(target, None, ["postgres", "postgres", "postgres"])?;
        let runtime_password = &roles.runtime.value;
        let migration_password = &roles.migration.value;
        let backup_password = &roles.backup.value;
        self.psql_admin(target, "postgres", &format!(r#"
CREATE ROLE {runtime} LOGIN PASSWORD {runtime_password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 10;
CREATE ROLE {migration} LOGIN PASSWORD {migration_password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE {backup} LOGIN PASSWORD {backup_password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
ALTER ROLE {runtime} SET search_path=app,pg_catalog;
ALTER ROLE {migration} SET search_path=app,pg_catalog;
ALTER ROLE {backup} SET search_path=app,pg_catalog;
CREATE DATABASE {database} OWNER {migration};
REVOKE CONNECT ON DATABASE {database} FROM PUBLIC;
GRANT CONNECT ON DATABASE {database} TO {runtime}, {migration}, {backup};
"#, runtime_password=literal(runtime_password), migration_password=literal(migration_password), backup_password=literal(backup_password)))?;
        self.psql_admin(target, &database, &format!(r#"
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO {runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO {runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} GRANT SELECT ON TABLES TO {backup};
ALTER DEFAULT PRIVILEGES FOR ROLE {migration} GRANT SELECT ON SEQUENCES TO {backup};
"#))?;
        let started = Instant::now();
        let archive_file =
            File::open(archive).map_err(|_| Failure::Postgres("restore_archive_unavailable"))?;
        let env_file = self.password_file(migration_password)?;
        let mut command = Command::new("docker");
        command
            .args(["exec", "-i", "--env-file"])
            .arg(&env_file)
            .args([
                &target.container_id,
                "pg_restore",
                "--host=127.0.0.1",
                "--no-owner",
                "--no-privileges",
                "--exit-on-error",
                "--username",
                &migration,
                "--dbname",
                &database,
            ]);
        command.stdin(Stdio::from(archive_file));
        let restore_result = run_status(&mut command, COMMAND_TIMEOUT);
        let _ = fs::remove_file(env_file);
        restore_result?;
        let replacement_identity = Uuid::new_v4();
        self.psql_admin(target, &database, &format!(r#"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO {runtime}, {backup};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app TO {runtime};
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA app TO {runtime};
GRANT SELECT ON ALL TABLES IN SCHEMA app TO {backup};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA app TO {backup};
REVOKE ALL ON app.hostlet_migration_effects FROM PUBLIC, {runtime};
GRANT SELECT ON app.hostlet_migration_effects TO {backup};
REVOKE ALL ON app.hostlet_fixture_effects FROM PUBLIC, {runtime};
GRANT SELECT ON app.hostlet_fixture_effects TO {backup};
CREATE SCHEMA hostlet_control AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA hostlet_control FROM PUBLIC, {runtime}, {migration}, {backup};
CREATE TABLE hostlet_control.database_identity(singleton boolean PRIMARY KEY, replacement_identity uuid NOT NULL, source_database_id uuid NOT NULL, recovery_id uuid NOT NULL);
INSERT INTO hostlet_control.database_identity VALUES(true,{replacement_identity_lit}::uuid,{source_database_lit}::uuid,{recovery_id_lit}::uuid);
REVOKE ALL ON hostlet_control.database_identity FROM PUBLIC, {runtime}, {migration}, {backup};
"#, replacement_identity_lit=literal(&replacement_identity.to_string()), source_database_lit=literal(&source_database_id.to_string()), recovery_id_lit=literal(&recovery_id.to_string())))?;
        let migration_env = self.password_file(migration_password)?;
        let mut probe_create = Command::new("docker");
        probe_create.args(["exec", "--env-file"]).arg(&migration_env).args([&target.container_id,
            "psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", &migration, "-d", &database,
            "-c", "CREATE TABLE app.hostlet_connection_probe(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)"]);
        let probe_result = run_status(&mut probe_create, COMMAND_TIMEOUT);
        let _ = fs::remove_file(migration_env);
        probe_result?;
        let runtime_env = self.password_file(runtime_password)?;
        let mut probe = Command::new("docker");
        probe.args(["exec", "--env-file"]).arg(&runtime_env).args([&target.container_id,
            "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", &runtime, "-d", &database,
            "-c", "INSERT INTO app.hostlet_connection_probe(value) VALUES('fixture-app'); SELECT value FROM app.hostlet_connection_probe WHERE value='fixture-app'"]);
        let probe_result = run_capture(&mut probe, COMMAND_TIMEOUT);
        let _ = fs::remove_file(runtime_env);
        if !probe_result?
            .lines()
            .any(|line| line.trim() == "fixture-app")
        {
            return Err(Failure::Postgres("recovery_application_validation_failed"));
        }
        self.psql_admin(target, &database, "ANALYZE")?;
        let validation = self.capture(target, ["psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", &database, "-c",
            "SELECT json_build_object('relations',(SELECT count(*) FROM information_schema.tables WHERE table_schema='app'),'foreign_keys',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='app' AND c.contype='f'),'populated',(SELECT count(*) FROM pg_stat_user_tables WHERE schemaname='app' AND n_live_tup>0))::text"], None)?;
        let summary: ValidationSummary = serde_json::from_str(validation.trim())
            .map_err(|_| Failure::Postgres("recovery_validation_failed"))?;
        if summary.relations < 2 || summary.foreign_keys < 1 || summary.populated < 2 {
            return Err(Failure::Postgres("recovery_validation_failed"));
        }
        self.assert_role_denied(
            target,
            &database,
            &runtime,
            runtime_password,
            "SELECT * FROM hostlet_control.database_identity",
        )?;
        self.assert_role_denied(
            target,
            &database,
            &runtime,
            runtime_password,
            "CREATE TABLE app.hostlet_forbidden_restore_probe(id integer)",
        )?;
        Ok(RestoreResult {
            replacement_identity,
            relation_count: summary.relations,
            foreign_key_count: summary.foreign_keys,
            populated_relation_count: summary.populated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub fn archive_listing(&self, target: &Target, archive: &Path) -> Result<String, Failure> {
        let archive_file =
            File::open(archive).map_err(|_| Failure::Postgres("restore_archive_unavailable"))?;
        let mut command = Command::new("docker");
        command.args(["exec", "-i", &target.container_id, "pg_restore", "--list"]);
        command.stdin(Stdio::from(archive_file));
        let output = run_capture(&mut command, COMMAND_TIMEOUT)?;
        if output
            .lines()
            .any(|line| line.contains(" ACL ") || line.contains(" DEFAULT ACL "))
        {
            return Err(Failure::Postgres("portable_archive_privileges_present"));
        }
        Ok(sha256(output.as_bytes()))
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the migration boundary binds target, generation, effect, credential, artifact, and schema identities explicitly"
    )]
    pub fn apply_migration(
        &self,
        target: &Target,
        database_id: Uuid,
        database_generation: Uuid,
        recovery_id: Option<Uuid>,
        migration_id: Uuid,
        migration_credential: &Credential,
        sql: &[u8],
        file_digest: &str,
        schema_revision: &str,
    ) -> Result<MigrationApplyResult, Failure> {
        if migration_credential.purpose != "migration"
            || migration_credential.value.is_empty()
            || migration_credential.value.len() > 4096
            || migration_credential
                .value
                .chars()
                .any(|item| matches!(item, '\n' | '\r' | '\0'))
            || migration_id.is_nil()
            || schema_revision.is_empty()
            || schema_revision.len() > 256
            || file_digest.len() != 71
            || !file_digest.starts_with("sha256:")
        {
            return Err(Failure::Postgres("migration_apply_invalid"));
        }
        let database = match recovery_id {
            Some(recovery) if target.restore_target && target.recovery_id == Some(recovery) => {
                restore_database_name(recovery)
            }
            None if !target.restore_target && target.recovery_id.is_none() => {
                database_name(database_id)
            }
            _ => return Err(Failure::Postgres("migration_target_mismatch")),
        };
        let migration = role_name("migration", migration_credential.role_ref);
        let (runtime, backup) = self.discover_application_roles(target, &migration)?;
        self.assert_cluster_scope(target, Some(&database), [&runtime, &migration, &backup])?;
        if recovery_id.is_none() {
            let identity = self.capture(
                target,
                [
                    "psql",
                    "-X",
                    "-A",
                    "-t",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "postgres",
                    "-d",
                    &database,
                    "-c",
                    &format!(
                        "SELECT count(*) FROM hostlet_control.database_identity i JOIN hostlet_control.storage_policy s ON s.singleton=i.singleton WHERE i.singleton AND i.database_id={}::uuid AND i.generation={}::uuid AND s.growth_mode='writable'",
                        literal(&database_id.to_string()),
                        literal(&database_generation.to_string())
                    ),
                ],
                None,
            )?;
            if identity.trim() != "1" {
                return Err(Failure::Postgres("migration_live_target_invalid"));
            }
        }
        let existing = self.migration_stamp(target, &database, migration_id)?;
        if let Some(existing) = existing {
            if existing.0 != file_digest || existing.1 != schema_revision {
                return Err(Failure::Postgres("migration_effect_conflict"));
            }
            return MigrationApplyResult::new(
                &self.state_dir,
                database_id,
                database_generation,
                migration_id,
                recovery_id,
                existing.0,
                existing.1,
                existing.2,
                true,
            );
        }
        let advisory_key = i64::from_be_bytes(
            migration_id.as_bytes()[..8]
                .try_into()
                .map_err(|_| Failure::Postgres("migration_apply_invalid"))?,
        );
        let mut input = format!(
            r#"\set QUIET 1
BEGIN;
SELECT pg_advisory_xact_lock({advisory_key}) AS hostlet_lock \gset
SELECT NOT EXISTS(SELECT 1 FROM app.hostlet_migration_effects WHERE migration_id={migration_id}::uuid) AS hostlet_should_apply \gset
\if :hostlet_should_apply
"#,
            migration_id = literal(&migration_id.to_string()),
        )
        .into_bytes();
        input.extend_from_slice(sql);
        if !input.ends_with(b"\n") {
            input.push(b'\n');
        }
        input.extend_from_slice(
            format!(
                r#"
INSERT INTO app.hostlet_migration_effects(migration_id,file_digest,schema_revision)
VALUES({migration_id}::uuid,{file_digest},{schema_revision});
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.hostlet_migration_effects WHERE migration_id={migration_id}::uuid AND file_digest={file_digest} AND schema_revision={schema_revision}) THEN
    RAISE EXCEPTION 'migration effect conflict';
  END IF;
END $$;
\echo HOSTLET_MIGRATION_APPLIED
\else
\echo HOSTLET_MIGRATION_ALREADY_APPLIED
\endif
COMMIT;
"#,
                migration_id = literal(&migration_id.to_string()),
                file_digest = literal(file_digest),
                schema_revision = literal(schema_revision),
            )
            .as_bytes(),
        );
        let env_file = self.password_file(&migration_credential.value)?;
        let mut command = Command::new("docker");
        command
            .args(["exec", "-i", "--env-file"])
            .arg(&env_file)
            .args([
                &target.container_id,
                "psql",
                "-X",
                "--quiet",
                "--file=-",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-U",
                &migration,
                "-d",
                &database,
            ]);
        let mode = run_migration_input(&mut command, &input, COMMAND_TIMEOUT)
            .map_err(|_| Failure::Postgres("migration_apply_failed"));
        let _ = fs::remove_file(env_file);
        let already_applied = match mode?.trim() {
            "HOSTLET_MIGRATION_APPLIED" => false,
            "HOSTLET_MIGRATION_ALREADY_APPLIED" => true,
            _ => return Err(Failure::Postgres("migration_apply_failed")),
        };
        let (file, schema, applied_at) = self
            .migration_stamp(target, &database, migration_id)?
            .ok_or(Failure::Postgres("migration_stamp_missing"))?;
        if file != file_digest || schema != schema_revision {
            return Err(Failure::Postgres("migration_effect_conflict"));
        }
        MigrationApplyResult::new(
            &self.state_dir,
            database_id,
            database_generation,
            migration_id,
            recovery_id,
            file,
            schema,
            applied_at,
            already_applied,
        )
    }

    fn discover_application_roles(
        &self,
        target: &Target,
        expected_migration: &str,
    ) -> Result<(String, String), Failure> {
        let output = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-c",
                "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ESCAPE '\\' AND rolname<>'postgres' ORDER BY rolname",
            ],
            None,
        )?;
        let roles: Vec<_> = output
            .lines()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect();
        if roles.len() != 3 || !roles.contains(&expected_migration) {
            return Err(Failure::Postgres("migration_role_scope_invalid"));
        }
        let runtime = roles
            .iter()
            .find(|role| valid_derived_role(role, "ha_"))
            .ok_or(Failure::Postgres("migration_role_scope_invalid"))?;
        let backup = roles
            .iter()
            .find(|role| valid_derived_role(role, "hb_"))
            .ok_or(Failure::Postgres("migration_role_scope_invalid"))?;
        if !valid_derived_role(expected_migration, "hm_") {
            return Err(Failure::Postgres("migration_role_scope_invalid"));
        }
        Ok(((*runtime).to_owned(), (*backup).to_owned()))
    }

    fn migration_stamp(
        &self,
        target: &Target,
        database: &str,
        migration_id: Uuid,
    ) -> Result<Option<(String, String, String)>, Failure> {
        let exists = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                database,
                "-c",
                "SELECT to_regclass('app.hostlet_migration_effects') IS NOT NULL",
            ],
            None,
        )?;
        if exists.trim() == "f" {
            return Ok(None);
        }
        if exists.trim() != "t" {
            return Err(Failure::Postgres("migration_stamp_invalid"));
        }
        let row = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-F",
                "|",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                database,
                "-c",
                &format!(
                    "SELECT file_digest,schema_revision,to_char(applied_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM app.hostlet_migration_effects WHERE migration_id={}::uuid",
                    literal(&migration_id.to_string())
                ),
            ],
            None,
        )?;
        if row.trim().is_empty() {
            return Ok(None);
        }
        let parts: Vec<_> = row.trim().split('|').collect();
        if parts.len() != 3 || parts.iter().any(|item| item.is_empty()) {
            return Err(Failure::Postgres("migration_stamp_invalid"));
        }
        Ok(Some((
            parts[0].to_owned(),
            parts[1].to_owned(),
            parts[2].to_owned(),
        )))
    }

    fn psql_admin(&self, target: &Target, database: &str, sql: &str) -> Result<(), Failure> {
        let mut command = Command::new("docker");
        command.args([
            "exec",
            "-i",
            "--user",
            "postgres",
            &target.container_id,
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            database,
        ]);
        run_with_input(&mut command, sql.as_bytes(), COMMAND_TIMEOUT)
    }

    fn assert_cluster_scope(
        &self,
        target: &Target,
        allowed_database: Option<&str>,
        allowed_roles: [&str; 3],
    ) -> Result<(), Failure> {
        let database_filter = allowed_database
            .map(|name| format!(" AND datname<>{}", literal(name)))
            .unwrap_or_default();
        let databases = self.capture(
            target,
            [
                "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
                "-d", "postgres", "-c",
                &format!("SELECT count(*) FROM pg_database WHERE NOT datistemplate AND datname<>'postgres'{database_filter}"),
            ],
            None,
        )?;
        let roles = self.capture(
            target,
            [
                "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
                "-d", "postgres", "-c",
                &format!("SELECT count(*) FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ESCAPE '\\' AND rolname<>'postgres' AND rolname NOT IN ({},{},{})",
                    literal(allowed_roles[0]), literal(allowed_roles[1]), literal(allowed_roles[2])),
            ],
            None,
        )?;
        if databases.trim() != "0" || roles.trim() != "0" {
            return Err(Failure::Postgres("tenant_target_nonempty"));
        }
        Ok(())
    }

    fn assert_role_login(
        &self,
        target: &Target,
        database: &str,
        role: &str,
        password: &str,
    ) -> Result<(), Failure> {
        let output = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-U",
                role,
                "-d",
                database,
                "-c",
                "SELECT current_user",
            ],
            Some(password),
        )?;
        if output.trim() != role {
            return Err(Failure::Postgres("grant_validation_failed"));
        }
        Ok(())
    }

    fn assert_application_read(
        &self,
        target: &Target,
        database: &str,
        role: &str,
        password: &str,
    ) -> Result<(), Failure> {
        let count = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-U",
                role,
                "-d",
                database,
                "-c",
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind IN ('r','p') AND has_table_privilege(current_user,c.oid,'SELECT')",
            ],
            Some(password),
        )?;
        if count.trim().parse::<u64>().unwrap_or(0) == 0 {
            return Err(Failure::Postgres("storage_read_validation_failed"));
        }
        let env_file = self.password_file(password)?;
        let mut command = Command::new("docker");
        command
            .args(["exec", "-i", "--env-file"])
            .arg(&env_file)
            .args([
                &target.container_id,
                "psql",
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-U",
                role,
                "-d",
                database,
            ]);
        let result = run_with_input(
            &mut command,
            b"SELECT format('SELECT 1 FROM %I.%I LIMIT 1',n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind IN ('r','p') AND has_table_privilege(current_user,c.oid,'SELECT') ORDER BY c.oid LIMIT 1 \\gexec\n",
            COMMAND_TIMEOUT,
        );
        let _ = fs::remove_file(env_file);
        result.map_err(|_| Failure::Postgres("storage_read_validation_failed"))
    }

    fn assert_application_write_denied(
        &self,
        target: &Target,
        database: &str,
        role: &str,
        password: &str,
    ) -> Result<(), Failure> {
        let env_file = self.password_file(password)?;
        let mut command = Command::new("docker");
        command
            .args(["exec", "-i", "--env-file"])
            .arg(&env_file)
            .args([
                &target.container_id,
                "psql",
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-U",
                role,
                "-d",
                database,
            ]);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        command.stdin(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| Failure::Postgres("storage_write_validation_failed"))?;
        child
            .stdin
            .take()
            .ok_or(Failure::Postgres("storage_write_validation_failed"))?
            .write_all(b"SELECT format('DELETE FROM %I.%I WHERE false',n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind IN ('r','p') AND has_table_privilege(current_user,c.oid,'SELECT') ORDER BY c.oid LIMIT 1 \\gexec\n")
            .map_err(|_| Failure::Postgres("storage_write_validation_failed"))?;
        let denied = wait_child_failure(child, COMMAND_TIMEOUT)
            .map_err(|_| Failure::Postgres("storage_write_validation_failed"));
        let _ = fs::remove_file(env_file);
        denied
    }

    fn assert_storage_frozen(
        &self,
        target: &Target,
        database: &str,
        runtime: &str,
        migration: &str,
    ) -> Result<(), Failure> {
        let query = format!(
            "SELECT (NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname={migration}) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind IN ('r','p') AND (has_table_privilege({runtime},c.oid,'INSERT') OR has_table_privilege({runtime},c.oid,'UPDATE') OR has_table_privilege({runtime},c.oid,'DELETE') OR has_table_privilege({runtime},c.oid,'TRUNCATE') OR has_table_privilege({runtime},c.oid,'REFERENCES') OR has_table_privilege({runtime},c.oid,'TRIGGER'))) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='S' AND (has_sequence_privilege({runtime},c.oid,'USAGE') OR has_sequence_privilege({runtime},c.oid,'UPDATE'))) AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind IN ('r','p') AND has_table_privilege({runtime},c.oid,'SELECT')))::int",
            runtime = literal(runtime),
            migration = literal(migration)
        );
        let result = self.capture(
            target,
            [
                "psql",
                "-X",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                database,
                "-c",
                &query,
            ],
            None,
        )?;
        if result.trim() != "1" {
            return Err(Failure::Postgres("storage_freeze_validation_failed"));
        }
        Ok(())
    }

    fn assert_backup_export(
        &self,
        target: &Target,
        database: &str,
        role: &str,
        password: &str,
    ) -> Result<(), Failure> {
        let env_file = self.password_file(password)?;
        let mut command = Command::new("docker");
        command.args(["exec", "--env-file"]).arg(&env_file).args([
            &target.container_id,
            "pg_dump",
            "--host=127.0.0.1",
            "--port=5432",
            "--username",
            role,
            "--schema-only",
            "--no-owner",
            "--no-privileges",
            "--exclude-schema=hostlet_control",
            "--dbname",
            database,
        ]);
        command.stdout(Stdio::null());
        let result = run_status(&mut command, COMMAND_TIMEOUT)
            .map_err(|_| Failure::Postgres("storage_export_validation_failed"));
        let _ = fs::remove_file(env_file);
        result
    }

    fn assert_role_denied(
        &self,
        target: &Target,
        database: &str,
        role: &str,
        password: &str,
        sql: &str,
    ) -> Result<(), Failure> {
        let env_file = self.password_file(password)?;
        let mut command = Command::new("docker");
        command.args(["exec", "--env-file"]).arg(&env_file).args([
            &target.container_id,
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            "127.0.0.1",
            "-U",
            role,
            "-d",
            database,
            "-c",
            sql,
        ]);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let child = command
            .spawn()
            .map_err(|_| Failure::Postgres("grant_validation_failed"))?;
        let denied = wait_child_failure(child, COMMAND_TIMEOUT);
        let _ = fs::remove_file(env_file);
        denied
    }

    fn capture<const N: usize>(
        &self,
        target: &Target,
        args: [&str; N],
        password: Option<&str>,
    ) -> Result<String, Failure> {
        let env_file = password
            .map(|value| self.password_file(value))
            .transpose()?;
        let mut command = Command::new("docker");
        command.arg("exec");
        if let Some(path) = &env_file {
            command.arg("--env-file").arg(path);
        }
        command.arg(&target.container_id).args(args);
        let result = run_capture(&mut command, COMMAND_TIMEOUT);
        if let Some(path) = env_file {
            let _ = fs::remove_file(path);
        }
        result
    }

    fn password_file(&self, password: &str) -> Result<PathBuf, Failure> {
        if password.is_empty()
            || password.len() > 4096
            || password
                .chars()
                .any(|item| matches!(item, '\n' | '\r' | '\0'))
        {
            return Err(Failure::Credential);
        }
        let path = self.state_dir.join(format!(".pg-env-{}", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|_| Failure::Postgres("credential_injection_failed"))?;
        file.write_all(b"PGPASSWORD=")
            .and_then(|_| file.write_all(password.as_bytes()))
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|_| Failure::Postgres("credential_injection_failed"))?;
        Ok(path)
    }
}

#[derive(Debug, Serialize)]
pub struct RestoreResult {
    pub replacement_identity: Uuid,
    pub relation_count: u64,
    pub foreign_key_count: u64,
    pub populated_relation_count: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug)]
pub struct StorageResult {
    pub storage_bytes: u64,
    pub growth_mode: String,
    pub write_denied: bool,
}

#[derive(Debug)]
pub struct FixtureBootstrapResult {
    pub populated_rows: u64,
}

#[derive(Debug)]
pub struct MigrationApplyResult {
    pub migration_file_digest: String,
    pub schema_revision: String,
    pub applied_at: String,
    pub receipt_digest: String,
    pub already_applied: bool,
}

impl MigrationApplyResult {
    #[allow(
        clippy::too_many_arguments,
        reason = "the receipt digest commits each migration and target identity as a separate field"
    )]
    fn new(
        state_dir: &Path,
        database_id: Uuid,
        database_generation: Uuid,
        migration_id: Uuid,
        recovery_id: Option<Uuid>,
        migration_file_digest: String,
        schema_revision: String,
        applied_at: String,
        already_applied: bool,
    ) -> Result<Self, Failure> {
        let mut receipt = serde_json::to_vec(&json!({
            "schema":"hostlet.database-migration-apply/v1",
            "tenant_database_id":database_id,
            "database_generation":database_generation,
            "migration_id":migration_id,
            "recovery_id":recovery_id,
            "migration_file_digest":migration_file_digest,
            "schema_revision":schema_revision,
            "applied_at":applied_at,
        }))
        .map_err(|_| Failure::Postgres("migration_apply_receipt_invalid"))?;
        receipt.push(b'\n');
        let receipt_digest = store_apply_receipt(state_dir, &receipt)?;
        Ok(Self {
            migration_file_digest,
            schema_revision,
            applied_at,
            receipt_digest,
            already_applied,
        })
    }
}

fn store_apply_receipt(state_dir: &Path, bytes: &[u8]) -> Result<String, Failure> {
    let digest = format!("{:x}", Sha256::digest(bytes));
    let directory = state_dir.join("evidence").join("sha256").join(&digest[..2]);
    let root = fs::symlink_metadata(state_dir)
        .map_err(|_| Failure::Postgres("migration_apply_receipt_store_failed"))?;
    for path in [
        state_dir.join("evidence"),
        state_dir.join("evidence").join("sha256"),
        directory.clone(),
    ] {
        let created = match fs::create_dir(&path) {
            Ok(()) => {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                    .map_err(|_| Failure::Postgres("migration_apply_receipt_store_failed"))?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(_) => return Err(Failure::Postgres("migration_apply_receipt_store_failed")),
        };
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| Failure::Postgres("migration_apply_receipt_store_failed"))?;
        if !metadata.file_type().is_dir()
            || metadata.uid() != root.uid()
            || metadata.gid() != root.gid()
            || metadata.permissions().mode() & 0o077 != 0
            || fs::canonicalize(&path).ok().as_deref() != Some(path.as_path())
        {
            return Err(Failure::Postgres("migration_apply_receipt_store_failed"));
        }
        if created {
            fs::File::open(
                path.parent()
                    .ok_or(Failure::Postgres("migration_apply_receipt_store_failed"))?,
            )
            .and_then(|file| file.sync_all())
            .map_err(|_| Failure::Postgres("migration_apply_receipt_store_failed"))?;
        }
    }
    let destination = directory.join(format!("{}.json", &digest[2..]));
    let temporary = directory.join(format!(".{}-{}.tmp", std::process::id(), Uuid::new_v4()));
    let write = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        match fs::hard_link(&temporary, &destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }
    })();
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Failure::Postgres("migration_apply_receipt_store_failed")),
    }
    write.map_err(|_| Failure::Postgres("migration_apply_receipt_store_failed"))?;
    let metadata = fs::symlink_metadata(&destination)
        .map_err(|_| Failure::Postgres("migration_apply_receipt_store_failed"))?;
    if !metadata.file_type().is_file()
        || metadata.uid() != root.uid()
        || metadata.gid() != root.gid()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() != bytes.len() as u64
        || fs::canonicalize(&destination).ok().as_deref() != Some(destination.as_path())
        || fs::read(&destination).ok().as_deref() != Some(bytes)
    {
        return Err(Failure::Postgres("migration_apply_receipt_store_failed"));
    }
    fs::File::open(&directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| Failure::Postgres("migration_apply_receipt_store_failed"))?;
    Ok(format!("sha256:{digest}"))
}

#[derive(Deserialize)]
struct ValidationSummary {
    relations: u64,
    foreign_keys: u64,
    populated: u64,
}

fn validate_role_set(database_id: Uuid, roles: &RoleSet<'_>) -> Result<(), Failure> {
    let mut purposes = HashMap::new();
    for credential in [roles.runtime, roles.migration, roles.backup] {
        if credential.value.is_empty()
            || credential.value.len() > 4096
            || credential
                .value
                .chars()
                .any(|item| matches!(item, '\n' | '\r' | '\0'))
            || purposes
                .insert(credential.purpose.as_str(), credential.role_ref)
                .is_some()
        {
            return Err(Failure::Credential);
        }
    }
    if roles.runtime.purpose != "runtime"
        || roles.migration.purpose != "migration"
        || roles.backup.purpose != "backup"
        || roles.runtime.role_ref == roles.migration.role_ref
        || roles.runtime.role_ref == roles.backup.role_ref
        || roles.migration.role_ref == roles.backup.role_ref
        || database_id.is_nil()
    {
        return Err(Failure::Credential);
    }
    Ok(())
}

pub fn database_name(id: Uuid) -> String {
    format!("hdb_{}", id.simple())
}
fn restore_database_name(id: Uuid) -> String {
    format!("hdr_{}", id.simple())
}
fn role_name(purpose: &str, id: Uuid) -> String {
    format!("h{}_{}", &purpose[..1], id.simple())
}
fn valid_derived_role(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 32
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_container_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_ip(value: &str, ipv6: bool) -> bool {
    value
        .parse::<std::net::IpAddr>()
        .map(|ip| match ip {
            std::net::IpAddr::V4(address) => !ipv6 && address.is_private(),
            std::net::IpAddr::V6(address) => ipv6 && address.is_unique_local(),
        })
        .unwrap_or(false)
}

fn run_with_input(command: &mut Command, input: &[u8], timeout: Duration) -> Result<(), Failure> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| Failure::Postgres("database_command_failed"))?;
    child
        .stdin
        .take()
        .ok_or(Failure::Postgres("database_command_failed"))?
        .write_all(input)
        .map_err(|_| Failure::Postgres("database_command_failed"))?;
    wait_child(child, timeout).map(|_| ())
}

fn run_migration_input(
    command: &mut Command,
    input: &[u8],
    timeout: Duration,
) -> Result<String, Failure> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| Failure::Postgres("database_command_failed"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(Failure::Postgres("database_command_failed"))?;
    let reader = thread::spawn(move || read_capped(stdout));
    child
        .stdin
        .take()
        .ok_or(Failure::Postgres("database_command_failed"))?
        .write_all(input)
        .map_err(|_| Failure::Postgres("database_command_failed"))?;
    wait_child(child, timeout)?;
    let (output, overflow) = reader
        .join()
        .map_err(|_| Failure::Postgres("database_command_failed"))??;
    if overflow {
        return Err(Failure::Postgres("database_command_failed"));
    }
    String::from_utf8(output).map_err(|_| Failure::Postgres("database_command_failed"))
}

fn run_status(command: &mut Command, timeout: Duration) -> Result<(), Failure> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|_| Failure::Postgres("database_command_failed"))?;
    wait_child(child, timeout).map(|_| ())
}

fn run_status_preserving_stdout(command: &mut Command, timeout: Duration) -> Result<(), Failure> {
    command.stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|_| Failure::Postgres("database_command_failed"))?;
    wait_child(child, timeout).map(|_| ())
}

fn run_capture(command: &mut Command, timeout: Duration) -> Result<String, Failure> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| Failure::Postgres("database_command_failed"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(Failure::Postgres("database_command_failed"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(Failure::Postgres("database_command_failed"))?;
    let stdout_reader = thread::spawn(move || read_capped(stdout));
    let stderr_reader = thread::spawn(move || read_capped(stderr));
    let started = Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|_| Failure::Postgres("database_command_failed"))?
        {
            Some(status) => break status,
            None if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::Postgres("database_command_timeout"));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| Failure::Postgres("database_command_failed"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| Failure::Postgres("database_command_failed"))??;
    if !status.success() || stdout.1 || stderr.1 {
        return Err(Failure::Postgres("database_command_failed"));
    }
    String::from_utf8(stdout.0).map_err(|_| Failure::Postgres("database_command_failed"))
}

fn read_capped(mut input: impl Read) -> Result<(Vec<u8>, bool), Failure> {
    let mut retained = Vec::new();
    let mut overflow = false;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| Failure::Postgres("database_command_failed"))?;
        if count == 0 {
            break;
        }
        let remaining = MAX_CAPTURE.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..count.min(remaining)]);
        overflow |= count > remaining;
    }
    Ok((retained, overflow))
}

fn wait_child(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, Failure> {
    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|_| Failure::Postgres("database_command_failed"))?
        {
            Some(status) if status.success() => return Ok(status),
            Some(_) => return Err(Failure::Postgres("database_command_failed")),
            None if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::Postgres("database_command_timeout"));
            }
        }
    }
}

fn wait_child_failure(mut child: std::process::Child, timeout: Duration) -> Result<(), Failure> {
    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|_| Failure::Postgres("grant_validation_failed"))?
        {
            Some(status) if !status.success() => return Ok(()),
            Some(_) => return Err(Failure::Postgres("grant_validation_failed")),
            None if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::Postgres("database_command_timeout"));
            }
        }
    }
}
