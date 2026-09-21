# Portfolio contract v1

The Rust types in `crates/protocol/src/portfolio.rs` define the shared M1
portfolio content and publication boundary. They do not render, publish, call
AI, reserve compute, or authorize access to source repositories. Runtime
publication is an M3 responsibility.

## State boundaries

`PortfolioDraft` is owner-authored input. It deliberately contains no account,
owner, draft, or server revision ID. The API assigns those values when it creates
a `PortfolioDraftRecord`. Draft replacements produce append-only
`OwnerEditDescriptor` audit records and advance the server-controlled draft
version exactly once.

`ApprovedPortfolioRevision` is an immutable snapshot. After insertion, changes
create a new revision rather than updating the old row. Its metadata binds the
snapshot to its owner, source draft version, SHA-256 content digest, previous
revision, approval time, and audit event. Persistence code derives the approval
manifest from the stored snapshot with `required_approval_targets()`; client
manifests are never authoritative.

Each shown public value has a scoped approval target and an exact value digest.
The approval also binds to the complete revision digest and owner. Targets cover
profile and project narrative, contact details, every résumé/source/demo/evidence
link, screenshots, contributions, technical decisions, and each displayed status
field. Link and evidence targets include their project scope so repeated local IDs
cannot authorize another project's content. Hidden fields remain in the owner's
private snapshot but are not publication requirements and must not be rendered.

Repository or private README access never creates an approval. A publication API
must reject missing, duplicate, stale-value, wrong-revision, wrong-owner, or extra
approvals before persisting an approved revision or changing a public pointer.

## Deployment facts and readiness

`AuthorizedDeploymentFacts` is separate from owner narrative. It binds a managed
demo destination, deployment time, availability, status, release, and deployment
to an owner-authorized project reference. Source commits remain absent unless the
owner creates `PublicSourceCommit` opt-in metadata.

Background refresh is disabled when `fact_refresh` is absent. A present
`FactRefreshAuthorization` may name only the managed demo destination, deployment
timestamp, and availability label. An owner-edited link, narrative, contribution,
new public field, screenshot, release identifier, status copy, or source commit
must return to review. Each allowed refresh creates a new immutable revision and a
`deployment_facts_refreshed` audit event; it never mutates an approved revision.

`DemoReadiness` is independent of deployment health. A ready attestation names
one release and records the owner's check time, demo-page check, synthetic-data
check, restricted-access check, and visitor instructions. A new release or access
change retains the old attestation but changes the state to `needs_recheck`.

## Validation and static output invariants

All structs deny unknown JSON fields. `validate()` applies bounded collection,
identifier, text, digest, timestamp, ordering, and URL rules. Public web URLs must
be absolute HTTPS URLs with a host and no embedded credentials; email contacts use
a bounded `mailto:` URL. Schemes such as `javascript:`, `data:`, `file:`, and plain
HTTP are rejected.

`StaticArtifactContract` requires an empty page-load dependency list. The emitted
site therefore cannot require the Hostlet dashboard, GitHub, or a tenant
application to render. It also requires zero hosted project slots for the
portfolio and zero for external case studies. A hosted project may consume a slot
through the separate project/deployment lifecycle; referencing it from a portfolio
does not consume another slot.

The fixtures under `contracts/v1/portfolio/` use synthetic data:

- `draft-valid.json` exercises all owner-content fields, ordering, visibility,
  one hosted project, and one zero-compute external case study.
- `approved-revision-metadata-valid.json`, `owner-edit-valid.json`, and
  `authorized-deployment-facts-valid.json` exercise the separated persisted states.
- `negative-missing-approval.json` declares the expected rejection when a public
  screenshot approval is absent.
- `negative-url-scheme.json` declares the expected rejection for an executable URL
  scheme.
- `expected-outcomes.json` maps typed fixtures and scenario data to their expected
  results.

These files are contract data, not isolated tests. M1 persistence E2E will load
portfolio draft revisions and audit relationships through the running service.
M3 publication E2E must derive approvals, reject the negative cases, publish a
static artifact, stop the dashboard/GitHub/tenant endpoints, verify content and
links still load, prove the last good pointer survives a failed update, and verify
portfolio/external-case-study references do not change hosted slot counts.
