-- M2 additive onboarding state; retained M1 schema-4 readers remain supported.

-- Frozen HOST-219 schema contract. The migration owner may wrap this in the
-- repository's schema-version transition, but table/column names are shared
-- with github.rs and github_webhooks.rs.

CREATE TABLE github_oauth_attempts (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    state_digest bytea NOT NULL UNIQUE CHECK (octet_length(state_digest) = 32),
    pkce_key_version text NOT NULL CHECK (octet_length(pkce_key_version) BETWEEN 1 AND 128),
    pkce_nonce bytea NOT NULL CHECK (octet_length(pkce_nonce) = 24),
    pkce_ciphertext bytea NOT NULL CHECK (octet_length(pkce_ciphertext) BETWEEN 1 AND 512),
    pkce_auth_tag bytea NOT NULL CHECK (octet_length(pkce_auth_tag) = 16),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    CHECK (expires_at > created_at),
    CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);

CREATE INDEX github_oauth_attempts_account_session_idx
    ON github_oauth_attempts(account_id, session_id, created_at DESC);

CREATE TABLE github_user_authorizations (
    account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    github_user_id bigint NOT NULL UNIQUE CHECK (github_user_id > 0),
    github_login text NOT NULL CHECK (octet_length(github_login) BETWEEN 1 AND 255),
    token_key_version text CHECK (token_key_version IS NULL OR octet_length(token_key_version) BETWEEN 1 AND 128),
    token_nonce bytea CHECK (token_nonce IS NULL OR octet_length(token_nonce) = 24),
    token_ciphertext bytea CHECK (token_ciphertext IS NULL OR octet_length(token_ciphertext) BETWEEN 1 AND 8192),
    token_auth_tag bytea CHECK (token_auth_tag IS NULL OR octet_length(token_auth_tag) = 16),
    token_expires_at timestamptz,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    CHECK (token_expires_at IS NULL OR token_expires_at > created_at),
    CHECK (
        (status IN ('active', 'expired') AND token_key_version IS NOT NULL AND
         token_nonce IS NOT NULL AND token_ciphertext IS NOT NULL AND token_auth_tag IS NOT NULL) OR
        (status = 'revoked' AND token_key_version IS NULL AND token_nonce IS NULL AND
         token_ciphertext IS NULL AND token_auth_tag IS NULL)
    )
);

CREATE TABLE github_installations (
    installation_id bigint PRIMARY KEY CHECK (installation_id > 0),
    app_id bigint NOT NULL CHECK (app_id > 0),
    target_id bigint NOT NULL CHECK (target_id > 0),
    target_type text NOT NULL CHECK (target_type IN ('User', 'Organization')),
    target_login text NOT NULL CHECK (octet_length(target_login) BETWEEN 1 AND 255),
    repository_selection text NOT NULL CHECK (repository_selection IN ('all', 'selected')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN (
        'active', 'suspended', 'deleted', 'revalidation_required'
    )),
    last_verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE github_repository_bindings (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    installation_id bigint NOT NULL REFERENCES github_installations(installation_id) ON DELETE RESTRICT,
    github_repository_id bigint NOT NULL CHECK (github_repository_id > 0),
    canonical_owner text NOT NULL CHECK (octet_length(canonical_owner) BETWEEN 1 AND 255),
    canonical_name text NOT NULL CHECK (octet_length(canonical_name) BETWEEN 1 AND 255),
    repository_private boolean NOT NULL,
    authorized_ref text NOT NULL CHECK (
        octet_length(authorized_ref) BETWEEN 12 AND 512 AND
        authorized_ref LIKE 'refs/heads/%' AND
        authorized_ref !~ '[[:cntrl:]]'
    ),
    status text NOT NULL DEFAULT 'active' CHECK (status IN (
        'active', 'disabled', 'access_removed', 'installation_suspended',
        'installation_deleted', 'revalidation_required', 'user_revalidation_required'
    )),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    selection_revision bigint NOT NULL CHECK (selection_revision > 0),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    UNIQUE (project_id, selection_revision),
    UNIQUE (id, account_id, project_id, repository_id),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, repository_id)
        REFERENCES repositories(account_id, project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX github_repository_bindings_one_active_project_idx
    ON github_repository_bindings(project_id) WHERE status = 'active';
CREATE INDEX github_repository_bindings_provider_lookup_idx
    ON github_repository_bindings(installation_id, github_repository_id, authorized_ref);

CREATE TABLE github_webhook_deliveries (
    delivery_id text PRIMARY KEY CHECK (octet_length(delivery_id) BETWEEN 1 AND 128),
    event text NOT NULL CHECK (octet_length(event) BETWEEN 1 AND 64),
    action text CHECK (action IS NULL OR octet_length(action) BETWEEN 1 AND 64),
    installation_id bigint CHECK (installation_id IS NULL OR installation_id > 0),
    github_repository_id bigint CHECK (github_repository_id IS NULL OR github_repository_id > 0),
    payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
    disposition text NOT NULL CHECK (disposition IN ('accepted', 'duplicate', 'rejected')),
    reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 128),
    received_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE github_source_revisions (
    id uuid PRIMARY KEY,
    binding_id uuid NOT NULL,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    installation_id bigint NOT NULL CHECK (installation_id > 0),
    github_repository_id bigint NOT NULL CHECK (github_repository_id > 0),
    canonical_owner text NOT NULL CHECK (octet_length(canonical_owner) BETWEEN 1 AND 255),
    canonical_name text NOT NULL CHECK (octet_length(canonical_name) BETWEEN 1 AND 255),
    repository_private boolean NOT NULL,
    authorized_ref text NOT NULL CHECK (
        octet_length(authorized_ref) BETWEEN 12 AND 512 AND
        authorized_ref LIKE 'refs/heads/%' AND
        authorized_ref !~ '[[:cntrl:]]'
    ),
    commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    tree_sha text CHECK (tree_sha IS NULL OR tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    source text NOT NULL CHECK (source IN ('owner_resolve', 'signed_push')),
    webhook_delivery_id text REFERENCES github_webhook_deliveries(delivery_id) ON DELETE RESTRICT,
    observed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    UNIQUE (binding_id, commit_sha, source, webhook_delivery_id),
    CHECK (
        (source = 'owner_resolve' AND tree_sha IS NOT NULL AND webhook_delivery_id IS NULL) OR
        (source = 'signed_push' AND tree_sha IS NULL AND webhook_delivery_id IS NOT NULL)
    ),
    FOREIGN KEY (binding_id, account_id, project_id, repository_id)
        REFERENCES github_repository_bindings(id, account_id, project_id, repository_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id) ON DELETE RESTRICT
);

CREATE INDEX github_source_revisions_binding_observed_idx
    ON github_source_revisions(binding_id, observed_at DESC, id DESC);
CREATE UNIQUE INDEX github_source_revisions_one_binding_delivery_idx
    ON github_source_revisions(binding_id, webhook_delivery_id)
    WHERE webhook_delivery_id IS NOT NULL;

-- HOST-220 draft for migration 0005. Parent owns the actual migration wrapper,
-- compatibility update (current=5, min_reader=4), and REQUIRED_RELATIONS.

CREATE TABLE admission_fixture_receipts (
    event_id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN (
        'entitlement', 'capacity', 'source_proof', 'resource_observation',
        'build_debit', 'platform_fault_credit'
    )),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE admission_capacity_pools (
    pool_key text PRIMARY KEY CHECK (octet_length(pool_key) BETWEEN 1 AND 64),
    profile text NOT NULL CHECK (octet_length(profile) BETWEEN 1 AND 64),
    hosted_slot_limit integer NOT NULL CHECK (hosted_slot_limit >= 0),
    rollout_headroom_limit integer NOT NULL CHECK (rollout_headroom_limit >= 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE admission_entitlements (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
    capacity_pool_key text NOT NULL REFERENCES admission_capacity_pools(pool_key) ON DELETE RESTRICT,
    source text NOT NULL CHECK (source = 'synthetic_internal'),
    hosted_slot_limit integer NOT NULL CHECK (hosted_slot_limit >= 0),
    build_seconds_limit integer NOT NULL CHECK (build_seconds_limit >= 0),
    period_starts_at timestamptz NOT NULL,
    period_ends_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('active', 'expired', 'revoked')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (id, account_id, capacity_pool_key),
    UNIQUE (id, account_id),
    CHECK (period_ends_at > period_starts_at)
);

CREATE TABLE admission_source_proofs (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    inventory_revision bigint NOT NULL CHECK (inventory_revision > 0),
    source text NOT NULL CHECK (source = 'synthetic_internal'),
    state text NOT NULL CHECK (state IN ('valid', 'superseded', 'expired')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, deployment_id, inventory_revision),
    UNIQUE (id, account_id, project_id, deployment_id),
    FOREIGN KEY (account_id, project_id, configuration_revision_id, deployment_id)
        REFERENCES deployments(account_id, project_id, configuration_revision_id, id)
        ON DELETE CASCADE
);
CREATE UNIQUE INDEX admission_source_proofs_one_valid_idx
    ON admission_source_proofs(deployment_id) WHERE state = 'valid';

CREATE TABLE capacity_holds (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    source_proof_id uuid NOT NULL,
    entitlement_id uuid NOT NULL REFERENCES admission_entitlements(id) ON DELETE RESTRICT,
    capacity_pool_key text NOT NULL REFERENCES admission_capacity_pools(pool_key) ON DELETE RESTRICT,
    reservation_id uuid,
    reservation_epoch uuid,
    kind text NOT NULL CHECK (kind IN ('initial', 'rollout')),
    state text NOT NULL CHECK (state IN ('active', 'consumed', 'released', 'expired')),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (id, account_id, project_id, deployment_id),
    UNIQUE (id, account_id, project_id, deployment_id, reservation_id, reservation_epoch),
    FOREIGN KEY (source_proof_id, account_id, project_id, deployment_id)
        REFERENCES admission_source_proofs(id, account_id, project_id, deployment_id) ON DELETE RESTRICT,
    FOREIGN KEY (entitlement_id, account_id, capacity_pool_key)
        REFERENCES admission_entitlements(id, account_id, capacity_pool_key) ON DELETE RESTRICT,
    CHECK (
        (kind = 'initial' AND reservation_id IS NULL AND reservation_epoch IS NULL) OR
        (kind = 'rollout' AND reservation_id IS NOT NULL AND reservation_epoch IS NOT NULL)
    ),
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE CASCADE,
    CHECK (expires_at > created_at),
    CHECK (state <> 'consumed' OR consumed_at IS NOT NULL),
    CHECK (state <> 'active' OR consumed_at IS NULL),
    CHECK ((state IN ('released', 'expired')) = (released_at IS NOT NULL))
);
CREATE UNIQUE INDEX capacity_holds_one_active_kind_idx
    ON capacity_holds(project_id, deployment_id, kind)
    WHERE (kind = 'initial' AND state = 'active') OR
          (kind = 'rollout' AND state IN ('active', 'consumed'));
CREATE INDEX capacity_holds_expiry_idx
    ON capacity_holds(expires_at, id) WHERE state = 'active';

CREATE TABLE slot_reservations (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    first_deployment_id uuid NOT NULL,
    entitlement_id uuid NOT NULL REFERENCES admission_entitlements(id) ON DELETE RESTRICT,
    capacity_pool_key text NOT NULL REFERENCES admission_capacity_pools(pool_key) ON DELETE RESTRICT,
    initial_hold_id uuid NOT NULL UNIQUE REFERENCES capacity_holds(id) ON DELETE RESTRICT,
    reservation_epoch uuid NOT NULL UNIQUE,
    state text NOT NULL CHECK (state IN (
        'reserved', 'resources_retained', 'release_pending', 'released'
    )),
    retention_reason text CHECK (
        retention_reason IS NULL OR octet_length(retention_reason) BETWEEN 1 AND 160
    ),
    release_observation_id uuid,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    released_at timestamptz,
    UNIQUE (account_id, project_id, id),
    UNIQUE (account_id, project_id, id, reservation_epoch),
    UNIQUE (account_id, project_id, capacity_pool_key, id, reservation_epoch),
    FOREIGN KEY (entitlement_id, account_id, capacity_pool_key)
        REFERENCES admission_entitlements(id, account_id, capacity_pool_key) ON DELETE RESTRICT,
    FOREIGN KEY (initial_hold_id, account_id, project_id, first_deployment_id)
        REFERENCES capacity_holds(id, account_id, project_id, deployment_id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, first_deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    CHECK ((state = 'released') = (released_at IS NOT NULL)),
    CHECK ((state = 'resources_retained') = (retention_reason IS NOT NULL))
);
CREATE UNIQUE INDEX slot_reservations_one_active_project_idx
    ON slot_reservations(project_id) WHERE state <> 'released';

ALTER TABLE capacity_holds ADD CONSTRAINT capacity_holds_reservation_generation_fk
    FOREIGN KEY (account_id, project_id, capacity_pool_key, reservation_id, reservation_epoch)
    REFERENCES slot_reservations(account_id, project_id, capacity_pool_key, id, reservation_epoch)
    ON DELETE RESTRICT;

CREATE TABLE admission_resource_observations (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    reservation_epoch uuid NOT NULL,
    rollout_hold_id uuid,
    outcome text NOT NULL CHECK (outcome IN (
        'resources_retained', 'cleanup_confirmed', 'rollout_released', 'deployment_healthy'
    )),
    resource_inventory text NOT NULL CHECK (resource_inventory IN (
        'none', 'runtime', 'static_release', 'database', 'multiple'
    )),
    proof_ref text NOT NULL CHECK (octet_length(proof_ref) BETWEEN 1 AND 256),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    FOREIGN KEY (account_id, project_id, reservation_id, reservation_epoch)
        REFERENCES slot_reservations(account_id, project_id, id, reservation_epoch) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (rollout_hold_id, account_id, project_id, deployment_id, reservation_id, reservation_epoch)
        REFERENCES capacity_holds(id, account_id, project_id, deployment_id, reservation_id, reservation_epoch)
        ON DELETE RESTRICT,
    CHECK (
        (outcome = 'cleanup_confirmed' AND resource_inventory = 'none') OR
        (outcome IN ('resources_retained', 'deployment_healthy') AND resource_inventory <> 'none') OR
        (outcome = 'rollout_released' AND rollout_hold_id IS NOT NULL)
    )
);
ALTER TABLE slot_reservations ADD CONSTRAINT slot_reservations_release_observation_fk
    FOREIGN KEY (account_id, project_id, release_observation_id)
    REFERENCES admission_resource_observations(account_id, project_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE build_usage_events (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    entitlement_id uuid NOT NULL REFERENCES admission_entitlements(id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('debit', 'platform_fault_credit')),
    seconds integer NOT NULL CHECK (seconds > 0),
    debit_event_id uuid,
    platform_fault_ref text CHECK (
        platform_fault_ref IS NULL OR octet_length(platform_fault_ref) BETWEEN 1 AND 256
    ),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    FOREIGN KEY (entitlement_id, account_id)
        REFERENCES admission_entitlements(id, account_id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (debit_event_id) REFERENCES build_usage_events(id) ON DELETE RESTRICT,
    CHECK (
        (kind = 'debit' AND debit_event_id IS NULL AND platform_fault_ref IS NULL) OR
        (kind = 'platform_fault_credit' AND debit_event_id IS NOT NULL AND platform_fault_ref IS NOT NULL)
    )
);
CREATE UNIQUE INDEX build_usage_one_debit_attempt_idx
    ON build_usage_events(entitlement_id, attempt_id) WHERE kind = 'debit';
CREATE UNIQUE INDEX build_usage_one_credit_debit_idx
    ON build_usage_events(debit_event_id) WHERE kind = 'platform_fault_credit';


CREATE TABLE admission_reconciliation_intents (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    hold_id uuid NOT NULL UNIQUE REFERENCES capacity_holds(id) ON DELETE RESTRICT,
    kind text NOT NULL CHECK (kind = 'refund_required'),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'resolved')),
    reason text NOT NULL CHECK (reason = 'hold_expired'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    resolved_at timestamptz,
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);

-- Private compatibility and preview records share the existing project graph.
-- Assumptions supplied by HOST-219:
--   github_source_revisions(id, account_id, project_id, commit_sha, ...)
--   UNIQUE (account_id, project_id, id)
-- The integrator should use the final HOST-219 table/constraint names verbatim.

CREATE TABLE compatibility_reports (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    source_revision_id uuid NOT NULL,
    analyzer_revision text NOT NULL CHECK (
        octet_length(analyzer_revision) BETWEEN 1 AND 128
    ),
    status text NOT NULL CHECK (status IN (
        'candidate',
        'configuration_needed',
        'database_needed',
        'secrets_needed',
        'showcase_only'
    )),
    advisory text NOT NULL DEFAULT 'deployment_not_verified' CHECK (
        advisory = 'deployment_not_verified'
    ),
    report jsonb NOT NULL CHECK (
        jsonb_typeof(report) = 'object' AND
        octet_length(report::text) BETWEEN 2 AND 131072
    ),
    report_digest text NOT NULL CHECK (
        report_digest ~ '^sha256:[0-9a-f]{64}$'
    ),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (
        account_id,
        project_id,
        configuration_revision_id,
        source_revision_id,
        analyzer_revision
    ),
    UNIQUE (
        account_id,
        project_id,
        configuration_revision_id,
        source_revision_id,
        id
    ),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (account_id, project_id, source_revision_id)
        REFERENCES github_source_revisions(account_id, project_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX compatibility_reports_owner_project_created_idx
    ON compatibility_reports(account_id, project_id, created_at DESC, id DESC);

-- Every M2 save still appends the full owner-authored PortfolioDraft to the M1
-- portfolio_draft_revisions table. This sidecar contains only private onboarding
-- context. M2 has one preview layout and a bounded typography/accent choice;
-- three professional publication templates remain M4 work.
CREATE TABLE portfolio_preview_contexts (
    account_id uuid NOT NULL,
    portfolio_revision_id uuid PRIMARY KEY,
    layout text NOT NULL DEFAULT 'layout_1' CHECK (layout = 'layout_1'),
    typography text NOT NULL DEFAULT 'system_sans'
        CHECK (typography IN ('system_sans', 'editorial_serif')),
    accent text NOT NULL DEFAULT 'coral'
        CHECK (accent IN ('coral', 'indigo', 'forest')),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, portfolio_revision_id),
    FOREIGN KEY (account_id, portfolio_revision_id)
        REFERENCES portfolio_draft_revisions(account_id, id) ON DELETE CASCADE
);

CREATE TABLE portfolio_preview_project_contexts (
    account_id uuid NOT NULL,
    portfolio_revision_id uuid NOT NULL,
    project_reference_id text NOT NULL CHECK (
        octet_length(project_reference_id) BETWEEN 1 AND 128
    ),
    project_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    source_revision_id uuid NOT NULL,
    compatibility_report_id uuid NOT NULL,
    placeholder text NOT NULL DEFAULT 'gradient_1'
        CHECK (placeholder IN ('gradient_1', 'grid_1', 'terminal_1')),
    configuration_answers jsonb NOT NULL CHECK (
        jsonb_typeof(configuration_answers) = 'array' AND
        octet_length(configuration_answers::text) BETWEEN 2 AND 65536
    ),
    PRIMARY KEY (portfolio_revision_id, project_reference_id),
    FOREIGN KEY (account_id, portfolio_revision_id)
        REFERENCES portfolio_preview_contexts(account_id, portfolio_revision_id)
        ON DELETE CASCADE,
    FOREIGN KEY (portfolio_revision_id, project_reference_id)
        REFERENCES portfolio_project_references(
            portfolio_revision_id,
            project_reference_id
        ) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        account_id,
        project_id,
        configuration_revision_id,
        source_revision_id,
        compatibility_report_id
    ) REFERENCES compatibility_reports(
        account_id,
        project_id,
        configuration_revision_id,
        source_revision_id,
        id
    ) ON DELETE RESTRICT
);

CREATE INDEX portfolio_preview_project_contexts_owner_report_idx
    ON portfolio_preview_project_contexts(account_id, compatibility_report_id);

-- Keep the retained schema-4 M1 binary readable/writable. All new state is in
-- additive tables; its old INSERT column lists remain valid.
DO $$
BEGIN
    UPDATE platform_schema_compatibility
    SET current_version = 5,
        min_reader_version = 4,
        updated_at = transaction_timestamp()
    WHERE singleton = true AND current_version = 4 AND min_reader_version = 3;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'unexpected schema compatibility state before migration 0005';
    END IF;
END
$$;

-- Application invariants not expressible as simple CHECK/FK constraints:
-- 1. compatibility_reports and their JSON are append-only; expose no UPDATE API.
-- 2. report is the bounded CompatibilitySafeFactsV1 DTO. It contains reason
--    codes/messages/source paths, inferred safe metadata, environment variable
--    names/classification and configuration questions. It contains no file body,
--    source excerpt, command output, environment value, credential or secret.
-- 3. configuration_answers is the bounded ConfigurationAnswerV1 DTO. It permits
--    public build-time values and unresolved/secret-required states; a secret
--    value is never accepted or persisted.
-- 4. Before report creation, the service revalidates the active owner/project
--    source binding. Preview saves verify the owned immutable report tuple and
--    its canonical JSON digest; a historical private report remains readable
--    after provider revocation and grants no fresh source access or publication.
