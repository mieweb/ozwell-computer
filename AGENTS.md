# Agent instructions

## Commits

Commit after every prompt that changes files: one prompt, one commit. Don't push unless
asked. PRs are squashed when merged, so these commits are for reviewers and whoever
continues the work: each one shows what a single request changed and why.

- Commit only the files that prompt changed, with a message in the repo's style
  (`area: what changed`, then a short body saying why).
- Run the checks below that apply before committing, and say in the message if any were
  skipped.

## Testing changes locally

Don't run the full suite (`npm test`) after every change. It takes minutes and
restarts the server in the compose container.

- **Every change:** `npm run typecheck` and `npm run test:unit`.
- **Orchestrator changes** (`orchestrator/`): `npm run typecheck` and `npm test` in that
  directory. If you change the computer's MCP tools, regenerate the catalog the
  orchestrator proxies: `make build && npm run mcp-tools` (CI checks it's current).
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
