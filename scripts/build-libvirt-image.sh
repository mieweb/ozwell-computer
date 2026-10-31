#!/usr/bin/env bash
# Build a bootable, immutable Ozwell guest template without touching host libvirt.
# Requires Docker and an existing linux/amd64 Ozwell image. Output contains no token.
set -euo pipefail
image=${OZWELL_COMPUTER_IMAGE:-ozwell-computer:dev}
output=${1:?Usage: build-libvirt-image.sh OUTPUT_DIRECTORY}
size=${LIBVIRT_IMAGE_SIZE_GIB:-16}
[[ "$size" =~ ^[1-9][0-9]*$ ]] || { echo 'LIBVIRT_IMAGE_SIZE_GIB must be a positive integer' >&2; exit 1; }
mkdir -p "$output"
for file in root.qcow2 vmlinuz initrd manifest.json; do
  test ! -e "$output/$file" || { echo "Refusing to overwrite $output/$file" >&2; exit 1; }
done
source_container="ozc-vm-source-$$"
builder="ozc-vm-builder-$$"
cleanup() {
  docker cp "$source_container:/tmp/guest-install.log" "$output/guest-install.log" >/dev/null 2>&1 || true
  docker cp "$builder:/tmp/builder-install.log" "$output/builder-install.log" >/dev/null 2>&1 || true
  docker rm -f "$source_container" "$builder" >/dev/null 2>&1 || true
}
trap cleanup EXIT
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = amd64 || { echo 'The libvirt guest requires a linux/amd64 Ozwell image' >&2; exit 1; }
docker run --rm --platform linux/amd64 --entrypoint sh "$image" -ec '
  test -f /opt/ozwell-computer/dist/lifecycle.js && test -f /opt/ozwell-computer/dist/routes/lifecycle.js || {
    echo "The image lacks the guest lifecycle API. Build the current Ozwell source before creating a VM template." >&2
    exit 1
  }
'
docker image inspect "$image" --format '{"image_id":"{{.Id}}","architecture":"{{.Architecture}}","repo_digests":{{json .RepoDigests}}}' > "$output/manifest.json"
docker run -d --init --name "$builder" node:24-bookworm-slim sleep infinity >/dev/null
docker exec "$builder" sh -ec '
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends qemu-utils e2fsprogs > /tmp/builder-install.log 2>&1
  mkdir -p /image/rootfs
'
docker run -d --init --platform linux/amd64 --name "$source_container" --entrypoint sleep "$image" infinity >/dev/null
docker exec "$source_container" sh -ec '
  mkdir -p /etc/initramfs-tools/conf.d
  echo RESUME=none > /etc/initramfs-tools/conf.d/resume
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends linux-image-amd64 initramfs-tools busybox systemd systemd-resolved > /tmp/guest-install.log 2>&1
  test -x /lib/systemd/systemd-networkd
'
docker export "$source_container" | docker exec -i "$builder" tar -xpf - -C /image/rootfs
docker exec -e IMAGE_SIZE_GIB="$size" "$builder" bash -ec '
  root=/image/rootfs
  : > "$root/etc/machine-id"
  rm -f "$root/var/lib/dbus/machine-id" "$root/.dockerenv" "$root/run/.containerenv"
  sed -i "/^OZWELL_COMPUTER_/d" "$root/etc/environment"
  # The golden template must not carry an access token from an earlier image boot.
  rm -f "$root/var/lib/ozwell-computer/token"
  printf "OZWELL_COMPUTER_UPDATE_URL=off\n" > "$root/etc/default/ozwell-computer"
  ln -sf /dev/null "$root/etc/systemd/system/environment.service"
  mkdir -p "$root/etc/systemd/network"
  rm -f "$root/etc/resolv.conf"
  ln -s /run/systemd/resolve/stub-resolv.conf "$root/etc/resolv.conf"
  cat > "$root/usr/local/sbin/ozwell-vm-config" <<"GUEST"
#!/bin/sh
# Fail closed: Ozwell must never start without its instance-specific credentials.
set -eu
config=/run/ozwell-vm-config
mkdir -p "$config"
for attempt in $(seq 1 30); do
  if [ -e /dev/disk/by-label/OZC_CONFIG ]; then break; fi
  sleep 1
done
mount -t iso9660 -o ro,nosuid,nodev,noexec /dev/disk/by-label/OZC_CONFIG "$config"
trap "umount $config" EXIT
install -m 600 "$config/ozwell.env" /etc/default/ozwell-computer
install -m 644 "$config/ozwell.network" /etc/systemd/network/10-ozwell.network
GUEST
  chmod 755 "$root/usr/local/sbin/ozwell-vm-config"
  cat > "$root/etc/systemd/system/ozwell-vm-config.service" <<"UNIT"
[Unit]
Description=Read private instance credentials and networking from seed disk
After=systemd-udev-settle.service
Wants=systemd-udev-settle.service
Before=systemd-networkd.service ozwell-computer.service ozwell-computer-xvfb.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ozwell-vm-config
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
  for service in ozwell-computer ozwell-computer-xvfb; do
    mkdir -p "$root/etc/systemd/system/$service.service.d"
    printf "[Unit]\nRequires=ozwell-vm-config.service\nAfter=ozwell-vm-config.service\n" > "$root/etc/systemd/system/$service.service.d/vm.conf"
  done
  ln -sf ../ozwell-vm-config.service "$root/etc/systemd/system/multi-user.target.wants/ozwell-vm-config.service"
  ln -sf /lib/systemd/system/systemd-networkd.service "$root/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
  ln -sf /lib/systemd/system/systemd-resolved.service "$root/etc/systemd/system/multi-user.target.wants/systemd-resolved.service"
  cp "$root/boot/$(basename "$(readlink "$root/vmlinuz")")" /image/vmlinuz
  cp "$root/boot/$(basename "$(readlink "$root/initrd.img")")" /image/initrd
  truncate -s "${IMAGE_SIZE_GIB}G" /image/root.raw
  mkfs.ext4 -q -F -L ozwell-root -d "$root" /image/root.raw
  qemu-img convert -f raw -O qcow2 /image/root.raw /image/root.qcow2
  chmod 644 /image/vmlinuz /image/initrd /image/root.qcow2
  cd /image
  sha256sum root.qcow2 vmlinuz initrd > SHA256SUMS
'
for file in root.qcow2 vmlinuz initrd SHA256SUMS; do docker cp "$builder:/image/$file" "$output/$file" >/dev/null; done
docker cp "$source_container:/tmp/guest-install.log" "$output/guest-install.log" >/dev/null
printf 'Guest template created in %s\n' "$output"
