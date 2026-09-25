# Hostlet development

M3.5 final recovery stopped under the full-gate failure rule on 2026-09-25.
Installed `d681a41` passed full run 1 (62/62). Run 2 passed 61 assertions but
failed a provider-status read during final route cleanup. Separate exact
cleanup restored the live preview and owner content; all eight demo rows and
all eleven ready services are retained. Read `docs/M3.5-FINAL-RESULT.md`.
HOST-248 is blocked at 3/5. Do not repair or rerun a gate without a new
assignment. Preserve the live preview and stop before M4.

This is the fresh `KanterLabs/hostlet-app` repository. Read `PLAN.md`,
`README.md` and the adopted planning baseline in `RECOMMENDATIONS.md` before
implementation. `PLAN.md` is the canonical current plan; `RECOMMENDATIONS.md`
records the accepted planning rationale and detailed validation candidates. The
supplied September 21 portfolio-and-demo brief is authoritative; the earlier
generic-hosting plan is superseded. M1 is complete at HOST-242; read
`docs/M1-HANDOFF.md` for verified evidence and limits. M2 acceptance is complete
through HOST-243 using Sol Medium workers; read `docs/M2-HANDOFF.md` for the two
clean runs and limits. M3 acceptance is complete through HOST-233 using GPT-6 Sol
workers at medium reasoning, with the primary owning integration and verification.
Read `docs/M3-HANDOFF.md` for the two clean 55-assertion runs, retained-M2 rebuild,
repeatable private artifacts and owned-fixture-only limits. Customer admission
remains disabled; Next.js 16 and the throughput target remain deferred.
M3.5 uses isolated owned preview resources and the access boundary in
`docs/M3.5-PREVIEW-CONTRACT.md`. Historical attempts are retained in
`docs/M3.5-HANDOFF.md`; the current result is `docs/M3.5-FINAL-RESULT.md`.
`docs/M3.5-DEMO-ACCESS.md` explains the separate browser gate and application
credentials. Customer admission, purchases and live payments remain disabled.
**Stop before M4.** Later work requires a new assignment.
Read [TESTING.md](TESTING.md) before adding or validating behavior. It defines
the E2E acceptance policy, the narrow test-first isolation exception, milestone
stop points and the artifact contract. Helm owns live task, dependency and claim
state; [ROADMAP.md](ROADMAP.md) and [roadmap.json](roadmap.json) are committed
snapshots of the milestone and dependency ordering.

- Author new code, tests, manifests and automation here. Other Hostlet repositories
  are references; do not import their history, runtime state or credentials.
- Preserve existing databases, guest disks, DNS routes, registries, subscriptions
  and provider mappings. M1 authorizes owned local foundation migrations and recovery drills, not production deployment or migration.
- Keep control, builder and runtime boundaries separate. PostgreSQL owns
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
- The adopted plan settles product scope and lifecycle defaults for implementation.
  Keep the dashboard on React/TypeScript/Vite and defer a Next.js dashboard
  migration. Prices ($5/$12/$20) remain pricing hypotheses; resource numbers are
  starting benchmark targets. Production provider/spend/domain placement remains
  a validation or authorization gate, not approval to publish, purchase or migrate.
- Add credentials only through explicit service-scoped injection. Do not commit
  secrets, private operational inventories, customer data or provider identifiers.
- Run `make check` before publishing changes. Pin toolchains and commit both locks.
  Prefer focused behavioral checks over tests that duplicate implementation.
- Follow [TESTING.md](TESTING.md) for behavior validation: define E2E scenarios
  and the milestone scope before implementation, use E2E as the acceptance
  evidence for complex features, and stop at the assigned milestone gate with a
  repeatable artifact and handoff. Do not add post-implementation unit tests;
  use the documented failure-inventory and test-first exception only when an
  isolation check cannot be covered at an E2E boundary.
- Use `homelab` for lightweight GitHub Actions jobs and `homelab-heavy` for Rust
  workspace builds/tests, images and long integration/browser suites. CI cannot deploy.
- Gitea is the canonical source; GitHub is the public mirror. Publish only content
  suitable for public release. Authenticate Gitea through the Infisical helper.
- Track substantive work in the Hostlet Helm project. Older completed cards are
  evidence for older repositories, not implementation evidence for this new tree.
- Use Helm's live prerequisite links before claiming implementation work. Keep
  future cards unclaimed until their prerequisites are complete; synchronize
  `ROADMAP.md` and `roadmap.json` when task scope or dependencies change. The
  planned release is a readiness boundary, not an automatic launch instruction.
- The primary agent owns integration and final verification. Delegate bounded,
  independent work to GPT-6 Sol workers at medium reasoning with explicit file ownership; workers must not
  spawn agents or revert concurrent edits. Serialize locks, migrations and builds.
- Later populated-data upgrades require a verified pre-upgrade backup, meaningful
  populated-data migration checks and retained-binary compatibility. Database
  reset/recreate or restore is not an upgrade procedure.
