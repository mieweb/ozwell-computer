#!/usr/bin/env bash
# First installation only. The private daemon never sees the host Docker socket.
set -euo pipefail
umask 077
# Avoid a remote BuildKit metadata resolution for already cached native stages.
# This affects this bootstrap only, not the user's Docker daemon configuration.
export DOCKER_BUILDKIT=${DOCKER_BUILDKIT:-0}
script_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$script_dir/.." && pwd)
compose_file="$repo_dir/orchestrator/compose.checkpoint.yml"
project=ozwell-checkpoint
config_dir=${OZC_CHECKPOINT_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ozwell-computer/checkpoint}
env_file="$config_dir/checkpoint.env"
image=ozwell-computer:checkpoint-arm64-flat
kit_image=ozwell-criu:checkpoint

for command in docker openssl; do
  command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done
docker compose version >/dev/null
engine_os=$(docker info --format '{{.OperatingSystem}}')
engine_arch=$(docker info --format '{{.Architecture}}')
if [[ "$(uname -s)" != Darwin || "$engine_os" != *OrbStack* || "$engine_arch" != aarch64 && "$engine_arch" != arm64 ]]; then
  echo 'This deployment is validated on Apple Silicon with OrbStack.' >&2
  exit 1
fi
# Existing state may contain saved application RAM even if no runtime is running.
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ||
      -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
  echo 'Checkpoint runtime state already exists. Refusing to rebuild or restart an installed deployment; follow the documented maintenance procedure.' >&2
  exit 1
fi
if [[ -e "$env_file" || -L "$env_file" || -L "$config_dir" ]]; then
  echo 'Private checkpoint configuration already exists or uses a symlink. Refusing to replace it.' >&2
  exit 1
fi
for setting in ORCHESTRATOR_IDLE_MS ORCHESTRATOR_IDLE_POLL_MS ORCHESTRATOR_MAX_INSTANCES; do
  value=${!setting:-}
  [[ -z "$value" || "$value" =~ ^[0-9]+$ ]] || { printf '%s must be a non-negative integer.\n' "$setting" >&2; exit 1; }
done
for setting in ORCHESTRATOR_IDLE_MS ORCHESTRATOR_IDLE_POLL_MS; do
  value=${!setting:-}
  if [[ -n "$value" ]]; then
    [[ "$value" =~ ^0*([0-9]{1,8})$ ]] && (( 10#${BASH_REMATCH[1]} <= 86400000 )) || {
      printf '%s must be at most 86400000 milliseconds.\n' "$setting" >&2; exit 1;
    }
  fi
done
[[ ! "${ORCHESTRATOR_IDLE_POLL_MS:-15000}" =~ ^0+$ ]] || { echo 'ORCHESTRATOR_IDLE_POLL_MS must be positive.' >&2; exit 1; }
# Escape dotenv syntax and Compose interpolation without exposing the value.
dotenv() {
  local value=$2
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo 'Checkpoint settings must contain a single line.' >&2; return 1; }
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\$\$}
  printf '%s="%s"\n' "$1" "$value"
}
compose() { docker compose --project-name "$project" --env-file "$env_file" -f "$compose_file" "$@"; }

echo 'Building the native checkpoint kit, desktop, private runtime and gateway...'
docker build -f "$repo_dir/docker/checkpoint-criu/Dockerfile" -t "$kit_image" "$repo_dir"
revision=$(git -C "$repo_dir" rev-parse HEAD)
docker build -f "$repo_dir/docker/checkpoint/Dockerfile" --build-arg "SOURCE_REVISION=$revision" -t "$image" "$repo_dir"
docker build -f "$repo_dir/docker/checkpoint-runtime/Dockerfile" --build-arg "CRIU_KIT_IMAGE=$kit_image" -t ozwell-computer-runtime:checkpoint "$repo_dir"
docker build -f "$repo_dir/orchestrator/Dockerfile" -t ozwell-computer-orchestrator:checkpoint "$repo_dir"
for dependency in node:24-bookworm-slim alpine:3.19; do
  docker image inspect "$dependency" >/dev/null 2>&1 || docker pull "$dependency"
done

# Builds/pulls can fail harmlessly and be retried without leaving installation
# intent. Only now create private configuration and persistent runtime state.
mkdir -p "$config_dir"
chmod 0700 "$config_dir"
token=${ORCHESTRATOR_TOKEN:-$(openssl rand -hex 32)}
set -o noclobber
{
  dotenv ORCHESTRATOR_TOKEN "$token"
  dotenv CHECKPOINT_COMPUTER_IMAGE "$image"
  dotenv CRIU_KIT_IMAGE "$kit_image"
  dotenv ORCHESTRATOR_IDLE_MS "${ORCHESTRATOR_IDLE_MS:-300000}"
  dotenv ORCHESTRATOR_IDLE_POLL_MS "${ORCHESTRATOR_IDLE_POLL_MS:-15000}"
  dotenv ORCHESTRATOR_MAX_INSTANCES "${ORCHESTRATOR_MAX_INSTANCES:-3}"
  dotenv COMPUTER_FRAME_ANCESTORS "${COMPUTER_FRAME_ANCESTORS:-}"
} > "$env_file"
set +o noclobber
unset token
chmod 0600 "$env_file"
trap 'bootstrap_exit_status=$?; if [[ "$bootstrap_exit_status" != 0 ]]; then printf "Installation stopped; preserve runtime volumes and use the maintenance procedure with private configuration: %s\\n" "$env_file" >&2; fi' EXIT
compose up -d --no-build --wait runtime
echo 'Loading native desktop and operation images into the private engine...'
docker image save "$image" node:24-bookworm-slim alpine:3.19 \
  | compose exec -T runtime docker load
compose up -d --no-build --wait gateway
printf 'Checkpoint gateway: https://ozwell-checkpoint.local\nPrivate configuration: %s\n' "$env_file"
