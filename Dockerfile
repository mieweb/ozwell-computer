# syntax=docker/dockerfile:1
ARG BASE=ghcr.io/mieweb/opensource-server/nodejs:latest

# ---- build: make deb (same base as runtime, so native modules match its glibc and Node ABI)
FROM ${BASE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git make python3 g++ ruby ruby-dev \
    && rm -rf /var/lib/apt/lists/*
ARG FPM_VERSION=1.16.0
RUN gem install --no-document fpm -v "${FPM_VERSION}"
WORKDIR /usr/src/ozwell-computer
# npm deps first, so they're cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci
# The whole checkout, including .git: the package version comes from git tags.
COPY . .
RUN make deb

# ---- the .deb on its own: docker buildx build --target deb --output type=local,dest=out .
FROM scratch AS deb
COPY --from=build /usr/src/ozwell-computer/*.deb /

# ---- runtime
FROM ${BASE}
# The package's dependencies (the desktop, ~all of the image) and the sample apps, in a
# layer of their own: cached until .fpm changes, so a commit only rebuilds and pushes
# the small layer with the package itself.
RUN --mount=type=bind,source=.fpm,target=/tmp/.fpm \
    deps=$(sed -n 's/^--depends "\{0,1\}\([^ "]*\).*/\1/p' /tmp/.fpm | grep -vx nodejs) \
    && apt-get update \
    && apt-get install -y --no-install-recommends $deps \
       # sample apps for agents to drive (zenity doubles as the AT-SPI test app):
       xterm zenity firefox-esr \
    && rm -rf /var/lib/apt/lists/*
# release: update from GitHub releases with apt. main: update by building the main
# branch from git (see the README), which needs the build stage's toolchain.
ARG UPDATE_CHANNEL=release
RUN [ "$UPDATE_CHANNEL" != main ] || { apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git make python3 g++ \
    && rm -rf /var/lib/apt/lists/*; }
RUN --mount=type=bind,from=build,source=/usr/src/ozwell-computer,target=/mnt/pkg \
    cp /mnt/pkg/ozwell-computer_*.deb /tmp/ \
    && apt-get install -y --no-install-recommends /tmp/ozwell-computer_*.deb \
    && rm -f /tmp/ozwell-computer_*.deb
# Track future releases from the GitHub release flat repo (added after the install
# above, so building the image doesn't depend on a published release).
COPY docker/ozwell-computer.sources /etc/apt/sources.list.d/ozwell-computer.sources
# main: a clean checkout of exactly this image's commit (a fresh clone: no build output,
# and no credentials from the CI checkout's .git/config), the git channel for both the
# server and the root upgrade unit, and no apt source that could replace that build.
RUN --mount=type=bind,from=build,source=/usr/src/ozwell-computer,target=/mnt/src \
    [ "$UPDATE_CHANNEL" != main ] || { git clone -q --no-hardlinks /mnt/src /usr/src/ozwell-computer \
    && git -C /usr/src/ozwell-computer checkout -q --detach "$(git -C /mnt/src rev-parse HEAD)" \
    && git -C /usr/src/ozwell-computer remote set-url origin https://github.com/mieweb/ozwell-computer.git \
    && echo 'OZWELL_COMPUTER_UPDATE_URL=git+https://github.com/mieweb/ozwell-computer.git#main' >> /etc/default/ozwell-computer \
    && rm /etc/apt/sources.list.d/ozwell-computer.sources; }

# ---- container-only adjustments (not part of the package)
# Firefox without first-run pages, password-save prompts or telemetry (agent-friendly).
COPY docker/firefox/policies.json /etc/firefox/policies/policies.json
# systemd logs to the journal only, so with a TTY the container console carries just
# ozwell-computer's output; the units also read `docker run -e` values from /etc/environment.
COPY docker/systemd/system.conf.d/ /etc/systemd/system.conf.d/
COPY docker/systemd/ozwell-computer-desktop.service.d/ /etc/systemd/system/ozwell-computer-desktop.service.d/
COPY docker/systemd/user/ozwell-computer.service.d/ /etc/systemd/user/ozwell-computer.service.d/
COPY docker/systemd/ozwell-computer-upgrade.service.d/ /etc/systemd/system/ozwell-computer-upgrade.service.d/
# Passwordless sudo for the desktop user (see docker/sudoers.d/ozwell-computer and the README).
COPY --chmod=0440 docker/sudoers.d/ozwell-computer /etc/sudoers.d/ozwell-computer
# The tty group lets the server write its startup link to /dev/console.
RUN visudo -cf /etc/sudoers.d/ozwell-computer && usermod -aG tty desktop \
 && systemctl mask console-getty.service && systemctl enable environment.service
ENV DISPLAY=:0
# systemd falls back to the console until journald is up; only show errors.
# TERM=dumb stops its console reset escape codes.
ENV SYSTEMD_LOG_TARGET=journal SYSTEMD_LOG_LEVEL=err TERM=dumb
EXPOSE 8080
LABEL org.mieweb.opensource-server.services.http.default-port="8080" \
      org.opencontainers.image.title="ozwell-computer" \
      org.opencontainers.image.source="https://github.com/mieweb/ozwell-computer" \
      org.opencontainers.image.licenses="MIT"
STOPSIGNAL SIGRTMIN+3
