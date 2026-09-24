# Managed restricted preview services

`managed-services.mjs` renders systemd units for the dedicated `hostlet-preview` identity by default. The restricted development installation can explicitly set `services.user` and `services.group` to `shane` to reuse the existing trusted M3 executor for owned fixture orchestration. Only matching `hostlet-preview` or `shane` pairs are accepted; the chosen identity is recorded per unit in the manifest and checked on readback. This does not admit customer work. Rendering does not install packages or units, touch Docker, change routes, run migrations, or seed data. The release input is the complete 40-character commit ID; binaries and scripts are read from `/opt/hostlet-preview/releases/<commit>`. The release snapshot must include the compiled Rust binaries, the built Vite dashboard, and the tracked script tree. Keep the snapshot immutable and root-owned after verification.

The config's `services` object supplies the exact local ports, credential file paths, pinned external binary paths, Caddy config path, and demo TLS paths. The renderer requires private state under `/var/lib/hostlet-preview`. Every unit uses the configured preview service identity, an explicit scoped `EnvironmentFile`, a 45-second start timeout, 30-second stop timeout, and at most three on-failure starts per 60 seconds. The `dashboard` unit serves built Vite files on loopback; the Caddy edge gateway proxies only configured paths to it and stays up if the dashboard stops. The pinned Caddy `file-server` command disables its admin API, and the rendered invocation omits `--browse`. [Caddy's command documentation](https://caddyserver.com/docs/command-line#caddy-file-server) describes both properties; the pinned 2.11.4 binary's help confirms the exact flags. `publisher-static` serves immutable approved pages independently of dashboard, control, source provider, and demo. The separate `demo-gateway` process terminates actual TLS on its configured loopback port. The Cloudflare connector consumes only its scoped `TUNNEL_TOKEN_FILE` environment entry; the token value is never an argument. Its pinned `cloudflared` version must support `TUNNEL_TOKEN_FILE` (2025.4.0 or later). [Cloudflare's run parameter reference](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/) documents that variable.

The `services` fields are:

| Field | Meaning |
| --- | --- |
| `user`, `group` | Matching service identity: `hostlet-preview` by default or explicitly `shane` for the existing trusted development executor. |
| `ports.publisherStatic`, `ports.dashboard`, `ports.gateway`, `ports.demoGateway`, `ports.tunnelMetrics` | Explicit unused loopback TCP ports; gateway is Caddy HTTPS. |
| `envFiles.control`, `builder`, `database`, `runtime`, `publisher`, `publisherStatic`, `dashboard`, `demoGateway`, `gateway`, `tunnel`, optional `provider` | Service-specific private environment files. `tunnel` contains `TUNNEL_TOKEN_FILE=/var/lib/hostlet-preview/secrets/<owned-token-file>`; do not put the token value in a unit. |
| `paths.buildProfile`, `runsc`, `runtimeTokenFile`, `demoCertificate`, `demoPrivateKey`, `caddy`, `caddyConfig`, `cloudflared`, optional `providerConfig` | Absolute pinned files. The token and TLS key are private preview files. |
| `publisherExpectedHost`, `demoHostname`, `projectId` | Exact expected portfolio host, demo TLS host, and owned project UUID. |
| `provider.enabled` | Render the separately scoped synthetic provider service when true. |

Before installing, prepare private `0700` preview state and scoped `0600` environment files. The files hold values only for the named service; no secret goes in the unit, command line, release tree, or artifact. The required environment keys from the current CLI sources are:

| Unit | Environment keys |
| --- | --- |
| `control` | `DATABASE_URL`, `HOSTLET_SECRET_KEY`, `HOSTLET_RECOVERY_KEY`, `HOSTLET_WORKER_TOKEN`, `HOSTLET_API_BIND`, `HOSTLET_WORKER_BIND`, `HOSTLET_M3_MODE=owned_fixture`, `HOSTLET_M3_STATE_DIR`, `HOSTLET_M3_BUILD_TOKEN`, `HOSTLET_M3_DATABASE_TOKEN`, `HOSTLET_M3_RUNTIME_TOKEN`, `HOSTLET_M3_PUBLISHER_TOKEN`; synthetic provider mode adds `HOSTLET_GITHUB_PROVIDER`, `HOSTLET_GITHUB_WEB_ORIGIN`, `HOSTLET_GITHUB_API_ORIGIN`, `HOSTLET_GITHUB_APP_ID`, `HOSTLET_GITHUB_CLIENT_ID`, `HOSTLET_GITHUB_CLIENT_SECRET`, `HOSTLET_GITHUB_PRIVATE_KEY_PEM`, `HOSTLET_GITHUB_WEBHOOK_SECRET`, `HOSTLET_GITHUB_CALLBACK_URL`. |
| `builder` | `HOSTLET_M3_BUILD_TOKEN`. The pinned build profile and worker URL are command arguments. |
| `database-worker` | `HOSTLET_M3_MODE=owned_fixture`, `HOSTLET_M3_DATABASE_TOKEN`, `HOSTLET_M3_STATE_DIR` set to the **database-owned** private directory (`config.postgres.stateDir`), `HOSTLET_TENANT_RECOVERY_KEY`, `HOSTLET_TENANT_RECOVERY_KEY_ID`, `HOSTLET_M3_FIXTURE_BOOTSTRAP_SHA256`. |
| `runtime` and allocation relays | Runtime worker reads its scoped token from `services.paths.runtimeTokenFile`; the relay reads owned runtime metadata. No control, database, or publisher token is needed in these unit environment files. |
| `publisher-worker` | `HOSTLET_M3_MODE=owned_fixture`, `HOSTLET_M3_PUBLISHER_TOKEN`, `HOSTLET_M3_STATE_DIR` set to `config.stateDir`. |
| `tunnel` | `TUNNEL_TOKEN_FILE` pointing to its dedicated private token file. |
| `publisher-static`, `dashboard`, `demo-gateway`, `gateway`, `provider` | No secret environment key is required by their current CLI. Keep their mandatory `EnvironmentFile` scoped and minimal. |

`control` needs the four role tokens because it authenticates each internal worker. Its foundation worker token is separate. For the synthetic provider, the private key must reach `HOSTLET_GITHUB_PRIVATE_KEY_PEM` with its PEM newlines intact. Use systemd environment-file quoting that preserves those newlines; do not flatten it into a literal backslash-n string.

The reviewed launch order is: provision the two exact PostgreSQL resources and verify the platform database; migrate only the selected empty or backup-qualified platform store as a separate operator step; initialize and start the owned provider; start a temporary loopback control if the project ID has not been seeded; seed and record the exact project ID; stop that temporary control; render and activate managed `control`; start `dashboard`, `publisher-static`, `publisher-worker`, `builder`, and `database-worker` as their persistent roots and build assets are ready; compose the owned build, project database, release worker, and allocation relay; activate `runtime` and then `demo-gateway` against the persisted release route; activate `gateway` and finally `tunnel`. Exercise the protected HTTPS staging route and full gate before final cutover. Starting any unit never migrates or reseeds. `renderManagedServices` requires the seeded project ID, so the temporary control step is necessary for the first seed.

The builder unit deliberately sets `PrivateTmp=false`. Its worker creates Unix sockets under host `/tmp`, then launches QEMU in a separate transient systemd unit whose `BindPaths` names those exact sockets. A private `/tmp` in the parent worker would hide the source paths from the system manager and break the build. The QEMU unit itself still uses `PrivateTmp=yes`, `ProtectHome=tmpfs`, and `ProtectSystem=strict`. The other preview units keep `PrivateTmp=true`; their inspected persistent roots and configured binaries are under private `/var/lib/hostlet-preview` and pinned `/opt/hostlet-preview`, with runtime helper access to `/run/netns` and cgroups through the existing trusted executor boundary.

Render and review before the parent-owned install:

```sh
node scripts/beta/managed-services.mjs render /var/lib/hostlet-preview/private/config.json <commit> /var/lib/hostlet-preview/private/rendered-units
```

The command writes exact `hostlet-preview-*.service` files and `services-manifest.json` to a private directory. The manifest lists expected fragment paths and readiness probes. After parent review, `activate CONFIG COMMIT PRIVATE_OUTPUT SHORT` installs one exact fixed unit through `sudo -n install`, reloads systemd, starts it, and waits for bounded readiness. Existing unit replacement is refused unless the installed root-owned unit has the exact expected identity and identical bytes. The trusted operator needs its existing noninteractive sudo access; this helper adds no grant. No service start may implicitly run a build, migration, seed, database reset, or release pointer change. A populated deployment change affecting storage requires the separate verified backup and isolated compatibility trial in the M3.5 contract before installation.

Use exact names for readback and lifecycle operations:

```sh
node scripts/beta/managed-services.mjs inspect control /var/lib/hostlet-preview/private/rendered-units/services-manifest.json
node scripts/beta/managed-services.mjs restart control /var/lib/hostlet-preview/private/rendered-units/services-manifest.json
node scripts/beta/managed-services.mjs ready /var/lib/hostlet-preview/private/rendered-units/services-manifest.json control
```

`start`, `stop`, and `restart` check the installed unit's exact `FragmentPath`, `Description`, `User`, and `Group` before mutation. Pass the rendered manifest as the optional last argument to verify the configured identity as well. They never enumerate or sweep a namespace. `ready` has a bounded deadline (30 seconds, or 45 seconds for the tunnel, with an optional last argument up to 60 seconds), checks systemd failure state, and probes loopback HTTP/TCP for network listeners. Dashboard readiness requires a real 200 for its built `index.html`. For a worker without an HTTP health endpoint, it confirms the exact systemd process is active; gate scenarios must separately prove work completion. `stop` affects only the exact requested unit. Stopping `dashboard` leaves the edge gateway and independent portfolio running. The demo process is separate from `demo-gateway` and relay. Platform and project PostgreSQL are exact owned Docker resources managed by the database/bootstrap work, and are deliberately absent from generic systemd lifecycle commands.

The runtime harness writes an owned allocation tuple to private state after a real allocation. Render its relay unit only from that exact tuple:

```sh
node scripts/beta/managed-services.mjs render-relay /var/lib/hostlet-preview/private/config.json <commit> /var/lib/hostlet-preview/private/preview-relays/<allocation-uuid>.json /var/lib/hostlet-preview/private/rendered-units
```

The tuple must match the configured project UUID, private runtime root, allocation UUID, generation, fence, private address, and ports. The resulting allocation-keyed `hostlet-preview-relay-<allocation-uuid>.service` and matching relay manifest allow predecessor and candidate relays to coexist during rollback. `activate-relay CONFIG COMMIT TUPLE PRIVATE_OUTPUT` installs, starts, and waits for only that allocation's unit; the exported `activateManagedRelay({config,commit,tuplePath,outputDir})` provides the same boundary to bootstrap. `activateManagedService({config,commit,outputDir,short})` handles the fixed runtime worker and gateways. Install and stop each relay only by its exact UUID. In this development installation the configured `shane` executor uses its already accepted M3 sudo and Docker operator boundary for the builder, runtime, database worker, and relay. No new sudo or Docker group grants are installed. Control, publisher, and edge units retain `NoNewPrivileges=true`; the helper units set it to `false` for the existing operator boundary. All listeners remain loopback. Routine restart preserves owner edits, database rows, approvals, publication pointers, and populated state.
