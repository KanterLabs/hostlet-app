#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --node-image IMAGE@sha256:DIGEST --guest-bin FILE --busybox FILE --output FILE [--size-mib N]" >&2
  exit 2
}

node_image=
guest_bin=
busybox=
output=
size_mib=2048
while (($#)); do
  case "$1" in
    --node-image) node_image=${2-}; shift 2 ;;
    --guest-bin) guest_bin=${2-}; shift 2 ;;
    --busybox) busybox=${2-}; shift 2 ;;
    --output) output=${2-}; shift 2 ;;
    --size-mib) size_mib=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ $node_image =~ ^node:[^@]+@sha256:[0-9a-f]{64}$ ]] || usage
[[ -f $guest_bin && -f $busybox && $output = /* && $size_mib =~ ^[0-9]+$ ]] || usage
((size_mib >= 512 && size_mib <= 4096)) || usage
[[ ! -e $output ]] || { echo "refusing to overwrite $output" >&2; exit 1; }

if readelf -l "$guest_bin" | grep -q 'Requesting program interpreter'; then
  echo "guest binary must be statically linked (build x86_64-unknown-linux-musl)" >&2
  exit 1
fi

tmp=$(mktemp -d)
container_id=
cleanup() {
  if [[ -n $container_id ]]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT

docker pull "$node_image" >/dev/null
container_id=$(docker create --network none "$node_image" /bin/true)
mkdir -p "$tmp/root"
docker export "$container_id" | tar --numeric-owner --xattrs --xattrs-include='*' -xf - -C "$tmp/root"
mkdir -p "$tmp/root/sbin" "$tmp/root/hostlet/bin" "$tmp/root/tmp" \
  "$tmp/root/dev" "$tmp/root/proc" "$tmp/root/sys" "$tmp/root/cache" "$tmp/root/workspace"
install -m 0755 "$guest_bin" "$tmp/root/sbin/hostlet-build-guest"
install -m 0755 "$busybox" "$tmp/root/hostlet/bin/busybox"
truncate -s "${size_mib}M" "$output"
mkfs.ext4 -q -F -L hostlet-root -d "$tmp/root" "$output"
sha256sum "$output"
