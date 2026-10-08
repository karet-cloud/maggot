<img src="assets/icon.svg" width="64" height="64" alt="">

# megit

A Git platform for many agents working on the same codebase at once, built on
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), Workers, and Durable Objects.

This is the headless MVP: an HTTP + WebSocket API, a merge-queue coordinator, and an agent CLI.
There is no UI yet; the API is meant to be built against (types in [`src/api.ts`](src/api.ts)).

## The model

GitHub's model (shared repo, branches, PRs, human review) breaks down when hundreds of agents
push at once. megit replaces it with:

- **Task = fork.** Each unit of agent work gets its own Artifacts fork with a repo-scoped write
  token. Agents can never push to the project repo, so they can't race each other or clobber `main`.
- **Two queues per project, both in the project's Durable Object.** A *fork queue* creates task
  forks at most 2 at a time (Artifacts fails ~40% of forks of one repo when 8 run at once, 0% at 2;
  different repos don't interfere, so the limit is per project). A *merge queue* lands submissions
  strictly one at a time. Both are persisted in SQLite and resumed by the alarm after a restart.
- **Single writer.** One Durable Object per project owns the default branch. Agents *submit*;
  the coordinator merges submissions one at a time (3-way merge with isomorphic-git, in memory)
  and pushes. If someone moved `main` underneath it, it resyncs and retries.
- **Conflicts are data, not a review thread.** A conflicting task goes to `conflict` with the
  conflicting files *and the already-merged tasks that touched them*. The agent runs
  `megit sync`, resolves, and resubmits. Non-conflicting work never waits on a human.
- **Advisory path claims.** Tasks can declare paths they intend to touch; creating a task returns
  any active tasks with overlapping claims so agents can coordinate before they collide.
- **Everything is an event.** Every state change is appended to a per-project event log, available
  by polling (`/events?after=`) or live over a WebSocket, with replay on reconnect.

```
 agent ──megit start──▶ Worker ──▶ ProjectCoordinator (DO, SQLite) ──fork──▶ Artifacts: proj--t123
   │                                        │
   ├── git push (fork token) ──────────────────────────────────────────────▶ Artifacts: proj--t123
   └──megit submit──▶ Worker ──▶ queue ──alarm──▶ fetch main + fork, merge, push ──▶ Artifacts: proj
                                            └──▶ events ──▶ WebSocket / polling
```

Task lifecycle: `provisioning → open → queued → merging → merged`, with `conflict` / `failed` returning to
`queued` on resubmit, and `abandoned` from any non-terminal state. Merged and abandoned forks are
deleted.

## Run it locally (no Cloudflare account needed)

```sh
npm install
npm run dev          # local Artifacts stand-in + `cf dev --mode offline`, on random free ports
```

`npm run dev` prints the API URL. The local stack uses `scripts/local-artifacts.ts`, which serves
real Git smart HTTP (via `git http-backend`) with Artifacts-style tokens and mirrors the parts of the
Workers binding megit uses, so the Worker code path is the same as production. State lives in
`.megit-local/`. Set `HOST=0.0.0.0 PUBLIC_HOST=<your-tailscale-host>` to expose it to other machines.
To reproduce Artifacts' concurrent-fork failures locally, set `LOCAL_ARTIFACTS_FORK_DELAY_MS=500`
and `LOCAL_ARTIFACTS_FORK_FAIL_ABOVE=2` (forks fail while more than 2 of one repo are in flight).

Then, in another shell:

```sh
export MEGIT_URL=http://127.0.0.1:<port>      # from the dev output; API key defaults to "dev"
npm run demo                                  # 6 concurrent agents + a deliberate conflict
```

Or drive it by hand:

```sh
node cli/megit.ts init myproj
node cli/megit.ts start myproj "Add login" --agent claude-1 --paths src/auth/
cd myproj-t…   # a normal git checkout of the task's fork
# …edit, commit (or not; submit commits for you)…
node cli/megit.ts submit --wait
node cli/megit.ts watch myproj               # live event stream
```

## Deploy to Cloudflare

Tooling is the new [`cf` CLI](https://github.com/cloudflare/cf) (beta). The Worker is configured in
[`cloudflare.config.ts`](cloudflare.config.ts) and built with `@cloudflare/vite-plugin`. Deploying
requires a Workers Paid plan, since Artifacts is in open beta there.

```sh
npx cf auth login
export CLOUDFLARE_ACCOUNT_ID=<account with Artifacts access>   # needed if your login has several accounts

# First deploy: a new Worker's secrets have to ship with it.
mkdir -p .secrets && echo "MEGIT_API_KEY=$(openssl rand -hex 24)" > .secrets/prod.env   # gitignored
npx cf deploy --secrets-file .secrets/prod.env

# Later deploys keep the secret.
npm run deploy
```

Point the CLI at it with `MEGIT_URL=https://megit.<subdomain>.workers.dev` and `MEGIT_API_KEY` from
`.secrets/prod.env`. The "megit" Artifacts namespace is created on first use. A brand-new
`workers.dev` route can return error 1042 for a few seconds after the first deploy.

`cloudflare.config.ts` is a function of the `--mode` flag: `offline` (used by `npm run dev`) binds
the local stand-in, and any other mode binds the real Artifacts namespace. Vite reserves the mode name
`local`, which is why the local mode is called `offline`. Types are generated from the config with
`cf workers types` into `.cloudflare/types/`.

## API

All routes are under `/api` and need `Authorization: Bearer <MEGIT_API_KEY>` (or `?key=` for
WebSockets). Errors look like `{ "error": { "code": "NOT_FOUND", "message": "…" } }`. Response
shapes are the types in [`src/api.ts`](src/api.ts).

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/projects` | | `{ projects: Project[] }` |
| POST | `/projects` | `{ name, description?, defaultBranch?, importUrl?, importBranch? }` | `{ project }` |
| GET | `/projects/:p` | | `{ project: Project }` (head, per-status counts, queue length) |
| DELETE | `/projects/:p` | | deletes repo, forks, and state |
| GET | `/projects/:p/tasks` | `?status=` | `{ tasks: Task[] }` newest first |
| POST | `/projects/:p/tasks` | `{ title, agent?, paths? }`, `?wait=<s>` (default/max 25) | `TaskAccess`: 201 with fork + base credentials once the fork exists; 202 with `fork: null` while still `provisioning` |
| GET | `/projects/:p/tasks/:id` | | `{ task: Task }` |
| POST | `/projects/:p/tasks/:id/access` | | `TaskAccess` with fresh tokens (`fork: null` while provisioning) |
| POST | `/projects/:p/tasks/:id/submit` | | `{ task }`, enqueues for merge (202) |
| POST | `/projects/:p/tasks/:id/abandon` | | `{ task }`, deletes the fork |
| GET | `/projects/:p/queue` | | `{ queue: QueueEntry[] }` |
| GET | `/projects/:p/events` | `?after=<seq>&limit=` | `{ events: ProjectEvent[] }` |
| WS | `/projects/:p/live` | `?key=&after=<seq>` | stream of `ProjectEvent` JSON; replays from `after`; send `ping` → `pong` |
| GET | `/projects/:p/log` | `?ref=&limit=` | `{ commits: Commit[] }` first-parent history |
| GET | `/projects/:p/files/<path>` | `?ref=` | raw file; `ref` is a branch/commit or `task:<id>` |

Event types: `project.created`, `task.created`, `task.ready` (repo, remote, baseOid, forkAttempts),
`task.submitted`, `task.merging`, `task.merged`,
`task.conflict` (files, withTasks), `task.failed` (code, message), `task.abandoned`,
`main.advanced` (from, to, fastForward, changedFiles).

## Layout

```
cloudflare.config.ts  Worker config (bindings, Durable Objects) for the cf CLI
src/index.ts          Worker: routing, auth, errors
src/project.ts        ProjectCoordinator DO (tasks, fork + merge queues, events, WebSocket) + Registry DO
src/git/workspace.ts  In-memory git workspace: fetch, 3-way merge, changed files, push
src/store.ts          Artifacts binding interface + local stand-in client
src/api.ts            Public API types (no runtime deps; import from a UI)
cli/megit.ts          Agent CLI
scripts/              local Artifacts server, dev launcher, demo
test/                 merge engine tests against real git
test/e2e/             the Worker under cf dev against the local stand-in with simulated fork failures
```

```sh
npm test             # merge engine (needs git)
npm run test:e2e     # coordinator end to end: fork throttling, retries, provisioning (~10s)
npm run typecheck
```

## Artifacts beta behaviour worked around

- Concurrent forks of the same repo fail with `INTERNAL_ERROR` (measured: 29/72 at 8 at once, 1/24 at
  3, 0/24 at 2 and 1; forks of different repos at 8 at once: 0/24). A failed fork's name is left
  half-created (`create` says `ALREADY_EXISTS`, `get` says `NOT_FOUND`). The per-project fork queue
  keeps concurrency at 2; any attempt that still fails is retried under a new name, and the
  half-created name is queued for deletion.
- Forks and imports are asynchronous; the coordinator waits until the new repo accepts Git traffic.
- Repo deletion takes seconds, so merged forks are deleted only when the merge queue is idle.
- If project creation dies partway (for example, a deploy resets the Durable Object), creating
  the same project again adopts the existing repo and seeds it if it is empty.

## Not done yet

- Checks before merge (run tests on a Workers Preview / Sandbox and gate the merge on them).
- Artifacts push event subscriptions (auto-submit on push, live "agent pushed" events).
- Per-agent identities and tokens instead of one shared API key.
- Stacked tasks (a task based on another unmerged task) and splitting merges into batches.
- Large repos: the coordinator keeps an in-memory clone, so repos near the 128 MB Worker memory
  limit need ArtifactFS or a Sandbox-backed merge.
