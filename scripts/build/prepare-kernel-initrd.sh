#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --kernel FILE --config FILE --busybox FILE --kernel-output FILE --initrd-output FILE --metadata-output FILE" >&2
  exit 2
}

kernel=
config=
busybox=
kernel_output=
initrd_output=
metadata_output=
while (($#)); do
  case "$1" in
    --kernel) kernel=${2-}; shift 2 ;;
    --config) config=${2-}; shift 2 ;;
    --busybox) busybox=${2-}; shift 2 ;;
    --kernel-output) kernel_output=${2-}; shift 2 ;;
    --initrd-output) initrd_output=${2-}; shift 2 ;;
    --metadata-output) metadata_output=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f $kernel && -f $config && -f $busybox ]] || usage
for output in "$kernel_output" "$initrd_output" "$metadata_output"; do
  [[ $output = /* && ! -e $output ]] || usage
done
if readelf -l "$busybox" 2>/dev/null | grep -q 'Requesting program interpreter'; then
  echo "busybox must be statically linked" >&2
  exit 1
fi
for option in CONFIG_DEVTMPFS CONFIG_VIRTIO CONFIG_VIRTIO_PCI CONFIG_VIRTIO_BLK CONFIG_VIRTIO_CONSOLE CONFIG_EXT4_FS; do
  grep -qx "${option}=y" "$config" || {
    echo "$option must be built into the pinned kernel" >&2
    exit 1
  }
done

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/initramfs/bin" "$tmp/initramfs/dev" "$tmp/initramfs/proc" \
  "$tmp/initramfs/sys" "$tmp/initramfs/newroot"
install -m 0755 "$busybox" "$tmp/initramfs/bin/busybox"
for applet in sh mount switch_root sleep mkdir; do
  ln -s busybox "$tmp/initramfs/bin/$applet"
done
cat > "$tmp/initramfs/init" <<'EOF'
#!/bin/busybox sh
set -eu
/bin/mount -t devtmpfs devtmpfs /dev
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
tries=0
while [ ! -b /dev/vda ]; do
  tries=$((tries + 1))
  [ "$tries" -le 100 ] || { echo "hostlet root device missing" >/dev/console; exit 1; }
  /bin/sleep 0.05
done
/bin/mount -t ext4 -o ro,nodev,nosuid /dev/vda /newroot
/bin/mount --move /dev /newroot/dev
/bin/mount --move /proc /newroot/proc
/bin/mount --move /sys /newroot/sys
exec /bin/switch_root /newroot /sbin/hostlet-build-guest
EOF
chmod 0755 "$tmp/initramfs/init"

install -m 0444 "$kernel" "$kernel_output"
(
  cd "$tmp/initramfs"
  find . -print0 | LC_ALL=C sort -z | cpio --null -o --format=newc \
    --owner=0:0 --reproducible 2>/dev/null | gzip -n -9 > "$initrd_output"
)
chmod 0444 "$initrd_output"

jq -n \
  --arg schema hostlet.build-kernel/v1 \
  --arg kernel_source "$kernel" \
  --arg config_source "$config" \
  --arg kernel_digest "sha256:$(sha256sum "$kernel_output" | awk '{print $1}')" \
  --arg initrd_digest "sha256:$(sha256sum "$initrd_output" | awk '{print $1}')" \
  --arg busybox_digest "sha256:$(sha256sum "$busybox" | awk '{print $1}')" \
  '{schema:$schema,kernel_source:$kernel_source,config_source:$config_source,
    kernel_digest:$kernel_digest,initrd_digest:$initrd_digest,busybox_digest:$busybox_digest,
    required_builtin_options:["CONFIG_DEVTMPFS","CONFIG_VIRTIO","CONFIG_VIRTIO_PCI",
      "CONFIG_VIRTIO_BLK","CONFIG_VIRTIO_CONSOLE","CONFIG_EXT4_FS"]}' > "$metadata_output"
sha256sum "$kernel_output" "$initrd_output" "$metadata_output"
