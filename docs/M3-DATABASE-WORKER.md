# M3 tenant database worker

`hostlet-database` is the separately authenticated HOST-223 database manager.
It consumes generation-fenced operations from the control API and is enabled
only in `HOSTLET_M3_MODE=owned_fixture`. It never connects to platform
PostgreSQL and never accepts SQL, a Docker name, a container ID, a host path, or
a PostgreSQL address from an owner request.

## Process configuration

Run the worker with:

```text
hostlet-database worker --control-url http://127.0.0.1:PORT --worker-id m3-database-1
```

`--kind KIND` may be repeated to restrict the operation kinds advertised when
leasing work. Unknown or duplicate kinds are rejected; omitting it admits all
supported database operation kinds. A returned lease outside the selected set
is rejected. This lets separate workers handle isolated trials and live applies
without racing to consume each other's work.

`--once` performs one scheduler tick and at most one operation. The worker
exits successfully when no operation is available. `--scheduler-once` performs
only one scheduler tick. The long-running form polls after every idempotent
tick. These modes let the E2E runner create an exact owned target after durable
intent exists and before the operation is leased.

Required environment:

- `HOSTLET_M3_MODE=owned_fixture`
- `HOSTLET_M3_STATE_DIR`, an absolute canonical directory with mode `0700`
- `HOSTLET_M3_DATABASE_TOKEN`, distinct from every other M3 worker token
- `HOSTLET_TENANT_RECOVERY_KEY`, a base64-encoded 32-byte key distinct from the
  platform recovery and credential keys
- `HOSTLET_TENANT_RECOVERY_KEY_ID`, a safe keyring identifier
- `HOSTLET_M3_FIXTURE_BOOTSTRAP_SHA256`, the lowercase SHA-256 identity of the
  exact owned v1 seed script used only while draining provision operations

The worker reads `database-inventory.json` from the state directory and writes
encrypted objects below `tenant-backups/`. It creates no configurable host
path. Temporary dumps and decrypted restore archives are mode `0600`, bounded
in memory during hashing/encryption, truncated after use, and removed. The
fixture must place the recovery repository outside the tenant data-volume
failure domain. On startup the worker truncates and removes only exact
UUID-named plaintext dump/restore temporary files left by an interrupted worker;
it does not treat unknown or partial encrypted objects as deletion candidates.

For an owned provision, the fixture runner installs the public seed script as
`database-fixtures/sha256/<first-two>/<remaining-62>.sql` beneath the same
private state root. The worker derives this location only from the required
digest, requires private canonical directories and a regular mode `0600` file,
re-hashes it, and admits only the exact bounded v1 fixture statements. It runs
the script over TCP with the resolved migration credential under a transaction
lock and durable effect stamp. Provision completion proves the script digest,
four exact populated fixture rows, and a runtime-credential readback. This is
M3 E2E setup and is not a customer migration interface.

## Owned target inventory

The inventory is a canonical regular file with mode `0600`. Replace it
atomically; the worker reloads and validates it for every operation. See
`scripts/database/database-inventory.example.json` for schema version 1.

A primary entry has `recovery_id: null` and `restore_target: false`. A recovery
or migration trial entry has its exact recovery/migration UUID and
`restore_target: true`. Container IDs are full 64-character lowercase IDs.
Addresses must be RFC 1918 IPv4 and unique-local IPv6 endpoint descriptors for the independently controlled
gateway; the database worker does not attach networking.

Before every command the worker runs `docker inspect` on the full ID and
requires a running container, `HostConfig.NetworkMode=none`, PostgreSQL 18, and
these exact labels:

```text
io.hostlet.scope=m3-e2e
io.hostlet.run-id=<inventory run UUID>
io.hostlet.resource=tenant-postgres
io.hostlet.database-id=<tenant database UUID>
io.hostlet.database-generation=<database generation UUID>
io.hostlet.restore-target=false|true
```

The fixture PostgreSQL image must retain the standard `postgres` operating
system user and bootstrap database role for management commands. The bootstrap
identity is the process-scoped management identity. It is never stored in the
platform database, resolved through the control API, or injected into a build
or runtime.

## Provisioning and roles

PostgreSQL databases and login roles are derived only from control-created
UUIDs. The worker creates runtime, migration, and backup roles from the exact
credential versions declared by the fenced operation. It revokes PUBLIC
database/schema access, sets the runtime connection limit to 10, creates the
private `hostlet_control` identity schema, installs default privileges, and
connects as each role before reporting ready. It also observes the runtime
connection cap and proves runtime DDL and `hostlet_control` access fail.

The application schema is `app`. The runtime role receives DML and sequence
rights. The migration role owns application objects but has no cluster role or
database creation privilege. The backup role receives read-only application
table access. The worker-injected bootstrap remains the management identity.

The 1 GiB storage boundary is enforced by hourly policy-clock observations.
PostgreSQL does not provide a per-database byte quota, so growth can exceed the
boundary between an application write and the next scheduled, leased
observation. The maximum detection window is the scheduler interval plus queue
and operation execution delay; this is not an instantaneous hard quota and
customer admission remains disabled for M3.

Provisioning installs a private durable storage-policy row. When an exact
fenced observation measures more than 1 GiB, the worker atomically changes the
policy to sticky `read_only_over_limit`, revokes runtime table DML and sequence
advancement (including matching migration-role default privileges), disables
the migration login, and terminates existing runtime and migration sessions.
It does not automatically re-enable growth if a later measurement falls below
the limit. The worker then reconnects with the runtime credential to prove an
application-table read succeeds and a write fails, and runs a schema-only
portable `pg_dump` with the backup credential to prove export access remains.
The control receipt records the real measured bytes, fixed limit, policy time,
durable growth mode, and those three validation outcomes. A later full export
still uses the normal authenticated export operation.

`scripts/database/fixture-bootstrap.sql` is the owned populated HOST-223
fixture: two related tables, an identity sequence, and rows. It must be applied
through the resolved migration role, never through a build guest.

## Backups, exports, expiry, and recovery

Backup and export operations invoke PostgreSQL 18 `pg_dump` as the backup role
with custom format, `--no-owner`, `--no-privileges`, and exclusion of
`hostlet_control`. Archive listings containing ACL entries are rejected.

`hostlet.tenant-backup/v1` is separate from and does not change
`hostlet.platform-backup/v1`. Its JSON manifest is followed by fixed-size
XChaCha20-Poly1305 chunks. Each chunk binds the complete manifest, chunk index,
and finality in AAD. A random 16-byte nonce prefix and 64-bit chunk index make
each nonce unique. The envelope records plaintext/encrypted hashes and byte
counts. Publication uses a private staging file, `fsync`, no-overwrite hard
link, directory `fsync`, complete read-back authentication, and exact receipt
completion.

The object reference is derived as
`<repository_namespace>/<archive_uuid>.htb`. The namespace is one
control-generated lowercase component. An expiry operation must supply that
exact reference, generation, and encrypted digest. The worker authenticates
the complete envelope before deleting it and refuses symlinks, incomplete
objects, unknown namespaces, changed digests, the exact seven-day endpoint,
and any future/non-expired operation.

A drill authenticates every chunk before creating the target database. The
replacement must be a distinct exact labeled container and the derived target
database must not exist. The worker creates fresh replacement roles, restores
with `pg_restore --no-owner --no-privileges`, reapplies grants, checks populated
relations and foreign keys, verifies runtime read/write through a real TCP
login, and verifies forbidden runtime DDL/private-schema access. There is no
cutover or source replacement path.

Archive snapshot times use the shared policy clock. Readback during publication
requires the exact assigned snapshot, while restore, migration, and expiry
require the authenticated snapshot to be no later than that operation's policy
time. The worker does not compare lifecycle timestamps with wall time. HTTP
authentication, leases, process timeouts, and elapsed recovery duration remain
bound to the real clock.

Daily buckets, strict-before seven-day expiry, and the four-week rotating drill
budget are selected by the control scheduler from the shared M3 policy clock.
The worker fetches that clock and calls the running scheduler. HTTP auth, lease
expiry, Docker/PostgreSQL command timeouts, and elapsed recovery measurement
use real time. A one-second heartbeat renews the exact operation/attempt/fence;
the worker refuses completion when renewal fails.

## Migration-trial boundary

The release coordinator extracts the declared migration from the exact
build-job/application HCA and atomically installs it at the digest-derived
private reference
`migration-artifacts/sha256/<first-two>/<remaining-62>.sql`. The operation
contains the build, artifact, service, application archive, artifact manifest,
entry, file, and staging-receipt identities. The worker accepts only that exact
relative reference beneath the canonical M3 state root, rejects symlinks and
group/world permissions, caps SQL at 1 MiB, re-hashes the bytes, rejects psql
meta-commands and transaction-control input, and never accepts raw SQL or a
caller-selected filesystem path. `scripts/database/fixture-migration-v2.sql`
is documentation/fixture input; the worker does not compile it in.

The owned artifact entries are
`dist/migrations/002_additive_client_compatibility.sql` and the negative fixture
`dist/migrations/003_destructive.sql`. SQL admission still permits only the
documented additive statements. The destructive fixture reaches the real worker
and fails with `migration_sql_not_admitted` before executing SQL. A terminal
trial failure marks its migration and waiting release failed, preserving the
active route and preventing live application of that migration.

The database worker authenticates the fresh pre-migration archive, restores a
populated isolated replacement, and applies those exact bytes with the scoped
migration login using `psql --single-transaction`. The same transaction writes
a migration-ID/file-digest/schema-revision stamp in the application schema.
Only then does it report `migration_trial_prepared`. It does not claim binary
compatibility. The release worker runs candidate, current, retained, and
cross-version probes in gVisor against that migrated clone, and control alone
can mark the trial `isolated_validated`.

After that gate, control queues `migration_live_apply` with only the current
migration credential, the same artifact tuple and digest, expected source-data
generation, schema revisions, and the isolated apply receipt. The database
worker re-resolves and re-hashes the artifact, requires the exact labeled live
primary and writable storage policy, and applies through the migration login.
The durable stamp makes an interrupted retry return the same apply receipt;
the worker never restores or recreates the primary. Fenced completion records
the once effect and advances control's source-data generation by one. Route
promotion remains blocked until the live database and application probes pass.

## Safe output and cleanup

Worker logs contain operation, attempt, fence, effect IDs, operation kind, and
policy counts. They contain no password, PostgreSQL URL, archive plaintext,
recovery key, or SQL error. Completion payloads contain safe hashes, sizes,
times, Boolean validation outcomes, and opaque refs. Failed provisioning is
reported with `resources_retained: true`, preserving the reservation whenever
a durable tenant resource might exist. The worker never removes a container,
primary database, live role, or source archive as cleanup.
