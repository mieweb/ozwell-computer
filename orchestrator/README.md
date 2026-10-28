# ozwell-computer-orchestrator

One MCP endpoint for a whole Ozwell workspace that gives every user their own
ozwell-computers. It creates, lists and destroys computers through a pluggable
provider, and proxies every ozwell-computer tool with an extra `instance_id` argument.

## How it works

- **Stateless.** Every MCP request is handled independently. Who owns which computer,
  their metadata, URLs and access token all live in the provider (for Docker: container
  labels and env), so restarting or replicating the orchestrator loses nothing.
- **Per user.** Ozwell calls with one workspace-wide configuration, plus
  `X-Ozwell-User-Id` (required), `X-Ozwell-User-Email` and `X-Ozwell-User-Name`. Every
  tool is scoped to that user id: other users' computers are reported as not found.
  These headers are only trusted on requests carrying the pre-shared key.
- **Tools.**
  - Management: `list_computers`, `create_computer` (optional `display_name`; waits
    until ready), `get_computer` and `destroy_computer`. They return `instance_id` and
    `viewer_url`, which embeds the computer's token for the user to open.
  - Proxied: every tool in `../docs/mcp-tools.json` with `instance_id` added. That
    catalog is generated from the computer (`npm run mcp-tools` at the repo root), so
    the orchestrator knows the tools without a running instance.

## Run

```bash
npm ci
PROVIDER_URI=docker:///var/run/docker.sock ORCHESTRATOR_TOKEN=<psk> npm start
```

| Variable | Default | |
|---|---|---|
| `PROVIDER_URI` | (required) | provider and its settings; the scheme selects the provider |
| `ORCHESTRATOR_TOKEN` | (required) | pre-shared key; Ozwell sends `Authorization: Bearer <psk>` |
| `ORCHESTRATOR_AUTH_DISABLED` | `false` | development only: no PSK, so any caller can claim any user |
| `ORCHESTRATOR_HOST` / `ORCHESTRATOR_PORT` | `127.0.0.1` / `8090` | listen address |
| `TOOL_CATALOG` | `../docs/mcp-tools.json` | proxied tool definitions |
| `LOG_LEVEL` | `info` | |

Configure Ozwell's workspace MCP server as `http(s)://<orchestrator>/mcp` (Streamable
HTTP) with the header `Authorization: Bearer <psk>`. Put TLS in front of it.

## Providers

`PROVIDER_URI`'s scheme selects a provider (`src/providers/index.ts`). The rest of the
URI, and the environment, are passed to it. A provider implements `list(owner)`,
`get(id)`, `create({ owner, displayName })` and `destroy(id)`. Each computer reports:
- `id`: provider-generated and DNS-compatible;
- `owner` and metadata;
- `status`;
- `internalUrl` (orchestrator → instance) and `externalUrl` (given to users);
- `token`.

### `docker` (reference)

```
docker:///var/run/docker.sock                  local daemon
docker://host:2375                             remote daemon (plain TCP)
  ?image=ghcr.io/mieweb/ozwell-computer:latest image (pulled if missing)
  &network=<name>                              network to attach to
  &publish=1&publish_host=<host>               publish 8080 on a random host port and use
                                               http://<publish_host>:<port>; otherwise the
                                               container's IP is used for both URLs
```

Containers are named `ozc-<random>` and labelled `org.mieweb.ozwell-computer.*` (owner,
display name, email, user name, created). The token is in the container's environment.
It's a reference implementation: it uses the same systemd settings as `compose.yml`,
applies no resource limits, and anyone with the Docker socket can read every token.
