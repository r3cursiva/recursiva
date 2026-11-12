# recursiva

Instructions for coding agents working in this repository. People: see [CONTRIBUTING.md](CONTRIBUTING.md) and
[ARCHITECTURE.md](ARCHITECTURE.md).

## Build and check

- Node 24 or newer, pnpm (corepack installs the pinned version), Docker for Postgres. `pnpm install`, `docker compose up -d db`,
  `pnpm build`.
- `pnpm check` before every push: typecheck, duplicate code (`jscpd`, fails on any repeat of 50 tokens), unused files, exports and
  dependencies (`knip`), tests, build, startup-bundle size. The `pre-push` hook in `.githooks` runs it.
- Setup details, running the server and sample data: [CONTRIBUTING.md](CONTRIBUTING.md).

## Speed and size

- After a change to the interface, server or protocol run `pnpm perf` and put the numbers in the pull request. Phone layout:
  `pnpm perf:phone`.
- Growth of `perf:bundle` above 2 % fails `pnpm check`. If it is justified, `pnpm perf:<part> --update` and explain it in the
  commit. Budgets in `perf/budgets.json` are not raised without a maintainer's decision.
- A new interface dependency: look at its weight in `pnpm perf:bundle` first and load heavy ones lazily.
- Versions from npm: exact, and not newer than a week (`minimumReleaseAge`).

## Conventions

- Reuse before adding. Look through `packages/ui` before writing a component; extract logic the second time it repeats,
  in the same change. Code shared by client and server lives in `packages/*`, not as copies in `apps/*`.
- Icons: Phosphor only (`@phosphor-icons/react`), imported one by one.
- Phone layout: the same elements, not separate screens. `max-md:` means a phone; touch targets at least 44 px (32 px for chips),
  inputs 16 px; anything shown on hover needs a `pointer-coarse:` path.
- English everywhere: interface, code, comments, error messages, commits.
- A behavior change comes with a test that fails without it.
- Do not copy code from Plane or other trackers: the project is AGPL-3.0 with a CLA and must stay ours to relicense.

@docs/CLAUDE.md
