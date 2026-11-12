# The recursiva server image: the bundled server and CLIs (apps/server/dist), the web build (apps/web/dist) and the
# migrations, nothing else. Built from what `pnpm build` left on the host, so the image needs neither pnpm nor
# node_modules; the paths keep the repository's layout, which the server resolves relative to itself.
#   pnpm build && docker buildx build --platform linux/amd64 -f deploy/stand/Dockerfile -t rsva:<sha> .
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
WORKDIR /app
COPY apps/server/dist/main.js apps/server/dist/*-cli.js apps/server/dist/
COPY apps/web/dist apps/web/dist/
COPY packages/schema/migrations packages/schema/migrations/
# A uid and gid that exist neither in the image nor on the host: the image's `node` is uid 1000, and an account with the
# same uid could read this process's environment (PLNR-32). compose.yaml sets the same user, so an older image brought
# back by rsva-deploy --rollback runs as it too.
USER 3820:3820
ENV NODE_ENV=production PORT=3800 HOST=0.0.0.0
EXPOSE 3800
CMD ["node", "--max-semi-space-size=16", "apps/server/dist/main.js"]
