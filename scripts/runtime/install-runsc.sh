#!/usr/bin/env bash
set -euo pipefail
umask 022

readonly release=release-20260914.0
readonly archive=gvisor-x86_64.tar.zstd
readonly archive_sha256=b4f2ac1a678f3911df3804f5e1fa89b0e6e66a7a0f4f062914e1809717a0b421
readonly base="https://github.com/google/gvisor/releases/download/${release}"
readonly repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
readonly tools_root="${repo_root}/.local/tools/gvisor"
readonly destination=${1:-"${tools_root}/${release}"}

readonly -a payload_specs=(
  '4b0c2a8eb7414d8b5f3d032e158784b454e9c98ffa3fdebbdd79047faf930d7c containerd-shim-runsc-v1'
  'e29be2ab32a10eb885c4a46635f47b80ad661be6f23b5d7903f11906941c7aab gvisor-bin/checkpointgofer'
  '3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0 gvisor-bin/gvisor-sentry-prewarmer'
  'aff3ed7dfac54b04aab14de2dde53e021402f0ba238bc7ece3ac7d4b6604b055 gvisor-bin/gvisor_sentry'
  '03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11 gvisor-bin/runsc-fd-parking'
  '02bb563cd060fe7992ccd00927024b02b70e0803b61abfa015e158d9d7e88507 gvisor-bin/runsc-metric-server'
  'c0f4ec0ac1198975d5cf919a78f2302426de096f69eebd33e50125c3ca42d699 runsc'
)

die() {
  echo "install-runsc: $*" >&2
  exit 1
}

[[ "$destination" == "${tools_root}/${release}" ]] || die destination_not_owned
[[ ! -e "$destination" && ! -L "$destination" ]] || die destination_exists

stage=$(mktemp -d "${repo_root}/.local/runsc-install.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
extract="$stage/$release"
mkdir -p -- "$tools_root" "$extract"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  "${base}/${archive}" -o "${stage}/${archive}"
observed=$(sha256sum -- "${stage}/${archive}" | awk '{print $1}')
[[ "$observed" == "$archive_sha256" ]] || die runsc_checksum_mismatch

tar --zstd --extract --file "${stage}/${archive}" --directory "$extract" --no-same-owner

expected_entries=(
  containerd-shim-runsc-v1
  gvisor-bin
  gvisor-bin/checkpointgofer
  gvisor-bin/gvisor-sentry-prewarmer
  gvisor-bin/gvisor_sentry
  gvisor-bin/runsc-fd-parking
  gvisor-bin/runsc-metric-server
  runsc
)
mapfile -t observed_entries < <(find -P "$extract" -mindepth 1 -maxdepth 3 -printf '%P\n' | LC_ALL=C sort)
[[ "${observed_entries[*]-}" == "${expected_entries[*]}" ]] || die runsc_archive_layout_invalid

for metadata in MANIFEST.sha256 RELEASE ARCHIVE.sha256; do
  [[ ! -e "$extract/$metadata" && ! -L "$extract/$metadata" ]] || die runsc_archive_metadata_present
done

for spec in "${payload_specs[@]}"; do
  digest=${spec%% *}
  relative=${spec#* }
  path="$extract/$relative"
  [[ -f "$path" && ! -L "$path" ]] || die runsc_archive_incomplete
  observed=$(sha256sum -- "$path" | awk '{print $1}')
  [[ "$observed" == "$digest" ]] || die runsc_payload_checksum_mismatch
done

printf '%s\n' "$release" > "$extract/RELEASE"
printf '%s  %s\n' "$archive_sha256" "$archive" > "$extract/ARCHIVE.sha256"
for spec in "${payload_specs[@]}"; do
  digest=${spec%% *}
  relative=${spec#* }
  printf '%s  %s\n' "$digest" "$relative"
done > "$extract/MANIFEST.sha256"

[[ "$(cat "$extract/RELEASE")" == "$release" ]] || die release_metadata_invalid
[[ "$(wc -l < "$extract/MANIFEST.sha256")" -eq "${#payload_specs[@]}" ]] || die runsc_manifest_invalid
(cd "$extract" && sha256sum --check MANIFEST.sha256 >/dev/null) || die runsc_manifest_invalid
[[ ! -e "$destination" && ! -L "$destination" ]] || die destination_changed_during_install
mv -T -- "$extract" "$destination"
"$destination/runsc" --version
