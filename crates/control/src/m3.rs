//! Explicit owned-fixture execution boundary and shared lifecycle policy clock.
//!
//! Authentication, leases and performance measurements intentionally keep real
//! time. Only M3 lifecycle policy uses this clock; advancing it cannot prolong
//! a credential or permit a stale worker completion.

use std::{os::unix::fs::PermissionsExt, path::PathBuf};

use axum::{
    Json, Router,
    extract::{FromRequestParts, State},
    http::{header, request::Parts},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{error::ApiError, foundation::FoundationState};

pub(crate) struct M3Config {
    pub state_dir: PathBuf,
    policy_clock: Option<PathBuf>,
    worker_hashes: [[u8; 32]; 4],
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PolicyTime {
    pub schema_version: u32,
    pub generation: i64,
    pub now: DateTime<Utc>,
}

impl M3Config {
    pub(crate) fn uses_foundation_token(&self, hash: &[u8; 32]) -> bool {
        self.worker_hashes
            .iter()
            .any(|candidate| bool::from(candidate.ct_eq(hash)))
    }

    pub(crate) fn from_env() -> Result<Option<Self>, &'static str> {
        match std::env::var("HOSTLET_M3_MODE").as_deref() {
            Err(std::env::VarError::NotPresent) | Ok("") => return Ok(None),
            Ok("owned_fixture") => {}
            _ => return Err("m3_mode_invalid"),
        }
        let state_dir = std::env::var_os("HOSTLET_M3_STATE_DIR")
            .map(PathBuf::from)
            .ok_or("m3_state_dir_required")?;
        let metadata =
            std::fs::symlink_metadata(&state_dir).map_err(|_| "m3_state_dir_unavailable")?;
        if !state_dir.is_absolute()
            || !metadata.is_dir()
            || metadata.permissions().mode() & 0o077 != 0
            || std::fs::canonicalize(&state_dir).ok().as_ref() != Some(&state_dir)
        {
            return Err("m3_state_dir_invalid");
        }
        let policy_clock = std::env::var_os("HOSTLET_M3_POLICY_CLOCK").map(PathBuf::from);
        if let Some(path) = &policy_clock
            && (!path.starts_with(&state_dir) || path == &state_dir)
        {
            return Err("m3_clock_outside_owned_root");
        }
        let mut worker_hashes = [[0u8; 32]; 4];
        for (index, name) in [
            "HOSTLET_M3_BUILD_TOKEN",
            "HOSTLET_M3_DATABASE_TOKEN",
            "HOSTLET_M3_RUNTIME_TOKEN",
            "HOSTLET_M3_PUBLISHER_TOKEN",
        ]
        .iter()
        .enumerate()
        {
            let mut token = std::env::var(name).map_err(|_| "m3_worker_token_required")?;
            if !(32..=256).contains(&token.len())
                || token.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                zeroize::Zeroize::zeroize(&mut token);
                return Err("m3_worker_token_invalid");
            }
            worker_hashes[index] = Sha256::digest(token.as_bytes()).into();
            zeroize::Zeroize::zeroize(&mut token);
        }
        for index in 0..worker_hashes.len() {
            if worker_hashes[..index].contains(&worker_hashes[index]) {
                return Err("m3_worker_tokens_must_differ");
            }
        }
        let config = Self {
            state_dir,
            policy_clock,
            worker_hashes,
        };
        config.read_policy_time()?;
        Ok(Some(config))
    }

    fn read_policy_time(&self) -> Result<PolicyTime, &'static str> {
        let Some(path) = &self.policy_clock else {
            return Ok(PolicyTime {
                schema_version: 1,
                generation: 0,
                now: Utc::now(),
            });
        };
        let metadata = std::fs::symlink_metadata(path).map_err(|_| "m3_clock_unavailable")?;
        if !metadata.is_file()
            || metadata.len() > 1_024
            || metadata.permissions().mode() & 0o077 != 0
            || std::fs::canonicalize(path).ok().as_ref() != Some(path)
        {
            return Err("m3_clock_invalid");
        }
        let value: PolicyTime =
            serde_json::from_slice(&std::fs::read(path).map_err(|_| "m3_clock_unavailable")?)
                .map_err(|_| "m3_clock_invalid")?;
        if value.schema_version != 1 || value.generation < 1 {
            return Err("m3_clock_invalid");
        }
        Ok(value)
    }
}

pub(crate) fn require_enabled(state: &FoundationState) -> Result<&M3Config, ApiError> {
    state.m3.as_deref().ok_or_else(|| {
        ApiError::unavailable(
            "internal_execution_disabled",
            "owned-fixture execution is not configured",
        )
    })
}

pub(crate) async fn policy_now(state: &FoundationState) -> Result<DateTime<Utc>, ApiError> {
    Ok(policy_time(state).await?.now)
}

async fn policy_time(state: &FoundationState) -> Result<PolicyTime, ApiError> {
    let config = require_enabled(state)?;
    let clock = config.read_policy_time().map_err(|_| {
        ApiError::unavailable(
            "policy_clock_unavailable",
            "the lifecycle policy clock is unavailable",
        )
    })?;
    if config.policy_clock.is_some() {
        let accepted = sqlx::query_scalar::<_, i64>(
            "INSERT INTO m3_policy_clock (singleton,generation,observed_at) VALUES (true,$1,$2) \
             ON CONFLICT (singleton) DO UPDATE SET generation=EXCLUDED.generation,observed_at=EXCLUDED.observed_at \
             WHERE (EXCLUDED.generation > m3_policy_clock.generation AND EXCLUDED.observed_at >= m3_policy_clock.observed_at) \
                OR (EXCLUDED.generation=m3_policy_clock.generation AND EXCLUDED.observed_at=m3_policy_clock.observed_at) \
             RETURNING generation",
        ).bind(clock.generation).bind(clock.now).fetch_optional(&state.pool).await?;
        if accepted.is_none() {
            return Err(ApiError::conflict(
                "policy_clock_regressed",
                "the shared lifecycle policy clock must advance monotonically",
            ));
        }
    }
    Ok(clock)
}

pub(crate) fn internal_routes() -> Router<FoundationState> {
    Router::new().route("/internal/v1/m3/policy-clock", get(read_clock))
}

async fn read_clock(
    State(state): State<FoundationState>,
    _: PolicyClockAuth,
) -> Result<Json<PolicyTime>, ApiError> {
    Ok(Json(policy_time(&state).await?))
}

fn check_worker(
    parts: &Parts,
    state: &FoundationState,
    role: Option<usize>,
) -> Result<(), ApiError> {
    let config = require_enabled(state)?;
    let supplied = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .filter(|token| (32..=256).contains(&token.len()))
        .ok_or_else(ApiError::unauthorized)?;
    let hash: [u8; 32] = Sha256::digest(supplied.as_bytes()).into();
    let matched = match role {
        Some(index) => hash.ct_eq(&config.worker_hashes[index]).unwrap_u8(),
        None => config.worker_hashes.iter().fold(0, |found, expected| {
            found | hash.ct_eq(expected).unwrap_u8()
        }),
    };
    if matched != 1 {
        return Err(ApiError::unauthorized());
    }
    Ok(())
}

macro_rules! worker_auth {
    ($name:ident, $role:expr) => {
        pub(crate) struct $name;
        impl FromRequestParts<FoundationState> for $name {
            type Rejection = ApiError;
            async fn from_request_parts(
                parts: &mut Parts,
                state: &FoundationState,
            ) -> Result<Self, Self::Rejection> {
                check_worker(parts, state, $role)?;
                Ok(Self)
            }
        }
    };
}
worker_auth!(BuildWorkerAuth, Some(0));
worker_auth!(DatabaseWorkerAuth, Some(1));
worker_auth!(RuntimeWorkerAuth, Some(2));
worker_auth!(PublisherWorkerAuth, Some(3));
worker_auth!(PolicyClockAuth, None);
