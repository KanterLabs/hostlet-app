# M1 secret metadata and versions

All owner routes require a Bearer session. Their base path is
`/v1/projects/{project_id}/services/{service_id}/secrets`; unknown and cross-owner
resources return the same `404`. No owner route decrypts or exports a value.

Create a definition with `POST` to the base path, an `Idempotency-Key`, and:

```json
{
  "name": "BUILD_TOKEN",
  "operation": "build",
  "credential_kind": "build_environment"
}
```

The `201` response contains `id`, `owner_account_id`, `project_id`, `service_id`,
`name`, `operation`, `credential_kind`, `status`, `revision`, and `created_at`.
`GET {base}/{secret_id}` returns the same metadata. Names contain 1–128
non-control bytes; leading and trailing whitespace is trimmed for storage.

Operations are `build`, `runtime`, `database_migration`, or `platform_management`.
Kinds are `source_repository_read`, `build_environment`, `production_database`,
or `platform_management`. These are storage scopes, not permission to execute
those operations. M1 bookkeeping jobs only accept the first two kinds scoped to
`build`.

Create an immutable version with `POST {base}/{secret_id}/versions`, an
`Idempotency-Key`, a quoted `If-Match` containing the definition revision, and
`{"value":"<injected value>"}`. Send the value from protected memory; never put
it in command arguments or logs. Values contain 1–16,384 UTF-8 bytes. The `201`
response contains only `id`, `secret_id`, `version`, and `created_at`.
`GET {base}/{secret_id}/versions/{version_id}` returns only that metadata.

Creating a version increments the definition revision. An exact replay returns
the original response before checking the old revision. Reusing the same key
with a changed value returns `409 idempotency_payload_changed`; a new key with a
stale revision returns `412 stale_revision`. The encrypted version, revision,
audit event, and safe replay result commit in one transaction.

Values use XChaCha20-Poly1305 with a random 24-byte nonce and authenticated data
binding the account, project, service, operation, kind, secret, and version.
Secret-bearing replay fingerprints use a domain-separated HMAC, never an
unkeyed hash of the value. Key bytes remain outside PostgreSQL. Missing or
mismatched key versions fail closed; a ciphertext/context mismatch also fails
credential resolution.

The internal credential endpoint in [M1-JOBS-API.md](M1-JOBS-API.md) is limited to
the exact declared versions of a live leased job. It checks the worker,
attempt, fence, scope, and current database time after acquiring the job lock.
Undeclared or cross-scope versions remain unavailable. The public listener has
no internal worker routes.

M1 has one injected secret key and no key-rotation or secret-revocation UI.
Preserve the key separately from encrypted database backups; replacing it
cannot recover or silently rewrite existing versions.
