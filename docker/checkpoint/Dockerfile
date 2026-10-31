# Native architecture image for Docker/CRIU desktops. Build from the repository root.
ARG BASE=node:24-bookworm-slim
FROM ${BASE} AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends make python3 g++ git \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY Makefile package-version .fpm tsconfig.json ./
COPY src/ src/
COPY web/ web/
COPY contrib/ contrib/
RUN make install DESTDIR=/stage

FROM ${BASE}
COPY .fpm /tmp/ozwell-dependencies
RUN deps=$(sed -n 's/^--depends "\{0,1\}\([^ "]*\).*/\1/p' /tmp/ozwell-dependencies | grep -vx nodejs) \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      $deps supervisor sudo xterm zenity firefox-esr ca-certificates file \
 && ln -sf /usr/local/bin/node /usr/bin/node \
 && rm -rf /var/lib/apt/lists/* /tmp/ozwell-dependencies
COPY --from=build /stage/ /
COPY contrib/postinst /tmp/ozwell-postinst
COPY docker/firefox/policies.json /etc/firefox/policies/policies.json
COPY docker/sudoers.d/ozwell-computer /etc/sudoers.d/ozwell-computer
COPY docker/checkpoint/entrypoint.sh /usr/local/bin/ozwell-checkpoint-entrypoint
COPY docker/checkpoint/component.sh /usr/local/bin/ozwell-checkpoint-component
COPY docker/checkpoint/supervisord.conf /etc/supervisor/ozwell-checkpoint.conf
ARG SOURCE_REVISION=unknown
RUN sh /tmp/ozwell-postinst configure '' \
 && rm /tmp/ozwell-postinst \
 && chmod 0440 /etc/sudoers.d/ozwell-computer \
 && visudo -cf /etc/sudoers.d/ozwell-computer \
 && chmod 0755 /usr/local/bin/ozwell-checkpoint-entrypoint /usr/local/bin/ozwell-checkpoint-component \
 && rm -f /etc/machine-id /var/lib/dbus/machine-id \
 && printf '%s\n' "$SOURCE_REVISION" > /opt/ozwell-computer/REVISION
LABEL org.opencontainers.image.source="https://github.com/mieweb/ozwell-computer" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.mieweb.ozwell-computer.checkpoint-image="1" \
      org.mieweb.ozwell-computer.checkpoint-profile="flat-v1"
ENV container=docker DISPLAY=:0 TERM=dumb OZWELL_COMPUTER_UPDATE_URL=off
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/ozwell-checkpoint-entrypoint"]
CMD []
