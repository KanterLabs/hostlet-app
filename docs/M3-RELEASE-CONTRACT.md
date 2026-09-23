# M3 owned-fixture release contract

HOST-226 is enabled only in `HOSTLET_M3_MODE=owned_fixture`. PostgreSQL owns
release intent, exact evidence references, reconciliation fencing, history and
the current route generation. Artifact and evidence bytes remain digest
addressed under the owned M3 state root. This contract does not admit customer
work or authorize production publication.

## Owner API

All POST requests require JSON. Release and rollback requests require an
`Idempotency-Key` header and are owner scoped; a cross-owner identifier returns
not found.

`POST /v1/projects/{project_id}/deployments/{deployment_id}/migration-trial`
accepts:

```json
{
  "build_job_id": "uuid",
  "tenant_database_id": "uuid",
  "database_generation": "uuid",
  "migration_revision": "schema-2",
  "migration_digest": "sha256:...",
  "migration_artifact_path": "dist/migrations/002_additive_client_compatibility.sql",
  "current_schema_revision": "schema-1",
  "candidate_schema_revision": "schema-2"
}
```

The control plane derives the candidate, current and retained application
artifact digests. It first returns `202` with phase
`pre_migration_backup_queued`. After the database worker has made that exact
backup usable, retry with a new idempotency key to record the immutable
migration plan; the response is `201` with phase `migration_planned` and its
migration ID. Planning does not queue database work. The release worker must
first materialize the exact HCA entry under its fenced release attempt. Control
then authenticates that receipt and queues the isolated trial. The database
worker prepares the isolated populated target and applies the exact migration
there. It cannot claim application compatibility or apply the live migration.

`POST /v1/projects/{project_id}/deployments/{deployment_id}/releases` accepts:

```json
{
  "build_job_id": "uuid",
  "runtime_allocation_id": "uuid-or-null",
  "tenant_database_id": "uuid-or-null",
  "database_generation": "uuid-or-null",
  "migration_revision": "schema-2-or-null",
  "migration_digest": "sha256:...-or-null",
  "migration_artifact_path": "dist/migrations/002_additive_client_compatibility.sql-or-null",
  "managed_demo_url": "https://owned-fixture.example/..."
}
```

The control plane derives source commit, configuration revision, registered
frontend/backend archives and manifests, build secret-version references, and
the exact healthy runtime observation. A backend and runtime allocation are
required together. Database identifiers are required together, and migration
revision/digest are required together. A migration release must reference the
exact immutable migration plan. The response contains the durable staged release and a
queued reconciliation; it never means healthy.

`GET /v1/projects/{project_id}/releases` returns `current_route` plus complete
release history. Failed candidates remain history but do not consume a
successful retention position.

`POST /v1/projects/{project_id}/releases/{release_id}/rollback` accepts `{}`.
The target must be an owner-scoped retained healthy release with a still-valid
configuration, runtime capability and secret-version set. For an application
release, its exact allocation ID, generation and fence must still have runtime
state `healthy` both at owner admission and worker lease. A stopped or cleaned
retained allocation remains immutable history but is not an M3 rollback target;
restart or allocation replacement is deferred beyond M3. Rollback creates a new
reconciliation against the current database generation; it never selects or
restores a backup.

## Runtime worker API

These routes exist only on the internal listener and require the runtime worker
token.

- `POST /internal/v1/release-reconciliations/lease` with `{"worker_id":"..."}`
- `POST /internal/v1/release-reconciliations/{id}/renew` with
  `{"worker_id":"...","attempt_id":"uuid","fence":1}`
- `POST /internal/v1/release-reconciliations/{id}/complete`
- `POST /internal/v1/release-reconciliations/{id}/activate`

A lease returns the fenced reconciliation and attempt, candidate, routed
current release, up to two retained predecessors, and `required_probes`. The phase is
`reconciliation.requirements.phase`. Every release entry pins source/config/build, both archive and manifest digests,
runtime allocation generation/fence and capability tuple, database/migration,
secret versions, and the original healthy observation. Hosted probes in
`standard` and `post_live_apply` use:

```json
{
  "check_kind": "health|current_data|cached_old_frontend_candidate_api|candidate_frontend_retained_api",
  "release_id": "uuid",
  "peer_release_id": "uuid-or-null",
  "allocation_id": "uuid",
  "generation": 1,
  "fence": 1,
  "artifact_digest": "sha256:...",
  "executor_receipt_digest": "sha256:...",
  "database_generation": "uuid-or-null",
  "migration_id": "uuid-or-null"
}
```

The worker derives network targets only from runtime-owned allocation state. A
hosted probe writes canonical bytes for
`hostlet.runtime.probe-receipt/v1` into the evidence CAS and sends only its
digest. The receipt binds the exact release, peer, allocation generation/fence,
artifact, database and migration plus an executor receipt digest, HTTP
observation and nonempty named assertions.

An `isolated_validation` entry instead uses
`hostlet.runtime.migration-probe-request/v1`. Control generates a fresh
`probe_execution_id` and binds it to the reconciliation, attempt, release
fence, source allocation tuple, exact artifact and executor-template digest,
tenant database generation, migration, and the immutable runtime, policy,
capability, platform, argv, port and health tuple. The worker resolves a
`hostlet.runtime.probe-credential/v1` document for that exact execution ID.
The document is written as a protected file and includes the isolated
`hdr_<migration UUID>` database, scoped role and password.

The disposable gVisor execution emits
`hostlet.runtime.probe-receipt/v2`. It binds the fresh execution ID and source
allocation tuple and references three canonical CAS objects: a healthy
executor receipt, an application write/read receipt against the isolated
populated database, and a passing cleanup receipt proving the sandbox,
namespaces, cgroup and retained state are absent. Control verifies all three
objects and the complete fenced identity before accepting the application
evidence. Summary booleans and reuse of a live allocation as the isolated
execution identity are rejected.

Completion is:

```json
{
  "worker_id": "worker-1",
  "attempt_id": "uuid",
  "fence": 1,
  "outcome": {
    "state": "succeeded",
    "code": "release_checks_passed",
    "probe_receipt_digests": ["sha256:..."],
    "migration_apply_receipt_digest": "sha256:...-or-null",
    "migration_materialized_ref": "digest-addressed-ref-or-null",
    "migration_stage_receipt_digest": "sha256:...-or-null"
  }
}
```

Migration reconciliation has three fenced worker phases. `prepare_trial`
accepts no probes and requires the exact materialized reference and stage
receipt; successful completion returns `awaiting_trial` after queuing database
trial work. `isolated_validation` begins only after that operation has prepared
and migrated the isolated populated target. Its completion records actual
candidate, current and retained gVisor probes against that target, validates
every ordered cross-version pair, and atomically queues `migration_live_apply`;
the response is `awaiting_live_apply`. `post_live_apply` begins only after the
database worker has applied the exact bytes to the live database. It reruns the
current-data and overlap probes, then checks the centralized verified migration
gate before preparing the route. Database-worker completion alone advances the
database generation; a release completion cannot assert or replay that effect.
Compatible migration work may therefore survive a later candidate or gateway
failure while the previous route remains current.

Successful completion enters durable `prepared` state and returns the parsed
manifest, an exact compact `route_manifest_json` string, its SHA-256 digest,
route generation and drain deadline. The gateway writes those exact bytes and
atomically switches only after receiving this committed authorization. It then
writes a canonical `hostlet.release-route-switch/v1` receipt and activates with:

```json
{
  "worker_id": "worker-1",
  "attempt_id": "uuid",
  "fence": 1,
  "switch_receipt_digest": "sha256:..."
}
```

Activation rechecks the live fence, old route generation, manifest digest,
owner, previous release and target release. One transaction then advances the
durable route, marks the release healthy, records immutable history, and retires
successful releases beyond the current plus two predecessors. If activation is
interrupted before activation, the durable prepared intent is re-leased with a
higher fence and `reconciliation.requirements.phase` set to `prepared_switch`.
That lease has no probes and carries the previously committed
`reconciliation.result.route_manifest_json`, digest, generation and drain
deadline. Control re-hashes the stored exact bytes and verifies their parsed
project, release and generation before issuing the lease. The worker skips
stage, probes and completion, repeats only the atomic gateway switch, and then
activates with a new exact switch receipt.

The route manifest schema is `hostlet.route-manifest/v1` and pins project,
release, deployment, exact source commit, generation, frontend archive/manifest, an opaque
`runtime-allocation:{id}:{generation}:{fence}` backend reference, database and
migration references, configuration, secret versions, the exact staged health
observation and receipt digest, previous release,
retained frontend assets and drain deadline. The gateway resolves the opaque
backend reference through runtime-owned relay state; the control API never
accepts a caller-supplied backend address.

## Failure rules

Expired running leases become retriable and receive a higher fence. Stale
completion, stale route generation, cross-owner identifiers, changed
idempotency payloads, missing or mismatched CAS bytes, expired runtime evidence,
invalid secrets, incomplete compatibility matrices, unhealthy candidates and
ineligible rollback targets cannot change the route. A failed promotion marks
only its staged candidate failed. A failed rollback leaves both target history
and the current route unchanged.
