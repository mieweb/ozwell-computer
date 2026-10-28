# syntax=docker/dockerfile:1
ARG BASE=ghcr.io/mieweb/opensource-server/nodejs:latest

# ---- build: make deb (same base as runtime, so native modules match its glibc and Node ABI)
FROM ${BASE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git make python3 g++ ruby ruby-dev \
    && rm -rf /var/lib/apt/lists/*
ARG FPM_VERSION=1.16.0
RUN gem install --no-document fpm -v "${FPM_VERSION}"
WORKDIR /usr/src/ozwell-desktop
# The whole checkout, including .git: the package version comes from git tags.
COPY . .
RUN make deps && make deb

# ---- the .deb on its own: docker buildx build --target deb --output type=local,dest=out .
FROM scratch AS deb
COPY --from=build /usr/src/ozwell-desktop/*.deb /

# ---- runtime
FROM ${BASE}
RUN --mount=type=bind,from=build,source=/usr/src/ozwell-desktop,target=/mnt/pkg \
    cp /mnt/pkg/ozwell-desktop_*.deb /tmp/ \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/ozwell-desktop_*.deb \
       # sample apps for agents to drive (zenity doubles as the AT-SPI test app):
       xterm zenity firefox-esr \
    && rm -rf /var/lib/apt/lists/* /tmp/ozwell-desktop_*.deb

# ---- container-only adjustments (not part of the package)
# systemd logs to the journal only, so with a TTY the container console carries just
# ozwell-desktop's output; the units also read `docker run -e` values from /etc/environment.
COPY docker/systemd/system.conf.d/ /etc/systemd/system.conf.d/
COPY docker/systemd/ozwell-desktop.service.d/ /etc/systemd/system/ozwell-desktop.service.d/
COPY docker/systemd/ozwell-desktop-xvfb.service.d/ /etc/systemd/system/ozwell-desktop-xvfb.service.d/
RUN systemctl mask console-getty.service && systemctl enable environment.service
ENV DISPLAY=:0
# systemd falls back to the console until journald is up; only show errors.
# TERM=dumb stops its console reset escape codes.
ENV SYSTEMD_LOG_TARGET=journal SYSTEMD_LOG_LEVEL=err TERM=dumb
EXPOSE 8080
LABEL org.mieweb.opensource-server.services.http.default-port="8080" \
      org.opencontainers.image.title="ozwell-desktop" \
      org.opencontainers.image.source="https://github.com/mieweb/ozwell-desktop" \
      org.opencontainers.image.licenses="MIT"
STOPSIGNAL SIGRTMIN+3
