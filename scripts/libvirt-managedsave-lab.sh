#!/usr/bin/env bash
# Disposable, software-emulated x86_64 VM lab. Requires Docker and an amd64 Ozwell image.
set -euo pipefail

image=${OZWELL_COMPUTER_IMAGE:-ozwell-computer:dev}
lab="ozc-managedsave-lab-$$"
source_container="ozc-managedsave-source-$$"
output=${1:-$(mktemp -d "${TMPDIR:-/tmp}/ozc-managedsave-results.XXXXXX")}
script_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$output"
cleanup() {
  docker cp "$source_container:/tmp/kernel-install.log" "$output/guest-kernel-install.log" 2>/dev/null || true
  docker cp "$lab:/lab/results/." "$output/" 2>/dev/null || true
  docker rm -f "$source_container" "$lab" >/dev/null 2>&1 || true
}
trap cleanup EXIT

test "$(docker image inspect "$image" --format '{{.Architecture}}')" = amd64 || {
  echo 'This initial lab requires a linux/amd64 Ozwell image.' >&2; exit 1;
}
# No host directories, host libvirt socket, or existing VM disks are mounted.
# This privileged container requires a trusted Docker host; TCG needs no nested KVM.
docker run -d --init --name "$lab" --privileged --memory 6g --cpus 6 \
  node:24-bookworm-slim sleep infinity >/dev/null
docker exec "$lab" mkdir -p /lab/rootfs /lab/results
docker cp "$script_dir/smoke-libvirt-managedsave.mjs" "$lab:/lab/smoke.mjs" >/dev/null
docker image inspect "$image" --format '{"id":"{{.Id}}","architecture":"{{.Architecture}}","repo_digests":{{json .RepoDigests}}}' > "$output/source-image.json"
docker exec "$lab" sh -ec '
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libvirt-daemon-system libvirt-clients qemu-system-x86 qemu-utils e2fsprogs \
    dbus procps python3 > /lab/results/host-install.log 2>&1
  mkdir -p /run/libvirt /run/dbus
  printf "security_driver = \"none\"\nuser = \"root\"\ngroup = \"root\"\ncgroup_controllers = []\nnamespaces = []\n" >> /etc/libvirt/qemu.conf
  dbus-daemon --system --fork
  virtlogd -d
  virtlockd -d
  libvirtd -d
'
docker run -d --init --platform linux/amd64 --name "$source_container" \
  --entrypoint sleep "$image" infinity >/dev/null
docker exec "$source_container" sh -ec '
  mkdir -p /etc/initramfs-tools/conf.d
  echo RESUME=none > /etc/initramfs-tools/conf.d/resume
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    linux-image-amd64 initramfs-tools busybox > /tmp/kernel-install.log 2>&1
'
docker cp "$source_container:/tmp/kernel-install.log" "$output/guest-kernel-install.log" >/dev/null
docker export "$source_container" | docker exec -i "$lab" tar -xpf - -C /lab/rootfs
docker exec "$lab" bash -ec '
  umask 022
  root=/lab/rootfs
  token=$(python3 -c "import secrets; print(secrets.token_hex(24))")
  # Container environment injection must not override the explicit guest settings.
  sed -i "/^OZWELL_COMPUTER_/d" "$root/etc/environment"
  printf "OZWELL_COMPUTER_TOKEN=%s\nOZWELL_COMPUTER_HOST=0.0.0.0\nOZWELL_COMPUTER_UPDATE_URL=off\nOZWELL_COMPUTER_SCREEN=1024x768x24\n" "$token" > "$root/etc/default/ozwell-computer"
  printf "%s" "$token" > /lab/token
  chmod 600 /lab/token
  : > "$root/etc/machine-id"
  rm -f "$root/var/lib/dbus/machine-id"
  rm -f "$root/.dockerenv" "$root/run/.containerenv"
  printf "nameserver 10.0.2.3\n" > "$root/etc/resolv.conf"
  ln -sf /dev/null "$root/etc/systemd/system/environment.service"
  cat > "$root/usr/local/sbin/ozc-lab-network" <<"EOF"
#!/bin/sh
set -eu
for attempt in $(seq 1 60); do
  for path in /sys/class/net/*; do
    [ -d "$path" ] || continue
    nic=${path##*/}
    [ "$nic" != lo ] || continue
    /usr/sbin/ip link set "$nic" up
    /usr/sbin/ip address replace 10.0.2.15/24 dev "$nic"
    /usr/sbin/ip route replace default via 10.0.2.2
    exit 0
  done
  sleep 1
done
exit 1
EOF
  chmod 755 "$root/usr/local/sbin/ozc-lab-network"
  cat > "$root/etc/systemd/system/lab-network.service" <<EOF
[Unit]
Description=Static user-mode QEMU network for managed-save experiment
After=systemd-udev-trigger.service
Before=ozwell-computer.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ozc-lab-network
RemainAfterExit=yes
Restart=on-failure
RestartSec=1
[Install]
WantedBy=multi-user.target
EOF
  ln -sf ../lab-network.service "$root/etc/systemd/system/multi-user.target.wants/lab-network.service"
  cat > "$root/usr/local/sbin/ozc-lab-diagnostics" <<"EOF"
#!/bin/sh
sleep 35
exec > /dev/ttyS0 2>&1
ip address
systemctl --no-pager --full status lab-network.service ozwell-computer.service
journalctl --no-pager -n 50 -u lab-network.service -u ozwell-computer.service
EOF
  chmod 755 "$root/usr/local/sbin/ozc-lab-diagnostics"
  cat > "$root/etc/systemd/system/lab-diagnostics.service" <<EOF
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ozc-lab-diagnostics
[Install]
WantedBy=multi-user.target
EOF
  ln -sf ../lab-diagnostics.service "$root/etc/systemd/system/multi-user.target.wants/lab-diagnostics.service"
  cp "$root/boot/$(basename "$(readlink "$root/vmlinuz")")" /lab/vmlinuz
  cp "$root/boot/$(basename "$(readlink "$root/initrd.img")")" /lab/initrd
  sha256sum /lab/vmlinuz /lab/initrd > /lab/results/boot-files.sha256
  truncate -s 8G /lab/rootfs.ext4
  mkfs.ext4 -q -F -L ozc-root -d "$root" /lab/rootfs.ext4
  cat > /lab/domain.xml <<EOF
<domain type="qemu" xmlns:qemu="http://libvirt.org/schemas/domain/qemu/1.0">
  <name>ozc-managedsave-test</name>
  <memory unit="MiB">2048</memory><vcpu>2</vcpu>
  <!-- libvips requires SSE4.2; QEMUs default qemu64 model is too old. -->
  <cpu mode="custom" match="exact"><model fallback="forbid">Nehalem</model></cpu>
  <os><type arch="x86_64" machine="pc">hvm</type>
    <kernel>/lab/vmlinuz</kernel><initrd>/lab/initrd</initrd>
    <cmdline>root=/dev/vda rw console=ttyS0 net.ifnames=0</cmdline>
  </os>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type="file" device="disk"><driver name="qemu" type="raw"/>
      <source file="/lab/rootfs.ext4"/><target dev="vda" bus="virtio"/>
    </disk>
    <serial type="file"><source path="/lab/results/serial.log"/>
      <target type="isa-serial" port="0"/>
    </serial>
    <memballoon model="none"/>
  </devices>
  <qemu:commandline>
    <qemu:arg value="-netdev"/>
    <qemu:arg value="user,id=labnet,hostfwd=tcp:127.0.0.1:18080-:8080"/>
    <qemu:arg value="-device"/><qemu:arg value="virtio-net-pci,netdev=labnet,addr=0x10"/>
  </qemu:commandline>
</domain>
EOF
  virsh -c qemu:///system define /lab/domain.xml
  virsh -c qemu:///system start ozc-managedsave-test
  cp /lab/domain.xml /lab/results/domain.xml
  for attempt in $(seq 1 300); do
    if python3 -c "import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:18080/health\", timeout=2)" 2>/dev/null; then break; fi
    sleep 2
  done
  export OZWELL_COMPUTER_TOKEN=$(cat /lab/token)
  node /lab/smoke.mjs --domain ozc-managedsave-test --url http://127.0.0.1:18080 \
    --require-gui --output /lab/results/results.json
'
echo "Results: $output"
