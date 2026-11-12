# Automatic idle hibernation and authenticated wake

The complete implementation passed three automatic save/restore cycles on
2026-10-31. This run used the production `LibvirtProvider`, `IdleController`,
orchestrator server, HTTP/WebSocket gateway and MCP client. It created its own
persistent VM and disk from the golden image, rather than manually saving a
separately provisioned domain. See the [deployment guide](../../libvirt-deployment.md)
for enabling this provider; the [initial mechanism experiment](../../libvirt-managed-save.md)
remains available as historical evidence.

## Results

| Automatic cycle | Trigger for restoration | Idle-to-saved wait¹ | Request-to-result² | Managed save |
|---|---|---:|---:|---:|
| Viewer | Authenticated viewer HTTP request | 2.620 s | 4.958 s | 919.3 MiB |
| Agent | Orchestrator MCP `run_command` | 2.409 s | 7.368 s | 919.2 MiB |
| Controller restart | Authenticated API request after restarting the controller | 2.358 s | 4.715 s | 918.8 MiB |

¹ Includes the test's 1.5 s idle grace and guest preparation; not just RAM copying.
Production defaults to a configurable five-minute grace.
² Includes host locking, libvirt restoration, guest health/admission checks and
the requested response. The MCP measurement also includes session initialization
and running a Python command. These are local x86_64 TCG observations on an ARM64
host, not KVM production benchmarks. Initial cold boot took 86.492 s.

Every saved interval had a managed-save image and **no matching QEMU process**.
After restoration, the original guest boot ID, process PID/start ticks, random
in-memory token and recomputed hash of a 64 MiB nonzero RAM payload matched.
The counter advanced and the same GUI window/process retained its unsaved text.
The test typed the text once; subsequent checks only copied it after installing a
fresh unrelated clipboard sentinel.

All four PNG captures are byte-identical (17,247 bytes, SHA256
`67c83c6c1a3fcdc6ab3e2a93f42f906840149651af6cf4ea3f083b946deefcbc`):

- [Before saving](gui-before.png)
- [After viewer wake](gui-after-viewer.png)
- [After MCP wake](gui-after-mcp.png)
- [After controller restart and wake](gui-after-controller-restart.png)

The same run verified that a manual keep-awake lease, an open SSE stream, a
WebSocket viewer and a detached command job each prevented automatic saving.
Explicit hibernation also refused leases/jobs. Authenticated health, metrics and
status polling, and anonymous requests, left the saved VM asleep. A fresh provider
and controller rediscovered the saved VM without waking it before the next
authorized request.

## Environment and reproducibility

- Libvirt 9.0.0; QEMU 7.2.22 (`1:7.2+dfsg-7+deb12u18+b3`); Node 24.22.2.
- Debian 13.1 x86_64 guest, kernel `6.12.113+deb13-amd64`, 2 GiB RAM, two vCPUs,
  Nehalem CPU model under TCG, independent qcow2 disk and private seed ISO.
- ARM64 OrbStack Linux `7.2.9-orbstack-00391-g2b298d05fbd4` in a disposable
  privileged Docker container. No host libvirt socket, existing VM disk or checkout
  mount was used. The wrapper removed its VM and container after finishing.

The local test image was prepared from the existing `ozwell-computer:dev` image by
installing the current checkout with `npm ci && make install`, including current
dependencies, system packages, service units and viewer. Docker's build frontend
fetch stalled on this host, so this was a local source installation rather than a
new release-package build. The old dpkg package version remains in provenance;
the installed application version is `0.0.0`. Recorded guest server/lifecycle bundle
hashes match the build from the current source. The standalone image builder then
added the kernel and required private-seed bootstrap service.

```sh
OZWELL_COMPUTER_IMAGE=ozwell-computer:libvirt-current \
  bash scripts/build-libvirt-image.sh /tmp/ozc-libvirt-final-image
OZC_LAB_SKIP_NWFILTER=1 LIBVIRT_IMAGE_DIR=/tmp/ozc-libvirt-final-image \
  bash scripts/libvirt-lifecycle-lab.sh /tmp/ozc-lifecycle-final
```

The host's kernel could not apply libvirt's anti-spoof ebtables rules; the production
provider correctly refused startup in strict runs. The successful lifecycle test
used the explicit **lab-only** XML adapter to omit `filterref`. Port isolation
remained enabled. Production has no bypass setting and still requires normal
filters. This result does not validate production network confinement or KVM
performance. Host reboot, storage corruption, long-duration sleeps and cross-host
restoration were not simulated.

Inspect [raw results](results.json), [image identity](image-manifest.json), and
[golden image checksums](image-SHA256SUMS). The random probe token is synthetic RAM
test data; guest and orchestrator access credentials are excluded. Private seed,
domain XML and serial logs are not published.

The complete root suite passed **238 tests** on Linux, including Chromium/Firefox
and the new guest lifecycle API. The API/MCP coverage check confirmed all **44
documented paths and 22 computer tools** were exercised. The orchestrator suite
passed **72 tests**, including save/wake races, surviving daemon jobs, ownership,
passive polling, streaming, canceled requests, startup retry and restore failures.
Both typechecks, root build and MCP catalog consistency check also passed.
