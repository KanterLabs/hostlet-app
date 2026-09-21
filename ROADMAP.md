# Hostlet implementation roadmap

Planning baseline updated on 2026-09-21. [PLAN.md](PLAN.md) defines the product
and adopted behavior; [RECOMMENDATIONS.md](RECOMMENDATIONS.md) records the
decision rationale and benchmark targets. [Helm](https://tc.shanekanterman.dev/p/hostlet)
owns live execution state. This file and [roadmap.json](roadmap.json) are the
committed task/dependency snapshot, not a claim that any future work is finished.

Planned release: **Hostlet 0.1 — paid pilot readiness**. No target date is assigned. The release
ends at reviewed readiness; customer contact, live charging, infrastructure
purchases and production cutover are separate actions. Prices remain hypotheses
and numeric resource allowances remain benchmark targets until measured.

The snapshot contains **27 unclaimed Backlog tasks and
40 prerequisite links**. Every task is in the same
planned release. Prerequisites below are actual Helm edges, not just prose or
a preferred ordering. The graph is acyclic and the final gate includes every
task through its prerequisite closure.

## Start here

- **HOST-209** implements the standard-project types, invariants and fixtures.
- **HOST-210** implements portfolio content, approval and publication types.

Those two tasks can begin independently. All remaining cards have unmet
prerequisites. Keep future cards unclaimed until their required work is complete;
use Helm for current claimability instead of this dated status snapshot.

## Milestones

| Milestone | Completion evidence |
| --- | --- |
| Contracts and durable foundation | Typed fixtures, accounts and ownership, persisted intent/jobs/secrets, populated migration checks and platform recovery |
| Safe onboarding | Selected repository/branch authorization, signed events, bounded static analysis, editable preview and capacity admission |
| Internal working demo — HOST-233 | Owned full-stack fixture reaches a healthy release and an approved portfolio using one independent static template |
| Complete launch behavior | Three layouts, screenshot review/readiness, logs/alerts/limits, tenant recovery, billing/refunds and cancellation/export |
| Paid-pilot readiness — HOST-239 | Measured economics, reviewed catalog, costed production configuration/runbooks, isolation and restore evidence, without launching |

Work on separate branches of the graph may overlap. Milestones are completion
conditions, not an instruction to serialize all work in a phase.

## Cards and direct prerequisites

Full goals and measurable acceptance criteria are on each Helm card and in
[roadmap.json](roadmap.json). A dependency means the prerequisite must finish
before the dependent card can be claimed. Transitive prerequisites are enforced
through the graph and are not repeated unnecessarily.

| Card | Phase | Deliverable | Prerequisites |
| --- | --- | --- | --- |
| HOST-209 | contracts | Implement standard project typed contract and fixtures | None |
| HOST-210 | contracts | Implement portfolio publication typed contract and fixtures | None |
| HOST-215 | foundation | Implement authenticated identity, ownership, and durable platform persistence | HOST-209, HOST-210 |
| HOST-216 | foundation | Add project, service, deployment, and slot-state records | HOST-215 |
| HOST-217 | foundation | Persist job lifecycle and service-scoped secret references | HOST-216 |
| HOST-218 | foundation | Establish additive migrations and populated platform backup recovery | HOST-217 |
| HOST-219 | onboarding | Bind selected GitHub repositories and signed events | HOST-218 |
| HOST-220 | onboarding | Implement entitlement, capacity hold, slot reservation, and build meter reconciliation | HOST-218 |
| HOST-221 | onboarding | Implement bounded static compatibility analysis | HOST-219 |
| HOST-222 | delivery | Evaluate gVisor runtime isolation and enforce workload controls | HOST-220 |
| HOST-223 | delivery | Provision tenant PostgreSQL with backup, restore, and export lifecycle | HOST-220 |
| HOST-224 | onboarding | Provide free compatibility and editable portfolio preview | HOST-221 |
| HOST-225 | delivery | Run bounded builds in disposable virtual machines | HOST-221, HOST-220 |
| HOST-226 | delivery | Coordinate frontend, backend, migration, and last-good releases | HOST-225, HOST-222, HOST-223 |
| HOST-227 | portfolio | Implement owner approvals and deployment-fact synchronization | HOST-224 |
| HOST-228 | launch | Implement test-mode billing and the first-subscription seven-day refund | HOST-224, HOST-220 |
| HOST-229 | portfolio | Publish one independent static portfolio template | HOST-227 |
| HOST-230 | delivery | Enforce resource limits and ship logs, health alerts, and metrics | HOST-226, HOST-229 |
| HOST-231 | portfolio | Complete the three launch portfolio layouts | HOST-229 |
| HOST-232 | launch | Implement cancellation, nonpayment, export, and deletion lifecycle | HOST-226, HOST-229, HOST-228 |
| HOST-233 | launch | Prove the complete internal fixture journey | HOST-226, HOST-229 |
| HOST-234 | portfolio | Add approved screenshots and separate demo-readiness checks | HOST-230 |
| HOST-235 | launch | Measure benchmark limits and full-use unit economics | HOST-230, HOST-228 |
| HOST-236 | launch | Produce costed cloud placement and domain-boundary decision | HOST-235 |
| HOST-237 | launch | Prepare provider adapters, domain/TLS configuration, and recovery runbooks | HOST-236 |
| HOST-238 | launch | Promote measured tiers to an approved test checkout catalog | HOST-236, HOST-233, HOST-232 |
| HOST-239 | launch | Record paid-pilot readiness without launching | HOST-231, HOST-234, HOST-238, HOST-237 |

## Reconciliation and verification

- Refreshed HOST-209 and HOST-210 in place as implementation contracts, preserving their IDs and comments.
- Added 25 fresh implementation cards with explicit acceptance criteria.
- Confirmed all 62 legacy cards (HOST-145 through HOST-206) remain removed; no stale live cards or inherited dependencies remain.
- Preserved completed fresh-project scaffold/review history (HOST-207, HOST-208, HOST-211, HOST-212 and HOST-213). HOST-214 tracks this reconciliation.
- Saved private before/after board exports and a reconciliation record; recovery data is not committed to the public mirror.
- Read back every prerequisite and dependent link from Helm, checked release membership and Backlog/claim state, and verified the final gate covers the entire graph.

When scope changes, update the matching card and dependency links, then refresh
this snapshot and the plan. Preserve stable IDs for work that is still relevant.
Retire superseded work with recovery evidence; do not mark it implemented merely
because its planning document has been written.
