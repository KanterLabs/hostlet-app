CREATE TABLE projects (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 120),
    mode text NOT NULL CHECK (mode IN (
        'draft', 'compatibility_check', 'deployment_intent',
        'showcase_only', 'portfolio_only', 'external_case_study'
    )),
    hosted_slots smallint NOT NULL DEFAULT 0 CHECK (hosted_slots IN (0, 1)),
    slot_state text NOT NULL DEFAULT 'no_slot' CHECK (slot_state IN (
        'no_slot', 'admission_required', 'reserved', 'resources_retained',
        'release_pending', 'released'
    )),
    current_configuration_revision_id uuid,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, id),
    CHECK (
        (hosted_slots = 0 AND slot_state IN (
            'no_slot', 'admission_required', 'release_pending', 'released'
        )) OR
        (hosted_slots = 1 AND slot_state IN (
            'reserved', 'resources_retained', 'release_pending'
        ))
    )
);

CREATE TABLE configuration_revisions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    revision_number bigint NOT NULL CHECK (revision_number > 0),
    spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    UNIQUE (project_id, revision_number),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE
);

ALTER TABLE projects ADD CONSTRAINT projects_current_configuration_fk
    FOREIGN KEY (account_id, id, current_configuration_revision_id)
    REFERENCES configuration_revisions(account_id, project_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE repositories (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    UNIQUE (project_id),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE
);

CREATE TABLE repository_configurations (
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (configuration_revision_id, repository_id),
    UNIQUE (account_id, project_id, configuration_revision_id, repository_id),
    UNIQUE (configuration_revision_id),
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, repository_id)
        REFERENCES repositories(account_id, project_id, id) ON DELETE RESTRICT
);

CREATE TABLE services (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('static_frontend', 'application', 'postgres')),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    UNIQUE (account_id, project_id, id, kind),
    UNIQUE (project_id, kind),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE
);

CREATE TABLE service_configurations (
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    service_id uuid NOT NULL,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 64),
    kind text NOT NULL CHECK (kind IN ('static_frontend', 'application', 'postgres')),
    specification jsonb NOT NULL CHECK (jsonb_typeof(specification) = 'object'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (configuration_revision_id, service_id),
    UNIQUE (account_id, project_id, configuration_revision_id, service_id),
    UNIQUE (account_id, project_id, configuration_revision_id, service_id, kind),
    UNIQUE (configuration_revision_id, name),
    UNIQUE (configuration_revision_id, kind),
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, service_id, kind)
        REFERENCES services(account_id, project_id, id, kind) ON DELETE RESTRICT
);

CREATE TABLE deployments (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    source_commit text NOT NULL CHECK (
        source_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
    ),
    lifecycle text NOT NULL CHECK (lifecycle IN (
        'intent', 'admission_required', 'queued', 'healthy',
        'failed_no_resources', 'failed_resources_retained',
        'rollback_requested', 'removed'
    )),
    health_result_ref text,
    database_migration_revision text,
    secret_version_refs jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(secret_version_refs) = 'array'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    UNIQUE (account_id, project_id, configuration_revision_id, id),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, configuration_revision_id)
        REFERENCES configuration_revisions(account_id, project_id, id) ON DELETE RESTRICT,
    CHECK (health_result_ref IS NULL OR octet_length(health_result_ref) BETWEEN 1 AND 256),
    CHECK (
        database_migration_revision IS NULL OR
        octet_length(database_migration_revision) BETWEEN 1 AND 256
    )
);

CREATE TABLE deployment_artifact_refs (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    service_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('static', 'application')),
    service_kind text NOT NULL CHECK (service_kind IN ('static_frontend', 'application')),
    digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (deployment_id, kind),
    FOREIGN KEY (account_id, project_id, configuration_revision_id, deployment_id)
        REFERENCES deployments(account_id, project_id, configuration_revision_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (
        account_id, project_id, configuration_revision_id, service_id, service_kind
    )
        REFERENCES service_configurations(
            account_id, project_id, configuration_revision_id, service_id, kind
        ) ON DELETE RESTRICT,
    CHECK (
        (kind = 'static' AND service_kind = 'static_frontend') OR
        (kind = 'application' AND service_kind = 'application')
    )
);

CREATE UNIQUE INDEX deployments_one_admission_required_idx
    ON deployments(project_id) WHERE lifecycle = 'admission_required';

CREATE TABLE hosting_state_events (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    deployment_id uuid,
    state text NOT NULL CHECK (state IN (
        'admission_required', 'reserved', 'failed_no_resources',
        'failed_resources_retained', 'rollback_requested',
        'removal_pending', 'removed'
    )),
    source text NOT NULL CHECK (source IN ('owner_intent', 'trusted_observation')),
    reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT
);

CREATE TABLE project_lifecycle_intents (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL,
    project_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('rollback', 'removal')),
    target_deployment_id uuid,
    state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'completed', 'canceled')),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, project_id, id),
    FOREIGN KEY (account_id, project_id)
        REFERENCES projects(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, project_id, target_deployment_id)
        REFERENCES deployments(account_id, project_id, id) ON DELETE RESTRICT,
    CHECK (
        (kind = 'rollback' AND target_deployment_id IS NOT NULL) OR
        (kind = 'removal' AND target_deployment_id IS NULL)
    )
);

CREATE UNIQUE INDEX project_lifecycle_intents_one_requested_idx
    ON project_lifecycle_intents(project_id) WHERE state = 'requested';

CREATE TABLE portfolio_draft_revisions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    revision_number bigint NOT NULL CHECK (revision_number > 0),
    draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    UNIQUE (account_id, id),
    UNIQUE (account_id, revision_number)
);

CREATE TABLE portfolio_project_references (
    portfolio_revision_id uuid NOT NULL,
    account_id uuid NOT NULL,
    project_reference_id text NOT NULL CHECK (
        octet_length(project_reference_id) BETWEEN 1 AND 128
    ),
    hosted_project_id uuid,
    external_reference_id text,
    PRIMARY KEY (portfolio_revision_id, project_reference_id),
    FOREIGN KEY (account_id, portfolio_revision_id)
        REFERENCES portfolio_draft_revisions(account_id, id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, hosted_project_id)
        REFERENCES projects(account_id, id) ON DELETE RESTRICT,
    CHECK (
        (hosted_project_id IS NOT NULL AND external_reference_id IS NULL) OR
        (
            hosted_project_id IS NULL AND external_reference_id IS NOT NULL AND
            octet_length(external_reference_id) BETWEEN 1 AND 128
        )
    )
);

DO $$
BEGIN
    UPDATE platform_schema_compatibility
    SET current_version = 2,
        min_reader_version = 1,
        updated_at = transaction_timestamp()
    WHERE singleton = true AND current_version = 1 AND min_reader_version = 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'unexpected schema compatibility state before migration 0002';
    END IF;
END
$$;
