# Hostlet — portfolio and live demos

Authoritative product direction for `hostlet-app`, based on the brief supplied
by Shane on 2026-09-21. This supersedes the provisional September generic-hosting
baseline recorded in the initial scaffold commit. Older Hostlet documents and
completed cards do not establish requirements or implementation evidence here.
`PLAN.md` is the canonical current plan. [RECOMMENDATIONS.md](RECOMMENDATIONS.md)
records the adopted planning rationale and detailed validation candidates, while
[ROADMAP.md](ROADMAP.md) is the implementation ordering and dependency source.

M1 is complete at HOST-242. The verified local control foundation and its limits
are described in [README.md](README.md) and the [M1 handoff](docs/M1-HANDOFF.md).
M2 acceptance passed through HOST-243: GitHub onboarding, synthetic admission,
bounded static compatibility and private preview passed two clean 48-assertion
runs. The [M2 handoff](docs/M2-HANDOFF.md) records verified receipts and limits. M3 is assigned through HOST-233 with Sol Medium workers; M4 and later remain unclaimed. The upfront acceptance inventory is docs/M3-SCENARIOS.md. The product and
lifecycle defaults below are adopted planning requirements for implementation;
they are not current capabilities, a published price catalog or permission to
provision infrastructure. Resource numbers are starting benchmark targets, and
$5/$12/$20 are pricing hypotheses subject to full-use validation. Provider,
spend, domain-purchase and production-migration decisions require separate
authorization.

> Your projects, live and ready to show.

## Customer and outcome

Start with students and early-career web developers who already have projects
and want a professional link for applications. Hostlet combines deployment,
ongoing hosting and presentation: connect GitHub, select supported projects,
resolve missing configuration, and publish a reviewed portfolio with live demos.

Activation means a published portfolio with at least one working demo. A GitHub
connection or a running process alone is insufficient. Hosting is infrastructure
underneath that outcome; the product is not a general cloud console.

## Customer journey

1. Connect a least-privilege GitHub App and choose accessible repositories.
2. Run a bounded pre-purchase compatibility advisory. Distinguish "Looks
   compatible — deployment not yet verified", configuration needed, database
   needed, secrets needed and portfolio-only unsupported repositories.
3. Infer framework, root directory, build/output/start settings and variable names
   where reliable; ask for confirmation when uncertain. Never infer secret values.
   The free check performs static inspection only: it does not execute customer
   code or inject secrets.
4. Preview the portfolio, show supported patterns and limits, and resolve
   configuration before activating paid hosting.
5. Deploy supported applications and collect the owner's introduction, target
   role, résumé, contact details and project contributions.
6. Attach healthy live URLs and approved screenshots to the draft. The owner
   reviews claims and publication permissions, then publishes.
7. Keep deployment facts synchronized; suggest narrative changes without
   overwriting the owner's edits.

Prepurchase compatibility analysis is not an entitlement to execute arbitrary
customer code. Begin with bounded static inspection; any later build validation
requires the same isolation and explicit cost/admission limits as paid builds.

## Standard project and slot contract

A project is one demonstrable application, not necessarily one repository or
container. Model `Account -> Projects -> Services -> Deployments`; portfolios
reference projects and their authorized public deployment facts. The typed
standard-project and portfolio contracts, with owned fixtures, are the
implementation work retained under `HOST-209` and `HOST-210`.

The first-release standard project includes one repository or monorepo, up to one
static frontend, one long-running application service and one optional small
PostgreSQL database. Static-only and API-only projects each use one hosted slot.
The model can represent a future frontend/backend split across repositories, but
separate repositories, extra workers, scheduled jobs and additional backends are
outside initial onboarding.

Drafts, compatibility checks, portfolios and external case studies consume no
hosted slot. The first accepted deployment atomically reserves one slot and
capacity before creating resources. If a deployment fails before any runtime,
static release or database remains, cleanup releases the reservation while
retaining the draft and failure report. If a database or other hosted resource
remains, retain the slot and data and offer retry or explicit export-and-remove.
Redeploys and rollbacks use the same slot; temporary overlap consumes rollout
headroom. Crashes, owner stops and retained databases keep the slot reserved.
Converting to showcase-only requires export and explicit resource removal before
releasing the slot. On downgrade, the owner chooses projects to remove; the
platform never chooses or deletes data automatically. Reservation and cleanup are
retry-safe and serialized against subscription capacity changes.

Initial supported scope is small JavaScript/TypeScript web applications: Vite or
other static exports, one Node HTTP service and an explicitly tested Next.js 16
standalone pattern, plus PostgreSQL. Node 24 LTS is the default customer runtime
and Node 22 LTS is an explicitly tested alternative. Require a lockfile and
declared service roots and commands. Long-running application services require an
HTTP health endpoint; applications with durable data use PostgreSQL. Static-only
projects require neither a service endpoint nor a database. A 512 MiB backend,
other resource values and the full supported
pattern list are starting benchmark targets; enforcement and compatibility must
be proven before launch. Python and other runtimes follow a later compatibility
decision.

Each benchmark limit needs units, enforcement behavior and a customer-visible
failure explanation. The detailed starting targets are in
[RECOMMENDATIONS.md](RECOMMENDATIONS.md); full-use tests must establish both
compatibility and enforcement before publishing a catalog. Extra workers,
backends or larger databases require explicit future options, not unlimited
inclusion in one slot.

## Portfolio and demo readiness

- Begin with three layouts sharing a structured content model. Allow typography,
  accent, project order and section visibility; defer a drag-and-drop page builder.
- Include introduction, featured projects, skills, résumé/contact links and project
  detail pages covering purpose, contribution, technical decisions and evidence.
- Require owner confirmation of contribution and technical claims. Optional AI
  drafts use approved inputs, exclude secrets and never invent statistics or work.
- Private source access is not publication permission. The first publication
  requires explicit approval of public descriptions, contribution claims,
  screenshots, contact details, each source/demo link and displayed
  deployment, availability and status fields; a private README is not public copy.
- Publish immutable approved revisions as static sites independent of the
  dashboard, GitHub and app availability. A failed deployment cannot replace the
  last published portfolio, and rendering must not call those systems at page load.
- Background updates may change only previously approved deployment facts such as
  the managed demo destination, deployment timestamp and availability label. Audit
  every fact-only revision. Owner-edited links, narrative, contribution claims,
  new public fields and screenshot refreshes return to review; keep source commit
  hashes private unless the owner opts in.
- Portfolio pages and external case studies do not consume live-project slots.
- Track "Ready to share" separately from deployment health: the owner verifies the
  demo page, synthetic example data, restricted demo access and visitor instructions.
  Record the check time and covered release. A new release or demo-access change
  marks readiness as "Needs recheck" without erasing the published case study.
- Initial demo access is configuration and guidance. Automatic guest-mode injection
  and arbitrary data resets are not promised. Later resets require application support.

## Availability, data and billing behavior

Admitted paid apps do not sleep due to inactivity. This does not promise zero
crashes, maintenance or outages. Build allowances may block new builds without
stopping an existing deployment. Build and health-check replacements before
switching traffic; keep the previous healthy version on failed updates.

Deploy a project release that records the source commit, frontend and backend
artifact digests, configuration revision, database migration revision and health
results. Build both sides, stage immutable assets, check the candidate and switch
the routing manifest as one unit with a bounded drain. Retain the current release
and two successful previous releases. Require backward-compatible frontend/API
behavior during overlap because an atomic route switch cannot replace JavaScript
already in a browser. A pre-promotion failure leaves the previous release serving;
after promotion, rollback selects an eligible prior release against current data.
Rollback never silently restores an older database, and retained secret-version
references and configuration must still be valid.

Included databases must not sleep or expire silently. Small project databases,
backups and a tested restore/export path are first-release scope in this brief,
superseding the earlier no-operational-backups plan. Use additive database
migrations compatible with the current and retained releases. Take a fresh backup,
test against a populated isolated copy and check both application versions before
production. Run each approved migration once as a controlled job; customer build
jobs never receive production database credentials. Incompatible migrations need a
separate reviewed maintenance procedure. Populated upgrades require verified
pre-upgrade backups and retained-binary compatibility.

Encrypt daily tenant-database backups and retain them for seven days; take a fresh
backup before each migration. Target at most 24 hours of tenant-data loss from the
latest usable routine backup and four hours to restore one project after recovery
starts. For platform data, retain hourly backups for 48 hours plus seven daily
backups, targeting one hour of data loss and four hours to recovery. These are test
targets, not an SLA. Back up required configuration and recovery keys separately,
outside the production failure domain. Restore into an isolated replacement first,
validate rows, relationships, ownership/grants and a real application connection,
and keep tenant role mappings separate from portable data. Switching a live project
to older restored data requires owner approval, an exact backup target, a
pre-restore snapshot and a write/cutover plan. Prove restore/export before the
pilot, after recovery-tool changes, and in rotating drills covering every active
database at least monthly.

Paid-only live compute follows compatibility checking and portfolio preview.
The prices to test are $5/$12/$20 for 1/3/5 projects, with the three-project plan
as the main offer. These are pricing hypotheses, not an approved catalog; do not
create Stripe prices or publish checkout until full-use economics cover allocation,
databases, builds, backups, traffic, payment fees, support and rollout/recovery
capacity. Every tested tier includes the portfolio, templates, HTTPS, automatic
deployments and basic logs.

Before payment, reserve capacity and revalidate the selected commit and
configuration. A short-lived capacity hold and idempotent entitlement
reconciliation must refund a settled payment if the hold is lost. Payment grants
permission to enqueue an isolated build, not a guaranteed successful deployment.
Adopt a seven-day first-subscription refund window once per account: the clock
starts with the first settled subscription charge that successfully activates
service; renewals, plan changes and reactivation do not reset it. An owner can
cancel and request a full initial-payment refund without proving fault. Stop
renewal and apply the disclosed export/retention process. A capacity-admission
failure receives its automatic refund separately and does not consume this window;
later failed updates preserve the last good release and do not restart it.

Adopt explicit nonpayment, abuse, resource-exhaustion, cancellation, export and
deletion-retention policies, and keep them distinct from inactivity. Abuse and
security suspension are separate, explained policies. Model full slot use,
databases, builds, backups, bandwidth, payment costs, support and rollout/spare
capacity.
Do not inherit the old $15/$35/$75 catalog or legacy subscriptions. On cancellation,
keep included services through the paid-through date and allow the owner to undo
the cancellation. A failed renewal gets seven days of payment grace with existing
demos running while new deployments and provisioning are blocked. When the paid
period or grace ends, stop hosted compute/database access, freeze deployment
changes and mark portfolio demo links "Demo offline". Retain recoverable database
data, configuration, portfolio export and the last approved static portfolio for
30 days after service ends; ordinary backups may remain up to seven days after
primary-data deletion. Provide authenticated HTML/assets, structured content and a
portable database dump during service and retention, with reauthentication for
separate secret export. A first-payment refund ends service when accepted and
starts the same 30-day recovery window. Explicit account deletion requires
confirmation, unpublishes immediately, removes primary data within seven days and
expires its backups within seven more; disclose separately required billing
retention. Show actual deletion dates and do not recycle a deleted public slug
during the pilot. Ordinary inactivity never suspends service.

## Architecture and current scaffold

The initial stack is Rust/Axum for the control API, React/TypeScript/Vite for the
dashboard, PostgreSQL for durable control and project data, Rust supervisors for
isolated builder/runtime boundaries, and independent static portfolio artifacts.
The customer compatibility baseline uses the Node versions and patterns above;
it does not change the dashboard stack.

| Boundary | Planned responsibility | Current state |
| --- | --- | --- |
| Control API | Accounts, GitHub, configuration, secrets, subscriptions, durable intent | Rust/Axum health and version skeleton |
| Web dashboard | Compatibility, setup, portfolio editing, demo readiness | React/TypeScript/Vite development shell |
| Platform PostgreSQL | Authoritative account/project/service/deployment and content records | No database/schema connected |
| Builder | Exact-commit source, isolated builds, bounded artifacts and reports | Rust CLI skeleton; refuses real work |
| Runtime | Isolated workloads, routing, resource limits, health and logs | Rust CLI skeleton; refuses real work |
| Project data | Tenant-isolated PostgreSQL, backup, restore and export | Unimplemented |
| Portfolio publisher | Approved structured revisions to independent static artifacts | Boundary documented; unimplemented |

The dashboard baseline remains React/TypeScript/Vite; a Next.js dashboard migration
is not part of the first release. Public portfolios must support independent static
publication regardless of dashboard framework.
Rust 1.96.0, Node 22.22.1, `/v1` and `hostlet.agent/v1` are current scaffold
implementation choices, not requirements implied by the new brief.

Customer builds and workloads are untrusted. Retain isolated build execution,
stronger runtime isolation evaluation (gVisor or microVMs), resource/egress limits,
separate management networks and separate domains for trusted UI and untrusted
content. No tenant Docker socket or management access. Signed GitHub events must
match authorized repositories/branches. Build load cannot starve live demos.

The brief recommends homelab development/testing and rejects relying on residential
connectivity for paid availability. Keep production placement deferred until a
costed provider/region and isolation proof cover these workloads; provider, spend,
domain purchase and production migration require explicit authorization. Existing
infrastructure and provider records remain intact.

## Review and implementation order

The brief is coherent around one outcome; the largest obligations are database
lifecycle/recovery, coordinated releases and independent portfolio publishing. Low
slot prices depend on measured full-use economics. Helm is the live execution state
for cards and progress. [ROADMAP.md](ROADMAP.md) and
[roadmap.json](roadmap.json) are committed repository snapshots of the dependency
graph and milestone ordering, mirrored from Helm; updating execution status does
not require changing this plan. They preserve the existing `HOST-209` and
`HOST-210` IDs.

The five milestones are **agent stopping points**. Default execution scope is one
milestone. Tasks within that milestone can run in parallel where Helm's actual
prerequisite edges permit; every later milestone depends on the preceding stop
gate. Completing a gate makes later work dependency-ready, but does not instruct
an agent to claim it. Publish the evidence and handoff, then stop. Continue only
on a later instruction or an explicit larger scope from Shane.

| Milestone | Deliverable at the stop |
| --- | --- |
| **M1 — Foundation** | First establish the real-process E2E runner and artifact contract; then typed project/portfolio contracts, authenticated ownership, durable PostgreSQL records, scoped secrets/jobs, additive migrations and platform recovery. |
| **M2 — Onboarding** | Selected-repository and branch authorization, signed events, bounded compatibility analysis, editable private preview, capacity admission and slot accounting. No prepurchase execution of customer code. |
| **M3 — Working demo and portfolio** | An owned fixture travels from exact commit through a disposable VM build and isolated runtime to a coordinated frontend/backend/database release, then an owner-approved independent static portfolio. Prove failed-update retention. |
| **M4 — Complete product behavior** | Three templates, screenshot approval and demo readiness, resource enforcement and actionable health/logs, test-mode billing/refunds, cancellation, nonpayment, retention, export and deletion. |
| **M5 — Pilot readiness** | Measured full-use economics, reviewed test catalog, costed provider/domain configuration and dry-run runbooks, linked security/recovery evidence and a final readiness handoff. Stop without launching. |

[TESTING.md](TESTING.md) is binding for implementation and gate completion.
Highly prefer E2E as the sole behavioral acceptance mechanism for complex
features, using real running boundaries. Define scenarios and expected outcomes
before implementation. **NEVER write unit tests after implementation code.** If
isolation is necessary, first write all identified ways the system could fail
and the expected outcomes, then write failing isolated cases, then implement.
Record why E2E cannot exercise that property meaningfully.

Every E2E run produces a verifiable, repeatable artifact with a readable report,
machine assertions, exact commit/environment/fixtures and rerun command, relevant
sanitized outputs, checksums and cleanup results. Gates require verified evidence
and a clean repeat run before the agent hands off and stops. Current `make check`
and legacy tests are routine scaffold checks, not E2E milestone evidence. The
scaffold runner is documented in [e2e/README.md](e2e/README.md); each foundation
and later milestone still requires its own running-system evidence and gate.

Use a 20-account paid pilot as the planning target after M5 and expand toward 30
only after observing support and capacity. Measure unaided activation, time to
publish, demo durability, full-allowance costs, résumé use and post-job-search
retention. Real customer outcomes are collected after an authorized launch.

The pilot target does not authorize external contact, charges, provider spend or
production migration. Arbitrary Compose, GPUs, hosted development environments,
teams, job boards, recruiter matching, AI résumé generation, custom domains,
automatic guest-mode injection and Python or other untested runtimes remain
deferred.

No competitor pricing or cited vendor claims are adopted as verified facts here;
recheck them if later used in public positioning or an economic model.
