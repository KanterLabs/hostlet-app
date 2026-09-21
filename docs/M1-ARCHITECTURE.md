# M1 foundation architecture contract

This document is the integration contract for the M1 foundation cards
`HOST-215` through `HOST-218`. It refines the product boundaries in
[`PLAN.md`](../PLAN.md), the milestone acceptance policy in
[`TESTING.md`](../TESTING.md), and the running-system scenarios in
[`M1-SCENARIOS.md`](M1-SCENARIOS.md). The scenarios remain the acceptance
oracle. This document defines the interfaces that implementations use to
satisfy them.

M1 establishes a durable authenticated control foundation for owned synthetic
data. It does not admit customers, reserve real capacity, execute customer
source, provision tenant databases, publish a portfolio, charge money, or
operate a build or runtime substrate. Those capabilities remain in later
milestones.

## Fixed implementation choices

- Rust/Axum remains the control API stack. SQLx 0.8.6 connects to PostgreSQL.
- Local passwords use Argon2id from `argon2` 0.5.3 and are stored only as PHC
  strings with per-password salts.
- Identities and owned resources use UUIDs. API clients must treat UUIDs as
  opaque values.
- M1 sessions are Bearer-only. A login returns a random 256-bit opaque token
  once; PostgreSQL stores only its SHA-256 hash. Sessions expire after 24 hours.
  Cookies and the resulting CSRF surface belong to a later browser-auth feature.
- Passwords are 12 through 256 bytes after UTF-8 decoding. Passwords are not
  trimmed or otherwise silently changed.
- JSON request bodies are limited to 128 KiB before deserialization. JSON
  objects reject unknown fields unless a versioned contract explicitly permits
  extension data.
- Durable intent mutations use bounded idempotency keys. M1 retains their
  records permanently; later retention work may introduce expiry without
  changing replay semantics.
- The default worker lease is 30 seconds. E2E may override it with an explicit
  duration of at least 2 seconds. Lease validity uses PostgreSQL time.
- Secret values use XChaCha20-Poly1305 through the stable 0.10 API. Platform
  backups use a separately injected recovery key and a distinct authenticated
  context. Neither key class is stored in PostgreSQL or an E2E artifact.
- PostgreSQL 18 is the M1 database boundary. Backup and recovery use matching
  PostgreSQL 18 `pg_dump` and `pg_restore` tools, either from the host or an
  explicitly named, run-owned PostgreSQL container.

## Process and trust boundaries

The control binary serves two listeners with separate routers:

1. The public control listener exposes liveness, readiness, version,
   authentication, and owner-scoped resource APIs.
2. The internal worker listener binds only to a loopback address. Startup
   rejects a non-loopback internal bind. It requires a service-scoped opaque
   Bearer token supplied outside PostgreSQL, source control, command-line
   arguments, logs, and artifacts.

The API compares only a hash of the internal token in constant time after
configuration has been loaded. The builder may gain an explicit M1 foundation
worker mode that talks to the internal listener and performs platform-owned
bookkeeping. Its existing default refusal, `--version`, and `--check-config`
behavior remain valid. The runtime continues to refuse work. No M1 mode may
spawn a customer command or claim that a build or runtime completed.

Database URLs, Bearer tokens, encryption keys, and recovery keys must be passed
through protected environment or file descriptors/files. Commands must never
interpolate URL credentials or tokens into `argv`, where process listings and
artifact capture could expose them.

Configuration and wrapper types containing `DATABASE_URL`, passwords, session
or worker tokens, secret-key bytes, or recovery-key bytes must not derive or
implement value-revealing `Debug` or `Display`. They may expose only an explicit
redacted representation. At the HTTP, process-log, and artifact boundaries,
SQLx errors and configuration failures are translated to stable safe codes;
raw database errors, connection strings, and secret-bearing error chains are
never returned or retained.

## Compatibility and readiness

The following scaffold interfaces stay compatible:

- `GET /healthz` reports whether the API process can serve HTTP. It does not
  inspect PostgreSQL.
- `GET /v1/version` preserves the existing response fixture and
  `hostlet.agent/v1` protocol identifier.
- The existing no-state `router()` may remain for legacy scaffold checks and
  continues to report `GET /readyz` as unavailable.
- A stateful application router owns PostgreSQL, keyring, and worker-auth state.

The stateful `GET /readyz` returns HTTP 200 only when all of these are true:

- PostgreSQL is reachable within a bounded timeout;
- every migration embedded in the binary is applied with its expected checksum;
- there is no pending migration known to the binary;
- `platform_schema_compatibility` permits this binary to read the current
  additive schema;
- the configured secret-key version is available; and
- internal worker authentication is configured.

A dependency failure returns HTTP 503 with a stable reason code. The response
does not include connection details, SQL errors, paths, or key identifiers that
are not safe to disclose. A representative success body is:

```json
{
  "status": "ready",
  "scope": "control_foundation",
  "customer_admission": false,
  "workload_execution": false,
  "dependencies": {
    "postgres": "ready",
    "schema": "ready",
    "secret_keyring": "ready",
    "worker_auth": "ready"
  }
}
```

Readiness at M1 means that the authenticated local control foundation can
durably accept its M1 intents. It is not deployment, customer, provider, or
launch readiness. If PostgreSQL becomes unavailable, readiness fails and no
write may report success from memory or an asynchronous buffer.

## Public HTTP interface

All JSON errors use one versioned shape containing a stable `code`, a safe
`message`, and a `request_id`. An error may include safe conflict data such as
the current resource revision. It never includes SQL text, an internal URL, a
password, a session token, a secret value, ciphertext, or a worker credential.

### Authentication

| Method and route | Contract |
| --- | --- |
| `POST /v1/accounts` | Create an account and local password identity atomically. Normalized email is unique; a duplicate returns a conflict. Return the account UUID, never a password hash or session token. |
| `POST /v1/sessions` | Verify local credentials and return a new opaque Bearer token once with its 24-hour expiry. This response is never stored in an idempotency record. |
| `DELETE /v1/sessions/current` | Revoke the presented session and return 204. |
| `GET /v1/me` | Return the authenticated account and session expiry metadata. |

Authentication uses `Authorization: Bearer <token>`. Missing, malformed,
expired, revoked, or unknown tokens are uniformly rejected. Authentication
logs and audit events record account, identity, and session UUIDs where known,
not the presented token or password. Login failure responses do not distinguish
an unknown identity from a wrong password.

Credential-bearing authentication requests do not use the resource-intent
idempotency cache. In particular, never retain an unsalted fast hash of a
password-bearing request as a replay fingerprint.

### Owned resources

The initial resource surface is deliberately small:

| Resource | Routes |
| --- | --- |
| Projects | `POST /v1/projects`, `GET /v1/projects/{project_id}`, `PATCH /v1/projects/{project_id}` |
| Configuration revisions | `POST /v1/projects/{project_id}/configuration-revisions`, `GET /v1/projects/{project_id}/configuration-revisions/{revision_id}` |
| Services | `POST /v1/projects/{project_id}/services`, `GET /v1/projects/{project_id}/services`, `GET /v1/projects/{project_id}/services/{service_id}` |
| Deployment intent and snapshots | `POST /v1/projects/{project_id}/deployment-intents`, `GET /v1/projects/{project_id}/deployments/{deployment_id}` |
| Portfolio drafts | `POST /v1/portfolio-draft-revisions`, `GET /v1/portfolio-draft-revisions/{revision_id}` |
| Secret metadata and versions | `POST /v1/projects/{project_id}/services/{service_id}/secrets`, `POST /v1/projects/{project_id}/services/{service_id}/secrets/{secret_id}/versions`, and metadata-only `GET` routes |
| Durable jobs | `POST /v1/projects/{project_id}/jobs`, `GET /v1/projects/{project_id}/jobs/{job_id}` |

Every resource query includes the authenticated account UUID. Path IDs, body
IDs, and referenced parent IDs never establish ownership. A resource owned by
another account returns the same not-found response as an unknown UUID. Cross-
owner references also fail at the database boundary through composite owner
foreign keys.

All accepted durable resource-intent writes commit their authoritative rows, audit
event, and idempotency result in one transaction before returning success.
Create operations require an `Idempotency-Key`; update operations additionally
require an `If-Match` revision. A stale revision fails without mutation. The
service serializes state transitions with row locks and uses constraints rather
than read-then-write assumptions for uniqueness.

An idempotency record is scoped to the actor, operation, and bounded key and
contains a canonical request hash plus a sanitized response. Concurrent use of
the same key and payload produces one effect and the same stable result. Reuse
with a different payload returns an explicit conflict. Idempotency records must
not contain session tokens, secret values, or internal credentials.
Secret-bearing resource writes use a keyed request fingerprint, bound to a
recorded key version; never expose an unsalted fast hash of a secret value.

Project, service, and deployment payloads use the versioned contracts from
`HOST-209`. A deployment snapshot may contain source commit, configuration
revision, artifact references, health result, database migration revision, and
secret-version references. It must not contain a secret value. Portfolio draft
routes persist the versioned `HOST-210` draft contract only; M1 has no approval,
publication, or public-serving action.

The hosting lifecycle distinguishes `showcase_only`, `admission_required`,
`reserved`, `hosted`, `failed_no_resources`, `failed_resources_retained`,
`rollback_requested`, `removal_pending`, and `removed`. M1 may create
`admission_required` intent and store typed transition records, but it cannot
claim real entitlement/capacity reservation or hosted resources. Only M2 may
produce a real capacity-backed reservation, and only M3 may produce runtime or
tenant-database effects. Drafts, compatibility checks, portfolio revisions,
and external case studies always have no slot disposition.

## PostgreSQL ownership model

The schema keeps authorization and lifecycle facts relational even when a
versioned content snapshot is JSONB. Queries use explicit column lists so an
additive column cannot change an older reader's row shape.

| Area | Required records and constraints |
| --- | --- |
| Database control | `database_identity` holds one immutable UUID. `platform_schema_compatibility` holds current and minimum-reader schema versions. SQLx owns its migration ledger. |
| Identity | `accounts`, `password_identities`, and `sessions`; normalized local identity uniqueness, one-way password/token hashes, expiry and revocation timestamps. |
| Audit and replay | `audit_events` and `idempotency_records`; actor/target UUIDs, safe event metadata, canonical request hash, and sanitized stable result. |
| Project graph | `projects`, `configuration_revisions`, `services`, `deployments`, `deployment_artifact_refs`, and `hosting_state_events`. |
| Portfolio foundation | `portfolio_draft_revisions`, containing typed owned draft snapshots and immutable revision metadata, not a published artifact. |
| Credentials | `secrets`, append-only `secret_versions`, and `job_secret_refs`. Metadata is separate from ciphertext. |
| Work | `jobs`, immutable `job_attempts`, and `job_effects`. A committed effect is unique per durable job. |

Owned child tables carry `account_id` and use composite foreign keys through
their project and service parents. The database enforces at most one static
frontend, one application service, and one PostgreSQL service per standard
project. It also enforces state values, nonnegative revisions, and parent/reference
consistency. Application authorization still scopes every query; constraints
are the second boundary, not a replacement for API checks.

## Secret storage and resolution

A secret definition is scoped to one account, project, service, operation, and
credential kind. Each change creates an immutable version. The version stores a
key version, a random 24-byte nonce, ciphertext and authentication tag. Its
XChaCha20-Poly1305 additional authenticated data is a canonical versioned
encoding of:

```text
hostlet-secret/v1 | account UUID | project UUID | service UUID |
operation | credential kind | secret UUID | version UUID
```

Moving ciphertext between any of those scopes therefore fails authentication.
Only key identifiers appear in PostgreSQL; key bytes are injected separately.
Secret-holding Rust values must not implement a value-revealing `Debug`, and
request tracing must never capture secret bodies.

A job binds an exact source commit and exact `job_secret_refs` at enqueue time.
Build-scoped resolution rejects undeclared versions, a different account,
project, service or operation, and credential kinds for production databases
or platform management. Metadata APIs return references, names, versions,
operation and status only. There is no general decrypt or export endpoint.

## Job leases and the internal worker API

The loopback-only internal listener exposes:

| Method and route | Contract |
| --- | --- |
| `POST /internal/v1/jobs/lease` | Atomically claim one eligible job kind, increment its fence, and create an immutable attempt. |
| `POST /internal/v1/jobs/{job_id}/renew` | Extend the lease only for the current attempt and fence. |
| `POST /internal/v1/jobs/{job_id}/credentials:resolve` | Resolve only the versions bound to this live job, operation, attempt and fence. |
| `POST /internal/v1/jobs/{job_id}/complete` | Atomically commit one sanitized outcome/effect and finish the current attempt. |

Persisted job states are `queued`, `running`, `succeeded`, `failed`, `canceled`,
and `retriable`. Attempts retain their worker identity, attempt number, fence,
lease interval, terminal reason, and timestamps. Claiming locks an eligible row,
uses skip-locked behavior for competing workers, increments a monotonic fence,
and inserts the attempt in the same transaction.

Renewal, secret resolution, and completion require all of: the current attempt,
the exact fence, `running` job state, and an unexpired database-clock lease.
Cancellation advances the fence. Lease recovery marks the old attempt expired,
makes the same durable intent retriable, and gives its replacement a higher
fence. Completion and `job_effects` commit in one transaction. A retry after a
lost response returns the already committed sanitized result; it does not
create another effect. A stale worker always receives a fenced conflict and
cannot renew, decrypt credentials, or complete.

The M1 real-worker E2E kills a foundation worker after it obtains a lease, waits
for the explicitly shortened lease to expire, and starts a replacement. This is
a real process and database lease failure, while the job itself remains
platform bookkeeping and executes no customer workload.

## Migrations and retained-binary compatibility

Migration files are numbered, additive, immutable after use, and serialized by
a PostgreSQL advisory lock:

| Version | Foundation |
| --- | --- |
| `0001` | Database identity, schema compatibility, accounts, password identities, sessions, audit, and idempotency. |
| `0002` | Project/configuration/service/deployment graph, hosting events, and portfolio draft revisions. |
| `0003` | Jobs, immutable attempts/effects, encrypted secret versions, and job secret references. |
| `0004` | HOST-218 additive recovery metadata with only optional columns or new tables; minimum reader version remains 3. |

Startup never applies migrations. An explicit control CLI performs migration
checks and changes. Before HOST-218 is present, the CLI may initialize an
explicitly selected empty database through all embedded migrations, but it
fails closed on a nonempty upgrade. It never resets or recreates a database.
Once HOST-218 is wired, every nonempty upgrade requires a fresh verified
encrypted backup receipt for the same immutable `database_identity`, current
schema, database target, and intended migration.

The v3 binary must be built and retained with its digest before `0004` is
introduced. Migration `0004` sets current schema version 4 and minimum reader
version 3. A binary requires all migrations and checksums that it knows. It may
tolerate a later additive current version only when the explicit compatibility
row says that binary's reader version is sufficient. This permits the actual v3
binary and the v4 binary to read the upgraded populated database. A binary
rollback does not roll back the schema or discard later writes.

The migration CLI rejects a missing number, an unexpected order, a changed
checksum, an incompatible minimum reader, or concurrent mutation outside its
lock. Queries and decoded models must continue to work when optional v4 fields
are absent or present.

## Platform backup and recovery

The backup path runs real PostgreSQL 18 dump tools against the explicitly
selected database. When a Docker tool is used, the E2E harness names the
run-owned container explicitly; it never discovers a broad or shared target.
The dump is encrypted using the separately injected platform recovery key and
backup-specific XChaCha20-Poly1305 authenticated context. Secret-encryption keys
and backup-recovery keys are not interchangeable.

The versioned encrypted-backup header and receipt record only safe metadata:

- backup UUID and immutable database identity UUID;
- schema version, source revision, database target fingerprint, and creation
  time;
- plaintext dump digest, encrypted payload digest, format version, and recovery
  key identifier; and
- intended migration where the receipt gates an upgrade.

For a framed backup, every frame uses a unique nonce and authenticates the
versioned header, database identity, backup UUID, and frame index. The recovery
key itself is absent from the header, receipt, database, logs, and artifacts.
Verification authenticates the complete encrypted stream and checks the receipt
target and freshness before the migration lock permits an upgrade.

Restore always targets a separately named empty recovery database. The restore
command refuses an occupied database, a live source target, a mismatched
identity or receipt, or a corrupt payload. It never automatically replaces,
resets, or cuts over the source database. After `pg_restore`, verification
checks migrations, ownership relationships, counts, encrypted-secret metadata,
audit links, and real API reads against the recovered database.

The scheduler produces actual dumps. Its explicit E2E clock may accelerate
schedule decisions, but evidence labels accelerated time and records real dump
and restore durations. Retention keeps every hourly backup in the most recent
48-hour window and one daily recovery point for each of the preceding seven
daily windows, with boundaries and deduplication deterministic in UTC. Cleanup
acts only on backup IDs and paths owned by that run. Evidence reports observed
data age and recovery duration against the one-hour loss and four-hour recovery
targets; those targets are not SLAs.

## Scenario and evidence traceability

The canonical expected outcomes are the bullets in
[`M1-SCENARIOS.md`](M1-SCENARIOS.md). E2E manifest assertions use the following
stable prefixes so reports can trace each result without copying or weakening
the source oracle:

| Assertion IDs | Source scenario heading |
| --- | --- |
| `M1-HARNESS-01` through `M1-HARNESS-03` | Harness: real boundaries, failing evidence, and clean repeat |
| `M1-CONTRACT-01` and `M1-CONTRACT-02` | Harness: standard-project and portfolio contract fixtures |
| `M1-AUTH-01` through `M1-AUTH-06` | Accounts, authentication and durable ownership |
| `M1-GRAPH-01` through `M1-GRAPH-05` | Project graph and release records |
| `M1-JOB-01` through `M1-JOB-06` | Durable jobs and scoped credentials |
| `M1-RECOVERY-01` through `M1-RECOVERY-08` | Additive upgrades, backup and recovery |
| `M1-GATE-01` | Gate and evidence handoff |

Numbering follows bullet order within each named source section. A scenario
change updates this mapping and the harness assertion list together. E2E is the
behavioral acceptance mechanism; M1 implementation must not add post-code unit
tests as substitute evidence. Every run, including failure, follows the artifact
contract in `TESTING.md`, and `HOST-242` stops after a clean repeat and verified
receipt without claiming M2 work.
