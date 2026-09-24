# Restricted preview Cloudflare route tool

`cloudflare.py` owns only the three exact M3.5 preview names. It creates a new remotely managed tunnel with three loopback HTTP ingress rules and a 404 fallback. It never edits the legacy tunnel or any apex or wildcard record. It retains the new tunnel, its connector token, and all application data on reversal; the operator inventories retained resources separately.

Use a private local work directory (`0700`) and private JSON input files (`0600`). The directory must be outside the public repository and E2E artifact tree. The config has exactly these fields:

```json
{
  "accountId": "<Cloudflare account ID, 32 hex characters>",
  "zoneId": "<hostlet.cloud zone ID, 32 hex characters>",
  "originPort": 18430,
  "workDir": "/private/path/hostlet-m35-cloudflare"
}
```

The two API tokens are supplied only to this process as `M35_CF_DNS_TOKEN` and `M35_CF_TUNNEL_TOKEN` through the scoped credential helper. They are never passed as command arguments or saved. The script writes a raw connector token to `workDir/connector-token` (`0600`) for the managed `cloudflared` service; only that service should receive it. No command prints the token or a provider response body. The journal includes provider IDs and the original exact route target, so keep it private and out of commits and artifacts.

Run in this order:

```sh
python3 scripts/beta/cloudflare.py inventory --config /private/path/config.json --before /tmp/hostlet-m35-cloudflare-before.json
python3 scripts/beta/cloudflare.py prepare --config /private/path/config.json
# Start the dedicated connector from the private connector-token file and verify the origin and HTTPS access gate.
python3 scripts/beta/cloudflare.py cutover --config /private/path/config.json --ready-proof /private/path/ready.json
python3 scripts/beta/cloudflare.py reverse --config /private/path/config.json
```

The readiness proof is a private (`0600`) JSON file. Its entire content must match this shape, including the configured port and exact host order:

```json
{
  "ready": true,
  "originPort": 18430,
  "hosts": ["beta.hostlet.cloud", "beta-demo.hostlet.cloud", "beta-portfolio.hostlet.cloud"]
}
```

`cutover` can be rerun after `reverse` to reapply the preview after a gate proves exact restoration. `reverse` removes only sibling DNS records created by this journal whose current record ID and target still match. It restores the original beta record ID and content recorded from the private before-state and a fresh provider read. Every mutation rereads live DNS and guards the apex and wildcard; unexpected changes stop without overwriting them. A private pending action is fsynced before each provider write. After an interruption, rerun the same command; it accepts only the exact owned result or refuses for manual investigation. `status --config ...` prints only a compact non-secret summary. All commands require both scoped tokens for live reads.

The observed Cloudflare readback adds `"warp-routing": {"enabled": false}` to the configuration sent by this tool. The route check requires that exact readback shape: the three ordered hostname-to-loopback rules, the 404 catchall, and no path or origin-request override. Any added route or enabled private routing is rejected.

Before `inventory`, the provided before-state file must match current Cloudflare state: one exact legacy beta CNAME, no exact sibling records, and the same legacy tunnel configuration. The tool does not inspect process/data ownership, validate the managed connector, probe the loopback origin, validate certificate coverage, or create the readiness proof. Those placement and access checks belong to the deployed gate. Cloudflare's DNS API has no compare-and-swap operation: the tool rereads immediately before each write and verifies readback, but another actor writing between those operations remains a concurrency risk. If a guard fails, stop and inspect privately; never edit the journal to force progress.

API operations follow Cloudflare's [Tunnel create](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/), [Tunnel configuration update](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/), [DNS record update](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/), and [DNS record deletion](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/) contracts.
