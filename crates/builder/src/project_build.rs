use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::IpAddr,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use reqwest::{
    StatusCode, Url,
    blocking::{Client, Response},
    header,
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    artifact::{self, ReceivedArtifact},
    build_protocol::{BuildLimits, BuildService, GuestCredential, GuestRequest},
    digest::{cas_path, store_bytes, valid_digest, verify_cas_file},
    vm::{self, BuildProfile, CleanupEvidence},
};

pub(crate) const USAGE: &str = "usage: hostlet-builder project-build-worker --control-url http://LOOPBACK:PORT --worker-id ID --profile FILE --cas-root DIR --work-root DIR [--once --completion-capture FILE]";
const JOB_KIND: &str = "project_build";
const MAX_CONTROL_RESPONSE: u64 = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IDLE_DELAY: Duration = Duration::from_millis(500);
const RENEW_DELAY: Duration = Duration::from_secs(2);
// Every build reserves this fixed allowance in control.  VM teardown can
// legitimately run past the guest timeout, so the measured billable value is
// bounded independently of the supervisor/cleanup duration recorded in the
// worker evidence.
const RESERVED_BUILD_SECONDS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectBuildOptions {
    control_url: String,
    worker_id: String,
    profile_path: PathBuf,
    cas_root: PathBuf,
    work_root: PathBuf,
    completion_capture: Option<PathBuf>,
    once: bool,
}

pub(crate) fn parse_options(args: &[String]) -> Result<ProjectBuildOptions, ()> {
    let mut control_url = None;
    let mut worker_id = None;
    let mut profile_path = None;
    let mut cas_root = None;
    let mut work_root = None;
    let mut completion_capture = None;
    let mut once = false;
    let mut index = 0;
    while index < args.len() {
        let destination = match args[index].as_str() {
            "--control-url" if control_url.is_none() => &mut control_url,
            "--worker-id" if worker_id.is_none() => &mut worker_id,
            "--profile" if profile_path.is_none() => &mut profile_path,
            "--cas-root" if cas_root.is_none() => &mut cas_root,
            "--work-root" if work_root.is_none() => &mut work_root,
            "--completion-capture" if completion_capture.is_none() => &mut completion_capture,
            "--once" if !once => {
                once = true;
                index += 1;
                continue;
            }
            _ => return Err(()),
        };
        index += 1;
        *destination = Some(args.get(index).cloned().ok_or(())?);
        index += 1;
    }
    let control_url = control_url.ok_or(())?;
    validate_control_url(&control_url)?;
    let worker_id = worker_id.ok_or(())?;
    if !valid_worker_id(&worker_id) {
        return Err(());
    }
    let profile_path = absolute_file(profile_path.ok_or(())?)?;
    let cas_root = absolute_directory(cas_root.ok_or(())?)?;
    let work_root = absolute_directory(work_root.ok_or(())?)?;
    let completion_capture = completion_capture.map(absolute_new_file).transpose()?;
    if completion_capture.is_some() && !once {
        return Err(());
    }
    Ok(ProjectBuildOptions {
        control_url,
        worker_id,
        profile_path,
        cas_root,
        work_root,
        completion_capture,
        once,
    })
}

pub(crate) fn run<W: Write>(
    options: ProjectBuildOptions,
    output: &mut W,
) -> Result<(), BuildFailure> {
    let token = BuildToken::from_environment()?;
    let client = ControlClient::new(
        &options.control_url,
        token,
        options.completion_capture.clone(),
    )?;
    let profile_bytes = fs::read(&options.profile_path).map_err(|_| BuildFailure::Configuration)?;
    let profile_digest = format!("sha256:{:x}", Sha256::digest(&profile_bytes));
    let profile: BuildProfile =
        serde_json::from_slice(&profile_bytes).map_err(|_| BuildFailure::Configuration)?;
    vm::verify_profile(&profile).map_err(|_| BuildFailure::Configuration)?;

    loop {
        match client.lease(&options.worker_id, &profile.id, &profile_digest)? {
            Some(lease) => {
                let identity = ClaimIdentity::from_lease(&lease)?;
                write_claim(output, &identity)?;
                process(
                    &client,
                    &options,
                    &profile,
                    &profile_digest,
                    lease,
                    identity,
                    output,
                )?;
            }
            None if options.once => return Ok(()),
            None => thread::sleep(IDLE_DELAY),
        }
        if options.once {
            return Ok(());
        }
    }
}

fn process(
    client: &ControlClient,
    options: &ProjectBuildOptions,
    profile: &BuildProfile,
    profile_digest: &str,
    lease: LeaseResponse,
    identity: ClaimIdentity,
    worker_output: &mut impl Write,
) -> Result<(), BuildFailure> {
    if let Err(failure) = validate_lease(&lease, profile, profile_digest, &options.worker_id) {
        return complete_early_failure(client, options, &identity, &lease.job, failure.code());
    }
    let materialized = match client.materialize(&identity, &options.worker_id) {
        Ok(value) => value,
        Err(failure) => {
            return complete_early_failure(client, options, &identity, &lease.job, failure.code());
        }
    };
    if materialized.commit_sha != lease.job.source_commit
        || materialized.tree_sha != lease.job.source_tree_sha
        || !valid_digest(&materialized.bundle_digest)
        || !valid_digest(&materialized.tree_manifest_digest)
        || materialized.entry_count == 0
        || materialized.total_bytes == 0
    {
        return complete_early_failure(
            client,
            options,
            &identity,
            &lease.job,
            "source_policy_rejected",
        );
    }
    let source_path = match cas_path(&options.cas_root, &materialized.bundle_digest)
        .and_then(|path| verify_cas_file(&path, &materialized.bundle_digest).map(|_| path))
    {
        Ok(path) => path,
        Err(_) => {
            return complete_early_failure(
                client,
                options,
                &identity,
                &lease.job,
                "source_policy_rejected",
            );
        }
    };
    let credential_ids: Vec<&str> = lease
        .job
        .secret_version_refs
        .iter()
        .map(|reference| reference.secret_version_id.as_str())
        .collect();
    let credentials = match client.credentials(&identity, &options.worker_id, &credential_ids) {
        Ok(value) => value,
        Err(failure) => {
            return complete_early_failure(client, options, &identity, &lease.job, failure.code());
        }
    };
    let credentials =
        match validate_credentials(&lease.job.secret_version_refs, credentials.credentials) {
            Ok(value) => value,
            Err(_) => {
                return complete_early_failure(
                    client,
                    options,
                    &identity,
                    &lease.job,
                    "credential_policy_rejected",
                );
            }
        };
    let request = GuestRequest {
        protocol: "hostlet.build-guest/v1".to_owned(),
        job_id: lease.job.id.clone(),
        attempt_id: identity.attempt_id.clone(),
        fence: identity.fence,
        input_manifest_digest: lease.job.input_manifest_digest.clone(),
        source_commit: lease.job.source_commit.clone(),
        source_tree_sha: lease.job.source_tree_sha.clone(),
        source_bundle_digest: materialized.bundle_digest,
        dependency_cache_digest: profile.dependency_cache.digest.clone(),
        services: lease.services,
        credentials,
        limits: lease.job.limits.clone(),
    };
    let attempt_dir = options
        .work_root
        .join(&lease.job.id)
        .join(&identity.attempt_id);
    if attempt_dir.exists() || fs::create_dir_all(&attempt_dir).is_err() {
        return complete_early_failure(client, options, &identity, &lease.job, "platform_fault");
    }

    let fenced = Arc::new(AtomicBool::new(false));
    let renew_stop = Arc::new(AtomicBool::new(false));
    let renew_thread = spawn_renewal(
        client.clone(),
        identity.clone(),
        options.worker_id.clone(),
        Arc::clone(&fenced),
        Arc::clone(&renew_stop),
    );
    let vm_result = vm::run(
        profile,
        &request,
        &source_path,
        &attempt_dir,
        &options.cas_root,
        Arc::clone(&fenced),
    );
    renew_stop.store(true, Ordering::SeqCst);
    let _ = renew_thread.join();

    let mut guest_console = Vec::new();
    let (state, code, artifacts, billable_elapsed, actual_elapsed, cleanup, launch_diagnostic) =
        match vm_result {
            Ok(result) => {
                let vm::VmResult {
                    output,
                    elapsed_seconds: elapsed,
                    actual_elapsed_seconds,
                    cleanup,
                    launch_diagnostic,
                    guest_console: observed_console,
                } = result;
                guest_console = observed_console;
                let billable_elapsed = elapsed.min(RESERVED_BUILD_SECONDS);
                match output {
                    Ok(output) if output.report.state == "succeeded" => {
                        if validate_artifacts(&request.services, &output.artifacts).is_err() {
                            (
                                "failed",
                                "output_invalid",
                                Vec::new(),
                                billable_elapsed,
                                actual_elapsed_seconds,
                                cleanup,
                                launch_diagnostic,
                            )
                        } else {
                            (
                                "succeeded",
                                "build_succeeded",
                                output.artifacts,
                                billable_elapsed,
                                actual_elapsed_seconds,
                                cleanup,
                                launch_diagnostic,
                            )
                        }
                    }
                    Ok(output) => (
                        "failed",
                        safe_guest_code(&output.report.code),
                        Vec::new(),
                        billable_elapsed,
                        actual_elapsed_seconds,
                        cleanup,
                        launch_diagnostic,
                    ),
                    Err(error) if error.kind() == io::ErrorKind::TimedOut => (
                        "failed",
                        "build_timeout",
                        Vec::new(),
                        billable_elapsed,
                        actual_elapsed_seconds,
                        cleanup,
                        launch_diagnostic,
                    ),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => (
                        "failed",
                        "build_canceled",
                        Vec::new(),
                        billable_elapsed,
                        actual_elapsed_seconds,
                        cleanup,
                        launch_diagnostic,
                    ),
                    Err(error)
                        if artifact::output_limit_code(&error)
                            == Some("static_output_too_large") =>
                    {
                        (
                            "failed",
                            "static_output_too_large",
                            Vec::new(),
                            billable_elapsed,
                            actual_elapsed_seconds,
                            cleanup,
                            launch_diagnostic,
                        )
                    }
                    Err(error)
                        if artifact::output_limit_code(&error)
                            == Some("runtime_output_too_large") =>
                    {
                        (
                            "failed",
                            "runtime_output_too_large",
                            Vec::new(),
                            billable_elapsed,
                            actual_elapsed_seconds,
                            cleanup,
                            launch_diagnostic,
                        )
                    }
                    Err(error) => {
                        let mut diagnostic = launch_diagnostic;
                        if diagnostic.is_empty() {
                            diagnostic.extend_from_slice(error.to_string().as_bytes());
                        }
                        (
                            "failed",
                            "platform_fault",
                            Vec::new(),
                            billable_elapsed,
                            actual_elapsed_seconds,
                            cleanup,
                            diagnostic,
                        )
                    }
                }
            }
            Err(error) => {
                let diagnostic = error.to_string().into_bytes();
                let mut cleanup = vm::cleanup_failed_setup(profile, &request, &attempt_dir);
                cleanup.killed_for_fence = fenced.load(Ordering::SeqCst);
                (
                    "failed",
                    "platform_fault",
                    Vec::new(),
                    0,
                    0,
                    cleanup,
                    diagnostic,
                )
            }
        };
    if state == "failed" && !launch_diagnostic.is_empty() {
        write_launch_diagnostic(
            worker_output,
            &identity,
            &launch_diagnostic,
            &request,
            &attempt_dir,
            profile,
        )?;
    }
    if state == "failed"
        && matches!(code, "platform_fault" | "build_failed")
        && !guest_console.is_empty()
    {
        write_guest_console_diagnostic(
            worker_output,
            &identity,
            &guest_console,
            cleanup.console_truncated,
            &request,
        )?;
    }
    write_cleanup_log(worker_output, &identity, &cleanup, actual_elapsed)?;
    if fenced.load(Ordering::SeqCst) {
        let cleanup_receipt_digest =
            store_cleanup_receipt(&options.cas_root, &lease.job, &identity, &cleanup)?;
        let acknowledged = client.cancel_ack(
            &identity,
            &options.worker_id,
            cleanup_receipt_digest,
            billable_elapsed,
        );
        let _ = fs::remove_dir_all(&attempt_dir);
        return acknowledged;
    }
    let completion = prepare_completion(
        &options.cas_root,
        &lease.job,
        &identity,
        state,
        code,
        billable_elapsed,
        cleanup,
        artifacts,
        &request.services,
    )?;
    let completed = client.complete(&identity, &options.worker_id, completion);
    let _ = fs::remove_dir_all(&attempt_dir);
    completed
}

// The completion boundary keeps each signed/fenced field explicit at its only
// construction site so a caller cannot accidentally reuse mutable job state.
#[allow(clippy::too_many_arguments)]
fn prepare_completion(
    cas_root: &Path,
    job: &LeasedJob,
    identity: &ClaimIdentity,
    state: &'static str,
    code: &'static str,
    elapsed_seconds: u64,
    cleanup: CleanupEvidence,
    artifacts: Vec<ReceivedArtifact>,
    services: &[BuildService],
) -> Result<CompletionOutcome, BuildFailure> {
    let cleanup_receipt_digest = store_cleanup_receipt(cas_root, job, identity, &cleanup)?;
    let mut completed_artifacts = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        let service = services
            .iter()
            .find(|service| service.service_id == artifact.service_id)
            .ok_or(BuildFailure::Processing)?;
        let entrypoint_argv = artifact_entrypoint(service, &artifact)?;
        let manifest = ArtifactManifest {
            schema: "hostlet.build-artifact/v1",
            job_id: &job.id,
            attempt_id: &identity.attempt_id,
            fence: identity.fence,
            input_manifest_digest: &job.input_manifest_digest,
            source_commit: &job.source_commit,
            service_id: &artifact.service_id,
            kind: &artifact.kind,
            archive_digest: &artifact.archive_digest,
            packed_bytes: artifact.packed_bytes,
            unpacked_bytes: artifact.unpacked_bytes,
            entry_count: artifact.entry_count,
            entrypoint_argv: entrypoint_argv.as_deref(),
        };
        let bytes = serde_json::to_vec(&manifest).map_err(|_| BuildFailure::Processing)?;
        let manifest_digest =
            store_bytes(cas_root, &bytes).map_err(|_| BuildFailure::Processing)?;
        completed_artifacts.push(CompletedArtifact {
            service_id: artifact.service_id,
            kind: artifact.kind,
            archive_digest: artifact.archive_digest,
            manifest_digest,
            packed_bytes: artifact.packed_bytes,
            unpacked_bytes: artifact.unpacked_bytes,
            entry_count: artifact.entry_count,
            entrypoint_argv,
        });
    }
    let result = ResultManifest {
        schema: "hostlet.build-result/v1",
        job_id: &job.id,
        attempt_id: &identity.attempt_id,
        fence: identity.fence,
        input_manifest_digest: &job.input_manifest_digest,
        state,
        code,
        elapsed_seconds,
        artifacts: &completed_artifacts,
    };
    let result_bytes = serde_json::to_vec(&result).map_err(|_| BuildFailure::Processing)?;
    let result_manifest_digest =
        store_bytes(cas_root, &result_bytes).map_err(|_| BuildFailure::Processing)?;
    Ok(CompletionOutcome {
        state,
        code,
        result_manifest_digest,
        cleanup_receipt_digest,
        elapsed_seconds,
        artifacts: completed_artifacts,
    })
}

fn store_cleanup_receipt(
    cas_root: &Path,
    job: &LeasedJob,
    identity: &ClaimIdentity,
    cleanup: &CleanupEvidence,
) -> Result<String, BuildFailure> {
    let status = if cleanup.qemu_exited && cleanup.sockets_removed && cleanup.workspace_removed {
        "confirmed"
    } else {
        "pending"
    };
    let manifest = CleanupManifest {
        schema: "hostlet.build-cleanup/v1",
        job_id: &job.id,
        attempt_id: &identity.attempt_id,
        fence: identity.fence,
        status,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|_| BuildFailure::Processing)?;
    store_bytes(cas_root, &bytes).map_err(|_| BuildFailure::Processing)
}

fn complete_early_failure(
    client: &ControlClient,
    options: &ProjectBuildOptions,
    identity: &ClaimIdentity,
    job: &LeasedJob,
    code: &'static str,
) -> Result<(), BuildFailure> {
    let completion = prepare_completion(
        &options.cas_root,
        job,
        identity,
        "failed",
        code,
        0,
        CleanupEvidence {
            qemu_exited: true,
            killed_for_timeout: false,
            killed_for_fence: false,
            sockets_removed: true,
            workspace_removed: true,
            console_truncated: false,
        },
        Vec::new(),
        &[],
    )?;
    client.complete(identity, &options.worker_id, completion)
}

fn spawn_renewal(
    client: ControlClient,
    identity: ClaimIdentity,
    worker_id: String,
    fenced: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            thread::sleep(RENEW_DELAY);
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if client.renew(&identity, &worker_id).is_err() {
                fenced.store(true, Ordering::SeqCst);
                break;
            }
        }
    })
}

fn validate_lease(
    lease: &LeaseResponse,
    profile: &BuildProfile,
    profile_digest: &str,
    worker_id: &str,
) -> Result<(), BuildFailure> {
    let job = &lease.job;
    if job.kind != JOB_KIND
        || lease.attempt.worker_id != worker_id
        || lease.attempt.attempt_number == 0
        || lease.attempt.fence == 0
        || lease.attempt.lease_expires_at.is_empty()
        || lease.attempt.lease_expires_at.len() > 64
        || !valid_uuid(&job.id)
        || !valid_uuid(&lease.attempt.id)
        || !valid_uuid(&job.account_id)
        || !valid_uuid(&job.project_id)
        || !valid_uuid(&job.deployment_id)
        || !valid_uuid(&job.configuration_revision_id)
        || !valid_uuid(&job.source_revision_id)
        || !valid_uuid(&job.compatibility_report_id)
        || !valid_git_sha(&job.source_commit)
        || !valid_git_sha(&job.source_tree_sha)
        || job.build_profile.id != profile.id
        || job.build_profile.digest != profile_digest
        || !valid_digest(&job.input_manifest_digest)
        || lease.services.is_empty()
        || lease.services.len() > 2
        || job.secret_version_refs.len() > 32
        || !valid_limits(&job.limits)
    {
        return Err(BuildFailure::Policy);
    }
    let mut kinds = HashSet::new();
    let mut service_ids = HashSet::new();
    for service in &lease.services {
        if !valid_uuid(&service.service_id)
            || !service_ids.insert(service.service_id.as_str())
            || !kinds.insert(service.kind.as_str())
            || !matches!(service.kind.as_str(), "static_frontend" | "application")
            || !matches!(service.node_major, 22 | 24)
            || !safe_relative(&service.root)
            || !safe_relative(&service.lockfile_path)
            || !safe_relative(&service.output_directory)
            || service.build_command.is_empty()
            || service.build_command.len() > 1024
        {
            return Err(BuildFailure::Policy);
        }
    }
    let mut refs = HashSet::new();
    for reference in &job.secret_version_refs {
        if !service_ids.contains(reference.service_id.as_str())
            || !valid_uuid(&reference.secret_version_id)
            || !valid_env_name(&reference.name)
            || !refs.insert(reference.secret_version_id.as_str())
        {
            return Err(BuildFailure::Policy);
        }
    }
    Ok(())
}

fn validate_credentials(
    references: &[SecretReference],
    credentials: Vec<CredentialValue>,
) -> Result<Vec<GuestCredential>, ()> {
    if references.len() != credentials.len() {
        return Err(());
    }
    let expected: HashMap<&str, (&str, &str)> = references
        .iter()
        .map(|item| {
            (
                item.secret_version_id.as_str(),
                (item.service_id.as_str(), item.name.as_str()),
            )
        })
        .collect();
    let mut observed = HashSet::new();
    let mut output = Vec::with_capacity(credentials.len());
    for mut credential in credentials {
        let Some((service, name)) = expected.get(credential.secret_version_id.as_str()) else {
            credential.value.zeroize();
            return Err(());
        };
        if credential.service_id != *service
            || credential.name != *name
            || credential.value.is_empty()
            || credential.value.len() > 16 * 1024
            || !observed.insert(credential.secret_version_id.clone())
        {
            credential.value.zeroize();
            return Err(());
        }
        output.push(GuestCredential {
            service_id: std::mem::take(&mut credential.service_id),
            secret_version_id: std::mem::take(&mut credential.secret_version_id),
            name: std::mem::take(&mut credential.name),
            value: std::mem::take(&mut credential.value),
        });
    }
    Ok(output)
}

fn validate_artifacts(services: &[BuildService], artifacts: &[ReceivedArtifact]) -> Result<(), ()> {
    if services.len() != artifacts.len() {
        return Err(());
    }
    for service in services {
        let expected_kind = if service.kind == "static_frontend" {
            "static"
        } else {
            "application"
        };
        if !artifacts.iter().any(|artifact| {
            artifact.service_id == service.service_id && artifact.kind == expected_kind
        }) {
            return Err(());
        }
    }
    Ok(())
}

fn artifact_entrypoint(
    service: &BuildService,
    artifact: &ReceivedArtifact,
) -> Result<Option<Vec<String>>, BuildFailure> {
    if service.kind == "static_frontend" {
        if artifact.kind != "static" {
            return Err(BuildFailure::Processing);
        }
        return Ok(None);
    }
    if artifact.kind != "application" || service.start_command.as_deref() != Some("npm run start") {
        return Err(BuildFailure::Processing);
    }
    let package: serde_json::Value = serde_json::from_slice(
        artifact
            .package_json
            .as_deref()
            .ok_or(BuildFailure::Processing)?,
    )
    .map_err(|_| BuildFailure::Processing)?;
    if !package.is_object() {
        return Err(BuildFailure::Processing);
    }
    match service.framework.as_str() {
        "node_http"
            if artifact.paths.contains("dist/server.mjs")
                && package
                    .pointer("/scripts/start")
                    .and_then(serde_json::Value::as_str)
                    == Some("node dist/server.mjs") =>
        {
            Ok(Some(vec!["node".to_owned(), "dist/server.mjs".to_owned()]))
        }
        "nextjs16_standalone" if artifact.paths.contains("server.js") => {
            Ok(Some(vec!["node".to_owned(), "server.js".to_owned()]))
        }
        _ => Err(BuildFailure::Processing),
    }
}

fn valid_limits(limits: &BuildLimits) -> bool {
    limits.cpu_millis == 2000
        && limits.memory_bytes == 2 * 1024 * 1024 * 1024
        && (1..=600).contains(&limits.timeout_seconds)
        && (256 * 1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&limits.workspace_bytes)
        && limits.static_output_bytes <= 250 * 1024 * 1024
        && limits.runtime_output_bytes <= 1024 * 1024 * 1024
        && (1..=100_000).contains(&limits.max_entries)
        && (1024..=4 * 1024 * 1024).contains(&limits.console_bytes)
        && (1024..=1024 * 1024).contains(&limits.report_bytes)
}

fn safe_guest_code(code: &str) -> &'static str {
    match code {
        "source_bundle_invalid" => "source_policy_rejected",
        "dependency_not_available_offline" => "dependency_not_available_offline",
        "build_command_failed" => "build_failed",
        "workspace_limit" => "workspace_limit",
        "memory_limit" => "memory_limit",
        "static_output_too_large" => "static_output_too_large",
        "runtime_output_too_large" => "runtime_output_too_large",
        "output_invalid" => "output_invalid",
        _ => "platform_fault",
    }
}

#[derive(Clone)]
struct ControlClient {
    client: Client,
    base_url: String,
    token: Arc<Zeroizing<String>>,
    completion_capture: Option<PathBuf>,
}

impl ControlClient {
    fn new(
        base_url: &str,
        mut token: BuildToken,
        completion_capture: Option<PathBuf>,
    ) -> Result<Self, BuildFailure> {
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| BuildFailure::Configuration)?;
        Ok(Self {
            client,
            base_url: base_url.to_owned(),
            token: Arc::new(Zeroizing::new(std::mem::take(&mut token.0))),
            completion_capture,
        })
    }

    fn lease(
        &self,
        worker_id: &str,
        profile_id: &str,
        profile_digest: &str,
    ) -> Result<Option<LeaseResponse>, BuildFailure> {
        let response = self
            .post("/internal/v1/build-jobs/lease")
            .json(&LeaseRequest {
                worker_id,
                kinds: [JOB_KIND],
                profiles: [ProfileIdentity {
                    id: profile_id,
                    digest: profile_digest,
                }],
            })
            .send()
            .map_err(|_| BuildFailure::Request)?;
        match response.status() {
            StatusCode::NO_CONTENT => Ok(None),
            StatusCode::OK => read_json(response).map(Some),
            StatusCode::CONFLICT => Err(BuildFailure::Fenced),
            _ => Err(BuildFailure::Response),
        }
    }

    fn renew(
        &self,
        identity: &ClaimIdentity,
        worker_id: &str,
    ) -> Result<RenewResponse, BuildFailure> {
        let response = self
            .post(&format!(
                "/internal/v1/build-jobs/{}/renew",
                identity.job_id
            ))
            .json(&IdentityRequest {
                worker_id,
                attempt_id: &identity.attempt_id,
                fence: identity.fence,
            })
            .send()
            .map_err(|_| BuildFailure::Request)?;
        if response.status() != StatusCode::OK {
            return Err(BuildFailure::Fenced);
        }
        let renewed: RenewResponse = read_json(response)?;
        if renewed.job_id != identity.job_id
            || renewed.attempt_id != identity.attempt_id
            || renewed.fence != identity.fence
            || renewed.lease_expires_at.is_empty()
            || renewed.lease_expires_at.len() > 64
        {
            return Err(BuildFailure::Response);
        }
        Ok(renewed)
    }

    fn materialize(
        &self,
        identity: &ClaimIdentity,
        worker_id: &str,
    ) -> Result<MaterializationResponse, BuildFailure> {
        let response = self
            .post(&format!(
                "/internal/v1/build-jobs/{}/source:materialize",
                identity.job_id
            ))
            .json(&IdentityRequest {
                worker_id,
                attempt_id: &identity.attempt_id,
                fence: identity.fence,
            })
            .send()
            .map_err(|_| BuildFailure::Request)?;
        match response.status() {
            StatusCode::OK => read_json(response),
            StatusCode::CONFLICT => Err(BuildFailure::Fenced),
            StatusCode::UNPROCESSABLE_ENTITY => {
                let envelope: ControlErrorEnvelope = read_json(response)?;
                if envelope.error.code == "build_source_rejected" {
                    Err(BuildFailure::Policy)
                } else {
                    Err(BuildFailure::Response)
                }
            }
            _ => Err(BuildFailure::Response),
        }
    }

    fn credentials(
        &self,
        identity: &ClaimIdentity,
        worker_id: &str,
        ids: &[&str],
    ) -> Result<CredentialsResponse, BuildFailure> {
        let response = self
            .post(&format!(
                "/internal/v1/build-jobs/{}/credentials:resolve",
                identity.job_id
            ))
            .json(&CredentialsRequest {
                worker_id,
                attempt_id: &identity.attempt_id,
                fence: identity.fence,
                secret_version_ids: ids,
            })
            .send()
            .map_err(|_| BuildFailure::Request)?;
        match response.status() {
            StatusCode::OK => read_json(response),
            StatusCode::CONFLICT => Err(BuildFailure::Fenced),
            _ => Err(BuildFailure::Credential),
        }
    }

    fn complete(
        &self,
        identity: &ClaimIdentity,
        worker_id: &str,
        outcome: CompletionOutcome,
    ) -> Result<(), BuildFailure> {
        let path = format!("/internal/v1/build-jobs/{}/complete", identity.job_id);
        let request = CompleteRequest {
            worker_id,
            attempt_id: &identity.attempt_id,
            fence: identity.fence,
            outcome,
        };
        let request_bytes = serde_json::to_vec(&request).map_err(|_| BuildFailure::Processing)?;
        if request_bytes.len() as u64 > MAX_CONTROL_RESPONSE {
            return Err(BuildFailure::Processing);
        }
        let response = self
            .post(&path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(request_bytes.clone())
            .send()
            .map_err(|_| BuildFailure::Request)?;
        let status = response.status();
        let response_content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 128)
            .unwrap_or("")
            .to_owned();
        let response_bytes = read_response_bytes(response)?;
        if let Some(capture_path) = &self.completion_capture {
            write_completion_capture(
                capture_path,
                identity,
                &path,
                &request_bytes,
                status.as_u16(),
                &response_content_type,
                &response_bytes,
            )?;
        }
        match status {
            StatusCode::OK => Ok(()),
            StatusCode::CONFLICT => Err(BuildFailure::Fenced),
            _ => Err(BuildFailure::Response),
        }
    }

    fn cancel_ack(
        &self,
        identity: &ClaimIdentity,
        worker_id: &str,
        cleanup_receipt_digest: String,
        elapsed_seconds: u64,
    ) -> Result<(), BuildFailure> {
        let response = self
            .post(&format!(
                "/internal/v1/build-jobs/{}/cancel:ack",
                identity.job_id
            ))
            .json(&CancelAckRequest {
                worker_id,
                attempt_id: &identity.attempt_id,
                fence: identity.fence,
                cleanup_receipt_digest,
                elapsed_seconds,
            })
            .send()
            .map_err(|_| BuildFailure::Request)?;
        match response.status() {
            StatusCode::OK => Ok(()),
            StatusCode::CONFLICT => Err(BuildFailure::Fenced),
            _ => Err(BuildFailure::Response),
        }
    }

    fn post(&self, path: &str) -> reqwest::blocking::RequestBuilder {
        self.client
            .post(format!("{}{}", self.base_url, path))
            .bearer_auth(self.token.as_str())
    }
}

struct BuildToken(String);
impl BuildToken {
    fn from_environment() -> Result<Self, BuildFailure> {
        let value =
            std::env::var("HOSTLET_M3_BUILD_TOKEN").map_err(|_| BuildFailure::Configuration)?;
        if !(32..=256).contains(&value.len())
            || value
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(BuildFailure::Configuration);
        }
        Ok(Self(value))
    }
}
impl Drop for BuildToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone)]
struct ClaimIdentity {
    job_id: String,
    attempt_id: String,
    fence: u64,
}
impl ClaimIdentity {
    fn from_lease(lease: &LeaseResponse) -> Result<Self, BuildFailure> {
        if !valid_uuid(&lease.job.id) || !valid_uuid(&lease.attempt.id) || lease.attempt.fence == 0
        {
            return Err(BuildFailure::Response);
        }
        Ok(Self {
            job_id: lease.job.id.clone(),
            attempt_id: lease.attempt.id.clone(),
            fence: lease.attempt.fence,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseResponse {
    job: LeasedJob,
    services: Vec<BuildService>,
    attempt: AttemptLease,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeasedJob {
    id: String,
    account_id: String,
    project_id: String,
    deployment_id: String,
    configuration_revision_id: String,
    source_revision_id: String,
    compatibility_report_id: String,
    kind: String,
    source_commit: String,
    source_tree_sha: String,
    build_profile: OwnedProfileIdentity,
    input_manifest_digest: String,
    secret_version_refs: Vec<SecretReference>,
    limits: BuildLimits,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnedProfileIdentity {
    id: String,
    digest: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretReference {
    service_id: String,
    secret_version_id: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttemptLease {
    id: String,
    attempt_number: u32,
    fence: u64,
    worker_id: String,
    lease_expires_at: String,
}
#[derive(Serialize)]
struct LeaseRequest<'a> {
    worker_id: &'a str,
    kinds: [&'static str; 1],
    profiles: [ProfileIdentity<'a>; 1],
}
#[derive(Serialize)]
struct ProfileIdentity<'a> {
    id: &'a str,
    digest: &'a str,
}
#[derive(Serialize)]
struct IdentityRequest<'a> {
    worker_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
}
#[derive(Serialize)]
struct CredentialsRequest<'a> {
    worker_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    secret_version_ids: &'a [&'a str],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenewResponse {
    job_id: String,
    attempt_id: String,
    fence: u64,
    lease_expires_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MaterializationResponse {
    commit_sha: String,
    tree_sha: String,
    bundle_digest: String,
    tree_manifest_digest: String,
    entry_count: u32,
    total_bytes: u64,
}
#[derive(Deserialize)]
struct ControlErrorEnvelope {
    error: ControlErrorBody,
}
#[derive(Deserialize)]
struct ControlErrorBody {
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialsResponse {
    credentials: Vec<CredentialValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialValue {
    service_id: String,
    secret_version_id: String,
    name: String,
    value: String,
}
impl Drop for CredentialValue {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Serialize)]
struct CompleteRequest<'a> {
    worker_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    outcome: CompletionOutcome,
}
#[derive(Serialize)]
struct CancelAckRequest<'a> {
    worker_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    cleanup_receipt_digest: String,
    elapsed_seconds: u64,
}
#[derive(Serialize)]
struct CompletionOutcome {
    state: &'static str,
    code: &'static str,
    result_manifest_digest: String,
    cleanup_receipt_digest: String,
    elapsed_seconds: u64,
    artifacts: Vec<CompletedArtifact>,
}
#[derive(Serialize)]
struct CompletedArtifact {
    service_id: String,
    kind: String,
    archive_digest: String,
    manifest_digest: String,
    packed_bytes: u64,
    unpacked_bytes: u64,
    entry_count: u32,
    entrypoint_argv: Option<Vec<String>>,
}
#[derive(Serialize)]
struct ArtifactManifest<'a> {
    schema: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    input_manifest_digest: &'a str,
    source_commit: &'a str,
    service_id: &'a str,
    kind: &'a str,
    archive_digest: &'a str,
    packed_bytes: u64,
    unpacked_bytes: u64,
    entry_count: u32,
    entrypoint_argv: Option<&'a [String]>,
}
#[derive(Serialize)]
struct ResultManifest<'a> {
    schema: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    input_manifest_digest: &'a str,
    state: &'a str,
    code: &'a str,
    elapsed_seconds: u64,
    artifacts: &'a [CompletedArtifact],
}
#[derive(Serialize)]
struct CleanupManifest<'a> {
    schema: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    status: &'static str,
}
#[derive(Serialize)]
struct ClaimLog<'a> {
    event: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
}

#[derive(Serialize)]
struct CleanupLog<'a> {
    event: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    qemu_exited: bool,
    killed_for_timeout: bool,
    killed_for_fence: bool,
    sockets_removed: bool,
    workspace_removed: bool,
    console_truncated: bool,
    actual_elapsed_seconds: u64,
}

#[derive(Serialize)]
struct LaunchDiagnosticLog<'a> {
    event: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    digest: String,
    byte_count: usize,
    message_truncated: bool,
    message: String,
}

#[derive(Serialize)]
struct GuestConsoleLog<'a> {
    event: &'static str,
    job_id: &'a str,
    attempt_id: &'a str,
    fence: u64,
    digest: String,
    byte_count: usize,
    capture_truncated: bool,
    message_truncated: bool,
    message: String,
}

fn write_claim(output: &mut impl Write, identity: &ClaimIdentity) -> Result<(), BuildFailure> {
    serde_json::to_writer(
        &mut *output,
        &ClaimLog {
            event: "build_job_claimed",
            job_id: &identity.job_id,
            attempt_id: &identity.attempt_id,
            fence: identity.fence,
        },
    )
    .map_err(|_| BuildFailure::Processing)?;
    writeln!(output).map_err(|_| BuildFailure::Processing)?;
    output.flush().map_err(|_| BuildFailure::Processing)
}

fn write_cleanup_log(
    output: &mut impl Write,
    identity: &ClaimIdentity,
    cleanup: &CleanupEvidence,
    actual_elapsed_seconds: u64,
) -> Result<(), BuildFailure> {
    serde_json::to_writer(
        &mut *output,
        &CleanupLog {
            event: "build_vm_cleaned",
            job_id: &identity.job_id,
            attempt_id: &identity.attempt_id,
            fence: identity.fence,
            qemu_exited: cleanup.qemu_exited,
            killed_for_timeout: cleanup.killed_for_timeout,
            killed_for_fence: cleanup.killed_for_fence,
            sockets_removed: cleanup.sockets_removed,
            workspace_removed: cleanup.workspace_removed,
            console_truncated: cleanup.console_truncated,
            actual_elapsed_seconds,
        },
    )
    .map_err(|_| BuildFailure::Processing)?;
    writeln!(output).map_err(|_| BuildFailure::Processing)?;
    output.flush().map_err(|_| BuildFailure::Processing)
}

fn write_launch_diagnostic(
    output: &mut impl Write,
    identity: &ClaimIdentity,
    bytes: &[u8],
    request: &GuestRequest,
    attempt_dir: &Path,
    profile: &BuildProfile,
) -> Result<(), BuildFailure> {
    let digest = format!("sha256:{:x}", Sha256::digest(bytes));
    let mut message = String::from_utf8_lossy(bytes).into_owned();
    for credential in &request.credentials {
        if !credential.value.is_empty() {
            message = message.replace(&credential.value, "<redacted>");
        }
    }
    for (path, replacement) in [
        (attempt_dir, "<attempt>"),
        (profile.qemu_binary.as_path(), "<qemu>"),
        (profile.kernel.path.as_path(), "<kernel>"),
        (profile.initrd.path.as_path(), "<initrd>"),
        (profile.rootfs.path.as_path(), "<rootfs>"),
        (profile.dependency_cache.path.as_path(), "<cache>"),
    ] {
        message = message.replace(path.to_string_lossy().as_ref(), replacement);
    }
    let message_truncated = message.chars().count() > 1024;
    message = message
        .chars()
        .map(|character| {
            if character == '\n' || character == '\t' || !character.is_control() {
                character
            } else {
                ' '
            }
        })
        .take(1024)
        .collect();
    serde_json::to_writer(
        &mut *output,
        &LaunchDiagnosticLog {
            event: "build_vm_launch_diagnostic",
            job_id: &identity.job_id,
            attempt_id: &identity.attempt_id,
            fence: identity.fence,
            digest,
            byte_count: bytes.len(),
            message_truncated,
            message,
        },
    )
    .map_err(|_| BuildFailure::Processing)?;
    writeln!(output).map_err(|_| BuildFailure::Processing)?;
    output.flush().map_err(|_| BuildFailure::Processing)
}

fn write_guest_console_diagnostic(
    output: &mut impl Write,
    identity: &ClaimIdentity,
    bytes: &[u8],
    capture_truncated: bool,
    request: &GuestRequest,
) -> Result<(), BuildFailure> {
    let digest = format!("sha256:{:x}", Sha256::digest(bytes));
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    for credential in &request.credentials {
        if !credential.value.is_empty() {
            text = text.replace(&credential.value, "<redacted>");
        }
    }
    let sanitized: String = text
        .chars()
        .map(|character| {
            if character == '\n'
                || character == '\t'
                || character == ' '
                || character.is_ascii_graphic()
            {
                character
            } else {
                '?'
            }
        })
        .collect();
    let mut relevant: Vec<String> = sanitized
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            [
                "kernel panic",
                "attempted to kill init",
                "run /sbin/hostlet-build-guest",
                "hostlet-build-guest failure",
                "hostlet root",
                "initramfs",
                "virtio",
                "vfs:",
                "ext4-fs",
                "mount: mounting /dev/vd",
            ]
            .iter()
            .any(|pattern| lower.contains(pattern))
        })
        .rev()
        .take(16)
        .map(|line| line.chars().take(128).collect())
        .collect();
    relevant.reverse();
    let tail: String = sanitized
        .chars()
        .rev()
        .take(768)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let message = if relevant.is_empty() {
        tail
    } else {
        format!("{}\n--- console tail ---\n{tail}", relevant.join("\n"))
            .chars()
            .take(3072)
            .collect()
    };
    let message_truncated = message.len() < sanitized.len();
    serde_json::to_writer(
        &mut *output,
        &GuestConsoleLog {
            event: "build_vm_guest_console",
            job_id: &identity.job_id,
            attempt_id: &identity.attempt_id,
            fence: identity.fence,
            digest,
            byte_count: bytes.len(),
            capture_truncated,
            message_truncated,
            message,
        },
    )
    .map_err(|_| BuildFailure::Processing)?;
    writeln!(output).map_err(|_| BuildFailure::Processing)?;
    output.flush().map_err(|_| BuildFailure::Processing)
}

fn read_json<T: DeserializeOwned>(mut response: Response) -> Result<T, BuildFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CONTROL_RESPONSE)
    {
        return Err(BuildFailure::Response);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .by_ref()
        .take(MAX_CONTROL_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BuildFailure::Response)?;
    if bytes.len() as u64 > MAX_CONTROL_RESPONSE {
        return Err(BuildFailure::Response);
    }
    serde_json::from_slice(&bytes).map_err(|_| BuildFailure::Response)
}

fn read_response_bytes(mut response: Response) -> Result<Vec<u8>, BuildFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CONTROL_RESPONSE)
    {
        return Err(BuildFailure::Response);
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_CONTROL_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BuildFailure::Response)?;
    if bytes.len() as u64 > MAX_CONTROL_RESPONSE {
        return Err(BuildFailure::Response);
    }
    Ok(bytes)
}

#[derive(Serialize)]
struct CompletionCapture<'a> {
    schema: &'static str,
    authenticated: bool,
    request: CapturedHttpMessage<'a>,
    response: CapturedHttpResponse<'a>,
}

#[derive(Serialize)]
struct CapturedHttpMessage<'a> {
    method: &'static str,
    path: &'a str,
    content_type: &'a str,
    body: &'a str,
}

#[derive(Serialize)]
struct CapturedHttpResponse<'a> {
    status: u16,
    content_type: &'a str,
    body: &'a str,
}

fn write_completion_capture(
    path: &Path,
    _identity: &ClaimIdentity,
    request_path: &str,
    request_bytes: &[u8],
    response_status: u16,
    response_content_type: &str,
    response_bytes: &[u8],
) -> Result<(), BuildFailure> {
    // The capture is deliberately limited to the completion HTTP exchange.
    // Authentication is represented by a boolean, never by the bearer value,
    // and the request body is the already-scoped completion DTO (which has no
    // credential fields).
    let request_body = std::str::from_utf8(request_bytes).map_err(|_| BuildFailure::Processing)?;
    let response_body =
        std::str::from_utf8(response_bytes).map_err(|_| BuildFailure::Processing)?;
    let capture = CompletionCapture {
        schema: "hostlet.build-completion-capture/v1",
        authenticated: true,
        request: CapturedHttpMessage {
            method: "POST",
            path: request_path,
            content_type: "application/json",
            body: request_body,
        },
        response: CapturedHttpResponse {
            status: response_status,
            content_type: response_content_type,
            body: response_body,
        },
    };
    let bytes = serde_json::to_vec(&capture).map_err(|_| BuildFailure::Processing)?;
    if bytes.len() as u64 > MAX_CONTROL_RESPONSE * 2 {
        return Err(BuildFailure::Processing);
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| BuildFailure::Processing)?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| BuildFailure::Processing)
}

pub(crate) enum BuildFailure {
    Configuration,
    Request,
    Response,
    Fenced,
    Credential,
    Policy,
    Processing,
}
impl BuildFailure {
    pub(crate) fn safe_message(&self) -> &'static str {
        match self {
            Self::Configuration => "project build worker configuration is invalid",
            Self::Request => "project build control request failed",
            Self::Response => "project build control response was invalid",
            Self::Fenced => "project build lease is no longer valid",
            Self::Credential => "project build credential resolution failed",
            Self::Policy => "project build policy rejected the job",
            Self::Processing => "project build processing failed",
        }
    }
    pub(crate) fn exit_code(&self) -> i32 {
        if matches!(self, Self::Configuration) {
            2
        } else {
            1
        }
    }
    fn code(&self) -> &'static str {
        match self {
            Self::Fenced => "platform_fault",
            Self::Credential | Self::Policy => "source_policy_rejected",
            _ => "platform_fault",
        }
    }
}

fn validate_control_url(value: &str) -> Result<(), ()> {
    let url = Url::parse(value).map_err(|_| ())?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(());
    }
    if !url
        .host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback())
        || url.port().is_none()
    {
        return Err(());
    }
    Ok(())
}
fn valid_worker_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_graphic())
}
fn absolute_file(value: String) -> Result<PathBuf, ()> {
    let path = PathBuf::from(value);
    if path.is_absolute() && path.is_file() {
        Ok(path)
    } else {
        Err(())
    }
}
fn absolute_directory(value: String) -> Result<PathBuf, ()> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(());
    }
    fs::create_dir_all(&path).map_err(|_| ())?;
    path.canonicalize().map_err(|_| ())
}

fn absolute_new_file(value: String) -> Result<PathBuf, ()> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(());
    }
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Ok(_) | Err(_) => return Err(()),
    }
    let parent = path.parent().ok_or(())?;
    if !parent.is_dir() || parent.is_symlink() {
        return Err(());
    }
    Ok(path)
}
fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}
fn valid_git_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn safe_relative(value: &str) -> bool {
    value == "."
        || (!value.is_empty()
            && !value.starts_with('/')
            && !value.contains(['\\', '\0', ':'])
            && value
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."))
}
fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
}
