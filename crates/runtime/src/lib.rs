//! Fail-closed gVisor runtime executor for owned M3 fixtures.

pub mod release_worker;

use hostlet_contracts::{PROTOCOL_VERSION, validate_protocol_version};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, net::IpAddr, path::PathBuf, process::Command};
use uuid::Uuid;

pub const SERVICE_NAME: &str = "hostlet-runtime";
const USAGE: &str = "usage: hostlet-runtime [--version|--check-config] | owned-fixture --request-file FILE --launcher FILE --state-root DIR --artifact-root DIR --runsc FILE | release-worker --control-url URL --worker-id ID --token-file FILE --coordinator FILE --probe FILE --migration-probe FILE --runtime-binary FILE --launcher FILE --runsc FILE --peer-helper FILE [--privileged-command FILE] --state-root DIR --runtime-root DIR --artifact-root DIR --runtime-artifact-root DIR [--once]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Version,
    CheckConfig,
    Run,
    OwnedFixture(ExecutorOptions),
    ReleaseWorker(Box<release_worker::ReleaseReconcilerOptions>),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutorOptions {
    request_file: PathBuf,
    launcher: PathBuf,
    state_root: PathBuf,
    artifact_root: PathBuf,
    runsc: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeRequest {
    schema: String,
    profile: String,
    operation: Operation,
    allocation_id: Uuid,
    generation: u64,
    fence: u64,
    artifact_digest: String,
    runtime_binary_digest: String,
    policy_digest: String,
    capability_digest: Option<String>,
    platform: Platform,
    argv: Vec<String>,
    environment: Vec<EnvironmentName>,
    secret_version_refs: Vec<SecretReference>,
    health_port: u16,
    health_path: String,
    application_port: u16,
    network: NetworkPolicy,
    resources: ResourcePolicy,
    #[serde(default)]
    exit_history_unix_ms: Vec<u64>,
    #[serde(default)]
    observed_at_unix_ms: u64,
}
#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Validate,
    Prepare,
    Start,
    Inspect,
    Reconcile,
    Stop,
    Cleanup,
    RecordExit,
}
#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Platform {
    Systrap,
    Kvm,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentName {
    name: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SecretReference {
    name: String,
    version_id: Uuid,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NetworkPolicy {
    application_ipv4: String,
    gateway_ipv4: String,
    application_ipv6: String,
    gateway_ipv6: String,
    ingress_sources: Vec<Endpoint>,
    outbound_destinations: Vec<Endpoint>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    address: String,
    port: u16,
    protocol: Transport,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Transport {
    Tcp,
    Udp,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ResourcePolicy {
    memory_bytes: u64,
    memory_swap_bytes: u64,
    cpu_quota_micros: u64,
    cpu_period_micros: u64,
    pids: u64,
    scratch_bytes: u64,
    max_connections: u64,
    new_connections_per_second: u64,
    new_connections_burst: u64,
}

pub fn parse_action(args: &[String]) -> Result<Action, String> {
    match args {
        [] => Ok(Action::Run),
        [flag] if flag == "--version" => Ok(Action::Version),
        [flag] if flag == "--check-config" => Ok(Action::CheckConfig),
        [command, rest @ ..] if command == "owned-fixture" => {
            parse_executor(rest).map(Action::OwnedFixture)
        }
        [command, rest @ ..] if command == "release-worker" => {
            parse_release_worker(rest).map(|options| Action::ReleaseWorker(Box::new(options)))
        }
        _ => Err(USAGE.to_owned()),
    }
}

fn parse_release_worker(
    args: &[String],
) -> Result<release_worker::ReleaseReconcilerOptions, String> {
    let (
        mut control_url,
        mut worker_id,
        mut token_file,
        mut coordinator,
        mut probe,
        mut migration_probe,
        mut runtime_binary,
        mut launcher,
        mut runsc,
        mut peer_helper,
        mut privileged_command,
        mut state_root,
        mut runtime_root,
        mut artifact_root,
        mut runtime_artifact_root,
    ) = (
        None, None, None, None, None, None, None, None, None, None, None, None, None, None, None,
    );
    let mut once = false;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--once" {
            if once {
                return Err(USAGE.to_owned());
            }
            once = true;
            i += 1;
            continue;
        }
        let target = match args[i].as_str() {
            "--control-url" => &mut control_url,
            "--worker-id" => &mut worker_id,
            "--token-file" => &mut token_file,
            "--coordinator" => &mut coordinator,
            "--probe" => &mut probe,
            "--migration-probe" => &mut migration_probe,
            "--runtime-binary" => &mut runtime_binary,
            "--launcher" => &mut launcher,
            "--runsc" => &mut runsc,
            "--peer-helper" => &mut peer_helper,
            "--privileged-command" => &mut privileged_command,
            "--state-root" => &mut state_root,
            "--runtime-root" => &mut runtime_root,
            "--artifact-root" => &mut artifact_root,
            "--runtime-artifact-root" => &mut runtime_artifact_root,
            _ => return Err(USAGE.to_owned()),
        };
        i += 1;
        let value = args.get(i).ok_or_else(|| USAGE.to_owned())?;
        if target.replace(value.clone()).is_some() {
            return Err(USAGE.to_owned());
        }
        i += 1;
    }
    Ok(release_worker::ReleaseReconcilerOptions {
        control_url: control_url.ok_or_else(|| USAGE.to_owned())?,
        worker_id: worker_id.ok_or_else(|| USAGE.to_owned())?,
        token_file: PathBuf::from(token_file.ok_or_else(|| USAGE.to_owned())?),
        coordinator: PathBuf::from(coordinator.ok_or_else(|| USAGE.to_owned())?),
        probe: PathBuf::from(probe.ok_or_else(|| USAGE.to_owned())?),
        migration_probe: PathBuf::from(migration_probe.ok_or_else(|| USAGE.to_owned())?),
        runtime_binary: PathBuf::from(runtime_binary.ok_or_else(|| USAGE.to_owned())?),
        launcher: PathBuf::from(launcher.ok_or_else(|| USAGE.to_owned())?),
        runsc: PathBuf::from(runsc.ok_or_else(|| USAGE.to_owned())?),
        peer_helper: PathBuf::from(peer_helper.ok_or_else(|| USAGE.to_owned())?),
        privileged_command: privileged_command.map(PathBuf::from),
        state_root: PathBuf::from(state_root.ok_or_else(|| USAGE.to_owned())?),
        runtime_root: PathBuf::from(runtime_root.ok_or_else(|| USAGE.to_owned())?),
        artifact_root: PathBuf::from(artifact_root.ok_or_else(|| USAGE.to_owned())?),
        runtime_artifact_root: PathBuf::from(
            runtime_artifact_root.ok_or_else(|| USAGE.to_owned())?,
        ),
        once,
    })
}

fn parse_executor(args: &[String]) -> Result<ExecutorOptions, String> {
    let (mut request_file, mut launcher, mut state_root, mut artifact_root, mut runsc) =
        (None, None, None, None, None);
    let mut i = 0;
    while i < args.len() {
        let target = match args[i].as_str() {
            "--request-file" => &mut request_file,
            "--launcher" => &mut launcher,
            "--state-root" => &mut state_root,
            "--artifact-root" => &mut artifact_root,
            "--runsc" => &mut runsc,
            _ => return Err(USAGE.to_owned()),
        };
        i += 1;
        let value = args.get(i).ok_or_else(|| USAGE.to_owned())?;
        if target.replace(PathBuf::from(value)).is_some() {
            return Err(USAGE.to_owned());
        }
        i += 1;
    }
    Ok(ExecutorOptions {
        request_file: request_file.ok_or_else(|| USAGE.to_owned())?,
        launcher: launcher.ok_or_else(|| USAGE.to_owned())?,
        state_root: state_root.ok_or_else(|| USAGE.to_owned())?,
        artifact_root: artifact_root.ok_or_else(|| USAGE.to_owned())?,
        runsc: runsc.ok_or_else(|| USAGE.to_owned())?,
    })
}

pub fn execute<W: Write, E: Write>(args: &[String], output: &mut W, error: &mut E) -> i32 {
    match parse_action(args) {
        Ok(Action::Version) => {
            let _ = writeln!(output, "{SERVICE_NAME} {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Ok(Action::CheckConfig) => match validate_protocol_version(PROTOCOL_VERSION) {
            Ok(()) => {
                let _ = writeln!(
                    error,
                    "{SERVICE_NAME} scaffold is not configured; enrollment is not configured"
                );
                1
            }
            Err(e) => {
                let _ = writeln!(error, "protocol configuration error: {e}");
                2
            }
        },
        Ok(Action::Run) => {
            let _ = writeln!(
                error,
                "{SERVICE_NAME} scaffold not enrolled; no agent work is executed"
            );
            1
        }
        Ok(Action::OwnedFixture(options)) => run_owned_fixture(options, output, error),
        Ok(Action::ReleaseWorker(options)) => {
            release_worker::run_reconciler(*options, output, error)
        }
        Err(message) => {
            let _ = writeln!(error, "{message}");
            2
        }
    }
}

fn run_owned_fixture<W: Write, E: Write>(o: ExecutorOptions, output: &mut W, error: &mut E) -> i32 {
    let bytes = match fs::read(&o.request_file) {
        Ok(v) if v.len() <= 1024 * 1024 => v,
        _ => {
            let _ = writeln!(error, "runtime_request_unreadable");
            return 2;
        }
    };
    let request: RuntimeRequest = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            let _ = writeln!(error, "runtime_request_invalid");
            return 2;
        }
    };
    if let Err(code) = validate_request(&request, &o) {
        let _ = writeln!(error, "{code}");
        return 2;
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if matches!(request.operation, Operation::Validate) {
        return emit(
            output,
            serde_json::json!({"schema":"hostlet.runtime.executor-receipt/v1","operation":"validate","result":"passed","status":"prepared","reason_code":"runtime_request_valid","allocation_id":request.allocation_id,"generation":request.generation,"fence":request.fence,"observed_at_unix_ms":request.observed_at_unix_ms,"profile":request.profile,"artifact_digest":request.artifact_digest,"runtime_binary_digest":request.runtime_binary_digest,"policy_digest":request.policy_digest,"capability_digest":request.capability_digest,"platform":request.platform,"sandbox_id":null,"oci_config_digest":null,"runsc_status":null,"namespace_inodes":[],"observed_limits":null,"network":null,"health":null,"cleanup":null}),
        );
    }
    if matches!(request.operation, Operation::RecordExit) {
        return restart_decision(&request, output);
    }
    match Command::new("/usr/bin/sudo")
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .arg("-n")
        .arg("--")
        .arg(&o.launcher)
        .arg("--request-file")
        .arg(&o.request_file)
        .arg("--request-sha256")
        .arg(&digest)
        .arg("--state-root")
        .arg(&o.state_root)
        .arg("--artifact-root")
        .arg(&o.artifact_root)
        .arg("--runsc")
        .arg(&o.runsc)
        .status()
    {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => {
            let _ = writeln!(error, "runtime_launcher_unavailable");
            1
        }
    }
}

fn validate_request(r: &RuntimeRequest, o: &ExecutorOptions) -> Result<(), &'static str> {
    if r.schema != "hostlet.runtime.executor-request/v1"
        || !matches!(
            r.profile.as_str(),
            "owned_fixture_evaluation" | "evidence_gated_owned_fixture"
        )
    {
        return Err("runtime_profile_not_admitted");
    }
    if r.generation == 0
        || r.generation > i64::MAX as u64
        || r.fence == 0
        || r.fence > i64::MAX as u64
    {
        return Err("runtime_generation_invalid");
    }
    valid_digest(&r.artifact_digest)?;
    valid_digest(&r.runtime_binary_digest)?;
    valid_digest(&r.policy_digest)?;
    match (r.profile.as_str(), &r.capability_digest) {
        ("owned_fixture_evaluation", None) => {}
        ("evidence_gated_owned_fixture", Some(value)) => valid_digest(value)?,
        _ => return Err("runtime_isolation_unverified"),
    }
    if r.argv.is_empty()
        || r.argv.len() > 32
        || r.argv
            .iter()
            .any(|v| v.is_empty() || v.len() > 4096 || v.as_bytes().contains(&0))
    {
        return Err("runtime_argv_invalid");
    }
    if r.environment.len() > 64 || r.environment.iter().any(|v| !valid_env(&v.name)) {
        return Err("runtime_environment_invalid");
    }
    if r.secret_version_refs.len() > 32 || r.secret_version_refs.iter().any(|v| !valid_env(&v.name))
    {
        return Err("runtime_secret_reference_invalid");
    }
    let mut secret_names = std::collections::HashSet::new();
    if r.secret_version_refs
        .iter()
        .any(|v| !secret_names.insert(&v.name))
    {
        return Err("runtime_secret_reference_invalid");
    }
    if r.application_port == 0 || r.health_port == 0 || !valid_health_path(&r.health_path) {
        return Err("runtime_port_invalid");
    }
    for v in [&r.network.application_ipv4, &r.network.gateway_ipv4] {
        v.parse::<std::net::Ipv4Addr>()
            .map_err(|_| "runtime_ipv4_invalid")?;
    }
    for v in [&r.network.application_ipv6, &r.network.gateway_ipv6] {
        v.parse::<std::net::Ipv6Addr>()
            .map_err(|_| "runtime_ipv6_invalid")?;
    }
    if r.network.ingress_sources.len() > 16 || r.network.outbound_destinations.len() > 64 {
        return Err("runtime_network_policy_too_large");
    }
    for e in r
        .network
        .ingress_sources
        .iter()
        .chain(&r.network.outbound_destinations)
    {
        e.address
            .parse::<IpAddr>()
            .map_err(|_| "runtime_endpoint_invalid")?;
        if e.port == 0 {
            return Err("runtime_endpoint_invalid");
        }
    }
    let p = &r.resources;
    if (
        p.memory_bytes,
        p.memory_swap_bytes,
        p.cpu_quota_micros,
        p.cpu_period_micros,
        p.pids,
        p.scratch_bytes,
        p.max_connections,
        p.new_connections_per_second,
        p.new_connections_burst,
    ) != (
        536_870_912,
        0,
        25_000,
        100_000,
        128,
        268_435_456,
        128,
        20,
        40,
    ) {
        return Err("runtime_policy_not_admitted");
    }
    if [&o.launcher, &o.state_root, &o.artifact_root, &o.runsc]
        .iter()
        .any(|v| !v.is_absolute())
    {
        return Err("runtime_host_path_not_absolute");
    }
    if r.exit_history_unix_ms.len() > 64 {
        return Err("runtime_exit_history_invalid");
    }
    Ok(())
}

fn valid_digest(v: &str) -> Result<(), &'static str> {
    let Some(h) = v.strip_prefix("sha256:") else {
        return Err("runtime_digest_invalid");
    };
    if h.len() != 64
        || !h
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    {
        return Err("runtime_digest_invalid");
    }
    Ok(())
}
fn valid_env(v: &str) -> bool {
    let mut b = v.bytes();
    matches!(b.next(), Some(b'A'..=b'Z' | b'_'))
        && b.all(|c| matches!(c, b'A'..=b'Z' | b'0'..=b'9' | b'_'))
        && v.len() <= 128
}
fn valid_health_path(v: &str) -> bool {
    v.starts_with('/')
        && v.len() <= 256
        && !v.contains('?')
        && !v.contains('#')
        && !v.bytes().any(|b| b.is_ascii_control())
}
fn emit<W: Write>(out: &mut W, value: serde_json::Value) -> i32 {
    if serde_json::to_writer(&mut *out, &value).is_ok() && writeln!(out).is_ok() {
        0
    } else {
        1
    }
}
fn restart_decision<W: Write>(r: &RuntimeRequest, out: &mut W) -> i32 {
    let floor = r.observed_at_unix_ms.saturating_sub(600_000);
    let count = r
        .exit_history_unix_ms
        .iter()
        .filter(|&&at| at >= floor && at <= r.observed_at_unix_ms)
        .count();
    let delays = [1_u64, 2, 4, 8, 16, 30];
    let (status, reason) = if count >= delays.len() {
        ("crash_loop_backoff", "crash_loop_backoff")
    } else {
        ("restart_scheduled", "runtime_exit")
    };
    emit(
        out,
        serde_json::json!({"schema":"hostlet.runtime.executor-receipt/v1","operation":"record_exit","result":"passed","status":status,"reason_code":reason,"allocation_id":r.allocation_id,"generation":r.generation,"fence":r.fence,"observed_at_unix_ms":r.observed_at_unix_ms,"profile":r.profile,"artifact_digest":r.artifact_digest,"runtime_binary_digest":r.runtime_binary_digest,"policy_digest":r.policy_digest,"capability_digest":r.capability_digest,"platform":r.platform,"sandbox_id":null,"oci_config_digest":null,"runsc_status":null,"namespace_inodes":[],"observed_limits":null,"network":null,"health":null,"cleanup":null}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_commands_are_explicit() {
        assert_eq!(parse_action(&[]).unwrap(), Action::Run);
        assert_eq!(
            parse_action(&["--version".to_owned()]).unwrap(),
            Action::Version
        );
        assert_eq!(
            parse_action(&["--check-config".to_owned()]).unwrap(),
            Action::CheckConfig
        );
    }

    #[test]
    fn default_execution_refuses_to_simulate_a_reconciler() {
        let mut output = Vec::new();
        let mut error = Vec::new();
        assert_eq!(execute(&[], &mut output, &mut error), 1);
        assert!(
            String::from_utf8(error)
                .unwrap()
                .contains("scaffold not enrolled")
        );
    }
}
