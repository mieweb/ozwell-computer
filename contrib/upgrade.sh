#!/bin/sh
# Upgrade ozwell-computer. Run as root by ozwell-computer-upgrade.service when the
# server (unprivileged) drops /var/lib/ozwell-computer/upgrade-request.
# Progress goes to upgrade.status ("<state> <epoch>") and upgrade.log in the same
# directory, which the server reports through GET /api/v1/update.
# OZWELL_COMPUTER_UPDATE_URL comes from this unit's own environment (never from the
# request file): git+https://<repo>#<branch> builds that branch, anything else uses apt.
set -u

STATE=/var/lib/ozwell-computer
PREFIX=@PREFIX@
SRC=/usr/src/ozwell-computer

status() {
    printf '%s %s\n' "$1" "$(date +%s)" > "$STATE/upgrade.status.tmp"
    chmod 0644 "$STATE/upgrade.status.tmp"
    mv -f "$STATE/upgrade.status.tmp" "$STATE/upgrade.status"
}

fail() {
    status failed
    exit 1
}

# The server's /health answers once it is up (its unit is Type=simple, so start returns at once).
# 20 probes of at most 2 s each, a second apart: about a minute in all.
healthy() {
    host=${OZWELL_COMPUTER_HOST:-127.0.0.1}
    case "$host" in 0.0.0.0|::) host=127.0.0.1 ;; *:*) host="[$host]" ;; esac
    url="http://$host:${OZWELL_COMPUTER_PORT:-8080}/health"
    for _ in $(seq 20); do
        node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$url" && return 0
        sleep 1
    done
    return 1
}

from_git() {
    url=${OZWELL_COMPUTER_UPDATE_URL#git+}
    repo=${url%%#*}
    branch=${url##*#}
    export HOME=${HOME:-/root} GIT_TERMINAL_PROMPT=0

    before=$(cat "$PREFIX/REVISION" 2>/dev/null || true)
    echo "installed: ${before:-none}"
    [ -d "$SRC/.git" ] || git clone --branch "$branch" "$repo" "$SRC" || fail
    # Full history and tags: ./package-version derives the version from them.
    git -C "$SRC" remote set-url origin "$repo" \
        && git -C "$SRC" fetch --tags --force origin "+refs/heads/$branch:refs/remotes/origin/$branch" || fail
    after=$(git -C "$SRC" rev-parse "origin/$branch") || fail
    echo "$branch is at $after"
    if [ "$after" = "$before" ]; then status unchanged; exit 0; fi

    # Build completely before installing, so a failed build leaves the install alone.
    git -C "$SRC" reset -q --hard "$after" && git -C "$SRC" clean -qffdx \
        && make -C "$SRC" deps build || fail
    # Stop only the server (Xvfb and apps open on the desktop keep running): replacing
    # its node_modules, native addons included, under the running process can crash it.
    systemctl stop ozwell-computer.service || fail
    # -o build: already built above; don't rebuild while the server is down.
    if ! { make -C "$SRC" -o build install PREFIX="$PREFIX" && systemctl daemon-reload \
        && systemctl start ozwell-computer.service && healthy \
        && systemctl try-restart ozwell-computer-upgrade.path; }; then
        # A commit no branch head has: the server keeps offering the update and a retry reinstalls
        # (removing REVISION would make it report updates as unsupported).
        echo 0000000000000000000000000000000000000000 > "$PREFIX/REVISION"
        systemctl start ozwell-computer.service
        fail
    fi
    echo "installed now: $after"
    status succeeded
}

# Mark running before taking the request, so the server never sees "no request,
# not running" in between (it would accept a second, duplicate request).
status running
rm -f "$STATE/upgrade-request"
: > "$STATE/upgrade.log"
chmod 0644 "$STATE/upgrade.log"
exec >>"$STATE/upgrade.log" 2>&1

case "${OZWELL_COMPUTER_UPDATE_URL:-}" in
    git+https://*\#*) from_git; exit 0 ;;
esac

before=$(dpkg-query -W -f='${Version}' ozwell-computer 2>/dev/null || true)
echo "installed: ${before:-none}"

export DEBIAN_FRONTEND=noninteractive
# Wait for another apt/dpkg (e.g. unattended-upgrades) instead of failing.
LOCK_WAIT="-o DPkg::Lock::Timeout=600"

# Finish anything an earlier, interrupted run left half-configured.
if dpkg --audit | grep -q .; then
    echo "completing an interrupted dpkg run:"
    dpkg --configure -a || { status failed; exit 1; }
fi
# One unreachable source shouldn't block the upgrade; apt reports which one failed.
apt-get $LOCK_WAIT update || echo "apt-get update reported errors; continuing"

if apt-get $LOCK_WAIT install -y --only-upgrade \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
        ozwell-computer; then
    after=$(dpkg-query -W -f='${Version}' ozwell-computer 2>/dev/null || true)
    echo "installed now: ${after:-none}"
    if [ "$after" = "$before" ]; then status unchanged; else status succeeded; fi
else
    status failed
    exit 1
fi
