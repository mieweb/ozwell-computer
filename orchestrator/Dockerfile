# ozwell-computer orchestrator. Build from the repo root (it needs docs/mcp-tools.json):
#   docker build -f orchestrator/Dockerfile -t ozwell-computer-orchestrator .
# Usually run through orchestrator/deploy/compose.yml.
FROM node:26-trixie-slim
ENV NODE_ENV=production
WORKDIR /app/orchestrator
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY orchestrator/src ./src
# The default TOOL_CATALOG: ../../docs/mcp-tools.json relative to src/.
COPY docs/mcp-tools.json /app/docs/mcp-tools.json
USER node
EXPOSE 8090 8091
# telemetry.ts first, so its instrumentations see fastify, pino, undici and http load.
CMD ["node", "--import", "./src/telemetry.ts", "src/cli.ts"]
