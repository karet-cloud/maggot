<img src="assets/icon.svg" width="64" height="64" alt="">

# maggot

Git hosting for people, and for many agents working on the same codebase at once, built on
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), Workers, Durable Objects and D1.

Sign up, create a public or private repository, and `git push` / `git clone` it over HTTPS at
`https://<host>/<owner>/<repo>.git` with a personal access token, or over SSH at
`git@<host>:<owner>/<repo>.git` with an SSH key. Browse it on the web: code, history,
branches, diffs, archives. On top of that sits the agent layer: an HTTP + WebSocket API, a merge-queue
coordinator, an agent CLI, and a live board. The UI is a plain client of the public API (types in [`src/api.ts`](src/api.ts)),
so anything it shows can be built against directly.

## The model

GitHub's model (shared repo, branches, PRs, human review) breaks down when hundreds of agents
push at once. maggot replaces it with:

- **Task = fork.** Each unit of agent work gets its own Artifacts fork with a repo-scoped write
  token. Agents can never push to the project repo, so they can't race each other or clobber the default branch.
- **Two queues per project, both in the project's Durable Object.** A *fork queue* creates task
  forks at most 2 at a time (Artifacts fails ~40% of forks of one repo when 8 run at once, 0% at 2;
  different repos don't interfere, so the limit is per project). A *merge queue* lands submissions
  strictly one at a time. Both are persisted in SQLite and resumed by the alarm after a restart.
- **Single writer.** One Durable Object per project owns the default branch. Agents *submit*;
  the coordinator merges submissions one at a time (3-way merge with isomorphic-git, in memory)
  and pushes. If someone moved the default branch underneath it, it resyncs and retries.
- **Conflicts are data, not a review thread.** A conflicting task goes to `conflict` with the
  conflicting files *and the already-merged tasks that touched them*. The agent runs
  `maggot sync`, resolves, and resubmits. Non-conflicting work never waits on a human.
- **Advisory path claims.** Tasks can declare paths they intend to touch; creating a task returns
  any active tasks with overlapping claims so agents can coordinate before they collide.
- **Everything is an event.** Every state change is appended to a per-project event log, available
  by polling (`/events?after=`) or live over a WebSocket, with replay on reconnect.

```
 agent ──maggot start──▶ Worker ──▶ ProjectCoordinator (DO, SQLite) ──fork──▶ Artifacts: proj--t123
   │                                        │
   ├── git push (fork token) ──────────────────────────────────────────────▶ Artifacts: proj--t123
   └──maggot submit──▶ Worker ──▶ queue ──alarm──▶ fetch master + fork, merge, push ──▶ Artifacts: proj
                                            └──▶ events ──▶ WebSocket / polling
```

Task lifecycle: `provisioning → open → queued → merging → merged`, with `conflict` / `failed` returning to
`queued` on resubmit, and `abandoned` from any non-terminal state. Merged and abandoned forks are
deleted.

## Web UI

One Worker serves Git at `/<owner>/<repo>.git`, SSH at `/_ssh`, the API at `/api`, and the UI everywhere else.

- **Accounts**: sign up with a username, email and password ([Better Auth](https://better-auth.com), stored
  in D1). Usernames are the first part of every repository URL, so they can't be changed.
- **Passwords**: change it under Settings, or reset it from "Forgot your password?". The emailed link
  works once, for an hour, and signs the account out everywhere (personal access tokens keep working).
  Emails go out through Cloudflare Email Sending when the deploy sets `MAGGOT_EMAIL_FROM` (a sender on a
  domain set up for it; a repository variable in CI). Without it the page says email isn't available, the
  link is logged, and an admin can issue one: `POST /api/admin/password-reset {"username": "…"}` with the
  admin key.
- **Email verification**: when the server can send email (or `MAGGOT_POLICY` sets
  `requireVerifiedEmail`), sign-up sends a link that works for a day, and until it's opened the account
  can't create repositories or push (a banner offers to resend it). Without email, an admin issues the
  link: `POST /api/admin/verify-email {"username": "…"}`.
- **Abuse limits**: sign-ups, sign-ins (per address and per account), reset and verification emails,
  API writes, signed-out API reads, and Git requests are rate limited (429 with `Retry-After`; counters live in a `Limiter`
  Durable Object per address, user or account). Each account has a repository count and storage quota,
  each repository a size limit, and each push a size limit; a push is measured as it streams through and
  counted once the backend reports it accepted, and once a repository is full git prints why. Defaults are in [`src/policy.ts`](src/policy.ts); set
  `MAGGOT_POLICY` (JSON, a repository variable in CI) to change them. The admin key isn't limited.
  Wrong tokens count against the address that sent them, and an address past its budget is refused
  before any lookup. Auth endpoints take JSON only, so every limit sees the fields it keys on.
- **Repositories**: `/<owner>/<repo>`, public (anyone can browse and clone; only the owner pushes) or
  private (only the owner sees it; to anyone else it doesn't exist). Create one empty, with a README, or by
  importing a public Git URL. Settings change the name, description and visibility, archive it, hand it
  to another user, or delete it.
- **Rename and transfer**: a rename keeps the old name as a redirect (the web, the API and git all
  follow it) until another repository takes that name. A transfer is an offer: the new owner gets a
  notification and accepts or declines on `/transfers` within a week, picking another name if they
  already have one like it; accepting checks their quotas, moves the repository (stars, forks, issues
  and webhooks included; the webhooks arrive paused, since they point at the previous owner's
  endpoints) and leaves the old address redirecting.
- **Archive**: an archived repository is read-only. Pushes (HTTPS and SSH), web edits, branch deletes,
  agent tasks and settings changes are refused until it's unarchived; cloning, forking and starring
  still work. It can't be archived while agent tasks are active, so nothing is left half merged.
- **Git over HTTPS**: `git clone https://<host>/<owner>/<repo>.git`. Pushing, and cloning private
  repositories, needs the username plus a **personal access token** as the password (Tokens page, or
  "Add a token" in a repository's Clone / push dialog, which puts it straight into the commands). The
  Worker checks access, then streams Git's smart-HTTP exchange to Artifacts with a short-lived internal
  token, so people only ever hold maggot credentials. Each push emits a `repo.pushed` event.
- **Git over SSH**: `git clone git@<host>:<owner>/<repo>.git` with a key added under Settings → SSH
  keys (Ed25519, ECDSA or RSA). Workers can't listen on port 22, so ssh connects through a
  `ProxyCommand` that carries the SSH byte stream over a WebSocket to `/_ssh`
  ([`/ssh-proxy.mjs`](src/ssh/proxy-script.ts), Node.js 22+; the SSH keys page has the one-time
  `~/.ssh/config` entry). The Worker is the SSH server ([`src/ssh/`](src/ssh)): ML-KEM-768 + X25519
  (post-quantum, what OpenSSH 10 prefers) or curve25519 key exchange, AES-GCM, and an Ed25519 host key
  derived from `MAGGOT_API_KEY` (or `MAGGOT_SSH_HOST_KEY_SEED`), so every isolate presents the same one.
  Fetches use Git protocol v2, whose requests are stateless and map one-to-one onto smart-HTTP requests
  to Artifacts; pushes stream the commands and pack as one receive-pack request. The same permission,
  verification, archive, quota and rate-limit checks apply as over HTTPS.
- **Push an existing project**: an empty repository shows GitHub-style quick-setup commands
  (`git remote add origin <url>`, `git branch -M <branch>`, `git push -u origin <branch>`, plus
  `git push origin --all` and `--tags`). The default branch is chosen at creation (`master` unless you change it).
- **Agents**: the board: tasks in four columns (working, merge queue, needs attention, merged), updated live over
  the project WebSocket. Cards glow as events touch them; tasks still waiting for a fork show "Forking".
- **Activity**: the project's event stream, in plain sentences, next to every page.
- **Task**: status, git details, the agent's commits and the full diff of what it changed (live while
  the fork is open, what landed once merged), conflict details with the tasks it collided with, the
  task's own timeline, Submit / Abandon, and copyable `git clone` / `git pull` commands with fresh tokens.
- **Code**: browse any branch, any task's fork, or any commit. Files are syntax-highlighted; click a line
  number (shift-click for a range) to link to `#L10-L20`, and "Permalink" copies that link pinned to the
  commit. Markdown renders (relative links and images resolve inside the repo), images preview, and
  every file has Raw and Download. "Download" on the tree gets the whole ref as `.zip` or `.tar.gz`.
  "Go to file" (or `t`) fuzzy-finds any path at the current ref, ranking file names, word starts and
  runs first.
- **Stars and forks**: star any repository you can see (counts on every list; a profile's Stars tab
  lists them). Fork copies a repository with every branch and tag into your account (a fork of a
  private repository stays private, and starts out counting its source's size against your quota);
  the fork shows where it came from, and the source lists its forks.
- **Edit in the browser**: Edit, Delete and Add file on any branch you can push to. The Worker builds
  the blob, the trees on the changed path and the commit itself, packs them and pushes them with one
  receive-pack request, so nothing is cloned. Commit to the branch or to a new one; if the branch moved
  since the editor opened, the commit is refused rather than overwriting. Text files up to 1 MB.
- **Search**: the top bar searches repositories by owner, name or description (`/search`, newest or
  most starred). Each repository's "Search code" tab searches its default branch: text files up to
  256 KB are kept in an FTS5 trigram index inside the repository's coordinator, updated from tree diffs
  whenever the branch moves, so any substring of three or more characters matches (shorter ones match
  file names), case-insensitively, with the matching lines. Queries are up to 100 characters and
  limited to 30 a minute; an update too large to apply file by file rebuilds the index instead.
- **Webhooks**: in a repository's settings. Pushes (one delivery per branch moved, from git, the web
  editor or a merge), merges and agent task events are POSTed as JSON with `X-Maggot-Event`,
  `X-Maggot-Delivery` and `X-Maggot-Signature-256: sha256=<HMAC-SHA256 of the body>`. Each hook gets a
  ping when it's added; deliveries are retried five times over about nine hours, kept (last 50) with
  their responses, and can be redelivered. A secret (8+ characters) is required. Pausing a hook drops
  what it had queued; at most 500 deliveries wait per repository. https only, no private addresses, no
  redirects followed. Merges also send a push delivery for the branch they moved, and deleting a
  branch sends one with `deleted: true`.
- **Notifications**: the bell in the top bar. Stars and forks of your repositories, agent tasks that
  merged, failed or hit conflicts, and webhooks that keep failing. Kept in D1, newest 200 per user.
- **README**: the root README renders on the repository's front page (the Code tab), like GitHub.
- **History**: first-parent history of any branch, tag or agent fork (the picker), and a Graph view:
  recent commits across every branch, newest first but never before their children, drawn in lanes
  with branch and tag labels. Each branch's history comes from one log request; merges whose
  branches are gone are filled in from their second parents.
- **Tags and releases**: the Releases tab lists releases (Markdown notes, pre-release flag, source
  `.zip` and `.tar.gz` of the tag) and tags. Tags can be created at any branch from the web (a ref
  update with an empty pack) or pushed with git; a release can create its own tag. Tag names work
  anywhere a branch does when browsing. Tags appearing or going away are push webhooks; releases
  have their own.
- **Branch protection**: rules per branch name or pattern (`*` within a segment, `**` across) in
  repository settings. "Block deletion" and "only the merge queue" are refused from the push's
  commands, before the pack is stored. "Block force pushes" needs the new commits to tell, so the push
  goes through, maggot checks the old head is an ancestor of the new one, and if not puts the branch
  back (a compare-and-swap ref update) and rewrites git's report so the client sees
  `! [remote rejected] … (protected branch: force pushes aren't allowed)`. The same rules apply to
  SSH pushes, web commits and branch deletes; the merge queue is never blocked.
- **Pull requests and code review**: open one from a branch here or from a fork (`/pulls/new`, "Open a
  pull request" on the compare page, or "Contribute back" on a fork). They share numbers, comments,
  labels and notifications with issues. Files changed shows the diff with line comments: hover a line,
  press +, and the comments gather into a review that comments, approves or requests changes (approving
  and requesting changes is for people who can merge, not the author). Merging (write access) makes a
  merge commit or squashes, through the same single merge slot as the agent merge queue, so they never
  race; conflicts are refused with the files named. A branch rule can require an approving review from
  someone with write access, of the commit being merged, and no changes requested; such a branch then
  takes changes only through pull requests (no pushes, web commits or merge queue). A pull request
  from a private fork shows its changes only to people who can read the fork. "Fixes #n" in the
  description or the commits closes those issues.
- **Organizations, teams and collaborators**: an organization is an account repositories belong to
  (`/orgs/new`; its page lists People and Teams, to members only). People join by invitation, accepted
  on `/transfers`. Owners administer every repository; members read them all, and administer the ones
  they create; teams give members read, write or admin access to particular repositories. Any
  repository can also invite collaborators with read, write or admin access. Access is one number per viewer and repository, computed in SQL (`accessLevel` in
  [`src/db.ts`](src/db.ts)) and used everywhere: the web, the API, git over HTTPS and SSH, lists and
  review decisions. Write means pushing and merging; admin means settings, webhooks, collaborators
  and archiving; transferring and deleting stay with the owner (an organization's owners). Live views
  reconnect, and are checked again, whenever access changes. Repositories can be created in, or
  transferred to, an organization (its owners accept), and its notifications go to its owners.
- **Blame and file history**: Blame on any file shows each run of lines with the commit that last
  changed it, shaded by age; History lists the commits that changed the file, paging further back.
  Both walk the first-parent log once, diffing versions with Myers, and are cached per commit.
- **Upload files**: drag files or folders onto Upload (any kind, 10 MB each, 25 MB per commit); they're
  committed like web edits, to the branch or a new one.
- **Issues**: numbered per repository. Anyone signed in (verified) who can read the repository opens
  and comments; authors and the owner edit and close; the owner labels. Markdown with a preview,
  search, label filters, notifications for the owner and everyone in the conversation, `issues`
  webhooks, and the activity feed. A commit landing on the default branch (push or merge queue) that
  says "fixes #12", "closes #12" or "resolves #12" closes it. Posting is limited per user per hour.
- **Wiki**: GitHub's model. Each repository has a wiki in a second Artifacts repo (created with its
  first page), whose Markdown files at the root of master are the pages: "Getting Started" is
  `Getting-Started.md`, `Home.md` is the landing page, and `_Sidebar.md` and `_Footer.md` frame every
  page. `[[Page Name]]` and `[[text|Page Name]]` link pages (missing ones link to creating them). Pages
  are created, edited with a preview, renamed and deleted on the web by anyone with write access (an
  edit from a stale head is refused), with per-page history; or clone and push
  `<origin>/<owner>/<repo>.wiki.git` over HTTPS or SSH, which counts toward the repository's size but
  has no branch rules or Actions. Changes refresh open pages and send `gollum` webhooks. Read-only when
  archived; forks don't copy it; admins can turn it off in Settings (it answers 404, pages are kept).
  Repository names can't end in `.wiki`.
- **Actions**: workflows in `.maggot/workflows/*.yml` in GitHub Actions syntax (`run` steps, `needs`,
  matrices, job `if` and outputs, GitHub's expressions, JavaScript and composite actions from GitHub or the
  repository, and built-in checkout, cache and artifact actions kept in R2), run on pushes, pull
  requests, schedules and by hand. Jobs run in a
  Depot sandbox paid for with the repository's own Depot token (Settings → Actions), or a Cloudflare
  container when the deploy turns that on. The Actions tab lists runs with live logs, cancel, re-run,
  approval for pull requests from people who can't write (forks' runs never get secrets) and Run
  workflow; commits and pull requests show their checks, and a branch rule can require the base
  branch's pull request workflows to pass before merging. Syntax, runners and the API:
  [`docs/actions.md`](docs/actions.md).
- **Commit pages**: every commit opens a commit page with its
  message, author, parents and diff (unified or split).
- **Branches**: the default branch, other branches with ahead/behind counts against it (delete them
  here), and each active task's fork grouped separately. "Compare" shows the commits and diff a branch
  or fork adds since it split off.

It's TanStack Start + React Query + Tailwind, in [`app/`](app/). `app/server.ts` is the Worker entry:
it routes `/api/*` to the Hono API and everything else to TanStack Start.

## Run it locally (no Cloudflare account needed)

```sh
npm install
npm run dev          # local Artifacts stand-in + Worker and UI (`vite dev --mode offline`), on random free ports
```

`npm run dev` prints the URL; open it in a browser and sign in with the key `dev`. The local stack uses `scripts/local-artifacts.ts`, which serves
real Git smart HTTP (via `git http-backend`) with Artifacts-style tokens and mirrors the parts of the
Workers binding maggot uses, so the Worker code path is the same as production. State lives in
`.maggot-local/`. Set `HOST=0.0.0.0 PUBLIC_HOST=<your-tailscale-host>` to expose it to other machines.
To reproduce Artifacts' concurrent-fork failures locally, set `LOCAL_ARTIFACTS_FORK_DELAY_MS=500`
and `LOCAL_ARTIFACTS_FORK_FAIL_ABOVE=2` (forks fail while more than 2 of one repo are in flight).

Then, in another shell:

```sh
export MAGGOT_URL=http://127.0.0.1:<port>      # from the dev output; API key defaults to "dev"
npm run demo                                  # 6 concurrent agents + a deliberate conflict
```

Or drive it by hand:

```sh
node cli/maggot.ts init myproj
node cli/maggot.ts start myproj "Add login" --agent claude-1 --paths src/auth/
cd myproj-t…   # a normal git checkout of the task's fork
# …edit, commit (or not; submit commits for you)…
node cli/maggot.ts submit --wait
node cli/maggot.ts watch myproj               # live event stream
```

## Deploy to Cloudflare

Tooling is the new [`cf` CLI](https://github.com/cloudflare/cf) (beta). The Worker is configured in
[`cloudflare.config.ts`](cloudflare.config.ts) and built with `@cloudflare/vite-plugin`. Deploying
requires a Workers Paid plan, since Artifacts is in open beta there.

CI deploys on its own: `.github/workflows/ci.yml` runs the typecheck and both test suites on every
pull request, and on every push to `master` runs them again and then `cf deploy` to https://maggot.karet.cloud. The custom domain is declared in
`cloudflare.config.ts`, and CI checks it before seeding the demo. It
needs a `CLOUDFLARE_API_TOKEN` repository secret (a dashboard token from the "Edit Cloudflare
Workers" template, plus Artifacts edit and D1 edit), a stable `MAGGOT_API_KEY` secret, and a
`CLOUDFLARE_ACCOUNT_ID` repository variable. Secrets can be scoped to the GitHub `production`
environment. CI passes the admin key with `--secrets-file` so a new or renamed Worker can deploy
without a previous version to inherit it from. The temporary secret file is removed when the
step exits. Set the key once and keep it stable: changing it also changes the derived session
secret and SSH host key.

For a brand-new self-hosted deployment only, generate the initial key outside the repo and store
it in GitHub before running CI. Existing deployments must reuse their current key.

```sh
(
  key_file=$(mktemp)
  trap 'rm -f "$key_file"' EXIT
  openssl rand -hex 24 > "$key_file"
  gh secret set MAGGOT_API_KEY --env production < "$key_file"
)
```

To store the key from an existing deployment without printing it, use a file outside the repo:

```sh
gh secret set MAGGOT_API_KEY --env production < /path/to/admin-key.txt
```
The first deploy creates the `maggot` D1 database; tables are created by the Worker on first use, so
there's no migration step. Better Auth's secret is derived from `MAGGOT_API_KEY` unless a
`BETTER_AUTH_SECRET` secret is set.

Point the CLI at it with `MAGGOT_URL=https://maggot.karet.cloud` and the same `MAGGOT_API_KEY`
configured in the GitHub `production` environment. GitHub secrets cannot be read back; CLI access
requires an authorized copy of that key, kept outside the repo. The "maggot" Artifacts namespace
is created on first use. A brand-new
`workers.dev` route can return error 1042 for a few seconds after the first deploy.

`cloudflare.config.ts` is a function of the Vite mode: `offline` (used by `npm run dev`) binds the
local stand-in, and any other mode binds the real Artifacts namespace. Vite reserves the mode name
`local`, which is why the local mode is called `offline`. Because the project is TanStack Start,
`cf dev` hands off to `vite dev` and won't pass `--mode` through, so the dev script runs Vite itself;
`cf build` and `cf deploy` work as usual. Types are generated from the config with
`cf workers types` into `.cloudflare/types/`.

## API

All routes are under `/api`. Callers are a signed-in user (Better Auth session cookie; writes must come
from the same origin), a user's personal access token (`Authorization: Bearer maggot_pat_…`, or `?key=` for
WebSockets), the admin key (`Bearer <MAGGOT_API_KEY>`), or anonymous.

User repositories live at `/repos/:owner/:repo`, and every per-repository route below works there with
the same suffix (`/repos/ada/hello/log`, `/repos/ada/hello/tasks`, …). Reads need read access (public, or
the owner); anything else needs the owner. A private repository someone can't read is a 404. The
`/projects/:p` routes address repositories by internal name and need the admin key.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| POST | `/auth/sign-up/email` | `{ email, password, name, username }` | Better Auth; sets the session cookie |
| POST | `/auth/sign-in/username` | `{ username, password }` | Better Auth; sets the session cookie |
| POST | `/auth/sign-out` | | clears it |
| POST | `/auth/request-password-reset` | `{ email, redirectTo: "/reset-password" }` | always the same answer; emails a one-hour link if the account exists |
| POST | `/auth/reset-password` | `{ token, newPassword }` | sets the password, signs out every session |
| POST | `/auth/change-password` | `{ currentPassword, newPassword, revokeOtherSessions? }` | signed in |
| POST | `/auth/send-verification-email` | `{ email, callbackURL: "/verify-email" }` | resends the verification link |
| GET | `/config` | | `{ emailDelivery, verificationRequired }` |
| POST | `/admin/password-reset` | `{ username }` or `{ email }` | `{ url }`: a reset link to hand over (admin key) |
| POST | `/admin/verify-email` | `{ username }` or `{ email }` | `{ url }`: a verification link (admin key; 409 if already verified) |
| GET | `/me` | | `{ user: Viewer \| null }`, with `emailVerified` and quota `usage` |
| GET / POST / DELETE | `/tokens`, `/tokens/:id` | `{ name }` | list, create (`{ token, info }`, plaintext once), revoke personal access tokens |
| GET | `/repos` | `?owner=&starredBy=&q=&sort=stars&limit=` | `{ repos: RepoInfo[] }`: public ones, plus your own private ones |
| POST | `/repos` | `{ name, description?, visibility?, defaultBranch?, importUrl?, importDepth?, readme? }` | `{ repo, project }` (signed-in users) |
| GET | `/repos/:owner/:repo` | | `{ project, repo }` |
| PATCH | `/repos/:owner/:repo` | `{ visibility?, description?, name?, archived? }` | `{ repo }` (owner); a new `name` leaves the old one redirecting |
| GET / POST / DELETE | `/repos/:owner/:repo/transfer` | `{ to }` | the pending offer; offer the repository to user `to`; cancel the offer (owner) |
| GET | `/transfers` | | `{ transfers: RepoTransfer[] }`: offers made to you |
| POST | `/transfers/:id/accept`, `/transfers/:id/decline` | `{ name? }` | take the repository (under `name` if given) → `{ repo }`, or turn it down |
| POST | `/repos/:owner/:repo/storage/recount` | `{}` | recount code and wiki storage, enforce quotas and refresh refs (instance admin key only) |
| GET | `/repos/:owner/:repo/paths` | `?ref=` | `FileList`: every file path at `ref` (up to 20,000), for the file finder |
| GET | `/repos/:owner/:repo/history`, `/blame` | `?path=&ref=` (`&from=` to page history) | `FileHistory`, `Blame` |
| GET / POST | `/repos/:owner/:repo/pulls` | `?state=`; `{ title, body?, base, head, headRepo? }` | `PullList`; open one (signed in, read access; `headRepo` is a fork, `owner/name`) |
| GET | `/repos/:owner/:repo/pulls/compare` | `?base=&head=&headRepo=` | what a pull request would bring |
| GET | `/repos/:owner/:repo/pulls/:n`, `…/files` | | the pull request, comments, reviews and line comments; its commits and diff |
| POST | `/repos/:owner/:repo/pulls/:n/reviews` | `{ state: "commented" \| "approved" \| "changes_requested", body?, commit?, comments: [{ path, line, side, body }] }` | a review |
| POST | `/repos/:owner/:repo/pulls/:n/merge` | `{ method: "merge" \| "squash" }` | merges it (write access) → `{ pull, commit }`; 409 on conflicts |
| GET / PUT / DELETE | `/repos/:owner/:repo/collaborators`, `…/:username` | `{ permission }` | collaborators (admins) |
| GET / POST | `/orgs`, `/orgs/:org` | `{ name, displayName? }` | your organizations; create one; one organization (members and teams for members) |
| POST / PATCH / DELETE | `/orgs/:org/members`, `…/:username` | `{ username, role }`, `{ role }` | invite, change role, remove or leave (owners; members can leave) |
| POST / DELETE | `/orgs/:org/teams`, `…/:team`, `…/members/:username` (PUT), `…/repos/:repo` (PUT `{ permission }`) | | teams (owners) |
| GET / POST | `/invitations`, `/invitations/:kind/:id/accept`, `…/decline` | | invitations to organizations (`org`) and repositories (`repo`) |
| GET | `/ssh` | | `SshInfo`: the host key, its fingerprint and the WebSocket URL |
| GET / POST / DELETE | `/repos/:owner/:repo/tags`, `…/tags/<name>` | `{ name, target? }` | list tags (with their commits); create one at a branch, tag or commit; delete one (owner) |
| GET / POST | `/repos/:owner/:repo/releases` | `{ tag, target?, name?, notes?, prerelease? }` | list releases; publish one, creating the tag at `target` if needed (owner) |
| PATCH / DELETE | `/repos/:owner/:repo/releases/:id` | `{ name?, notes?, prerelease? }`, `?deleteTag` | edit or delete a release (owner) |
| GET | `/repos/:owner/:repo/graph` | `?limit=` (≤ 400) | `Graph`: recent commits across every branch, children before parents, with branch and tag labels |
| GET / PUT / DELETE | `/repos/:owner/:repo/protection` | `{ pattern, blockDeletions?, blockForcePushes?, requireMergeQueue? }`, `?pattern=` | branch rules (anyone who can read sees them; the owner sets them) |
| GET / POST | `/repos/:owner/:repo/issues` | `?state=open\|closed\|all&q=&label=`; `{ title, body?, labels? }` | `IssueList` with open and closed counts; open an issue (signed in) |
| GET / PATCH | `/repos/:owner/:repo/issues/:n` | `{ title?, body?, state?, labels? }` | the issue and its comments; edit, close or reopen (author or owner; labels: owner) |
| POST / PATCH / DELETE | `/repos/:owner/:repo/issues/:n/comments`, `…/comments/:id` | `{ body }` | comment (signed in); edit (author); delete (author or owner) |
| GET | `/repos/:owner/:repo/wiki` | | `WikiIndex`: the wiki's head, its pages (Home first), sidebar and footer |
| GET | `/repos/:owner/:repo/wiki/pages/:page`, `…/history` | `?from=` (history) | `{ page }` with its Markdown and last edit; the commits that changed it |
| POST | `/repos/:owner/:repo/wiki/pages` | `{ title, content, message? }` | creates a page (write access) → `{ page, commit }` |
| PATCH / DELETE | `/repos/:owner/:repo/wiki/pages/:page` | `{ title?, content?, message?, baseCommit? }` | edits or renames a page, or deletes it (write access); a stale `baseCommit` is refused |
| GET | `/repos/:owner/:repo/wiki/raw` | `?path=` | a file from the wiki (images), sandboxed |
| GET / POST / DELETE | `/ssh/keys`, `/ssh/keys/:id` | `{ key, name? }` | list, add (an authorized_keys line) or remove your SSH keys |
| DELETE | `/repos/:owner/:repo` | | deletes it, its agent forks and state (owner) |
| PUT / DELETE | `/repos/:owner/:repo/star` | | star or unstar (signed in, read access) → `{ starred, stars }` |
| GET / POST | `/repos/:owner/:repo/forks` | `{ name? }` | list public forks; fork into your account (read access) |
| GET | `/repos/:owner/:repo/search` | `?q=` | `CodeSearch`: matching files and lines on the default branch (`indexing` while it catches up) |
| GET / POST | `/repos/:owner/:repo/hooks` | `{ url, secret?, events: ["push" \| "merge" \| "task"] }` | list or add webhooks (owner) |
| PATCH / DELETE | `/repos/:owner/:repo/hooks/:id` | `{ url?, secret?, events?, active? }` | change or remove one (owner) |
| GET | `/repos/:owner/:repo/hooks/:id/deliveries` | | `{ deliveries }`, newest first, with payloads and responses |
| POST | `/repos/:owner/:repo/hooks/:id/ping`, `…/deliveries/:d/redeliver` | | queue a test or a repeat delivery |
| GET | `/notifications` | `?unread` | `{ notifications, unread }` (signed in) |
| POST | `/notifications/read` | `{ ids? }` | marks those, or all, read |
| POST | `/repos/:owner/:repo/contents` | `{ branch?, baseCommit?, newBranch?, message, files: [{ path, content \| null }] }` | commits up to 20 text files (null deletes); 409 if `branch` moved past `baseCommit` |

Admin and per-repository routes: Errors look like `{ "error": { "code": "NOT_FOUND", "message": "…" } }`. Response
shapes are the types in [`src/api.ts`](src/api.ts).

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/projects` | | `{ projects: Project[] }` |
| POST | `/projects` | `{ name, description?, defaultBranch? (default `master`), importUrl?, importBranch?, importDepth?, readme? }` | `{ project }`; `readme: false` leaves the repo empty for a first `git push` |
| GET | `/projects/:p` | | `{ project: Project }` (head, per-status counts, queue length) |
| DELETE | `/projects/:p` | | deletes repo, forks, and state |
| GET | `/projects/:p/tasks` | `?status=` | `{ tasks: Task[] }` newest first |
| POST | `/projects/:p/tasks` | `{ title, agent?, paths? }`, `?wait=<s>` (default/max 25) | `TaskAccess`: 201 with fork + base credentials once the fork exists; 202 with `fork: null` while still `provisioning` |
| GET | `/projects/:p/tasks/:id` | | `{ task: Task }` |
| POST | `/projects/:p/tasks/:id/access` | | `TaskAccess` with fresh tokens (`fork: null` while provisioning) |
| POST | `/projects/:p/tasks/:id/submit` | | `{ task }`, enqueues for merge (202) |
| POST | `/projects/:p/tasks/:id/abandon` | | `{ task }`, deletes the fork |
| POST | `/projects/:p/credentials` | `{ scope?, ttlSeconds? }` (`write`, 30 days default; TTL 1–2,592,000 seconds) | `GitCredentials` for the project repo itself (admin key only: direct pushes skip the proxy) |
| GET | `/projects/:p/queue` | | `{ queue: QueueEntry[] }` |
| GET | `/projects/:p/events` | `?after=<seq>&limit=` | `{ events: ProjectEvent[] }`: from `after` forward, or the newest `limit` without it |
| WS | `/projects/:p/live` | `?key=&after=<seq>` | stream of `ProjectEvent` JSON; replays from `after`; send `ping` → `pong` |
| GET | `/projects/:p/log` | `?ref=&limit=` | `{ commits: Commit[] }` first-parent history |
| GET | `/projects/:p/tree` | `?ref=&path=` | `{ tree: Tree }` directory listing, same refs as files |
| GET | `/projects/:p/files/<path>` | `?ref=` | raw file; `ref` is a branch/commit or `task:<id>` |
| GET | `/projects/:p/raw` | `?path=&ref=&download` | the file's bytes with its content type (sandboxed, `nosniff`); `download` forces a download |
| GET | `/projects/:p/archive` | `?ref=&format=zip\|tar.gz` | the whole tree at `ref`, streamed |
| GET | `/projects/:p/commits/:hash` | `?ref=` (`task:<id>` for fork commits) | `{ commit: CommitDetail, diff: Diff }` against the first parent |
| GET | `/projects/:p/compare` | `?base=&head=` | `{ comparison: Comparison }`: commits on `head` since its merge base with `base`, and their diff |
| GET | `/projects/:p/tasks/:id/changes` | | `{ comparison }` for the task: its fork against the default branch, or what it merged |
| GET | `/projects/:p/branches` | `?counts=0` skips ahead/behind | `Branches`: project branches and active task forks |
| DELETE | `/projects/:p/branches/<name>` | | deletes a branch (not the default one) |

Event types: `project.created`, `repo.pushed` (branch, from, to, moved, refs: every branch it moved), `task.created`, `task.ready` (repo, remote, baseOid, forkAttempts),
`task.submitted`, `task.merging`, `task.merged`,
`task.conflict` (files, withTasks), `task.failed` (code, message), `task.abandoned`,
`main.advanced` (from, to, fastForward, changedFiles).

## QA against real repositories

`npm run qa:github` mirrors six small public GitHub repositories into a running maggot, the way someone
moving over would: `git push --all` and `--tags` with a personal access token (one goes through
"Import from URL" instead). Then it checks:

- every branch and tag against GitHub's
- a clone back from maggot, which must pass `git fsck` and keep the full history
- that anonymous clones work for public repositories and are refused for private ones
- that the API agrees with git: head, history, root tree, branches, README, a raw file, and a zip
  archive with every file
- that a follow-up push lands

It signs up a throwaway user unless `MAGGOT_USER` and `MAGGOT_TOKEN` are set, deletes what it creates
(`KEEP=1` keeps it), and works against production with `MAGGOT_URL`.

## Layout

```
cloudflare.config.ts  Worker config (bindings, Durable Objects) for the cf CLI
app/server.ts         Worker entry: git smart HTTP, /api/* to the API, everything else to the UI
app/routes/           UI pages (TanStack Start file routes); app/lib/live.ts streams project events
src/index.ts          API: routing, permissions, errors
src/auth.ts           Better Auth, personal access tokens, who-may-do-what
src/policy.ts         Rate limits (Limiter DO), quotas, email verification policy
src/db.ts             D1 schema (created on first use), repositories, tokens
src/git-http.ts       git clone/fetch/push at /<owner>/<repo>.git, proxied to Artifacts
src/ssh/              SSH server over a WebSocket (transport, keys, git bridge) and the client proxy script
src/project.ts        ProjectCoordinator DO (tasks, fork + merge queues, events, WebSocket) + Registry DO
src/git/workspace.ts  In-memory git workspace: fetch, 3-way merge, changed files, push
src/git/diff.ts       Tree diffs and merge-base walks over the Artifacts object reads
src/git/protocol.ts   Branch listing, deletion, pushes and repo measuring over Git smart HTTP
src/git/commit.ts     Commits from the web editor: objects, trees, pack, push
src/search.ts         Code search index (FTS5 trigram) kept in each repository's coordinator
src/ci/               Actions: workflow parsing, runs and logs in the coordinator, job DOs, Cloudflare and Depot sandboxes
src/hooks.ts          Webhook subscriptions, signed deliveries and retries, in the coordinator
src/wiki.ts           Wikis: the second Artifacts repo per repository, pages, web edits and pushes
src/wiki-pages.ts     Wiki page names, files and [[links]] (shared with the UI)
src/archive.ts        Streaming .tar.gz / .zip of a tree
src/protection.ts     Branch rules: push command checks, holding refs, ancestry, git report rewriting
src/branch-rules.ts   Which rules apply to a branch (shared with the UI)
src/orgs.ts           Organizations, teams, collaborators and invitations
src/git/history.ts    File history and blame
src/store.ts          Artifacts binding interface + local stand-in client
src/api.ts            Public API types (no runtime deps; import from a UI)
cli/maggot.ts          Agent CLI
scripts/              local Artifacts server, dev launcher, demo
test/                 merge engine tests against real git
docs/actions.md       Actions workflow syntax, actions, caches and artifacts, runners, Depot, secrets, API
.maggot/workflows/     This repository's own maggot Actions workflow
test/e2e/             the Worker under vite dev against the local stand-in with simulated fork failures
```

```sh
npm test             # merge engine (needs git)
npm run test:e2e     # end to end: accounts, git push/clone permissions, fork throttling, retries (~25s)
npm run qa:github    # mirrors small public GitHub repos into a running maggot and checks everything (see below)
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

- Password reset and verification emails need a sending domain (see Passwords above).
- Repository sizes are the bytes of accepted pushes (packs as sent, so force pushes add up), not what
  Artifacts stores after packing, and
  imports are measured once, as the pack a full clone downloads. Agent task forks get Artifacts
  credentials directly, so what lands through the merge queue isn't counted (task creation still
  needs a verified email and a repository under its size limit).
- Live sockets are checked when they connect; a visibility change disconnects them all, but revoking
  a token doesn't close a socket it opened.
- Git LFS. SSH needs the ProxyCommand: Workers can't take raw TCP on port 22 (Spectrum could, on
  Enterprise plans), and SSH fetches need Git protocol v2 (git 2.26 and newer use it by default).
- Pull request niceties: suggested changes, threaded replies to line comments, and draft pull requests.
- Actions: no services, containers, environments, concurrency, reusable workflows or Docker actions, and
  no status API for external CI to report into (see [`docs/actions.md`](docs/actions.md)).
- Artifacts push event subscriptions (auto-submit when an agent pushes to its fork). Pushes through maggot's
  Git URL already emit `repo.pushed`.
- Per-agent identities: agents act as their owner's personal access token (or the admin key), not as
  accounts of their own.
- Stacked tasks (a task based on another unmerged task) and splitting merges into batches.
- Large repos: the coordinator keeps an in-memory clone, so repos near the 128 MB Worker memory
  limit need ArtifactFS or a Sandbox-backed merge.

The production landing page links its cached Linux root listing to the public `maggot-mirror/linux` repository. CI seeds it with a shallow Git clone and push from
`torvalds/linux` on `master` (depth 1) and the full source tree. Blob batches use temporary tree tags
to keep each upload small; the final master commit retains its upstream hash and metadata, and
staging tags are removed. Interrupted seeds clean up their staging tags on reruns. The Artifacts URL import service
currently fails for Linux. CI uses a five-minute storage Git token through the admin-only
credentials endpoint, then calls `/api/repos/:owner/:repo/storage/recount` to restore quota
accounting and refresh repository views. This avoids large uploads through the Worker proxy. Set a stable
`MAGGOT_MIRROR_PASSWORD` production environment secret for the mirror service account. Existing
mirrors are left unchanged; this is a demo snapshot, not continuous upstream synchronization.
The repository creation API accepts optional `importDepth` (1–10,000) for shallow imports;
omitting it keeps the existing full-history import behavior.
