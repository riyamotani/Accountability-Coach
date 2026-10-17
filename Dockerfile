# One Dockerfile, several STAGES, two final images.
#
# A multi-stage build uses throwaway stages to compile, then copies only the
# results into a small final image. The compilers, TypeScript, dev
# dependencies and source files never reach production — which makes the
# image smaller, faster to pull, and gives an attacker less to work with.
#
#   deps  → installs every dependency once (cached until a package.json changes)
#   build → compiles shared, api, bot and web
#   app   → FINAL image for the api, worker and bot (same code, different command)
#   web   → FINAL image for the Next.js dashboard
#
# Build one with:  docker build --target app -t coach-app .
#                  docker build --target web -t coach-web .

# node:22-alpine is a multi-architecture image: the same line gives x86 on a
# laptop and ARM on an Oracle Ampere VM, with no changes here.
FROM node:22-alpine AS base
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps

# Package manifests FIRST, source later. Docker caches each step and reuses
# it until its inputs change — so as long as no package.json changes, this
# slow `npm ci` is skipped entirely on the next build, even if every .ts file
# changed. Copying the whole repo here would bust that cache on every edit.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/

# `ci`, not `install`: installs exactly what package-lock.json says and fails
# if the two disagree, so every build gets identical dependencies.
RUN npm ci

# ---------------------------------------------------------------------------
FROM deps AS build

COPY . .

# Baked into the dashboard's JavaScript AT BUILD TIME — Next.js copies
# NEXT_PUBLIC_* values into the code it sends to browsers. "/api" is a
# relative path: Caddy serves the API under /api on the same domain, so the
# image never needs to know its own hostname, and the browser never makes a
# cross-origin request.
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

# Order matters: everything imports @coach/shared, so it builds first.
RUN npm run build --workspace=@coach/shared \
 && npm run build --workspace=@coach/api \
 && npm run build --workspace=@coach/bot \
 && npm run build --workspace=@coach/web

# ---------------------------------------------------------------------------
# api + worker + bot. One image, three containers: they share every
# dependency, so separate images would just be three copies of the same
# node_modules. docker-compose chooses which program each container runs.
FROM base AS app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/

# Production dependencies of these three workspaces only: no TypeScript, no
# tsx, no drizzle-kit, and none of the dashboard's React/Next packages.
RUN npm ci --omit=dev --workspace=@coach/shared --workspace=@coach/api --workspace=@coach/bot \
 && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
# The migration SQL, read at deploy time by dist/migrate.js.
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/bot/dist apps/bot/dist

# Never run as root inside the container. The official image ships a `node`
# user for exactly this; a compromised process then can't write to the
# system or install anything.
USER node

CMD ["node", "apps/api/dist/server.js"]

# ---------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Listen on every interface, not just localhost: inside a container,
# "localhost" is the container itself, and Caddy connects from outside it.
ENV HOSTNAME=0.0.0.0

# The standalone output mirrors the monorepo layout, so server.js lands at
# apps/web/server.js. Static assets and /public are deliberately left out of
# the standalone folder by Next (they're meant for a CDN), so they're copied
# in beside it.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
