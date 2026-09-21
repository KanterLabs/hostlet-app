# Hostlet development

This is the fresh `KanterLabs/hostlet-app` repository. Read `PLAN.md` and
`README.md` before implementation. The supplied September 21 portfolio-and-demo brief is authoritative; the earlier
generic-hosting plan is superseded. The current deliverable is a local scaffold.

- Author new code, tests, manifests and automation here. Other Hostlet repositories
  are references; do not import their history, runtime state or credentials.
- Preserve existing databases, guest disks, DNS routes, registries, subscriptions
  and provider mappings. A scaffold task does not authorize deployment or migration.
- Keep control, builder and runtime boundaries separate. PostgreSQL will own
  durable intent; an in-memory placeholder must not accept customer work.
- Customer builds belong in disposable VMs, never organization CI runners.
  Tenant runtime requires stronger isolation evaluation, resource/network controls
  and a documented compatibility decision before customer admission.
- Keep trusted platform, tenant applications and portfolio publishing trust boundaries
  explicit. Private repository access never grants permission to publish its content.
- Model projects containing services and deployments; the portfolio references those
  projects. A portfolio or external case study does not consume a live-project slot.
- Keep live deployment facts distinct from owner-approved narratives and demo readiness.
- Project databases, backups and tested restore/export belong to the new launch scope.
  Do not carry forward the old no-backup exception or pricing catalog.
- Proposed prices, limits, Next.js migration and production placement are not approvals.
- Add credentials only through explicit service-scoped injection. Do not commit
  secrets, private operational inventories, customer data or provider identifiers.
- Run `make check` before publishing changes. Pin toolchains and commit both locks.
  Prefer focused behavioral checks over tests that duplicate implementation.
- Use `homelab` for lightweight GitHub Actions jobs and `homelab-heavy` for Rust
  workspace builds/tests, images and long integration/browser suites. CI cannot deploy.
- Gitea is the canonical source; GitHub is the public mirror. Publish only content
  suitable for public release. Authenticate Gitea through the Infisical helper.
- Track substantive work in the Hostlet Helm project. Older completed cards are
  evidence for older repositories, not implementation evidence for this new tree.
- The primary agent owns integration and final verification. Delegate bounded,
  independent work to `luna_worker` with explicit file ownership; workers must not
  spawn agents or revert concurrent edits. Serialize locks, migrations and builds.
- Later populated-data upgrades require a verified pre-upgrade backup, meaningful
  populated-data migration checks and retained-binary compatibility. Database
  reset/recreate or restore is not an upgrade procedure.
