# Diffract control plane — Railway image.
# Zero runtime dependencies (Node 22 + node: builtins only), so there is no
# install/build step: we just copy the source and run it.
FROM node:22-slim

ENV NODE_ENV=production
# Tenant store + email outbox live on a Railway Volume mounted at /data.
ENV TENANT_STORE=/data/tenants.json

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# Runs as root: Railway mounts the persistent Volume (/data) root-owned, and the
# container is already an isolated security boundary. The app execs no untrusted
# code. Ensure the mount point exists for local `docker run` without a volume.
RUN mkdir -p /data

# Railway injects PORT; the server reads it and binds 0.0.0.0 (config.bindHost).
CMD ["node", "src/server.mjs"]
