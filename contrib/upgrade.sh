#!/bin/sh
# Upgrade the ozwell-desktop package. Run as root by ozwell-desktop-upgrade.service
# when the server (unprivileged) drops /var/lib/ozwell-desktop/upgrade-request.
# Progress goes to upgrade.status ("<state> <epoch>") and upgrade.log in the same
# directory, which the server reports through GET /api/v1/update.
set -u

STATE=/var/lib/ozwell-desktop

status() {
    printf '%s %s\n' "$1" "$(date +%s)" > "$STATE/upgrade.status.tmp"
    chmod 0644 "$STATE/upgrade.status.tmp"
    mv -f "$STATE/upgrade.status.tmp" "$STATE/upgrade.status"
}

# Mark running before taking the request, so the server never sees "no request,
# not running" in between (it would accept a second, duplicate request).
status running
rm -f "$STATE/upgrade-request"
: > "$STATE/upgrade.log"
chmod 0644 "$STATE/upgrade.log"
exec >>"$STATE/upgrade.log" 2>&1

before=$(dpkg-query -W -f='${Version}' ozwell-desktop 2>/dev/null || true)
echo "installed: ${before:-none}"

export DEBIAN_FRONTEND=noninteractive
# One unreachable source shouldn't block the upgrade; apt reports which one failed.
apt-get update || echo "apt-get update reported errors; continuing"

if apt-get install -y --only-upgrade \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
        ozwell-desktop; then
    after=$(dpkg-query -W -f='${Version}' ozwell-desktop 2>/dev/null || true)
    echo "installed now: ${after:-none}"
    if [ "$after" = "$before" ]; then status unchanged; else status succeeded; fi
else
    status failed
    exit 1
fi
