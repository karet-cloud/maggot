# megit Actions

megit runs workflows from `.megit/workflows/*.yml` (or `.yaml`) in the repository. The syntax is a
subset of GitHub Actions: jobs of shell steps, ordered with `needs`, on a fresh Linux machine with the
commit already checked out. Anything outside the subset makes the workflow fail to load with a message
naming the key. megit never silently skips it. The Actions tab lists each workflow file and why it can't run.

An example that runs this repository's own tests is in [`.megit/workflows/ci.yml`](../.megit/workflows/ci.yml).

```yaml
name: CI
on:
  push:
    branches: [master, "release/**"]
  pull_request:
  workflow_dispatch:

env:
  NODE_ENV: test

jobs:
  test:
    runs-on: ubuntu-latest      # the repository's default runner
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4 # built in, so a no-op
      - run: npm ci
      - name: Test
        run: npm test
      - name: Upload coverage
        if: ${{ success() }}
        run: ./scripts/upload-coverage.sh
        env:
          TOKEN: ${{ secrets.COVERAGE_TOKEN }}
  build:
    needs: test
    runs-on: depot-8            # an 8 vCPU Depot sandbox
    steps:
      - run: npm ci && npm run build
```

## Supported syntax

| Key | What megit accepts |
| --- | --- |
| `on` | `push` with `branches` or `branches-ignore` (`*`, `**`, `?`, and `!` to exclude); `pull_request` with those plus `types` (`opened`, `synchronize`, `reopened`; all three by default); `workflow_dispatch` without inputs. A string or list of event names also works. |
| `name`, `env` | The workflow's name (defaults to the file name) and environment for every job. |
| `defaults.run` | `shell` and `working-directory` for every `run` step, at workflow or job level. |
| `permissions` | Only read access: `read-all`, or scopes set to `read` or `none`. Jobs' checkout token is read-only anyway. |
| `jobs.<id>` | `name`, `runs-on`, `needs` (string or list; cycles and unknown names are errors), `timeout-minutes` (1–360, default 30), `env`, `defaults`, `permissions`, `steps`. Up to 20 jobs per workflow. |
| `runs-on` | `cloudflare` (or `megit`), `depot` (2 vCPUs), `depot-<n>` or `depot-ubuntu-<version>-<n>` with n = 2, 4, 8, 16, 32 or 64, or `ubuntu-latest`, `ubuntu-<version>`, `linux` and `default` for the repository's default runner. x64 only: Arm labels are refused. |
| `steps[]` | `run` (a script), `name`, `shell` (`bash`, the default, or `sh`), `working-directory` (inside the repository), `env`, `if`, `continue-on-error`, `id`, `timeout-minutes` (no longer than the job's). Up to 50 steps per job. |
| `uses` | Only `actions/checkout`, with `fetch-depth` (default 50; 0 for all history), `clean: true` and `persist-credentials: false`. The commit is always checked out before the first step, so the step only sets the depth. Other actions aren't supported yet. |
| `if` (steps) | `success()`, `always()`, `failure()`, `cancelled()` or `!cancelled()`, with or without `${{ }}`. |
| `${{ … }}` | In `env` values and `run` scripts: `secrets.NAME` (empty if unset), `env.NAME`, `runner.os` (`Linux`), `runner.arch` (`X64`), and `github.sha`, `ref`, `ref_name`, `ref_type`, `head_ref`, `base_ref`, `repository`, `repository_owner`, `server_url`, `event_name`, `run_id`, `run_number`, `run_attempt`, `actor`, `triggering_actor`, `workflow`, `job`, `workspace`. Any other expression is an error, reported when the workflow is listed. |

Jobs see the same values as environment variables (`GITHUB_SHA`, `GITHUB_REF_NAME`, …), plus `CI=true`,
`MEGIT_ACTIONS=true`, `GITHUB_ACTIONS=true`, `RUNNER_OS` and `RUNNER_ARCH`. The workspace is `/workspace`
and jobs have Internet access.

Not supported yet: `matrix`/`strategy`, `services`, `container`, job-level `if`, job `outputs`,
`concurrency`, `run-name`, artifacts and caches, reusable workflows, `schedule`, `workflow_dispatch`
inputs, and other `uses:` actions.

## When workflows run

- **push**: each branch a push (HTTPS, SSH, web edit or merge) moves, using the workflow files at the new commit.
- **pull_request**: when a pull request is opened or reopened, and on new pushes to its head
  (`synchronize`), filtered by the workflow's `branches` (matched against the base branch) and
  `types`. The head commit's workflow files are used, as on GitHub. A workflow the base branch has
  (see [Requiring Actions to pass](#requiring-actions-to-pass)) that the head lacks runs from the base's
  file, on the head's code. Events are recorded and retried until their runs start, and acted on only
  while their commit is still the pull request's head, so a late one can't touch a newer head's runs.
- **workflow_dispatch**: Run workflow on the Actions tab (write access), on any branch.

A pull request's runs wait as **Waiting for approval** unless whoever caused them can write to the
repository: one opened by a reader (from a fork or from a branch here) and new pushes to a fork's
branch wait. Someone who can merge reads the workflow and approves it, from the run page or the checks
box on the pull request. Runs from forks never get the repository's secrets; an approved run for a
reader's pull request from a branch here does (its code was pushed by someone who can write). At most
100 runs wait at once per repository (20 per pull request author); past that, the pull request's required
runs show as missing, and **Start missing checks** creates them, still waiting for approval. Runs nobody
approves within 7 days are cancelled. Closing a pull request cancels its waiting and running runs
(merging cancels the waiting ones); reopening it starts them again (waiting, if they'd wait).

Cancel stops a queued or running run. Re-run starts a new run of the same workflow file on the same
commit, keeping the original trigger. A job's conclusion is success, failure, cancelled or skipped
(skipped: a job it `needs` didn't succeed); a run's is failure if any job failed, else cancelled if any
was cancelled, else success.

The 300 newest finished runs that someone who can write started or approved are kept per repository,
with up to 5 MB of log per job and 512 MB per repository (the oldest logs go first). Runs on an open
pull request's head commit are kept whatever their age. Finished runs nobody approved (a reader's or
fork's broken workflow files, expired or cancelled waiting runs) are kept apart, at most 100 per
repository and 20 per author, so they can't push other runs out.

## Runners

Settings → Actions picks the **default runner**, which handles `ubuntu-latest` and jobs with no `runs-on`.
A job can also name a runner.

- **Cloudflare container**: a Cloudflare Container attached to each job. It's off unless the server's
  deploy sets `MEGIT_CI_CLOUDFLARE=on` (and `MEGIT_CI_DOCKERFILE=1` to build `container/ci/Dockerfile`
  rather than use Cloudflare's managed Debian image). Without it, Settings says it isn't available, Depot
  is the default runner, and `runs-on: cloudflare` jobs fail saying so.
- **Depot sandbox**: a [Depot sandbox](https://depot.dev/docs/api/sandbox-sdk-reference) billed to
  your own Depot organization. Connect it as described below.

Blacksmith isn't supported, and `runs-on: blacksmith-*` is refused with that reason. Its
[documentation](https://docs.blacksmith.sh/introduction/quickstart) describes it only as a runner for
GitHub Actions jobs in GitHub organizations, so it can't take megit's jobs.

### Connecting Depot

1. In Depot, open **Organization Settings**, add a description under **API Tokens** and click **Create
   token** ([Depot API authentication](https://depot.dev/docs/api/authentication)). A user token from
   **Settings → Personal settings** works too ([Depot accounts](https://depot.dev/docs/account)).
2. If it's an app or service token, or a user token in more than one organization, you also need the
   organization ID ([sandbox SDK reference](https://depot.dev/docs/api/sandbox-sdk-reference)).
   `depot org show` prints the ID of the CLI's current organization; `depot org switch` changes which
   organization that is ([CLI reference](https://depot.dev/docs/cli/reference/overview)). A user token
   in a single organization doesn't need it.
3. In megit, go to **Settings → Actions → Depot sandboxes** and paste the token (and the ID, if needed). Then click
   **Connect Depot**. megit checks the token with Depot before saving it, then stores it encrypted.
   It's never shown again. To change it, paste a new one; to remove it, click Disconnect.
4. Use `runs-on: depot` or `depot-<vcpus>`, or make Depot the default runner.

## Secrets

Settings → Actions → Secrets (repository admins). Names use letters, digits and `_`, don't start
with a digit, and can't start with `GITHUB_`, `MEGIT_` or `RUNNER_`. Each value can be up to 48 KB, and a
repository can have up to 100 secrets. A value is at least 3 characters, so it can be masked in logs (a
job that uses a shorter one saved earlier fails, asking for it to be replaced). Values are encrypted,
never returned by the API, and masked in logs. Use them as `${{ secrets.NAME }}`, usually through `env`.

Jobs check the commit out with a read-only token for that repository alone, which expires 30 minutes
after the job starts (the checkout happens while the job is set up).

## Requiring Actions to pass

Branch protection has **Require Actions to pass**. A pull request into a matching branch merges only
when, on its head commit:

- every **required** workflow has a successful `pull_request` run for it. Required are the base
  branch's `pull_request` workflows whose `branches` match the base and whose `types` match an event
  the head commit had: a `types: [opened]` workflow is required on the commit the pull request was
  opened at, not on later pushes. If a head's event was lost, it counts as a new push. Deleting or
  renaming a workflow on the head doesn't drop it, since the base's file is used;
- and the newest run of every other workflow on that commit (push runs and manual runs included) has
  succeeded. A failed or cancelled run blocks the merge, as does one still running or waiting for approval.

A required workflow that hasn't run shows as **not started** with **Start missing checks** for people
who can merge. The usual cause is a workflow added to the base branch after the pull request's last push
(the required set is read from the base branch's tip when checks are read), or an author already having
20 runs waiting for approval. Starting creates only the listed runs, and they wait for approval if the
pull request's runs would. Such a branch takes changes only through pull requests: direct pushes, web commits,
branch deletion and the agent merge queue are refused. The checks box above the merge button shows
the server's answer (`GET …/pulls/:number/checks`), the same one the merge gets. Commit pages show a
badge with how many runs passed.

As on GitHub's `pull_request` event, the head's own version of a workflow is what runs, so someone who
can push to the head can change what a required workflow does; review workflow changes before approving
or merging.

megit doesn't have an API for external CI to report statuses yet. Only megit Actions runs count as checks.

## API

Under `/api/repos/:owner/:repo/actions`:

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/runs` | `?before=&sha=&pull=&workflow=<path>&branch=&limit=<1–100>` | `CiRunList` (newest first; pass `next` as `before` for older runs) |
| GET | `/runs/:number` | | `CiRun` with its jobs and steps |
| GET | `/runs/:number/jobs/:job/logs` | `?after=<seq>` | `{ logs: CiLogChunk[], next: number \| null }`. Step 0 is setup; step i is the job's i-th step |
| POST | `/runs/:number/cancel`, `/rerun`, `/approve` | | `CiRun` (a re-run is a new run) |
| GET | `/workflows` | `?ref=` | `{ workflows: CiWorkflow[] }` |
| POST | `/dispatch` | `{ path, ref }` | `{ runs: CiRunSummary[] }` |
| GET / PUT | `/settings` | `{ defaultRunner }` | `CiSettings` (admins) |
| PUT / DELETE | `/depot` | `{ token, orgId }` | `CiSettings` (admins) |
| PUT / DELETE | `/secrets/:name` | `{ value }` | `CiSettings` (admins) |

And for a pull request, under `/api/repos/:owner/:repo/pulls/:number`:

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/checks` | `PullChecks`: the head, whether checks are required, the runs counted, required workflows missing, and why they block a merge (`reason`) |
| POST | `/checks` | Creates runs for exactly the workflows `missing` lists, at the head the checks are for (write access), then `PullChecks`. Where the pull request's runs wait for approval (a fork's, or one a reader opened), these wait too, past the waiting cap, for Approve; starting never runs unreviewed code. |

Settings reads and writes, the Depot token and secrets are for repository admins. Cancel, re-run,
approve, dispatch and starting checks need write access.

An archived repository runs nothing: archiving cancels its runs, and dispatch, re-run, approval and
settings changes are refused. Disconnecting Depot, deleting secrets and cancelling runs still work, so
a credential can always be revoked.

The `workflow_run` webhook event is sent when a run completes.
