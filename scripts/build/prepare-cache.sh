#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --npm-cache DIR --metadata FILE --output FILE [--size-mib N]" >&2
  exit 2
}

cache=
metadata=
output=
size_mib=2048
while (($#)); do
  case "$1" in
    --npm-cache) cache=${2-}; shift 2 ;;
    --metadata) metadata=${2-}; shift 2 ;;
    --output) output=${2-}; shift 2 ;;
    --size-mib) size_mib=${2-}; shift 2 ;;
    *) usage ;;
  esac
done
[[ -d $cache && -f $metadata && $output = /* && $size_mib =~ ^[0-9]+$ ]] || usage
((size_mib >= 256 && size_mib <= 8192)) || usage
[[ ! -e $output ]] || { echo "refusing to overwrite $output" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/image/npm" "$tmp/image/hostlet"
cp -a -- "$cache"/. "$tmp/image/npm"/
install -m 0444 "$metadata" "$tmp/image/hostlet/cache-metadata.json"
truncate -s "${size_mib}M" "$output"
mkfs.ext4 -q -F -L hostlet-cache -d "$tmp/image" "$output"
sha256sum "$output"
