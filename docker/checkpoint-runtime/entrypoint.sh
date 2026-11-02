#!/bin/sh
set -eu
# The socket and engine state belong exclusively to this runtime. Never enable
# Docker's unauthenticated TCP listener or inherit the outer engine's socket.
if [ "$#" -ne 0 ]; then
  echo 'This runtime accepts no daemon overrides; configure its private deployment instead.' >&2
  exit 1
fi
cd /
sha256sum -c /opt/ozc-criu/SHA256SUMS >/dev/null
mkdir -p /run/ozc-criu /run/ozwell-docker
chmod 0700 /run/ozc-criu /run/ozwell-docker
# A dependent container retains its old network namespace when this container
# restarts. Let the gateway detect that boundary and rejoin via its restart policy.
generation=$(mktemp /run/ozwell-docker/.runtime-generation.XXXXXX)
printf '%s\n%s\n' "$(cat /proc/sys/kernel/random/uuid)" "$(readlink /proc/self/ns/net)" > "$generation"
chmod 0600 "$generation"
mv -f "$generation" /run/ozwell-docker/runtime-generation
# Explicit dockerd avoids the official entrypoint's no-argument TCP defaults,
# while retaining stale PID cleanup, docker-init reaping and iptables setup.
exec /usr/local/bin/dockerd-entrypoint.sh dockerd --experimental \
  --host=unix:///run/ozwell-docker/docker.sock \
  --data-root=/var/lib/docker \
  --pidfile=/run/ozwell-docker/dockerd.pid
