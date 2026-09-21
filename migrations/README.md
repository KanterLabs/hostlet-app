# Persistence boundary

PostgreSQL is planned as the authoritative store for accounts, project intent,
services, deployment/configuration snapshots, jobs, entitlements, provider inboxes,
portfolio drafts/publication revisions, demo-readiness records and audit records.
No database is connected and no migration runs in this scaffold.

Customer project databases are a separate tenant-data boundary, not application
tables inside platform persistence. Define isolation, backup, export, restore and
deletion policies before provisioning them. Public portfolio content is an approved
snapshot referencing projects, not a second authority for deployment URLs.

Introduce numbered additive SQL migrations with the first persistence slice.
Serialize migration numbering. Validate upgrades on populated disposable data,
retain compatibility with rollback binaries, and verify a pre-upgrade backup
before changing persistent environments. Never use reset/recreate as an upgrade.
