#!/bin/sh
set -eu
# Every component inherits the original container environment, including all
# OZWELL_COMPUTER_* settings. No shell evaluation or config-file interpolation.
export DISPLAY=:0
export OZWELL_COMPUTER_HOST="${OZWELL_COMPUTER_HOST:-0.0.0.0}"
export OZWELL_COMPUTER_SCREEN="${OZWELL_COMPUTER_SCREEN:-1920x1080x24}"
export OZWELL_COMPUTER_TOKEN_FILE="${OZWELL_COMPUTER_TOKEN_FILE:-/var/lib/ozwell-computer/token}"
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/desktop-bus/bus
export XDG_CONFIG_DIRS=/opt/ozwell-computer/xdg:/etc/xdg
export XDG_RUNTIME_DIR="/run/user/$(id -u desktop)"
export GNOME_ACCESSIBILITY=1 GSK_RENDERER=cairo LIBGL_ALWAYS_SOFTWARE=1
export GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 QT_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1

install -d -m 0700 -o desktop -g desktop /run/desktop-bus /var/lib/ozwell-computer "$XDG_RUNTIME_DIR"
install -d -m 1777 /tmp/.X11-unix /tmp/.ICE-unix
dbus-uuidgen --ensure=/etc/machine-id
exec /usr/bin/supervisord -n -c /etc/supervisor/ozwell-checkpoint.conf
