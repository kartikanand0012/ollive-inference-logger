# Shared image for the three backend apps (api / ingest / worker) — pick with
# --build-arg APP=<name>. tsx runtime, no build step; typecheck gates
# in CI/dev, not in the image.
FROM node:20-alpine
ARG APP
ENV APP=${APP}
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer caches across source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/ingest/package.json apps/ingest/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/providers/package.json packages/providers/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile --filter "@ollive/${APP}..."

COPY packages ./packages
COPY apps/${APP} ./apps/${APP}

ENV NODE_ENV=production
CMD pnpm --filter "@ollive/${APP}" start
