use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::worker::Failure;

const MAX_MIGRATION_BYTES: u64 = 1024 * 1024;
const MAX_FIXTURE_BYTES: u64 = 64 * 1024;
// Both owned artifacts may reach policy validation. The destructive fixture
// must still fail validate_sql before any statement is executed.
const OWNED_MIGRATION_ENTRIES: [&str; 2] = [
    "dist/migrations/002_additive_client_compatibility.sql",
    "dist/migrations/003_destructive.sql",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationArtifact {
    pub build_job_id: Uuid,
    pub artifact_id: Uuid,
    pub service_id: Uuid,
    pub application_archive_digest: String,
    pub manifest_digest: String,
    pub migration_entry_path: String,
    pub file_digest: String,
    pub materialized_ref: String,
    pub stage_receipt_digest: String,
}

pub struct ArtifactStore {
    state_dir: PathBuf,
}

impl ArtifactStore {
    pub fn from_state_dir(state_dir: PathBuf) -> Self {
        Self { state_dir }
    }

    pub fn migration_sql(&self, expected: &MigrationArtifact) -> Result<Vec<u8>, Failure> {
        if expected.build_job_id.is_nil()
            || expected.artifact_id.is_nil()
            || expected.service_id.is_nil()
            || !OWNED_MIGRATION_ENTRIES.contains(&expected.migration_entry_path.as_str())
            || !valid_digest(&expected.application_archive_digest)
            || !valid_digest(&expected.manifest_digest)
            || !valid_digest(&expected.file_digest)
            || !valid_digest(&expected.stage_receipt_digest)
        {
            return Err(Failure::Processing("migration_artifact_invalid"));
        }
        let hex = &expected.file_digest[7..];
        let exact_ref = format!("migration-artifacts/sha256/{}/{}.sql", &hex[..2], &hex[2..]);
        if expected.materialized_ref != exact_ref {
            return Err(Failure::Processing("migration_artifact_invalid"));
        }
        let root = self.state_dir.join("migration-artifacts");
        let sha = root.join("sha256");
        let prefix = sha.join(&hex[..2]);
        validate_directory_private(&root)?;
        validate_directory_private(&sha)?;
        validate_directory_private(&prefix)?;
        let path = self.state_dir.join(&exact_ref);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| Failure::Processing("migration_artifact_unavailable"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.len() == 0
            || metadata.len() > MAX_MIGRATION_BYTES
            || fs::canonicalize(&path).ok().as_ref() != Some(&path)
        {
            return Err(Failure::Processing("migration_artifact_invalid"));
        }
        let migration =
            fs::read(path).map_err(|_| Failure::Processing("migration_artifact_unavailable"))?;
        if format!("sha256:{:x}", Sha256::digest(&migration)) != expected.file_digest {
            return Err(Failure::Processing("migration_file_digest_mismatch"));
        }
        validate_sql(&migration)?;
        Ok(migration)
    }

    pub fn fixture_bootstrap(&self, digest: &str) -> Result<Vec<u8>, Failure> {
        if !valid_digest(digest) {
            return Err(Failure::Processing("fixture_bootstrap_digest_invalid"));
        }
        let hex = &digest[7..];
        let root = self.state_dir.join("database-fixtures");
        let sha = root.join("sha256");
        let prefix = sha.join(&hex[..2]);
        validate_directory_private(&root)?;
        validate_directory_private(&sha)?;
        validate_directory_private(&prefix)?;
        let path = prefix.join(format!("{}.sql", &hex[2..]));
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| Failure::Processing("fixture_bootstrap_unavailable"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.len() == 0
            || metadata.len() > MAX_FIXTURE_BYTES
            || fs::canonicalize(&path).ok().as_ref() != Some(&path)
        {
            return Err(Failure::Processing("fixture_bootstrap_invalid"));
        }
        let bytes =
            fs::read(path).map_err(|_| Failure::Processing("fixture_bootstrap_unavailable"))?;
        if format!("sha256:{:x}", Sha256::digest(&bytes)) != digest {
            return Err(Failure::Processing("fixture_bootstrap_digest_mismatch"));
        }
        validate_fixture_sql(&bytes)?;
        Ok(bytes)
    }
}

fn validate_sql(bytes: &[u8]) -> Result<(), Failure> {
    let sql =
        std::str::from_utf8(bytes).map_err(|_| Failure::Processing("migration_sql_invalid"))?;
    if sql.contains('\0') || sql.lines().any(|line| line.trim_start().starts_with('\\')) {
        return Err(Failure::Processing("migration_sql_invalid"));
    }
    let without_comments = sql
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    let statements: Vec<String> = without_comments
        .split(';')
        .map(|statement| statement.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|statement| !statement.is_empty())
        .collect();
    let admitted = [
        "ALTER TABLE journal_items ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT ''",
        "ALTER TABLE journal_items ADD COLUMN IF NOT EXISTS client_release text",
        "INSERT INTO fixture_schema_migrations(revision) VALUES (2) ON CONFLICT DO NOTHING",
    ];
    if statements.len() != admitted.len()
        || statements
            .iter()
            .zip(admitted)
            .any(|(actual, expected)| actual != expected)
    {
        return Err(Failure::Processing("migration_sql_not_admitted"));
    }
    Ok(())
}

fn validate_fixture_sql(bytes: &[u8]) -> Result<(), Failure> {
    let sql =
        std::str::from_utf8(bytes).map_err(|_| Failure::Processing("fixture_bootstrap_invalid"))?;
    if sql.contains('\0') || sql.lines().any(|line| line.trim_start().starts_with('\\')) {
        return Err(Failure::Processing("fixture_bootstrap_invalid"));
    }
    let statements: Vec<String> = sql
        .split(';')
        .map(|statement| statement.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|statement| !statement.is_empty())
        .collect();
    let admitted = [
        "CREATE TABLE app.authors ( id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, display_name text NOT NULL )",
        "CREATE TABLE app.entries ( id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, author_id bigint NOT NULL REFERENCES app.authors(id), title text NOT NULL, body text NOT NULL )",
        "INSERT INTO app.authors(display_name) VALUES ('Owned Fixture Author')",
        "INSERT INTO app.entries(author_id, title, body) SELECT id, 'First owned entry', 'Populated relationship used by restore validation' FROM app.authors WHERE display_name = 'Owned Fixture Author'",
        "CREATE TABLE app.journal_items ( id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now() )",
        "CREATE TABLE app.fixture_schema_migrations ( revision integer PRIMARY KEY )",
        "INSERT INTO app.fixture_schema_migrations(revision) VALUES (1)",
        "INSERT INTO app.journal_items(name) VALUES ('Owned populated journal item')",
    ];
    if statements.len() != admitted.len()
        || statements
            .iter()
            .zip(admitted)
            .any(|(actual, expected)| actual != expected)
    {
        return Err(Failure::Processing("fixture_bootstrap_not_admitted"));
    }
    Ok(())
}

fn validate_directory_private(path: &Path) -> Result<(), Failure> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| Failure::Processing("migration_artifact_unavailable"))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
        || fs::canonicalize(path).ok().as_ref() != Some(&path.to_path_buf())
    {
        return Err(Failure::Processing("migration_artifact_invalid"));
    }
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
