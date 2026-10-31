FROM node:24-bookworm-slim
WORKDIR /opt/ozwell-computer/orchestrator
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY orchestrator/src/ src/
COPY docs/mcp-tools.json /opt/ozwell-computer/docs/mcp-tools.json
EXPOSE 8090
CMD ["node", "src/cli.ts"]
