#!/usr/bin/env bash
set -euo pipefail
umask 022

readonly release=release-20260914.0
readonly archive=gvisor-x86_64.tar.zstd
readonly archive_sha256=b4f2ac1a678f3911df3804f5e1fa89b0e6e66a7a0f4f062914e1809717a0b421
readonly marker_text=hostlet-owned-fixture-tools-v1
readonly public_root=/opt/hostlet-owned-fixture-tools
readonly default_destination="${public_root}/gvisor/${release}"
readonly repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
readonly default_source="${repo_root}/.local/tools/gvisor/${release}"

source=${HOSTLET_RUNSC_SOURCE:-"$default_source"}
destination=${HOSTLET_RUNSC_DESTINATION:-"$default_destination"}

readonly -a payload_specs=(
  '4b0c2a8eb7414d8b5f3d032e158784b454e9c98ffa3fdebbdd79047faf930d7c containerd-shim-runsc-v1'
  'e29be2ab32a10eb885c4a46635f47b80ad661be6f23b5d7903f11906941c7aab gvisor-bin/checkpointgofer'
  '3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0 gvisor-bin/gvisor-sentry-prewarmer'
  'aff3ed7dfac54b04aab14de2dde53e021402f0ba238bc7ece3ac7d4b6604b055 gvisor-bin/gvisor_sentry'
  '03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11 gvisor-bin/runsc-fd-parking'
  '02bb563cd060fe7992ccd00927024b02b70e0803b61abfa015e158d9d7e88507 gvisor-bin/runsc-metric-server'
  'c0f4ec0ac1198975d5cf919a78f2302426de096f69eebd33e50125c3ca42d699 runsc'
)

usage() {
  cat >&2 <<'EOF'
usage: stage-runsc.sh [--source SOURCE_RELEASE_DIR] [--destination DEST_RELEASE_DIR]

The destination is fixed to /opt/hostlet-owned-fixture-tools/gvisor/release-20260914.0.
The source must be the repository's .local/tools/gvisor/release-20260914.0 tree.
EOF
}

die() {
  echo "stage-runsc: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --source)
      (($# >= 2)) || { usage; exit 2; }
      source=$2
      shift 2
      ;;
    --destination)
      (($# >= 2)) || { usage; exit 2; }
      destination=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die must_run_as_root
[[ "$destination" == "$default_destination" ]] || die destination_not_owned
[[ -d /opt && ! -L /opt ]] || die public_parent_invalid
[[ -d "$source" && ! -L "$source" ]] || die source_missing_or_symlink

tools_root=$(realpath -e -- "${repo_root}/.local/tools/gvisor") || die source_root_missing
source_real=$(realpath -e -- "$source") || die source_missing_or_symlink
[[ "$source_real" == "$tools_root/$release" ]] || die source_not_owned

readonly -a expected_entries=(
  ARCHIVE.sha256
  MANIFEST.sha256
  RELEASE
  containerd-shim-runsc-v1
  gvisor-bin
  gvisor-bin/checkpointgofer
  gvisor-bin/gvisor-sentry-prewarmer
  gvisor-bin/gvisor_sentry
  gvisor-bin/runsc-fd-parking
  gvisor-bin/runsc-metric-server
  runsc
)

die_if_unexpected_tree() {
  local root=$1
  local -a actual=()
  mapfile -t actual < <(find -P "$root" -mindepth 1 -maxdepth 3 -printf '%P\n' | LC_ALL=C sort)
  [[ "${actual[*]-}" == "${expected_entries[*]}" ]] || die source_filename_allowlist_mismatch
}

check_regular() {
  local path=$1
  [[ -f "$path" && ! -L "$path" ]] || die "regular_file_required:$path"
}

check_directory() {
  local path=$1
  [[ -d "$path" && ! -L "$path" ]] || die "directory_required:$path"
}

check_owner_mode() {
  local path=$1
  local expected_mode=$2
  [[ "$(stat -c '%u:%g' -- "$path")" == 0:0 ]] || die "ownership_mismatch:$path"
  [[ "$(stat -c '%a' -- "$path")" == "$expected_mode" ]] || die "mode_mismatch:$path"
}

verify_source_metadata() {
  local root=$1
  check_regular "$root/MANIFEST.sha256"
  check_regular "$root/RELEASE"
  check_regular "$root/ARCHIVE.sha256"
  cmp -s "$root/RELEASE" <(printf '%s\n' "$release") || die source_release_mismatch
  cmp -s "$root/ARCHIVE.sha256" <(printf '%s  %s\n' "$archive_sha256" "$archive") || die source_archive_metadata_mismatch
}

verify_payloads() {
  local root=$1
  for spec in "${payload_specs[@]}"; do
    local digest=${spec%% *}
    local relative=${spec#* }
    local path="$root/$relative"
    check_regular "$path"
    local observed
    observed=$(sha256sum -- "$path" | awk '{print $1}')
    [[ "$observed" == "$digest" ]] || die "payload_checksum_mismatch:$relative"
  done
}

verify_source() {
  die_if_unexpected_tree "$source"
  verify_source_metadata "$source"
  # Older private preparations may have a self-referential or absolute-path
  # MANIFEST.sha256. The seven payload pins above are authoritative; the
  # public manifest is generated from those pins below.
  verify_payloads "$source"
}

verify_manifest() {
  local root=$1
  [[ "$(wc -l < "$root/MANIFEST.sha256")" -eq "${#payload_specs[@]}" ]] || die "manifest_line_count:$root"
  (cd "$root" && sha256sum --check MANIFEST.sha256 >/dev/null) || die "manifest_checksum_mismatch:$root"
}

verify_release_tree() {
  local root=$1
  check_directory "$root"
  check_owner_mode "$root" 755
  check_directory "$root/gvisor-bin"
  check_owner_mode "$root/gvisor-bin" 755
  for metadata in MANIFEST.sha256 RELEASE ARCHIVE.sha256; do
    check_regular "$root/$metadata"
    check_owner_mode "$root/$metadata" 644
  done
  for spec in "${payload_specs[@]}"; do
    local relative=${spec#* }
    check_regular "$root/$relative"
    check_owner_mode "$root/$relative" 755
  done
  die_if_unexpected_tree "$root"
  verify_manifest "$root"
  cmp -s "$root/RELEASE" <(printf '%s\n' "$release") || die destination_release_mismatch
  cmp -s "$root/ARCHIVE.sha256" <(printf '%s  %s\n' "$archive_sha256" "$archive") || die destination_archive_metadata_mismatch
}

verify_marker() {
  check_regular "$public_root/.hostlet-owned-tools"
  check_owner_mode "$public_root/.hostlet-owned-tools" 644
  cmp -s "$public_root/.hostlet-owned-tools" <(printf '%s\n' "$marker_text") || die ownership_marker_mismatch
}

verify_container_layout() {
  check_directory "$public_root"
  check_owner_mode "$public_root" 755
  verify_marker
  check_directory "$public_root/gvisor"
  check_owner_mode "$public_root/gvisor" 755
  local -a top_entries=()
  mapfile -t top_entries < <(find -P "$public_root" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
  [[ "${top_entries[*]-}" == ".hostlet-owned-tools gvisor" ]] || die public_filename_allowlist_mismatch
  local -a gvisor_entries=()
  mapfile -t gvisor_entries < <(find -P "$public_root/gvisor" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
  if ((${#gvisor_entries[@]} > 1)) || { ((${#gvisor_entries[@]} == 1)) && [[ "${gvisor_entries[0]}" != "$release" ]]; }; then
    die public_gvisor_filename_allowlist_mismatch
  fi
}

verify_source

if [[ -e "$destination" || -L "$destination" ]]; then
  verify_container_layout
  verify_release_tree "$destination"
  echo "stage-runsc: already staged $destination"
  exit 0
fi

if [[ ! -e "$public_root" && ! -L "$public_root" ]]; then
  mkdir -- "$public_root"
  chown root:root -- "$public_root"
  chmod 0755 -- "$public_root"
else
  check_directory "$public_root"
  check_owner_mode "$public_root" 755
fi

top_entries=()
mapfile -t top_entries < <(find -P "$public_root" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
for entry in "${top_entries[@]}"; do
  case "$entry" in
    .hostlet-owned-tools|gvisor) ;;
    *) die public_filename_allowlist_mismatch ;;
  esac
done

marker_present=false
if [[ -e "$public_root/.hostlet-owned-tools" || -L "$public_root/.hostlet-owned-tools" ]]; then
  marker_present=true
  verify_marker
fi

if [[ ! -e "$public_root/gvisor" && ! -L "$public_root/gvisor" ]]; then
  mkdir -- "$public_root/gvisor"
  chown root:root -- "$public_root/gvisor"
  chmod 0755 -- "$public_root/gvisor"
else
  check_directory "$public_root/gvisor"
  check_owner_mode "$public_root/gvisor" 755
fi

gvisor_entries=()
mapfile -t gvisor_entries < <(find -P "$public_root/gvisor" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
[[ "${gvisor_entries[*]-}" == "" ]] || die public_gvisor_filename_allowlist_mismatch

stage=$(mktemp -d "$public_root/.stage-runsc.XXXXXX")
cleanup_stage() { rm -rf -- "$stage"; }
trap cleanup_stage EXIT
stage_release="$stage/$release"
mkdir -- "$stage_release" "$stage_release/gvisor-bin"
chown root:root -- "$stage_release" "$stage_release/gvisor-bin"
chmod 0755 -- "$stage_release" "$stage_release/gvisor-bin"

for spec in "${payload_specs[@]}"; do
  relative=${spec#* }
  mkdir -p -- "$(dirname "$stage_release/$relative")"
  install -o root -g root -m 0755 -- "$source/$relative" "$stage_release/$relative"
done
printf '%s\n' "$release" > "$stage_release/RELEASE"
printf '%s  %s\n' "$archive_sha256" "$archive" > "$stage_release/ARCHIVE.sha256"
for spec in "${payload_specs[@]}"; do
  digest=${spec%% *}
  relative=${spec#* }
  printf '%s  %s\n' "$digest" "$relative"
done > "$stage_release/MANIFEST.sha256"
chown root:root -- "$stage_release/MANIFEST.sha256" "$stage_release/RELEASE" "$stage_release/ARCHIVE.sha256"
chmod 0644 -- "$stage_release/MANIFEST.sha256" "$stage_release/RELEASE" "$stage_release/ARCHIVE.sha256"

verify_release_tree "$stage_release"
[[ ! -e "$destination" && ! -L "$destination" ]] || die destination_changed_during_staging
mv -T -- "$stage_release" "$destination"

if [[ "$marker_present" == false ]]; then
  install -o root -g root -m 0644 /dev/null "$public_root/.hostlet-owned-tools"
  printf '%s\n' "$marker_text" > "$public_root/.hostlet-owned-tools"
fi
verify_container_layout
verify_release_tree "$destination"
echo "stage-runsc: staged $destination"
