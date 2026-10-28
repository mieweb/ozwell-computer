# Agent instructions

## Testing changes locally

Don't run the full suite (`npm test`) after every change. It takes minutes and
restarts the server in the compose container.

- **Every change:** `npm run typecheck` and `npm run test:unit`.
- **Changes the integration tests cover:** also run the integration file(s) for that
  area, against the running compose container:
  ```bash
  make build
  npx vitest run --project integration test/integration/<file>.test.ts
  npx vitest run --project integration test/integration/<file>.test.ts -t "<test name>"
  ```
  The run restarts the server so it picks up `./dist`. Running only some files skips
  the API/MCP coverage check.
- **Changes to the image** (`Dockerfile`, `contrib/`, `docker/`, `.fpm`, dependencies):
  `docker compose up -d --build` first, then the relevant integration files.
- **Full suite (`npm test`):** only before a release, or after a large or cross-cutting
  change (auth, the X11 core, VNC, packaging). It also runs the coverage check, so new
  routes and MCP tools need tests.

CI runs only typecheck, unit tests and the build on each push. The full integration
suite runs on releases, nightly, and on demand (`gh workflow run CI`).
