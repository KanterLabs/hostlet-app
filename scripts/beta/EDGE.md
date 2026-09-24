# Restricted M3.5 preview edge

Build the real Vite dashboard with `VITE_HOSTLET_RESTRICTED_PREVIEW=true`. This
build sends the application session as `X-Hostlet-Authorization: Bearer …` so the
browser's `Authorization: Basic …` remains available to the independent Caddy
owner gate. A normal build keeps the standard Bearer header. The flag contains
no credential and is the only preview-specific browser build input.

Run `node scripts/beta/render-edge.mjs /absolute/private/Caddyfile` with all of
the following service configuration variables. The renderer refuses missing or
unsafe values and writes the generated file mode 0600. Keep the output and
auth include outside the repository. The Caddy service must read both private
files. No account name, password, hash, session, CA private key or provider
token belongs in the build or repository.

| Variable | Value |
| --- | --- |
| `HOSTLET_BETA_EDGE_PORT` | Dedicated unused Caddy loopback port; the tunnel connector points only here. |
| `HOSTLET_BETA_CONTROL_PORT` | Real control API loopback port. |
| `HOSTLET_BETA_DEMO_PORT` | Existing release gateway's TLS loopback port. |
| `HOSTLET_BETA_DEMO_HOST` | Exact gateway certificate and routing hostname ending in `.localowned.test`. |
| `HOSTLET_BETA_DEMO_CA_FILE` | Absolute path to the private CA certificate trusted for that gateway. |
| `HOSTLET_BETA_STATIC_PORT` | Independent publisher `serve` loopback port. |
| `HOSTLET_BETA_STATIC_EXPECTED_HOST` | Exact value passed to publisher `serve --expected-host`. |
| `HOSTLET_BETA_WEB_PORT` | Managed dashboard file server's loopback port. Its root is the built Vite `dist` directory. |
| `HOSTLET_BETA_AUTH_INCLUDE` | Absolute path to the private Caddy auth snippet. |

The private snippet has exactly this shape, with a newly generated bcrypt hash
in place of the marker. Use a generic owner name, and deliver the password
privately:

```caddyfile
basic_auth {
    owner <bcrypt-hash>
}
```

Generate the hash with `caddy hash-password` through a protected input path.
The renderer reads and validates the snippet without copying the hash into the
generated Caddyfile. The Caddyfile imports the snippet separately inside each
host's route. Caddy must run with its configuration and include accessible to
the service identity; do not put a password in a systemd command line.

The generated site listens on `127.0.0.1:<edge port>` only. Configure
the dedicated Cloudflare Tunnel for the three exact names
`beta.hostlet.cloud`, `beta-demo.hostlet.cloud`, and
`beta-portfolio.hostlet.cloud` to that origin. Require public HTTPS and edge
HTTP-to-HTTPS redirection before credential entry. The Caddy origin also
redirects a known host when the connector marks `X-Forwarded-Proto: http`,
before issuing any Basic challenge. Keep the origin inaccessible
from the network, including direct API, demo and publisher ports. Caddy returns
404 for any other Host header.

After Basic Authentication, dashboard `/v1` calls and readiness checks reach
the control API. `/v1/accounts` is denied by Caddy. Only the alternate app
session header is translated into control `Authorization`; Basic credentials,
cookies and the alternate header are removed from that upstream request. The
demo proxy verifies its existing private CA and hostname while rewriting Host
to the release gateway's exact `.localowned.test` name. The publisher proxy
uses its configured exact expected Host. Both proxies remove Basic credentials,
and alternate app sessions; demo cookies remain so release affinity and
application sessions keep working. Publisher and dashboard file-server requests
also drop cookies. The dashboard proxy serves only `/`, `/index.html`, its
`/assets/*` files and `/favicon.ico` from the separately managed file server.
Stopping that server does not stop Caddy or the independent portfolio. Unknown
paths and API failures cannot fall through to the SPA.

Before any route cutover, validate the generated file with
`caddy validate --config /absolute/private/Caddyfile --adapter caddyfile` and
exercise Basic denial, signed-in owner access, alternate-header translation,
direct-origin isolation, all three hosts, unknown Host 404, sign-up denial,
and static independence in the deployed M3.5 gate. The real browser and
durability oracles are in `docs/M3.5-SCENARIOS.md`; this renderer is not an
acceptance substitute.
