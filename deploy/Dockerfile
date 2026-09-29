FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --chown=root:root dist ./dist
COPY --chown=root:root portal-server.mjs portal-service.mjs community.mjs execution.mjs projects.mjs gpuq-status.mjs cli.mjs package.json ./
COPY --chown=root:root USER_README.md ADMIN_README.md ./
COPY --chown=root:root docs/DATASETS.md docs/PROJECTS.md docs/TERMINAL_SESSIONS.md docs/JOB_DIAGNOSTICS.md docs/RAY_RESOURCES.md docs/COMMUNITY.md docs/PROJECT_NETWORK.md ./docs/
COPY --chown=root:root deploy/install-client.sh ./deploy/
USER node
EXPOSE 8080
CMD ["node", "portal-server.mjs"]
