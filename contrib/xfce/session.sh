#!/bin/sh
# Desktop session for user "desktop", managed by xfce4-session. The first start runs the
# "Ozwell" failsafe session from xfce4-session.xml (xfwm4, a top bar and bottom dock from
# xfce4-panel, and a terminal); later starts restore the last saved session instead.
case "${1-}" in
    save)
        # Checkpoint: session-aware apps and xfwm4 save their state, then the session is written.
        exec dbus-send --session --print-reply --dest=org.xfce.SessionManager \
            /org/xfce/SessionManager org.xfce.Session.Manager.Checkpoint string: >/dev/null
        ;;
    stop)
        # Saves the session (SaveOnExit); wait for it to finish before systemd's SIGTERM.
        xfce4-session-logout --logout || exit
        while kill -0 "$MAINPID" 2>/dev/null; do sleep 0.2; done
        exit
        ;;
esac
/usr/libexec/at-spi-bus-launcher --launch-immediately &
# After xfwm4 starts, otherwise it clears the root to black. The checkpoints keep a
# recent session for when the desktop is killed without a clean stop.
( sleep 3; xsetroot -solid '#2e3440'; while sleep 60; do "$0" save; done ) &
exec xfce4-session
