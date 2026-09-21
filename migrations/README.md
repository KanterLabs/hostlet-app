# Platform persistence and migration boundary

PostgreSQL 18 is the authoritative M1 store for accounts, ownership, project
configuration, deployment intent, portfolio drafts, jobs, encrypted secret
versions and audit records. Customer project databases remain a separate,
future tenant-data boundary. M1 does not provision or execute customer apps.

Startup checks compatibility and never migrates automatically. Use the explicit
`hostlet-control migrate` CLI with `DATABASE_URL` injected through protected
environment. Initial migration requires an empty, explicitly selected database.
An occupied uninitialized database is refused.

| Version | Additive change | Minimum reader |
| --- | --- | --- |
| 0001 | Identity, authentication, audit and intent replay | 1 |
| 0002 | Owned project graph and portfolio draft revisions | 1 |
| 0003 | Fenced jobs and scoped encrypted secret versions | 1 |
| 0004 | Verified platform recovery receipts | 3 |

Published migrations are immutable. The binary checks the contiguous applied
ledger, embedded checksums, compatibility row, database identity and required
relations. A schema-3 binary may read the additive schema-4 database because its
minimum reader remains 3. A new binary refuses readiness while migration 4 is
pending. Binary rollback does not rewind the database or discard later writes.

A populated upgrade is one additive step and requires a fresh authenticated
backup for the exact source database, schema and intended migration:

```sh
hostlet-control backup create --repository /private/hostlet-backups --intended-migration 4
hostlet-control backup verify --repository /private/hostlet-backups --backup-id BACKUP_UUID
hostlet-control migrate --repository /private/hostlet-backups --backup-id BACKUP_UUID
```

Use the returned backup UUID. Backup encryption uses a separately injected
recovery key. No URL credential, key or password belongs in command arguments.
The backup gate and migration hold the same database advisory lock; the schema
change and verified receipt commit together. There is no reset/recreate or
automatic restore path.

[The recovery runbook](../docs/M1-RECOVERY.md) specifies PostgreSQL tooling,
backup limits, key custody, scheduling, retention and explicit separate-target
restore. [M1 scenarios](../docs/M1-SCENARIOS.md) require real populated upgrades,
retained-binary compatibility and restore evidence. Production migration,
restoration, tenant provisioning and cutover are outside this local M1 scope.
