CREATE TABLE database_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO database_identity (singleton) VALUES (true);

CREATE TABLE platform_schema_compatibility (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    current_version bigint NOT NULL CHECK (current_version > 0),
    min_reader_version bigint NOT NULL CHECK (
        min_reader_version > 0 AND min_reader_version <= current_version
    ),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO platform_schema_compatibility (
    singleton,
    current_version,
    min_reader_version
) VALUES (true, 1, 1);

CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    email_normalized text NOT NULL UNIQUE,
    display_name text NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (id, revision),
    CHECK (octet_length(email) BETWEEN 3 AND 320),
    CHECK (octet_length(email_normalized) BETWEEN 3 AND 320),
    CHECK (octet_length(display_name) BETWEEN 1 AND 100)
);

CREATE TABLE password_identities (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    CHECK (octet_length(password_hash) BETWEEN 20 AND 1024)
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    last_used_at timestamptz,
    CHECK (expires_at > created_at)
);

CREATE INDEX sessions_account_id_idx ON sessions(account_id);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    target_type text NOT NULL,
    target_id uuid,
    outcome text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    CHECK (octet_length(event_type) BETWEEN 1 AND 128),
    CHECK (octet_length(target_type) BETWEEN 1 AND 128),
    CHECK (octet_length(outcome) BETWEEN 1 AND 64),
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX audit_events_account_created_idx
    ON audit_events(account_id, created_at DESC, id DESC);

CREATE TABLE idempotency_records (
    actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    operation text NOT NULL,
    key text NOT NULL,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
    response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (actor_account_id, operation, key),
    CHECK (octet_length(operation) BETWEEN 1 AND 160),
    CHECK (octet_length(key) BETWEEN 1 AND 128)
);
