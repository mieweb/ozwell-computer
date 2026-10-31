# Idle hibernation with local libvirt

The `libvirt` provider runs one persistent x86_64 VM per computer. An external
orchestrator owns the idle policy and viewer gateway. `virsh managedsave --running`
writes guest RAM/device state to libvirt's managed-save directory and terminates
QEMU. An ordinary `virsh start` restores the saved state. No restore failure falls
back to a fresh boot. The guest's CPU and anonymous RAM allocation are released;
the host, gateway and filesystem page cache continue to exist.
The lifecycle relies on libvirt's documented
[managed-save/start behavior](https://libvirt.org/manpages/virsh.html#managedsave),
[port isolation](https://libvirt.org/formatnetwork.html#isolating-ports-from-one-another)
and [explicit IP anti-spoof filters](https://libvirt.org/formatnwfilter.html#concepts).

## Host and image preparation

Use a dedicated Linux x86_64 host with KVM, Node.js 24+, and sufficient RAM and disk.
Install libvirt's system daemon, QEMU x86, `qemu-img`, `virsh`, `flock`, and
`genisoimage`. On Debian, the packages are `libvirt-daemon-system`,
`libvirt-daemon-config-nwfilter`, `libvirt-clients`, `qemu-system-x86`, `qemu-utils`,
`util-linux`, `genisoimage`, `ebtables`, and `dnsmasq-base`. Ensure the standard
`clean-traffic` nwfilter exists (`virsh -c qemu:///system nwfilter-list`). The provider
fails VM startup if its anti-spoof filter cannot be applied. Its dedicated NAT
network uses isolated guest ports and explicit per-instance IPv4 anti-spoof rules.
Guests cannot send directly to one another. Use a dedicated subnet with no overlap
with the host's other networks.

Build an Ozwell Docker image with the current source first (for example
`make build && docker compose build`). Then produce the guest template:

```sh
OZWELL_COMPUTER_IMAGE=ozwell-computer:dev \
  bash scripts/build-libvirt-image.sh /tmp/ozwell-vm-template
```

The builder uses temporary Docker containers, installs the guest kernel, and exports
an ext4 root as `root.qcow2` with matching `vmlinuz` and `initrd`. It also writes image
provenance, SHA256 checksums and the guest install log. Output contains no instance
access token. Move the complete output to an immutable, readable location, such as
`/var/lib/ozwell-computer/images/2026-10-31/`. Do not overwrite an image directory
used by existing domains: managed saves depend on the original machine, kernel,
libvirt and QEMU configuration. Each computer receives its own full qcow2 copy,
without a backing-file dependency on the golden disk.
Use a trusted, pristine application image as the source: the builder clears the
server's generated token and machine identity, but retains other image contents,
including any application profiles deliberately baked into a custom image.

On first boot, a required guest service mounts its read-only `OZC_CONFIG` seed ISO
and installs its private token and static network configuration before Ozwell or
Xvfb can start. Networking uses systemd-networkd and systemd-resolved. The seed is
retained with the VM for future ordinary boots. Do not copy another computer's
seed disk. Guest package auto-updates are disabled; update templates for new guests
and schedule maintenance for existing ones with an explicit state-retention plan.

## Configuration

Set the following in `/etc/default/ozwell-computer-orchestrator` (mode 0600):

```dotenv
PROVIDER_URI=libvirt:///system
LIBVIRT_IMAGE_DIR=/var/lib/ozwell-computer/images/2026-10-31
LIBVIRT_STORAGE_DIR=/var/lib/ozwell-computer
LIBVIRT_SAVE_DIR=/var/lib/libvirt/qemu/save
LIBVIRT_PUBLIC_URL=https://{id}.computers.example.com
LIBVIRT_NETWORK=ozwell-computer
LIBVIRT_SUBNET=192.168.230
LIBVIRT_MEMORY_MIB=2048
LIBVIRT_VCPUS=2
LIBVIRT_DOMAIN_TYPE=kvm
LIBVIRT_JOB_TIMEOUT_MS=120000
ORCHESTRATOR_IDLE_MS=300000
ORCHESTRATOR_IDLE_POLL_MS=15000
ORCHESTRATOR_HOST=127.0.0.1
ORCHESTRATOR_PORT=8090
ORCHESTRATOR_TOKEN=replace-with-a-long-random-secret
```

`LIBVIRT_PUBLIC_URL` must have exactly one `{id}` as its first hostname label. Use
wildcard DNS and TLS, and forward those virtual hosts to the orchestrator listener
while preserving the original `Host` and WebSocket upgrade headers. Public URLs
remain stable while the VM is asleep. Also forward the MCP endpoint on a separate
host through the same listener. The gateway authenticates the computer's own token
before waking or proxying it; the MCP endpoint uses `ORCHESTRATOR_TOKEN` and Ozwell
user headers as before. Restrict the listener to the reverse proxy. Do not proxy
unauthenticated endpoints directly to guest IPs.

`LIBVIRT_SAVE_DIR` is a capacity-check location, not an override of libvirt's save
path. Set it to the actual save directory used by your libvirt installation; an
incorrect value makes the check ineffective. Allow uncompressed guest RAM plus a
10% margin and a 1 GiB reserve per save, on top of persistent guest disks. QEMU and
the controller must be able to traverse the image/storage paths. The controller
also needs traversal through the save directory's parents for `statfs`; libvirt
socket group membership alone may not grant this. Where necessary, grant the
service account a narrow execute-only directory ACL. It does not need permission
to read managed-save files. Libvirt's normal
DAC/AppArmor/SELinux labeling must permit those paths; add local policy as needed
without disabling host security globally. The controller creates storage directories
with mode 0711 and credential files with 0600; libvirt adjusts QEMU disk ownership.
Treat guest disks, seed disks, domain XML, managed-save files and backups as secrets.
Encrypt the host's storage and restrict libvirt administration.

Use one storage directory, libvirt URI, network and subnet consistently across all
controllers for a host. An in-process queue and a host `flock` on
`LIBVIRT_STORAGE_DIR/.lifecycle.lock` serialize lifecycle callbacks, including the
idle check and guest preparation. Domain metadata stores ownership, token, IP, public
URL and durable save intent. Every startup rediscovers managed domains; no local
controller database or autostarting guest is needed. Never enable libvirt autostart
for these domains: the controller restores them only when requested.
Before admitting lifecycle callbacks, the provider also waits for any libvirt
daemon job to settle. A killed controller or timed-out `virsh` client may leave a
save/restore running after its file lock is released. `LIBVIRT_JOB_TIMEOUT_MS`
bounds this recovery wait (default 120 seconds). A job that remains active, or
cannot be queried, keeps admission closed and preserves durable save intent; retry
after resolving the daemon job rather than forcing a boot.

For the supplied hardened systemd service, create a static service account, add it
to the libvirt administration group, and install
[`orchestrator/systemd/libvirt.conf`](../orchestrator/systemd/libvirt.conf) as
`/etc/systemd/system/ozwell-computer-orchestrator.service.d/libvirt.conf`. Provision
`/var/lib/ozwell-computer` owned by that account with mode 0711. Configure the
libvirt UNIX socket's group authorization to allow this trusted service account
noninteractive read/write access; test `virsh -c qemu:///system list --all` as that
account before enabling the service. Libvirt administration is root-equivalent;
use this account only for the orchestrator. The drop-in keeps the original service's
other hardening and makes its state directory writable. Adapt the libvirt service
unit name if your distribution uses modular daemons.

## Recovery and deletion

The provider refuses unmanaged networks or domains. Its network marker, domain
metadata and UUID are checked before lifecycle operations. The controller does not
remove saved RAM during a wake error. If libvirt reports an incompatible CPU or a
missing/corrupt image, repair that host configuration and retry; do not use
`--force-boot` or `managedsave-remove` to bypass it. A durable save-intent flag also
blocks cold boot when a previously saved image disappears. Inspect with:

```sh
virsh -c qemu:///system dominfo COMPUTER_ID
virsh -c qemu:///system dumpxml COMPUTER_ID --inactive
journalctl -u ozwell-computer-orchestrator
```

The domain XML contains access credentials; do not paste it into public issues.
Failed initial startup retains the defined domain and disk for recovery. Failure
before a domain is defined removes only that creation's partial directory. Explicit
`destroy_computer` is destructive: it stops the owned VM, undefines it with its
managed-save image, and removes only its owned storage directory. Network and golden
images remain. Back up persistent disks and managed RAM consistently while the guest
is saved; a copied disk alone cannot preserve unsaved process/application state.

`LIBVIRT_DOMAIN_TYPE=qemu` selects software emulation with a Nehalem CPU (SSE4.2),
for functional tests on hosts without KVM. Its timing does not represent production
KVM performance. Test your production host and application workload before adopting
a timeout. An idle saved desktop does not execute timers, keep sockets alive, or
renew external credentials; reconnects, expired tokens and external service changes
are expected after a long sleep even when application memory is retained exactly.

## Validation

The recorded [whole-lifecycle run](experiments/libvirt-lifecycle/README.md) exercises
the actual provider, idle controller, HTTP/WebSocket gateway and MCP proxy across
three automatic saves, including an external controller restart. All three retain
the original boot, process, RAM and unsaved GUI state. The root regression suite
passed all 238 unit/integration tests, including Chromium and Firefox; the
orchestrator passed 72 tests.

Run the same disposable test with a freshly built template:

```sh
LIBVIRT_IMAGE_DIR=/path/to/template \
  bash scripts/libvirt-lifecycle-lab.sh /tmp/ozwell-lifecycle-results
```

The default test requires real libvirt network filters. Some nested Docker kernels,
including the tested OrbStack host, cannot apply the required ebtables rules. Only
for that disposable, single-VM lab, `OZC_LAB_SKIP_NWFILTER=1` enables a test XML
adapter that omits the filter reference and records the exemption in the results.
There is no corresponding production-provider setting. This validates lifecycle
behavior under emulation; run with normal filtering and KVM on the deployment host
to validate its networking, confinement and performance before serving users.

References: [managed save and restore](https://libvirt.org/manpages/virsh.html#managedsave),
[domain jobs](https://libvirt.org/manpages/virsh.html#domjobinfo), and
[libvirt network filters](https://libvirt.org/formatnwfilter.html).
