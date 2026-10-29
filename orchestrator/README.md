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
  - Management: `list_computers`, `create_computer`, `get_computer` and
    `destroy_computer`. `create_computer` takes an optional `display_name`. It and
    `get_computer` wait up to about 40 s for the computer to start, then return
    `ready: false` if it is still starting (under the 60 s MCP client limit); the agent
    calls `get_computer` again. They return `instance_id` and
    `viewer_url`, which embeds the computer's token for the user to open.
  - Quota: with `ORCHESTRATOR_MAX_INSTANCES` set, `create_computer` fails with
    `quota_exceeded` once the user has that many computers (counted from the provider,
    whatever their status). The error lists them and tells the agent to reuse one, or to
    `destroy_computer` one only after the user explicitly agrees.
  - Proxied: every tool in `../docs/mcp-tools.json` with `instance_id` added. That
    catalog is generated from the computer (`npm run mcp-tools` at the repo root), so
    the orchestrator knows the tools without a running instance.

## Computer lifecycle

As the agent sees it. The orchestrator stores none of this: readiness is worked out on
each call from the provider's status and the computer's `GET /health` (204 once its X
display is connected).

```mermaid
stateDiagram-v2
    [*] --> Starting: create_computer
    Starting --> Starting: get_computer, ready false
    Starting --> Ready: GET /health returns 204
    Starting --> Stopped: status failed, exited, dead, missing or offline
    Ready --> Ready: proxied tool calls
    Ready --> Stopped: container stops
    Starting --> [*]: destroy_computer
    Ready --> [*]: destroy_computer
    Stopped --> [*]: destroy_computer
```

Every request is a stateless `POST /mcp` with Ozwell's headers. The orchestrator checks
them before any tool runs:

```mermaid
sequenceDiagram
    participant C as MCP client (Ozwell)
    participant O as Orchestrator
    C->>O: POST /mcp<br/>Authorization: Bearer psk, X-Ozwell-User-Id/-Email/-Name
    alt PSK missing or wrong
        O-->>C: 401 unauthenticated
    else no X-Ozwell-User-Id
        O-->>C: 400 invalid_request
    else
        O->>O: fresh MCP server for this user (no session)
        O-->>C: SSE response: tools/list or tools/call result
    end
```

### create_computer and get_computer

```mermaid
sequenceDiagram
    autonumber
    participant C as MCP client
    participant O as Orchestrator
    participant P as Provider
    participant I as ozwell-computer
    C->>O: tools/call create_computer (display_name)
    O->>P: create(owner = user, displayName)
    P-->>O: Computer: id, status, internalUrl, externalUrl, token
    loop every 1.5 s until ready, a dead status, or 40 s
        O->>P: get(id)
        P-->>O: Computer (URLs may only appear while it starts)
        O->>I: GET internalUrl/health
        I-->>O: 204 when ready, otherwise 503 or unreachable
    end
    O-->>C: instance_id, display_name, status, created_at, viewer_url, ready
    opt ready is false
        C->>O: tools/call get_computer (instance_id)
        O->>P: get(instance_id)
        alt missing, or owned by another user
            O-->>C: error target_unavailable
        else
            O->>O: same 40 s wait loop
            O-->>C: same fields as create_computer
        end
    end
```

`viewer_url` is `externalUrl/?token=...`: the user opens it to watch or take over.

### list_computers

```mermaid
sequenceDiagram
    participant C as MCP client
    participant O as Orchestrator
    participant P as Provider
    C->>O: tools/call list_computers
    O->>P: list(user id)
    P-->>O: that user's computers
    O-->>C: computers: instance_id, display_name, status, created_at, viewer_url
```

No readiness check: `status` is the provider's own.

### Proxied tool calls

Any tool from `docs/mcp-tools.json` (`screenshot`, `click`, `run_command`, ...):

```mermaid
sequenceDiagram
    autonumber
    participant C as MCP client
    participant O as Orchestrator
    participant P as Provider
    participant I as ozwell-computer
    C->>O: tools/call screenshot (instance_id, args)
    O->>P: get(instance_id)
    P-->>O: Computer
    alt missing, or owned by another user
        O-->>C: error target_unavailable
    else no internalUrl or token yet
        O-->>C: error target_unavailable (not reachable)
    else
        opt no cached session for this computer and user
            O->>I: POST /mcp initialize (Bearer instance token)
            I-->>O: Mcp-Session-Id
            O->>I: POST /mcp notifications/initialized
        end
        O->>I: POST /mcp tools/call screenshot (args without instance_id)
        opt HTTP 400 or 404: session lost (computer restarted)
            O->>I: initialize again, then retry tools/call once
        end
        I-->>O: CallToolResult
        O-->>C: CallToolResult, unchanged
    end
    Note over O,I: Sessions idle for 5 min are closed with DELETE /mcp.
```

The session's client name is the user's name, so the agent appears under it in the
viewer.

Each proxied call has an 11-minute HTTP timeout; that is not a command limit.
`run_command` waits at most 50 s (`wait_ms`, default 25 s), then returns the still-running
job, which the agent follows with `command_output`. The command itself may run for up
to 24 hours (`timeout_ms`, default 1 hour).

### destroy_computer

```mermaid
sequenceDiagram
    participant C as MCP client
    participant O as Orchestrator
    participant P as Provider
    C->>O: tools/call destroy_computer (instance_id)
    O->>P: get(instance_id)
    alt missing, or owned by another user
        O-->>C: error target_unavailable
    else
        O->>P: destroy(id)
        P-->>O: done (the computer and its storage are gone)
        O-->>C: ok true, instance_id
    end
```

## Run

```bash
npm ci
cp .env.example .env   # then edit
npm start
```

`npm start` reads `orchestrator/.env` if it exists (git-ignored). Variables already set in
the environment take precedence.

| Variable | Default | |
|---|---|---|
| `PROVIDER_URI` | (required) | provider and its settings; the scheme selects the provider |
| `ORCHESTRATOR_TOKEN` | (required) | pre-shared key; Ozwell sends `Authorization: Bearer <psk>` |
| `ORCHESTRATOR_AUTH_DISABLED` | `false` | development only: no PSK, so any caller can claim any user |
| `ORCHESTRATOR_HOST` / `ORCHESTRATOR_PORT` | `127.0.0.1` / `8090` | listen address |
| `TOOL_CATALOG` | `../docs/mcp-tools.json` | proxied tool definitions |
| `ORCHESTRATOR_MAX_INSTANCES` | unlimited | computers each user may have |
| `COMPUTER_FRAME_ANCESTORS` | none | origins (e.g. `https://app.ozwell.ai`) allowed to embed the viewer in an iframe; passed to computers when they are created as `OZWELL_COMPUTER_FRAME_ANCESTORS`, so existing computers keep their value |
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

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant D as Docker Engine API
    participant K as Container ozc-xxxx
    Note over O,D: create(owner, displayName)
    O->>D: POST /containers/create?name=ozc-xxxx<br/>labels org.mieweb.ozwell-computer.*, env OZWELL_COMPUTER_TOKEN
    opt HTTP 404: image not present
        O->>D: POST /images/create?fromImage=...
        O->>D: POST /containers/create (retry)
    end
    O->>D: POST /containers/ozc-xxxx/start
    D->>K: start: systemd boots Xvfb, the session and the server
    O->>D: GET /containers/ozc-xxxx/json
    D-->>O: labels, token, container IP or published port
    Note over O,D: list(owner)
    O->>D: GET /containers/json?all=1, filtered on the managed and owner labels
    O->>D: GET /containers/{id}/json for each (token and network)
    Note over O,D: get(id)
    O->>D: GET /containers/{id}/json
    D-->>O: null unless it has the managed label
    Note over O,D: destroy(id)
    O->>D: GET /containers/{id}/json (must be managed)
    O->>D: DELETE /containers/{id}?force=1&v=1
    D->>K: kill, remove it and its anonymous volumes
```

`status` is Docker's container state (`created`, `running`, `exited`, ...). Both URLs
are `http://<container IP>:8080`, or `http://<publish_host>:<host port>` with `publish=1`.

### `opensource-server`

```
opensource-server://manager.os.mieweb.org?site=<id>&domain=<external domain id>
  &template=ghcr.io/mieweb/ozwell-computer:latest
  &owner=tag|email
  &internal=external|ip
  &tls=0                                        (http, development only)
```

The API key comes from `OPENSOURCE_SERVER_API_KEY`.
- **Container:** each computer is an opensource-server container named `ozc-<random>`,
  with an `http` service on port 8080 published as `https://ozc-<random>.<domain>`.
  `authRequired` is off, because the computer has its own token.
- **Ownership:** it is always enforced by the Ozwell user id, kept in environment-variable
  tags (`OZWELL_ORCHESTRATOR_*`) next to `OZWELL_COMPUTER_TOKEN`. That is the only
  free-form metadata the API has.
  - `owner=tag` (default): containers belong to the API key's account.
  - `owner=email`: each container is also attributed to the opensource-server user whose
    email matches `X-Ozwell-User-Email`, so it appears in their dashboard. This needs an
    admin key, and creation fails for users without an opensource-server account.
- **Internal URL:** `internal=external` (default) reaches computers through their public
  URL. `internal=ip` uses `http://<ipv4>:8080`, for an orchestrator running on the
  site's network.
- **Note:** an admin key lists every container on the site; non-orchestrator containers
  are ignored.

The paths below are relative to the API base `/api/v1`, e.g. `GET /users` is
`GET /api/v1/users`.

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant S as opensource-server API
    participant K as Container ozc-xxxx
    Note over O,S: create(owner, displayName)
    opt owner=email
        O->>S: GET /users
        S-->>O: the uid whose mail is X-Ozwell-User-Email (else creation fails)
    end
    O->>S: POST /sites/{site}/containers<br/>hostname ozc-xxxx, template, username (owner=email),<br/>env OZWELL_ORCHESTRATOR_* and OZWELL_COMPUTER_TOKEN,<br/>http service 8080 as ozc-xxxx.{domain}, authRequired false
    S->>K: create and start from the template image
    O->>S: GET /sites/{site}/containers?hostname=ozc-xxxx
    S-->>O: status, ipv4Address, externalUrl (may be empty while starting)
    Note over O,S: list(owner)
    O->>S: GET /sites/{site}/containers
    S-->>O: all containers, kept if MANAGED and OWNER tags match
    Note over O,S: get(id)
    O->>S: GET /sites/{site}/containers?hostname={id}
    Note over O,S: destroy(id)
    O->>S: GET /sites/{site}/containers?hostname={id}
    S-->>O: numeric container id
    O->>S: DELETE /sites/{site}/containers/{numeric id}
    S->>K: delete
```

`status` is opensource-server's. The orchestrator polls `/health` on the internal URL
(`https://ozc-xxxx.<domain>` or `http://<ipv4>:8080`) until the computer answers.
