# M3.5 deployed preview gate

Run only against the dedicated, previously staged owned preview. The gate uses
real Chromium, three independently configured HTTPS origins, the real control
API, demo and PostgreSQL stores, managed services, and exact Cloudflare records.
It creates `artifacts/e2e/M3.5/<run-id>/` before setup and writes a failed
artifact when prerequisites or assertions fail. Stop after a failed full run;
diagnose its retained receipt before retrying.
Public-origin readiness uses one 300-second deadline for seven concurrent
HTTPS probes: three anonymous roots must return 401, the malformed dashboard
session API must return 401, and the protected dashboard, demo and current
portfolio HTML must return 200. All seven must remain stable for 20 seconds
before feature checks start. Any other status or transport error resets that
stability window. Each attempt is recorded under
`observations.placement.propagation` in `manifest.json` with host, attempt time,
elapsed time, HTTP status or transport error name/code/cause; a safe Cloudflare
Ray ID and 1033 code are included when observed. Response bodies are not
retained. The runner flushes these observations before a readiness failure
triggers restoration of the exact entry route.
The retained inventory captures pre-existing preview owner, project, release
and publication IDs before the browser journey. Passwords and provider tokens
are scrubbed from artifacts; the non-secret Basic username is allowed in paths
so the recorded private rerun command remains usable.

```sh
node e2e/beta/run.mjs \
  --config /private/preview-config.json \
  --edge-credentials /private/edge-credentials.json \
  --cloudflare-config /private/cloudflare-config.json \
  --cloudflare-before /private/cloudflare-before.json \
  --ready-proof /private/ready-proof.json \
  --services-manifest /private/services-manifest.json \
  --require-clean
```

All input files must be regular mode-0600 private files. Edge credentials use
`{"username":"...","passwordFile":"/private/edge-password"}`. The
preview config follows `scripts/beta/config.example.json` and includes the
separate `otherOwner` fixture. Cloudflare config and readiness proof follow
`scripts/beta/CLOUDFLARE.md`; scoped provider tokens remain in the child
environment. No credential belongs in the command line, repository or artifact.

The runner verifies the exact owned provider route at entry, including when
the separately authorized preview is already live. It performs cutover, exact
reversal to the retained legacy route, reapplication, and a second exact
reversal within each full gate. Cleanup restores and verifies the entry route
on both success and failure; a live preview at entry remains live. The focused
`--phase login` checks a real browser's rejected application password, accurate
notice, signed-out form and subsequent correct sign-in without editing content.
The focused `--phase route-only` needs no prior synthetic phase receipts. It
checks the current approved publication, private draft, protected HTML bytes
and exact demo items, then proves original route, preview reapplication,
second original route and cleanup back to the verified entry route. Its three
preview readings use the same seven-path HTTPS readiness window; it does not
publish, edit the portfolio, or write demo items. API requests close their
connection so a managed service restart cannot leave the runner using a stale
pooled socket; transport failures retain only safe cause codes and are not
retried.
The full gate requires a clean source tree from
start to finish, and `SHA256SUMS` is external to the manifest. Run `sha256sum
-c SHA256SUMS` from the artifact directory and record the SHA256SUMS file hash
in the handoff.

The independently managed `dashboard` asset unit is stopped alongside control,
demo gateway/runtime worker, and source provider during the static outage
check; Caddy, the static publisher, and tunnel remain up. The browser profile
is temporary and deleted after the run. Basic credentials
are delivered to Chromium through CDP authentication challenges for only the
three configured origins. The application session uses the preview-only
`X-Hostlet-Authorization` header. Artifacts contain redacted observations,
assertion results, cleanup state and no browser profile or request headers.

The separate partial seed uses the stable synthetic second owner on the same
private control API. It interrupts after the account step in a run-owned
private manifest, then resumes the real seed and checks the resulting owner and
project IDs. The resulting secondary synthetic project is retained and named
in the artifact; it has no live release or customer slot. Release failure and
rollback semantics reuse the independently verified M3 receipts because their
policy and code did not change. The M3.5 gate still proves new populated
backup and isolated restore, managed restart, publisher/database failure,
and exact deployed route reversal itself.
