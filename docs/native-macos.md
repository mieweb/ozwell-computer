# Native macOS pilot

`--backend macos` serves the current Mac desktop through Ozwell's HTTP API and MCP.
It uses the optional `@trycua/cua-driver` SDK, pinned to `0.38.0`, behind the same
backend interface used by Linux/X11. Docker and OrbStack are unnecessary for this mode.

Each native server controls the logged-in Mac user session. Multiple servers or
agent connections share applications, files, credentials, focus and the clipboard;
they do not create separate desktops. Use container workspaces for independent Linux
jobs, or separate machines/VMs when Mac session isolation is required.

## Prepare the Mac

Use macOS 14 or newer and Node.js 24 or newer. Install the signed CuaDriver helper
following the [Cua Driver quickstart](https://cua.ai/docs/cua-driver/quickstart).
Installing this repository's npm dependencies alone does not install that helper.
Keep the helper compatible with the pinned SDK; report the versions when debugging
native ABI or daemon errors.

Run in the desktop session Ozwell will operate:

```bash
cua-driver permissions grant
cua-driver permissions status
cua-driver status
cua-driver doctor
```

In System Settings → Privacy & Security, enable **Accessibility** and **Screen &
System Audio Recording** (called **Screen Recording** on some versions) for
**CuaDriver**. Follow any quit/reopen prompt, then check permissions again. Review
`doctor` warnings even if the command exits successfully. Ozwell does not grant these
permissions itself.

The SDK normally connects to or starts CuaDriver.app, which owns those grants. Its
embedded fallback can attribute permissions to Node or its launching application.
For this pilot, install the signed helper and leave `CUA_DRIVER_EMBEDDED` unset.
See the [SDK guide](https://cua.ai/docs/cua-driver/guides/use-the-sdk) for those modes.

## Start Ozwell

```bash
npm ci
npm run build
node dist/cli.js --backend macos --host 127.0.0.1 --port 8081 --update-url off
```

The alternate port allows the native pilot and an existing container on port 8080
to run together. Bind to loopback while evaluating it. Use the access URL printed at
startup for the screenshot preview, or send the token as a Bearer credential to
`http://127.0.0.1:8081/api/v1/*` and `http://127.0.0.1:8081/mcp`. Keep the endpoint and
token private: input operates real Mac apps with their existing access.

Browser cookies are shared across ports on the same hostname. When viewing both
instances, use `127.0.0.1` for native Ozwell and `localhost` for the container, or use
separate browser profiles, to avoid their login cookies replacing each other.

The generated token lives in `~/.config/ozwell-computer/macos/token`, separately from
the X11 token. `--token`/`OZWELL_COMPUTER_TOKEN` and `--token-file` override it.
Exec, PTY and filesystem APIs default to disabled for macOS. Use `--exec` only when
those services should run as the Mac account hosting Ozwell. Native app launch and
open-target APIs remain unsupported even with `--exec`.
Background commands additionally require GNU coreutils: install it with
`brew install coreutils` and make `gtimeout` (or GNU `timeout`) available on the
server's `PATH`. Without it, background commands return `feature_unsupported`.
Disabling these APIs does not sandbox what an agent can do through the GUI.

## Verify the connection

With Ozwell running in one terminal, run this in another:

```bash
node scripts/smoke-macos.mjs \
  --url http://127.0.0.1:8081 \
  --token-file "$HOME/.config/ozwell-computer/macos/token" \
  --require-a11y \
  --out /tmp/ozwell-native-desktop.png
```

This checks native capabilities, health, the primary display, window enumeration,
PNG dimensions and coordinate metadata, accessibility snapshots, and MCP window and
screenshot tools. It prints counts and dimensions. The screenshot is saved only
when `--out` is supplied. Omit `--require-a11y` to report unavailable accessibility
as a skipped check. `--window <id>` restricts screenshots and the accessibility
snapshot to an ID returned by `GET /api/v1/windows`.

The smoke test does not send input, change focus, launch apps or access the
clipboard. A successful run establishes read-only connectivity; it does not verify
clicking, typing or accessibility actions. Verify those separately in a disposable
test document, take a fresh screenshot after each action, and confirm the intended
change before retrying an uncertain action.

## Pilot behavior and limits

| Surface | Native behavior |
|---|---|
| Screenshots | Primary display capture, optionally cropped to a window entirely on that display; PNG, JPEG and WebP responses. Cursor capture and OCR are unsupported. |
| Coordinates | Screen and window coordinates use macOS logical points. Screenshot image dimensions are pixels. Pass `screenshot_id` when acting on a screenshot so Ozwell maps Retina/downscaled images correctly. |
| Input | Foreground click, move, line scroll, type, press and hotkey can affect the user's current session. Drag, held buttons/keys, paste mode, pointer modifiers and motion duration are unsupported. Unsupported options return a structured error. |
| Windows | Enumeration, stable IDs within the session, titles and bounds. Activation, resize, minimize, maximize, restore and close are unsupported. Focused/maximized fields are `null` because the SDK does not report them. |
| Accessibility | Native AX snapshots, normalized roles, logical-point bounds, element search and token-based background `press` without a foreground retry. Coverage depends on the app; only enabled/selected states are exposed. Hidden-node traversal, generic `set_value`, `focus` and other actions are unsupported. Use a fresh snapshot after stale-token errors. |
| Clipboard | Plain text through the existing APIs. It is the user's actual clipboard. Image clipboard content is unsupported; generation tracks Ozwell writes and does not observe external changes. |
| Processes/files | Disabled by default; `--exec` enables the host process, PTY and filesystem APIs. Native `launch_app`, app-launch and open-target routes remain unsupported. |
| Viewer | `/` provides a screenshot preview. Native VNC and its interactive noVNC controls are unavailable; capabilities report `vnc.available=false`. |
| Capabilities | `GET /api/v1/capabilities` reports `backend: "macos"` and feature limitations. Check it rather than assuming X11 parity. |

The pilot targets one primary display. Multi-monitor arrangements, display changes,
locked/login screens, protected content and application-specific accessibility gaps
need further evaluation. Permission changes may require relaunching CuaDriver and
restarting Ozwell. Xvfb and X11 display flags apply to the X11 backend only.
Input results also use `focus_changed: null` when a focus change cannot be established.

Unit tests use a fake native driver/backend so Linux CI can check dispatch, geometry,
errors and the HTTP/MCP boundary without a Mac desktop. They do not establish that
the signed helper or macOS permissions work on a particular machine. Run the smoke
test above to record that separately; do not infer native verification from a passing
Linux/container test suite.
