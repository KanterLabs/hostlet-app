# M1 foundation handoff

M1 acceptance passed on 2026-09-21. Stop at **HOST-242**; later milestones remain
unclaimed. [Helm](https://tc.shanekanterman.dev/p/hostlet) owns live completion and
claim state. This is local foundation evidence, not a production launch.

## Tested source and delivered behavior

Both clean full runs tested exactly
`5d72bd0b5af60576d6e4bd71d932847cfe1976eb`, unchanged from start to finish.
Later commits containing this handoff and roadmap status are documentation only;
they are not substituted for the tested implementation commit.

The API persists authenticated accounts, ownership, immutable project/service
configurations, deployment intents and portfolio drafts. It supports fenced
bookkeeping jobs with retry/restart recovery and service-scoped encrypted secret
versions. Real PostgreSQL backup, verified additive upgrade and separate-target
restore preserve the populated graph. The web application remains a status
preview. Customer builds, hosting, GitHub onboarding, billing and public portfolio
publication belong to later milestones.

The new recovery migration is schema 3 to 4, minimum reader 3. Both actual
binaries read and write upgraded data without rewinding the database. Restore
recovers the pre-upgrade schema-3 data into a distinct empty database; owner
isolation and a fresh live job's scoped secret resolution are verified afterward.

## Clean acceptance receipts

Each row passed **54 assertions**, including eight recovery scenarios. Every
retained payload hash, complete receipt coverage, private file/directory mode,
source stability and backup source/binary provenance was independently checked.
Artifacts stay private and Git-ignored under `artifacts/e2e/M1/<run-id>/`.

| Run | Retained binary acquisition | Verified files | SHA-256 of SHA256SUMS |
| --- | --- | ---: | --- |
| `2026-09-21T232727-289Z-2549499-860f4a` | Verified original cache | 279 | `477a059df6975ba87105403ea8e0c62f118ba3454ae67931cf1560930f257123` |
| `2026-09-21T233321-646Z-2565431-5f790b` | Fresh detached-source rebuild | 284 | `23220db3fc054e5f4b842cdb938c70c0fed3b04b57ad0a46fcc56550bacfb4e0` |

The retained source is `c78d9a2857bdb6a741cf7c67a8bd89acd4781767`.
The original binary hash is `f68b958e98842992bb542c8b5a1ddb7f3ed043f1b33c8d16f56ab3635fe6cb40`;
the fresh rebuild hash is `d7813d7b12c95acd0a587105e8d8d2b49724a270529d526ae4cfe6898de53732`.
Debug paths can change binary bytes. Reproducibility means verified source,
locked dependencies and repeated behavior, not identical debug binaries.

Rerun from a full-history checkout at the tested implementation commit, with the
prerequisites in [the E2E guide](../e2e/README.md):

```sh
make install
make check
make e2e-gate E2E_ARGS='--task HOST-218'
make e2e-gate E2E_ARGS='--task HOST-242 --rebuild-retained'
```

Use an isolated checkout when the current working tree has later changes. Each
bundle's `manifest.json` records its exact Node command, toolchains, fixtures,
image and binary hashes. From either bundle directory, run:

```sh
sha256sum --check SHA256SUMS
sha256sum SHA256SUMS
```

Compare the second output with the receipt table and inspect `REPORT.md`,
`manifest.json` and `assertions.json`. Valid hashes do not turn a failed or
abandoned run into a pass.

## What the scenarios prove

- Real API, Vite and Chromium health/version/not-ready/offline behavior.
- Two-account authentication and ownership; durable writes, idempotency,
  concurrency, API/database restarts and unavailable-database refusal.
- Project and portfolio contracts, immutable configuration/draft references,
  deployment/slot lifecycle intent and owned relationship preservation.
- Job states, leases, fencing, bounded retries, competing workers, one durable
  effect, service/operation-scoped secret access and wrong-key refusal.
- Initial migration, ledger integrity, real encrypted exported-snapshot backups,
  missing/stale/wrong-target/corrupt evidence refusal, concurrent populated
  upgrade, retained/new binary compatibility and distinct empty-target recovery.
- **58 real scheduled dumps** under an explicit accelerated scheduling clock:
  49 inclusive hourly points plus seven completed UTC calendar-day points kept,
  two expired/redundant points deleted, two manual points preserved; same-hour
  deduplication and corrupt/symlink refusal without unsafe deletion.

The clean runs observed backup data ages of 259 and
251 seconds and restore durations of
0.546 and 0.469 seconds.
These small synthetic-fixture measurements meet the one-hour/four-hour targets
for the drill; they are not production capacity or availability guarantees.

## Runner failure evidence

These diagnostics use the same implementation commit. Their receipts verify,
but they are intentionally **not acceptance passes**.

| Failure | Run | Outcome | SHA-256 of SHA256SUMS |
| --- | --- | --- | --- |
| Real SIGKILL immediately before receipt creation | `2026-09-21T232610-934Z-2546298-0b1536` | Exit 137; no receipt at crash; next run preserves original manifest and marks abandoned | `f85be2b35300e5c85ce6c44e243e37f4eb1fe8bb90d38dfe70ef0abb21426edb` |
| Deliberately wrong browser version oracle | `2026-09-21T232635-577Z-2547466-07c549` | Nonzero; `browser-connected-version` fails | `0599e12d01c6e7e45c5ab94c83b2fe6de870e1f1d49a91d81b2df0fa345c4416` |
| Omitted required assertion | `2026-09-21T232657-932Z-2548476-f9ddd8` | Nonzero; `required-assertions-complete` fails | `99afab2411753755e360b2ad78623ffdb2911261f8638efd6bfac796c3c5139f` |

The recorded diagnostic sequence was:

```sh
node --require ./e2e/faults/crash-before-receipt.cjs e2e/run.mjs --task HOST-242
make e2e-failure E2E_ARGS='--task HOST-242'
node e2e/run.mjs --task HOST-242 --scenario-module e2e/faults/missing-required.mjs
```

These commands intentionally return nonzero. See each manifest for the resolved
Chromium path and full invocation. Earlier
handled SIGTERM, timeout and missing-prerequisite evidence remains private in
the artifact history; the final clean receipts above establish this handoff.

## Cleanup, validation and limits

Both clean runs removed their exact labeled PostgreSQL container and named
volume, stopped owned API/browser/web/worker processes, and deleted temporary
files. The fresh rebuild also removed its detached worktree. Credential scans
reported zero matches. Synthetic backup payloads and in-memory keys are not
published; safe command receipts and assertions are retained.

`make check` passed: formatting, Clippy, TypeScript, web build and the eight
pre-existing scaffold checks. No post-implementation unit tests were added.
CI for the implementation commit passed on `homelab` and `homelab-heavy`:
[run 35667665200](https://github.com/KanterLabs/hostlet-app/actions/runs/35667665200).
The canonical repository is [Gitea](https://gitea.home.shanekanterman.dev/KanterLabs/hostlet-app),
with [GitHub](https://github.com/KanterLabs/hostlet-app) as its mirror.

M1 backup plaintext is capped at 64 MiB. Recovery uses a separate single-key
configuration; rotation and larger streaming backups are later work. The hourly
scheduler is a verified one-shot tick with an operator runbook; M1 installs no
host timer, performs no production cutover and provides no customer execution.
See [the recovery runbook](M1-RECOVERY.md) for exact commands and boundaries.

Hark activity publishing timed out; Helm remained available and holds the work
record. No M2 card was claimed. Continue only after a new assignment.
