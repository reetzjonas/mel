# Deployment

Static image, no backend: the `Dockerfile` builds the bundle and serves it with
**nginx-unprivileged** (uid 101, port 8080), so it drops into a hardened Kubernetes
`securityContext` (`runAsNonRoot`, `readOnlyRootFilesystem`) without a shim.
Examples in the repo: `compose.yaml` (port 8081, because 8080 belongs to the dev
Stalwart) and `deploy/k8s/` (Deployment, Service, Ingress).

Two traps, both verified:

- **nginx does not inherit `add_header`**: as soon as a `location` sets a header of
  its own it loses *every* inherited one. The security headers therefore live in
  `docker/nginx-headers.conf` and are `include`d per block. Without that they were
  missing on exactly the path that matters — `/` falls through to `/index.html`
  internally.
- **`sw.js` must not be cached**, or users stay pinned to an old build for as long as
  the entry lives. Only `/assets/*` (hashed) is `immutable`.

Important when deploying: the app talks to the JMAP server **straight from the
browser**, so the origin decides what is needed. Served from a *different* origin —
the usual case, and note that another subdomain already counts — the mail server has
to permit mel's origin via CORS; without it everything fails as an opaque
`TypeError` that nothing on our side can fix or even diagnose. Served from the *same*
origin, CORS never applies at all, but then the proxy in front must route `/jmap`,
`/.well-known/jmap` (and `/dav`) to the mail server first: mel's SPA fallback answers
those paths with `index.html` otherwise (verified against the image), shadowing the
mail server.

CI (`.github/workflows/ci.yml`): `check` (lint, build = typecheck, Vitest) and `e2e`
run in parallel, `publish` depends on both and pushes to ghcr on `push` only. The e2e
job tests **the image**, not the dev server — `playwright.config.ts` reads
`MEL_E2E_BASE_URL` and skips its `webServer` when that is set. Only that way are the
nginx delivery and the service worker registered in production covered at all.

**GitHub CI**: what remains open is that no run has ever happened on GitHub itself —
everything above is verified locally (image built, container tested, `kubectl
--dry-run` clean), but the first real workflow run is still pending.
