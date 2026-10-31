# Build a self-contained native CRIU kit; no daemon or host changes are performed.
# Export /runtime from the resulting image, or COPY it into a private runtime image.
FROM node:24-bookworm-slim AS build
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential git pkg-config libprotobuf-dev libprotobuf-c-dev \
      protobuf-c-compiler protobuf-compiler python3-protobuf libnl-3-dev \
      libcap-dev uuid-dev libnet1-dev libnftables-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY docker/checkpoint-criu/build.sh /build-kit.sh
COPY docker/checkpoint-criu/criu /kit-criu
COPY docker/checkpoint-criu/ozwell.conf /kit-ozwell.conf
RUN sh /build-kit.sh

FROM scratch AS kit
COPY --from=build /runtime /runtime
# This image is an export artifact, not an application image.
CMD ["/runtime/opt/ozc-criu/bin/criu", "--version"]
