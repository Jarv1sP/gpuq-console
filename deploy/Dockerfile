FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS client-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY *.mjs ./
COPY dist ./dist
COPY scripts/build-client.mjs ./scripts/
RUN npm run build:client

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --from=client-builder --chown=root:root /app/build/gpuctl.mjs ./build/gpuctl.mjs
COPY --chown=root:root dist ./dist
COPY --chown=root:root portal-server.mjs portal-service.mjs community.mjs execution.mjs job-submission.mjs projects.mjs gpuq-status.mjs cli.mjs job-watch.mjs job-notifications.mjs client-bundle.mjs guide.mjs package.json ./
COPY --chown=root:root docs/USER_GUIDE.md ./docs/
COPY --chown=root:root deploy/install-client.sh deploy/install-client.ps1 ./deploy/
USER node
EXPOSE 8080
CMD ["node", "portal-server.mjs"]
