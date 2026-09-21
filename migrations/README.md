# Persistence boundary

PostgreSQL is planned as the authoritative store for accounts, project intent,
configuration snapshots, jobs, entitlements, provider inboxes and audit records.
No database is connected and no migration runs in this scaffold.

Introduce numbered additive SQL migrations with the first persistence slice.
Serialize migration numbering. Validate upgrades on populated disposable data,
retain compatibility with rollback binaries, and verify a pre-upgrade backup
before changing persistent environments. Never use reset/recreate as an upgrade.
