#!/usr/bin/env bash
# Real native Docker checkpoint acceptance in an owned, isolated Docker daemon.
# No host Docker socket, host directory mounts, engine restart, or vendor writes.
set -euo pipefail
umask 077
script_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$script_dir/.." && pwd)
output=${1:-$(mktemp -d "${TMPDIR:-/tmp}/ozc-docker-checkpoint-results.XXXXXX")}
image=${OZC_CHECKPOINT_IMAGE:-ozwell-computer:checkpoint-arm64-flat}
runtime_source=${OZC_LAB_RUNTIME_SOURCE:-host}
host_memory=${OZC_CHECKPOINT_HOST_MEMORY:-0}
[[ "$host_memory" =~ ^[01]$ ]] || { echo 'OZC_CHECKPOINT_HOST_MEMORY must be 0 or 1' >&2; exit 1; }
lab="ozc-mac-checkpoint-lab-$$"
exporter="$lab-runtime-export"
kit_container="$lab-kit"
kit_image="ozc-mac-checkpoint-criu:build-$$"
volume="$lab-data"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ozc-docker-checkpoint-build.XXXXXX")
created_kit=0
mkdir -p "$output/private" "$output/runtime-kit"
output=$(cd "$output" && pwd)
record_host_memory() {
  python3 - "$output/host-memory-observations.jsonl" "$1" <<'PY'
import datetime,json,os,subprocess,sys
row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase':sys.argv[2],
     'shared_vm':True,'note':'Shared OrbStack helper RSS; builds and other containers introduce noise. This does not establish causal host memory reclamation.'}
try:
    supplied=os.environ.get('OZC_ORBSTACK_HELPER_PID','')
    rows=subprocess.run(['ps','-axo','pid=,rss=,comm='],capture_output=True,text=True).stdout.splitlines()
    pids=[supplied] if supplied.isdecimal() else [parts[0] for line in rows
        if len(parts:=line.split(None,2))==3 and parts[2].endswith('/Contents/MacOS/OrbStack Helper')]
    samples=[]
    for pid in pids:
        values=subprocess.run(['ps','-p',pid,'-o','pid=,rss='],capture_output=True,text=True).stdout.split()
        if len(values)==2:samples.append({'pid':int(values[0]),'rss_kib':int(values[1])})
    row['processes']=samples
except (OSError,ValueError):row['processes']=[]
with open(sys.argv[1],'a') as out:out.write(json.dumps(row)+'\n')
PY
}
cleanup() {
  status=$?
  trap - EXIT
  docker cp "$lab:/lab/output/." "$output/" >/dev/null 2>&1 || true
  # Raw daemon/install diagnostics stay private; the smoke exports redacted JSON.
  docker cp "$lab:/tmp/ozc-dockerd.log" "$output/private/daemon.log" >/dev/null 2>&1 || true
  docker rm -f "$lab" "$exporter" "$kit_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  if [ "$created_kit" = 1 ]; then docker image rm "$kit_image" >/dev/null 2>&1 || true; fi
  rm -rf "$scratch"
  record_host_memory after_cleanup || true
  printf 'Docker checkpoint lab evidence: %s\n' "$output"
  exit "$status"
}
trap cleanup EXIT
record_host_memory before_lab
engine_os=$(docker info --format '{{.OperatingSystem}}')
if [[ "$(uname -s)" != Darwin || "$engine_os" != *OrbStack* ]]; then
  [[ "${OZC_CHECKPOINT_LAB_ALLOW_OTHER_HOST:-0}" = 1 ]] || {
    echo 'This lab defaults to Mac/OrbStack. Set OZC_CHECKPOINT_LAB_ALLOW_OTHER_HOST=1 for another explicitly disposable-capable host.' >&2
    exit 1
  }
fi
[[ "$runtime_source" = host || "$runtime_source" = package ]] || {
  echo 'OZC_LAB_RUNTIME_SOURCE must be host or package' >&2; exit 1;
}
docker image inspect "$image" >/dev/null
profile=$(docker image inspect "$image" --format '{{index .Config.Labels "org.mieweb.ozwell-computer.checkpoint-profile"}}')
[[ "$profile" = flat-v1 ]] || { echo 'Build the native flat-v1 checkpoint image first.' >&2; exit 1; }

if [ -n "${OZC_CRIU_KIT_DIR:-}" ]; then
  cp -R "$OZC_CRIU_KIT_DIR/." "$output/runtime-kit/"
else
  docker build --force-rm -f "$repo_dir/docker/checkpoint-criu/Dockerfile" -t "$kit_image" "$repo_dir" \
    > "$output/private/criu-build.log" 2>&1
  created_kit=1
  docker create --name "$kit_container" "$kit_image" >/dev/null
  docker cp "$kit_container:/runtime/." "$output/runtime-kit/" >/dev/null
fi
kit_dir="$output/runtime-kit"
test -f "$kit_dir/opt/ozc-criu/SHA256SUMS"
test -f "$kit_dir/opt/ozc-criu/ozwell.conf"
# Verify exported binary/library bytes without relying on platform-specific shasum.
python3 - "$kit_dir" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
for line in (root/'opt/ozc-criu/SHA256SUMS').read_text().splitlines():
    expected,name=line.split(None,1)
    path=(root/name).resolve()
    if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
        raise SystemExit('CRIU kit SHA256 verification failed')
PY

# This daemon owns a separate data volume and shares no host engine state.
# Host cgroup namespace enables normal unprivileged nested desktop supervision.
docker run -d --name "$lab" --privileged --cgroupns=host --tmpfs /run \
  --mount "type=volume,src=$volume,dst=/var/lib/docker" \
  alpine:latest sleep infinity >/dev/null
docker exec "$lab" sh -ec '
  apk add --no-cache docker-engine docker-cli iptables ip6tables tar nodejs npm python3 > /tmp/lab-install.log 2>&1
  test "$(node -p "Number(process.versions.node.split(\".\")[0]) >= 24")" = true
  mkdir -p /lab/source /lab/output /run/ozc-criu
'
docker cp "$kit_dir/." "$lab:/" >/dev/null
if [ "$runtime_source" = host ]; then
  [[ "$engine_os" = *OrbStack* ]] || {
    echo 'Host binary export supports OrbStack only; use OZC_LAB_RUNTIME_SOURCE=package on another host.' >&2; exit 1;
  }
  # Read only the vendor runtime executables/libraries through an owned helper.
  # No host files are modified, and no host socket or directory is bind-mounted.
  docker run --name "$exporter" --privileged --pid=host alpine:latest sh -ec '
    mkdir /export
    host_root=$(stat -Lc "%d:%i" /proc/1/root)
    for wanted in dockerd containerd; do
      found=0
      for process in /proc/[0-9]*; do
        name=$(cat "$process/comm" 2>/dev/null || true)
        if [ "$name" = "$wanted" ] && [ "$(stat -Lc "%d:%i" "$process/root" 2>/dev/null || true)" = "$host_root" ]; then
          cp -L "$process/exe" "/export/$wanted"; found=1; break
        fi
      done
      test "$found" = 1
    done
    root=/proc/1/root
    cp -L "$root/usr/local/bin/containerd-shim-runc-v2" /export/containerd-shim-runc-v2
    cp -L "$root/usr/bin/.runc" /export/runc
    for library in libpathrs.so.0 libgcc_s.so.1 libseccomp.so.2; do
      if [ -e "$root/usr/lib/$library" ]; then cp -L "$root/usr/lib/$library" "/export/$library";
      else cp -L "$root/lib/$library" "/export/$library"; fi
    done
    cp -L "$root/usr/sbin/criu" /export/vendor-criu-readonly
    sha256sum /export/* > /export/SHA256SUMS
  ' > "$output/private/host-export.log" 2>&1
  mkdir -p "$scratch/host-runtime"
  docker cp "$exporter:/export/." "$scratch/host-runtime/" >/dev/null
  for binary in dockerd containerd containerd-shim-runc-v2 runc; do
    docker cp "$scratch/host-runtime/$binary" "$lab:/usr/local/bin/$binary" >/dev/null
  done
  for library in libpathrs.so.0 libgcc_s.so.1 libseccomp.so.2; do
    docker cp "$scratch/host-runtime/$library" "$lab:/usr/lib/$library" >/dev/null
  done
  cp "$scratch/host-runtime/SHA256SUMS" "$output/host-runtime-SHA256SUMS"
fi
docker exec -d "$lab" sh -ec '
  exec dockerd --experimental --host=unix:///run/docker.sock --data-root=/var/lib/docker \
    --pidfile=/run/ozc-dockerd.pid \
    --userland-proxy-path=/usr/bin/docker-proxy > /tmp/ozc-dockerd.log 2>&1
'
ready=0
for attempt in $(seq 60); do
  if docker exec "$lab" docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" = 1 ]] || { echo 'Owned nested Docker daemon did not become ready.' >&2; exit 1; }
docker exec "$lab" docker version --format '{{json .Server}}' > "$output/runtime-version.json"
docker exec "$lab" sh -ec '
  daemon_id=$(docker info --format "{{.ID}}")
  printf "{\"daemonId\":\"%s\"}\n" "$daemon_id" > /lab/.ozwell-checkpoint-lab
  cd / && sha256sum -c /opt/ozc-criu/SHA256SUMS >/dev/null
  criu --version
' > "$output/criu-version.txt"

# Cache images on the outer engine, then transfer bytes; never share its socket.
for dependency in node:24-bookworm-slim alpine:3.19; do
  docker image inspect "$dependency" >/dev/null 2>&1 || docker pull "$dependency" > "$output/private/image-pull.log" 2>&1
done
docker image save "$image" node:24-bookworm-slim alpine:3.19 | docker exec -i "$lab" docker load \
  > "$output/private/image-load.log"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$repo_dir" -cf - package.json orchestrator/package.json \
  orchestrator/package-lock.json orchestrator/src docs/mcp-tools.json scripts/smoke-docker-checkpoint.ts \
  | docker exec -i "$lab" tar -xpf - -C /lab/source
docker exec "$lab" sh -ec 'cd /lab/source/orchestrator; npm ci --ignore-scripts > /tmp/lab-npm.log 2>&1'
docker exec "$lab" docker run --rm --name "$lab-network-check" node:24-bookworm-slim node -e '
  Promise.all([require("node:dns/promises").lookup("example.com"),
    fetch("https://example.com",{signal:AbortSignal.timeout(15000)}).then(async r=>({status:r.status,bytes:(await r.text()).length}))])
    .then(rows=>{if(rows[1].status!==200)throw Error("HTTPS failed");console.log(JSON.stringify({passed:true,dns:rows[0],https:rows[1]}))})
    .catch(e=>{console.error(e.message);process.exitCode=1})
' > "$output/network.json"
if [ "$host_memory" = 1 ]; then
  # This host-side probe validates the owned daemon marker before mutations.
  python3 "$script_dir/smoke-docker-checkpoint-host-memory.py" "$lab" "$output/host-memory.json"
fi
record_host_memory before_smoke
docker exec -e OZC_DOCKER_CHECKPOINT_LAB=1 -e OZC_CHECKPOINT_IMAGE="$image" \
  -e OZC_DOCKER_SOCKET=/var/run/docker.sock -e DOCKER_CHECKPOINT_DAEMON_SOCKET=/var/run/docker.sock \
  "$lab" node /lab/source/scripts/smoke-docker-checkpoint.ts /lab/output/results.json \
  | while IFS= read -r line; do
      printf '%s\n' "$line"
      case "$line" in *'automatically checkpointed;'*) record_host_memory checkpoint_notice ;; esac
    done
