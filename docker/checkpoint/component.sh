#!/bin/sh
set -eu

wait_desktop() {
    for attempt in $(seq 100); do
        if [ -S /tmp/.X11-unix/X0 ] && [ -S /run/desktop-bus/bus ]; then return; fi
        sleep 0.1
    done
    echo 'desktop X11/D-Bus sockets did not become ready' >&2
    exit 1
}

case "${1-}" in
    xvfb)
        exec /usr/bin/Xvfb :0 -screen 0 "$OZWELL_COMPUTER_SCREEN" -nolisten tcp +extension RANDR +extension DAMAGE -dpi 96
        ;;
    dbus)
        exec /usr/bin/dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS"
        ;;
    session)
        wait_desktop
        exec /opt/ozwell-computer/bin/ozwell-computer-session
        ;;
    server)
        wait_desktop
        for attempt in $(seq 100); do
            if dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.xfce.SessionManager 2>/dev/null | grep -q 'boolean true'; then
                exec /usr/bin/node /opt/ozwell-computer/dist/cli.js
            fi
            sleep 0.1
        done
        echo 'desktop session did not become ready' >&2
        exit 1
        ;;
    *) echo 'expected xvfb, dbus, session, or server' >&2; exit 2 ;;
esac
