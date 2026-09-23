# M3 independent portfolio publisher contract

HOST-229 consumes only the immutable public document produced by HOST-227. The
publication row contains that document and its canonical SHA-256 digest; it
does not contain a draft, source-provider context, compatibility output, tenant
credentials, or other private preview state.

## Owner HTTP boundary

All owner routes require M3 owned-fixture mode and the normal authenticated
session. `POST /v1/portfolio/publications` requires `Idempotency-Key` and:

```json
{"approved_revision_id":"uuid","slug":"owned-site"}
```

The slug is normalized lowercase ASCII and must match
`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`. It is globally reserved and remains
owned by one account. The operation locks the account and site, materializes
the public-only document inside the transaction with
`load_public_portfolio_document`, and appends an immutable queued publication.
An exact idempotent replay returns the same publication; changed input conflicts.
Portfolio publication does not reserve or consume a hosted-project slot.

`GET /v1/portfolio/publications/{publication_id}` returns the owned publication
state. `GET /v1/portfolio/publications/latest` returns the latest owner
publication or 404. Responses have this stable shape:

```json
{
  "id":"uuid", "approved_revision_id":"uuid", "slug":"owned-site",
  "cause":"owner_request", "state":"queued", "document_digest":"sha256:…",
  "artifact_digest":null, "pointer_generation":null, "failure_code":null,
  "created_at":"RFC3339", "updated_at":"RFC3339", "published_at":null
}
```

After an effective authorized deployment-fact refresh, the approval flow calls
`portfolio_publish::enqueue_fact_refresh_publication` in its existing account-
locked transaction. If the account has a prior public site, it materializes a
new public document for the same approved revision and slug. A unique
`(account, approved revision, document digest)` key makes repeated delivery a
no-op. The new document can differ only because HOST-227 changed an authorized
fact head/readiness state; it never rewrites owner narrative or owner-edited
links. The append gets its own audit event.

## Publisher worker boundary

Only `m3::PublisherWorkerAuth` is accepted. Build, runtime, database and generic
worker tokens are rejected.

- `POST /internal/v1/portfolio-publications/lease` with
  `{"worker_id":"publisher-1"}` returns 204 or a publication, immutable public
  document, staging-relative directory, attempt ID, fence and real-time expiry.
- The worker renders locally without network access into that exact staging
  directory and writes `manifest.json` last.
- `POST /internal/v1/portfolio-publications/{id}/complete` with worker, attempt,
  fence, outcome and (on success) artifact digest asks control to validate and
  promote. A successful completion first checks the live publication/attempt,
  worker, fence and database-clock lease before reading or installing staging;
  `prepare_promotion` repeats that check while locking the publication and site
  so a lease race cannot create promotion intent. A failure contains a bounded
  code and cannot supply an artifact. Once the fenced failure is recorded,
  control removes only that attempt's exact staging directory; a cleanup error
  is reported as `publisher_staging_cleanup_failed`.

The manifest format is `hostlet.static-site-manifest/v1`. It lists every file
except `manifest.json`, sorted by relative path, with SHA-256 and byte length.
The artifact digest is SHA-256 of the exact manifest bytes. Paths are relative
ASCII URL paths with no empty, dot, parent, absolute or backslash component.
Symlinks, special files, undeclared files, duplicate paths, more than 256 files,
an individual file over 8 MiB, or a tree over 32 MiB reject promotion. The
complete tree must include `index.html`, `assets/site.css`, and one
`projects/<safe-id>/index.html` for every document project.

The renderer HTML-escapes every text and attribute value. It accepts only
absolute HTTPS URLs for web links and only normalized `mailto:` contacts for
email links. Screenshot evidence currently carries a remote URL without
materialized bytes, so the renderer fails closed with `unsupported_external_image`
instead of fetching it or emitting an external page dependency. It never
fetches a URL. Project output order is the approved `order`; optional sections
remain absent when the public document omits them.

## Filesystem and recovery boundary

The owned artifact root is `<HOSTLET_M3_STATE_DIR>/publisher`. Workers can write
only `staging/<publication-id>/<attempt-id>`. Control validates that tree, moves
it to immutable `artifacts/sha256-<hex>`, and updates the slug pointer as a
same-filesystem temporary symlink rename. The pointer is
`sites/<slug>/current -> ../../artifacts/sha256-<hex>`.

When a lease is reclaimed, control records the prior current attempt as expired,
removes its exact `staging/<publication-id>/<attempt-id>` directory, and only
then issues the replacement lease. Cleanup checks canonical private parents and
never follows a symlink or sweeps unrelated staging directories. A cleanup
failure prevents the replacement lease from being issued, so the response does
not claim a clean retry. Failed or reclaimed staging cleanup never changes the
last-good immutable artifact or its site pointer.

PostgreSQL and a filesystem rename cannot form one transaction. Control first
commits a promotion intent with the expected next pointer generation. It then
installs and swaps the verified tree, and finally marks the publication and site
pointer published in PostgreSQL. A crash before or after the swap leaves the
intent durable. `reconcile_pending` validates the immutable artifact and current
symlink, performs the missing swap when needed, then finalizes the same
generation. It never infers success from an unverified tree. A newer publication
sequence makes an older completion stale before intent creation; expired or
wrong-fence attempts cannot create or advance an intent.

The independent `hostlet-publisher serve` process receives only the artifact
root, bind address and a required `--expected-host HOST` authority. It opens
`sites/<slug>/current`, validates its target and manifest within the artifact
root, and serves declared regular files. It has no database, control API,
source provider, tenant endpoint, or worker credential. Requests require one
exact `Host` header matching `--expected-host`; they reject percent-encoded
separators, malformed percent encoding, traversal, unknown hosts/slugs and
undeclared files. HTML is served with `no-cache`; digest-stable CSS and images
use immutable caching. Responses set `nosniff`, a restrictive static CSP,
`Referrer-Policy: no-referrer`, and deny framing.
