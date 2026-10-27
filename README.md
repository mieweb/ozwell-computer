# ozwell-desktop

One HTTP port that serves an X11 desktop to people and to agents:

- `/`: a noVNC viewer for humans, with presence cursors, local clipboard sharing and special keys
- `/api/v1/*`: JSON API for screenshots, input, windows, clipboard, accessibility, processes and files ([OpenAPI](docs/openapi.json), Swagger UI at `/api/docs`)
- `/mcp`: an MCP server (Streamable HTTP) with the same capabilities as tools

The VNC server is written in TypeScript and runs in-process; it talks to X through
[node-x11](https://github.com/sidorares/node-x11). It needs no x11vnc, websockify or
xdotool. The design takes ideas from [CUA](https://github.com/trycua/cua) but is not
wire-compatible with it.

## Run the container

```bash
docker run -d -p 8080:8080 \
  --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cgroupns=host \
  -e OZWELL_DESKTOP_TOKEN=$(openssl rand -hex 24) \
  ghcr.io/mieweb/ozwell-desktop:latest
```

Open `http://localhost:8080/?token=<token>`. The server sets an HttpOnly cookie and
redirects, which removes the token from the address bar.

If you don't set a token, the server generates one. Read it with
`docker exec <c> cat /run/ozwell-desktop/token`.

The image is based on `ghcr.io/mieweb/opensource-server/nodejs`, with systemd as PID 1.
It runs these units:

| Unit | Purpose |
|---|---|
| `environment.service` | (from the base image) copies `docker run -e` values into `/etc/environment` |
| `desktop-dbus.service` | session D-Bus at the fixed address `unix:path=/run/desktop-bus/bus` |
| `xvfb.service` | `Xvfb :0` at `$OZWELL_DESKTOP_SCREEN` |
| `desktop-session.service` | xfwm4 plus `xfce4-panel` (a top bar with an Applications menu and clock, and a bottom dock with launchers and running apps). It also starts the AT-SPI bus and a terminal (xfce4-terminal); Thunar is the file manager. Config is in `docker/xfce/`. |
| `ozwell-desktop.service` | this server, running as user `desktop` |

Apps launched through the API share the session bus and have the GTK/Qt
accessibility bridges enabled, so their UI shows up in `/api/v1/a11y/*`.

## Run without Docker

```bash
npx @mieweb/ozwell-desktop                          # attach to $DISPLAY, bind 127.0.0.1:8080
npx @mieweb/ozwell-desktop --spawn-xvfb --display :99 # headless desktop for development (needs Xvfb)
```

When no token is configured, one is generated and stored in
`~/.config/ozwell-desktop/token`, and a one-time access URL is printed to stderr.

## Configuration

| Variable / flag | Default | |
|---|---|---|
| `OZWELL_DESKTOP_PORT` / `--port` | `8080` | |
| `OZWELL_DESKTOP_HOST` / `--host` | `0.0.0.0` in a container, otherwise `127.0.0.1` | |
| `OZWELL_DESKTOP_TOKEN` / `--token` | generated | Pre-shared key |
| `OZWELL_DESKTOP_TOKEN_FILE` | `/run/ozwell-desktop/token` or `~/.config/ozwell-desktop/token` | |
| `OZWELL_DESKTOP_AUTH_DISABLED` / `--no-auth` | `false` | Logs loud warnings |
| `DISPLAY` / `--display` | `:0` | |
| `OZWELL_DESKTOP_SPAWN_XVFB` / `--spawn-xvfb` | `false` | Development only |
| `OZWELL_DESKTOP_SCREEN` / `--screen` | `1920x1080x24` | |
| `OZWELL_DESKTOP_VIEW_ONLY` / `--view-only` | `false` | VNC viewers can't send input |
| `OZWELL_DESKTOP_A11Y` / `--a11y` | `auto` | `auto`, `on` or `off` |
| `OZWELL_DESKTOP_EXEC` / `--no-exec` | `true` | Controls the process, PTY, file and app-launch APIs |
| `OZWELL_DESKTOP_VNC_BACKEND` / `--vnc-backend` | `builtin` | `external:[host:]port` proxies to another VNC server, such as x11vnc |
| `OZWELL_DESKTOP_FS_ROOT` / `--fs-root` | `/` | Root directory for the file API |
| `OZWELL_DESKTOP_LOG_LEVEL` / `--log-level` | `info` | |

## Authentication

The server accepts any one of these credentials, checked in this order:
`?token=`, `Authorization: Bearer`, `X-Auth-Token`, or the `ozwell_desktop_token`
cookie. WebSocket upgrades (`/websockify`, `/api/v1/pty`) follow the same rules.

Only these paths are exempt: `GET /health`, the static assets under `/novnc/*` and
`/static/*`, and HMAC-signed `/files/*` URLs. Tokens and signatures are redacted from
logs.

There is one key and one role, so anyone holding the token has full control. Put TLS
in front of the server, and use `OZWELL_DESKTOP_EXEC=false` or `--view-only` when less
access is appropriate.

## API quick tour

```bash
T="Authorization: Bearer $TOKEN"; B=http://localhost:8080/api/v1
curl -H "$T" "$B/screenshot?max_dimension=1280" -D - -o s.png     # note X-Screenshot-Id
curl -H "$T" -H 'content-type: application/json' \
  -d '{"action":"click","x":640,"y":360,"screenshot_id":"<id>"}' $B/input/pointer
curl -H "$T" -H 'content-type: application/json' \
  -d '{"action":"type","text":"hello"}' $B/input/keyboard
curl -H "$T" $B/windows
curl -H "$T" -H 'content-type: application/json' -d '{"role":"button","name":"OK"}' $B/a11y/find
curl -N -H "$T" $B/events                                           # SSE: windows, clipboard, presence
```

- **Coordinates:** `space` is one of `screen`, `window`, `screenshot` or `normalized`.
  Screenshot coordinates are scaled back to screen pixels. If the screen or window
  geometry has changed since the capture, the request fails with `409 stale_geometry`.
- **Errors:** every error has the shape
  `{"error":{"reason","message",...}}`. The reasons are listed in `src/errors.ts`, and
  MCP tool errors use the same codes.
- **Delivery:** XTEST input always goes to the foreground, so a request with
  `delivery: "background"` returns `422 would_require_activation`. Accessibility
  actions (`/a11y/act`) don't move the pointer.
- **Agent presence:** send `X-Principal: {"id","name","kind":"agent"}` on input calls
  and the agent's cursor appears in the viewer.

## MCP

Point any MCP client at `http://host:8080/mcp` with header
`Authorization: Bearer <token>`. Each session appears as an agent participant in the
viewer.

The tools are: `screenshot`, `click`, `double_click`, `move`, `drag`, `scroll`,
`type_text`, `press_key`, `hotkey`, `list_windows`, `activate_window`, `launch_app`,
`get_ui_tree`, `find_element`, `ui_action`, `get_clipboard` and `set_clipboard`. When
exec is enabled, `run_command`, `read_file` and `write_file` are also available.

## Development

```bash
nvm use            # Node 26 (.nvmrc); the image runs the base image's Node 24
npm ci
npm test           # unit tests: auth, keymap, coords, ZRLE round-trips, fs signing, exec
npm run build
docker build -f docker/Dockerfile -t ozwell-desktop:dev .
docker run -d --name ozd -p 18080:8080 --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cgroupns=host -e OZWELL_DESKTOP_TOKEN=testtoken ozwell-desktop:dev
OZ_URL=http://localhost:18080 OZ_TOKEN=testtoken npm run test:integration   # API, VNC, MCP, a11y, Chrome viewer
npm run openapi    # regenerate docs/openapi.json
```

## Known limitations

- **GTK4 bounds:** GTK4 reports AT-SPI extents relative to the window, so `bounds`
  from `/a11y/*` may not be screen coordinates. Actions are unaffected.
- **Clipboard sharing:** in the viewer, Ctrl/Cmd+C and Ctrl/Cmd+V use your local
  clipboard with full Unicode. This needs HTTPS or localhost; on plain HTTP the toolbar
  shows a manual Clipboard panel instead. Paste uses the browser's native paste event,
  so no permission prompt appears. Copies made without a shortcut (menus,
  select-to-copy) reach your clipboard on your next click in the viewer.
- **CPU:** the VNC encoder runs on the main thread. A constantly scrolling terminal
  uses about 25 to 35% of one core. Tight/JPEG encoding, MIT-SHM capture and a worker
  pool are planned (Phase 6).

## Licences

Our code is MIT. noVNC (MPL-2.0) is served unmodified from `node_modules/@novnc/novnc`,
which includes its `LICENSE.txt`. See PLAN.md §11 for the full runtime inventory.
