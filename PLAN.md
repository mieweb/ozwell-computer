# Implementation Plan: `ozwell-computer`

**Goal:** A single Docker image based on `ghcr.io/mieweb/opensource-server/base:latest`
(hardened Debian 13, systemd as PID 1) that serves one HTTP port:

- `/` gives a human a browser view of the X11 desktop through noVNC.
- `/api/*` and `/mcp` let automation and AI agents view and control the same desktop.

The server is a Node.js application that also runs outside the container against
any X display. It takes CUA (trycua/cua) as design inspiration only and is **not**
wire-compatible with it.

> Assumption: the base image is Debian 13 with apt and systemd as PID 1, and is run
> with the cgroup and tmpfs settings it already documents.

---

## 1. Guiding decisions

| Decision | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript, ESM | One ecosystem; runs on a dev host or in the container |
| HTTP framework | `fastify` (MIT), `@fastify/websocket`, `@fastify/static`, `@fastify/swagger` | Fast, schema-validated, generates OpenAPI |
| API style | JSON over HTTP, plus SSE for events and WebSocket for VNC | Easy to use from curl, browsers and agents. No gRPC. |
| X11 access | `x11` npm (node-x11, MIT), a **pure-JS X protocol client** | No xdotool, xwd or x11vnc. Input goes through the XTEST extension, capture through `GetImage`, change tracking through DAMAGE, windows through EWMH. |
| VNC server | **In-process RFB 3.8 server written in TypeScript**, fed by node-x11, compressed with Node's built-in `zlib` | Removes the need for x11vnc (GPL) and websockify (LGPL). noVNC connects straight to our WebSocket. |
| VNC client | `@novnc/novnc` npm (MPL-2.0), served **unmodified** as static files | MPL is file-level copyleft; using it unmodified places no obligations on our code. Ship its LICENSE. |
| Image encoding | `sharp` (Apache-2.0, prebuilt libvips installed by npm) for PNG/JPEG/WebP and resizing; `pngjs` (MIT) as a dependency-free fallback | `npm install` covers it |
| Accessibility | `dbus-next` (MIT, pure JS) talking to AT-SPI2 over D-Bus | No native bindings |
| Processes and PTY | `child_process`; `node-pty` (MIT, prebuilt) for PTYs | |
| Agent interface | `@modelcontextprotocol/sdk` (MIT), Streamable HTTP transport | |
| Validation and types | `zod` (MIT) plus JSON schemas | |
| Logging | `pino` (MIT) | |

**External binaries we can't avoid** come from the image's apt packages, not npm.
Outside Docker you provide them yourself or point the app at an existing display:

- `Xvfb`, the X server
- a window manager (`openbox`, or `xfwm4` with a light XFCE)
- `dbus` and `at-spi2-core`, only for accessibility features
- fonts

The app **never shells out** to them for normal operation. The one exception is an
optional `--spawn-xvfb` mode for development.

---

## 2. Repository layout

```
ozwell-computer/
├─ package.json            # "bin": { "ozwell-computer": "dist/cli.js" }
├─ tsconfig.json
├─ src/
│  ├─ cli.ts               # arg/env parsing, starts server
│  ├─ config.ts            # env schema (zod), defaults
│  ├─ server.ts            # fastify bootstrap, route registration
│  ├─ auth/
│  │  ├─ token.ts          # load/generate PSK, constant-time compare
│  │  └─ plugin.ts         # fastify onRequest hook (query/header/cookie)
│  ├─ x11/
│  │  ├─ connection.ts     # single shared node-x11 client, reconnect, ext. loading
│  │  ├─ capture.ts        # GetImage → BGRA buffer; DAMAGE tracking
│  │  ├─ input.ts          # XTEST fake input; typing
│  │  ├─ keymap.ts         # KeyboardEvent.code / names → keysym → keycode
│  │  ├─ windows.ts        # EWMH: list, activate, move/resize, close, watch
│  │  ├─ clipboard.ts      # CLIPBOARD selection owner/requestor (text, png)
│  │  └─ displays.ts       # RandR / root geometry
│  ├─ vnc/
│  │  ├─ rfb-server.ts     # RFB 3.8 state machine per client
│  │  ├─ encodings.ts      # Raw, ZRLE, (later) Tight/JPEG
│  │  └─ ws-bridge.ts      # WebSocket ↔ RFB session (binary frames)
│  ├─ a11y/atspi.ts        # dbus-next AT-SPI tree, find, act
│  ├─ process/             # exec, pty sessions
│  ├─ fs/                  # file ops, signed URLs
│  ├─ presence/            # participants, cursors, SSE broadcaster
│  ├─ coords.ts            # coordinate spaces, screenshot registry
│  ├─ errors.ts            # error reasons → HTTP status
│  ├─ routes/              # one file per API area (see §5)
│  ├─ mcp/server.ts        # MCP tools wrapping the same services
│  └─ web/                 # landing page, noVNC viewer wrapper
├─ test/                   # vitest unit + integration (Xvfb in CI)
├─ docker/
│  ├─ Dockerfile
│  ├─ systemd/             # *.service units
│  └─ openbox/             # minimal WM config / autostart
```

---

## 3. Configuration (environment variables and matching CLI flags)

| Variable | Default | Meaning |
|---|---|---|
| `OZWELL_COMPUTER_PORT` | `8080` | Listening port |
| `OZWELL_COMPUTER_HOST` | `0.0.0.0` in the container, `127.0.0.1` on a host | Bind address |
| `OZWELL_COMPUTER_TOKEN` | *(unset)* | The PSK. If unset and auth is enabled, the server generates 32 random bytes (base64url), writes them to `OZWELL_COMPUTER_TOKEN_FILE`, and logs a one-time access URL. |
| `OZWELL_COMPUTER_TOKEN_FILE` | `/run/ozwell-computer/token` (container) or `~/.config/ozwell-computer/token` | Where a generated token is stored and read back, so it survives restarts |
| `OZWELL_COMPUTER_AUTH_DISABLED` | `false` | When `true`, nothing requires auth. A loud warning is logged at startup, and binding to a non-loopback address without auth logs a second warning. |
| `DISPLAY` | `:0` in the container | X display to attach to |
| `OZWELL_COMPUTER_SPAWN_XVFB` | `false` | Development only: start `Xvfb $DISPLAY` if nothing is listening |
| `OZWELL_COMPUTER_SCREEN` | `1920x1080x24` | Geometry used with spawn-xvfb, and what the container's Xvfb unit uses |
| `OZWELL_COMPUTER_VIEW_ONLY` | `false` | The VNC/web viewer ignores input |
| `OZWELL_COMPUTER_A11Y` | `auto` | Enable AT-SPI when the D-Bus a11y bus is reachable |
| `OZWELL_COMPUTER_EXEC` | `true` | Enable the process and filesystem APIs (can be turned off for safety) |
| `OZWELL_COMPUTER_VNC_BACKEND` | `builtin` | `builtin`, or `external:<port>` to proxy to an external VNC server |
| `OZWELL_COMPUTER_LOG_LEVEL` | `info` | |

---

## 4. Authentication

**Accepted credentials**, checked in this order. Any one match is enough:

1. Query parameter `?token=<psk>` (so a URL works in a browser)
2. `Authorization: Bearer <psk>`
3. `X-Auth-Token: <psk>` (for gateways that strip `Authorization`)
4. Cookie `ozwell_computer_token` (set automatically, see the browser flow below)

**Rules:**

- Compare with `crypto.timingSafeEqual` on SHA-256 digests, so differing token
  lengths don't leak timing information.
- Exempt only `GET /health` and the static noVNC assets under `/novnc/*`. Static
  assets carry no secrets, and exempting them lets the viewer page load its JS.
- WebSocket upgrades (`/websockify`, `/api/v1/pty`) are checked in the same hook,
  with the same rules. A browser can't set headers on a WebSocket, so it relies on
  the query parameter or the cookie.
- Failures return `401` with `WWW-Authenticate: Bearer` and a JSON error body. The
  token is never logged; redact `token` from logged URLs.
- When `OZWELL_COMPUTER_AUTH_DISABLED=true`, the hook does nothing and
  `GET /api/v1/capabilities` reports `"auth": "disabled"`.

**Browser flow:**

1. A user opens `http://host:8080/?token=XYZ`.
2. The server validates the token, sets the cookie
   `ozwell_computer_token=XYZ; HttpOnly; SameSite=Strict; Path=/` (adding `Secure`
   when served behind TLS, detected from `X-Forwarded-Proto`), and responds
   `302 /` so the token disappears from the address bar and history.
3. `/` serves the viewer page. Its noVNC WebSocket goes to `/websockify`, which
   authenticates with the cookie.
4. Opening `/` with no credential shows a small page asking for a token, which
   submits it as `?token=`.

**Automation:** send `Authorization: Bearer XYZ` on each request.

**Limitation:** there is a single PSK and a single role. A human and an agent with
the token have the same rights. Identity is self-declared, through `X-Principal`
(`{"id","name","kind":"human|agent"}`) or the MCP session, and is used for presence
only.

---

## 5. HTTP surface

Every API route is under `/api/v1`, JSON in and out. An OpenAPI document is served at
`/api/v1/openapi.json`, and a Swagger UI at `/api/docs`, which requires auth.

### 5.1 System

| Method and path | Purpose |
|---|---|
| `GET /health` | `204` when the X connection is up (no auth) |
| `GET /api/v1/capabilities` | Version, display geometry, X extensions found (XTEST, DAMAGE, RandR, XFIXES), whether a11y, clipboard, exec and VNC are available, auth mode. Every unsupported feature includes a `limitation` string. |
| `GET /api/v1/displays` | Root and RandR outputs: `{id, bounds, scale: 1}` |

### 5.2 Screen

| Method and path | Purpose |
|---|---|
| `GET /api/v1/screenshot?format=png\|jpeg\|webp&quality=&max_dimension=&region=x,y,w,h&window=<id>&cursor=1` | Returns the image bytes with the correct `Content-Type`, plus headers `X-Screenshot-Id`, `X-Image-Size`, `X-Native-Size`, `X-Scale`. Add `Accept: application/json` to get `{screenshot_id, image_base64, ...}` instead, which suits MCP and LLM tools. |
| `GET /api/v1/cursor` | Pointer position and the window under it |

**Screenshot registry:** an LRU of 64 entries, keyed by `screenshot_id` (a ULID).
Each entry stores `{origin, scale, root geometry, geometry_epoch, window bounds}` and
expires after 120 s.

### 5.3 Input

`POST /api/v1/input/pointer`

```json
{ "action": "click|move|down|up|drag|scroll",
  "x": 100, "y": 200, "space": "screen|window|screenshot|normalized",
  "screenshot_id": "…", "window": "0x1a00003",
  "button": "left|right|middle|back|forward", "count": 1,
  "modifiers": ["ctrl"], "to": {"x": 0, "y": 0}, "path": [],
  "dx": 0, "dy": -3, "unit": "line|pixel", "duration_ms": 0 }
```

`POST /api/v1/input/keyboard`

```json
{ "action": "type|press|hotkey|down|up",
  "text": "hello", "mode": "keystrokes|paste",
  "key": "KeyA|Enter|F5|ArrowLeft|…", "keys": ["Control", "Shift", "t"],
  "modifiers": ["ctrl"], "repeat": 1, "delay_ms": 0 }
```

**Response for both:**

```json
{ "delivery": "foreground", "pointer_moved": true, "focus_changed": false, "cursor": {"x": 0, "y": 0} }
```

**Coordinate resolution** (`coords.ts`):

- `normalized`: multiply by the target window's or display's bounds.
- `window`: add the window's origin, read from `TranslateCoordinates`.
- `screenshot`: look up the registry entry. If the root geometry or the window's
  bounds have changed since capture, return `409 {reason: "stale_geometry"}`.

**Delivery:** XTEST injects into the global input stream, so delivery on X11 is
always `foreground`. A request for `delivery: "background"` returns
`422 would_require_activation`. Clicks done through accessibility actions count as
background-safe.

**Keyboard mapping** (`keymap.ts`):

- Translate W3C `KeyboardEvent.code` and friendly names to keysyms, then to keycodes
  with `GetKeyboardMapping`.
- For a character that has no keycode, temporarily remap a spare keycode with
  `ChangeKeyboardMapping`, press it, then restore it. This is the same trick
  xdotool uses, done in pure JS.
- `mode: "paste"` puts the text on the clipboard, sends Ctrl+V, and restores the
  previous clipboard.

### 5.4 Clipboard

- `GET /api/v1/clipboard` returns `{text?, image_png_base64?, generation}`.
- `PUT /api/v1/clipboard` accepts the same shape.

Implementation: own the `CLIPBOARD` and `PRIMARY` selections through node-x11, and
answer `SelectionRequest` for `UTF8_STRING`, `TEXT` and `image/png`. Reading uses
`ConvertSelection` into a property on a hidden window. `generation` increments
whenever XFIXES reports a selection-owner change.

### 5.5 Windows and apps

| Method and path | Purpose |
|---|---|
| `GET /api/v1/windows` | Reads `_NET_CLIENT_LIST_STACKING`. Returns `{id, epoch, title, app (WM_CLASS), pid, bounds, focused, minimized}` |
| `GET /api/v1/windows/:id` | One window |
| `POST /api/v1/windows/:id/{activate,minimize,maximize,restore,close}` | Sends EWMH client messages: `_NET_ACTIVE_WINDOW`, `_NET_WM_STATE`, `_NET_CLOSE_WINDOW` |
| `PUT /api/v1/windows/:id/bounds` | `_NET_MOVERESIZE_WINDOW` |
| `POST /api/v1/apps/launch` | `{command, args, env}`. Spawns the process detached with `DISPLAY` set |
| `POST /api/v1/open` | `{target}`. Opens a URL or file with `xdg-open` (the only intentional shell-out, and optional) |

**Window epochs:** the window id is the X window id in hex. `epoch` is a counter kept
per id, incremented on `DestroyNotify` followed by the id being reused. A stale epoch
returns `409 stale_handle`.

### 5.6 Accessibility (optional; requires the AT-SPI bus)

| Method and path | Purpose |
|---|---|
| `GET /api/v1/a11y/tree?window=&max_depth=&max_nodes=5000&hidden=0` | Flat pre-order list `{element_id, parent_id, depth, role, native_role, name, value, description, bounds, states[], actions[]}` plus `snapshot_id` and `truncated` |
| `POST /api/v1/a11y/find` | `{role, name, name_contains, value_contains, states[], max_results}` |
| `POST /api/v1/a11y/act` | `{snapshot_id, element_id, action: press\|focus\|set_value\|…, value}` |

**Snapshots:** the server keeps the last 8 snapshots, mapping element ids to AT-SPI
object paths. Acting on an expired snapshot returns `409 stale_snapshot`.

**Role mapping:** AT-SPI role names map to one fixed vocabulary
(`push button` → `button`, `entry` → `text_field`, and so on).

### 5.7 Processes and files (gated by `OZWELL_COMPUTER_EXEC`)

- `POST /api/v1/exec`: `{cmd, args, cwd, env, timeout_ms}`. Returns
  `{exit_code, stdout, stderr}` when it finishes, or streams NDJSON when `?stream=1`.
- `WS /api/v1/pty`: a `node-pty` terminal. Text frames carry I/O;
  `{"resize": [cols, rows]}` resizes.
- Files:
  - `GET /api/v1/fs?path=` returns stat or a directory listing.
  - `GET /api/v1/fs/content?path=` downloads, supporting HTTP `Range`.
  - `PUT /api/v1/fs/content?path=&sha256=` uploads; if the declared hash doesn't
    match, it returns `422 checksum_mismatch`.
  - `DELETE` and `POST /move` are also provided.
- `POST /api/v1/fs/sign`: `{path, method, ttl_s}`. Returns a URL of the form
  `/files/<path>?exp=&sig=` (HMAC-SHA256 with a key derived from the PSK). Changing
  the token invalidates every signed URL.

### 5.8 Presence and events

- `GET /api/v1/events` (SSE) carries these events:
  - `presence.joined`, `presence.left`, `presence.cursor`
  - `window.created`, `window.destroyed`, `window.focus`, `window.bounds`
  - `clipboard.changed`
  - a `keepalive` every 15 s
- `POST /api/v1/presence/join` sends `{name, kind, color}` and returns
  `{participant_id, roster}`. `POST /api/v1/presence/cursor` sends
  `{participant_id, x, y (normalized), visible}`. `POST /api/v1/presence/leave` ends
  participation.
- Pointer and keyboard API calls that include `X-Principal` with `kind: "agent"`
  publish that agent's cursor automatically. Agent cursors expire after 15 s idle;
  human cursors are hidden after 60 s.
- The `/` viewer draws the other participants' cursors as an HTML overlay on the
  noVNC canvas, using normalized coordinates.

### 5.9 Human viewer and VNC

| Path | Purpose |
|---|---|
| `GET /` | The viewer page. An iframe-free wrapper around noVNC's `RFB` class (imported as an ES module from `/novnc/core/rfb.js`), plus a toolbar: clipboard sync, keys browsers won't capture (Ctrl+Alt+Del, Super, Alt+Tab), view-only toggle, scaling, fullscreen, presence cursors. |
| `GET /novnc/*` | Static files from `node_modules/@novnc/novnc` |
| `WS /websockify` | Binary RFB stream from our in-process server, so stock noVNC and other clients work |

### 5.10 Agent interface

`POST|GET|DELETE /mcp` uses MCP Streamable HTTP and the same auth. Tools:

- `screenshot`: image content plus `screenshot_id`
- `click`, `double_click`, `move`, `drag`, `scroll`
- `type_text`, `press_key`, `hotkey`
- `list_windows`, `activate_window`, `launch_app`
- `get_ui_tree`, `find_element`, `ui_action`
- `get_clipboard`, `set_clipboard`
- `run_command`, `read_file`, `write_file` (only when exec is enabled)

Tool errors carry the same `reason` codes as the HTTP API, so the model can recover
(take a new screenshot after `stale_geometry`, and so on). Each MCP session becomes a
presence participant of kind `agent`. `DELETE` removes it.

### 5.11 Errors

All errors use one shape:
`{"error": {"reason": "...", "message": "...", "feature"?: "...", "retry_after_ms"?: n}}`.

| Reason | HTTP status |
|---|---|
| `unauthenticated` | 401 |
| `feature_unsupported` | 501 |
| `permission_denied` | 403 |
| `stale_geometry`, `stale_handle`, `stale_snapshot` | 409 |
| `would_require_activation` | 422 |
| `target_unavailable`, `path_not_found` | 404 |
| `checksum_mismatch` | 422 |
| `limit_exceeded` | 413 |
| `rate_limited` | 429 |
| `internal` | 500 |

---

## 6. The in-process RFB server (the main technical risk)

**Protocol:** RFB 3.8.

- Security type 1 (None), because authentication already happened at the
  HTTP/WebSocket layer.
- `ServerInit` sends the root geometry and a 32-bit true-colour pixel format.
- Supports `SetPixelFormat` (convert as needed, though noVNC always asks for 32-bit),
  `SetEncodings`, `FramebufferUpdateRequest`, `KeyEvent`, `PointerEvent` and
  `ClientCutText`.

**Encodings:**

- Phase 2: Raw, plus **ZRLE** using one persistent `zlib.deflate` stream per client
  (Node's built-in zlib).
- Phase 6: **Tight with JPEG** (using `sharp`) for better bandwidth on photo-like
  content.
- Pseudo-encodings: DesktopSize (resize) and Cursor (cursor image from XFIXES
  `GetCursorImage`).
- Optional: `ExtendedDesktopSize`, so a client can resize the desktop through RandR.

**Damage tracking:**

- Create a DAMAGE object on the root window, and collect and merge dirty rectangles
  per client.
- If DAMAGE isn't available, fall back to polling: grab the frame every 100 ms,
  compare 64×64 tiles by hash, and send the tiles that changed.

**Capture:** `GetImage(ZPixmap)` per dirty rectangle, sending large regions in strips
to stay under the X request size limit. Phase 6 adds MIT-SHM if node-x11 supports it
well; otherwise stay with GetImage, which is fine at 1080p and around 15 to 30 fps
for typical desktop changes.

**Flow control:** only answer the client's outstanding `FramebufferUpdateRequest`
(noVNC's normal pacing). Merge damage between requests and never queue more than one
update per client.

**Input:** `KeyEvent` arrives as a keysym and goes through XTEST using `keymap.ts`.
`PointerEvent` button masks become XTEST button presses (buttons 4 and 5 are the
scroll wheel). `ClientCutText` sets the clipboard. Input from a VNC client also
updates the presence cursor of the human participant bound to that socket.

**Fallback if the native-JS server isn't ready:** systemd starts `x11vnc` (apt, GPL,
a separate process) on `localhost:5900`, and `ws-bridge.ts` simply proxies the
WebSocket to that TCP socket in JS, with no websockify. Controlled by
`OZWELL_COMPUTER_VNC_BACKEND=builtin|external:5900`.

---

## 7. Docker image

### 7.1 Dockerfile (outline)

```dockerfile
FROM node:22-bookworm-slim AS build      # build stage only; copies the node binary later
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/mieweb/opensource-server/base:latest
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox dbus-x11 at-spi2-core xdg-utils \
      fonts-dejavu-core fonts-noto-core ca-certificates \
      # sample apps for agents to drive (optional):
      xterm firefox-esr \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /src/dist /opt/ozwell-computer/dist
COPY --from=build /src/node_modules /opt/ozwell-computer/node_modules
COPY --from=build /src/package.json /opt/ozwell-computer/
COPY docker/systemd/*.service /etc/systemd/system/
COPY docker/openbox/ /etc/xdg/openbox/
RUN useradd -m -s /bin/bash desktop \
 && systemctl enable xvfb.service desktop-session.service ozwell-computer.service
ENV DISPLAY=:0
EXPOSE 8080
STOPSIGNAL SIGRTMIN+3
```

- **Node binary:** the build copies Node 22 from the official image. If the
  hardening policy only allows apt-installed packages, use Debian 13's `nodejs`
  package (20.x) instead; every dependency here supports Node 20.
- **Native modules:** `sharp` and `node-pty` ship prebuilt binaries for linux-x64 and
  arm64 with glibc. Build both architectures with buildx so the prebuilt binary
  matches.

### 7.2 systemd units

| Unit | Runs | Notes |
|---|---|---|
| `xvfb.service` | `Xvfb :0 -screen 0 ${SCREEN} -nolisten tcp +extension RANDR +extension DAMAGE` as user `desktop` | `Restart=always` |
| `desktop-session.service` | `dbus-run-session -- openbox-session` as `desktop`, with `DISPLAY=:0` and `GTK_MODULES=gail:atk-bridge`, `NO_AT_BRIDGE=0` | Brings up the a11y bus and an autostart file for any launcher or apps. `After=xvfb.service`. |
| `ozwell-computer-env.service` | Oneshot: copies `OZWELL_COMPUTER_*` entries from `/proc/1/environ` into `/run/ozwell-computer.env` | systemd doesn't automatically give `docker run -e` values to its services |
| `ozwell-computer.service` | `/usr/local/bin/node /opt/ozwell-computer/dist/cli.js` as `desktop` | `EnvironmentFile=-/run/ozwell-computer.env`. `After=desktop-session.service ozwell-computer-env.service`. `Restart=always`. |

**Run:**

```bash
docker run -d -p 8080:8080 \
  --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cgroupns=host \
  -e OZWELL_COMPUTER_TOKEN=$(openssl rand -hex 24) \
  ghcr.io/mieweb/ozwell-computer:latest
```

Then open `http://localhost:8080/?token=…`.

If the token isn't set, read the generated one with
`docker exec <c> cat /run/ozwell-computer/token` or `journalctl -u ozwell-computer`.

### 7.3 Outside Docker

- `npx ozwell-computer` attaches to `$DISPLAY`, binds to `127.0.0.1`, and generates a
  token in `~/.config/ozwell-computer/token`.
- `npx ozwell-computer --spawn-xvfb --display :99` starts a headless desktop for
  development and CI. It requires Xvfb on the host.

---

## 8. Phases and milestones

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Skeleton** (about 3 days) | Repo, TypeScript build, fastify, config, auth plugin (query, headers, cookie, disable flag), `/health`, `/capabilities`, OpenAPI, pino, vitest, CI that starts Xvfb | Auth matrix tests pass: no token → 401; `?token` → 302 plus cookie; Bearer, X-Auth-Token and cookie all → 200; auth disabled → 200 |
| **1. X11 core** (about 1 week) | node-x11 connection with extension discovery, screenshots (sharp), pointer and keyboard through XTEST, keymap with spare-keycode remapping, coordinate spaces, screenshot registry, displays and cursor | Integration test: launch `xterm`, type `echo hi`, press Enter, take a screenshot, and pixel-diff it against a golden image. A screenshot-space click on a scaled screenshot lands within ±1 px. A stale-geometry case returns 409. |
| **2. Human viewer** (about 1.5 weeks) | RFB server with Raw and ZRLE, DesktopSize, Cursor pseudo-encoding, damage tracking, WebSocket bridge, noVNC static assets, `/` page, token-entry page | Stock noVNC connects through `/?token=` and works interactively at 1080p, using under 30% of one core at idle-to-light activity. The `external:5900` fallback also works. |
| **3. Windows, clipboard, events** (about 1 week) | EWMH APIs and window epochs, launch and open, clipboard owner and requestor including PNG, SSE event bus, presence and the cursor overlay on `/` | Two browser tabs plus one API "agent" show each other's cursors. Clipboard copied in an X app appears via the API and in noVNC, and the reverse. |
| **4. Agent interface** (about 1 week) | MCP server and tools, `X-Principal`, JSON screenshot mode, error-reason mapping in tool results | An end-to-end check with an MCP client (Claude Code, Cursor or the MCP inspector): "open xterm and run `uname -a`" succeeds and the agent's cursor is visible in `/`. |
| **5. Accessibility, exec, files** (about 1.5 weeks) | AT-SPI tree, find and act with snapshots, exec and PTY, filesystem and signed URLs, the `OZWELL_COMPUTER_EXEC` gate | A GTK app's buttons can be found and pressed through the API. Upload, download, range and checksum tests pass. |
| **6. Performance and hardening** (about 1 week) | Tight/JPEG encoding, MIT-SHM if feasible, rate limits, request size limits, fuzzing of RFB input parsing, multi-arch image, image scan, documentation | Under 150 ms end-to-end latency from input to visible change over LAN. Trivy or Grype is clean against the company baseline. |

**Total:** roughly 7 to 8 weeks for one engineer. Phases 3 to 5 can be split across
two engineers.

---

## 9. Testing strategy

- **Unit tests:** keymap tables, coordinate transforms, auth comparison and
  extraction, RFB message encoding and decoding (golden byte fixtures), ZRLE tile
  encoder against reference output, HMAC URL signing.
- **Integration tests (CI with Xvfb):** spawn `Xvfb :99` plus openbox, drive real X
  apps (`xterm`, `xeyes`, a GTK test app for AT-SPI), and assert with screenshots and
  the accessibility tree.
- **VNC conformance:** run noVNC headless in Playwright (Apache-2.0, a dev dependency
  only) against the server. Connect, check that the canvas updates, send keys, and
  verify the X side.
- **Container smoke test:** `docker run`, wait for `/health`, run the auth matrix,
  take a screenshot, and open `/` in Playwright.
- **Security:** fuzz RFB client messages and the JSON schemas with `fast-check`. Test
  path traversal on `/fs` and signed URLs. Confirm the token never appears in logs.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| node-x11 lacks some extensions or is slow (DAMAGE, XFIXES, XTEST and RandR are supported; SHM is uncertain) | Keep the X calls behind `x11/` interfaces. Poll with tile hashing when DAMAGE is missing. Use the `external:5900` VNC backend as a safety valve. |
| Throughput of a JS RFB encoder | ZRLE through native zlib, encoding only damaged areas, and later Tight/JPEG through sharp. Move encoding to a `worker_threads` pool if profiling shows the main thread is saturated. |
| Unicode and IME typing on X11 | Spare-keycode remapping, with paste mode as the robust alternative |
| AT-SPI coverage varies between toolkits | Report it under `capabilities.a11y` with a `limitation`. Agents fall back to screenshots and coordinates. |
| Keeping systemd-in-docker portable | Document the required run flags. The app also runs without systemd (`node dist/cli.js --spawn-xvfb`) for Kubernetes or simple containers. |
| A single PSK gives full control | Default on, never logged, rotation by restart, read-only and view-only switches, `OZWELL_COMPUTER_EXEC=false` for less trusted setups. Recommend putting TLS in front (a reverse proxy). |
| MPL-2.0 obligations from noVNC | Serve it unmodified from npm and include its LICENSE. Any changes to noVNC files must be published. |

---

## 11. Licence inventory (runtime)

- **MIT:** fastify and its plugins, ws, x11, dbus-next, node-pty, pngjs, zod, pino,
  @modelcontextprotocol/sdk, our own code
- **Apache-2.0:** sharp (and libvips, which is LGPL-3.0 but dynamically linked and
  prebuilt)
- **MPL-2.0:** @novnc/novnc, served unmodified
- **System packages (apt, separate processes):** Xorg/Xvfb (MIT/X11), openbox
  (GPL-2.0), dbus (AFL/GPL), at-spi2-core (LGPL-2.1)

No CUA code is used. The API is modelled on CUA's ideas (screenshot-relative
coordinates, delivery reports, snapshot-scoped accessibility, presence), but it is
not wire-compatible.
