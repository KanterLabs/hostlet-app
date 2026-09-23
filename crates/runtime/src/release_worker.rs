//! Fail-closed adapter for the owned-fixture coordinated release worker.
//!
//! The control plane supplies identities, immutable digests and a loopback
//! backend endpoint. It never supplies a host path or command. The privileged
//! process resolves artifacts below its configured CAS root and delegates the
//! HCA1 extraction, health probe and atomic route installation to the reviewed
//! coordinator program.

use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseReconcilerOptions {
    pub control_url: String,
    pub worker_id: String,
    pub token_file: PathBuf,
    pub coordinator: PathBuf,
    pub probe: PathBuf,
    pub migration_probe: PathBuf,
    pub runtime_binary: PathBuf,
    pub launcher: PathBuf,
    pub runsc: PathBuf,
    pub peer_helper: PathBuf,
    pub runtime_artifact_root: PathBuf,
    pub privileged_command: Option<PathBuf>,
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
    pub artifact_root: PathBuf,
    pub once: bool,
}

/// Poll the durable control queue and execute one reconciliation at a time.
///
/// Returning after a transport failure is intentional: a service manager owns
/// bounded restart/backoff, while the durable attempt fence makes every local
/// stage/probe/switch operation safe to repeat after restart.
pub fn run_reconciler<W: Write, E: Write>(
    options: ReleaseReconcilerOptions,
    output: &mut W,
    error: &mut E,
) -> i32 {
    if let Err(code) = validate_reconciler_options(&options) {
        return fail(error, code, 2);
    }
    if scrub_stale_probe_credentials(&options.state_root).is_err() {
        return fail(error, "release_probe_credential_cleanup_failed", 2);
    }
    let mut token = match fs::read_to_string(&options.token_file) {
        Ok(value) => value.trim_end_matches(['\r', '\n']).to_owned(),
        Err(_) => return fail(error, "release_worker_token_unreadable", 2),
    };
    if !(32..=256).contains(&token.len())
        || token.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        token.zeroize();
        return fail(error, "release_worker_token_invalid", 2);
    }
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(value) => value,
        Err(_) => {
            token.zeroize();
            return fail(error, "release_worker_http_unavailable", 1);
        }
    };
    loop {
        let result = reconcile_once(&client, &options, &token, output, error);
        if options.once || result != 0 {
            token.zeroize();
            return result;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn reconcile_once<W: Write, E: Write>(
    client: &reqwest::blocking::Client,
    options: &ReleaseReconcilerOptions,
    token: &str,
    output: &mut W,
    error: &mut E,
) -> i32 {
    let lease_url = format!(
        "{}/internal/v1/release-reconciliations/lease",
        options.control_url
    );
    let response = match client
        .post(&lease_url)
        .bearer_auth(token)
        .json(&serde_json::json!({"worker_id":options.worker_id}))
        .send()
    {
        Ok(value) => value,
        Err(_) => return fail(error, "release_lease_unavailable", 1),
    };
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return 0;
    }
    if response.status() != reqwest::StatusCode::OK {
        return fail(error, "release_lease_rejected", 1);
    }
    let lease: serde_json::Value = match response.json() {
        Ok(value) => value,
        Err(_) => return fail(error, "release_lease_invalid", 1),
    };
    let identity = match LeaseIdentity::read(&lease, &options.worker_id) {
        Ok(value) => value,
        Err(code) => return fail(error, code, 1),
    };
    let phase = lease
        .pointer("/reconciliation/requirements/phase")
        .and_then(|value| value.as_str())
        .unwrap_or("standard");
    if phase == "prepared_switch" {
        let prepared = match prepared_resume(&lease) {
            Ok(value) => value,
            Err(code) => return fail(error, code, 1),
        };
        return switch_and_activate(client, options, token, &identity, &prepared, output, error);
    }

    let staged = match run_coordinator("stage", &lease, options, Some(&identity), client, token) {
        Ok(value) => value,
        Err(code) => {
            let _ = complete(
                client,
                options,
                token,
                &identity,
                CompletionOutcome {
                    state: "failed",
                    code,
                    digests: &[],
                    migration_receipt: None,
                    materialized_ref: None,
                    stage_receipt_digest: None,
                },
            );
            let _ = writeln!(
                output,
                "{}",
                serde_json::json!({
                    "reconciliation_id":identity.reconciliation_id,"state":"failed","code":code
                })
            );
            return 0;
        }
    };
    let (materialized_ref, stage_receipt_digest) = if phase == "prepare_trial" {
        let Some(reference) = staged
            .get("migration_materialized_ref")
            .and_then(|value| value.as_str())
        else {
            return fail(error, "release_migration_materialization_invalid", 1);
        };
        let digest = match store_evidence(&options.state_root, &staged) {
            Ok(value) => value,
            Err(_) => return fail(error, "release_stage_receipt_store_failed", 1),
        };
        (Some(reference), Some(digest))
    } else {
        (None, None)
    };
    let probes = match lease.get("required_probes").and_then(|v| v.as_array()) {
        Some(value) if !value.is_empty() && value.len() <= 16 => value,
        Some(value) if value.is_empty() && phase == "prepare_trial" => value,
        _ => {
            let _ = complete(
                client,
                options,
                token,
                &identity,
                CompletionOutcome {
                    state: "failed",
                    code: "release_probes_missing",
                    digests: &[],
                    migration_receipt: None,
                    materialized_ref: None,
                    stage_receipt_digest: None,
                },
            );
            return fail(error, "release_probes_missing", 1);
        }
    };
    let mut receipt_digests = Vec::with_capacity(probes.len());
    for probe_request in probes {
        if renew(client, options, token, &identity).is_err() {
            return fail(error, "release_lease_lost", 1);
        }
        match execute_probe(probe_request, &lease, options, client, token, &identity) {
            Ok((digest, passed)) => {
                receipt_digests.push(digest);
                if !passed {
                    let _ = complete(
                        client,
                        options,
                        token,
                        &identity,
                        CompletionOutcome {
                            state: "failed",
                            code: "release_probe_failed",
                            digests: &receipt_digests,
                            migration_receipt: None,
                            materialized_ref: None,
                            stage_receipt_digest: None,
                        },
                    );
                    let _ = writeln!(
                        output,
                        "{}",
                        serde_json::json!({
                            "reconciliation_id":identity.reconciliation_id,"state":"failed","code":"release_probe_failed"
                        })
                    );
                    return 0;
                }
            }
            Err(code) => {
                let _ = complete(
                    client,
                    options,
                    token,
                    &identity,
                    CompletionOutcome {
                        state: "failed",
                        code,
                        digests: &receipt_digests,
                        migration_receipt: None,
                        materialized_ref: None,
                        stage_receipt_digest: None,
                    },
                );
                let _ = writeln!(
                    output,
                    "{}",
                    serde_json::json!({
                        "reconciliation_id":identity.reconciliation_id,"state":"failed","code":code
                    })
                );
                return 0;
            }
        }
    }
    let migration_receipt = lease
        .pointer("/candidate/isolated_apply_receipt_digest")
        .or_else(|| lease.pointer("/migration/migration_apply_receipt_digest"))
        .or_else(|| lease.pointer("/migration/apply_receipt_digest"))
        .and_then(|value| value.as_str());
    let prepared = match complete(
        client,
        options,
        token,
        &identity,
        CompletionOutcome {
            state: "succeeded",
            code: "release_checks_passed",
            digests: &receipt_digests,
            migration_receipt,
            materialized_ref,
            stage_receipt_digest: stage_receipt_digest.as_deref(),
        },
    ) {
        Ok(value) => value,
        Err(code) => return fail(error, code, 1),
    };
    // Migration reconciliations deliberately release their attempt while the
    // fenced database worker performs the server-accepted live apply. A later
    // lease resumes final probes. Only `prepared` may cross the route boundary.
    let completion_state = prepared
        .get("state")
        .or_else(|| prepared.pointer("/reconciliation/state"))
        .and_then(|value| value.as_str());
    if completion_state != Some("prepared") {
        let Some(state @ ("awaiting_trial" | "awaiting_live_apply" | "awaiting_final_probes")) =
            completion_state
        else {
            return fail(error, "release_completion_invalid", 1);
        };
        let _ = writeln!(
            output,
            "{}",
            serde_json::json!({
                "reconciliation_id":identity.reconciliation_id,"state":state
            })
        );
        return 0;
    }
    switch_and_activate(client, options, token, &identity, &prepared, output, error)
}

fn prepared_resume(lease: &serde_json::Value) -> Result<serde_json::Value, &'static str> {
    if lease
        .pointer("/reconciliation/state")
        .and_then(|value| value.as_str())
        != Some("prepared")
        || !lease
            .get("required_probes")
            .and_then(|value| value.as_array())
            .is_some_and(Vec::is_empty)
    {
        return Err("release_prepared_resume_invalid");
    }
    let result = lease
        .pointer("/reconciliation/result")
        .and_then(|value| value.as_object())
        .ok_or("release_prepared_resume_invalid")?;
    for key in [
        "route_manifest",
        "route_manifest_json",
        "route_manifest_digest",
        "route_generation",
        "drain_expires_at",
    ] {
        if !result.contains_key(key) {
            return Err("release_prepared_resume_invalid");
        }
    }
    let mut prepared = result.clone();
    prepared.insert(
        "state".to_owned(),
        serde_json::Value::String("prepared".to_owned()),
    );
    prepared.insert(
        "reconciliation".to_owned(),
        lease
            .get("reconciliation")
            .cloned()
            .ok_or("release_prepared_resume_invalid")?,
    );
    Ok(serde_json::Value::Object(prepared))
}

fn switch_and_activate<W: Write, E: Write>(
    client: &reqwest::blocking::Client,
    options: &ReleaseReconcilerOptions,
    token: &str,
    identity: &LeaseIdentity,
    prepared: &serde_json::Value,
    output: &mut W,
    error: &mut E,
) -> i32 {
    let switch_receipt =
        match run_coordinator("switch", prepared, options, Some(identity), client, token) {
            Ok(value) => value,
            Err(code) => return fail(error, code, 1),
        };
    let switch_digest = match store_evidence(&options.state_root, &switch_receipt) {
        Ok(value) => value,
        Err(_) => return fail(error, "release_switch_receipt_store_failed", 1),
    };
    let activate_url = format!(
        "{}/internal/v1/release-reconciliations/{}/activate",
        options.control_url, identity.reconciliation_id
    );
    let activated = client
        .post(activate_url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "worker_id":options.worker_id,"attempt_id":identity.attempt_id,"fence":identity.fence,
            "switch_receipt_digest":switch_digest
        }))
        .send();
    match activated {
        Ok(value) if value.status().is_success() => {
            let _ = writeln!(
                output,
                "{}",
                serde_json::json!({"reconciliation_id":identity.reconciliation_id,"state":"activated","switch_receipt_digest":switch_digest})
            );
            0
        }
        _ => fail(error, "release_activation_unconfirmed", 1),
    }
}

struct LeaseIdentity {
    reconciliation_id: Uuid,
    attempt_id: Uuid,
    fence: u64,
}

struct CompletionOutcome<'a> {
    state: &'a str,
    code: &'a str,
    digests: &'a [String],
    migration_receipt: Option<&'a str>,
    materialized_ref: Option<&'a str>,
    stage_receipt_digest: Option<&'a str>,
}
impl LeaseIdentity {
    fn read(value: &serde_json::Value, worker_id: &str) -> Result<Self, &'static str> {
        let reconciliation_id = json_uuid(value, "/reconciliation/id")?;
        let attempt_id = json_uuid(value, "/attempt/id")?;
        let fence = value
            .pointer("/attempt/fence")
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0)
            .ok_or("release_lease_invalid")?;
        if value.pointer("/attempt/worker_id").and_then(|v| v.as_str()) != Some(worker_id) {
            return Err("release_lease_invalid");
        }
        Ok(Self {
            reconciliation_id,
            attempt_id,
            fence,
        })
    }
}

fn json_uuid(value: &serde_json::Value, pointer: &str) -> Result<Uuid, &'static str> {
    value
        .pointer(pointer)
        .and_then(|v| v.as_str())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or("release_lease_invalid")
}
fn renew(
    client: &reqwest::blocking::Client,
    options: &ReleaseReconcilerOptions,
    token: &str,
    id: &LeaseIdentity,
) -> Result<(), ()> {
    let url = format!(
        "{}/internal/v1/release-reconciliations/{}/renew",
        options.control_url, id.reconciliation_id
    );
    client.post(url).bearer_auth(token).json(&serde_json::json!({"worker_id":options.worker_id,"attempt_id":id.attempt_id,"fence":id.fence}))
        .send().ok().filter(|r| r.status().is_success()).map(|_| ()).ok_or(())
}
fn complete(
    client: &reqwest::blocking::Client,
    options: &ReleaseReconcilerOptions,
    token: &str,
    id: &LeaseIdentity,
    outcome: CompletionOutcome<'_>,
) -> Result<serde_json::Value, &'static str> {
    let url = format!(
        "{}/internal/v1/release-reconciliations/{}/complete",
        options.control_url, id.reconciliation_id
    );
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "worker_id":options.worker_id,"attempt_id":id.attempt_id,"fence":id.fence,
            "outcome":{"state":outcome.state,"code":outcome.code,"probe_receipt_digests":outcome.digests,
                "migration_apply_receipt_digest":outcome.migration_receipt,
                "migration_materialized_ref":outcome.materialized_ref,
                "migration_stage_receipt_digest":outcome.stage_receipt_digest}
        }))
        .send()
        .map_err(|_| "release_completion_unavailable")?;
    if !response.status().is_success() {
        return Err("release_completion_rejected");
    }
    response.json().map_err(|_| "release_completion_invalid")
}

fn execute_probe(
    request: &serde_json::Value,
    lease: &serde_json::Value,
    options: &ReleaseReconcilerOptions,
    client: &reqwest::blocking::Client,
    token: &str,
    identity: &LeaseIdentity,
) -> Result<(String, bool), &'static str> {
    if request.get("schema").and_then(|value| value.as_str())
        == Some("hostlet.runtime.migration-probe-request/v1")
    {
        return execute_migration_probe(request, options, client, token, identity);
    }
    if request
        .get("schema")
        .is_some_and(|v| v.as_str() != Some("hostlet.runtime.probe-request/v1"))
    {
        return Err("release_probe_request_invalid");
    }
    let _allocation = request
        .get("allocation_id")
        .and_then(|v| v.as_str())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or("release_probe_request_invalid")?;
    let _generation = request
        .get("generation")
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .ok_or("release_probe_request_invalid")?;
    let _fence = request
        .get("fence")
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .ok_or("release_probe_request_invalid")?;
    let kind = request
        .get("check_kind")
        .and_then(|v| v.as_str())
        .ok_or("release_probe_request_invalid")?;
    let health_path = lease
        .pointer("/candidate/runtime/health_path")
        .and_then(|v| v.as_str())
        .unwrap_or("/healthz");
    let (method, path_value) = match kind {
        "health" => ("GET", health_path),
        "current_data"
        | "cached_old_frontend_candidate_api"
        | "candidate_frontend_retained_api" => ("POST", "/api/items"),
        _ => return Err("release_probe_request_invalid"),
    };
    let mut enriched = request.clone();
    let object = enriched
        .as_object_mut()
        .ok_or("release_probe_request_invalid")?;
    object.insert(
        "schema".to_owned(),
        serde_json::Value::String("hostlet.runtime.probe-request/v1".to_owned()),
    );
    object.insert(
        "method".to_owned(),
        serde_json::Value::String(method.to_owned()),
    );
    object.insert(
        "path".to_owned(),
        serde_json::Value::String(path_value.to_owned()),
    );
    object.insert(
        "expected_response_sha256".to_owned(),
        serde_json::Value::Null,
    );
    if kind != "health" {
        let release_prefix = request
            .get("release_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .chars()
            .take(8)
            .collect::<String>();
        object.insert("write_body".to_owned(),serde_json::json!({"name":format!("release-probe-{release_prefix}"),"client_release":kind}));
        object.insert(
            "verify_path".to_owned(),
            serde_json::Value::String("/api/items".to_owned()),
        );
    }
    let request_bytes =
        serde_json::to_vec(&enriched).map_err(|_| "release_probe_request_invalid")?;
    let request_sha = format!("{:x}", Sha256::digest(&request_bytes));
    let path = private_temp(&options.state_root, "probe-request", request_bytes)?;
    let mut command = if let Some(privileged) = &options.privileged_command {
        let mut value = Command::new(privileged);
        value.arg("-n").arg("--").arg(&options.probe);
        value
    } else {
        Command::new(&options.probe)
    };
    let result = command
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .arg("--request-file")
        .arg(&path)
        .arg("--request-sha256")
        .arg(request_sha)
        .arg("--state-root")
        .arg(&options.runtime_root)
        .arg("--evidence-root")
        .arg(&options.state_root)
        .output();
    let _ = fs::remove_file(&path);
    let output = result.map_err(|_| "release_probe_unavailable")?;
    if !output.status.success() || output.stdout.len() > 512 * 1024 {
        return Err("release_probe_failed");
    }
    let receipt: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "release_probe_receipt_invalid")?;
    if receipt.get("schema").and_then(|v| v.as_str()) != Some("hostlet.runtime.probe-receipt/v1") {
        return Err("release_probe_receipt_invalid");
    }
    let passed = receipt.get("result").and_then(|v| v.as_str()) == Some("passed");
    let digest = store_evidence(&options.state_root, &receipt)
        .map_err(|_| "release_probe_receipt_store_failed")?;
    Ok((digest, passed))
}

fn execute_migration_probe(
    request: &serde_json::Value,
    options: &ReleaseReconcilerOptions,
    client: &reqwest::blocking::Client,
    token: &str,
    identity: &LeaseIdentity,
) -> Result<(String, bool), &'static str> {
    let execution_id = json_uuid(request, "/probe_execution_id")?;
    let release_id = json_uuid(request, "/release_id")?;
    if json_uuid(request, "/reconciliation_id")? != identity.reconciliation_id
        || json_uuid(request, "/attempt_id")? != identity.attempt_id
        || request
            .get("release_fence")
            .and_then(|value| value.as_u64())
            != Some(identity.fence)
        || request.get("target").and_then(|value| value.as_str()) != Some("isolated")
    {
        return Err("release_migration_probe_identity_invalid");
    }
    let credential_url = format!(
        "{}/internal/v1/release-reconciliations/{}/probe-credential",
        options.control_url, identity.reconciliation_id
    );
    let response = client
        .post(credential_url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "worker_id":options.worker_id,"attempt_id":identity.attempt_id,"fence":identity.fence,
            "probe_execution_id":execution_id,"release_id":release_id,"target":"isolated"
        }))
        .send()
        .map_err(|_| "release_probe_credential_unavailable")?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length > 64 * 1024)
    {
        return Err("release_probe_credential_rejected");
    }
    let mut credential_bytes = response
        .bytes()
        .map_err(|_| "release_probe_credential_invalid")?
        .to_vec();
    if credential_bytes.len() > 64 * 1024 {
        credential_bytes.zeroize();
        return Err("release_probe_credential_invalid");
    }
    let mut credential: serde_json::Value = match serde_json::from_slice(&credential_bytes) {
        Ok(value) => value,
        Err(_) => {
            credential_bytes.zeroize();
            return Err("release_probe_credential_invalid");
        }
    };
    if credential.get("schema").and_then(|value| value.as_str())
        != Some("hostlet.runtime.probe-credential/v1")
        || json_uuid(&credential, "/probe_execution_id").ok() != Some(execution_id)
        || json_uuid(&credential, "/reconciliation_id").ok() != Some(identity.reconciliation_id)
        || json_uuid(&credential, "/attempt_id").ok() != Some(identity.attempt_id)
        || json_uuid(&credential, "/release_id").ok() != Some(release_id)
        || credential
            .get("release_fence")
            .and_then(|value| value.as_u64())
            != Some(identity.fence)
        || credential.get("target").and_then(|value| value.as_str()) != Some("isolated")
    {
        credential_bytes.zeroize();
        return Err("release_probe_credential_invalid");
    }
    let Some(password_value) = credential
        .as_object_mut()
        .and_then(|object| object.remove("password"))
        .and_then(|value| value.as_str().map(str::to_owned))
    else {
        credential_bytes.zeroize();
        return Err("release_probe_credential_invalid");
    };
    let password = zeroize::Zeroizing::new(password_value);
    if !(16..=1024).contains(&password.len()) || password.chars().any(char::is_control) {
        credential_bytes.zeroize();
        return Err("release_probe_credential_invalid");
    }

    let credential_directory = options.state_root.join("probe-credentials");
    if fs::create_dir_all(&credential_directory)
        .and_then(|_| fs::set_permissions(&credential_directory, fs::Permissions::from_mode(0o700)))
        .is_err()
    {
        credential_bytes.zeroize();
        return Err("release_probe_credential_store_failed");
    }
    let credential_path = credential_directory.join(format!("{execution_id}.json"));
    let mut credential_file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&credential_path)
    {
        Ok(value) => value,
        Err(_) => {
            credential_bytes.zeroize();
            return Err("release_probe_credential_store_failed");
        }
    };
    if credential_file
        .write_all(&credential_bytes)
        .and_then(|_| credential_file.sync_all())
        .is_err()
    {
        credential_bytes.zeroize();
        let _ = wipe_remove(&credential_path);
        return Err("release_probe_credential_store_failed");
    }
    let credential_sha = format!("{:x}", Sha256::digest(&credential_bytes));
    credential_bytes.zeroize();
    drop(password);
    drop(credential_file);

    let request_bytes = serde_json::to_vec(request).map_err(|_| "release_probe_request_invalid")?;
    let request_sha = format!("{:x}", Sha256::digest(&request_bytes));
    let request_path = match private_temp(
        &options.state_root,
        "migration-probe-request",
        request_bytes,
    ) {
        Ok(value) => value,
        Err(code) => {
            let _ = wipe_remove(&credential_path);
            return Err(code);
        }
    };
    let mut command = if let Some(privileged) = &options.privileged_command {
        let mut value = Command::new(privileged);
        value.arg("-n").arg("--").arg(&options.migration_probe);
        value
    } else {
        Command::new(&options.migration_probe)
    };
    command
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .arg("--request-file")
        .arg(&request_path)
        .arg("--request-sha256")
        .arg(request_sha)
        .arg("--credential-file")
        .arg(&credential_path)
        .arg("--credential-sha256")
        .arg(credential_sha)
        .arg("--runtime-binary")
        .arg(&options.runtime_binary)
        .arg("--launcher")
        .arg(&options.launcher)
        .arg("--runsc")
        .arg(&options.runsc)
        .arg("--peer-helper")
        .arg(&options.peer_helper)
        .arg("--state-root")
        .arg(&options.runtime_root)
        .arg("--artifact-root")
        .arg(&options.runtime_artifact_root)
        .arg("--evidence-root")
        .arg(&options.state_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(_) => {
            let _ = fs::remove_file(&request_path);
            let _ = wipe_remove(&credential_path);
            return Err("release_migration_probe_unavailable");
        }
    };
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                std::thread::sleep(Duration::from_secs(2));
                if renew(client, options, token, identity).is_err() {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&request_path);
                    let _ = wipe_remove(&credential_path);
                    return Err("release_lease_lost");
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&request_path);
                let _ = wipe_remove(&credential_path);
                return Err("release_migration_probe_failed");
            }
        }
    }
    let result = child.wait_with_output();
    let _ = fs::remove_file(&request_path);
    let _ = wipe_remove(&credential_path);
    let result = result.map_err(|_| "release_migration_probe_unavailable")?;
    if !result.status.success() || result.stdout.len() > 64 * 1024 {
        return Err("release_migration_probe_failed");
    }
    let output: serde_json::Value = serde_json::from_slice(&result.stdout)
        .map_err(|_| "release_migration_probe_receipt_invalid")?;
    if output.get("schema").and_then(|value| value.as_str())
        != Some("hostlet.runtime.migration-probe-result/v1")
        || json_uuid(&output, "/probe_execution_id")? != execution_id
    {
        return Err("release_migration_probe_receipt_invalid");
    }
    let digest = output
        .get("probe_receipt_digest")
        .and_then(|value| value.as_str())
        .filter(|value| valid_digest(value))
        .ok_or("release_migration_probe_receipt_invalid")?;
    Ok((digest.to_owned(), true))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn wipe_remove(path: &Path) -> std::io::Result<()> {
    if let Ok(metadata) = fs::metadata(path) {
        let mut file = OpenOptions::new().write(true).open(path)?;
        let zeros = vec![0_u8; usize::try_from(metadata.len()).unwrap_or(0).min(64 * 1024)];
        file.write_all(&zeros)?;
        file.sync_all()?;
    }
    fs::remove_file(path)
}

fn scrub_stale_probe_credentials(root: &Path) -> std::io::Result<()> {
    let directory = root.join("probe-credentials");
    if !directory.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&directory)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(std::io::Error::other("unsafe probe credential directory"));
    }
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        let safe_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|value| value.strip_suffix(".json"))
            .and_then(|value| Uuid::parse_str(value).ok())
            .is_some();
        if !safe_name
            || !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.len() > 64 * 1024
        {
            return Err(std::io::Error::other("unsafe stale probe credential"));
        }
        wipe_remove(&path)?;
    }
    Ok(())
}

fn run_coordinator(
    operation: &str,
    input: &serde_json::Value,
    options: &ReleaseReconcilerOptions,
    identity: Option<&LeaseIdentity>,
    client: &reqwest::blocking::Client,
    token: &str,
) -> Result<serde_json::Value, &'static str> {
    let path = private_temp(
        &options.state_root,
        "release-input",
        serde_json::to_vec(input).map_err(|_| "release_coordinator_input_invalid")?,
    )?;
    let mut command = Command::new(&options.coordinator);
    command
        .arg(operation)
        .arg("--input-file")
        .arg(&path)
        .arg("--state-root")
        .arg(&options.state_root)
        .arg("--artifact-root")
        .arg(&options.artifact_root);
    if let Some(id) = identity {
        command
            .arg("--reconciliation-id")
            .arg(id.reconciliation_id.to_string())
            .arg("--attempt-id")
            .arg(id.attempt_id.to_string())
            .arg("--fence")
            .arg(id.fence.to_string());
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "release_coordinator_unavailable")?;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                std::thread::sleep(Duration::from_secs(2));
                if let Some(id) = identity
                    && renew(client, options, token, id).is_err()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&path);
                    return Err("release_lease_lost");
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&path);
                return Err("release_coordinator_failed");
            }
        }
    }
    let result = child.wait_with_output();
    let _ = fs::remove_file(&path);
    let result = result.map_err(|_| "release_coordinator_unavailable")?;
    if !result.status.success() || result.stdout.len() > 1024 * 1024 {
        return Err("release_coordinator_failed");
    }
    serde_json::from_slice(&result.stdout).map_err(|_| "release_coordinator_receipt_invalid")
}

fn private_temp(root: &Path, stem: &str, bytes: Vec<u8>) -> Result<PathBuf, &'static str> {
    for sequence in 0..64_u32 {
        let path = root.join(format!(".{stem}-{}-{sequence}.json", std::process::id()));
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&bytes)
                    .map_err(|_| "release_private_write_failed")?;
                file.sync_all()
                    .map_err(|_| "release_private_write_failed")?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("release_private_write_failed"),
        }
    }
    Err("release_private_write_failed")
}
fn store_evidence(root: &Path, value: &serde_json::Value) -> std::io::Result<String> {
    let mut bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    let hex = format!("{:x}", Sha256::digest(&bytes));
    let directory = root.join("evidence").join("sha256").join(&hex[..2]);
    fs::create_dir_all(&directory)?;
    for owned in [
        root.join("evidence"),
        root.join("evidence").join("sha256"),
        directory.clone(),
    ] {
        fs::set_permissions(owned, fs::Permissions::from_mode(0o700))?;
    }
    let destination = directory.join(format!("{}.json", &hex[2..]));
    if !destination.exists() {
        let temporary = directory.join(format!(".{}-{}.tmp", std::process::id(), &hex[..12]));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        match fs::hard_link(&temporary, &destination) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => {
                let _ = fs::remove_file(&temporary);
                return Err(e);
            }
        }
        let _ = fs::remove_file(&temporary);
        fs::File::open(&directory)?.sync_all()?;
    }
    Ok(format!("sha256:{hex}"))
}

fn validate_reconciler_options(options: &ReleaseReconcilerOptions) -> Result<(), &'static str> {
    let url =
        reqwest::Url::parse(&options.control_url).map_err(|_| "release_control_url_invalid")?;
    if url.scheme() != "http"
        || url
            .host_str()
            .filter(|host| *host == "127.0.0.1" || *host == "::1")
            .is_none()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("release_control_url_invalid");
    }
    if options.worker_id.is_empty()
        || options.worker_id.len() > 128
        || !options
            .worker_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err("release_worker_id_invalid");
    }
    for (path, executable) in [
        (&options.state_root, false),
        (&options.runtime_root, false),
        (&options.artifact_root, false),
        (&options.runtime_artifact_root, false),
        (&options.coordinator, true),
        (&options.probe, true),
        (&options.migration_probe, true),
        (&options.runtime_binary, true),
        (&options.launcher, true),
        (&options.runsc, true),
        (&options.peer_helper, true),
    ] {
        if !path.is_absolute() {
            return Err("release_worker_path_invalid");
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| "release_worker_path_invalid")?;
        if metadata.file_type().is_symlink()
            || (executable && (!metadata.is_file() || metadata.permissions().mode() & 0o111 == 0))
            || (!executable && (!metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0))
        {
            return Err("release_worker_path_invalid");
        }
    }
    if let Some(path) = &options.privileged_command {
        if !path.is_absolute() {
            return Err("release_worker_path_invalid");
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| "release_worker_path_invalid")?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.permissions().mode() & 0o111 == 0
        {
            return Err("release_worker_path_invalid");
        }
    }
    let token =
        fs::symlink_metadata(&options.token_file).map_err(|_| "release_worker_token_unreadable")?;
    if !options.token_file.is_absolute()
        || !token.is_file()
        || token.file_type().is_symlink()
        || token.permissions().mode() & 0o077 != 0
    {
        return Err("release_worker_token_invalid");
    }
    Ok(())
}

fn fail<E: Write>(error: &mut E, code: &str, status: i32) -> i32 {
    let _ = writeln!(error, "{code}");
    status
}
