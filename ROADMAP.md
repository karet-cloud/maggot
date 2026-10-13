# Roadmap: Git hosting features

Git-platform features megit doesn't have yet, compared with GitHub. AI assistant features are out of scope.
"Have" means already shipped. Effort: S is under a day, M is 1–3 days, L is more than that.

## What megit has today

- User accounts (Better Auth: username, email, password), password change and reset, and personal access tokens.
- Repositories at `/<owner>/<repo>`, public or private, created empty, with a README, or by importing a public Git URL.
- `git clone` / `fetch` / `push` at `https://<host>/<owner>/<repo>.git`, proxied to Artifacts after a permission check. Tested against six public GitHub repositories (`npm run qa:github`).
- Tasks with agent branches, a merge queue, automatic merges, and a "needs attention" state for conflicts.
- A code browser (file tree and file view, with a branch/commit picker), commit history, a live activity feed, and the board.
- Everything in Tier 1: diffs for commits, tasks and branch comparisons; commit pages; README rendering; a branches page; syntax highlighting with line links; raw files and archives.
- CI that deploys to production on pushes to `master`.

## Tier 1: needed to feel like a Git host (done)

| # | Feature | Notes | Effort |
|---|---------|-------|--------|
| 1 | **Diffs** for commits and tasks | Unified and split views, with a stats summary (+/-) per file. Compute them in the Worker from the two trees; most blobs are small. Also shows "what the agent changed" on a task page. | M |
| 2 | **Commit detail page** | Message, author, parents, a list of changed files, then the diff. Link to it from history and the activity feed. | S (after 1) |
| 3 | **README rendering** on the project home and code view | Markdown, sanitized, with relative links and images resolved against the repo. | S |
| 4 | **Branches page** | List branches with ahead/behind counts against the default branch and last commit, plus delete. Agent branches are grouped separately. | S |
| 5 | **Syntax highlighting and line links** in the file view | Shiki or similar. `#L10-L20` anchors and a copy-permalink button. | S |
| 6 | **Raw file and download archive** | `/raw/:ref/:path` and a `.tar.gz` or `.zip` of a ref. | S |

## Tier 2: collaboration (what GitHub is actually used for)

| # | Feature | Notes | Effort |
|---|---------|-------|--------|
| 7 | **Pull requests for humans** | Open a PR from any branch, show its diff, and merge it through the same merge queue the agents use. Reuses the task and queue machinery. | M |
| 8 | **Code review** | Inline line comments on diffs, approve or request changes, and resolvable threads. | M |
| 9 | **Compare view** | `base...head` for any two refs: commits plus diff. Becomes the "open PR" entry point. | S (after 1) |
| 10 | **Branch protection** | Block direct pushes to the default branch, require the queue or review, and require checks to pass. Enforced in the coordinator. | M |
| 11 | **Issues** | Title, body, labels, open/closed, and a "fixes #n" link that closes the issue on merge. Can turn into an agent task in one click. | M |
| 12 | **User accounts and permissions** (partly done: accounts, tokens, owner-only repos; password reset and change; email verification, rate limits and quotas; next: collaborators, orgs) | Better Auth with GitHub or email login. Per-project roles: read, write, admin. Per-user personal access tokens instead of one shared key. | L |
| 13 | **Tags and releases** | List tags. Create a release with notes and a downloadable archive. | S–M |

## Tier 3: Git depth

| # | Feature | Notes | Effort |
|---|---------|-------|--------|
| 14 | **Blame** | Per-line last commit. Expensive; compute lazily and cache in the DO or KV. | M |
| 15 | **File history** | Commits that touched a path. | S–M |
| 16 | **Code search** | Filename "go to file" first (S), then full-text search over the default branch, indexed on push (L). | S / L |
| 17 | **Commit graph** | A branch and merge visualization in history. Useful to show agent merges. | M |
| 18 | **Edit in browser** | Edit a file, commit it to a branch, and optionally open a PR. | M |
| 19 | **Forks** | Artifacts fork into another project, then PR back across forks. | M |
| 20 | **Signed commit badges** | Verify GPG/SSH signatures and show "Verified". | M |
| 21 | **Git LFS** | Store large files in R2 behind the LFS batch API. | L |
| 22 | **SSH push/clone** | Depends on what Artifacts exposes; HTTPS-only may be fine. | ? |

## Tier 4: platform and integrations

| # | Feature | Notes | Effort |
|---|---------|-------|--------|
| 23 | **Webhooks** | Push, task, merge, and PR events posted to a URL, HMAC-signed. The event log already exists. | S–M |
| 24 | **Checks / CI status** | A commit status API (`pending/success/failure`) that external CI can report into, shown on commits, tasks and PRs, and able to gate the queue. Pairs with "checks before merge" in the README. | M |
| 25 | **Built-in CI runner** | Run tests in Cloudflare Sandbox or Containers per task or PR. | L |
| 26 | **Notifications** | An in-app inbox plus email for review requests, mentions, and failed merges. | M |
| 27 | **Organizations and teams** | Group projects and share permissions. | L |
| 28 | **Mirror from or to GitHub** | Keep a GitHub repo in sync both ways. Useful for adoption. | M |
| 29 | **Audit log** | Who pushed, merged, or changed settings. Mostly the existing event log plus users. | S (after 12) |
| 30 | **Project settings page** | Rename, default branch, visibility, delete, and token management. | S |

## Suggested order

1. **Done:** Tier 1, plus the compare view (9).
2. **Next:** 7 → 8 → 24 → 10. Human PRs, reviews, and checks reuse the merge queue, which is megit's distinguishing piece.
3. **Then:** 12 (accounts) unlocks 11, 13, 26, 27 and 29.

## Review follow-ups

From the deep code review of 2026-10-12. Already fixed:
- `/files` can't run as a page.
- Diff and archive memory and CPU limits, with archive cancellation handled.
- Diff content can no longer be mistaken for the "binary"/"large" markers.
- Branch deletion requires Git's explicit `ok`.
- Event and log limits are validated.
- Expiring sessions, constant-time key checks, and Origin checks for cookie requests.
- Copyable commands are shell-quoted.
- The CLI redacts tokens from errors.
- New projects default to `master`.

Still open:
- **Merge memory**: bound how much the in-memory workspace fetches, and refuse repos that are too large instead of running out of memory.
- **Project deletion**: fence it against new tasks and in-flight forks, and keep failed repo deletions as durable cleanup jobs that retry.
- **Submit pins the commit**: record the fork head at submit and merge exactly that, and persist merge provenance so recovery after a restart records the right commit.
- **True merge bases**: use full DAG reachability for compare and ahead counts, not only the default branch's first parents.
- **Live replay**: detect gaps and resync completely after more than 1,000 missed events, and reset the event cursor per project.
- **Request budgets**: one shared cap on Artifacts calls when listing branches, and size limits for file and Markdown previews.
- **Fork permalinks**: carry repository and commit separately, so links to fork commits stay pinned.
- **Local Artifacts stand-in**: authenticate its control API, or bind it to loopback, and validate names before touching disk.

From the three-model review of 2026-10-13 (GPT-6.1-Sol, GPT-6-Astra, Claude Fable 5.1), still open:
- **Rate limiting at the edge**: each limited request is a round trip to a `Limiter` Durable Object; the
  Workers Rate Limiting binding would be colo-local.
- **Real repository sizes**: quotas count accepted push bytes (force pushes add up) and agent merges
  aren't counted; reconcile with the stored size once Artifacts exposes it.
- **Agent fork credentials**: tasks hand out Artifacts tokens directly; proxy them through megit so the
  push limits and token revocation apply.
- **Live sockets and revoked tokens**: a socket opened with a token stays open after the token is revoked.
- **UI nits**: sign-in doesn't return to the page you came from; compare allows head = base; a profile for
  a user who doesn't exist says they have no repositories.
