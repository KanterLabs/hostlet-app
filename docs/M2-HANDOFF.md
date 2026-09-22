# M2 onboarding handoff

M2 acceptance passed on 2026-09-22 using Sol Medium workers and primary-agent
integration and verification. Stop at **HOST-243**. M3 is not assigned or claimed.
[Helm](https://tc.shanekanterman.dev/p/hostlet) owns live task and claim state.
This milestone delivers local onboarding and private previews, not a launch.

## Tested source and delivered behavior

Both clean full acceptance runs tested
`82ecd6d473335d563325989a7ecfaf040a7e8b4e`, unchanged from start to finish.
Later handoff and roadmap commits contain documentation only and do not replace
that tested implementation identity. The upfront acceptance inventory was
committed at `b17a48dc0dceac426b96d92824e16e8462752848` before production code.

- Account sign-up/sign-in, selected GitHub installation/repository/branch access,
  exact immutable source revisions, signed webhook verification, durable
  duplicate handling and revocation.
- Bounded static compatibility reports with five distinct outcomes, exact
  configuration/source binding, conservative framework detection and actionable
  configuration questions. Analysis never executes repository commands.
- A private portfolio editor with owner-written profile and project stories,
  order and visibility, local artwork placeholders, one layout, two typography
  choices and three accents. Full-snapshot saves use immutable revisions and
  optimistic concurrency; stale edits remain available for explicit resolution.
- Configuration edits create a new configuration, resolve the selected source
  again and rerun compatibility. Public build values, deferred decisions and
  secret requirements are distinct; this flow accepts no server-secret values.
- Internal entitlement/capacity fixtures, capacity holds, project slots, rollout
  headroom, resource-observation generation fences, build-meter debits and
  one-time verified platform-fault credits, with durable reconciliation.
- Additive schema 4 to 5, minimum reader 4, verified pre-upgrade backup and
  preserved populated state. All 44 public platform relations are included in
  recovery evidence. Actual M1 and current binaries read and write without a
  database rewind; retained content-only edits inherit compatible preview
  context and filter removed or replaced project references.

See [M2-API.md](M2-API.md) for the HTTP contracts and [M2-DECISIONS.md](M2-DECISIONS.md)
for implementation boundaries.

## Clean acceptance receipts

Each run passed **48 assertions**, including the additional clean-source
invariant. Every payload hash, complete receipt coverage, private file/directory
mode, source stability and current backup source/binary provenance was checked
independently. The browser evidence includes the editable form and rendered
private portfolio. Artifacts remain private and Git-ignored under
`artifacts/e2e/M2/<run-id>/`.

| Run | Retained M1 acquisition | Verified files | SHA-256 of SHA256SUMS |
| --- | --- | ---: | --- |
| `2026-09-22T021132-355Z-2966442-8aed9f` | Verified original cache | 350 | `61f9964f321e0e93ac95264c112b83e471f7be03d1f8bcf65c2a77d61157aae3` |
| `2026-09-22T021343-002Z-2980264-19eb55` | Fresh detached-source rebuild | 354 | `3eb439a61b188604faa6001dea1dad82a7b5428b3d36d81233419fe905ef6560` |

The retained M1 source is `b17a48dc0dceac426b96d92824e16e8462752848`.
Its original cached binary hash is
`a544f8b3e24e9375f4be7b04a4711329ae9cfce1a4d70eba9bdfdc472c7306a1`;
the clean rebuild hash is
`45a878122b906a10293bdeaaaf699f49d8a960780ab554480705c2fc7dd71b83`.
Rust debug build paths can change binary bytes. The fresh rebuild verifies
pinned source, a clean detached worktree, locked dependencies and repeated
behavior; it does not assert identical debug binaries.

From a full-history checkout at the tested implementation commit, with the
prerequisites in [the E2E guide](../e2e/README.md):

```sh
make install
make check
make e2e-gate
make e2e-gate E2E_ARGS='--rebuild-retained'
```

Use an isolated checkout when the current tree contains later changes. Each
manifest records the exact invocation, toolchains, Chromium executable, image,
fixtures and binary hashes. From either artifact directory:

```sh
sha256sum --check SHA256SUMS
sha256sum SHA256SUMS
```

Compare the receipt hash with the table and inspect `REPORT.md`, `manifest.json`
and `assertions.json`. The rendered screenshot is
`browser/m2-private-preview-canvas.png`; the editor screenshot is
`browser/m2-private-preview-showcase.png`.

## Coverage and cleanup

The running-system cases exercise provider permission, OAuth state/PKCE,
expiration, selected refs, scope, signed/replayed/rejected events, provider
bounds, static-inspection regressions and non-execution sentinels. Browser
cases cover sign-up, reconnect, source selection, unsaved-edit preservation,
preview authoring/reload, concurrent winners and stale losers, configuration
reruns and visible portfolio content. HTTP/SQL checks cover first revision
creation, 51-project keyset pagination, owner isolation, exact idempotency,
invalid snapshots and secret-value rejection without partial writes.

Admission cases exercise concurrent capacity and slot limits, retained-resource
accounting, rollout overlap, expiry, generation-scoped cleanup, delayed stale
observations, build quota debit/credit and restart reconciliation. The populated
upgrade requires a verified fresh backup, preserves relationships and IDs,
restores into a separate owned empty target, and checks retained/new binary
writes plus restored GitHub, report and preview state.

Both clean runs removed their exact labeled PostgreSQL container and named
volume, stopped owned API/browser/Vite processes and removed temporary data.
The second run also removed its detached worktree. Independent inspection found
no remaining owned PostgreSQL container or retained temporary worktree.
Credential scans reported zero matches. Synthetic encrypted backup payloads and
in-memory credentials are not published; sanitized observations and receipts
are retained. Failed diagnostic bundles remain available and are not acceptance
passes.

`make check` passed: formatting, Clippy, TypeScript, web build and the eight
pre-existing scaffold checks. No post-implementation unit tests were added.
Implementation [CI run 35678712043](https://github.com/KanterLabs/hostlet-app/actions/runs/35678712043)
passed with web checks on `homelab` and Rust checks on `homelab-heavy`.
The implementation is published to canonical
[Gitea](https://gitea.home.shanekanterman.dev/KanterLabs/hostlet-app) and its
[GitHub mirror](https://github.com/KanterLabs/hostlet-app).

## Limits and next stop

GitHub acceptance uses the declared owned loopback HTTP provider fixture and
real Hostlet authorization logic. It does not register or validate a live
GitHub App against real private repositories. Provider configuration defaults
to disabled; live credentials are a separate operator setup.

Entitlements, inventory and resource observations are explicit authenticated
internal fixtures. M2 performs no payment, customer build, runtime provisioning,
tenant-database provisioning or public portfolio publication. Readiness keeps
`customer_admission` and `workload_execution` false. Compatibility is advisory
and conservative, not a deployment guarantee. Static non-execution evidence
combines bounded source reads, filesystem/network sentinels and sampled process
observations; sampling is not a universal operating-system execution proof.

The preview has one layout; three publication templates are M4. Platform backup
plaintext remains capped at 64 MiB. No production database, existing Hostlet
resource, domain, provider account or customer state was migrated or replaced.

**Next milestone: M3 — Working demo and portfolio**, ending at HOST-233. It covers
runtime isolation, tenant PostgreSQL recovery, disposable-VM builds, coordinated
releases, owner approvals and one independently published static portfolio.
Its cards remain unclaimed; a new assignment is required before work begins.

Hark activity publishing timed out during this work. Helm remained available
and holds the durable progress and milestone record.
