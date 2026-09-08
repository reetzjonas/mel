# mel ships as a plain static bundle: there is no backend, the browser talks to
# the JMAP server directly. That means the only job here is serving files —
# and getting the caching right, because a stale service worker pins users to
# an old build far more stubbornly than a stale asset does.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first: this layer only rebuilds when the lockfile moves.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# vite build must precede tsc — it generates routeTree.gen.ts, which tsc reads.
RUN npm run build


# Unprivileged variant: runs as uid 101 and listens on 8080, so the image drops
# straight into a hardened Kubernetes securityContext without a shim.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx-headers.conf /etc/nginx/mel-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/index.html >/dev/null || exit 1
