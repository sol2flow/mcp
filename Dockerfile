# syntax=docker/dockerfile:1.7
# The sol2flow MCP server, HTTP transport: one bundled file, no node_modules, non-root, port 3000.
#   docker build -t ghcr.io/sol2flow/mcp:dev .
#   docker run --rm -p 3000:3000 --read-only -e SOL2FLOW_URL=https://app.example.com \
#     -e ALLOWED_HOSTS=mcp.example.com ghcr.io/sol2flow/mcp:dev
# Nothing deployment-specific is baked in: SOL2FLOW_URL, ALLOWED_HOSTS, ALLOWED_ORIGINS, TRUST_PROXY_HOPS,
# FORWARD_CLIENT_IP, READ_ONLY, LOG_* and SENTRY_* are read at start (README.md → Configuration).
#
# Multi-platform without emulation: the build stage runs on the build machine's platform ($BUILDPLATFORM; the bundle
# is plain JavaScript), and the runtime stage has no RUN step, so an arm64 image needs no QEMU.

FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /src
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY . .
# the version the server reports (--version, /healthz, the MCP handshake, error tracking's release): the release
# workflow passes the semantic-release version, or "edge"
ARG APP_VERSION=dev
RUN APP_VERSION="$APP_VERSION" npm run build \
 && mkdir -p /out/app /out/data/logs \
 && cp dist/index.js dist/sentry-sdk.js LICENSE THIRD-PARTY-NOTICES.md /out/app/

FROM node:26-alpine AS runtime
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="sol2flow MCP server" \
      org.opencontainers.image.description="Lets AI assistants work with sol2flow tasks through its REST API (Model Context Protocol, Streamable HTTP)" \
      org.opencontainers.image.source="https://github.com/sol2flow/mcp" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production MCP_TRANSPORT=http HOST=0.0.0.0 PORT=3000
WORKDIR /app
# owned by root and only readable by the server's user: it never writes here (runs with --read-only)
COPY --from=build /out/app/ ./
# a fixed user id (1001:1001), so a host directory bind-mounted to /data/logs (LOG_FILE) can be prepared for it
COPY --from=build --chown=1001:1001 /out/data /data
USER 1001:1001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "index.js"]
