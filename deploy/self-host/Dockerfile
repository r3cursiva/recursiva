# The recursiva server image built from source, for whoever runs it themselves (SELF_HOSTING.md): needs only Docker. The
# stage `build` does what `pnpm build` does on a developer's machine; the final stage is the same as deploy/stand/Dockerfile
# (the bundled server and CLIs, the web build and the migrations, no node_modules), so both images behave alike.
#   docker build -f deploy/self-host/Dockerfile -t recursiva .
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @rsva/server --filter @rsva/web build

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
WORKDIR /app
COPY --from=build /src/apps/server/dist/main.js /src/apps/server/dist/*-cli.js apps/server/dist/
COPY --from=build /src/apps/web/dist apps/web/dist/
COPY --from=build /src/packages/schema/migrations packages/schema/migrations/
# A uid that exists neither in the image nor, as a rule, on the host (as deploy/stand/Dockerfile).
# Uploads: a volume mounted here starts with this directory's owner.
RUN mkdir -p /data/files && chown 3820:3820 /data/files
USER 3820:3820
ENV NODE_ENV=production PORT=3800 HOST=0.0.0.0 RSVA_FILES_DIR=/data/files
EXPOSE 3800
CMD ["node", "--max-semi-space-size=16", "apps/server/dist/main.js"]
