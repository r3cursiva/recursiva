# Architecture

recursiva is a pnpm monorepo of TypeScript (Node 24, run directly from source with type stripping; the web app is built
with Vite). One Postgres database, one Node server, one browser app, plus terminal clients.

## Map

`apps/`

- `apps/web`: the browser app (React, MobX, ProseMirror editor). Talks to the server over HTTP and one WebSocket.
- `apps/server`: the Node server. Sign-in (`src/auth`), the write pipeline and the log (`src/sync`), the REST API
  (`src/api*.ts`), notifications (`src/notify`, `src/mail`, `src/telegram`), the GitHub App (`src/github`), command-line
  tools (`src/cli`: import, tokens, waitlist). It also serves the built web app (`src/static.ts`).
- `apps/cli`: the `rsva` command for people and agents, over the REST API.
- `apps/tui`: `rsva tui`, the app in the terminal and the agent dispatch.

`packages/` (Apache-2.0 ones marked)

- `packages/schema` (Apache-2.0): the database tables (Drizzle), migrations, and the data models shared by client and server.
- `packages/protocol` (Apache-2.0): the wire format: actions in the log, WebSocket frames, snapshot lines, API shapes.
- `packages/sync` (Apache-2.0): the client sync engine: store, IndexedDB queue, transport.
- `packages/query` (Apache-2.0): the query language (`state:"In Review" assignee:me`), parsed and run on both sides.
- `packages/policy` (Apache-2.0): who may do what: roles, token grants, the "only people" rules. Used by the server to
  decide and by the client to hide what would be refused.
- `packages/editor`: the description editor and Markdown/ProseMirror conversion.
- `packages/ui`: UI components over Base UI primitives; `packages/display`: how issue properties are shown;
  `packages/terminal`: the terminal renderer behind `rsva tui`.

`tools/`: `fixtures` (synthetic workspace data), `perf` (size and timing checks), `sync-lab` (the real engine and server
over a network that resets and hangs), `copies` (duplicate checks that jscpd cannot see), `test-kit` and `test-watchdog`
(test helpers), `release` (the maintainers' deploy command), `dev` (a dev helper).

`connectors/`: importers from Plane (`plane` via its API, `plane-db` from a database copy). `deploy/`: deployment files.
`perf/`: budgets and the baseline.

## The sync model in one screen

**In the browser.** On a cold start the server streams a snapshot of the workspace, the project you opened first in front. The
client keeps it as an in-memory pool and a copy in IndexedDB. A warm start reads that copy and is ready before any network
call, then catches up from the last log number it applied. Views, filters, search and the issue list are computed locally
from the pool; no click waits on a request.

**Edits.** A local edit applies to the pool in the same tick and goes into a persisted queue as a transaction of actions.
For every field with a pending edit the client also keeps the latest value the server confirmed. When a delta arrives it
updates that value and the pool, then the pending edits are replayed on top. If the server refuses a transaction, the field
returns to the confirmed value, not to what the user saw before. The UI says how many changes are not saved yet.

**On the server.** All writes, whether from the browser, an agent through the API, an import or a webhook, go through one
pipeline (`apps/server/src/sync/write.ts`): validate, check the transaction id so a retry is harmless, check policy, write,
take the next log numbers, commit, broadcast. Numbers come from the workspace row at the end of the transaction and the
row stays locked until commit, so the log is contiguous and in commit order. The server encodes each frame once and sends
the same bytes to every subscriber of the workspace (`sync/hub.ts`); a client that falls behind is dropped and reconnects.

**Merging.** Lists (labels, assignees, relations) merge instead of replacing each other; a description edited from an older
text is refused rather than overwritten. There is no live co-editing of a description.

**Today's limits.** The fan-out lives in one server process; several processes are not supported yet. Several tabs each
open their own connection.

## Where to start reading

1. `packages/protocol/src/index.ts`: the vocabulary (actions, frames).
2. `packages/sync/src/client.ts`: the client engine; its header comment is the best short description.
3. `apps/server/src/sync/write.ts`, `log.ts`, `hub.ts`, `socket.ts`: the write path and the log.
4. `packages/policy/src`: the rules.
5. `apps/web/src`: the screens; start from `App.tsx`.
6. `tools/sync-lab`: how the engine is tested against a bad network (`pnpm sync:lab`).
