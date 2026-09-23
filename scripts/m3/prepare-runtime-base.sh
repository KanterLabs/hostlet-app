#!/usr/bin/env bash
# Trusted toolchain preparation; no repository command runs on the host.
set -euo pipefail
umask 077
[[ $# == 2 && $2 == /* && ! -e $2 ]] || {
  echo 'usage: prepare-runtime-base.sh 22|24 ABSOLUTE_NEW_DIRECTORY' >&2; exit 2;
}
case "$1" in
  22) image=node:22-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2 ;;
  24) image=node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 ;;
  *) exit 2 ;;
esac
target=$2
temporary=$(mktemp -d)
container_id=
cleanup() {
  if [[ -n $container_id ]]; then docker rm "$container_id" >/dev/null; fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
container_id=$(docker create --network none --label io.hostlet.scope=m3-runtime-base-preparation "$image" /bin/true)
docker export --output "$temporary/rootfs.tar" "$container_id"
mkdir -p "$target/rootfs"
tar --extract --file "$temporary/rootfs.tar" --directory "$target/rootfs" --no-same-owner --same-permissions
# The private preparation directory must not mask the trusted image's modes:
# runtime code executes as uid 65532 and needs the image's normal read/execute
# permissions. Docker exports may omit an entry for the root directory itself.
chmod 0755 "$target/rootfs"
for executable in usr/local/bin/node usr/bin/env; do
  [[ -f "$target/rootfs/$executable" && -x "$target/rootfs/$executable" ]] || {
    echo 'runtime base is missing a required executable' >&2; exit 1;
  }
done
jq -n --arg image "$image" --arg archive_sha256 "$(sha256sum "$temporary/rootfs.tar" | awk '{print $1}')" \
  '{schema:"hostlet.runtime-base/v1",image:$image,archive_sha256:$archive_sha256,project_code_executed:false}' > "$target/base.json"
chmod 0600 "$target/base.json"
printf '%s\n' "$target"
