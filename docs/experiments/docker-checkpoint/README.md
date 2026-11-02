# Mac/OrbStack automatic idle checkpoint acceptance

The native ARM64 implementation passed three automatic save/restore cycles on
2026-10-31 using the production `DockerCheckpointProvider`, `IdleController`,
HTTP/WebSocket gateway and MCP server. The desktop was created through the
provider from the native Supervisor image. Its applications were not relaunched
to reconstruct state. See the [deployment guide](../../docker-checkpoint-deployment.md).

## Automatic lifecycle results

| Cycle | Automatic idle-to-saved wait¹ | Authorized request-to-result | Saved application |
|---|---:|---:|---|
| Viewer HTTP wake | 4.085 s | 1.755 s | PID 0, memory 0 B |
| MCP command wake | 4.105 s | 2.056 s | PID 0, memory 0 B |
| Controller restart while saved | 3.714 s | 1.697 s | PID 0, memory 0 B |

¹ Includes the test's 1.5-second idle grace, preparation, checkpoint and durable
receipt promotion. Production defaults to five minutes. Initial cold readiness
took 1.898 seconds. These are observations on this Mac, not universal latency
guarantees; save size and duration depend on the applications' memory.

Every saved interval had a completed checkpoint receipt, an exited application
container, PID zero and zero Docker memory. Its sleeping Alpine network anchor
remained alive at 45,056 bytes in this run. The external daemon and controller
also remain running. Every restoration retained:

- The same Python process PID, synthetic random RAM nonce, recomputed SHA256 of
  a nonzero 64 MiB payload, and an advancing in-memory counter.
- The same Zenity window and process, including unsaved text typed exactly once.
  Verification installed a fresh unrelated clipboard sentinel before copying the
  existing entry text; it did not retype the expected text.
- A working AT-SPI `text_field` match before saving and after each restoration.

All four window PNGs are byte-identical: 6,869 bytes, SHA256
`4b63274965f6d110b606aa176e5b6a15b2a2520cb41502dbbec5e2e342f39370`:

- [Before saving](gui-before.png)
- [After viewer wake](gui-after-viewer.png)
- [After MCP wake](gui-after-mcp.png)
- [After controller restart and wake](gui-after-controller-restart.png)

The same run verified that keep-awake leases, an open SSE stream, a WebSocket
viewer and a detached command job prevent saving. Explicit saves refused active
work. Passive health/metrics/status and anonymous requests left the saved desktop
asleep. A fresh controller rediscovered the saved computer without waking it.
Normal DNS and outbound HTTPS worked through the runtime's bridge/NAT.

Inspect [redacted lifecycle results](results.json), [runtime versions](runtime-version.json)
and [network verification](network.json). Synthetic RAM and GUI markers are test
data; computer/orchestrator access credentials and daemon diagnostics are excluded.

## Production Compose and HTTPS

The actual Compose deployment also passed MCP creation, automatic idle save and
authorized viewer restoration through OrbStack's management and wildcard HTTPS
domains, with certificates verified against OrbStack's public CA. It restored
the same 64 MiB nonce/hash/PID and advancing counter in **1.416 seconds**. The
application had zero PIDs and 0 B memory while saved.

This run used the pinned official Docker 29.8.2 DinD image (ARM64 manifest
`sha256:0cfe34780472229470f56736bbf85165a0f15e2da84a4798af89bed607f3ffc3`)
and the self-contained kit, rather than copied host executables. A deliberate
daemon SIGKILL automatically restarted both runtime and gateway and recovered
verified HTTPS without manual intervention. A gateway deliberately started in
the wrong network namespace exited before starting its CLI. These checks prove
runtime/frontend recovery; they do not prove preservation of an awake desktop
across an unplanned daemon crash. The owned computer, Compose project and volumes
were removed afterward. See [production results](production-compose.json).

## Mac host memory observation

A separate owned-daemon test allocated and touched a random **1 GiB RAM-only
payload**, checkpointed it, and restored its identical nonce, hash and PID with
the counter continuing. Saving took 6.112 seconds; restoring took 4.996 seconds.
While saved, Docker reported 0 B memory, zero PIDs and 0.00% CPU for the application.

Mac `ps` RSS samples for the shared OrbStack Helper were collected once per
second, with builds and other test work held quiet. The median of each phase's
last ten samples was:

| Phase | Shared OrbStack Helper RSS |
|---|---:|
| Before allocation | 4,845.8 MiB |
| Payload active | 6,219.7 MiB |
| Payload checkpointed | 5,615.4 MiB |
| Payload restored | 8,648.8 MiB |

Observed host RSS fell **604.3 MiB** during the saved interval. This establishes
host-level reclamation in this run, rather than relying solely on container
accounting. It does not establish immediate return of the entire payload to
macOS: the shared VM also holds unrelated services, runtime state and filesystem
caches produced by checkpoint I/O. Restoration raised RSS while loading pages.
No global cache flushing, memory-pressure injection, engine restart or OrbStack
setting change was used. Do not interpret application RAM zero as OrbStack RAM zero.

See [timestamped samples and state checks](host-memory.json). Reproduce the same
method with `OZC_CHECKPOINT_HOST_MEMORY=1` on the lab wrapper, keeping other
memory-heavy activity quiet. The helper script requires a matching disposable
daemon marker and no existing running workloads in that daemon.

## Runtime and provenance

- Apple Silicon Mac, macOS 27.0.1; OrbStack 2.2.4.
- ARM64 Linux `7.2.9-orbstack-00391-g2b298d05fbd4`.
- Docker 29.8.2, containerd 2.3.6, runc 1.5.2; Node 24.22.2.
- Native desktop image `sha256:663c21f279981015755cf99ba23e4398f9b26cd760d923bf261f43723b68a8ab`,
  profile `flat-v1`, default seccomp, no external TTY, no host cgroup bind.
- Self-contained CRIU v4.1 plus the three exact upstream fixes documented in
  the deployment guide, built successfully by the checked-in Dockerfile.

The main wrapper copied the exact installed OrbStack Docker/containerd/runc
executables read-only into its own isolated daemon. Its patched CRIU, engine data
and configuration remained private to that runtime. No host socket or workspace
mount, vendor executable replacement or engine restart was performed.

The image was built from the current uncommitted PR worktree based on `c32969e`.
The image's revision label therefore identifies that base commit; installed
current server/lifecycle hashes are recorded in the lifecycle results and
[regression manifest](regression.json). The latter also records current AT-SPI,
MCP and PTY bundles. This is a native source build, not the existing amd64
development image or a released package.

## Regression and limits

The full root suite passed **256 tests**: 191 unit tests and all 65 integration
tests, including Chromium and Firefox, running in an owned Linux QA helper
against the native ARM64 desktop on OrbStack. The existing coverage validator was
called explicitly after the `OZ_URL` run: all **44 documented paths and 22 computer
MCP tools** were exercised. Typecheck, build and generated catalog consistency
also passed. Regression tests include commands and MCP callbacks that continue
after an HTTP disconnect, PTY disconnect during module loading, and GTK3 entry
normalization. A Mac-host browser invocation exposed platform-specific clipboard
key and Firefox-launch failures; the final complete browser run used Linux.
The orchestrator typecheck and all **111 tests** passed, including failed and
ambiguous checkpoint jobs, ownership, save/wake races, missing restore state and
orphan cleanup that preserves foreign namespace users, including short-ID aliases.

Docker's metrics collector can return HTTP 500 `no metrics received` for a
restored running task. The acceptance script records unavailable running metrics
as `null`, never as zero. Saved-state zero-memory checks still require an exited
PID-zero application and successful saved-container metrics. RAM and GUI probes
independently establish resumed execution.

Container checkpoints recreate kernel tasks: numeric PIDs and application memory
survive, but `/proc` process start ticks may change. This is not the same kernel
continuity as libvirt's whole-VM managed save. Host reboot, storage corruption,
long sleeps, cross-host restore, GPU applications and future kernels were not
validated. Existing amd64/systemd/TTY desktops require an explicit migration to
the new profile. The host's existing development computer and database were left
running throughout.

Reproduce from the repository root after building the native desktop:

```sh
OZC_CHECKPOINT_IMAGE=ozwell-computer:checkpoint-arm64-flat \
  bash scripts/docker-checkpoint-lab.sh /tmp/ozwell-checkpoint-results
```
