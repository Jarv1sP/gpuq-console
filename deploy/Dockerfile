FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS client-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY *.mjs ./
COPY dist ./dist
COPY scripts/build-client.mjs ./scripts/
RUN npm run build:client
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --from=client-builder --chown=root:root /app/build/gpuctl.mjs ./build/gpuctl.mjs
COPY --from=client-builder --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root dist ./dist
COPY --chown=root:root portal-server.mjs portal-service.mjs community.mjs maintenance.mjs execution.mjs job-submission.mjs projects.mjs snapshot-sync.mjs gpuq-status.mjs cli.mjs job-watch.mjs job-notifications.mjs client-bundle.mjs guide.mjs package.json ./
COPY --chown=root:root cloud-import.mjs aliyun-share.mjs community-cli.mjs ./
COPY --chown=root:root clouddrive-provider.mjs ./
COPY --chown=root:root proto/clouddrive-pilot.proto ./proto/
COPY --chown=root:root dataset-catalog.mjs dataset-preparation.mjs dataset-replication.mjs ./
COPY --chown=root:root docs/USER_GUIDE.md ./docs/
COPY --chown=root:root deploy/install-client.sh deploy/install-client.ps1 ./deploy/
USER node
EXPOSE 8080
CMD ["node", "portal-server.mjs"]
