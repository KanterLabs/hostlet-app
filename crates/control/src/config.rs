use std::{net::SocketAddr, str::FromStr, sync::Arc};

use sha2::{Digest, Sha256};

use crate::{Config, DEFAULT_BIND};

pub const DEFAULT_WORKER_BIND: &str = "127.0.0.1:8081";

pub enum ProcessConfig {
    Scaffold(Config),
    Foundation(FoundationConfig),
}

pub struct FoundationConfig {
    pub api_bind: SocketAddr,
    pub worker_bind: SocketAddr,
    database_url: String,
    worker_token_hash: Option<[u8; 32]>,
    secret_key: Option<KeyMaterial>,
    recovery_key: Option<KeyMaterial>,
    worker_lease_seconds: i64,
}

pub struct FoundationPrerequisites {
    pub worker_token_hash: Option<[u8; 32]>,
    pub secret_key: Option<Arc<crate::crypto::SecretKey>>,
    pub recovery_key: Option<Arc<crate::recovery::RecoveryKey>>,
    pub worker_lease_seconds: i64,
}

struct KeyMaterial([u8; 32]);

pub struct FoundationConfigError {
    variable: &'static str,
    reason: &'static str,
}

impl std::fmt::Debug for FoundationConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FoundationConfigError")
            .field("variable", &self.variable)
            .field("reason", &self.reason)
            .finish()
    }
}

impl std::fmt::Display for FoundationConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "invalid configuration for {}: {}",
            self.variable, self.reason
        )
    }
}

impl std::error::Error for FoundationConfigError {}

impl ProcessConfig {
    pub fn from_env() -> Result<Self, FoundationConfigError> {
        let api_bind = parse_bind(
            "HOSTLET_API_BIND",
            std::env::var("HOSTLET_API_BIND")
                .ok()
                .as_deref()
                .unwrap_or(DEFAULT_BIND),
        )?;
        let Some(database_url) = present_env("DATABASE_URL") else {
            return Ok(Self::Scaffold(Config {
                bind_addr: api_bind,
            }));
        };

        let worker_bind = parse_bind(
            "HOSTLET_WORKER_BIND",
            std::env::var("HOSTLET_WORKER_BIND")
                .ok()
                .as_deref()
                .unwrap_or(DEFAULT_WORKER_BIND),
        )?;
        if !worker_bind.ip().is_loopback() {
            return Err(FoundationConfigError {
                variable: "HOSTLET_WORKER_BIND",
                reason: "must use a loopback address",
            });
        }

        let worker_token_hash = match present_env("HOSTLET_WORKER_TOKEN") {
            Some(token)
                if (32..=256).contains(&token.len())
                    && !token
                        .chars()
                        .any(|character| character.is_whitespace() || character.is_control()) =>
            {
                Some(Sha256::digest(token.as_bytes()).into())
            }
            Some(_) => {
                return Err(FoundationConfigError {
                    variable: "HOSTLET_WORKER_TOKEN",
                    reason: "must contain 32 to 256 non-whitespace bytes",
                });
            }
            None => None,
        };
        let secret_key = optional_key("HOSTLET_SECRET_KEY")?;
        let recovery_key = optional_key("HOSTLET_RECOVERY_KEY")?;
        let worker_lease_seconds = match present_env("HOSTLET_WORKER_LEASE_SECONDS") {
            None => 30,
            Some(value) => value
                .parse::<i64>()
                .ok()
                .filter(|seconds| (2..=300).contains(seconds))
                .ok_or(FoundationConfigError {
                    variable: "HOSTLET_WORKER_LEASE_SECONDS",
                    reason: "must be an integer from 2 through 300",
                })?,
        };
        if matches!((&secret_key, &recovery_key), (Some(left), Some(right)) if left.0 == right.0) {
            return Err(FoundationConfigError {
                variable: "HOSTLET_RECOVERY_KEY",
                reason: "must differ from HOSTLET_SECRET_KEY",
            });
        }

        Ok(Self::Foundation(FoundationConfig {
            api_bind,
            worker_bind,
            database_url,
            worker_token_hash,
            secret_key,
            recovery_key,
            worker_lease_seconds,
        }))
    }
}

impl FoundationConfig {
    pub fn into_runtime_parts(self) -> (SocketAddr, SocketAddr, String, FoundationPrerequisites) {
        let prerequisites = FoundationPrerequisites {
            worker_token_hash: self.worker_token_hash,
            secret_key: self
                .secret_key
                .map(|key| Arc::new(crate::crypto::SecretKey::new(key.0))),
            recovery_key: self
                .recovery_key
                .map(|key| Arc::new(crate::recovery::RecoveryKey::new(key.0))),
            worker_lease_seconds: self.worker_lease_seconds,
        };
        (
            self.api_bind,
            self.worker_bind,
            self.database_url,
            prerequisites,
        )
    }
}

fn parse_bind(variable: &'static str, value: &str) -> Result<SocketAddr, FoundationConfigError> {
    SocketAddr::from_str(value).map_err(|_| FoundationConfigError {
        variable,
        reason: "must be a valid socket address",
    })
}

fn present_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn optional_key(name: &'static str) -> Result<Option<KeyMaterial>, FoundationConfigError> {
    present_env(name)
        .map(|value| decode_key(name, &value))
        .transpose()
}

fn decode_key(variable: &'static str, encoded: &str) -> Result<KeyMaterial, FoundationConfigError> {
    if encoded.len() != 64 {
        return Err(FoundationConfigError {
            variable,
            reason: "must contain exactly 64 hexadecimal characters",
        });
    }
    let mut bytes = [0_u8; 32];
    for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
        let high = decode_hex(pair[0]).ok_or(FoundationConfigError {
            variable,
            reason: "must contain only hexadecimal characters",
        })?;
        let low = decode_hex(pair[1]).ok_or(FoundationConfigError {
            variable,
            reason: "must contain only hexadecimal characters",
        })?;
        bytes[index] = high << 4 | low;
    }
    Ok(KeyMaterial(bytes))
}

fn decode_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

impl Drop for KeyMaterial {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

/// Recovery commands do not require a live source database, listener settings,
/// worker authentication, or the secret-decryption key.
pub fn recovery_key_from_env() -> Result<crate::recovery::RecoveryKey, FoundationConfigError> {
    let key = optional_key("HOSTLET_RECOVERY_KEY")?.ok_or(FoundationConfigError {
        variable: "HOSTLET_RECOVERY_KEY",
        reason: "is required for recovery commands",
    })?;
    if let Some(encoded) = present_env("HOSTLET_SECRET_KEY")
        && let Ok(secret) = decode_key("HOSTLET_SECRET_KEY", &encoded)
        && secret.0 == key.0
    {
        return Err(FoundationConfigError {
            variable: "HOSTLET_RECOVERY_KEY",
            reason: "must differ from HOSTLET_SECRET_KEY",
        });
    }
    Ok(crate::recovery::RecoveryKey::new(key.0))
}
