# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20
ARG ALPINE_VERSION=3.22

# --- Stage 1: build wireguard-go from source (pinned via WG_GO_REF) ---
FROM golang:1.23-alpine${ALPINE_VERSION} AS wg-build
ARG WG_GO_REF=0.0.20250522
RUN apk add --no-cache git make && \
    git clone --depth 1 --branch ${WG_GO_REF} https://git.zx2c4.com/wireguard-go /src && \
    cd /src && make && cp wireguard-go /wireguard-go

# --- Stage 2: npm install ---
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node-build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
# Default empty — fails explicitly if private packages are actually required
# but not provided. Local builds without private deps work fine.
ARG GH_PACKAGES_TOKEN=""
# Inline on the RUN line — NOT an ENV layer (would leak token via docker history).
RUN NODE_AUTH_TOKEN=${GH_PACKAGES_TOKEN} npm ci --omit=dev --ignore-scripts
COPY src ./src

# --- Stage 3: runtime ---
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION}
RUN apk add --no-cache wireguard-tools iproute2 libcap tini && \
    addgroup -S gateway && adduser -S -G gateway -H -s /sbin/nologin gateway && \
    mkdir -p /config /var/log/gateway && \
    chown -R gateway:gateway /var/log/gateway

COPY --from=wg-build /wireguard-go /usr/local/bin/wireguard-go
COPY --from=node-build /build/node_modules /app/node_modules
COPY --from=node-build /build/src /app/src
COPY --chown=gateway:gateway package.json /app/package.json

# Grant NET_ADMIN cap to wireguard-go binary (so we can drop CAP_NET_ADMIN from container)
# Note: Container must still have CAP_NET_ADMIN in cap_add (setcap only works if FS supports it)
RUN setcap cap_net_admin+ep /usr/local/bin/wireguard-go

WORKDIR /app

# NOTE: Container runs as root (UID 0) because wg-quick is a shell script that
# hard-requires UID 0 (line 85: "exec sudo ... bash" when $UID != 0, and sudo
# is not installed in this minimal image). The security boundary is the
# cap_drop: ALL + minimal-cap-add pattern enforced in docker-compose, NOT the
# user UID. Inside this container root has only CAP_NET_ADMIN + CAP_NET_BIND_SERVICE.
# The 'gateway' user is kept in the image for future non-root operation if
# wg-quick dependency is replaced with a direct wireguard-go+ip wrapper.

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.GC_API_PORT || 9876) + '/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "node", "src/index.js"]
