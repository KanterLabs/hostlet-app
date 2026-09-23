-- M3 owned-fixture execution and approved publication, additive over schema 5.
-- Published migrations 0001..0005 remain immutable. Retained M2 readers are supported.
CREATE TABLE m3_policy_clock (
    singleton boolean PRIMARY KEY CHECK (singleton),
    generation bigint NOT NULL CHECK (generation > 0),
    observed_at timestamptz NOT NULL
);

-- HOST-225 dedicated durable build queue. The parent wraps this in migration 0006.
-- Existing M1 jobs/job_attempts/job_effects remain unchanged.

CREATE TABLE source_materializations (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    source_revision_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    compatibility_report_id uuid NOT NULL,
    commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
    tree_sha text NOT NULL CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
    materializer_revision text NOT NULL CHECK (octet_length(materializer_revision) BETWEEN 1 AND 64),
    bundle_digest text CHECK (bundle_digest IS NULL OR bundle_digest ~ '^sha256:[0-9a-f]{64}$'),
    tree_manifest_digest text CHECK (tree_manifest_digest IS NULL OR tree_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
    entry_count integer CHECK (entry_count IS NULL OR entry_count BETWEEN 0 AND 10000),
    total_bytes bigint CHECK (total_bytes IS NULL OR total_bytes BETWEEN 0 AND 67108864),
    authorization_observed_at timestamptz,
    state text NOT NULL CHECK (state IN ('pending','ready','failed')),
    failure_code text CHECK (failure_code IS NULL OR octet_length(failure_code) BETWEEN 1 AND 64),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (deployment_id, source_revision_id, configuration_revision_id, commit_sha, tree_sha, materializer_revision),
    UNIQUE (id, account_id, project_id, deployment_id),
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, source_revision_id)
        REFERENCES github_source_revisions(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, configuration_revision_id, source_revision_id, compatibility_report_id)
        REFERENCES compatibility_reports(account_id, project_id, configuration_revision_id, source_revision_id, id)
        ON DELETE RESTRICT,
    CHECK ((state = 'ready') = (bundle_digest IS NOT NULL AND tree_manifest_digest IS NOT NULL
        AND entry_count IS NOT NULL AND total_bytes IS NOT NULL AND authorization_observed_at IS NOT NULL)),
    CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

CREATE TABLE build_jobs (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    reservation_epoch uuid NOT NULL,
    source_proof_id uuid NOT NULL,
    source_revision_id uuid NOT NULL,
    compatibility_report_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
    source_tree_sha text NOT NULL CHECK (source_tree_sha ~ '^[0-9a-f]{40}$'),
    build_profile_id text NOT NULL CHECK (build_profile_id IN (
        'm3-owned-node24-v1','m3-owned-node22-v1','m3-owned-node24-cache-miss-v1'
    )),
    build_profile_digest text NOT NULL CHECK (build_profile_digest ~ '^sha256:[0-9a-f]{64}$'),
    source_materialization_id uuid,
    source_bundle_digest text CHECK (source_bundle_digest IS NULL OR source_bundle_digest ~ '^sha256:[0-9a-f]{64}$'),
    source_tree_manifest_digest text CHECK (source_tree_manifest_digest IS NULL OR source_tree_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
    input_manifest jsonb NOT NULL CHECK (jsonb_typeof(input_manifest) = 'object' AND octet_length(input_manifest::text) <= 131072),
    input_manifest_digest text NOT NULL CHECK (input_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','canceled','retriable')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
    current_attempt_id uuid,
    current_fence bigint NOT NULL DEFAULT 0 CHECK (current_fence >= 0),
    lease_expires_at timestamptz,
    terminal_code text CHECK (terminal_code IS NULL OR octet_length(terminal_code) BETWEEN 1 AND 64),
    cleanup_status text NOT NULL DEFAULT 'not_started' CHECK (cleanup_status IN ('not_started','confirmed','pending')),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (deployment_id, input_manifest_digest),
    UNIQUE (account_id, project_id, id),
    UNIQUE (account_id, project_id, deployment_id, id),
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, reservation_id, reservation_epoch)
        REFERENCES slot_reservations(account_id, project_id, id, reservation_epoch) ON DELETE RESTRICT,
    FOREIGN KEY (source_proof_id, account_id, project_id, deployment_id)
        REFERENCES admission_source_proofs(id, account_id, project_id, deployment_id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, source_revision_id)
        REFERENCES github_source_revisions(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, configuration_revision_id, source_revision_id, compatibility_report_id)
        REFERENCES compatibility_reports(account_id, project_id, configuration_revision_id, source_revision_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (source_materialization_id,account_id,project_id,deployment_id)
        REFERENCES source_materializations(id,account_id,project_id,deployment_id) ON DELETE RESTRICT,
    CHECK ((state = 'running') = (current_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK (state <> 'succeeded' OR (source_materialization_id IS NOT NULL
        AND source_bundle_digest IS NOT NULL AND source_tree_manifest_digest IS NOT NULL))
);
CREATE INDEX build_jobs_claimable_idx ON build_jobs(created_at,id) WHERE state IN ('queued','retriable');
CREATE INDEX build_jobs_expired_idx ON build_jobs(lease_expires_at,id) WHERE state='running';
CREATE INDEX build_jobs_project_idx ON build_jobs(account_id,project_id,deployment_id,created_at DESC);
CREATE UNIQUE INDEX build_jobs_one_active_account_idx ON build_jobs(account_id)
    WHERE state='running' OR cleanup_status='pending';

CREATE TABLE build_job_services (
    job_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    service_id uuid NOT NULL,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 1),
    kind text NOT NULL CHECK (kind IN ('static_frontend','application')),
    root text,
    node_major smallint NOT NULL CHECK (node_major IN (22,24)),
    framework text NOT NULL CHECK (framework IN ('vite_static','static_export','node_http','nextjs16_standalone')),
    lockfile_path text NOT NULL,
    build_command text NOT NULL,
    output_directory text NOT NULL,
    start_command text,
    health_path text,
    PRIMARY KEY (job_id,service_id),
    UNIQUE (job_id,ordinal),
    UNIQUE (job_id,kind),
    FOREIGN KEY (account_id,project_id,job_id) REFERENCES build_jobs(account_id,project_id,id) ON DELETE CASCADE,
    FOREIGN KEY (account_id,project_id,configuration_revision_id,service_id,kind)
        REFERENCES service_configurations(account_id,project_id,configuration_revision_id,service_id,kind) ON DELETE RESTRICT,
    CHECK (root IS NULL OR (octet_length(root) BETWEEN 1 AND 1024 AND root !~ '(^/|\\.\\.)')),
    CHECK (octet_length(lockfile_path) BETWEEN 1 AND 1024),
    CHECK (octet_length(build_command) BETWEEN 1 AND 4096),
    CHECK (octet_length(output_directory) BETWEEN 1 AND 1024),
    CHECK ((kind='application') = (start_command IS NOT NULL AND health_path IS NOT NULL))
);

CREATE TABLE build_job_secret_refs (
    job_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_id uuid NOT NULL,
    secret_id uuid NOT NULL,
    secret_version_id uuid NOT NULL,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 128),
    credential_kind text NOT NULL CHECK (credential_kind='build_environment'),
    PRIMARY KEY (job_id,secret_version_id),
    UNIQUE (job_id,service_id,name),
    FOREIGN KEY (account_id,project_id,job_id) REFERENCES build_jobs(account_id,project_id,id) ON DELETE CASCADE,
    FOREIGN KEY (account_id,project_id,service_id,secret_id)
        REFERENCES secrets(account_id,project_id,service_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id,project_id,service_id,secret_id,secret_version_id)
        REFERENCES secret_versions(account_id,project_id,service_id,secret_id,id) ON DELETE RESTRICT
);

CREATE TABLE build_attempts (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
    fence bigint NOT NULL CHECK (fence > 0),
    worker_id text NOT NULL CHECK (octet_length(worker_id) BETWEEN 1 AND 128),
    state text NOT NULL CHECK (state IN ('running','succeeded','failed','retriable','expired','canceled')),
    lease_started_at timestamptz NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    vm_instance_id text CHECK (vm_instance_id IS NULL OR octet_length(vm_instance_id) BETWEEN 1 AND 128),
    launched_at timestamptz,
    finished_at timestamptz,
    terminal_code text CHECK (terminal_code IS NULL OR octet_length(terminal_code) BETWEEN 1 AND 64),
    completion_hash bytea CHECK (completion_hash IS NULL OR octet_length(completion_hash)=32),
    UNIQUE (account_id,project_id,job_id,id), UNIQUE(job_id,id,fence),
    UNIQUE (account_id,project_id,job_id,id,fence),
    UNIQUE (job_id,attempt_number), UNIQUE (job_id,fence),
    FOREIGN KEY (account_id,project_id,job_id) REFERENCES build_jobs(account_id,project_id,id) ON DELETE CASCADE,
    CHECK (lease_expires_at > lease_started_at),
    CHECK ((state='running') = (finished_at IS NULL AND terminal_code IS NULL))
);
ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_current_attempt_fk
    FOREIGN KEY (account_id,project_id,id,current_attempt_id,current_fence)
    REFERENCES build_attempts(account_id,project_id,job_id,id,fence) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE build_artifacts (
    id uuid PRIMARY KEY, account_id uuid NOT NULL, project_id uuid NOT NULL,
    job_id uuid NOT NULL, attempt_id uuid NOT NULL, fence bigint NOT NULL, service_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('static','application')),
    archive_digest text NOT NULL CHECK (archive_digest ~ '^sha256:[0-9a-f]{64}$'),
    manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
    packed_bytes bigint NOT NULL CHECK (packed_bytes BETWEEN 0 AND 1073741824),
    unpacked_bytes bigint NOT NULL CHECK (unpacked_bytes BETWEEN 0 AND 1073741824),
    entry_count integer NOT NULL CHECK (entry_count BETWEEN 0 AND 10000),
    entrypoint_argv jsonb,
    cas_state text NOT NULL CHECK (cas_state='registered'), created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (job_id,kind),
    FOREIGN KEY (account_id,project_id,job_id,attempt_id,fence)
        REFERENCES build_attempts(account_id,project_id,job_id,id,fence) ON DELETE RESTRICT,
    FOREIGN KEY (job_id,service_id) REFERENCES build_job_services(job_id,service_id) ON DELETE RESTRICT,
    CHECK (
        (kind='static' AND entrypoint_argv IS NULL) OR
        (kind='application' AND jsonb_typeof(entrypoint_argv)='array'
            AND jsonb_array_length(entrypoint_argv)=2)
    )
);

CREATE TABLE build_effects (
    job_id uuid PRIMARY KEY REFERENCES build_jobs(id) ON DELETE CASCADE,
    attempt_id uuid NOT NULL, fence bigint NOT NULL, state text NOT NULL CHECK (state IN ('succeeded','failed','retriable')),
    code text NOT NULL CHECK (octet_length(code) BETWEEN 1 AND 64),
    completion_hash bytea NOT NULL CHECK (octet_length(completion_hash)=32),
    response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body)='object' AND octet_length(response_body::text)<=131072),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE(job_id,attempt_id,fence), FOREIGN KEY(job_id,attempt_id,fence) REFERENCES build_attempts(job_id,id,fence) ON DELETE RESTRICT
);

CREATE TABLE build_attempt_receipts (
    attempt_id uuid PRIMARY KEY REFERENCES build_attempts(id) ON DELETE CASCADE,
    job_id uuid NOT NULL, fence bigint NOT NULL,
    completion_hash bytea NOT NULL CHECK (octet_length(completion_hash)=32),
    response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body)='object' AND octet_length(response_body::text)<=131072),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE(job_id,attempt_id,fence),
    FOREIGN KEY(job_id,attempt_id,fence) REFERENCES build_attempts(job_id,id,fence) ON DELETE CASCADE
);

CREATE TABLE build_usage_reservations (
    job_id uuid PRIMARY KEY REFERENCES build_jobs(id) ON DELETE RESTRICT,
    account_id uuid NOT NULL, project_id uuid NOT NULL, deployment_id uuid NOT NULL,
    entitlement_id uuid NOT NULL, reserved_seconds integer NOT NULL CHECK (reserved_seconds=600),
    finalized_seconds integer CHECK (finalized_seconds BETWEEN 0 AND 600),
    state text NOT NULL CHECK (state IN ('reserved','finalized','released')),
    debit_event_id uuid UNIQUE REFERENCES build_usage_events(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), finalized_at timestamptz,
    FOREIGN KEY(entitlement_id,account_id) REFERENCES admission_entitlements(id,account_id) ON DELETE RESTRICT,
    FOREIGN KEY(account_id,project_id,deployment_id) REFERENCES deployments(account_id,project_id,id) ON DELETE RESTRICT,
    CHECK (
        (state='reserved' AND finalized_seconds IS NULL AND debit_event_id IS NULL AND finalized_at IS NULL) OR
        (state='finalized' AND finalized_seconds IS NOT NULL AND finalized_at IS NOT NULL
            AND (debit_event_id IS NOT NULL OR finalized_seconds=0)) OR
        (state='released' AND finalized_seconds=0 AND debit_event_id IS NULL AND finalized_at IS NOT NULL)
    )
);

CREATE TABLE build_request_receipts (
    account_id uuid NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL,
    request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32), response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), PRIMARY KEY(account_id,operation,idempotency_key)
);


-- HOST-223 additive schema-5 -> schema-6 draft. Parent owns migration wrapper,
-- platform_schema_compatibility update, REQUIRED_RELATIONS, and integration.

CREATE TABLE tenant_databases (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    first_deployment_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    reservation_epoch uuid NOT NULL,
    generation uuid NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN (
        'provision_requested', 'provisioning', 'ready', 'recovery_attention',
        'failed_resources_retained', 'removed'
    )),
    postgres_major smallint NOT NULL DEFAULT 18 CHECK (postgres_major = 18),
    application_connection_limit integer NOT NULL CHECK (application_connection_limit > 0),
    storage_limit_bytes bigint NOT NULL CHECK (storage_limit_bytes > 0),
    database_ref text NOT NULL CHECK (octet_length(database_ref) BETWEEN 1 AND 128),
    placement_ref text NOT NULL CHECK (octet_length(placement_ref) BETWEEN 1 AND 256),
    runtime_network_policy_ref text NOT NULL CHECK (octet_length(runtime_network_policy_ref) BETWEEN 1 AND 256),
    management_network_policy_ref text NOT NULL CHECK (octet_length(management_network_policy_ref) BETWEEN 1 AND 256),
    grant_plan_version text NOT NULL CHECK (octet_length(grant_plan_version) BETWEEN 1 AND 64),
    provisioning_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provisioning_metadata) = 'object'),
    source_data_generation bigint NOT NULL DEFAULT 1 CHECK (source_data_generation > 0),
    growth_mode text NOT NULL DEFAULT 'writable' CHECK (growth_mode IN ('writable', 'read_only_over_limit')),
    measured_storage_bytes bigint CHECK (measured_storage_bytes IS NULL OR measured_storage_bytes >= 0),
    storage_observed_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    last_error_code text CHECK (last_error_code IS NULL OR octet_length(last_error_code) BETWEEN 1 AND 96),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    ready_at timestamptz,
    removed_at timestamptz,
    UNIQUE (account_id, project_id, id),
    UNIQUE (account_id, project_id, service_id, id),
    UNIQUE (account_id, project_id, id, generation),
    FOREIGN KEY (account_id, project_id, service_id)
        REFERENCES services(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, first_deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, reservation_id, reservation_epoch)
        REFERENCES slot_reservations(account_id, project_id, id, reservation_epoch) ON DELETE RESTRICT,
    CHECK ((state = 'ready') = (ready_at IS NOT NULL) OR state IN ('recovery_attention', 'failed_resources_retained', 'removed')),
    CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
    CHECK ((measured_storage_bytes IS NULL) = (storage_observed_at IS NULL)),
    CHECK (growth_mode = 'writable' OR storage_observed_at IS NOT NULL)
);
CREATE UNIQUE INDEX tenant_databases_one_live_service_idx
    ON tenant_databases(service_id) WHERE state <> 'removed';

CREATE TABLE tenant_database_credentials (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    tenant_database_id uuid NOT NULL,
    database_generation uuid NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('runtime', 'migration', 'backup')),
    role_ref text NOT NULL CHECK (octet_length(role_ref) BETWEEN 1 AND 128),
    version_number bigint NOT NULL DEFAULT 1 CHECK (version_number > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
    key_version text NOT NULL CHECK (octet_length(key_version) BETWEEN 1 AND 64),
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 24),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 16384),
    auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (tenant_database_id, purpose, version_number),
    UNIQUE (account_id, project_id, tenant_database_id, database_generation, id),
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation)
        REFERENCES tenant_databases(account_id, project_id, id, generation) ON DELETE CASCADE
);
CREATE UNIQUE INDEX tenant_database_credentials_one_active_purpose_idx
    ON tenant_database_credentials(tenant_database_id, purpose) WHERE status = 'active';

CREATE TABLE tenant_database_archives (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    tenant_database_id uuid NOT NULL,
    database_generation uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('daily', 'pre_migration', 'export')),
    state text NOT NULL DEFAULT 'creating' CHECK (state IN ('creating', 'usable', 'corrupt', 'expired', 'deleted')),
    scheduled_for date,
    intended_migration_revision text CHECK (intended_migration_revision IS NULL OR octet_length(intended_migration_revision) BETWEEN 1 AND 256),
    source_data_generation bigint NOT NULL CHECK (source_data_generation > 0),
    object_ref text CHECK (object_ref IS NULL OR octet_length(object_ref) BETWEEN 1 AND 512),
    format text CHECK (format IS NULL OR octet_length(format) BETWEEN 1 AND 96),
    recovery_key_id text CHECK (recovery_key_id IS NULL OR octet_length(recovery_key_id) BETWEEN 1 AND 128),
    plaintext_sha256 text CHECK (plaintext_sha256 IS NULL OR plaintext_sha256 ~ '^[0-9a-f]{64}$'),
    encrypted_sha256 text CHECK (encrypted_sha256 IS NULL OR encrypted_sha256 ~ '^[0-9a-f]{64}$'),
    plaintext_bytes bigint CHECK (plaintext_bytes IS NULL OR plaintext_bytes > 0),
    encrypted_bytes bigint CHECK (encrypted_bytes IS NULL OR encrypted_bytes > 0),
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manifest) = 'object'),
    snapshot_at timestamptz,
    verified_at timestamptz,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, tenant_database_id, database_generation, id),
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation)
        REFERENCES tenant_databases(account_id, project_id, id, generation) ON DELETE RESTRICT,
    CHECK (
      (kind = 'daily' AND scheduled_for IS NOT NULL AND intended_migration_revision IS NULL) OR
      (kind = 'pre_migration' AND scheduled_for IS NULL AND intended_migration_revision IS NOT NULL) OR
      (kind = 'export' AND scheduled_for IS NULL AND intended_migration_revision IS NULL)
    ),
    CHECK (state <> 'usable' OR (
      object_ref IS NOT NULL AND format IS NOT NULL AND recovery_key_id IS NOT NULL AND
      plaintext_sha256 IS NOT NULL AND encrypted_sha256 IS NOT NULL AND
      plaintext_bytes IS NOT NULL AND encrypted_bytes IS NOT NULL AND
      snapshot_at IS NOT NULL AND verified_at IS NOT NULL
    )),
    CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX tenant_database_archives_one_daily_idx
    ON tenant_database_archives(tenant_database_id, database_generation, scheduled_for)
    WHERE kind = 'daily';
CREATE UNIQUE INDEX tenant_database_archives_one_pre_migration_idx
    ON tenant_database_archives(tenant_database_id, database_generation, intended_migration_revision, source_data_generation)
    WHERE kind = 'pre_migration';

CREATE TABLE tenant_database_recoveries (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    tenant_database_id uuid NOT NULL,
    database_generation uuid NOT NULL,
    archive_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'restoring', 'validated', 'failed', 'cleaned')),
    policy_week date NOT NULL,
    replacement_ref text CHECK (replacement_ref IS NULL OR octet_length(replacement_ref) BETWEEN 1 AND 256),
    replacement_identity uuid,
    validation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(validation) = 'object'),
    restore_started_at timestamptz,
    restored_at timestamptz,
    validated_at timestamptz,
    cleaned_at timestamptz,
    elapsed_milliseconds bigint CHECK (elapsed_milliseconds IS NULL OR elapsed_milliseconds >= 0),
    last_error_code text CHECK (last_error_code IS NULL OR octet_length(last_error_code) BETWEEN 1 AND 96),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, tenant_database_id, database_generation, id),
    UNIQUE (tenant_database_id, database_generation, policy_week),
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation)
        REFERENCES tenant_databases(account_id, project_id, id, generation) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation, archive_id)
        REFERENCES tenant_database_archives(account_id, project_id, tenant_database_id, database_generation, id) ON DELETE RESTRICT,
    CHECK (state NOT IN ('validated', 'cleaned') OR (validated_at IS NOT NULL AND replacement_identity IS NOT NULL))
);

CREATE TABLE tenant_database_operations (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    tenant_database_id uuid NOT NULL,
    database_generation uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN (
      'provision', 'backup_daily', 'backup_pre_migration', 'export',
      'restore_drill', 'observe_storage', 'migration_trial', 'migration_live_apply', 'archive_expire'
    )),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'retriable', 'succeeded', 'failed', 'canceled')),
    operation_key text NOT NULL CHECK (octet_length(operation_key) BETWEEN 1 AND 256),
    spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    credential_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(credential_ids) <= 8),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 5),
    current_attempt_id uuid,
    current_fence bigint NOT NULL DEFAULT 0 CHECK (current_fence >= 0),
    lease_expires_at timestamptz,
    policy_time timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (tenant_database_id, database_generation, kind, operation_key),
    UNIQUE (account_id, project_id, tenant_database_id, database_generation, id),
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation)
        REFERENCES tenant_databases(account_id, project_id, id, generation) ON DELETE RESTRICT,
    CHECK ((state = 'running') = (current_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX tenant_database_operations_claimable_idx
    ON tenant_database_operations(created_at, id) WHERE state IN ('queued', 'retriable');
CREATE INDEX tenant_database_operations_expired_idx
    ON tenant_database_operations(lease_expires_at, id) WHERE state = 'running';

CREATE TABLE tenant_database_operation_attempts (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    tenant_database_id uuid NOT NULL,
    database_generation uuid NOT NULL,
    operation_id uuid NOT NULL,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    fence bigint NOT NULL CHECK (fence > 0),
    worker_id text NOT NULL CHECK (octet_length(worker_id) BETWEEN 1 AND 128),
    state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'retriable', 'expired', 'canceled')),
    lease_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    lease_expires_at timestamptz NOT NULL,
    finished_at timestamptz,
    terminal_code text CHECK (terminal_code IS NULL OR octet_length(terminal_code) BETWEEN 1 AND 96),
    completion_hash bytea CHECK (completion_hash IS NULL OR octet_length(completion_hash) = 32),
    UNIQUE (operation_id, attempt_number),
    UNIQUE (operation_id, fence),
    UNIQUE (account_id, project_id, tenant_database_id, database_generation, operation_id, id, fence),
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation, operation_id)
        REFERENCES tenant_database_operations(account_id, project_id, tenant_database_id, database_generation, id) ON DELETE CASCADE,
    CHECK (lease_expires_at > lease_started_at),
    CHECK ((state = 'running') = (finished_at IS NULL AND terminal_code IS NULL))
);
ALTER TABLE tenant_database_operations ADD CONSTRAINT tenant_database_operations_current_attempt_fk
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation, id, current_attempt_id, current_fence)
    REFERENCES tenant_database_operation_attempts(account_id, project_id, tenant_database_id, database_generation, operation_id, id, fence)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE tenant_database_migrations (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    tenant_database_id uuid NOT NULL,
    database_generation uuid NOT NULL,
    deployment_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    migration_revision text NOT NULL CHECK (octet_length(migration_revision) BETWEEN 1 AND 256),
    migration_digest text NOT NULL CHECK (migration_digest ~ '^sha256:[0-9a-f]{64}$'),
    source_data_generation bigint NOT NULL CHECK (source_data_generation > 0),
    pre_migration_archive_id uuid NOT NULL,
    validation_operation_id uuid,
    state text NOT NULL CHECK (state IN ('planned', 'trial_prepared', 'isolated_validated', 'applied', 'failed')),
    current_schema_revision text NOT NULL CHECK (octet_length(current_schema_revision) BETWEEN 1 AND 256),
    candidate_schema_revision text NOT NULL CHECK (octet_length(candidate_schema_revision) BETWEEN 1 AND 256),
    current_binary_digest text NOT NULL CHECK (current_binary_digest ~ '^sha256:[0-9a-f]{64}$'),
    migration_artifact jsonb NOT NULL CHECK (jsonb_typeof(migration_artifact) = 'object'),
    retained_binary_evidence jsonb NOT NULL CHECK (jsonb_typeof(retained_binary_evidence) = 'array'),
    compatibility_evidence jsonb NOT NULL CHECK (jsonb_typeof(compatibility_evidence) = 'object'),
    once_effect_id uuid UNIQUE,
    validated_at timestamptz,
    applied_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (tenant_database_id, database_generation, migration_revision),
    UNIQUE (account_id, project_id, tenant_database_id, database_generation, id),
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation)
        REFERENCES tenant_databases(account_id, project_id, id, generation) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation, pre_migration_archive_id)
        REFERENCES tenant_database_archives(account_id, project_id, tenant_database_id, database_generation, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, tenant_database_id, database_generation, validation_operation_id)
        REFERENCES tenant_database_operations(account_id, project_id, tenant_database_id, database_generation, id) ON DELETE RESTRICT,
    CHECK ((state IN ('isolated_validated', 'applied')) = (validated_at IS NOT NULL)),
    CHECK ((state = 'applied') = (applied_at IS NOT NULL AND once_effect_id IS NOT NULL))
);


-- HOST-222 additive schema fragment. Parent owns migration integration.
CREATE TABLE runtime_evaluation_intents (
 id uuid PRIMARY KEY,
 evaluation_subject_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 fence bigint NOT NULL CHECK(fence>0),
 build_job_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE RESTRICT,
 artifact_id uuid NOT NULL REFERENCES build_artifacts(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL, project_id uuid NOT NULL, configuration_revision_id uuid NOT NULL,
 reservation_id uuid NOT NULL, reservation_epoch uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose='owned_fixture_evaluation'),
 state text NOT NULL CHECK(state IN ('requested','credential_issued','consumed')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(evaluation_subject_id,generation,fence),
 FOREIGN KEY(account_id,project_id,configuration_revision_id)
  REFERENCES configuration_revisions(account_id,project_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(account_id,project_id,reservation_id,reservation_epoch)
  REFERENCES slot_reservations(account_id,project_id,id,reservation_epoch) ON DELETE RESTRICT
);

CREATE TABLE runtime_evaluations (
 id uuid PRIMARY KEY,
 evaluation_intent_id uuid NOT NULL UNIQUE REFERENCES runtime_evaluation_intents(id) ON DELETE RESTRICT,
 evaluation_subject_id uuid NOT NULL,
 evaluation_generation bigint NOT NULL CHECK(evaluation_generation>0),
 evaluation_fence bigint NOT NULL CHECK(evaluation_fence>0),
 evidence_digest text NOT NULL UNIQUE CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
 capability_digest text NOT NULL UNIQUE CHECK (capability_digest ~ '^sha256:[0-9a-f]{64}$'),
 result text NOT NULL CHECK (result IN ('passed','failed')),
 reason_code text NOT NULL CHECK (octet_length(reason_code) BETWEEN 1 AND 96),
 runtime_binary_digest text NOT NULL CHECK (runtime_binary_digest ~ '^sha256:[0-9a-f]{64}$'),
 policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
 platform text NOT NULL CHECK (platform IN ('systrap','kvm')),
 profile text NOT NULL CHECK (profile='evidence_gated_owned_fixture'),
 observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=524288),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(evaluation_subject_id,evaluation_generation,evaluation_fence), CHECK(expires_at>observed_at)
);
CREATE INDEX runtime_evaluations_active_idx ON runtime_evaluations(expires_at,id) WHERE result='passed';

CREATE TABLE runtime_allocations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL, project_id uuid NOT NULL,
 deployment_id uuid NOT NULL, service_id uuid NOT NULL,
 build_job_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE RESTRICT,
 artifact_id uuid NOT NULL REFERENCES build_artifacts(id) ON DELETE RESTRICT,
 evaluation_id uuid NOT NULL REFERENCES runtime_evaluations(id) ON DELETE RESTRICT,
 reservation_id uuid NOT NULL, reservation_epoch uuid NOT NULL,
 configuration_revision_id uuid NOT NULL,
 source_commit text NOT NULL CHECK(source_commit ~ '^[0-9a-f]{40}$'),
 generation bigint NOT NULL CHECK(generation>0), fence bigint NOT NULL CHECK(fence>0),
 state text NOT NULL CHECK(state IN ('allocated','running','healthy','backoff','stopped','cleaned')),
 reason_code text CHECK(reason_code IS NULL OR octet_length(reason_code) BETWEEN 1 AND 96),
 artifact_digest text NOT NULL CHECK(artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
 artifact_manifest_digest text NOT NULL CHECK(artifact_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
 build_profile_digest text NOT NULL CHECK(build_profile_digest ~ '^sha256:[0-9a-f]{64}$'),
 runtime_binary_digest text NOT NULL CHECK(runtime_binary_digest ~ '^sha256:[0-9a-f]{64}$'),
 policy_digest text NOT NULL CHECK(policy_digest ~ '^sha256:[0-9a-f]{64}$'),
 capability_digest text NOT NULL CHECK(capability_digest ~ '^sha256:[0-9a-f]{64}$'),
 platform text NOT NULL CHECK(platform IN ('systrap','kvm')),
 profile text NOT NULL CHECK(profile IN ('node22-http-v1','node24-http-v1','nextjs16-node22-v1','nextjs16-node24-v1')),
 argv jsonb NOT NULL CHECK(jsonb_typeof(argv)='array' AND jsonb_array_length(argv) BETWEEN 1 AND 8 AND octet_length(argv::text)<=4096),
 application_port integer NOT NULL CHECK(application_port=3000),
 health_port integer NOT NULL CHECK(health_port=3000),
 health_path text NOT NULL CHECK(octet_length(health_path) BETWEEN 1 AND 256 AND health_path LIKE '/%'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(service_id,generation), UNIQUE(service_id,fence), UNIQUE(artifact_id,evaluation_id),
 UNIQUE(id,account_id,project_id,deployment_id,service_id,generation,fence),
 FOREIGN KEY(account_id,project_id,deployment_id) REFERENCES deployments(account_id,project_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(account_id,project_id,service_id) REFERENCES services(account_id,project_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(account_id,project_id,reservation_id,reservation_epoch) REFERENCES slot_reservations(account_id,project_id,id,reservation_epoch) ON DELETE RESTRICT,
 FOREIGN KEY(account_id,project_id,configuration_revision_id) REFERENCES configuration_revisions(account_id,project_id,id) ON DELETE RESTRICT
);
CREATE INDEX runtime_allocations_project_idx ON runtime_allocations(account_id,project_id,created_at DESC);
CREATE INDEX runtime_allocations_reconcile_idx ON runtime_allocations(updated_at,id) WHERE state<>'cleaned';

CREATE TABLE runtime_restore_probe_intents (
 id uuid PRIMARY KEY,
 evaluation_intent_id uuid NOT NULL UNIQUE REFERENCES runtime_evaluation_intents(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL, project_id uuid NOT NULL,
 recovery_id uuid NOT NULL, tenant_database_id uuid NOT NULL, database_generation uuid NOT NULL,
 source_allocation_id uuid NOT NULL REFERENCES runtime_allocations(id) ON DELETE RESTRICT,
 source_allocation_generation bigint NOT NULL CHECK(source_allocation_generation>0),
 source_allocation_fence bigint NOT NULL CHECK(source_allocation_fence>0),
 state text NOT NULL CHECK(state IN ('requested','credential_issued','consumed')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 FOREIGN KEY(account_id,project_id,tenant_database_id,database_generation,recovery_id)
  REFERENCES tenant_database_recoveries(account_id,project_id,tenant_database_id,database_generation,id) ON DELETE RESTRICT
);
CREATE INDEX runtime_restore_probe_intents_recovery_idx
 ON runtime_restore_probe_intents(recovery_id,created_at DESC);

CREATE TABLE runtime_observations (
 id uuid PRIMARY KEY, allocation_id uuid NOT NULL REFERENCES runtime_allocations(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL, project_id uuid NOT NULL, deployment_id uuid NOT NULL, service_id uuid NOT NULL,
 generation bigint NOT NULL, fence bigint NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 state text NOT NULL CHECK(state IN ('running','healthy','backoff','stopped','cleaned')),
 reason_code text NOT NULL CHECK(reason_code IN (
  'runtime_prepared','runtime_started','runtime_stopped','runtime_cleaned','runtime_exit','runtime_oom',
  'cpu_throttled','process_limit_exceeded','scratch_limit_exceeded','network_connection_limit',
  'health_failed','crash_loop_backoff','runtime_isolation_unverified','runtime_internal_failure')),
 receipt_digest text NOT NULL UNIQUE CHECK(receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
 safe_receipt jsonb NOT NULL CHECK(jsonb_typeof(safe_receipt)='object' AND octet_length(safe_receipt::text)<=524288),
 observed_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(allocation_id,sequence),
 FOREIGN KEY(allocation_id,account_id,project_id,deployment_id,service_id,generation,fence)
  REFERENCES runtime_allocations(id,account_id,project_id,deployment_id,service_id,generation,fence) ON DELETE RESTRICT
);
CREATE INDEX runtime_observations_owner_idx ON runtime_observations(account_id,project_id,observed_at DESC,id DESC);


-- M3 coordinated release references shared by runtime and portfolio approvals.
-- The current public pointer is changed only by the checked release reconciler.
CREATE TABLE application_releases (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    build_job_id uuid NOT NULL,
    source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
    frontend_digest text CHECK (frontend_digest ~ '^sha256:[0-9a-f]{64}$'),
    backend_digest text CHECK (backend_digest ~ '^sha256:[0-9a-f]{64}$'),
    tenant_database_id uuid,
    database_generation uuid,
    migration_revision text CHECK (octet_length(migration_revision) BETWEEN 1 AND 256),
    migration_digest text CHECK (migration_digest ~ '^sha256:[0-9a-f]{64}$'),
    migration_artifact_path text CHECK (migration_artifact_path IS NULL OR (
        octet_length(migration_artifact_path) BETWEEN 1 AND 1024 AND
        migration_artifact_path LIKE 'dist/migrations/%' AND
        migration_artifact_path !~ '(^/|\\.\\.)'
    )),
    migration_id uuid,
    runtime_allocation_id uuid,
    runtime_service_id uuid,
    runtime_generation bigint CHECK (runtime_generation > 0),
    runtime_fence bigint CHECK (runtime_fence > 0),
    staged_health_observation_id uuid,
    staged_health_receipt_digest text CHECK (staged_health_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('staged','healthy','failed','retired')),
    secret_version_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secret_version_refs)='array'),
    health_results jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(health_results)='object'),
    expected_route_generation bigint NOT NULL CHECK (expected_route_generation >= 0),
    managed_demo_url text CHECK (octet_length(managed_demo_url) BETWEEN 1 AND 2048),
    promoted_at timestamptz,
    failure_code text CHECK (octet_length(failure_code) BETWEEN 1 AND 96),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (account_id,project_id,id),
    UNIQUE (deployment_id,build_job_id),
    FOREIGN KEY (account_id,project_id,configuration_revision_id,deployment_id)
        REFERENCES deployments(account_id,project_id,configuration_revision_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id,project_id,deployment_id,build_job_id)
        REFERENCES build_jobs(account_id,project_id,deployment_id,id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id,project_id,tenant_database_id,database_generation)
        REFERENCES tenant_databases(account_id,project_id,id,generation) ON DELETE RESTRICT,
    FOREIGN KEY (account_id,project_id,tenant_database_id,database_generation,migration_id)
        REFERENCES tenant_database_migrations(account_id,project_id,tenant_database_id,database_generation,id) ON DELETE RESTRICT,
    FOREIGN KEY (runtime_allocation_id,account_id,project_id,deployment_id,runtime_service_id,runtime_generation,runtime_fence)
        REFERENCES runtime_allocations(id,account_id,project_id,deployment_id,service_id,generation,fence) ON DELETE RESTRICT,
    FOREIGN KEY (staged_health_observation_id)
        REFERENCES runtime_observations(id) ON DELETE RESTRICT,
    CHECK (frontend_digest IS NOT NULL OR backend_digest IS NOT NULL),
    CHECK ((tenant_database_id IS NULL) = (database_generation IS NULL)),
    CHECK ((migration_revision IS NULL) = (migration_digest IS NULL)),
    CHECK ((migration_revision IS NULL) = (migration_artifact_path IS NULL)),
    CHECK ((backend_digest IS NULL) = (runtime_allocation_id IS NULL)),
    CHECK ((runtime_allocation_id IS NULL) = (runtime_service_id IS NULL)),
    CHECK ((runtime_allocation_id IS NULL) = (runtime_generation IS NULL)),
    CHECK ((runtime_allocation_id IS NULL) = (runtime_fence IS NULL)),
    CHECK ((runtime_allocation_id IS NULL) = (staged_health_observation_id IS NULL)),
    CHECK ((runtime_allocation_id IS NULL) = (staged_health_receipt_digest IS NULL)),
    CHECK (state NOT IN ('healthy','retired') OR promoted_at IS NOT NULL)
);
CREATE INDEX application_releases_history_idx ON application_releases(project_id,promoted_at DESC,id DESC);

CREATE TABLE project_release_routes (
    project_id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    release_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    availability text NOT NULL CHECK (availability IN ('available','degraded','demo_offline')),
    availability_observed_at timestamptz NOT NULL,
    demo_access_revision bigint NOT NULL DEFAULT 1 CHECK (demo_access_revision > 0),
    route_manifest_digest text NOT NULL CHECK (route_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
    route_manifest jsonb NOT NULL CHECK (jsonb_typeof(route_manifest)='object'),
    retained_asset_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(retained_asset_refs)='array'),
    drain_expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    FOREIGN KEY (account_id,project_id,release_id)
        REFERENCES application_releases(account_id,project_id,id) ON DELETE RESTRICT
);

-- Every promotion and rollback is an independently fenced reconciliation. A
-- staged release is never treated as healthy merely because an owner created it.
CREATE TABLE release_reconciliations (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    release_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('promote','rollback')),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN (
        'queued','running','awaiting_trial','awaiting_live_apply','prepared','retriable','succeeded','failed'
    )),
    expected_route_generation bigint NOT NULL CHECK (expected_route_generation >= 0),
    requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements)='object'),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 6),
    max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts=6),
    current_attempt_id uuid,
    current_fence bigint NOT NULL DEFAULT 0 CHECK (current_fence >= 0),
    lease_expires_at timestamptz,
    terminal_code text CHECK (terminal_code IS NULL OR octet_length(terminal_code) BETWEEN 1 AND 96),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id,project_id,id),
    UNIQUE (release_id,id),
    FOREIGN KEY (account_id,project_id,release_id)
        REFERENCES application_releases(account_id,project_id,id) ON DELETE RESTRICT,
    CHECK ((state IN ('running','prepared'))=(current_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX release_reconciliations_claimable_idx
    ON release_reconciliations(created_at,id) WHERE state IN ('queued','retriable');
CREATE UNIQUE INDEX release_reconciliations_one_active_project_idx
    ON release_reconciliations(project_id) WHERE state IN ('queued','running','awaiting_trial','awaiting_live_apply','prepared','retriable');

CREATE TABLE release_reconciliation_attempts (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    release_id uuid NOT NULL,
    reconciliation_id uuid NOT NULL,
    attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 6),
    fence bigint NOT NULL CHECK (fence > 0),
    worker_id text NOT NULL CHECK (octet_length(worker_id) BETWEEN 1 AND 128),
    state text NOT NULL CHECK (state IN (
        'running','succeeded','failed','retriable','expired'
    )),
    lease_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_expires_at timestamptz NOT NULL,
    finished_at timestamptz,
    terminal_code text CHECK (terminal_code IS NULL OR octet_length(terminal_code) BETWEEN 1 AND 96),
    completion_hash bytea CHECK (completion_hash IS NULL OR octet_length(completion_hash)=32),
    UNIQUE (reconciliation_id,attempt_number),
    UNIQUE (reconciliation_id,fence),
    UNIQUE (account_id,project_id,release_id,reconciliation_id,id,fence),
    FOREIGN KEY (account_id,project_id,reconciliation_id)
        REFERENCES release_reconciliations(account_id,project_id,id) ON DELETE CASCADE,
    FOREIGN KEY (account_id,project_id,release_id)
        REFERENCES application_releases(account_id,project_id,id) ON DELETE RESTRICT,
    CHECK (lease_expires_at > lease_started_at),
    CHECK ((state='running')=(finished_at IS NULL AND terminal_code IS NULL))
);
ALTER TABLE release_reconciliations ADD CONSTRAINT release_reconciliations_current_attempt_fk
    FOREIGN KEY (account_id,project_id,release_id,id,current_attempt_id,current_fence)
    REFERENCES release_reconciliation_attempts(
        account_id,project_id,release_id,reconciliation_id,id,fence
    ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE application_release_events (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    release_id uuid NOT NULL,
    event_key text NOT NULL CHECK (octet_length(event_key) BETWEEN 1 AND 128),
    kind text NOT NULL CHECK (kind IN ('staged','failed','promoted','rollback','retired','observation')),
    route_generation bigint CHECK (route_generation > 0),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
    occurred_at timestamptz NOT NULL,
    UNIQUE (release_id,event_key),
    FOREIGN KEY (account_id,project_id,release_id)
        REFERENCES application_releases(account_id,project_id,id) ON DELETE RESTRICT
);


-- HOST-227/HOST-229 design draft. Parent integration owns the numbered migration.
-- Additive over schema 5; existing tables and columns remain unchanged so the
-- retained schema-5 binary can continue to read and write after min_reader=5.

CREATE TABLE portfolio_approved_revisions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    approval_sequence bigint NOT NULL CHECK (approval_sequence > 0),
    source_draft_revision_id uuid NOT NULL,
    source_draft_revision_number bigint NOT NULL CHECK (source_draft_revision_number > 0),
    previous_approved_revision_id uuid,
    review_digest bytea NOT NULL CHECK (octet_length(review_digest) = 32),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    preview_context jsonb NOT NULL CHECK (jsonb_typeof(preview_context) = 'object'),
    approval_requirements jsonb NOT NULL CHECK (jsonb_typeof(approval_requirements) = 'array'),
    approvals jsonb NOT NULL CHECK (jsonb_typeof(approvals) = 'array'),
    refresh_authorizations jsonb NOT NULL CHECK (jsonb_typeof(refresh_authorizations) = 'array'),
    audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
    approved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, id),
    UNIQUE (account_id, approval_sequence),
    UNIQUE (account_id, source_draft_revision_id, review_digest),
    FOREIGN KEY (account_id, source_draft_revision_id)
        REFERENCES portfolio_draft_revisions(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, previous_approved_revision_id)
        REFERENCES portfolio_approved_revisions(account_id, id) ON DELETE RESTRICT
);

CREATE INDEX portfolio_approved_revisions_owner_sequence_idx
    ON portfolio_approved_revisions(account_id, approval_sequence DESC);

CREATE TABLE portfolio_deployment_fact_revisions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    approved_revision_id uuid NOT NULL,
    project_reference_id text NOT NULL CHECK (octet_length(project_reference_id) BETWEEN 1 AND 128),
    hosted_project_id uuid NOT NULL,
    revision_number bigint NOT NULL CHECK (revision_number > 0),
    previous_fact_revision_id uuid,
    revision_kind text NOT NULL CHECK (revision_kind IN ('owner_authorized','fact_refresh')),
    source_release_id uuid NOT NULL,
    source_deployment_id uuid NOT NULL,
    facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
    refresh_scope jsonb NOT NULL CHECK (jsonb_typeof(refresh_scope) = 'array'),
    facts_digest bytea NOT NULL CHECK (octet_length(facts_digest) = 32),
    audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, id),
    UNIQUE (account_id, approved_revision_id, project_reference_id, id),
    UNIQUE (account_id, approved_revision_id, project_reference_id, revision_number),
    UNIQUE (account_id, approved_revision_id, project_reference_id, source_release_id, facts_digest),
    FOREIGN KEY (account_id, approved_revision_id)
        REFERENCES portfolio_approved_revisions(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, hosted_project_id)
        REFERENCES projects(account_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, hosted_project_id, source_deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, hosted_project_id, source_release_id)
        REFERENCES application_releases(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (
        account_id, approved_revision_id, project_reference_id,
        previous_fact_revision_id
    ) REFERENCES portfolio_deployment_fact_revisions(
        account_id, approved_revision_id, project_reference_id, id
    ) ON DELETE RESTRICT
);

CREATE INDEX portfolio_fact_revisions_head_idx
    ON portfolio_deployment_fact_revisions(
        account_id, approved_revision_id, project_reference_id,
        revision_number DESC, id DESC
    );

CREATE TABLE portfolio_readiness_events (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    approved_revision_id uuid NOT NULL,
    project_reference_id text NOT NULL CHECK (octet_length(project_reference_id) BETWEEN 1 AND 128),
    event_sequence bigint NOT NULL CHECK (event_sequence > 0),
    fact_revision_id uuid NOT NULL,
    previous_event_id uuid,
    state text NOT NULL CHECK (state IN ('ready_to_share','needs_recheck')),
    reason text CHECK (reason IN ('never_checked','new_release','demo_access_changed','owner_requested')),
    attestation jsonb CHECK (attestation IS NULL OR jsonb_typeof(attestation) = 'object'),
    audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, id),
    UNIQUE (account_id, approved_revision_id, project_reference_id, id),
    UNIQUE (account_id, approved_revision_id, project_reference_id, event_sequence),
    FOREIGN KEY (account_id, approved_revision_id)
        REFERENCES portfolio_approved_revisions(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (
        account_id, approved_revision_id, project_reference_id,
        fact_revision_id
    ) REFERENCES portfolio_deployment_fact_revisions(
        account_id, approved_revision_id, project_reference_id, id
    ) ON DELETE RESTRICT,
    FOREIGN KEY (
        account_id, approved_revision_id, project_reference_id,
        previous_event_id
    ) REFERENCES portfolio_readiness_events(
        account_id, approved_revision_id, project_reference_id, id
    ) ON DELETE RESTRICT,
    CHECK (
        (state = 'ready_to_share' AND reason IS NULL AND attestation IS NOT NULL) OR
        (state = 'needs_recheck' AND reason IS NOT NULL)
    )
);

CREATE INDEX portfolio_readiness_events_head_idx
    ON portfolio_readiness_events(
        account_id, approved_revision_id, project_reference_id,
        event_sequence DESC
    );

-- HOST-229 appends immutable publication revisions, fenced attempts, artifacts
-- and the site pointer to the same still-unpublished schema-6 migration after
-- HOST-227 is accepted. There is one populated schema-5 to schema-6 upgrade.


-- HOST-229 schema fragment for migrations/0006_m3_execution.sql.
CREATE TABLE portfolio_public_sites (
    account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
    slug text NOT NULL UNIQUE,
    current_publication_id uuid,
    current_artifact_digest text,
    pointer_generation bigint NOT NULL DEFAULT 0 CHECK (pointer_generation >= 0),
    promotion_publication_id uuid,
    promotion_artifact_digest text,
    promotion_manifest jsonb,
    promotion_generation bigint,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
    CHECK ((current_publication_id IS NULL) = (current_artifact_digest IS NULL)),
    CHECK (current_artifact_digest IS NULL OR current_artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    CHECK ((promotion_publication_id IS NULL) = (promotion_artifact_digest IS NULL)),
    CHECK ((promotion_publication_id IS NULL) = (promotion_manifest IS NULL)),
    CHECK ((promotion_publication_id IS NULL) = (promotion_generation IS NULL)),
    CHECK (promotion_artifact_digest IS NULL OR promotion_artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    CHECK (promotion_generation IS NULL OR promotion_generation > pointer_generation)
);

CREATE TABLE portfolio_publications (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    publication_sequence bigint GENERATED ALWAYS AS IDENTITY,
    approved_revision_id uuid NOT NULL,
    slug text NOT NULL,
    document jsonb NOT NULL,
    document_digest text NOT NULL,
    cause text NOT NULL CHECK (cause IN ('owner_request','deployment_fact_refresh')),
    state text NOT NULL CHECK (state IN ('queued','publishing','promotion_pending','published','failed')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    current_attempt_id uuid,
    current_fence bigint NOT NULL DEFAULT 0 CHECK (current_fence >= 0),
    lease_expires_at timestamptz,
    artifact_digest text,
    manifest jsonb,
    pointer_generation bigint,
    failure_code text,
    audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    published_at timestamptz,
    UNIQUE (account_id, publication_sequence),
    UNIQUE (account_id, id),
    UNIQUE (account_id, approved_revision_id, document_digest),
    FOREIGN KEY (account_id, approved_revision_id)
        REFERENCES portfolio_approved_revisions(account_id, id) ON DELETE RESTRICT,
    CHECK (document_digest ~ '^sha256:[0-9a-f]{64}$'),
    CHECK (artifact_digest IS NULL OR artifact_digest ~ '^sha256:[0-9a-f]{64}$')
);
CREATE INDEX portfolio_publications_queue_idx
    ON portfolio_publications(state, publication_sequence);
CREATE INDEX portfolio_publications_owner_idx
    ON portfolio_publications(account_id, publication_sequence DESC);

ALTER TABLE portfolio_public_sites
    ADD CONSTRAINT portfolio_public_sites_current_fk
    FOREIGN KEY (account_id, current_publication_id)
    REFERENCES portfolio_publications(account_id, id) ON DELETE RESTRICT;
ALTER TABLE portfolio_public_sites
    ADD CONSTRAINT portfolio_public_sites_promotion_fk
    FOREIGN KEY (account_id, promotion_publication_id)
    REFERENCES portfolio_publications(account_id, id) ON DELETE RESTRICT;

CREATE TABLE portfolio_publication_attempts (
    id uuid PRIMARY KEY,
    publication_id uuid NOT NULL REFERENCES portfolio_publications(id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    fence bigint NOT NULL CHECK (fence > 0),
    worker_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('leased','succeeded','failed','expired','fenced')),
    lease_expires_at timestamptz NOT NULL,
    completion_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    UNIQUE (publication_id, attempt_number),
    UNIQUE (publication_id, fence)
);


DO $$
BEGIN
    UPDATE platform_schema_compatibility
       SET current_version = 6, min_reader_version = 5, updated_at = transaction_timestamp()
     WHERE singleton = true AND current_version = 5 AND min_reader_version = 4;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unexpected schema compatibility state before migration 0006';
    END IF;
END
$$;
