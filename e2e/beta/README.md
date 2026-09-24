# M3.5 deployed preview gate

Run only against the dedicated, previously staged owned preview. The gate uses
real Chromium, three independently configured HTTPS origins, the real control
API, demo and PostgreSQL stores, managed services, and exact Cloudflare records.
It creates `artifacts/e2e/M3.5/<run-id>/` before setup and writes a failed
artifact when prerequisites or assertions fail. Stop after a failed full run;
diagnose its retained receipt before retrying.

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

The runner performs temporary cutover, exact reversal, reapplication, and a
second exact reversal within each gate. The final preview route is an operator
action after two clean gates on the same commit. A failed gate reverses the
temporary route in its cleanup path. The source tree must remain clean from
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
