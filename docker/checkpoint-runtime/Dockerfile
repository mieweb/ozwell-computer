ARG CRIU_KIT_IMAGE=ozwell-criu:checkpoint
FROM ${CRIU_KIT_IMAGE} AS criu-kit

FROM docker:29.8.2-dind
# CRIU archives tmpfs mounts using GNU tar options unavailable in BusyBox tar.
RUN apk add --no-cache tar
COPY --from=criu-kit /runtime/ /
COPY docker/checkpoint-runtime/entrypoint.sh /usr/local/bin/ozwell-runtime
ENV DOCKER_HOST=unix:///run/ozwell-docker/docker.sock DOCKER_TLS_CERTDIR=""
HEALTHCHECK --interval=2s --timeout=3s --start-period=10s --retries=30 \
  CMD docker info >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/bin/ozwell-runtime"]
CMD []
