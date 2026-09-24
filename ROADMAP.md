# Hostlet implementation roadmap

Execution snapshot updated on 2026-09-24. [PLAN.md](PLAN.md) defines the product;
[RECOMMENDATIONS.md](RECOMMENDATIONS.md) records adopted answers and benchmark
targets. [TESTING.md](TESTING.md) defines the required E2E evidence and agent
stopping rules. [Helm](https://tc.shanekanterman.dev/p/hostlet) owns live task,
dependency and claim state. This file and [roadmap.json](roadmap.json) are
committed snapshots; planned acceptance is not evidence of implementation.

Planned release: **Hostlet 0.1 — paid pilot readiness**. No target date is assigned. The release
ends at reviewed readiness. Customer contact, live charging, infrastructure
purchases and production cutover remain separate authorized actions. Prices
are hypotheses and resource allowances remain benchmark targets.

The snapshot contains **34 cards (22 complete, one active, 11 in Backlog),
41 prerequisite links and six milestone stop gates** in one planned release. Every later milestone
depends on the preceding gate through real Helm dependencies. The acyclic
graph makes the final gate depend transitively on all 33 other cards.

## Start here

**M3 is complete at HOST-233. M3.5 is assigned through HOST-248; stop before M4.**
Shane authorized a restricted owner preview at `beta.hostlet.cloud` on
2026-09-24. HOST-246 defines placement, access and preservation; HOST-247 builds
the durable seeded composition; HOST-248 deploys and verifies the preview twice.
M4 depends on HOST-248. Snapshot revision 12127 records HOST-246 and
HOST-247 complete and HOST-248 active after Shane authorized focused fixes.
The first failed gate and exact route reversal remain retained in
[the M3.5 handoff](docs/M3.5-HANDOFF.md). Fixes address observed public-route
propagation and failure evidence; acceptance is not yet claimed. Later cards
remain unclaimed.

Two clean full M3 runs each passed **55/55 assertions and all 11 phases** on
`0649f74f4a93ffc691b9c472c1759d1ff56f439d`, with unchanged source, harness and
fixtures. The second rebuilt the retained M2 binary from its pinned clean
source. Both runs verified populated migration and exact 78-relation recovery,
real VM builds and isolated runtimes, coordinated releases, approved independent
static portfolios, private receipts and cleanup with zero surviving relays.
[The M3 handoff](docs/M3-HANDOFF.md) records exact repeat commands, artifact paths,
receipt hashes, browser evidence and limits. GPT-6 Sol workers at medium
reasoning completed the bounded work; the primary integrated and verified it.

M1's two clean runs each passed 54 assertions, and M2's each passed 48.
Their historical evidence remains in the [M1 handoff](docs/M1-HANDOFF.md) and
[M2 handoff](docs/M2-HANDOFF.md). The upfront [M3 scenarios](docs/M3-SCENARIOS.md)
and completed [execution plan](docs/M3-COMPLETION-PLAN.md) retain scope and
validation decisions.

The current milestone is **M3.5 — Private beta preview**: a real dashboard,
seeded owner/project, working owned Node/PostgreSQL demo and approved independent
portfolio. Preserve the occupied legacy route/data, stage the new isolated
origin and verify the authorized exact-host cutover with rollback evidence.
The [M3.5 scenarios](docs/M3.5-SCENARIOS.md) and
[preview contract](docs/M3.5-PREVIEW-CONTRACT.md) define acceptance.
The following milestone, requiring a later assignment, is **M4 — Complete
product behavior**, ending at HOST-244.
The paid-pilot readiness release remains planned. M3 acceptance covers owned
local fixtures; customer admission remains disabled. Next.js 16 stays
unsupported, and both full gates missed the provisional throughput target.
The [runtime decision](docs/M3-RUNTIME-DECISION.md) and handoff preserve these
production-readiness deferrals. No customer execution, live payment, provider
purchase or production launch follows from milestone completion.

Keep future cards unclaimed until their prerequisites are complete and their
milestone is in the assigned scope. Consult Helm for current claimability.

## Milestone stops

| Milestone | Stop gate | Cards | Required exit evidence |
| --- | --- | --- | --- |
| **M1 — Foundation** | **HOST-242** | HOST-241, HOST-209, HOST-210, HOST-215, HOST-216, HOST-217, HOST-218, HOST-242 | Account/ownership and durable-state E2E, restart/failure cases, populated migration and platform restore receipts. |
| **M2 — Onboarding** | **HOST-243** | HOST-219, HOST-220, HOST-221, HOST-224, HOST-243 | Selected-source, compatibility, private preview and concurrent slot-admission E2E without prepurchase customer code. |
| **M3 — Working demo and portfolio** | **HOST-233** | HOST-222, HOST-223, HOST-225, HOST-226, HOST-227, HOST-229, HOST-233 | Real isolated build/runtime/database journey, failed-update retention and independent approved static portfolio. |
| **M3.5 — Private beta preview** | **HOST-248** | HOST-246, HOST-247, HOST-248 | Restricted HTTPS owner journey, durable seeded state, working demo, independent portfolio, restart/rollback and repeated browser/system receipts. |
| **M4 — Complete product behavior** | **HOST-244** | HOST-228, HOST-230, HOST-231, HOST-232, HOST-234, HOST-244 | Three layouts, screenshot/readiness, quotas and payment/retention/export/deletion E2E with an explicit test clock. |
| **M5 — Pilot readiness** | **HOST-239** | HOST-235, HOST-236, HOST-237, HOST-238, HOST-239 | Repeatable full-use evidence, reviewed test catalog, costed production dry-runs and recovery/security receipts; no launch. |

**Default agent scope is one milestone.** Parallel work may occur inside
that milestone only where the prerequisite graph permits. At its gate:

1. Finish the milestone scope and run its E2E acceptance scenarios.
2. Retain `artifacts/e2e/<milestone>/<run-id>/` with `REPORT.md`, `manifest.json`,
   sanitized outputs and the external `SHA256SUMS` receipt.
3. Verify the receipt and reproduce the assertions with a clean repeat run.
4. Hand off the exact commit, rerun command, artifact path, receipt hash,
   assertion results, cleanup outcome and remaining limitations.
5. **STOP.** Do not claim the next milestone just because its cards become
   dependency-ready. Resume only on a later instruction or an explicit larger
   assignment from Shane.

The graph enforces prerequisite completion; the instructions above enforce
the agent handoff. Helm claimability alone is not an instruction to continue.

## Testing rules

- Highly prefer E2E as the sole behavioral acceptance mechanism for complex
  features. Define scenarios and expected outcomes before implementation.
- **NEVER write unit tests after implementation code.** If isolation is
  necessary, first record all identified failure modes and expected outcomes,
  then write failing isolated cases, then implement. Document why E2E cannot
  meaningfully cover that property.
- Every E2E run, including a failed run, produces verifiable repeatable
  evidence. Missing, incomplete or failed evidence cannot pass a gate.
- Existing `make check` runs formatting, linting, builds and legacy tests.
  It is not E2E evidence. M1, M2 and M3 completion is established by the linked clean-run receipts.

The full contract, artifact fields, interruption handling and isolation
exception are in [TESTING.md](TESTING.md).

## Cards and direct prerequisites

Goals and measurable acceptance criteria are on every Helm card and in
[roadmap.json](roadmap.json). Transitive prerequisites are enforced through
the graph and omitted here when a direct link would be redundant.

| Card | Milestone | Deliverable | Prerequisites |
| --- | --- | --- | --- |
| HOST-241 | M1 | Build the real-process E2E runner and repeatable evidence bundle | None |
| HOST-209 | M1 | Implement standard project typed contract and fixtures | HOST-241 |
| HOST-210 | M1 | Implement portfolio publication typed contract and fixtures | HOST-241 |
| HOST-215 | M1 | Implement authenticated identity, ownership, and durable platform persistence | HOST-209, HOST-210 |
| HOST-216 | M1 | Add project, service, deployment, and slot-state records | HOST-215 |
| HOST-217 | M1 | Persist job lifecycle and service-scoped secret references | HOST-216 |
| HOST-218 | M1 | Establish additive migrations and populated platform backup recovery | HOST-217 |
| HOST-242 | M1 | M1 stop — verify foundation E2E and hand off | HOST-218 |
| HOST-219 | M2 | Bind selected GitHub repositories and signed events | HOST-242 |
| HOST-220 | M2 | Implement entitlement, capacity hold, slot reservation, and build meter reconciliation | HOST-242 |
| HOST-221 | M2 | Implement bounded static compatibility analysis | HOST-219 |
| HOST-224 | M2 | Provide free compatibility and editable portfolio preview | HOST-221 |
| HOST-243 | M2 | M2 stop — verify onboarding E2E and hand off | HOST-224, HOST-220 |
| HOST-222 | M3 | Evaluate gVisor runtime isolation and enforce workload controls | HOST-243 |
| HOST-223 | M3 | Provision tenant PostgreSQL with backup, restore, and export lifecycle | HOST-243 |
| HOST-225 | M3 | Run bounded builds in disposable virtual machines | HOST-243 |
| HOST-227 | M3 | Implement owner approvals and deployment-fact synchronization | HOST-243 |
| HOST-226 | M3 | Coordinate frontend, backend, migration, and last-good releases | HOST-225, HOST-222, HOST-223 |
| HOST-229 | M3 | Publish one independent static portfolio template | HOST-227 |
| HOST-233 | M3 | M3 stop — prove the working demo and portfolio E2E | HOST-226, HOST-229 |
| HOST-246 | M3.5 | Define isolated preview placement, access and preservation | HOST-233 |
| HOST-247 | M3.5 | Build durable seeded preview composition | HOST-246 |
| HOST-248 | M3.5 | M3.5 stop — deploy and verify private beta preview | HOST-247 |
| HOST-228 | M4 | Implement test-mode billing and the first-subscription seven-day refund | HOST-248 |
| HOST-230 | M4 | Enforce resource limits and ship logs, health alerts, and metrics | HOST-248 |
| HOST-231 | M4 | Complete the three launch portfolio layouts | HOST-248 |
| HOST-232 | M4 | Implement cancellation, nonpayment, export, and deletion lifecycle | HOST-228 |
| HOST-234 | M4 | Add approved screenshots and separate demo-readiness checks | HOST-230 |
| HOST-244 | M4 | M4 stop — verify product lifecycle E2E and hand off | HOST-231, HOST-232, HOST-234 |
| HOST-235 | M5 | Measure benchmark limits and full-use unit economics | HOST-244 |
| HOST-236 | M5 | Produce costed cloud placement and domain-boundary decision | HOST-235 |
| HOST-237 | M5 | Prepare provider adapters, domain/TLS configuration, and recovery runbooks | HOST-236 |
| HOST-238 | M5 | Promote measured tiers to an approved test checkout catalog | HOST-236 |
| HOST-239 | M5 | M5 stop — verify pilot readiness evidence without launching | HOST-238, HOST-237 |

## Reconciliation and verification

- Added three scoped M3.5 cards, HOST-246 through HOST-248, after the accepted
  M3 gate. M4 entry cards now depend on HOST-248; all existing IDs are preserved.
- Preserved all 27 original implementation card IDs, goals and comments while
  aligning their acceptance criteria with E2E evidence and milestone stops.
- Added HOST-241 (E2E harness), HOST-242 (M1 gate), HOST-243 (M2 gate) and
  HOST-244 (M4 gate). Retained HOST-233 and HOST-239 as the M3 and M5 gates.
- All 62 legacy cards, HOST-145 through HOST-206, remain removed. Completed
  fresh-project history HOST-207, HOST-208 and HOST-211 through HOST-214 is
  preserved. HOST-240 tracks this milestone/policy reconciliation.
- Saved private before/after board exports and read back every prerequisite
  and dependent link, release membership and unclaimed Backlog state.
- Verified unique milestone membership, the absence of cycles and redundant
  edges, full final-gate coverage, and that later work stays blocked until
  its preceding gate completes.
- Milestone membership appears in card titles and descriptions. The current
  token cannot create labels; no token scopes were changed.

When scope changes, update the live cards and edges, then refresh these
snapshots. Preserve stable IDs for still-relevant work. Retire superseded
work with recovery evidence; never mark it implemented merely because its
planning document has been written.
