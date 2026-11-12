#!/usr/bin/env bash
# Run the complete provider/controller/gateway against an isolated, real libvirt VM.
# Build the golden image first with build-libvirt-image.sh. No host mounts or sockets.
set -euo pipefail
image_dir=${LIBVIRT_IMAGE_DIR:?Set LIBVIRT_IMAGE_DIR to a directory created by build-libvirt-image.sh}
output=${1:-$(mktemp -d "${TMPDIR:-/tmp}/ozc-lifecycle-results.XXXXXX")}
script_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$script_dir/.." && pwd)
lab="ozc-lifecycle-lab-$$"
skip_nwfilter=${OZC_LAB_SKIP_NWFILTER:-0}
[[ "$skip_nwfilter" =~ ^[01]$ ]] || { echo 'OZC_LAB_SKIP_NWFILTER must be 0 or 1' >&2; exit 1; }
for file in root.qcow2 vmlinuz initrd; do
  test -f "$image_dir/$file" || { echo "Missing golden image file: $file" >&2; exit 1; }
done
mkdir -p "$output"
cleanup() {
  docker cp "$lab:/lab/results/." "$output/" 2>/dev/null || true
  docker rm -f "$lab" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Privileged only inside this disposable Docker container; software emulation needs no KVM.
docker run -d --init --name "$lab" --privileged --memory 8g --cpus 6 \
  node:24-bookworm-slim sleep infinity >/dev/null
docker exec "$lab" mkdir -p /lab/repo /lab/image /lab/results /lab/storage
docker cp "$image_dir/." "$lab:/lab/image/" >/dev/null
COPYFILE_DISABLE=1 tar --no-xattrs -C "$repo_dir" -cf - package.json orchestrator/package.json \
  orchestrator/package-lock.json orchestrator/src docs/mcp-tools.json scripts/smoke-libvirt-lifecycle.ts \
  | docker exec -i "$lab" tar -xpf - -C /lab/repo
docker exec "$lab" sh -ec '
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libvirt-daemon-system libvirt-clients qemu-system-x86 qemu-utils \
    genisoimage dnsmasq-base iptables ebtables iproute2 util-linux dbus procps \
    > /lab/results/host-install.log 2>&1
  mkdir -p /run/libvirt /run/dbus
  printf "security_driver = \"none\"\nuser = \"root\"\ngroup = \"root\"\ncgroup_controllers = []\nnamespaces = []\n" >> /etc/libvirt/qemu.conf
  dbus-daemon --system --fork
  virtlogd -d
  virtlockd -d
  libvirtd -d
  cd /lab/repo/orchestrator
  npm ci --ignore-scripts > /lab/results/npm-install.log 2>&1
  if [ -f /lab/image/manifest.json ]; then cp /lab/image/manifest.json /lab/results/image-manifest.json; fi
  if [ -f /lab/image/SHA256SUMS ]; then cp /lab/image/SHA256SUMS /lab/results/image-SHA256SUMS; fi
'
# Strict anti-spoof filtering is the default. A nested host lacking ebtables/ARP
# kernel support may explicitly set OZC_LAB_SKIP_NWFILTER=1 for this disposable
# one-VM lab. The test then adapts its own domain XML only; production is unchanged.
docker exec -e OZC_LIFECYCLE_LAB=1 -e OZC_LAB_SKIP_NWFILTER="$skip_nwfilter" -e LIBVIRT_IMAGE_DIR=/lab/image \
  -e LIBVIRT_STORAGE_DIR=/lab/storage -e LIBVIRT_DOMAIN_TYPE=qemu \
  -e LIBVIRT_MEMORY_MIB=2048 -e LIBVIRT_VCPUS=2 \
  "$lab" node /lab/repo/scripts/smoke-libvirt-lifecycle.ts /lab/results/results.json
printf 'Whole lifecycle test completed. Evidence: %s\n' "$output"
