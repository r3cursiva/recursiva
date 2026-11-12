# Contributing

Thank you for looking. recursiva is young and the maintainers are few, so small, focused pull requests get reviewed
fastest. For anything bigger than a fix, open an issue first and say what you plan.

## Set up

You need Node 24 or newer, [corepack](https://nodejs.org/api/corepack.html) (it installs the pnpm version the repository
pins) and Docker for Postgres.

```sh
pnpm install
docker compose up -d db          # Postgres on 127.0.0.1:5438
pnpm build
RSVA_MAIL=log pnpm --filter @rsva/server start   # http://127.0.0.1:3800; sign-in codes are printed in the server log
```

Only a member of a workspace (or someone invited to one) gets a sign-in code, so an empty database lets nobody in. Load
synthetic data, then open `http://127.0.0.1:3800/sample/` and sign in as `owner@sample.test`:

```sh
mkdir -p .data && node tools/fixtures/src/cli.ts sample --slug sample --out .data/sample.ndjson
node apps/server/src/cli/import.ts .data/sample.ndjson
```

To be able to create more workspaces, start the server with `RSVA_WORKSPACE_CREATORS=<your address>` and sign in with an
address that is already a member. Settings that the server reads are listed in `.env.example` (copy it to `.env`; git
ignores that file).

### Hot reload

`pnpm dev` runs the server in watch mode and the Vite web app at `https://rsva.localhost` through
[portless](https://www.npmjs.com/package/portless) (`npm install -g portless`). On its first run portless binds port 443,
which may ask for `sudo`, and adds a local certificate authority to your system trust store.

Without portless, run the two halves in two terminals and open `http://localhost:5173`:

```sh
pnpm --filter @rsva/server dev        # API on 127.0.0.1:3800, restarts on change
pnpm --filter @rsva/web exec vite     # web app on localhost:5173, proxies the API to 127.0.0.1:3800 (or RSVA_SERVER)
```

Either way the dev server takes `000000` as the sign-in code and mails nothing; with the sample data, sign in as
`owner@sample.test`.

## Check before you push

```sh
pnpm check
```

This is typecheck, duplicate-code check (`jscpd`; any repeat of 50 tokens fails), unused files and exports (`knip`),
tests, build and the startup-size check. Server tests use their own database, `rsva_test`, in the same Postgres. A
`pre-push` git hook in `.githooks` runs `pnpm check` for you; it is installed by `pnpm install` and skips pushes that only
touch Markdown or `docs/`. On GitHub, the `CI` workflow runs the same checks on Linux for pull requests from forks
(read-only, no secrets); a maintainer approves each run before it starts, so it may wait a little.

## Rules that matter for a pull request

- **Speed and size count.** After a change to the interface, server or protocol run `pnpm perf` and put the numbers in the
  pull request. Growth of the startup bundle above 2 % fails `pnpm check`; budgets are in `perf/budgets.json` and are not
  raised without a maintainer's decision. Check the weight of a new dependency in `pnpm perf:bundle` and load heavy ones
  lazily. A phone-layout change: `pnpm perf:phone`.
- **Reuse before adding.** Look through `packages/ui` before writing a component; extract logic the second time you repeat it.
- **Dependencies:** exact versions, and nothing published less than a week ago (`minimumReleaseAge`).
- **Icons:** Phosphor only (`@phosphor-icons/react`), imported one by one.
- **English.** Code, comments, error messages, commit messages and the interface are in English.
- **Tests** for a behavior change: one that fails without your change.
- **Commits and pull requests:** a short imperative subject, a body that says why. If the work belongs to an issue,
  mention its key (`Fixes RSVA-123`).

## License and CLA

Contributions are accepted under a Contributor License Agreement, not a DCO sign-off: it lets the project keep the code
under its open licenses (AGPL-3.0-only, and Apache-2.0 for `packages/policy`, `schema`, `protocol`, `query` and `sync`)
and also offer a commercial license to those who cannot use the AGPL. When you open your first pull request, a bot
will ask you to sign the CLA; the pull request cannot be merged until you have. Details are in the bot's comment.

The name and mark recursiva are not licensed with the code: [TRADEMARKS.md](TRADEMARKS.md).

## Security

Do not report vulnerabilities in public issues: see [SECURITY.md](SECURITY.md).
