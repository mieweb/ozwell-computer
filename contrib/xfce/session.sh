#!/bin/sh
# Desktop session for user "desktop": xfwm4 + a top bar and bottom dock (xfce4-panel).
/usr/libexec/at-spi-bus-launcher --launch-immediately &
xfwm4 --compositor=off &
sleep 1
# after xfwm4 starts, otherwise it clears the root to black
xsetroot -solid '#2e3440'
xfce4-panel &
xfce4-terminal --geometry=100x30+60+60 &
wait
