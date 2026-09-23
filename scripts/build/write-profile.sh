#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo "usage: $0 PROFILE_ID QEMU KERNEL INITRD ROOTFS CACHE OUTPUT" >&2
  exit 2
}
[[ $# -eq 7 ]] || usage
profile_id=$1 qemu=$2 kernel=$3 initrd=$4 rootfs=$5 cache=$6 output=$7
[[ $profile_id =~ ^[A-Za-z0-9._-]{1,64}$ && $output = /* && ! -e $output ]] || usage
for file in "$qemu" "$kernel" "$initrd" "$rootfs" "$cache"; do
  [[ $file = /* && -f $file ]] || usage
done

digest() { sha256sum "$1" | awk '{print "sha256:" $1}'; }
jq -n \
  --arg schema hostlet.build-profile/v1 \
  --arg id "$profile_id" \
  --arg qemu_binary "$qemu" --arg qemu_digest "$(digest "$qemu")" \
  --arg kernel_path "$kernel" --arg kernel_digest "$(digest "$kernel")" \
  --arg initrd_path "$initrd" --arg initrd_digest "$(digest "$initrd")" \
  --arg rootfs_path "$rootfs" --arg rootfs_digest "$(digest "$rootfs")" \
  --arg cache_path "$cache" --arg cache_digest "$(digest "$cache")" \
  '{schema:$schema,id:$id,qemu_binary:$qemu_binary,qemu_digest:$qemu_digest,
    kernel:{path:$kernel_path,digest:$kernel_digest},
    initrd:{path:$initrd_path,digest:$initrd_digest},
    rootfs:{path:$rootfs_path,digest:$rootfs_digest},
    dependency_cache:{path:$cache_path,digest:$cache_digest},
    mkfs_ext4:"/usr/sbin/mkfs.ext4",sudo:"/usr/bin/sudo",
    systemd_run:"/usr/bin/systemd-run",systemctl:"/usr/bin/systemctl"}' > "$output"
sha256sum "$output"
