# M3 tenant PostgreSQL contract

HOST-223 adds one PostgreSQL database to an admitted project service. PostgreSQL is the durable source of control intent. A separately enrolled database worker performs SQL and archive I/O with its own management identity. Owners, application runtimes, build workers, and release workers never receive that identity.

## Durable boundary

The additive schema is defined by `tenant_databases`, `tenant_database_credentials`, `tenant_database_archives`, `tenant_database_recoveries`, `tenant_database_operations`, `tenant_database_operation_attempts`, and `tenant_database_migrations`. Every child row carries the owner, project, tenant database, and immutable database generation. Foreign keys and unique indexes prevent a receipt, credential, archive, recovery, or migration from crossing that boundary.

The database generation is a UUID fence. Worker operations also use a monotonically increasing attempt fence. A completion is accepted only while its operation, attempt ID, worker ID, fence, and real-time lease are current. Duplicate byte-identical completion returns the prior effect; stale or changed completion fails closed.

Policy scheduling uses the shared injected M3 policy clock. Lease expiry, authentication, and resource lifetime use PostgreSQL `clock_timestamp()` or monotonic process time. Daily backups are unique by database generation and policy date. Storage enforcement is unique by database generation and UTC policy hour. Its detection bound is the scheduler cadence plus lease and execution delay. Weekly drills are unique by database generation and Monday policy week. Usable archives expire after seven policy days; owner exports expire after 24 policy hours.

## Owner API

All routes require normal owner authentication and `m3::require_enabled`. Mutations require the existing idempotency and expected-revision headers.

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /v1/projects/{project}/deployments/{deployment}/tenant-databases` | `{configuration_revision_id,service_id,reservation_id,reservation_epoch}` | Records the exact admitted PostgreSQL service and queues provisioning. |
| `GET /v1/projects/{project}/services/{service}/tenant-database` | none | Safe database state, limits, backup/drill times, and revision. |
| `GET .../tenant-database/backups` | none | Safe archive metadata; no object path, ciphertext hash, key ID, or credential. |
| `POST .../tenant-database/exports` | `{}` | Queues a portable encrypted role-free archive. |
| `GET .../tenant-database/exports/{archive}` | none | Export status and safe manifest metadata. M3 does not expose repository objects through a public download route. |
| `POST .../tenant-database/recovery-drills` | `{archive_id}` | Queues an isolated restore of an owned usable non-export archive. |
| `GET .../tenant-database/recovery-drills/{recovery}` | none | Safe recovery status and validation time. |

Provisioning accepts no database name, role name, SQL, network target, repository path, or grants. Control derives a PostgreSQL 18 database, ten-connection application limit, 1 GiB storage limit, placement, network policies, three role refs, and grant plan `hostlet.tenant-grants/v1` from the admitted configuration and reservation.

## Database worker API

These routes require `m3::DatabaseWorkerAuth`, backed by the database service token only.

| Method and path | Request |
| --- | --- |
| `POST /internal/v1/tenant-database-scheduler/tick` | `{}` |
| `POST /internal/v1/tenant-database-operations/lease` | `{worker_id,kinds:[...]}` |
| `POST /internal/v1/tenant-database-operations/{operation}/renew` | `{worker_id,attempt_id,fence}` |
| `POST /internal/v1/tenant-database-operations/{operation}/credentials:resolve` | `{worker_id,attempt_id,fence,credential_ids:[...]}` |
| `POST /internal/v1/tenant-database-operations/{operation}/complete` | `{worker_id,attempt_id,fence,outcome:{state,code,proof}}` |

Supported lease kinds are `provision`, `backup_daily`, `backup_pre_migration`, `export`, `restore_drill`, `observe_storage`, `migration_trial`, `migration_live_apply`, and `archive_expire`. Credential resolution accepts only the exact IDs declared by the live lease and returns `{id,purpose,role_ref,value}`. `role_ref` is a UUID string. The canonical secret value is JSON `{database_ref,role_ref,password}`; both refs are UUID strings. The worker derives SQL identifiers and never accepts them from the operation: primary database `hdb_<database UUID simple>`, application role `ha_<runtime role UUID simple>`, and isolated replacement `hdr_<recovery or migration UUID simple>`. The worker's injected management login is not stored in control.

Credentials use the existing platform secret key with AAD:

```
hostlet-tenant-database-credential/v1\0{account}\0{project}\0{database}\0{generation}\0{purpose}\0{credential}
```

Purposes are exactly `runtime`, `migration`, and `backup`. Build workers receive none. Runtime control calls the private `resolve_runtime_credential` helper only after it has independently bound a live allocation, deployment, project, reservation, database generation, and allocation fence. The helper returns the ref IDs, derived `database_name` and `role_name`, and a zeroized canonical secret value.

## Operation receipts

Provision success proves the expected database ref and raw SHA-256 of the compiled grant plan, plus successful application connection, cross-tenant denial, system-schema denial, and revoked public access.

Archive success records the exact object ref, format, recovery key ID, plaintext and encrypted raw SHA-256 values, positive byte counts, snapshot time, and this manifest:

```json
{
  "format": "hostlet.tenant-backup/v1",
  "archive_id": "uuid",
  "tenant_database_id": "uuid",
  "database_generation": "uuid",
  "source_data_generation": 1,
  "postgres_server_major": 18,
  "pg_dump_major": 18,
  "no_owner": true,
  "no_privileges": true,
  "cluster_roles_included": false
}
```

Restore success proves the recovery ID, isolated replacement UUID/ref, restore time and duration, equal rows and relationships, recreated grants, a working application connection, and an unchanged source. Archive expiry is its own fenced operation and proves the exact archive ID and encrypted hash were authenticated and deleted.

Storage enforcement receives exactly `{storage_limit_bytes,role_refs:{runtime,migration,backup}}` and all three active credential IDs. The 1 GiB limit and UUID role refs are control-owned. Success proves exactly `{storage_bytes,storage_limit_bytes,observed_at,growth_mode,write_denied,reads_preserved,export_preserved}`. `observed_at` equals the operation policy time. At or below the limit, a previously writable database remains `writable`, writes remain enabled, and reads and export work. Above the limit, the worker revokes runtime DML, sequence advancement, and unsafe default grants, changes the migration role to `NOLOGIN`, terminates runtime and migration sessions, and verifies `read_only_over_limit`, denied writes, preserved runtime reads, and preserved backup export over TCP. Control persists `growth_mode`, `measured_storage_bytes`, and `storage_observed_at`. The transition to `read_only_over_limit` is sticky; later measurements never automatically restore writes.

Repository namespace is the single safe component `tenant_<database UUID simple>`. Control supplies the exact archive UUID, namespace, object ref where applicable, and encrypted hash. The worker derives the object filename from the archive UUID. The separately injected backup encryption key never enters control storage or responses.

## Populated migration gate

Migration admission is phased so the database worker cannot claim application compatibility:

1. `request_pre_migration_backup` records a verified backup of the current source-data generation, bound to the migration revision.
2. Owner preparation records state `planned`, the migration digest, planned current and one or two retained binary digests, and the server-validated application HCA identity `{build_job_id,artifact_id,service_id,application_archive_digest,manifest_digest,migration_entry_path,file_digest}`. The only admitted entry is the owned-fixture path `dist/migrations/002_additive_client_compatibility.sql`, and `file_digest` equals the migration digest.
3. A live fenced release worker verifies the HCA and manifest, extracts only that entry, rehashes it, writes it mode 0600 below the M3 state directory at `migration-artifacts/sha256/<first2>/<remaining62>.sql`, and stores a digest-addressed stage receipt. `enqueue_materialized_migration_trial` independently binds that receipt, HCA tuple, release attempt, and path before queuing the database operation with all three role envelopes.
4. The database worker authenticates the pre-migration archive, restores the populated isolated clone, revalidates the artifact bytes and bounded SQL, and applies them through the least-privilege migration TCP role in one transaction. It records a durable schema effect stamp, validates the clone, and completes `migration_trial_prepared` with exact artifact, schema, and apply-receipt evidence.
5. The release worker runs the real candidate, current, and retained artifacts in gVisor against the migrated clone. Control independently checks the staged release, reconciliation ID, attempt ID, fence, real-time lease, database generation, isolated apply receipt, migration digest, current route, retained release set, allocation generations/fences, one receipt per expected binary, and every ordered cross-version frontend/API pairing.
6. Successful isolated validation atomically changes the migration to `isolated_validated` and queues `migration_live_apply` with only the migration credential and the same artifact tuple. The database worker revalidates the bytes and durable isolated stamp, applies the same SQL to the live database once, and completes with code `migration_live_applied`. Only this fenced database completion records the once-effect ID, changes the migration to `applied`, and advances the source-data generation.
7. A resumed release reconciliation requires the applied gate and real post-live candidate/current/retained and cross-version probes before changing the route. Release metadata cannot mark a migration applied.

The release receipt DTO is `MigrationRuntimeValidation {release_id,reconciliation_id,attempt_id,release_fence,migration_id,migration_apply_receipt_digest,probe_receipts,cross_version_receipts,validated_at}`. Each probe binds `{application_release_id,artifact_digest,runtime_allocation_id,runtime_generation,runtime_fence,database_generation,migration_id,migration_digest,probe_kind,probe_receipt_digest,observed_at}`; `probe_kind` is `candidate`, `current`, or `retained`. Cross-version receipts bind `{frontend_release_id,api_release_id,receipt_digest}`.

The isolated database receipt is exactly `{migration_id,archive_id,replacement_identity,replacement_ref,prepared_at,endpoint_descriptor_hash,migration_file_digest,schema_revision,migration_apply_receipt_digest,applied_at}`. The live operation spec is exactly `{migration_id,migration_revision,migration_digest,artifact,expected_source_data_generation,current_schema_revision,candidate_schema_revision,isolated_apply_receipt_digest}`, declares only the migration credential, and accepts code `migration_live_applied` with proof `{migration_id,migration_file_digest,migration_apply_receipt_digest,schema_revision,source_data_generation_before,source_data_generation_after,application_mode,applied_at}`. `application_mode` is `applied` or `already_applied`; the latter is accepted only for crash recovery around the same durable database stamp and operation fence.

Reset, recreate, or restore is never treated as an upgrade. A live migration gate always requires the verified pre-migration backup, the populated isolated migration, a real current-binary probe, all retained-binary probes, cross-version probes, and the durable once effect.

## Acceptance failures

M3 E2E must exercise: absent M3 configuration; wrong worker scope; owner crossing; stale owner revision; unadmitted or mismatched service/configuration/reservation; duplicate and changed idempotency; stale generation; lease expiry, theft, replay, retry exhaustion, and changed completion; undeclared credential resolution; credential ciphertext/AAD/key-version failure and response redaction; arbitrary identifier/path/SQL rejection; grant drift; public/system/cross-tenant privilege leakage; archive corruption, manifest mismatch, wrong generation/hash/key, partial upload, retention deletion replay, and missing backup key; missed/catch-up daily scheduling; weekly drill rotation and isolated cleanup; source mutation; hourly storage observation, over-limit write denial, read/export preservation, session termination, default-grant denial, and sticky no-auto-unfreeze behavior; export expiry; pre-migration backup staleness; prepared-trial proof mismatch; digest or release-set drift; stale release attempt/fence; missing, duplicate, or unexpected runtime probes; missing cross-version pair; migration double effect; rollback using retained binaries; and upgrade of populated schema-5 data without reset while the retained M2 binary still reads and writes.
