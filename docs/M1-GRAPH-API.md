# M1 project graph API

M1 persists owner intent and typed references. It does not admit capacity, execute a
workload, or let an owner report health, reservation, artifacts, or removal as fact.
All routes below require a Bearer session and are scoped to its account. A missing or
cross-owner resource returns `404`.

Every write requires `Idempotency-Key`. Updates also require a quoted project revision
in `If-Match`, for example `If-Match: "3"`. An exact replay returns the stored success
before evaluating the old revision. Reusing a key with another payload returns `409`;
a distinct write against an old revision returns `412`. The mutation, audit event, and
safe replay response commit in one PostgreSQL transaction.

Stored operation names are `project.create`, `project.update/{project_id}`,
`project.configuration.create/{project_id}`,
`project.deployment_intent.create/{project_id}`,
`project.rollback_intent.create/{project_id}`,
`project.removal_intent.create/{project_id}`, and
`portfolio.draft_revision.create`.

## Projects and immutable configurations

- `POST /v1/projects`
  - Body: `{"name":"Example","configuration":<StandardProjectSpec>}`
  - Returns `201` with `{project,configuration,repositories,services}`.
- `GET /v1/projects/{project_id}` returns the current graph.
- `PATCH /v1/projects/{project_id}`
  - Body: `{"name":"New name"}`
  - Returns the updated current graph.
- `POST /v1/projects/{project_id}/configuration-revisions`
  - Body: `{"configuration":<StandardProjectSpec>}`
  - Returns `201` with the graph at the new immutable configuration revision.
- `GET /v1/projects/{project_id}/configuration-revisions/{configuration_id}` returns
  one immutable configuration, repository configuration, and its service snapshots.
- `GET /v1/projects/{project_id}/services` and
  `GET /v1/projects/{project_id}/services/{service_id}` return services from the current
  configuration.

Repository and service identities are stable across configuration revisions. Their
configuration rows are append-only snapshots. A deployment references one immutable
configuration revision, so a later edit cannot alter its inputs.

Invalid `StandardProjectSpec` input returns `422`:

```json
{
  "error": {
    "code": "invalid_project_configuration",
    "message": "the request failed contract validation",
    "request_id": "00000000-0000-4000-8000-000000000000",
    "details": {
      "issues": [
        {"code": "missing_start_command", "path": "services[0].start_command", "message": "..."}
      ]
    }
  }
}
```

Issue order is deterministic. Malformed JSON and unknown fields return `400` with the
normal safe error envelope.

## Deployment and lifecycle intent

- `POST /v1/projects/{project_id}/deployment-intents`
  - Body: `{"configuration_revision_id":"<uuid>","source_commit":"<40-or-64-lowercase-hex>"}`
  - Returns `201` with a `DeploymentRecord` in `admission_required` and empty release
    references.
- `GET /v1/projects/{project_id}/deployments/{deployment_id}` returns its immutable
  input reference and any trusted observed release references.
- `POST /v1/projects/{project_id}/rollback-intents`
  - Body: `{"target_deployment_id":"<uuid>"}`
  - The target must have a trusted observed `healthy` lifecycle; otherwise the API
    returns `409 rollback_target_ineligible`.
- `POST /v1/projects/{project_id}/removal-intents`
  - Body: `{}`
  - Records `release_pending`; it never claims that resources were removed.

An M1 deployment intent sets the project to `admission_required` with
`hosted_slots: 0`. Only a later trusted capacity observation may set `reserved` with
one slot. A retained-resource failure keeps one slot until a trusted removal
observation records `released` and zero slots.

Only one `admission_required` deployment may be unresolved for a project. A replacement
intent after a trusted observation preserves an existing `reserved` or
`resources_retained` slot. Another deployment while admission is unresolved returns
`409 deployment_intent_pending`. Only one rollback or removal intent may be requested
at a time; conflicting writes return `409 lifecycle_intent_pending`. Trusted observation
fixtures explicitly complete an intent before the next lifecycle request.

M1 has no public or private worker observation endpoint. The E2E suite seeds explicitly
labeled `trusted_observation` rows through PostgreSQL to exercise the persistence and
read boundary without implementing M2 capacity work. Artifact references are relational:
`static` must reference the static service snapshot, `application` must reference the
application snapshot, and digests must match `sha256:` plus 64 lowercase hexadecimal
characters. Public request DTOs reject lifecycle, slot, health, artifact, and secret
value fields.

## Portfolio drafts

- `POST /v1/portfolio/draft-revisions` with `{"draft":<PortfolioDraft>}` returns an
  immutable owner-scoped draft revision.
- `GET /v1/portfolio/draft-revisions/{revision_id}` returns that revision.

Hosted references must resolve to a project owned by the caller. M1 accepts only
`needs_recheck` with reason `never_checked`, no previous attestation, and a null
`authorized_deployment_facts_id`. Ready-to-share claims and client-authored deployment
facts return `422 invalid_portfolio_draft`. Portfolio and external case-study references
consume no hosted slot and authorize no publication.
