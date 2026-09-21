# Hostlet — portfolio and live demos

Authoritative product direction for `hostlet-app`, based on the brief supplied
by Shane on 2026-09-21. This supersedes the provisional September generic-hosting
baseline recorded in the initial scaffold commit. Older Hostlet documents and
completed cards do not establish requirements or implementation evidence here.

Concrete proposed answers to the review questions are recorded in
[RECOMMENDATIONS.md](RECOMMENDATIONS.md). They cover implementation order, hosted
slots, compatibility/payment, release recovery and portfolio/cancellation behavior.
Their numeric limits and policies remain proposals until accepted and validated.

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
2. Check compatibility before purchase. Distinguish ready, configuration needed,
   database needed, secrets needed and showcase-only unsupported repositories.
3. Infer framework, root directory, build/output/start settings and variable names
   where reliable; ask for confirmation when uncertain. Never infer secret values.
4. Preview the portfolio and resolve configuration before activating paid hosting.
5. Deploy supported applications and collect the owner's introduction, target
   role, résumé, contact details and project contributions.
6. Attach healthy live URLs and approved screenshots to the draft. The owner
   reviews claims and publication permissions, then publishes.
7. Keep deployment facts synchronized; suggest narrative changes without
   overwriting the owner's edits.

Prepurchase compatibility analysis is not an entitlement to execute arbitrary
customer code. Begin with bounded static inspection; any later build validation
requires the same isolation and explicit cost/admission limits as paid builds.

## Standard project: draft contract

A project is one demonstrable application, not necessarily one repository or
container. Model `Account -> Projects -> Services -> Deployments`; portfolios
reference projects and their authorized public deployment facts.

The proposed standard project includes one static frontend where applicable,
one always-running application process and one optional small PostgreSQL database.
The first release may accept one repository or monorepo per project, while the
model allows a future frontend/backend split across repositories.

Initial supported scope is small JavaScript/TypeScript web applications: static
frontends and an explicitly documented set of Node/Next.js patterns, plus
PostgreSQL. A 512 MiB backend is a measurement starting point, not an approved
universal allocation or compatibility guarantee. Python and other runtimes follow.

Before implementation freezes this contract, specify the supported versions and
build patterns, service-count semantics, CPU/memory, database size/connections,
static/artifact storage, transfer, build usage, backup retention and deployment
headroom. Each limit needs units, enforcement behavior and a customer-visible
failure explanation. Extra workers/backends or larger databases require explicit
future options, not unlimited inclusion in one slot.

## Portfolio and demo readiness

- Begin with three layouts sharing a structured content model. Allow typography,
  accent, project order and section visibility; defer a drag-and-drop page builder.
- Include introduction, featured projects, skills, résumé/contact links and project
  detail pages covering purpose, contribution, technical decisions and evidence.
- Require owner confirmation of contribution and technical claims. Optional AI
  drafts use approved inputs, exclude secrets and never invent statistics or work.
- Private source access is not publication permission. Explicitly approve public
  descriptions, screenshots and source links; a private README is not public copy.
- Publish approved revisions as static sites independent of dashboard, GitHub and
  app availability. A failed deployment cannot replace the last published portfolio.
- Portfolio pages and external case studies do not consume live-project slots.
- Track "Ready to share" separately from deployment health: the owner verifies the
  demo page, synthetic example data, restricted demo access and visitor instructions.
- Initial demo access is configuration and guidance. Automatic guest-mode injection
  and arbitrary data resets are not promised. Later resets require application support.

## Availability, data and billing behavior

Admitted paid apps do not sleep due to inactivity. This does not promise zero
crashes, maintenance or outages. Build allowances may block new builds without
stopping an existing deployment. Build and health-check replacements before
switching traffic; keep the previous healthy version on failed updates.

Included databases must not sleep or expire silently. Small project databases,
backups and a tested restore/export path are first-release scope in this brief,
superseding the earlier no-operational-backups plan. Platform data also needs an
explicit preservation/recovery policy. RPO/RTO and retention are not yet promised.
Application rollback does not reverse database migrations; require compatible
changes and a separately scoped restore procedure. Populated upgrades require
verified pre-upgrade backups and retained-binary compatibility.

Paid-only live compute follows compatibility checking and portfolio preview.
Proposed monthly prices are hypotheses: Starter 1 project/$5, Portfolio 3/$12,
Builder 5/$20. Every proposed tier includes the portfolio, templates, HTTPS,
automatic deployments and basic logs. These are not an approved catalog; do not
create Stripe prices or publish checkout from this document.

Define nonpayment, abuse, exhaustion, cancellation, export and deletion retention
explicitly. Keep them distinct from inactivity. Model full slot use, databases,
builds, backups, bandwidth, payment costs, support and rollout/spare capacity.
Do not inherit the old $15/$35/$75 catalog or legacy subscriptions.

## Architecture and current scaffold

| Boundary | Planned responsibility | Current state |
| --- | --- | --- |
| Control API | Accounts, GitHub, configuration, secrets, subscriptions, durable intent | Rust/Axum health and version skeleton |
| Web dashboard | Compatibility, setup, portfolio editing, demo readiness | React/TypeScript/Vite development shell |
| Platform PostgreSQL | Authoritative account/project/service/deployment and content records | No database/schema connected |
| Builder | Exact-commit source, isolated builds, bounded artifacts and reports | Rust CLI skeleton; refuses real work |
| Runtime | Isolated workloads, routing, resource limits, health and logs | Rust CLI skeleton; refuses real work |
| Project data | Tenant-isolated PostgreSQL, backup, restore and export | Unimplemented |
| Portfolio publisher | Approved structured revisions to independent static artifacts | Boundary documented; unimplemented |

Next.js is a proposed dashboard choice, not a mandate to replace the existing
React scaffold. Decide SSR/prerendering needs before that change. Public portfolios
must support independent static publication regardless of dashboard framework.
Rust 1.96.0, Node 22.22.1, `/v1` and `hostlet.agent/v1` are current scaffold
implementation choices, not requirements implied by the new brief.

Customer builds and workloads are untrusted. Retain isolated build execution,
stronger runtime isolation evaluation (gVisor or microVMs), resource/egress limits,
separate management networks and separate domains for trusted UI and untrusted
content. No tenant Docker socket or management access. Signed GitHub events must
match authorized repositories/branches. Build load cannot starve live demos.

The brief recommends homelab development/testing and rejects relying on residential
connectivity for paid availability. Production placement, provider and spend are
unresolved: do not provision or migrate based on the older homelab-only decision.
Domain assignments for platform, demos and published portfolios also need a fresh
trust-boundary decision. Existing infrastructure and provider records remain intact.

## Review and implementation order

The brief is coherent around one outcome; the largest new obligations are database
lifecycle/recovery and independent portfolio publishing. Low slot prices depend on
measured full-use economics. Keep these obligations visible rather than implementing
only deployment and postponing the differentiating portfolio experience.

1. Freeze the standard-project compatibility/resource contract (`HOST-209`) and
   portfolio content/publication contract (`HOST-210`). Both are unclaimed Backlog
   cards for this new direction. Record unresolved values instead of treating
   recommendations as approvals.
2. Implement authoritative persistence, identity, ownership checks, scoped secrets
   and project/service records before accepting repository bindings or draft content.
   Establish populated-data migration and backup/recovery checks with this foundation.
3. Implement selected-repository binding, bounded compatibility analysis and an
   editable portfolio preview before paid-compute activation.
4. Prove an internal journey using owned fixtures: an isolated build, coordinated
   frontend/backend release, project database and reviewed static portfolio using
   one template. Customer execution remains gated on entitlements and capacity.
5. Complete all three templates, screenshots, independent demo-readiness state,
   the supported Node/Next.js patterns, approved slot billing, no-idle-sleep behavior,
   last-good releases, backup/restore/export and cancellation/retention controls.
6. Prove the complete journey, tenant isolation, data recovery and full-use economics
   before a small paid pilot. Measure unaided activation, time to publish, demo
   durability, full-allowance costs, résumé use and post-job-search retention.

A 20–30 person paid pilot is a proposal, not authorization to contact customers,
charge accounts or spend money. Arbitrary Compose, GPUs, hosted dev environments,
teams, job boards, recruiter matching and AI résumé generation remain deferred.

No competitor pricing or cited vendor claims are adopted as verified facts here;
recheck them if later used in public positioning or an economic model.
