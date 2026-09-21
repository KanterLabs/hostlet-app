# Hostlet — adopted planning baseline

Adopted on 2026-09-21 in response to the plan review. These answers are the
working planning baseline and decision rationale for implementation. [PLAN.md](PLAN.md)
is canonical when this document and the plan differ. The baseline records planned
behavior, **not current capabilities, published prices, availability guarantees or
permission to provision infrastructure**. Resource numbers are starting benchmark
targets subject to validation; $5/$12/$20 are pricing hypotheses. No older Hostlet
pricing catalog or deployment decision is adopted here.

## 1. What should we build first?

Keep the existing Rust/Axum API, React/Vite dashboard and PostgreSQL direction.
Keep the React/TypeScript/Vite dashboard for the first release; a Next.js
dashboard migration is outside this baseline. Public portfolios should be
generated static artifacts regardless of the dashboard framework.

Build through the five stopping milestones in [ROADMAP.md](ROADMAP.md):

1. **M1 — Foundation:** E2E runner and evidence first, then typed project/portfolio
   contracts (`HOST-209` and `HOST-210`), accounts, ownership, durable PostgreSQL
   intent, scoped secrets/jobs, populated migrations and platform recovery.
2. **M2 — Onboarding:** selected-repository and branch access, signed events,
   bounded static compatibility, editable private preview and capacity/slot
   admission without prepurchase execution of customer code.
3. **M3 — Working demo and portfolio:** owned exact-commit fixtures, disposable
   builds, isolated runtime, a coordinated frontend/API/database release and
   one owner-approved static portfolio template. Keep admission internal.
4. **M4 — Complete product behavior:** three layouts, screenshots/readiness,
   resource enforcement, test-mode billing/refunds and cancellation, nonpayment,
   retention, export and deletion, verified across the running system.
5. **M5 — Pilot readiness:** full-use economics, reviewed test catalog, costed
   production dry-runs, security/recovery evidence and a readiness handoff.

Every milestone ends with E2E evidence, a clean repeat run and an agent STOP.
Parallel work is allowed within the current milestone where dependencies permit.
A later milestone requires its preceding gate and a subsequent instruction or
explicit larger assignment; follow [TESTING.md](TESTING.md). Never add unit tests
after implementation. Necessary isolation checks require the failure inventory
first, then failing cases, then code. Every E2E run produces a verifiable,
repeatable artifact.

The product activation milestone remains a published portfolio with a working
demo; it appears at agent stop M3. One template suffices there, while all three
remain required for paid launch. A 20-account pilot is the planning target after
M5; expand toward 30 after observing support and capacity. External contact,
charging and production use still require explicit go/no-go authorization.

## 2. What exactly uses a project slot?

One hosted project includes **one repository or monorepo, up to one static
frontend, one long-running application service and one optional PostgreSQL
database**. Static-only and API-only projects also use one hosted slot. Separate
frontend/backend repositories can be modeled later, but are outside initial
onboarding. Extra workers, scheduled jobs and additional backends are unsupported.

| State or action | Adopted planning behavior |
| --- | --- |
| Draft, compatibility check, portfolio or external case study | No hosted slot |
| First deploy accepted | Atomically reserve one slot and actual capacity before creating resources |
| First deploy fails with no retained runtime, static release or database | Release the reservation after cleanup; keep the draft and failure report |
| A database or other hosted resource already exists after failure | Retain the slot and data; offer retry or explicit export-and-remove |
| Redeploy or rollback | Same slot; temporary overlap comes from platform rollout capacity |
| App crashes, is stopped by its owner, or retains an allocated database | Slot remains reserved; do not equate unhealthy with deleted |
| Convert to showcase-only | Export and explicitly remove hosted resources, then release the slot; keep approved case-study content |
| Downgrade | Owner chooses which hosted projects to remove before renewal; never choose or delete their data automatically |

Display "Hosted slots used" with a reason such as "Database retained". Archive
is a presentation action, not an implicit resource deletion or a way to release
a slot while continuing to host its database. Reservation and cleanup operations
must be retry-safe and serialized against subscription capacity changes.
Releasing a failed reservation does not reset the account's build meter. Each
customer retry needs a valid reservation and consumes build allowance; retries
caused by a verified platform fault are credited back. Never double-reserve a slot.

### Supported patterns and starting limits

Adopt Node 24 LTS by default, Node 22 LTS as an explicitly tested alternative,
locked npm installs, Vite/static exports, a single Node HTTP service, and a tested
Next.js 16 standalone pattern as the initial customer compatibility baseline. This
targets maintained Node lines; pin patched images by digest when implementing and
recheck support before launch. [Node release policy](https://nodejs.org/en/about/previous-releases)

Require a lockfile, declared service roots and commands, an HTTP health endpoint
for application services, and PostgreSQL for durable application data. Initially
exclude arbitrary Dockerfiles/Compose, local SQLite/uploads that require persistent
app disks, custom Next.js servers and features needing extra worker services.
Reject unsupported combinations before purchase; don't silently alter their app.

Test Next.js SSR, route handlers, Server Actions and image optimization separately.
Document cache behavior and old-client handling before admitting a pattern. Public
environment values may be embedded during builds, while server secrets have a
different lifecycle; previews must identify that distinction. [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)

These are **adopted starting benchmark targets**, not promised allowances. Do not
publish the catalog until full-use tests establish both compatibility and
enforcement.

| Resource | Starting benchmark target | Behavior at the limit |
| --- | --- | --- |
| Application memory/CPU | 512 MiB memory; 0.25 vCPU ceiling per hosted project | Throttle CPU; report memory termination and apply bounded restart backoff; never call this inactivity sleep |
| Project database | PostgreSQL 18; 1 GiB including indexes; 10 application connections | Warn at 80%; prevent further growth safely at capacity while preserving reads/export; enforcement proof is a launch gate |
| App scratch storage | 256 MiB, ephemeral | Fail excess writes; clearly disclose that restarts/redeploys can discard scratch data |
| Build | 2 vCPU, 2 GiB memory, 10-minute execution timeout; one concurrent build per account | Fail only that build; preserve the live release |
| Monthly build usage | 60 execution minutes per purchased slot, pooled per account and reset on billing renewal | Queue no further customer builds until renewal; platform-fault retries do not consume allowance |
| Release artifacts | 250 MiB static output and 1 GiB unpacked runtime artifact per release; retain current plus two successful previous releases | Reject oversized replacements; never evict the current release to fit a candidate |
| Public outbound transfer | 10 GiB per purchased slot per billing month, pooled across demos and portfolio | Warn at 80% and 95%; at 100% show a limit page for public traffic while retaining app/data and authenticated export; no automatic overage charge |
| Portfolio assets | 100 MiB per account | Reject new oversized uploads; preserve the published revision |
| Logs | Seven days, at most 100 MiB per project; redact platform-known secret values | Rotate oldest logs; never stop an app because logs are full |

Resource exhaustion can interrupt a demo; "no inactivity sleep" does not mean
unlimited resources. Traffic caps and their effect must be visible before checkout.
Database CPU, memory, disk I/O and connection isolation must also be proven under
concurrent tenant load; a size counter alone cannot enforce PostgreSQL storage.
Reserve real rollout and recovery headroom outside customer allocations, including
database connections during old/new service overlap. Defer an update if that
headroom is unavailable instead of terminating the last healthy deployment.

## 3. What can we promise before payment?

Use **"Looks compatible — deployment not yet verified"** after bounded source
inspection. A manifest match is not proof that install scripts, builds, migrations
or health checks will succeed. "Configuration needed" and "Portfolio only" are
separate outcomes with specific reasons.

Before checkout, show supported patterns, required configuration, resource limits
and a portfolio preview using owner-written copy and uploaded images/placeholders.
Do not imply that an unavailable live URL or screenshot is already real. Do not
execute customer code or inject secrets during the free compatibility check.
The free step is static inspection and portfolio preview; hosting a static project
still requires a paid slot.

Reserve capacity and revalidate the selected commit/configuration before taking
payment. Use a short-lived capacity hold and idempotent entitlement reconciliation;
if payment settles after that hold is lost, refund rather than admit beyond capacity.
Payment grants permission to enqueue an isolated build, not a guaranteed successful
deployment. Only label a demo "Deployment verified" after its configured checks pass.

Adopt a **seven-day, first-subscription refund window**: an owner who cannot get
value from onboarding can cancel and request a full initial-payment refund without
having to prove whose bug caused the failure. Stop renewal and apply the disclosed
export/retention process. This is an implementation requirement, not a current
offer; implement it before publishing checkout. Later failed updates preserve the
last good release and do not independently restart the subscription/refund window.
The seven elapsed days start with the first settled subscription charge that
successfully activates service, once per account. Renewals, plan changes and
reactivation do not reset it. A capacity-admission failure receives its automatic
refund separately and does not consume the first-subscription window.

## 4. What does a safe deployment or rollback mean?

Deploy a **project release**, recording the source commit, frontend/backend artifact
digests, configuration revision, database migration revision and health results.
Retain secret-version references rather than secret values in the release record.

Build both sides, stage immutable assets, and check the candidate before switching
the routing manifest as a unit. Allow a short bounded drain for old requests.
Retain old assets and require backward-compatible frontend/API behavior during
overlap: an atomic route switch alone cannot replace JavaScript already in a browser.
For Next.js, test deployment identifiers and old Server Action requests explicitly;
the framework documents version-skew handling requirements. [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)

For database changes, use additive migrations compatible with the current and all
retained rollback releases. Verify a fresh pre-migration backup, run against a
populated isolated copy and check both application versions before production.
Run approved migrations once as a controlled job, not independently at each app
startup. Customer build jobs never receive production database credentials.
Destructive/incompatible migrations need a separate reviewed maintenance procedure;
they cannot enter automatic push-to-deploy in the first release.

A failure before traffic promotion leaves the old release serving. Compatible
migrations may remain applied. After promotion, rollback selects an eligible prior
release against the current data; it never silently restores an older database.
Configuration and required secret versions must still be valid for rollback.

Adopt encrypted daily tenant-database backups retained for seven days plus a fresh
backup before each migration. Target at most 24 hours of tenant-data loss from the
latest usable routine backup and four hours to restore an individual project after
recovery starts; these are test targets, not an SLA. For platform data, adopt hourly
backups retained 48 hours plus seven daily backups, targeting one hour of data loss
and four hours to recovery. Back up required configuration and recovery keys
separately; keep copies outside the production failure domain.

Restore into an isolated replacement database first. Validate rows, relationships,
ownership/grants and a real application connection; keep tenant role mappings
separate from the export. A database dump alone does not contain cluster-wide
roles. [PostgreSQL SQL-dump guidance](https://www.postgresql.org/docs/current/backup-dump.html)
Switching a live project to older restored data requires explicit owner approval,
the exact backup target, a pre-restore snapshot and a write/cutover plan. Prove
restore/export before the pilot, after recovery-tool changes, and in weekly
rotating drills covering every active database at least monthly.

## 5. What can change publicly, and what survives cancellation?

Publish immutable portfolio revisions with an atomic pointer update. The first
publication requires owner approval of narrative, contributions, images, contact
details, each public source/demo link and the displayed deployment, availability
and status fields.
Source access never implies publication.
Rendering must not call the dashboard, GitHub or customer applications at page load.

Allow background revision updates only for previously approved deployment facts:
the managed demo destination, deployment timestamp and availability label. Keep
an audit record for every fact-only revision; an owner-edited link returns to review
instead of being overwritten. Keep source commit hashes private unless the owner
opted to display them. Narrative,
contribution and new public fields always return to review. Default screenshot
refreshes to review too; later automation requires explicit per-project opt-in
for the capture URL and what may be published. Capture workers need the same
network boundaries as other workers that visit untrusted content.

Health and "Ready to share" remain separate. Record the owner's readiness check
time and the release it covered. A new release or demo-access change marks that
check "Needs recheck" without erasing the published case study. Never convert an
old attestation into a permanent green guarantee.

| Event | Adopted planning behavior |
| --- | --- |
| Cancel renewal | Keep included services through the paid-through date; owner can undo cancellation before then |
| Failed renewal | Seven-day payment grace with notices; keep existing demos running, block new deployments/provisioning |
| Paid period or payment grace ends | Stop hosted compute/database access, freeze deployment changes and update portfolio demo links to "Demo offline" |
| Data recovery window | Retain recoverable database data, configuration and portfolio export for 30 days after service ends; retain ordinary backups up to seven days after primary-data deletion |
| Published portfolio | Keep the last approved static portfolio for those same 30 days; then unpublish unless service resumes |
| Export | Allow authenticated portfolio HTML/assets plus structured content and a portable database dump during service and retention; reauthentication is required for any separate secret export |
| First-payment refund | End service when the refund is accepted and start the same 30-day recovery window; no additional paid-through hosting |
| Explicit account deletion | Explain consequences and require confirmation; unpublish and revoke access immediately, remove primary content/data within seven days, expire its backups within seven more; disclose any separately required billing-record retention |

Send advance expiry reminders and show actual deletion dates. Backup retention is
not permission to keep a public site online. Support reactivation from retained
data after entitlement and capacity checks. Do not recycle a deleted public slug
to a different owner during the pilot. Abuse/security suspension is a separate,
explained policy; ordinary inactivity is never a suspension reason.

## Pricing and production guardrails

Keep **$5 / $12 / $20 for 1 / 3 / 5 projects** as the prices to test, with the
three-project plan as the main offer. These remain pricing hypotheses, not an
approved catalog. Do not publish them until costs include full allocation,
database service, builds, backups, traffic, payment fees, support and
rollout/recovery capacity. Twenty fully used three-slot accounts already allocate
30 GiB of app memory and generate only $240/month at the tested price, before
those additional costs. If the numbers do not work, revise prices before checkout;
don't remove backups or introduce idle sleeping.

Use a datacenter/cloud deployment for the paid pilot. Keep homelab resources for
development and testing. Use separate management/database, build and runtime
capacity, disposable build VMs, and gVisor as the first runtime-isolation candidate
to benchmark. gVisor's isolation still needs explicit network/resource policy and
workload compatibility testing. [gVisor security model](https://gvisor.dev/docs/architecture_guide/intro/)
Serve portfolios through independent object storage/CDN publication. Use separate
registrable domains for the authenticated platform, customer applications and
portfolios; defer customer custom domains initially.

The next infrastructure decision should be a costed provider/region and isolation
proof against these workloads. A provider name and spend cap without that evidence
would be premature. No provider, domain purchase or production migration is
authorized by this baseline. `HOST-209` and `HOST-210` are the retained typed-contract
implementation cards; this document supplies their planning inputs, not evidence
that the contracts or validation gates are finished.
