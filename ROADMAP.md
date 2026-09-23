# Hostlet implementation roadmap

Execution snapshot updated on 2026-09-23. [PLAN.md](PLAN.md) defines the product;
[RECOMMENDATIONS.md](RECOMMENDATIONS.md) records adopted answers and benchmark
targets. [TESTING.md](TESTING.md) defines the required E2E evidence and agent
stopping rules. [Helm](https://tc.shanekanterman.dev/p/hostlet) owns live task,
dependency and claim state. This file and [roadmap.json](roadmap.json) are
committed snapshots; planned acceptance is not evidence of implementation.

Planned release: **Hostlet 0.1 — paid pilot readiness**. No target date is assigned. The release
ends at reviewed readiness. Customer contact, live charging, infrastructure
purchases and production cutover remain separate authorized actions. Prices
are hypotheses and resource allowances remain benchmark targets.

The snapshot contains **31 cards (thirteen complete, two active, 16 in Backlog),
38 prerequisite links and five milestone stop gates** in one planned release. Every later milestone
depends on the preceding gate through real Helm dependencies. The acyclic
graph makes the final gate depend transitively on all 30 other cards.

## Start here

**M2 is complete at HOST-243. M3 is assigned through HOST-233; stop before M4.** All eight M1 cards and all
five M2 cards are complete. Two clean M2 runs each passed 48 assertions on the
same unchanged implementation commit, including real-browser source/preview
flows, concurrent admission, bounded compatibility, populated upgrade/restore
and retained-M1 compatibility. The second rebuilt M1 from its pinned clean source.
[The M2 handoff](docs/M2-HANDOFF.md) records exact commands, private artifact paths,
receipt hashes, CI, cleanup and limits. Sol Medium workers implemented M2;
the primary agent integrated and verified their work.

M1's two clean runs each passed 54 assertions; its historical evidence remains
in [the M1 handoff](docs/M1-HANDOFF.md). The upfront M2 inventory remains
[M2 scenarios](docs/M2-SCENARIOS.md).

The next milestone is **M3 — Working demo and portfolio**, ending at HOST-233.
HOST-222 and HOST-225 are active in Helm for runtime and disposable-VM build verification. HOST-223 and HOST-227 have completed prerequisites; later dependent cards remain unclaimed. Helm accepted both claims and structured progress; the latest dependency snapshot is revision 11758. The resumed M3 assignment uses Luna workers with Sol owning integration and verification. No M3 completion is implied. See [M3 scenarios](docs/M3-SCENARIOS.md) for the upfront acceptance inventory.
The planned paid-pilot readiness release remains planned; M2 does not authorize
customer execution, live payments, provider purchases or a production launch.
The [M3 runtime decision](docs/M3-RUNTIME-DECISION.md) retains the observed
throughput target miss as a production-readiness deferral. Owned-fixture
acceptance still requires every isolation, resource and functional gate.

Keep future cards unclaimed until their prerequisites are complete and their
milestone is in the assigned scope. Consult Helm for current claimability.

## Milestone stops

| Milestone | Stop gate | Cards | Required exit evidence |
| --- | --- | --- | --- |
| **M1 — Foundation** | **HOST-242** | HOST-241, HOST-209, HOST-210, HOST-215, HOST-216, HOST-217, HOST-218, HOST-242 | Account/ownership and durable-state E2E, restart/failure cases, populated migration and platform restore receipts. |
| **M2 — Onboarding** | **HOST-243** | HOST-219, HOST-220, HOST-221, HOST-224, HOST-243 | Selected-source, compatibility, private preview and concurrent slot-admission E2E without prepurchase customer code. |
| **M3 — Working demo and portfolio** | **HOST-233** | HOST-222, HOST-223, HOST-225, HOST-226, HOST-227, HOST-229, HOST-233 | Real isolated build/runtime/database journey, failed-update retention and independent approved static portfolio. |
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
  It is not E2E evidence. M1 and M2 completion is established by the linked clean-run receipts.

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
| HOST-228 | M4 | Implement test-mode billing and the first-subscription seven-day refund | HOST-233 |
| HOST-230 | M4 | Enforce resource limits and ship logs, health alerts, and metrics | HOST-233 |
| HOST-231 | M4 | Complete the three launch portfolio layouts | HOST-233 |
| HOST-232 | M4 | Implement cancellation, nonpayment, export, and deletion lifecycle | HOST-228 |
| HOST-234 | M4 | Add approved screenshots and separate demo-readiness checks | HOST-230 |
| HOST-244 | M4 | M4 stop — verify product lifecycle E2E and hand off | HOST-231, HOST-232, HOST-234 |
| HOST-235 | M5 | Measure benchmark limits and full-use unit economics | HOST-244 |
| HOST-236 | M5 | Produce costed cloud placement and domain-boundary decision | HOST-235 |
| HOST-237 | M5 | Prepare provider adapters, domain/TLS configuration, and recovery runbooks | HOST-236 |
| HOST-238 | M5 | Promote measured tiers to an approved test checkout catalog | HOST-236 |
| HOST-239 | M5 | M5 stop — verify pilot readiness evidence without launching | HOST-238, HOST-237 |

## Reconciliation and verification

- Preserved all 27 current implementation card IDs, goals and comments while
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
