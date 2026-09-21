ALTER TABLE idempotency_records ADD COLUMN request_key_version text
    CHECK (
        request_key_version IS NULL OR
        octet_length(request_key_version) BETWEEN 1 AND 64
    );

CREATE TABLE secrets (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_id uuid NOT NULL,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 128),
    operation text NOT NULL CHECK (operation IN (
        'build', 'runtime', 'database_migration', 'platform_management'
    )),
    credential_kind text NOT NULL CHECK (credential_kind IN (
        'source_repository_read', 'build_environment', 'production_database',
        'platform_management'
    )),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, service_id, id),
    UNIQUE (account_id, project_id, service_id, id, operation, credential_kind),
    UNIQUE (account_id, project_id, service_id, name, operation, credential_kind),
    FOREIGN KEY (account_id, project_id, service_id)
        REFERENCES services(account_id, project_id, id) ON DELETE CASCADE
);

CREATE TABLE secret_versions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_id uuid NOT NULL,
    secret_id uuid NOT NULL,
    version_number bigint NOT NULL CHECK (version_number > 0),
    key_version text NOT NULL CHECK (octet_length(key_version) BETWEEN 1 AND 64),
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 24),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 16384),
    auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, service_id, secret_id, id),
    UNIQUE (secret_id, version_number),
    FOREIGN KEY (account_id, project_id, service_id, secret_id)
        REFERENCES secrets(account_id, project_id, service_id, id) ON DELETE CASCADE
);

CREATE INDEX secret_versions_scope_version_idx
    ON secret_versions(account_id, project_id, service_id, secret_id, version_number DESC);

CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind = 'foundation_bookkeeping'),
    operation text NOT NULL CHECK (operation = 'build'),
    source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN (
        'queued', 'running', 'succeeded', 'failed', 'canceled', 'retriable'
    )),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
    current_attempt_id uuid,
    current_fence bigint NOT NULL DEFAULT 0 CHECK (current_fence >= 0),
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    UNIQUE (account_id, project_id, service_id, id),
    UNIQUE (account_id, project_id, service_id, id, operation),
    FOREIGN KEY (account_id, project_id, service_id)
        REFERENCES services(account_id, project_id, id) ON DELETE CASCADE,
    CHECK (
        (state = 'running' AND current_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL) OR
        (state <> 'running' AND lease_expires_at IS NULL)
    )
);

CREATE INDEX jobs_claimable_idx
    ON jobs(created_at, id) WHERE state IN ('queued', 'retriable');
CREATE INDEX jobs_expired_lease_idx
    ON jobs(lease_expires_at, id) WHERE state = 'running';

CREATE TABLE job_attempts (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    fence bigint NOT NULL CHECK (fence > 0),
    worker_id text NOT NULL CHECK (octet_length(worker_id) BETWEEN 1 AND 128),
    state text NOT NULL CHECK (state IN (
        'running', 'succeeded', 'failed', 'retriable', 'expired', 'canceled'
    )),
    lease_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    lease_expires_at timestamptz NOT NULL,
    finished_at timestamptz,
    terminal_code text CHECK (
        terminal_code IS NULL OR octet_length(terminal_code) BETWEEN 1 AND 64
    ),
    completion_hash bytea CHECK (
        completion_hash IS NULL OR octet_length(completion_hash) = 32
    ),
    UNIQUE (account_id, project_id, job_id, id),
    UNIQUE (account_id, project_id, job_id, id, fence),
    UNIQUE (job_id, attempt_number),
    UNIQUE (job_id, fence),
    FOREIGN KEY (account_id, project_id, job_id)
        REFERENCES jobs(account_id, project_id, id) ON DELETE CASCADE,
    CHECK (lease_expires_at > lease_started_at),
    CHECK (
        (state = 'running' AND finished_at IS NULL AND terminal_code IS NULL) OR
        (state <> 'running' AND finished_at IS NOT NULL AND terminal_code IS NOT NULL)
    )
);

ALTER TABLE jobs ADD CONSTRAINT jobs_current_attempt_fk
    FOREIGN KEY (account_id, project_id, id, current_attempt_id, current_fence)
    REFERENCES job_attempts(account_id, project_id, job_id, id, fence)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE job_secret_refs (
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    service_id uuid NOT NULL,
    job_id uuid NOT NULL,
    secret_id uuid NOT NULL,
    secret_version_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation = 'build'),
    credential_kind text NOT NULL CHECK (credential_kind IN (
        'source_repository_read', 'build_environment', 'production_database',
        'platform_management'
    )),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (job_id, secret_version_id),
    UNIQUE (job_id, secret_id),
    UNIQUE (
        account_id, project_id, service_id, job_id, secret_id, secret_version_id,
        operation, credential_kind
    ),
    FOREIGN KEY (account_id, project_id, service_id, job_id, operation)
        REFERENCES jobs(account_id, project_id, service_id, id, operation) ON DELETE CASCADE,
    FOREIGN KEY (
        account_id, project_id, service_id, secret_id, operation, credential_kind
    ) REFERENCES secrets(
        account_id, project_id, service_id, id, operation, credential_kind
    ) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, service_id, secret_id, secret_version_id)
        REFERENCES secret_versions(
            account_id, project_id, service_id, secret_id, id
        ) ON DELETE RESTRICT
);

CREATE TABLE job_effects (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    fence bigint NOT NULL CHECK (fence > 0),
    outcome_state text NOT NULL CHECK (outcome_state IN ('succeeded', 'failed')),
    outcome_code text NOT NULL CHECK (octet_length(outcome_code) BETWEEN 1 AND 64),
    response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
    completion_hash bytea NOT NULL CHECK (octet_length(completion_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (job_id),
    UNIQUE (account_id, project_id, job_id, id),
    FOREIGN KEY (account_id, project_id, job_id)
        REFERENCES jobs(account_id, project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, job_id, attempt_id, fence)
        REFERENCES job_attempts(account_id, project_id, job_id, id, fence) ON DELETE RESTRICT
);

DO $$
BEGIN
    UPDATE platform_schema_compatibility
    SET current_version = 3,
        min_reader_version = 1,
        updated_at = transaction_timestamp()
    WHERE singleton = true AND current_version = 2 AND min_reader_version = 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'unexpected schema compatibility state before migration 0003';
    END IF;
END
$$;
