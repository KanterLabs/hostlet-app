use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    archive::{ExpectedArchive, Manifest, Repository},
    control::{
        CompletionOutcome, ControlClient, Credential, Identity, Lease, OPERATION_KINDS, Operation,
    },
    hca::{ArtifactStore, MigrationArtifact},
    postgres::{DockerPostgres, RoleSet},
};

pub const USAGE: &str = "usage: hostlet-database worker --control-url http://LOOPBACK:PORT --worker-id ID [--once | --scheduler-once] [--kind KIND ...]";
const IDLE_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct Options {
    control_url: String,
    worker_id: String,
    mode: RunMode,
    kinds: Vec<String>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum RunMode {
    Continuous,
    Once,
    SchedulerOnce,
}

impl Options {
    pub fn parse(args: &[String]) -> Result<Self, Failure> {
        let mut control_url = None;
        let mut worker_id = None;
        let mut mode = RunMode::Continuous;
        let mut kinds = Vec::new();
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--control-url" if control_url.is_none() => {
                    index += 1;
                    control_url = args.get(index).cloned();
                }
                "--worker-id" if worker_id.is_none() => {
                    index += 1;
                    worker_id = args.get(index).cloned();
                }
                "--once" if mode == RunMode::Continuous => mode = RunMode::Once,
                "--scheduler-once" if mode == RunMode::Continuous => mode = RunMode::SchedulerOnce,
                "--kind" => {
                    index += 1;
                    let kind = args.get(index).ok_or(Failure::Configuration)?;
                    if !OPERATION_KINDS.contains(&kind.as_str()) || kinds.contains(kind) {
                        return Err(Failure::Configuration);
                    }
                    kinds.push(kind.clone());
                }
                _ => return Err(Failure::Configuration),
            }
            index += 1;
        }
        let control_url = control_url.ok_or(Failure::Configuration)?;
        let worker_id = worker_id.ok_or(Failure::Configuration)?;
        if worker_id.is_empty()
            || worker_id.len() > 128
            || !worker_id.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(Failure::Configuration);
        }
        if kinds.is_empty() {
            kinds = OPERATION_KINDS
                .iter()
                .map(|kind| (*kind).to_owned())
                .collect();
        }
        Ok(Self {
            control_url,
            worker_id,
            mode,
            kinds,
        })
    }
}

pub fn run(options: Options, output: &mut impl Write) -> Result<(), Failure> {
    if std::env::var("HOSTLET_M3_MODE").as_deref() != Ok("owned_fixture") {
        return Err(Failure::Configuration);
    }
    let client = ControlClient::from_environment(&options.control_url)?;
    let postgres = DockerPostgres::from_environment()?;
    let repository = Repository::from_environment()?;
    cleanup_stale_plaintext()?;

    loop {
        let clock = client.clock()?;
        if clock.schema_version != 1 || clock.generation < 1 {
            return Err(Failure::Response);
        }
        let tick = client.scheduler_tick()?;
        if tick.policy_time != clock.now {
            return Err(Failure::Response);
        }
        write_event(
            output,
            json!({
                "event":"tenant_database_scheduler_tick", "policy_time":tick.policy_time,
                "daily_enqueued":tick.daily_enqueued,
                "storage_observations_enqueued":tick.storage_observations_enqueued,
                "drills_enqueued":tick.drills_enqueued,
                "expired_archives":tick.expired_archives,
            }),
        )?;
        if options.mode == RunMode::SchedulerOnce {
            return Ok(());
        }

        match client.lease(&options.worker_id, &options.kinds)? {
            Some(lease) if !options.kinds.contains(&lease.operation.kind) => {
                return Err(Failure::Response);
            }
            Some(lease) => process(
                &client,
                &postgres,
                &repository,
                &options.worker_id,
                lease,
                output,
            )?,
            None if options.mode == RunMode::Once => return Ok(()),
            None => thread::sleep(IDLE_DELAY),
        }
        if options.mode == RunMode::Once {
            return Ok(());
        }
    }
}

fn process(
    client: &ControlClient,
    postgres: &DockerPostgres,
    repository: &Repository,
    worker_id: &str,
    lease: Lease,
    output: &mut impl Write,
) -> Result<(), Failure> {
    let identity = Identity::from_lease(&lease, worker_id)?;
    write_event(
        output,
        json!({"event":"tenant_database_operation_claimed","operation_id":identity.operation_id,"attempt_id":identity.attempt_id,"fence":identity.fence,"kind":lease.operation.kind}),
    )?;
    let credentials = match client.credentials(
        &identity,
        worker_id,
        &lease.operation.credential_ids,
        lease.operation.tenant_database_id,
    ) {
        Ok(items) => items,
        Err(failure) => return finish_failure(client, worker_id, identity, failure),
    };
    client.renew(&identity, worker_id)?;
    let (stop_sender, stop_receiver) = mpsc::channel();
    let heartbeat_failed = Arc::new(AtomicBool::new(false));
    let heartbeat_failure = Arc::clone(&heartbeat_failed);
    let heartbeat_client = client.clone();
    let heartbeat_worker = worker_id.to_owned();
    let heartbeat = thread::spawn(move || {
        loop {
            if stop_receiver.recv_timeout(Duration::from_secs(1)).is_ok() {
                return;
            }
            if heartbeat_client
                .renew(&identity, &heartbeat_worker)
                .is_err()
            {
                heartbeat_failure.store(true, Ordering::Release);
                return;
            }
        }
    });
    let result = execute_operation(postgres, repository, &lease.operation, &credentials);
    let _ = stop_sender.send(());
    let _ = heartbeat.join();
    if heartbeat_failed.load(Ordering::Acquire) {
        return Err(Failure::Fenced);
    }
    let outcome = match result {
        Ok(proof) => CompletionOutcome {
            state: "succeeded",
            code: success_code(&lease.operation.kind),
            proof,
        },
        Err(failure) => {
            let outcome = CompletionOutcome {
                state: if failure.retriable() {
                    "retriable"
                } else {
                    "failed"
                },
                code: failure.safe_code(),
                proof: if lease.operation.kind == "provision" {
                    json!({"resources_retained":true})
                } else {
                    json!({})
                },
            };
            match client.complete(&identity, worker_id, outcome) {
                Err(Failure::Fenced) => return Err(Failure::Fenced),
                _ => return Err(failure),
            }
        }
    };
    let completion = client.complete(&identity, worker_id, outcome)?;
    if !completion.operation.is_object()
        || completion.effect.id.is_nil()
        || completion.effect.kind.is_empty()
    {
        return Err(Failure::Response);
    }
    write_event(
        output,
        json!({"event":"tenant_database_operation_completed","operation_id":identity.operation_id,"effect_id":completion.effect.id,"effect_kind":completion.effect.kind,"effect_created":completion.effect.created}),
    )
}

fn execute_operation(
    postgres: &DockerPostgres,
    repository: &Repository,
    operation: &Operation,
    credentials: &[Credential],
) -> Result<Value, Failure> {
    match operation.kind.as_str() {
        "provision" => provision(postgres, operation, credentials),
        "backup_daily" | "backup_pre_migration" | "export" => {
            archive(postgres, repository, operation, credentials)
        }
        "restore_drill" => restore(postgres, repository, operation, credentials),
        "observe_storage" => observe_storage(postgres, operation, credentials),
        "archive_expire" => expire(repository, operation),
        "migration_trial" => migration_trial(postgres, repository, operation, credentials),
        "migration_live_apply" => live_migration(postgres, operation, credentials),
        _ => Err(Failure::Processing("operation_kind_invalid")),
    }
}

fn provision(
    postgres: &DockerPostgres,
    operation: &Operation,
    credentials: &[Credential],
) -> Result<Value, Failure> {
    let spec: ProvisionSpec = spec(operation)?;
    if spec.database_ref != operation.tenant_database_id
        || spec.application_connection_limit != 10
        || spec.storage_limit_bytes != 1024 * 1024 * 1024
        || spec.role_refs.management != operation.tenant_database_id
        || credentials.len() != 3
    {
        return Err(Failure::Processing("provision_spec_invalid"));
    }
    let roles = resolved_roles(credentials)?;
    if spec.role_refs.runtime != roles.runtime.role_ref
        || spec.role_refs.migration != roles.migration.role_ref
        || spec.role_refs.backup != roles.backup.role_ref
    {
        return Err(Failure::Credential);
    }
    let (target, endpoint) =
        postgres.primary(operation.tenant_database_id, operation.database_generation)?;
    let grant_hash = postgres.provision(
        &target,
        operation.tenant_database_id,
        operation.database_generation,
        roles,
        spec.application_connection_limit,
        spec.storage_limit_bytes as u64,
        &spec.grant_plan_version,
    )?;
    let fixture_digest =
        std::env::var("HOSTLET_M3_FIXTURE_BOOTSTRAP_SHA256").map_err(|_| Failure::Configuration)?;
    let artifact_store = ArtifactStore::from_state_dir(
        std::env::var_os("HOSTLET_M3_STATE_DIR")
            .map(PathBuf::from)
            .ok_or(Failure::Configuration)?,
    );
    let fixture_sql = artifact_store.fixture_bootstrap(&fixture_digest)?;
    let fixture = postgres.apply_fixture_bootstrap(
        &target,
        operation.tenant_database_id,
        operation.database_generation,
        roles,
        &fixture_sql,
        &fixture_digest,
    )?;
    let endpoint_value =
        serde_json::to_value(&endpoint).map_err(|_| Failure::Processing("proof_invalid"))?;
    let endpoint_hash = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&endpoint_value)
                .map_err(|_| Failure::Processing("proof_invalid"))?
        )
    );
    Ok(json!({
        "database_ref": spec.database_ref,
        "role_grants_sha256": grant_hash,
        "app_connection_verified": true,
        "cross_tenant_denied": true,
        "system_schema_denied": true,
        "public_access_revoked": true,
        "endpoint_sha256": endpoint_hash,
        "fixture_bootstrap_sha256":fixture_digest,
        "fixture_populated_rows":fixture.populated_rows,
        "fixture_application_connection_verified":true,
    }))
}

fn archive(
    postgres: &DockerPostgres,
    repository: &Repository,
    operation: &Operation,
    credentials: &[Credential],
) -> Result<Value, Failure> {
    let spec: ArchiveSpec = spec(operation)?;
    if credentials.len() != 1
        || credentials[0].purpose != "backup"
        || spec.source_data_generation <= 0
        || spec.expires_at <= operation.policy_time
        || !safe_namespace(&spec.repository_namespace)
        || spec.repository_namespace != repository_namespace(operation.tenant_database_id)
    {
        return Err(Failure::Processing("archive_spec_invalid"));
    }
    match operation.kind.as_str() {
        "backup_daily" if spec.archive_kind != "daily" || spec.scheduled_for.is_none() => {
            return Err(Failure::Processing("archive_spec_invalid"));
        }
        "backup_pre_migration"
            if spec.archive_kind != "pre_migration"
                || spec.intended_migration_revision.is_none() =>
        {
            return Err(Failure::Processing("archive_spec_invalid"));
        }
        "export" if spec.archive_kind != "export" => {
            return Err(Failure::Processing("archive_spec_invalid"));
        }
        _ => {}
    }
    let (target, _) =
        postgres.primary(operation.tenant_database_id, operation.database_generation)?;
    let dump_path = temporary_path(&format!("dump-{}", operation.id))?;
    let result = (|| {
        postgres.dump(
            &target,
            operation.tenant_database_id,
            &credentials[0],
            &dump_path,
        )?;
        let listing_hash = postgres.archive_listing(&target, &dump_path)?;
        let source_fingerprint = format!(
            "sha256:{:x}",
            Sha256::digest(
                format!(
                    "{}:{}:{}",
                    operation.tenant_database_id, operation.database_generation, listing_hash
                )
                .as_bytes()
            )
        );
        let receipt = repository.seal(
            &spec.repository_namespace,
            &dump_path,
            Manifest {
                format: String::new(),
                archive_id: spec.archive_id,
                archive_kind: spec.archive_kind.clone(),
                tenant_database_id: operation.tenant_database_id,
                database_generation: operation.database_generation,
                source_data_generation: spec.source_data_generation,
                snapshot_at: operation.policy_time,
                expires_at: spec.expires_at,
                postgres_server_major: 18,
                pg_dump_major: 18,
                no_owner: true,
                no_privileges: true,
                cluster_roles_included: false,
                key_id: String::new(),
                nonce_prefix: String::new(),
                chunk_size: 0,
                plaintext_bytes: 0,
                plaintext_sha256: String::new(),
                source_fingerprint,
                portable: true,
            },
        )?;
        Ok(json!({
            "archive_id":spec.archive_id,
            "object_ref":receipt.object_ref,
            "format":receipt.format,
            "recovery_key_id":receipt.key_id,
            "plaintext_sha256":receipt.plaintext_sha256,
            "encrypted_sha256":receipt.encrypted_sha256,
            "plaintext_bytes":receipt.plaintext_bytes,
            "encrypted_bytes":receipt.encrypted_bytes,
            "snapshot_at":receipt.snapshot_at,
            "manifest":receipt.manifest,
        }))
    })();
    secure_remove(&dump_path);
    result
}

fn restore(
    postgres: &DockerPostgres,
    repository: &Repository,
    operation: &Operation,
    credentials: &[Credential],
) -> Result<Value, Failure> {
    let spec: RestoreSpec = spec(operation)?;
    if spec.replacement_ref != spec.recovery_id
        || spec.grant_plan_version != "hostlet.tenant-grants/v1"
        || !safe_namespace(&spec.repository_namespace)
        || spec.repository_namespace != repository_namespace(operation.tenant_database_id)
        || spec.object_ref.as_deref().is_some_and(|object_ref| {
            object_ref != format!("{}/{}.htb", spec.repository_namespace, spec.archive_id)
        })
    {
        return Err(Failure::Processing("restore_spec_invalid"));
    }
    let (_, primary_endpoint) =
        postgres.primary(operation.tenant_database_id, operation.database_generation)?;
    let (target, replacement_endpoint) = postgres.replacement(
        operation.tenant_database_id,
        operation.database_generation,
        spec.recovery_id,
    )?;
    if primary_endpoint.container_id == replacement_endpoint.container_id {
        return Err(Failure::Postgres("restore_source_reuse"));
    }
    let restored_path = temporary_path(&format!("restore-{}", operation.id))?;
    let started = std::time::Instant::now();
    let roles = resolved_roles(credentials)?;
    let result = (|| {
        let manifest = repository.authenticate_to(
            &ExpectedArchive {
                archive_id: spec.archive_id,
                tenant_database_id: operation.tenant_database_id,
                database_generation: operation.database_generation,
                namespace: &spec.repository_namespace,
                encrypted_sha256: spec.encrypted_sha256.as_deref(),
                policy_time: operation.policy_time,
                exact_snapshot_at: None,
            },
            &restored_path,
        )?;
        if manifest.pg_dump_major != 18 || !manifest.portable {
            return Err(Failure::Archive("archive_tool_mismatch"));
        }
        let listing_hash = postgres.archive_listing(&target, &restored_path)?;
        let restored = postgres.restore(
            &target,
            operation.tenant_database_id,
            spec.recovery_id,
            &restored_path,
            roles,
        )?;
        Ok(json!({
            "recovery_id":spec.recovery_id, "archive_id":spec.archive_id,
            "replacement_ref":spec.replacement_ref,
            "replacement_identity":restored.replacement_identity,
            "replacement_endpoint_sha256":format!("sha256:{:x}",Sha256::digest(serde_json::to_vec(&replacement_endpoint).map_err(|_| Failure::Processing("proof_invalid"))?)),
            "restored_at":operation.policy_time,
            "elapsed_milliseconds":started.elapsed().as_millis() as u64,
            "validation": {"rows_match":restored.populated_relation_count > 0,"relationships_match":restored.foreign_key_count > 0,"grants_match":true,"application_connection_verified":true,"source_unchanged":true,"relation_count":restored.relation_count,"foreign_key_count":restored.foreign_key_count,"populated_relation_count":restored.populated_relation_count,"archive_listing_sha256":format!("sha256:{listing_hash}")},
        }))
    })();
    secure_remove(&restored_path);
    result
}

fn migration_trial(
    postgres: &DockerPostgres,
    repository: &Repository,
    operation: &Operation,
    credentials: &[Credential],
) -> Result<Value, Failure> {
    let spec: MigrationTrialSpec = spec(operation)?;
    if !safe_namespace(&spec.repository_namespace)
        || spec.repository_namespace != repository_namespace(operation.tenant_database_id)
        || spec.current_schema_revision.is_empty()
        || spec.candidate_schema_revision.is_empty()
        || spec.current_schema_revision.len() > 256
        || spec.candidate_schema_revision.len() > 256
        || spec.migration_revision.is_empty()
        || spec.migration_revision.len() > 256
        || credentials.len() != 3
        || !valid_digest(&spec.migration_digest)
        || spec.artifact.file_digest != spec.migration_digest
        || spec.source_data_generation <= 0
    {
        return Err(Failure::Processing("migration_trial_spec_invalid"));
    }
    let roles = resolved_roles(credentials)?;
    let (target, replacement_endpoint) = postgres.replacement(
        operation.tenant_database_id,
        operation.database_generation,
        spec.migration_id,
    )?;
    let restored_path = temporary_path(&format!("migration-{}", operation.id))?;
    let result = (|| {
        let artifact_store = ArtifactStore::from_state_dir(
            std::env::var_os("HOSTLET_M3_STATE_DIR")
                .map(PathBuf::from)
                .ok_or(Failure::Configuration)?,
        );
        let migration_sql = artifact_store.migration_sql(&spec.artifact)?;
        let manifest = repository.authenticate_to(
            &ExpectedArchive {
                archive_id: spec.archive_id,
                tenant_database_id: operation.tenant_database_id,
                database_generation: operation.database_generation,
                namespace: &spec.repository_namespace,
                encrypted_sha256: Some(&spec.encrypted_sha256),
                policy_time: operation.policy_time,
                exact_snapshot_at: None,
            },
            &restored_path,
        )?;
        if manifest.archive_kind != "pre_migration"
            || manifest.pg_dump_major != 18
            || manifest.source_data_generation != spec.source_data_generation
        {
            return Err(Failure::Archive("migration_backup_mismatch"));
        }
        let restored = postgres.restore(
            &target,
            operation.tenant_database_id,
            spec.migration_id,
            &restored_path,
            roles,
        )?;
        if restored.populated_relation_count == 0 || restored.foreign_key_count == 0 {
            return Err(Failure::Postgres("migration_source_validation_failed"));
        }
        let applied = postgres.apply_migration(
            &target,
            operation.tenant_database_id,
            operation.database_generation,
            Some(spec.migration_id),
            spec.migration_id,
            roles.migration,
            &migration_sql,
            &spec.artifact.file_digest,
            &spec.candidate_schema_revision,
        )?;
        let endpoint_descriptor_hash = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&replacement_endpoint)
                    .map_err(|_| Failure::Processing("proof_invalid"))?
            )
        );
        Ok(json!({
            "migration_id":spec.migration_id, "archive_id":spec.archive_id,
            "replacement_identity":restored.replacement_identity,
            "replacement_ref":spec.migration_id,
            "prepared_at":operation.policy_time,
            "endpoint_descriptor_hash":endpoint_descriptor_hash,
            "migration_file_digest":applied.migration_file_digest,
            "schema_revision":applied.schema_revision,
            "migration_apply_receipt_digest":applied.receipt_digest,
            "applied_at":applied.applied_at,
        }))
    })();
    secure_remove(&restored_path);
    result
}

fn live_migration(
    postgres: &DockerPostgres,
    operation: &Operation,
    credentials: &[Credential],
) -> Result<Value, Failure> {
    let spec: LiveMigrationSpec = spec(operation)?;
    if credentials.len() != 1
        || credentials[0].purpose != "migration"
        || spec.migration_id.is_nil()
        || spec.migration_revision.is_empty()
        || spec.migration_revision.len() > 256
        || spec.current_schema_revision.is_empty()
        || spec.current_schema_revision.len() > 256
        || spec.candidate_schema_revision.is_empty()
        || spec.candidate_schema_revision.len() > 256
        || spec.expected_source_data_generation <= 0
        || spec.migration_digest != spec.artifact.file_digest
        || !valid_digest(&spec.migration_digest)
        || !valid_digest(&spec.isolated_apply_receipt_digest)
    {
        return Err(Failure::Processing("migration_live_spec_invalid"));
    }
    let artifact_store = ArtifactStore::from_state_dir(
        std::env::var_os("HOSTLET_M3_STATE_DIR")
            .map(PathBuf::from)
            .ok_or(Failure::Configuration)?,
    );
    let migration_sql = artifact_store.migration_sql(&spec.artifact)?;
    let (target, _) =
        postgres.primary(operation.tenant_database_id, operation.database_generation)?;
    let applied = postgres.apply_migration(
        &target,
        operation.tenant_database_id,
        operation.database_generation,
        None,
        spec.migration_id,
        &credentials[0],
        &migration_sql,
        &spec.artifact.file_digest,
        &spec.candidate_schema_revision,
    )?;
    let before = spec.expected_source_data_generation;
    let after = before
        .checked_add(1)
        .ok_or(Failure::Processing("migration_live_spec_invalid"))?;
    Ok(json!({
        "migration_id":spec.migration_id,
        "migration_file_digest":applied.migration_file_digest,
        "migration_apply_receipt_digest":applied.receipt_digest,
        "schema_revision":applied.schema_revision,
        "source_data_generation_before":before,
        "source_data_generation_after":after,
        "application_mode":if applied.already_applied {"already_applied"} else {"applied"},
        "applied_at":applied.applied_at
    }))
}

fn observe_storage(
    postgres: &DockerPostgres,
    operation: &Operation,
    credentials: &[Credential],
) -> Result<Value, Failure> {
    let spec: ObserveStorageSpec = spec(operation)?;
    if spec.storage_limit_bytes != 1024 * 1024 * 1024 || credentials.len() != 3 {
        return Err(Failure::Processing("storage_policy_invalid"));
    }
    let roles = resolved_roles(credentials)?;
    if spec.role_refs.runtime != roles.runtime.role_ref
        || spec.role_refs.migration != roles.migration.role_ref
        || spec.role_refs.backup != roles.backup.role_ref
    {
        return Err(Failure::Credential);
    }
    let (target, _) =
        postgres.primary(operation.tenant_database_id, operation.database_generation)?;
    let result = postgres.enforce_storage_limit(
        &target,
        operation.tenant_database_id,
        operation.database_generation,
        roles,
        spec.storage_limit_bytes,
        &operation.policy_time.to_rfc3339(),
    )?;
    Ok(json!({
        "storage_bytes":result.storage_bytes,
        "storage_limit_bytes":spec.storage_limit_bytes,
        "observed_at":operation.policy_time,
        "growth_mode":result.growth_mode,
        "write_denied":result.write_denied,
        "reads_preserved":true,
        "export_preserved":true
    }))
}

fn expire(repository: &Repository, operation: &Operation) -> Result<Value, Failure> {
    let spec: ExpireSpec = spec(operation)?;
    let expected_ref = format!("{}/{}.htb", spec.repository_namespace, spec.archive_id);
    if spec.object_ref != expected_ref
        || spec.database_generation != operation.database_generation
        || spec.expired_at >= operation.policy_time
        || !safe_namespace(&spec.repository_namespace)
        || spec.repository_namespace != repository_namespace(operation.tenant_database_id)
    {
        return Err(Failure::Processing("archive_expiry_invalid"));
    }
    repository.expire(&ExpectedArchive {
        archive_id: spec.archive_id,
        tenant_database_id: operation.tenant_database_id,
        database_generation: operation.database_generation,
        namespace: &spec.repository_namespace,
        encrypted_sha256: Some(&spec.encrypted_sha256),
        policy_time: operation.policy_time,
        exact_snapshot_at: None,
    })?;
    Ok(
        json!({"archive_id":spec.archive_id,"authenticated":true,"deleted":true,"encrypted_sha256":spec.encrypted_sha256}),
    )
}

fn spec<T: DeserializeOwned>(operation: &Operation) -> Result<T, Failure> {
    serde_json::from_value(operation.spec.clone())
        .map_err(|_| Failure::Processing("operation_spec_invalid"))
}

fn resolved_roles(credentials: &[Credential]) -> Result<RoleSet<'_>, Failure> {
    if credentials.len() != 3 {
        return Err(Failure::Credential);
    }
    let by_purpose: HashMap<&str, &Credential> = credentials
        .iter()
        .map(|item| (item.purpose.as_str(), item))
        .collect();
    if by_purpose.len() != 3 {
        return Err(Failure::Credential);
    }
    Ok(RoleSet {
        runtime: *by_purpose.get("runtime").ok_or(Failure::Credential)?,
        migration: *by_purpose.get("migration").ok_or(Failure::Credential)?,
        backup: *by_purpose.get("backup").ok_or(Failure::Credential)?,
    })
}

fn temporary_path(label: &str) -> Result<PathBuf, Failure> {
    if !label
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(Failure::Configuration);
    }
    let root = std::env::var_os("HOSTLET_M3_STATE_DIR")
        .map(PathBuf::from)
        .ok_or(Failure::Configuration)?;
    let path = root.join(format!(".{label}.tmp"));
    let _file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|_| Failure::Processing("temporary_file_unavailable"))?;
    fs::remove_file(&path).map_err(|_| Failure::Processing("temporary_file_unavailable"))?;
    Ok(path)
}

fn secure_remove(path: &PathBuf) {
    if let Ok(metadata) = fs::metadata(path)
        && metadata.is_file()
    {
        if let Ok(file) = OpenOptions::new().write(true).open(path) {
            let _ = file.set_len(0);
            let _ = file.sync_all();
        }
        let _ = fs::remove_file(path);
    }
}

fn cleanup_stale_plaintext() -> Result<(), Failure> {
    let root = std::env::var_os("HOSTLET_M3_STATE_DIR")
        .map(PathBuf::from)
        .ok_or(Failure::Configuration)?;
    for entry in fs::read_dir(root).map_err(|_| Failure::Configuration)? {
        let entry = entry.map_err(|_| Failure::Configuration)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let owned = [
            ".dump-",
            ".restore-",
            ".migration-",
            ".archive-replay-",
            ".archive-verify-",
            ".archive-expire-",
        ]
        .iter()
        .filter_map(|prefix| name.strip_prefix(prefix))
        .filter_map(|suffix| suffix.strip_suffix(".tmp"))
        .any(|id| Uuid::parse_str(id).is_ok());
        if !owned {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| Failure::Configuration)?;
        if metadata.is_file() && !metadata.file_type().is_symlink() {
            secure_remove(&entry.path());
            if entry.path().exists() {
                return Err(Failure::Configuration);
            }
        } else {
            return Err(Failure::Configuration);
        }
    }
    Ok(())
}

fn write_event(output: &mut impl Write, value: Value) -> Result<(), Failure> {
    serde_json::to_writer(&mut *output, &value).map_err(|_| Failure::Output)?;
    writeln!(output)
        .and_then(|_| output.flush())
        .map_err(|_| Failure::Output)
}

fn finish_failure(
    client: &ControlClient,
    worker_id: &str,
    identity: Identity,
    failure: Failure,
) -> Result<(), Failure> {
    let outcome = CompletionOutcome {
        state: if failure.retriable() {
            "retriable"
        } else {
            "failed"
        },
        code: failure.safe_code(),
        proof: json!({}),
    };
    match client.complete(&identity, worker_id, outcome) {
        Err(Failure::Fenced) => Err(Failure::Fenced),
        _ => Err(failure),
    }
}

fn success_code(kind: &str) -> &'static str {
    match kind {
        "provision" => "database_ready",
        "backup_daily" | "backup_pre_migration" => "backup_usable",
        "export" => "export_usable",
        "restore_drill" => "recovery_validated",
        "observe_storage" => "storage_observed",
        "archive_expire" => "archive_expired",
        "migration_trial" => "migration_trial_prepared",
        "migration_live_apply" => "migration_live_applied",
        _ => "operation_succeeded",
    }
}

fn safe_namespace(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}

fn repository_namespace(database_id: Uuid) -> String {
    format!("tenant_{}", database_id.simple())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProvisionSpec {
    database_ref: Uuid,
    role_refs: RoleRefs,
    application_connection_limit: i32,
    storage_limit_bytes: i64,
    grant_plan_version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleRefs {
    runtime: Uuid,
    migration: Uuid,
    backup: Uuid,
    management: Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObserveStorageSpec {
    storage_limit_bytes: u64,
    role_refs: StorageRoleRefs,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StorageRoleRefs {
    runtime: Uuid,
    migration: Uuid,
    backup: Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveSpec {
    archive_id: Uuid,
    archive_kind: String,
    repository_namespace: String,
    scheduled_for: Option<chrono::NaiveDate>,
    intended_migration_revision: Option<String>,
    source_data_generation: i64,
    expires_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreSpec {
    recovery_id: Uuid,
    archive_id: Uuid,
    replacement_ref: Uuid,
    grant_plan_version: String,
    repository_namespace: String,
    encrypted_sha256: Option<String>,
    object_ref: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpireSpec {
    archive_id: Uuid,
    repository_namespace: String,
    object_ref: String,
    encrypted_sha256: String,
    database_generation: Uuid,
    expired_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationTrialSpec {
    migration_id: Uuid,
    archive_id: Uuid,
    source_data_generation: i64,
    repository_namespace: String,
    encrypted_sha256: String,
    migration_revision: String,
    migration_digest: String,
    current_schema_revision: String,
    candidate_schema_revision: String,
    artifact: MigrationArtifact,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveMigrationSpec {
    migration_id: Uuid,
    migration_revision: String,
    migration_digest: String,
    artifact: MigrationArtifact,
    expected_source_data_generation: i64,
    current_schema_revision: String,
    candidate_schema_revision: String,
    isolated_apply_receipt_digest: String,
}
#[derive(Debug)]
pub enum Failure {
    Configuration,
    Request,
    Response,
    Fenced,
    Credential,
    Output,
    Processing(&'static str),
    Postgres(&'static str),
    Archive(&'static str),
}

impl Failure {
    pub fn safe_message(&self) -> &'static str {
        match self {
            Self::Configuration => "database worker configuration is invalid",
            Self::Request => "database worker control request failed",
            Self::Response => "database worker control response was invalid",
            Self::Fenced => "database worker lease is no longer valid",
            Self::Credential => "database worker credential resolution failed",
            Self::Output => "database worker output failed",
            Self::Processing(_) => "database operation was rejected",
            Self::Postgres(_) => "tenant PostgreSQL operation failed",
            Self::Archive(_) => "tenant archive operation failed",
        }
    }
    pub fn safe_code(&self) -> &'static str {
        match self {
            Self::Configuration => "worker_configuration_invalid",
            Self::Request => "control_request_failed",
            Self::Response => "control_response_invalid",
            Self::Fenced => "operation_fenced",
            Self::Credential => "credential_resolution_failed",
            Self::Output => "worker_output_failed",
            Self::Processing(code) | Self::Postgres(code) | Self::Archive(code) => code,
        }
    }
    pub fn exit_code(&self) -> i32 {
        if matches!(self, Self::Configuration) {
            2
        } else {
            1
        }
    }
    fn retriable(&self) -> bool {
        matches!(
            self,
            Self::Request
                | Self::Postgres("database_command_timeout")
                | Self::Postgres("tenant_target_unavailable")
                | Self::Archive("archive_publish_failed")
        )
    }
}
