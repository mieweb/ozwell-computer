# syntax=docker/dockerfile:1
ARG BASE=ghcr.io/mieweb/opensource-server/nodejs:latest

# ---- build: same base as runtime so native modules (sharp, node-pty) match glibc/Node ABI
FROM ${BASE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xfwm4 xfce4-panel xfconf thunar adwaita-icon-theme dbus-daemon at-spi2-core libatk-adaptor xdg-utils x11-xserver-utils xclip \
      fonts-dejavu-core fonts-noto-core ca-certificates \
      # sample apps for agents to drive (zenity doubles as the AT-SPI test app):
      xfce4-terminal xterm zenity firefox-esr \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/dist /opt/ozwell-desktop/dist
COPY --from=build /src/node_modules /opt/ozwell-desktop/node_modules
COPY --from=build /src/package.json /opt/ozwell-desktop/
COPY docker/systemd/*.service /etc/systemd/system/
COPY docker/xfce/xfconf/ /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/
COPY docker/xfce/applications/ /usr/share/applications/
COPY docker/xfce/session.sh /usr/local/bin/ozwell-desktop-session
COPY docker/xfce/mimeapps.list /etc/xdg/mimeapps.list
COPY docker/systemd/quiet.conf /etc/systemd/system.conf.d/ozwell-desktop.conf
RUN useradd -m -s /bin/bash desktop \
 && install -d -o desktop -g desktop -m 700 /var/lib/ozwell-desktop \
 && ln -s /opt/ozwell-desktop/dist/cli.js /usr/local/bin/ozwell-desktop \
 && systemctl mask console-getty.service \
 && systemctl enable environment.service desktop-dbus.service xvfb.service desktop-session.service ozwell-desktop.service
ENV DISPLAY=:0
# With a TTY the container console (docker logs) carries only ozwell-desktop's output:
# systemd logs to the journal, and only errors (it falls back to the console until
# journald is up). TERM=dumb stops systemd's console reset escape codes.
ENV SYSTEMD_LOG_TARGET=journal SYSTEMD_LOG_LEVEL=err TERM=dumb
EXPOSE 8080
LABEL org.mieweb.opensource-server.services.http.default-port="8080" \
      org.opencontainers.image.title="ozwell-desktop" \
      org.opencontainers.image.source="https://github.com/mieweb/ozwell-desktop" \
      org.opencontainers.image.licenses="MIT"
STOPSIGNAL SIGRTMIN+3
