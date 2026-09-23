# M3 portfolio approval and deployment-fact contract

This is the HOST-227 boundary used by the M3 scenarios. It does not publish a
site. HOST-229 consumes its approved snapshot and current fact heads without
receiving private source or preview context that is not explicitly public.

All routes require the explicit owned-fixture M3 mode. Owner routes use the
normal authenticated session. The fact refresh route uses the runtime worker
role; build, database, generic M1 and future publisher credentials are rejected.

## Exact owner review

`GET /v1/portfolio/publication-review?draft_revision_id=<uuid>` loads an owned,
immutable draft revision and its appearance. The server derives every approval
target from stored content. For displayed deployment fields it reads only the
current healthy `application_releases` row selected by
`project_release_routes`; the caller cannot provide a URL, time, availability,
release, deployment or commit.

The response contains the snapshot, appearance, trusted public deployment
values, every target and exact value digest, and one domain-separated SHA-256
review digest over all of them. Hidden sections have no target and are excluded
from the later public document. A source commit is absent unless the draft's
explicit `displayed_status.source_commit` opt-in is true.

Appearance follows the latest preview context at or before the selected draft,
matching the M2 preview inheritance rule. Approval locks the account, rejects a
historical draft when a newer draft exists, and holds a shared lock on the
selected route/release rows through commit.

`POST /v1/portfolio/approved-revisions` requires an `Idempotency-Key` and:

```json
{
  "draft_revision_id": "uuid",
  "review_digest": "sha256:...",
  "approval": {
    "type": "entire_revision",
    "review_digest": "sha256:..."
  },
  "refresh_authorizations": [
    {
      "project_reference_id": "project-ref",
      "fields": ["deployment_timestamp", "availability_label"]
    }
  ]
}
```

The alternative `individual_fields` form supplies every server-returned target
and value digest exactly once. A recorded entire-revision approval expands to
the same immutable per-target approval array. The API recomputes the review
inside the approval transaction, so a changed draft, promoted route or public
fact produces `stale_publication_review`. Missing, duplicate, extra, stale or
wrong-owner approvals do not write an approved revision.

An approved revision stores the source draft, appearance, derived requirements,
expanded approvals, refresh scope and audit event in immutable rows. Deployment
facts are separate immutable revisions. The draft remains private owner input;
the approval operation never writes facts into a draft or treats repository
access as publication permission.

Per-account approval sequences and per-project readiness-event sequences are
monotonic database identities. Head selection uses these sequences, not policy
timestamps or random UUID ordering, because the shared policy clock may stay
fixed across several valid events.

`GET /v1/portfolio/approved-revisions/latest` returns the newest owner approval,
the current immutable deployment-fact head for each referenced project and the
current readiness event. HOST-229 must materialize its public document from this
response shape or the equivalent transaction-local query. It must filter hidden
content and must never pass compatibility/source context or unapproved fields to
the publisher.

The materializer parses appearance into the exact public shape `{layout,
typography, accent}` and validates the supported values. It rejects malformed or
expanded preview context instead of copying raw preview JSON, so project,
configuration, source and compatibility-report context cannot enter a
publication document.

## Narrow fact refresh

At approval time an owner may authorize only:

- `managed_demo_destination`, when an approved demo link exactly equals the
  trusted managed destination;
- `deployment_timestamp`, when that status field is displayed; and
- `availability_label`, when that status field is displayed.

`POST /internal/v1/portfolio/deployment-fact-refreshes` accepts only a
`source_release_id`. It verifies that release is the current healthy routed
release and reads destination, promotion time, availability and demo-access
revision from trusted release tables. It never accepts caller-authored fact
values.

Each effective refresh appends a fact revision with its predecessor, source
release and deployment, changed public facts, exact scope, digest and audit
event. The displayed release identifier and opted-in source commit remain at
their owner-approved values. Narrative, contributions, evidence, new fields and
screenshots never change. If the latest draft changed the approved managed demo
link, destination refresh is suspended while independently authorized time or
availability refreshes may continue. Draft edits remain intact and reviewable.
Repeated events produce no duplicate revision, account-scoped serialization
closes the concurrent-delivery window, and immutable uniqueness is the database
backstop.

After all effective fact and readiness rows are appended, the same transaction
materializes the updated public document and queues at most one publication for
each changed approved revision. The enqueue operation is digest-idempotent: it
does nothing when no public site exists or the same approved revision and public
document digest is already queued or recorded. Materialization, publication
enqueue and its audit event commit with the fact refresh; any enqueue failure
rolls the entire refresh back.

Every successful release or rollback activation invokes this same transaction-
local refresh after the healthy route and release facts are written. It uses the
activated source release, locks the account before reconciliation and route
state, and commits fact revisions, readiness changes, and at-most-one
publication enqueue atomically with activation. With no approved fact head it
is an intentional no-op; callers do not need a separate refresh request.

## Readiness

Readiness history is separate from release health and fact history. Initial
approved facts start at `needs_recheck/never_checked`.
`POST /v1/portfolio/readiness-attestations` requires an idempotency key, the
current fact revision, all four owner checks, and bounded visitor instructions.
It appends `ready_to_share`; it never derives readiness from health.

A new source release or a changed trusted `demo_access_revision` appends
`needs_recheck`, links to the prior event and carries forward the prior
attestation as history. It does not erase the approved case study. The shared M3
policy clock supplies approval, fact and readiness lifecycle timestamps; session
expiry and idempotency synchronization keep real time.

## Publisher handoff

HOST-229 should add a `PublicPortfolioDocument` with only shown approved values,
current fact heads and current readiness state. It should be persisted in an
immutable publication revision before a publisher lease is exposed. The
publisher receives that document, the approved layout and a site slug; it must
not receive the raw draft, GitHub/source context, private commit, or a database
credential.

The one-template artifact should contain an index, project detail pages and
local CSS/assets. Rendering escapes text, validates public HTTPS/mailto links,
and performs no arbitrary network fetch. Approved screenshot URLs are rejected
as `unsupported_external_image` until the input contract supplies materialized
image bytes, so a public page cannot depend on a remote image host. A successful
worker writes a complete temporary tree, validates its manifest and digest,
renames it to an immutable digest path, then atomically renames a same-filesystem
`current` symlink. The independent server reads only that artifact root. A
failed or stale worker never changes `current`; a crash after the symlink swap
is reconciled as the successful digest already being served.

## Failure inventory mapping

- Malformed IDs, unknown JSON fields, invalid URL/state, foreign ownership and
  absent M3 mode fail before durable effects.
- Missing, extra, duplicate, stale-value and stale-revision approvals fail the
  owner transaction. Exact idempotent replay returns one stable revision;
  changed-key reuse conflicts.
- A missing/noncurrent/unhealthy release, missing destination or promotion time,
  or unsupported availability cannot become authorized facts.
- Duplicate/concurrent refresh, restart and an owner edit race append at most one
  fact head and never mutate a draft or approved revision.
- New releases and access changes invalidate readiness without deleting the
  previous attestation. Availability changes alone do not attest readiness.
- PostgreSQL transaction failure leaves approval, facts, readiness, audit and
  idempotency state all committed or all absent.

The browser/HTTP/PostgreSQL scenarios in `M3-SCENARIOS.md` are the acceptance
evidence. No isolated or post-implementation unit suite is introduced.
