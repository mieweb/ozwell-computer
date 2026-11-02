# Idle hibernation on Mac with Docker and OrbStack

The `docker-checkpoint` provider saves each idle Ozwell desktop's processes and
memory with Docker/CRIU, then restores them when an authorized viewer, API or MCP
request arrives. It uses the same idle controller and wake gateway as the
[libvirt provider](libvirt-deployment.md). The default idle grace is five minutes.

This releases the desktop container's resident application memory and stops its
CPU execution. It does not hibernate macOS or the shared OrbStack Linux VM.
The wake gateway, a dedicated Docker daemon and a small sleeping network anchor
for each computer remain running. OrbStack can reclaim unused Linux memory for
macOS; filesystem caches and these control processes mean the entire OrbStack
allocation will not fall to zero.

## Runtime layout

```mermaid
flowchart LR
    client[Viewer / API / MCP] --> proxy[OrbStack wildcard HTTPS]
    proxy --> gateway[Always available gateway + idle controller]
    gateway --> socket[Private UNIX Docker socket]
    socket --> daemon[Dedicated checkpoint Docker daemon]
    daemon --> anchor[Sleeping network anchor]
    anchor --- desktop[Native desktop: X11 + apps + API]
    desktop --> save[CRIU memory images on persistent volume]
```

[The Compose deployment](../orchestrator/compose.checkpoint.yml) adds a private
privileged runtime container inside the existing OrbStack installation. Its
engine data and socket use named volumes. The gateway shares its network
namespace so it can reach the inner desktops. The host Docker socket is not
mounted and OrbStack's executables and configuration are not modified.

The runtime is an administrator boundary: its private socket permits reading
computer tokens and controlling all of its desktops. Keep that socket local.
Only the gateway's HTTP port is exposed through OrbStack. Keep authentication
enabled and use the returned computer viewer URLs.

The native desktop image uses Supervisor as PID 1 to keep all application
processes in one cgroup. It starts the same Xvfb, session D-Bus, XFCE and API as
the standard image. It uses ordinary container isolation, the default Docker
seccomp profile and no external TTY. The daemon preflights architecture and
the `org.mieweb.ozwell-computer.checkpoint-profile=flat-v1` image label.

## First installation

Requirements: a running OrbStack Docker engine on an Apple Silicon Mac, Docker
Compose, Bash, OpenSSL, and enough free disk space for image builds and saved
application RAM. Build and run from the repository root:

```sh
bash scripts/start-checkpoint-runtime.sh
```

The script builds the CRIU kit, native desktop, runtime and orchestrator images,
loads the desktop and helper images into the private engine, and starts the
gateway. It generates an orchestrator key in a private configuration file and
prints the file location without displaying the key. It refuses to overwrite an
existing runtime; use the operational steps below for an installed deployment.
The first build requires Internet access and takes longer than subsequent boots.
The bootstrap defaults to Docker's legacy builder for this invocation so cached
native stages do not require a separate BuildKit metadata request. It leaves host
builder settings unchanged; set `DOCKER_BUILDKIT=1` explicitly to use BuildKit.

Connect Ozwell's workspace MCP client to the gateway's `/mcp` endpoint using
`Authorization: Bearer <ORCHESTRATOR_TOKEN>` and `X-Ozwell-User-Id`. The gateway
is reachable at `https://ozwell-checkpoint.local`; individual desktops use
`https://<instance_id>.ozwell-computers.local`. OrbStack's wildcard hostname
routes remain available while a desktop is saved. Its local CA must be trusted
by the client for HTTPS.

`create_computer` creates a new checkpoint-compatible desktop. The existing
`ozwell-computer-ozwell-computer-1` development container continues independently.
Its amd64/systemd/TTY processes cannot be converted into this native profile
without restarting them. Move files and reopen work in a new computer when ready;
the implementation does not silently replace an existing desktop.

Settings can be supplied to Compose through its private environment file:

```dotenv
ORCHESTRATOR_IDLE_MS=300000
ORCHESTRATOR_IDLE_POLL_MS=15000
ORCHESTRATOR_MAX_INSTANCES=3
```

Set idle milliseconds to `0` to disable automatic saves. The explicit
`hibernate_computer`, `keep_computer_awake` and `allow_computer_hibernation` tools
remain available. A keep-awake lease expires automatically; renew it for long
unattended application work.

## Activity and restoration

Open viewer connections, HTTP requests, SSE/WebSocket sessions, upgrades,
detached command jobs and keep-awake leases prevent saving. When the grace
expires, the guest atomically closes admission, drains idle HTTP connections,
and confirms there is no work before the provider asks Docker to checkpoint.
Requests racing with this transition wait for the shared lifecycle lock and
restore the desktop before forwarding. Mutating requests are never replayed.

Only authorized traffic wakes a saved desktop. Health, metrics, lifecycle status
and anonymous requests leave it saved. The gateway streams HTTP and WebSockets
and keeps each computer on its own stable hostname. Guest lifecycle preparation
and resumption are private controller operations.

The network anchor preserves the desktop's network namespace and IP while its
processes are absent. This also avoids Docker's independent-network checkpoint
restore regression. An external server may close connections during a long
sleep; preserving application memory cannot guarantee a remote session remains
valid. Use a lease when a download or other unattended application must continue.

## Persistence, recovery and maintenance

The private engine volume contains computer writable layers and RAM images.
Atomic container names retain `saving`, `saved` or `restoring` intent. Immutable
labels retain computer identity, ownership, URL and runtime configuration.
Operation worker containers retain actual Docker response receipts; an early
checkpoint directory or PID zero is not treated as successful completion.
The coordination volume holds local SQLite locking, not application state.

Restarting only the gateway rediscovers saved desktops without waking them.
All controller replicas must use the same engine socket and local coordination
volume. Do not start a second controller against this engine with a separate
lock directory. Remote TCP Docker endpoints are refused.

The deployment records a private runtime generation and network namespace
identity. Its gateway supervisor automatically restarts into the current namespace
after a runtime crash/restart; a stale namespace is rejected before starting the
controller. The actual HTTPS recovery path has been tested with a daemon SIGKILL.

For an installed deployment, use the same private environment file and Compose
project. For example, to apply a gateway configuration change:

```sh
checkpoint_env="$HOME/.config/ozwell-computer/checkpoint/checkpoint.env"
docker compose --env-file "$checkpoint_env" \
  -f orchestrator/compose.checkpoint.yml up -d --no-deps --no-build --wait gateway
```

If the first installation stopped after creating runtime state but before any
computers were created, preserve its volumes and resume using the already built
images. Do not rerun the bootstrap or remove volumes to bypass its guard:

```sh
docker compose --env-file "$checkpoint_env" \
  -f orchestrator/compose.checkpoint.yml up -d --no-build --wait runtime
docker image save ozwell-computer:checkpoint-arm64-flat node:24-bookworm-slim alpine:3.19 \
  | docker compose --env-file "$checkpoint_env" \
      -f orchestrator/compose.checkpoint.yml exec -T runtime docker load
docker compose --env-file "$checkpoint_env" \
  -f orchestrator/compose.checkpoint.yml up -d --no-build --wait gateway
```

A timed-out, missing or corrupt restore never falls back to an ordinary boot.
The saved image and intent remain in place for diagnosis. If an operation worker
was killed or its result is unknown, the provider keeps admission closed rather
than guessing that the job finished. Explicit `destroy_computer` deliberately
discards the computer, disk and saved RAM; it is not a restore repair command.

Do not run `docker start`, rename containers, remove checkpoints, delete runtime
volumes, or replace images behind the provider. Keep the checkpoint runtime and
helper image versions fixed while saved computers exist. Before runtime, kernel
or OrbStack upgrades, restore computers, save important files, and arrange a
controlled maintenance window. Controller restart is tested; restoring after
host reboot or across changed kernels/runtime versions is not established.

Saved RAM contains credentials and unsaved content. Restrict access to the named
volumes and use encrypted host storage. Budget disk space for live container
layers plus a checkpoint approximately proportional to the desktop's memory.
If checkpointing fails, the running workload is retained and the controller
reports the failure; inspect the runtime's daemon and CRIU logs.

## CRIU compatibility and reproducibility

The kit is built from CRIU v4.1 commit
`b6059ff193a9b0dff98e997134d662c3ccfd1600` with three exact upstream fixes:

| Upstream commit | Reason on the tested OrbStack kernel |
|---|---|
| [`189ad2c6`](https://github.com/checkpoint-restore/criu/commit/189ad2c6fea42ae480b10ffe06a28adada10ebc6) | tolerate removed UDP-Lite diagnostics |
| [`4b739859`](https://github.com/checkpoint-restore/criu/commit/4b73985955ecc01604d8ed1247605a5875042e4c) | restrict Unix credential socket options to supported socket families |
| [`1c6c68d1`](https://github.com/checkpoint-restore/criu/commit/1c6c68d1fecd8378fdcf433de995de783b49e4fb) | create restore helpers without shared file/FS contexts |

The image retains the source identifiers, patch, license and binary/library
checksums. Its loader and libraries are self-contained, and its capability cache
uses `/run/ozc-criu`. File-lock, established-TCP and inotify lookup settings are
applied only to checkpoint desktops through the `org.criu.config` annotation.
The kit is never installed as OrbStack's CRIU or as global `runc.conf`.

Run the destructive acceptance test only in its owned disposable daemon:

```sh
OZC_CHECKPOINT_IMAGE=ozwell-computer:checkpoint-arm64-flat \
  bash scripts/docker-checkpoint-lab.sh /tmp/ozwell-checkpoint-results
```

To include the separate 1 GiB Mac-host RSS observation, also set
`OZC_CHECKPOINT_HOST_MEMORY=1`. Keep other builds and memory-heavy work quiet for
its approximately 100-second baseline/save/restore sampling window. Host RSS is
shared and includes filesystem caches, so compare it separately from the strict
application PID/RAM-zero assertions.

The wrapper does not mount the host socket or workspace. It copies image/source
bytes into its own runtime, guards the smoke test with the exact daemon identity,
and removes its containers and data volume afterward. Private daemon diagnostics
are separate from the redacted results. See the recorded
[Mac acceptance evidence](experiments/docker-checkpoint/README.md).

Container checkpoints recreate kernel tasks: numeric PIDs and application memory
can survive while `/proc` process start ticks change. They are not a complete VM
snapshot. The Linux libvirt implementation preserves the guest kernel state as
well. Docker documents checkpoint/restore as experimental, and arbitrary
applications, GPU devices and future OrbStack kernels require compatibility
validation rather than an unconditional support claim.

References: [Docker checkpoint](https://docs.docker.com/reference/cli/docker/checkpoint/),
[OrbStack checkpoints](https://docs.orbstack.dev/docker/#checkpoints),
[memory efficiency](https://docs.orbstack.dev/efficiency), and
[wildcard domains](https://docs.orbstack.dev/docker/domains).
