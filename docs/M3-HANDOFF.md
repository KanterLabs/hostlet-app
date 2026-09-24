# M3 working demo and portfolio handoff

M3 local acceptance passed on 2026-09-24 through **HOST-233**. Two clean full
journeys each passed 55/55 recorded assertions and all 11 ordered M3 phases.
They tested the same implementation commit,
`0649f74f4a93ffc691b9c472c1759d1ff56f439d`, unchanged and clean throughout
both runs. This handoff and related roadmap updates are later documentation; they
do not replace the tested implementation identity. Stop before M4. The planned
paid-pilot release remains a readiness boundary, not a launch.

The owned synthetic fixture traveled from an authorized exact source commit
through a disposable VM build, isolated application and tenant PostgreSQL,
coordinated release and rollback, owner approval, and an independently served
static portfolio. Customer admission, production workload execution, live
payment, provider purchases, and production or public site publication were not
authorized by these runs.

## Clean acceptance receipts

The two bundles are private and Git-ignored under `artifacts/e2e/M3/`. The
independent pair audit verified complete checksum receipts, identical source,
harness and fixture identities, all required assertion IDs, private modes,
redaction and exact owned cleanup. Each bundle has 2,911 checksum-covered files
and five provenance identities; 67 relay start/group/identity observations had
zero survivors in each run. The harness revision in both manifests is
`70eb072e8f40e310f637d97b2aea076ca958966000239f0820b4991e064a1133`.

| Gate | Run ID | Retained M2 acquisition | SHA-256 of `SHA256SUMS` |
| --- | --- | --- | --- |
| A | `2026-09-24T013229-534Z-3903199-4fd227` | Verified private binary cache | `4c3c2558dcb05cc3f0849af0cbb235e020ead1563f1f6e192fa6a0c062af3dc3` |
| B | `2026-09-24T023724-407Z-4105684-395b91` | Clean detached source and locked-dependency rebuild | `9bc08445d499c7d6309b7b374fc6787ef787f37bfe40769bf2a32b1edbba998f` |

From a full-history checkout of the tested implementation commit, with the
owned assets and prerequisites in [the M3 E2E guide](M3-E2E.md), repeat the
gates serially with the recorded umask:

```sh
umask 0022
make e2e-m3-gate
make e2e-m3-gate E2E_ARGS='--rebuild-retained'
```

Run Gate B only after auditing Gate A. A failed full gate ends the attempt
after owned cleanup and a complete report. The manifests contain the exact
Node invocation, toolchain and fixture digests, and non-secret configuration.
For either run ID above, inspect the private bundle and independently verify
its external receipt:

```sh
RUN_DIR='artifacts/e2e/M3/<run-id>'
(cd "$RUN_DIR" && sha256sum --check SHA256SUMS)
sha256sum "$RUN_DIR/SHA256SUMS"
```

Compare the second command with the corresponding receipt hash in the table;
then inspect `manifest.json`, `assertions.json` and `REPORT.md`. The retained M2
source is `a70b49664ebfab1bb44a3b9077c535b244a9dfb9`. Gate A used cached
binary SHA-256
`3a3b95a5e4418aea5c980b6e960dbc51602c710d7bd2ed760dff25a1435893b5`;
Gate B rebuilt binary SHA-256
`b1e5b608b0f1d32cd316421602cafe0f28c02e6a7ebce85b1e857dc08eddbe7a`.
The source-pinned rebuild permits different bytes because Rust debug paths can
be embedded. Gate B verified the pinned clean source, locked dependencies and compatible behavior,
and removed its exact detached worktree. `make check` passed on the tested
implementation before the full gates; its workspace checks are separate from
the E2E evidence.

## Browser, release and portfolio evidence

For a visual of the working demo, open Gate A
`browser/m3-release-v2-active.png` in its private bundle. The neighboring
`browser/m3-release-v2-active.html` and
`browser/m3-release-v2-active-network.json` record the same browser state and
requests. The image shows the running owned project journal with
`frontend-v2 using api-v2` and populated entries. `M3-RELEASE-01/02/03` record
the route promotion, old/new client compatibility, data-safe release and
rollback, and retained predecessor handling. `M3-RELEASE-03-STOPPED` records
HTTP 409 rejection of a stopped and cleaned rollback target while preserving
the active route and data in both gates.

`M3-APPROVAL-01` records owner review of 20 exact public targets from one saved
immutable revision; the source commit, hidden headline and unapproved external
screenshot stayed private. `M3-APPROVAL-02/03` record authorized deployment-fact
refresh without changing owner narrative or approval, plus `needs_recheck`
readiness after a new release. `M3-PUBLISH-01/02` record explicit immutable
publication, last-good preservation through corrupt and interrupted attempts,
and stale completion fencing.

In both runs, `M3-PUBLISH-03` records a fresh Chromium load of the published
index and project detail while dashboard/control, provider and tenant endpoints
were stopped. Both pages loaded, every observed resource request stayed on the
independent static server, no dependent upstream remained, and the static HTTP
boundary rejected unknown hosts, slugs and encoded traversal. The portfolio
consumed no hosted-project slot. Its inspectable browser result is the named
assertion in each `manifest.json` and `REPORT.md`. **Neither run retained a
portfolio screenshot or DOM snapshot**; the journal image above depicts the
working demo, not the portfolio.

## Data preservation and runtime limits

`M3-UPGRADE-01/02` record verified pre-upgrade backups, meaningful populated
schema-5 to schema-6 migration, current and actual retained M2 binary reads and
writes, repeat-migration idempotence, no database rewind, and final verified
restore into a separate empty owned target. Each final restore matched 78
relation hashes with zero unvalidated foreign keys or relationship violations.
`M3-DATA-01-STORAGE` exercised actual growth beyond 1 GiB: the running database
became sticky read-only, denied writes and kept reads and portable export.
`M3-DATA-02/03/04` exercised encrypted daily backup and seven-day retention,
rotating restore drills across both active databases, large portable export and
isolated restore, and a verified fresh backup plus populated trial and live
migration before release. Both journeys retained private, redacted evidence and
cleaned their exact owned resources.

The accepted runtime decision is **`owned_fixture_only`** with
**`production_ready=false`** and customer admission disabled. Node 22 and Node
24 owned fixtures ran under gVisor. Next 16 recorded zero admitted cold starts
and explicit HTTP 409 rejection because `cold_start_health` was unmet; general
Next.js support is not established. The provisional 50% throughput ratio target
was missed in both accepted gates:

| Gate | Native rps | gVisor rps | Ratio | Target |
| --- | ---: | ---: | ---: | ---: |
| A | 1,646.097 | 493.489 | 29.979% | 50% |
| B | 1,675.337 | 497.675 | 29.706% | 50% |

The performance decision remains deferred for production; a passing owned
fixture journey is not a production capacity result. The earlier 26.58%
diagnostic in [the runtime decision](M3-RUNTIME-DECISION.md) remains historical
diagnostic evidence, not either full gate. Known limits also include
peer-journal interruption, four-version migration scope and unreferenced
publisher CAS objects. Production provider, spend, domain, capacity/cost and
customer-admission decisions remain separate gates.

## Source publication and CI

This handoff records local acceptance at the tested implementation commit.
The later documentation commit, canonical Gitea and public GitHub mirror heads,
and applicable CI results are reported separately in the milestone completion
message after publication verification. Source publication does not deploy or
publish a customer portfolio.
