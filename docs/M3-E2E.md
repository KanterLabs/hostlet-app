# M3 owned E2E preparation and run guide

M3 implementation and validation are in progress. This guide prepares and runs
the owned HOST-233 journey described in [M3-SCENARIOS.md](M3-SCENARIOS.md).
It is not an M3 acceptance record, and a successful local invocation is not an
acceptance claim. The gate still requires the evidence and clean-repeat policy
in [TESTING.md](../TESTING.md).

The procedure uses only owned local fixtures and run-scoped resources. It does
not authorize production deployment, customer admission, public publication,
provider purchases, existing database or container changes, or cleanup based
on unverified ownership. Do not put credentials, private source bundles,
database URLs, host inventories, or unredacted logs in retained evidence.

## Identify the host prerequisites

Run these read-only checks from the repository root. The Rust toolchain is
pinned by `rust-toolchain.toml` to 1.96.0. Chromium defaults to
`/snap/bin/chromium`; set `HOSTLET_E2E_CHROMIUM` before the run when the owned
test host uses another executable.

```sh
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
rustc --version
cargo --version
rustup target list --installed | grep '^x86_64-unknown-linux-musl$'
node --version
npm --version
make --version | head -1
docker version
docker info --format '{{json .ServerVersion}}'
test -x "${HOSTLET_E2E_CHROMIUM:-/snap/bin/chromium}"

command -v qemu-system-x86_64
qemu-system-x86_64 --version | head -1
command -v mkfs.ext4
command -v busybox
command -v cpio
command -v jq
command -v curl
command -v tar
command -v zstd
command -v ip
command -v nft
command -v mountpoint
test -c /dev/kvm
test "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs
sudo -n true
```

The journey also reads the digest-pinned PostgreSQL image in
`e2e/postgres-image.txt`. Docker must be able to pull and start that image in
an owned, labeled container. The build scenario performs its own systemd broker
preflight and proves that the run-owned unit preserves the caller UID,
receives the `kvm` supplementary group, and opens `/dev/kvm` read-write. A
character device alone is not sufficient evidence for that boundary.

The runtime scenario checks `ip`, `nft`, `jq`, and `mountpoint` itself. Its
privileged helpers use `sudo -n`, direct OCI `runsc`, owned network namespaces,
and cgroup v2. It never registers a Docker runtime or changes the Docker daemon.
The executable `scripts/runtime/hostlet-runtime-relay-stop` uses the same
`sudo -n` boundary and requires Python's `os.pidfd_open` and
`signal.pidfd_send_signal`. Each relay owns a dedicated process group; shutdown
validates its allocation, PID, process-group ID and Linux starttime before
signaling through pidfds and verifying that no member remains.
The E2E harness uses the public staged runtime at
`/opt/hostlet-owned-fixture-tools/gvisor/release-20260914.0/runsc` by default;
the private repository tree is only the staging source. Verify that the public
tree is root-owned, executable, and contains the seven pinned payloads before
starting the journey:

```sh
RUNSC_ROOT=/opt/hostlet-owned-fixture-tools/gvisor/release-20260914.0
test "$(cat /opt/hostlet-owned-fixture-tools/.hostlet-owned-tools)" = 'hostlet-owned-fixture-tools-v1'
test "$(stat -c '%u:%g:%a' /opt/hostlet-owned-fixture-tools/.hostlet-owned-tools)" = '0:0:644'
test -x "$RUNSC_ROOT/runsc"
test "$(stat -c '%u:%g:%a' "$RUNSC_ROOT/runsc")" = '0:0:755'
test "$(stat -c '%u:%g:%a' "$RUNSC_ROOT/gvisor-bin/gvisor-sentry-prewarmer")" = '0:0:755'
(cd "$RUNSC_ROOT" && sha256sum --check MANIFEST.sha256)
```

The release tree is prepared with the owned, idempotent staging command below.
It rejects a mismatched or symlinked existing destination and never changes
permissions on the private `.local` source tree.

## Current owned asset pins

The default asset root is `.local/m3-assets`, which is private and ignored by
Git. The profiles contain checkout-specific absolute paths, so copy neither the
profile bytes nor those paths into public evidence. The following values identify
the assets currently prepared on the owned M3 host:

| Input | Current identity |
| --- | --- |
| Static guest helper | `sha256:5bdfd3620a28396988d384b821e810ccaf64754b7fa32ddfe15b9053cd828e75` |
| QEMU | `sha256:0cd4112a8f0cb891eb7c10e8df38c9dfeec8c7389bb22db6aa425f0d6fe733dc` |
| Kernel | `sha256:19fd789cd5e6b4adfe18c9c6b92a1ce8c8b2eef6ff88456cef80ee2dca9b3f72` |
| Initramfs | `sha256:f6315bba1d34a4baa534b60d27c205c7c207996c13ad96a6a711759bde6d49b7` |
| Node 24 build rootfs v7 | `sha256:f800751dfa5e5367e984ee70189e6654eeb6270d94fe5cc9f680966acef2d133` |
| Node 22 build rootfs v6 | `sha256:d463aa2405a93e0977b74c5ce35a3bdee7fa30dc965d688c0a2ecd1cf20f95c9` |
| Node 24 dependency cache | `sha256:72c2411e55d6d76f762dde9934799b2d74a02e35b56f45bf4abdd17d4a0f87b7` |
| Node 22 dependency cache | `sha256:be9da4b70c71a173efe789f741d7239130e5b790edd6a19ae5803bfb10e97d4c` |
| Intentional cache-miss cache | `sha256:ae76512b0d5d8901fba4dbdbd4271089f5a6ca582b83cf11f516bc1924fd8d7b` |
| Node 24 profile file | `sha256:df85fbd247ff424e36d5cce9888fec14f3b10fc43d83aabc518bb12666397aa2` |
| Node 22 profile file | `sha256:97ee7aeeed87419cfb2cd8f1f6156b2d84e9ea9f7e1ea1f57cb1bf4d700f1fdd` |
| Cache-miss profile file | `sha256:234fdcdfcee8c76d94b76b77634d96ae86edf580c0a3a23c8c75e420f7c8e44e` |

The active Node 24 profiles deliberately reference `node24/rootfs-v7.ext4`,
and the active Node 22 profile references `node22/rootfs-v6.ext4`. Earlier
rootfs files are retained only to reproduce failed runs and must not be
substituted. The kernel receipt is `.local/m3-assets/kernel/metadata.json`; it
records the matching kernel configuration and the required built-in devtmpfs,
virtio PCI/block/console, and ext4 options.

The official amd64 Node inputs are:

```text
node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2
```

The runtime pin is gVisor `release-20260914.0`. Its downloaded
`gvisor-x86_64.tar.zstd` digest is
`b4f2ac1a678f3911df3804f5e1fa89b0e6e66a7a0f4f062914e1809717a0b421`,
and the evaluated `runsc` digest is
`c0f4ec0ac1198975d5cf919a78f2302426de096f69eebd33e50125c3ca42d699`.

Verify the prepared inputs without printing their contents:

```sh
sha256sum \
  target/x86_64-unknown-linux-musl/release/hostlet-build-guest \
  .local/m3-assets/kernel/vmlinuz \
  .local/m3-assets/kernel/initrd.gz \
  .local/m3-assets/node24/rootfs-v7.ext4 \
  .local/m3-assets/node22/rootfs-v6.ext4 \
  .local/m3-assets/node24/cache.ext4 \
  .local/m3-assets/node22/cache.ext4 \
  .local/m3-assets/node24-cache-miss/cache.ext4 \
  .local/m3-assets/profiles/m3-owned-node24-v1.json \
  .local/m3-assets/profiles/m3-owned-node22-v1.json \
  .local/m3-assets/profiles/m3-owned-node24-cache-miss-v1.json

sha256sum /opt/hostlet-owned-fixture-tools/gvisor/release-20260914.0/runsc
(cd /opt/hostlet-owned-fixture-tools/gvisor/release-20260914.0 && sha256sum --check MANIFEST.sha256)
```

Stop if a measured value differs from the profile or the table. Do not rewrite
a profile around an unexplained mismatch.

## Prepare build VM assets

These scripts refuse to overwrite outputs. Run them for an initial setup or in
a separate owned staging directory, then compare every digest before adopting
the staged files. Serialize image, cache, profile, lockfile, and workspace-wide
build operations.

Build the frozen static guest helper and verify its current digest:

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --locked --release --target x86_64-unknown-linux-musl \
  -p hostlet-builder --bin hostlet-build-guest
sha256sum target/x86_64-unknown-linux-musl/release/hostlet-build-guest
```

Prepare the kernel and deterministic initramfs. `KERNEL_CONFIG` must correspond
to `KERNEL_SOURCE`; the current receipt identifies Linux `7.0.0-31-generic`.

```sh
ASSET_ROOT="$PWD/.local/m3-assets"
mkdir -p "$ASSET_ROOT/kernel"
KERNEL_SOURCE="$ASSET_ROOT/kernel/source-vmlinuz"
KERNEL_CONFIG=/boot/config-7.0.0-31-generic
BUSYBOX=$(command -v busybox)
test ! -e "$KERNEL_SOURCE"
install -m 0444 /boot/vmlinuz-7.0.0-31-generic "$KERNEL_SOURCE"

scripts/build/prepare-kernel-initrd.sh \
  --kernel "$KERNEL_SOURCE" \
  --config "$KERNEL_CONFIG" \
  --busybox "$BUSYBOX" \
  --kernel-output "$ASSET_ROOT/kernel/vmlinuz" \
  --initrd-output "$ASSET_ROOT/kernel/initrd.gz" \
  --metadata-output "$ASSET_ROOT/kernel/metadata.json"
```

Populate the trusted npm caches from locked public tarballs. This step uses the
digest-pinned official images, disables lifecycle scripts, verifies package
integrities, and never executes fixture build commands on the host. The
cache-miss profile intentionally contains no packages.

```sh
node scripts/m3/prepare-npm-cache.mjs 24
node scripts/m3/prepare-npm-cache.mjs 22
node scripts/m3/prepare-npm-cache.mjs 24-cache-miss

scripts/build/prepare-cache.sh \
  --npm-cache "$ASSET_ROOT/node24/npm" \
  --metadata "$ASSET_ROOT/node24/npm/cache-metadata.json" \
  --output "$ASSET_ROOT/node24/cache.ext4"
scripts/build/prepare-cache.sh \
  --npm-cache "$ASSET_ROOT/node22/npm" \
  --metadata "$ASSET_ROOT/node22/npm/cache-metadata.json" \
  --output "$ASSET_ROOT/node22/cache.ext4" --size-mib 256
scripts/build/prepare-cache.sh \
  --npm-cache "$ASSET_ROOT/node24-cache-miss/npm" \
  --metadata "$ASSET_ROOT/node24-cache-miss/npm/cache-metadata.json" \
  --output "$ASSET_ROOT/node24-cache-miss/cache.ext4" --size-mib 256
```

Prepare the immutable Node build root filesystems. The output names below are
the paths pinned by the active profiles; the scripts refuse to overwrite them.

```sh
GUEST="$PWD/target/x86_64-unknown-linux-musl/release/hostlet-build-guest"
NODE24='node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7'
NODE22='node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2'

scripts/build/prepare-rootfs.sh \
  --node-image "$NODE24" --guest-bin "$GUEST" --busybox "$BUSYBOX" \
  --output "$ASSET_ROOT/node24/rootfs-v7.ext4"
scripts/build/prepare-rootfs.sh \
  --node-image "$NODE22" --guest-bin "$GUEST" --busybox "$BUSYBOX" \
  --output "$ASSET_ROOT/node22/rootfs-v6.ext4"
```

Create the three exact profile files. The writer hashes QEMU and every image;
the control plane later copies the exact bytes into its run-owned 0600 profile
directory and uses the profile-file SHA-256 as the lease capability.

```sh
mkdir -p "$ASSET_ROOT/profiles"
QEMU=$(command -v qemu-system-x86_64)

scripts/build/write-profile.sh m3-owned-node24-v1 \
  "$QEMU" "$ASSET_ROOT/kernel/vmlinuz" "$ASSET_ROOT/kernel/initrd.gz" \
  "$ASSET_ROOT/node24/rootfs-v7.ext4" "$ASSET_ROOT/node24/cache.ext4" \
  "$ASSET_ROOT/profiles/m3-owned-node24-v1.json"
scripts/build/write-profile.sh m3-owned-node22-v1 \
  "$QEMU" "$ASSET_ROOT/kernel/vmlinuz" "$ASSET_ROOT/kernel/initrd.gz" \
  "$ASSET_ROOT/node22/rootfs-v6.ext4" "$ASSET_ROOT/node22/cache.ext4" \
  "$ASSET_ROOT/profiles/m3-owned-node22-v1.json"
scripts/build/write-profile.sh m3-owned-node24-cache-miss-v1 \
  "$QEMU" "$ASSET_ROOT/kernel/vmlinuz" "$ASSET_ROOT/kernel/initrd.gz" \
  "$ASSET_ROOT/node24/rootfs-v7.ext4" \
  "$ASSET_ROOT/node24-cache-miss/cache.ext4" \
  "$ASSET_ROOT/profiles/m3-owned-node24-cache-miss-v1.json"
```

## Prepare runtime assets

Install the exact gVisor release beneath the owned `.local/tools` tree. The
installer verifies the downloaded archive, extracts its complete sidecar set,
and writes `MANIFEST.sha256`, `RELEASE`, and `ARCHIVE.sha256`.

```sh
scripts/runtime/install-runsc.sh
sudo -n scripts/runtime/stage-runsc.sh
```

The installer is the private source preparation step. The staging command
independently checks all seven pinned payload digests, creates a relative
manifest, and installs root-owned mode `0755` directories and binaries plus
mode `0644` metadata beneath
`/opt/hostlet-owned-fixture-tools/gvisor/release-20260914.0`.
The installer refuses an existing private release tree; when that source is
already present, rerun the staging command directly after its source checks
pass.

Prepare the complete Node runtime base trees. Each destination must be a new
absolute directory. The script uses `docker create --network none`, exports the
pinned image without running project code, and writes `base.json`.

```sh
scripts/m3/prepare-runtime-base.sh 22 \
  "$PWD/.local/m3-assets/node22/runtime-base"
scripts/m3/prepare-runtime-base.sh 24 \
  "$PWD/.local/m3-assets/node24/runtime-base"

jq . .local/m3-assets/node22/runtime-base/base.json
jq . .local/m3-assets/node24/runtime-base/base.json
```

The current runtime base receipts record archive digests
`fed060080e24a534442e5f5be18d98fb42359d30e7a919081e0220a774448db1`
for Node 22 and
`a4a98b19b99dce86d977fb40d777c245ad8e7f221c8b564d7fd28f8650e921da`
for Node 24. The E2E runtime preparer independently measures the extracted
trees before staging an application beneath `/app`.

## Build the workspace and run the journey

Install locked dependencies and run the repository checks before producing gate
evidence:

```sh
make install
make check
```

Run the full owned M3 journey with its two-hour runner limit and one-hour
per-operation limit:

```sh
make e2e-m3
```

Force a fresh retained predecessor build from its pinned detached source with:

```sh
make e2e-m3 E2E_ARGS='--rebuild-retained'
```

`make e2e-m3` permits a dirty development tree and records its source and diff
digests. Such a run is diagnostic only. Once implementation is committed and
the milestone prerequisites are satisfied, the clean-tree command is:

```sh
make e2e-m3-gate
```

For shorter debugging cycles, the partial data and runtime development
scenarios can be run directly:

```sh
node e2e/run.mjs --milestone M3-journey-development --task HOST-233 \
  --scenario-module e2e/scenarios/m3-journey-development.mjs \
  --operation-timeout 3600000 --run-timeout 7200000

node e2e/run.mjs --milestone M3-data-development --task HOST-233 \
  --scenario-module e2e/scenarios/m3-data-development.mjs \
  --operation-timeout 3600000 --run-timeout 7200000

node e2e/run.mjs --milestone M3-runtime-development --task HOST-233 \
  --scenario-module e2e/scenarios/m3-runtime-development.mjs \
  --operation-timeout 3600000 --run-timeout 7200000

node e2e/run.mjs --milestone M3-runtime-bootstrap-development --task HOST-233 \
  --scenario-module e2e/scenarios/m3-runtime-bootstrap-development.mjs \
  --operation-timeout 1800000 --run-timeout 3600000

node e2e/run.mjs --milestone M3-runtime-pressure-development --task HOST-233 \
  --scenario-module e2e/scenarios/m3-runtime-pressure-development.mjs \
  --operation-timeout 1800000 --run-timeout 3600000

node e2e/run.mjs --milestone M3-runtime-database-bootstrap-development --task HOST-233 \
  --scenario-module e2e/scenarios/m3-runtime-database-bootstrap-development.mjs \
  --operation-timeout 1800000 --run-timeout 3600000
```

These partial commands deliberately omit parts of the journey and are
non-gating diagnostic tools. Their receipts cannot establish completed M3
behavior or satisfy any HOST-233 acceptance or clean-repeat requirement.
The journey diagnostic uses the existing short real-build setup and then runs
runtime, release, approval, publication and data recovery stages. It omits build
retry/failure acceptance, including the real ten-minute timeout, and cannot
replace either full clean run.
The database bootstrap diagnostic launches one Node 24 application with a
control-scoped tenant credential, exercises application read/write, and verifies
secret mount and runtime cleanup. It does not register a runtime capability.

Do not call the gate complete from this guide. HOST-233 requires two clean runs
on the same implementation commit, including one retained rebuild run, and a
separate handoff that records both verified receipts and observed limits.

## Verify a run receipt

Every invocation creates its private run directory before prerequisite checks,
including failed or blocked runs. Use the exact directory printed by the runner:

```sh
RUN_DIR='artifacts/e2e/M3/<run-id>'
(cd "$RUN_DIR" && sha256sum --check SHA256SUMS)
sha256sum "$RUN_DIR/SHA256SUMS"
jq '{status,task,milestone,source,cleanup}' "$RUN_DIR/manifest.json"
jq . "$RUN_DIR/assertions.json"
sed -n '1,240p' "$RUN_DIR/REPORT.md"
```

Confirm that the manifest records M3/HOST-233, the intended source identity,
the exact rerun command, tool and fixture digests, all required assertion
results, and complete owned-resource cleanup. Check that the report is readable
and that no retained file contains credentials or private source content. A
valid `SHA256SUMS` proves artifact integrity only; it does not turn a failed,
blocked, dirty, incomplete, or single run into milestone acceptance. Preserve
failed and interrupted receipts for diagnosis, and never repair an oracle by
weakening its assertion.
