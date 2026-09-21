# M1 backup, upgrade, and recovery runbook

This runbook defines the HOST-218 recovery boundary. It covers platform-owned
PostgreSQL 18 data in M1. It does not reset a database, replace a live database,
or authorize a production cutover.

## Commands and configuration

The recovery commands are:

```text
hostlet-control backup create --repository DIR [--intended-migration N] [--scheduled-for RFC3339]
hostlet-control backup verify --repository DIR --backup-id UUID
hostlet-control backup schedule --repository DIR [--effective-at RFC3339]
hostlet-control migrate --repository DIR --backup-id UUID
hostlet-control restore --repository DIR --backup-id UUID
```

`backup create`, `backup schedule`, and `migrate` read the source database from
`DATABASE_URL`. `restore` reads only the separately selected target from
`HOSTLET_RESTORE_DATABASE_URL`; the source may be offline. `backup verify` needs
no database connection. Every recovery command needs `HOSTLET_RECOVERY_KEY`, a
64-character hexadecimal encoding of a separate 32-byte key. If
`HOSTLET_SECRET_KEY` is also present, configuration rejects equal key bytes.
There is no caller-supplied key identifier or source revision.

`HOSTLET_BACKUP_MAX_AGE_SECONDS` controls the upgrade gate and defaults to 3600
seconds. Its accepted range is 1 through 3600. `HOSTLET_PG_CONTAINER` selects
one explicitly named, run-owned PostgreSQL 18 container. Without it, commands
use PostgreSQL 18 tools from `PATH`. A container tool connects through its local
PostgreSQL socket, and a fixed `psql` identity query proves that this is the same
physical cluster and database checked over `DATABASE_URL` or
`HOSTLET_RESTORE_DATABASE_URL`.

Successful commands write one JSON receipt to stdout. Errors write only a safe
configuration message or `recovery failed: <code>` to stderr. Recovery keys,
database URLs, passwords, plaintext dumps, tool stderr, and SQL errors are not
printed. Invalid command syntax exits 2; an operation failure exits 1.

## Backup repository and envelope

The repository is private (`0700`). Each backup owns exactly two regular files:

```text
<backup-id>.hostlet-backup
<backup-id>.receipt.json
```

Artifact and receipt files are created with `0600`; reads reject symlinks and
special files. The backup artifact is a versioned JSON envelope containing a
safe manifest, a random 24-byte XChaCha20 nonce, ciphertext, and the 16-byte
authentication tag. The complete PostgreSQL custom-format dump is one
authenticated message. Canonical manifest JSON plus the
`hostlet-backup-envelope/v1` domain is AEAD additional data. The external
receipt repeats the authenticated manifest and records the digest and byte
length of `nonce || ciphertext || tag`.

The manifest records the backup UUID, immutable database identity UUID, schema
and minimum-reader versions, intended migration, source snapshot time, optional
schedule time, exact relation counts, source physical-target fingerprint,
PostgreSQL and tool major versions, plaintext digest and length, recovery-key
identifier, source Git revision and dirty state, and the running binary's
SHA-256. The key identifier is derived inside `RecoveryKey::new` from the key
and a recovery-specific domain. It is metadata, not key material.

Plaintext is never written to disk. The custom dump is held in zeroizing memory
and rejected above 64 MiB. Tool stdout and stderr are bounded, each tool has a
120-second deadline, and a canceled operation kills its child. Tool processes
receive a cleared environment with only locale, `PATH`, and the minimum
required `PG*` values. This 64 MiB design is the deliberate M1 limit; larger
databases fail closed and require a later streaming format.

Docker tools also run below an in-container 110-second deadline. Every dump and
restore uses a unique PostgreSQL application name. If the outer 120-second
deadline, an output bound, or the tool itself fails, Hostlet kills and awaits
the local child, terminates only the matching target-database backend, and
confirms that backend is absent before releasing the advisory lock. Terminating
a failed `pg_restore --single-transaction` backend rolls back its restore
transaction.

## Consistent snapshot and upgrade gate

Backup creation obtains the same advisory lock used by migration before it
starts a `REPEATABLE READ READ ONLY` transaction. It calls
`pg_export_snapshot()`, keeps that transaction open, collects metadata and exact
relation counts in that snapshot, and runs `pg_dump --format=custom
--snapshot=<snapshot> --no-owner --no-acl --no-password`. PostgreSQL documents
that an exported snapshot remains importable only while the exporting
transaction remains open, and `pg_dump --snapshot` synchronizes the dump to
that view: [snapshot synchronization](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION) and
[`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html).

The physical-target fingerprint hashes a domain-separated tuple of
`pg_control_system().system_identifier`, the current database OID, and database
name. The OID and name come from `pg_database`; see
[`pg_control_system`](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-CONTROL-SYSTEM) and
[`pg_database`](https://www.postgresql.org/docs/18/catalog-pg-database.html).
Consequently, alternate URLs for the same database do not bypass target checks.

For a populated upgrade, `migrate` first holds the advisory lock and verifies
the selected envelope and receipt. The receipt must use the configured derived
key identifier and authenticate successfully; name, backup UUID, encrypted and
plaintext digests, database identity, physical target, source schema, intended
migration, and pending migration must match. Freshness uses PostgreSQL
`clock_timestamp()`: the snapshot may be at most five seconds in the future and
must be no older than the configured maximum age.

Migration 0004 and its receipt insert commit in one database transaction. The
receipt table stores the backup UUID, database identity, source schema,
intended migration, full safe receipt JSON, and verification time. A duplicate
backup UUID is accepted only when every stored field matches. Readiness checks
all persisted receipts against the configured derived recovery-key identifier;
a missing or different key fails closed. The retained v3 binary remains a valid
reader because migration 0004 is additive and keeps the minimum reader at 3.

## Restore

Restore authenticates the envelope before connecting to the target. It acquires
the migration advisory lock on the explicitly selected target, requires that
database to contain no user objects, and rejects the source physical target.
For Docker tools, the preflight physical fingerprint also prevents a published
host port from being checked while `pg_restore` silently addresses a different
container database.

The command pipes the decrypted custom archive directly to PostgreSQL 18
`pg_restore --single-transaction --exit-on-error --no-owner --no-acl
--no-password`. It never uses `--clean` or `--create`. PostgreSQL documents
custom-archive restoration and the atomic `--single-transaction` behavior in
[`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html). After the
tool exits, Hostlet verifies the restored database identity, schema version,
and every recorded relation count before returning a restore receipt. The
target remains a separate recovery database; the operator must perform later
application reads and any separately authorized cutover.

## Hourly schedule and retention

`backup schedule` uses the current time unless `--effective-at` supplies an
explicit E2E clock, then floors that value to its UTC hour. A stable private
repository lock makes concurrent scheduler calls fail safely. Before same-hour deduplication
or deletion, it authenticates every complete envelope/receipt pair and requires
every pair to belong to the current immutable database identity and physical
target. A repeated call in the same UTC hour returns no new backup.

Retention keeps every scheduled point in the inclusive interval
`[effective_at - 48 hours, effective_at]`. With a point at each endpoint this is
49 hourly points. Let `cutoff_date` be the UTC calendar date containing the
48-hour cutoff. Retention also keeps the newest scheduled point on each of the
seven completed UTC dates `cutoff_date - 1 day` through `cutoff_date - 7 days`,
inclusive. An older point on `cutoff_date` is not a daily representative because
that UTC date is only partially outside the hourly window. These fixed calendar
dates do not shift an already selected daily representative into a different
bucket on the next hourly tick. Manual and pre-upgrade backups have no
`scheduled_for` value and are never deleted by scheduled retention. Unknown
files, malformed names, incomplete pairs, unauthenticated artifacts, and
artifacts for another database are never treated as deletion candidates.

The explicit clock may be accelerated by owned E2E scenarios, but every
scheduled point still performs a real dump. Evidence records observed backup
age and restore duration against the one-hour loss and four-hour recovery
targets. Those measurements are milestone evidence, not availability promises.
An operator may invoke the one-shot tick hourly from an authorized cron or
systemd timer with its key and database environment supplied outside Git. M1
does not install a host timer; deployment, monitoring, and alerting for that
timer belong to the later authorized environment.
