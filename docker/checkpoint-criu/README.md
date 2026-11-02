The Dockerfile builds a native, self-contained CRIU kit under `/runtime`. It pins
CRIU v4.1 and three upstream compatibility fixes by full commit SHA. It does not
install anything on the host or change Docker's configuration.

```sh
docker build -f docker/checkpoint-criu/Dockerfile -t ozwell-criu:checkpoint .
```

A private runtime image can `COPY --from=ozwell-criu:checkpoint /runtime/ /`.
The wrapper at `/usr/local/sbin/criu` uses its bundled loader and libraries under
`/opt/ozc-criu`. A private capability-cache directory avoids invalidating the
vendor CRIU cache. Source identifiers, the exact patch, and SHA256 checksums ship
with the kit. Build it for the same native architecture as the desktop image.

Only checkpoint desktops should use OCI annotation
`org.criu.config=/opt/ozc-criu/ozwell.conf`. The config enables file-lock/TCP state
and overlay file-watch path lookup. Do not replace `/etc/criu/runc.conf` globally.
Normal Docker seccomp is required: an unconfined desktop may create io_uring
descriptors unsupported by this CRIU version.

Run the complete isolated acceptance test with a built native flat-v1 desktop:

```sh
OZC_CHECKPOINT_IMAGE=ozwell-computer:checkpoint-arm64-flat \
  scripts/docker-checkpoint-lab.sh /tmp/ozc-checkpoint-results
```

The lab builds and exports this kit, copies current code and images into a
separate daemon, verifies bridge DNS/HTTPS, then runs the actual provider,
controller, viewer/MCP wake gateway, and GUI/RAM test. It cleans up only its own
container, helper, and volume. No host directory or Docker socket is mounted.
Reports and screenshots are redacted; raw diagnostics stay in a private output
subdirectory. Shared OrbStack helper RSS observations are labeled as noisy and
are not evidence that the entire VM's memory becomes zero.

Set `OZC_CHECKPOINT_HOST_MEMORY=1` to add the separate macOS acceptance probe
before the lifecycle harness. It takes about 100 seconds, touches a 1 GiB RAM
payload, saves/restores its exact nonce/hash, and samples shared OrbStack helper
RSS across quiet baseline/active/saved periods. Run it when other builds and
image loads are quiet; shared VM activity still limits causal interpretation.

`OZC_CRIU_KIT_DIR` reuses an exported, checksum-verified kit.
`OZC_LAB_RUNTIME_SOURCE=host` (default) reads the exact OrbStack Docker,
containerd, and runc binaries through a disposable helper; `package` uses Alpine's
runtime packages and records their versions instead. Other hosts require
`OZC_CHECKPOINT_LAB_ALLOW_OTHER_HOST=1`. If Docker's metadata lookup stalls despite
a cached base, `DOCKER_BUILDKIT=0` selects the legacy builder for that invocation.
