use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use chrono::{DateTime, Utc};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::worker::Failure;

const MAGIC: &[u8; 23] = b"hostlet.tenant-backup\0\x01";
const CHUNK_SIZE: usize = 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;

pub struct Repository {
    root: PathBuf,
    key_id: String,
    key: Zeroizing<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub archive_id: Uuid,
    pub archive_kind: String,
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub source_data_generation: i64,
    pub snapshot_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub postgres_server_major: u32,
    pub pg_dump_major: u32,
    pub no_owner: bool,
    pub no_privileges: bool,
    pub cluster_roles_included: bool,
    pub key_id: String,
    pub nonce_prefix: String,
    pub chunk_size: usize,
    pub plaintext_bytes: u64,
    pub plaintext_sha256: String,
    pub source_fingerprint: String,
    pub portable: bool,
}

#[derive(Debug, Serialize)]
pub struct Receipt {
    pub object_ref: String,
    pub format: &'static str,
    pub key_id: String,
    pub plaintext_sha256: String,
    pub encrypted_sha256: String,
    pub plaintext_bytes: u64,
    pub encrypted_bytes: u64,
    pub snapshot_at: DateTime<Utc>,
    pub manifest_sha256: String,
    pub manifest: Manifest,
}

pub struct ExpectedArchive<'a> {
    pub archive_id: Uuid,
    pub tenant_database_id: Uuid,
    pub database_generation: Uuid,
    pub namespace: &'a str,
    pub encrypted_sha256: Option<&'a str>,
    pub policy_time: DateTime<Utc>,
    pub exact_snapshot_at: Option<DateTime<Utc>>,
}

impl Repository {
    pub fn from_environment() -> Result<Self, Failure> {
        let state_dir = std::env::var_os("HOSTLET_M3_STATE_DIR")
            .map(PathBuf::from)
            .ok_or(Failure::Configuration)?;
        let state = canonical_private_dir(&state_dir)?;
        let root = state.join("tenant-backups");
        if !root.exists() {
            fs::create_dir(&root).map_err(|_| Failure::Configuration)?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| Failure::Configuration)?;
        }
        let root = canonical_private_dir(&root)?;
        if root.parent() != Some(state.as_path()) {
            return Err(Failure::Configuration);
        }

        let mut encoded =
            std::env::var("HOSTLET_TENANT_RECOVERY_KEY").map_err(|_| Failure::Configuration)?;
        let key = STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| Failure::Configuration)?;
        encoded.zeroize();
        if key.len() != 32 {
            return Err(Failure::Configuration);
        }
        let key_id = std::env::var("HOSTLET_TENANT_RECOVERY_KEY_ID")
            .unwrap_or_else(|_| "fixture-v1".to_owned());
        if !safe_component(&key_id) {
            return Err(Failure::Configuration);
        }
        Ok(Self {
            root,
            key_id,
            key: Zeroizing::new(key),
        })
    }

    pub fn seal(
        &self,
        namespace: &str,
        source: &Path,
        mut manifest: Manifest,
    ) -> Result<Receipt, Failure> {
        let namespace_dir = self.namespace(namespace, true)?;
        let final_path = namespace_dir.join(format!("{}.htb", manifest.archive_id));
        let staging_path = namespace_dir.join(format!(
            ".{}.{}.partial",
            manifest.archive_id,
            Uuid::new_v4()
        ));
        if final_path.exists() {
            let verification = self
                .root
                .parent()
                .ok_or(Failure::Configuration)?
                .join(format!(".archive-replay-{}.tmp", Uuid::new_v4()));
            let recovered = self.authenticate_to(
                &ExpectedArchive {
                    archive_id: manifest.archive_id,
                    tenant_database_id: manifest.tenant_database_id,
                    database_generation: manifest.database_generation,
                    namespace,
                    encrypted_sha256: None,
                    policy_time: manifest.snapshot_at,
                    exact_snapshot_at: Some(manifest.snapshot_at),
                },
                &verification,
            );
            let _ = fs::remove_file(&verification);
            let recovered = recovered?;
            if recovered.archive_kind != manifest.archive_kind
                || recovered.source_data_generation != manifest.source_data_generation
                || recovered.expires_at != manifest.expires_at
            {
                return Err(Failure::Archive("archive_replay_mismatch"));
            }
            let (encrypted_bytes, encrypted_sha256) = hash_file(&final_path)?;
            let manifest_bytes = serde_json::to_vec(&recovered)
                .map_err(|_| Failure::Archive("archive_manifest_invalid"))?;
            return Ok(Receipt {
                object_ref: format!("{namespace}/{}.htb", recovered.archive_id),
                format: "hostlet.tenant-backup/v1",
                key_id: recovered.key_id.clone(),
                plaintext_sha256: recovered.plaintext_sha256.clone(),
                encrypted_sha256,
                plaintext_bytes: recovered.plaintext_bytes,
                encrypted_bytes,
                snapshot_at: recovered.snapshot_at,
                manifest_sha256: sha256(&manifest_bytes),
                manifest: recovered,
            });
        }

        let (plaintext_bytes, plaintext_sha256) = hash_file(source)?;
        let mut nonce_prefix = [0u8; 16];
        OsRng.fill_bytes(&mut nonce_prefix);
        manifest.format = "hostlet.tenant-backup/v1".to_owned();
        manifest.key_id = self.key_id.clone();
        manifest.nonce_prefix = hex(&nonce_prefix);
        manifest.chunk_size = CHUNK_SIZE;
        manifest.plaintext_bytes = plaintext_bytes;
        manifest.plaintext_sha256 = plaintext_sha256.clone();
        let manifest_bytes = serde_json::to_vec(&manifest)
            .map_err(|_| Failure::Archive("archive_manifest_invalid"))?;
        if manifest_bytes.len() > MAX_MANIFEST_BYTES {
            return Err(Failure::Archive("archive_manifest_invalid"));
        }

        let result = (|| {
            let mut input =
                File::open(source).map_err(|_| Failure::Archive("archive_source_unavailable"))?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&staging_path)
                .map_err(|_| Failure::Archive("archive_stage_failed"))?;
            output
                .write_all(MAGIC)
                .map_err(|_| Failure::Archive("archive_stage_failed"))?;
            output
                .write_all(&(manifest_bytes.len() as u32).to_be_bytes())
                .map_err(|_| Failure::Archive("archive_stage_failed"))?;
            output
                .write_all(&manifest_bytes)
                .map_err(|_| Failure::Archive("archive_stage_failed"))?;
            let cipher =
                XChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| Failure::Configuration)?;
            let mut buffer = vec![0u8; CHUNK_SIZE];
            let mut index = 0u64;
            loop {
                let count = input
                    .read(&mut buffer)
                    .map_err(|_| Failure::Archive("archive_source_unavailable"))?;
                let final_chunk = count == 0;
                let nonce = nonce(&nonce_prefix, index);
                let aad = aad(&manifest_bytes, index, final_chunk);
                let sealed = cipher
                    .encrypt(
                        XNonce::from_slice(&nonce),
                        chacha20poly1305::aead::Payload {
                            msg: &buffer[..count],
                            aad: &aad,
                        },
                    )
                    .map_err(|_| Failure::Archive("archive_encrypt_failed"))?;
                output
                    .write_all(&(count as u32).to_be_bytes())
                    .map_err(|_| Failure::Archive("archive_stage_failed"))?;
                output
                    .write_all(&(sealed.len() as u32).to_be_bytes())
                    .map_err(|_| Failure::Archive("archive_stage_failed"))?;
                output
                    .write_all(&sealed)
                    .map_err(|_| Failure::Archive("archive_stage_failed"))?;
                index = index
                    .checked_add(1)
                    .ok_or(Failure::Archive("archive_too_large"))?;
                if final_chunk {
                    break;
                }
            }
            output
                .sync_all()
                .map_err(|_| Failure::Archive("archive_stage_failed"))?;
            fs::hard_link(&staging_path, &final_path)
                .map_err(|_| Failure::Archive("archive_publish_failed"))?;
            File::open(&namespace_dir)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| Failure::Archive("archive_publish_failed"))?;
            Ok(())
        })();
        let _ = fs::remove_file(&staging_path);
        result?;

        let expected = ExpectedArchive {
            archive_id: manifest.archive_id,
            tenant_database_id: manifest.tenant_database_id,
            database_generation: manifest.database_generation,
            namespace,
            encrypted_sha256: None,
            policy_time: manifest.snapshot_at,
            exact_snapshot_at: Some(manifest.snapshot_at),
        };
        let verify_path = self
            .root
            .parent()
            .ok_or(Failure::Configuration)?
            .join(format!(".archive-verify-{}.tmp", Uuid::new_v4()));
        let verified = match self.authenticate_to(&expected, &verify_path) {
            Ok(manifest) => manifest,
            Err(failure) => {
                let _ = fs::remove_file(&verify_path);
                let _ = fs::remove_file(&final_path);
                return Err(failure);
            }
        };
        let _ = fs::remove_file(&verify_path);
        if verified.plaintext_sha256 != plaintext_sha256
            || verified.plaintext_bytes != plaintext_bytes
        {
            return Err(Failure::Archive("archive_readback_failed"));
        }
        let (encrypted_bytes, encrypted_sha256) = hash_file(&final_path)?;
        Ok(Receipt {
            object_ref: format!("{namespace}/{}.htb", manifest.archive_id),
            format: "hostlet.tenant-backup/v1",
            key_id: self.key_id.clone(),
            plaintext_sha256,
            encrypted_sha256,
            plaintext_bytes,
            encrypted_bytes,
            snapshot_at: manifest.snapshot_at,
            manifest_sha256: sha256(&manifest_bytes),
            manifest,
        })
    }

    pub fn authenticate_to(
        &self,
        expected: &ExpectedArchive<'_>,
        destination: &Path,
    ) -> Result<Manifest, Failure> {
        let path = self.object_path(expected)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| Failure::Archive("archive_unavailable"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(Failure::Archive("archive_unsafe_object"));
        }
        if let Some(digest) = expected.encrypted_sha256
            && (!valid_sha256(digest) || hash_file(&path)?.1 != digest)
        {
            return Err(Failure::Archive("archive_digest_mismatch"));
        }
        let mut input = File::open(&path).map_err(|_| Failure::Archive("archive_unavailable"))?;
        let mut magic = [0u8; 23];
        input
            .read_exact(&mut magic)
            .map_err(|_| Failure::Archive("archive_truncated"))?;
        if magic != *MAGIC {
            return Err(Failure::Archive("archive_format_invalid"));
        }
        let manifest_len = read_u32(&mut input)? as usize;
        if manifest_len == 0 || manifest_len > MAX_MANIFEST_BYTES {
            return Err(Failure::Archive("archive_manifest_invalid"));
        }
        let mut manifest_bytes = vec![0u8; manifest_len];
        input
            .read_exact(&mut manifest_bytes)
            .map_err(|_| Failure::Archive("archive_truncated"))?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| Failure::Archive("archive_manifest_invalid"))?;
        if manifest.format != "hostlet.tenant-backup/v1"
            || manifest.archive_id != expected.archive_id
            || manifest.tenant_database_id != expected.tenant_database_id
            || manifest.database_generation != expected.database_generation
            || manifest.key_id != self.key_id
            || manifest.chunk_size != CHUNK_SIZE
            || manifest.snapshot_at > expected.policy_time
            || expected
                .exact_snapshot_at
                .is_some_and(|snapshot| manifest.snapshot_at != snapshot)
            || manifest.expires_at <= manifest.snapshot_at
        {
            return Err(Failure::Archive("archive_target_mismatch"));
        }
        let prefix = decode_hex_16(&manifest.nonce_prefix)
            .ok_or(Failure::Archive("archive_manifest_invalid"))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(destination)
            .map_err(|_| Failure::Archive("archive_stage_failed"))?;
        let cipher =
            XChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| Failure::Configuration)?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut index = 0u64;
        loop {
            let plain_len = read_u32(&mut input)? as usize;
            let sealed_len = read_u32(&mut input)? as usize;
            if plain_len > CHUNK_SIZE || sealed_len != plain_len + 16 {
                return Err(Failure::Archive("archive_chunk_invalid"));
            }
            let mut sealed = vec![0u8; sealed_len];
            input
                .read_exact(&mut sealed)
                .map_err(|_| Failure::Archive("archive_truncated"))?;
            let final_chunk = plain_len == 0;
            let nonce = nonce(&prefix, index);
            let opened = cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    chacha20poly1305::aead::Payload {
                        msg: &sealed,
                        aad: &aad(&manifest_bytes, index, final_chunk),
                    },
                )
                .map_err(|_| Failure::Archive("archive_authentication_failed"))?;
            if opened.len() != plain_len {
                return Err(Failure::Archive("archive_chunk_invalid"));
            }
            if final_chunk {
                let mut trailing = [0u8; 1];
                if input
                    .read(&mut trailing)
                    .map_err(|_| Failure::Archive("archive_unavailable"))?
                    != 0
                {
                    return Err(Failure::Archive("archive_trailing_data"));
                }
                break;
            }
            output
                .write_all(&opened)
                .map_err(|_| Failure::Archive("archive_stage_failed"))?;
            hasher.update(&opened);
            total = total
                .checked_add(opened.len() as u64)
                .ok_or(Failure::Archive("archive_too_large"))?;
            index = index
                .checked_add(1)
                .ok_or(Failure::Archive("archive_too_large"))?;
        }
        output
            .sync_all()
            .map_err(|_| Failure::Archive("archive_stage_failed"))?;
        if total != manifest.plaintext_bytes || hex(&hasher.finalize()) != manifest.plaintext_sha256
        {
            return Err(Failure::Archive("archive_plaintext_digest_mismatch"));
        }
        Ok(manifest)
    }

    pub fn expire(&self, expected: &ExpectedArchive<'_>) -> Result<(), Failure> {
        let verification = self
            .root
            .parent()
            .ok_or(Failure::Configuration)?
            .join(format!(".archive-expire-{}.tmp", Uuid::new_v4()));
        let result = self.authenticate_to(expected, &verification);
        let _ = fs::remove_file(&verification);
        result?;
        let path = self.object_path(expected)?;
        fs::remove_file(&path).map_err(|_| Failure::Archive("archive_delete_failed"))?;
        File::open(
            path.parent()
                .ok_or(Failure::Archive("archive_unsafe_object"))?,
        )
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Failure::Archive("archive_delete_failed"))?;
        Ok(())
    }

    fn namespace(&self, namespace: &str, create: bool) -> Result<PathBuf, Failure> {
        if !safe_component(namespace) {
            return Err(Failure::Archive("archive_namespace_invalid"));
        }
        let path = self.root.join(namespace);
        if create && !path.exists() {
            fs::create_dir(&path).map_err(|_| Failure::Archive("archive_namespace_invalid"))?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .map_err(|_| Failure::Archive("archive_namespace_invalid"))?;
        }
        let canonical = canonical_private_dir(&path)
            .map_err(|_| Failure::Archive("archive_namespace_invalid"))?;
        if canonical.parent() != Some(self.root.as_path()) {
            return Err(Failure::Archive("archive_namespace_invalid"));
        }
        Ok(canonical)
    }

    fn object_path(&self, expected: &ExpectedArchive<'_>) -> Result<PathBuf, Failure> {
        Ok(self
            .namespace(expected.namespace, false)?
            .join(format!("{}.htb", expected.archive_id)))
    }
}

fn canonical_private_dir(path: &Path) -> Result<PathBuf, Failure> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Failure::Configuration)?;
    let canonical = fs::canonicalize(path).map_err(|_| Failure::Configuration)?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
        || canonical != path
    {
        return Err(Failure::Configuration);
    }
    Ok(canonical)
}

fn hash_file(path: &Path) -> Result<(u64, String), Failure> {
    let mut file = File::open(path).map_err(|_| Failure::Archive("archive_unavailable"))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0u8; CHUNK_SIZE];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| Failure::Archive("archive_unavailable"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        total = total
            .checked_add(count as u64)
            .ok_or(Failure::Archive("archive_too_large"))?;
    }
    Ok((total, hex(&hasher.finalize())))
}

fn read_u32(input: &mut impl Read) -> Result<u32, Failure> {
    let mut bytes = [0u8; 4];
    input
        .read_exact(&mut bytes)
        .map_err(|_| Failure::Archive("archive_truncated"))?;
    Ok(u32::from_be_bytes(bytes))
}
fn nonce(prefix: &[u8; 16], index: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..16].copy_from_slice(prefix);
    nonce[16..].copy_from_slice(&index.to_be_bytes());
    nonce
}
fn aad(manifest: &[u8], index: u64, final_chunk: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(manifest.len() + 9);
    aad.extend_from_slice(manifest);
    aad.extend_from_slice(&index.to_be_bytes());
    aad.push(u8::from(final_chunk));
    aad
}
fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex(&digest)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}
fn decode_hex_16(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (index, item) in out.iter_mut().enumerate() {
        *item = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}
