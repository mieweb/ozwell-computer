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

If you don't set a token, the server generates one, stores it in
`/var/lib/ozwell-desktop/token` (mount a volume there to keep it), and prints a link
with the token embedded at startup. Run with `-t` to see it in `docker logs`; that's
how `docker compose up` shows it. A token you configure yourself is never printed.

The image is based on `ghcr.io/mieweb/opensource-server/nodejs`, with systemd as PID 1,
and installs the `ozwell-desktop` Debian package (below) plus a few sample apps. The
package provides these units, all running as the `desktop` user:

| Unit | Purpose |
|---|---|
| `ozwell-desktop-dbus.service` | session D-Bus at the fixed address `unix:path=/run/desktop-bus/bus` |
| `ozwell-desktop-xvfb.service` | `Xvfb :0` at `$OZWELL_DESKTOP_SCREEN` |
| `ozwell-desktop-session.service` | xfwm4 plus `xfce4-panel` (a top bar with an Applications menu and clock, and a bottom dock with launchers and running apps). It also starts the AT-SPI bus and a terminal (xfce4-terminal); Thunar is the file manager. |
| `ozwell-desktop.service` | this server |

Apps launched through the API share the session bus and have the GTK/Qt
accessibility bridges enabled, so their UI shows up in `/api/v1/a11y/*`.

Container-only adjustments live in `docker/` and are applied by the `Dockerfile`, not
the package: `docker run -e` values reach the services through the base image's
`environment.service`, and systemd's own output is kept off the console so
`docker logs` shows only the server.

## Debian package

`ozwell-desktop_<version>_<arch>.deb` installs the app under `/opt/ozwell-desktop`,
the systemd units, `/usr/bin/ozwell-desktop`, and the desktop configuration
(`/etc/xdg/...`). Settings go in `/etc/default/ozwell-desktop`.
- It needs Node.js 24 or newer from NodeSource, which provides the `nodejs` package.
- Installing it creates the `desktop` user, then enables and starts the services.
- Upgrading restarts only the server, so applications open on the desktop survive.
- Removing it stops and disables the services; purging also deletes
  `/var/lib/ozwell-desktop`.

```bash
make deps               # npm ci
make build              # npm run build
make install DESTDIR=/tmp/stage PREFIX=/opt/ozwell-desktop   # stage the files
make deb                # stage into .pkg/buildroot (or DESTDIR=...) and run fpm
docker buildx build --target deb --output type=local,dest=out .   # .deb without local fpm
```

Package metadata and dependencies are in `.fpm`. The maintainer scripts and units
are in `contrib/`.
- **Versions come from git tags** (`./package-version deb`): `v1.2.3` gives `1.2.3`,
  3 commits later `1.2.3+3.g<hash>`, `v1.3.0-rc1` gives `1.3.0~rc1`, and no tag gives
  `0.0.0`.
- **Releases:** publishing a GitHub release builds the `.deb`, attaches it to the
  release, and pushes the image with that version.

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
| `OZWELL_DESKTOP_TOKEN_FILE` | `/var/lib/ozwell-desktop/token` (container) or `~/.config/ozwell-desktop/token` | Where a generated token is kept |
| `OZWELL_DESKTOP_PUBLIC_URL` / `--public-url` | derived | Base URL used in the startup link (for example the host port behind Docker) |
| `OZWELL_DESKTOP_OPEN` / `--open` | `false` | Open the viewer in the default browser at startup |
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

`compose.yml` is the dev container. It uses the production image and systemd layout,
with your local `./dist` mounted over `/opt/ozwell-desktop/dist`.

```bash
nvm use                 # Node 26 (.nvmrc); the container runs the base image's Node 24
make deps               # npm ci
make build              # ./dist must exist before the first `docker compose up`
docker compose up       # prints "open http://localhost:8080/?token=…" (use -d, then
                        # `docker compose logs`, to run it in the background)
npm run watch           # rebuild on save; restarts the server in the container (about 1 s);
                        # viewer JS/CSS changes need only a page reload
npm test                # full regression: unit + integration (API, VNC, MCP, a11y,
                        # Chromium and Firefox viewer tests) against the compose service
```

- `npm test` builds `./dist` and installs Playwright's Chromium and Firefox if
  missing. It then starts the compose service if it isn't running, or restarts the
  server inside it if it is, and leaves the service running.
- **Startup link:** when no `OZWELL_DESKTOP_TOKEN` is set, the server generates a
  token and keeps it (compose stores it in the `state` volume, which survives
  `down` but not `down -v`). Every start then prints a link with the token
  embedded. A token you configure (environment or `.env`) is never printed.
- **`npm start`** runs the server on this host against `$DISPLAY` and opens the link
  in your default browser.
  - It reuses the compose service's generated token when that service is running.
  - It moves to port 8081 if compose is already on 8080.
- **Coverage guard:** a full integration run fails if any documented API route never
  returned a 2xx, or any MCP tool was never called. It checks the server's own request
  log, so new routes and tools need a test. Runs filtered to some files or tests skip
  the check.
- `npm run test:unit` runs only the fast unit tests.
- `OZ_URL=… OZ_TOKEN=… npm test` runs the suite against any other server.
- Run `docker compose up -d --build` after changing anything packaged other than
  `./dist`: `contrib/` (units, XFCE config, maintainer scripts), `.fpm`, `docker/`, the
  `Dockerfile`, or dependencies. The image is rebuilt from a fresh `.deb`.
- The compose container mounts `./dist` read-only, so don't `dpkg -i` or `apt` the
  package inside it. Use `docker compose up -d --build` instead.
- Don't delete the `dist` directory itself (`rm -rf dist`) while the container is
  running. The bind mount stays attached to the old directory; run
  `docker compose up -d --force-recreate` if you do. Rebuilding into `dist`, or
  emptying it, is fine: until `dist/cli.js` exists the service logs a hint and keeps
  retrying.
- If port 8080 is taken, set `OZWELL_DESKTOP_HOST_PORT` in a `.env` file. The tests
  discover the port and token from compose.
- `npm run openapi` regenerates `docs/openapi.json`.

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
