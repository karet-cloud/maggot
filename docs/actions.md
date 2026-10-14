# megit Actions

megit runs workflows from `.megit/workflows/*.yml` (or `.yaml`) in the repository, in GitHub Actions
syntax: jobs of steps on a fresh Linux machine with the commit already checked out, ordered with `needs`,
expanded by a `matrix`, using shell scripts, megit's built-in checkout, cache and artifact actions, and
JavaScript and composite actions from GitHub or the repository itself. Anything megit doesn't do makes
the workflow fail to load with a message naming the key; megit never silently skips it. The Actions tab
lists each workflow file and why it can't run.

An example that runs this repository's own tests is in [`.megit/workflows/ci.yml`](../.megit/workflows/ci.yml).

```yaml
name: CI
on:
  push:
    branches: [master, "release/**"]
  pull_request:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1-5"       # weekdays at 06:00 UTC, on the default branch

env:
  NODE_ENV: test

jobs:
  test:
    runs-on: ubuntu-latest      # the repository's default runner
    timeout-minutes: 15
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4 # built in
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - uses: actions/cache@v4    # built in, kept in R2
        with:
          path: ~/.npm
          key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
          restore-keys: npm-${{ runner.os }}-
      - run: npm ci
      - name: Test
        run: npm test
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: test-results-${{ matrix.node }}
          path: test-results/
  build:
    needs: test
    runs-on: depot-8            # an 8 vCPU Depot sandbox
    outputs:
      version: ${{ steps.version.outputs.value }}
    steps:
      - id: version
        run: echo "value=$(git describe --always)" >> "$GITHUB_OUTPUT"
      - run: npm ci && npm run build
        env:
          TOKEN: ${{ secrets.COVERAGE_TOKEN }}
  announce:
    needs: build
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Built ${{ needs.build.outputs.version }}"
```

## Supported syntax

| Key | What megit accepts |
| --- | --- |
| `on` | `push` with `branches` or `branches-ignore` (`*`, `**`, `?`, and `!` to exclude); `pull_request` with those plus `types` (`opened`, `synchronize`, `reopened`; all three by default); `workflow_dispatch` without inputs; `schedule` (a list of `cron:` entries). A string or list of event names also works. |
| `name`, `env` | The workflow's name (defaults to the file name) and environment for every job. |
| `defaults.run` | `shell` and `working-directory` for every `run` step, at workflow or job level. |
| `permissions` | Only read access: `read-all`, or scopes set to `read` or `none`. Jobs' checkout token is read-only anyway. |
| `jobs.<id>` | `name`, `runs-on`, `needs` (string or list; cycles and unknown names are errors), `if`, `outputs`, `strategy`, `timeout-minutes` (1–360, default 30), `env`, `defaults`, `permissions`, `steps`. Up to 50 jobs per workflow, and 256 once matrices are expanded. |
| `strategy` | `matrix` (named lists of values, plus `include` and `exclude`, as GitHub combines them; at most 256 combinations; not one built by an expression), `fail-fast` (default true: a failed job cancels the rest of its matrix), `max-parallel`. |
| `runs-on` | `cloudflare` (or `megit`), `depot` (2 vCPUs), `depot-<n>` or `depot-ubuntu-<version>-<n>` with n = 2, 4, 8, 16, 32 or 64, or `ubuntu-latest`, `ubuntu-<version>`, `linux` and `default` for the repository's default runner. May use `${{ matrix.* }}`. x64 only: Arm labels are refused. |
| `steps[]` | `run` (a script) or `uses` (an action) with `with`, plus `name`, `id`, `shell` (`bash`, the default, or `sh`), `working-directory` (inside the repository), `env`, `if`, `continue-on-error`, `timeout-minutes` (no longer than the job's). Up to 50 steps per job. |
| `uses` | `actions/checkout` (built in: `fetch-depth`, default 50, 0 for all history; `clean: true`; `persist-credentials: false`), `actions/cache`, `actions/cache/restore` and `actions/cache/save` (built in, see [Caches](#caches)), `actions/upload-artifact` and `actions/download-artifact` (built in, see [Artifacts](#artifacts)), and any JavaScript or composite action from GitHub (`owner/repo@ref`, `owner/repo/path@ref`) or this repository (`./path`). See [Actions](#actions). |
| `if` | Any expression, with or without `${{ }}`. Without a status function it means `success() && (…)`, as on GitHub. A job's `if` is checked once the jobs it `needs` are done. |
| `${{ … }}` | GitHub's expression language: literals, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `\|\|`, property and index access and `.*` filters, and `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles` and `success()`, `failure()`, `cancelled()`, `always()`. Contexts: `github`, `env`, `secrets` (empty if unset), `matrix`, `strategy`, `steps.<id>.outputs` / `outcome` / `conclusion`, `needs.<id>.outputs` / `result`, `job.status`, `runner` (`os`, `arch`, `temp`, `tool_cache`), and `inputs` inside composite actions. Each place allows the contexts GitHub allows there; a mistake is reported when the workflow is listed. |

Steps' expressions are filled in on the machine as each step starts, so they see the outputs of the
steps before (`$GITHUB_OUTPUT`), and `hashFiles` hashes the checkout as it is then. Jobs see the `github`
values as environment variables (`GITHUB_SHA`, `GITHUB_REF_NAME`, …), plus `CI=true`, `MEGIT_ACTIONS=true`,
`GITHUB_ACTIONS=true`, `RUNNER_OS`, `RUNNER_ARCH`, `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`, and the `$GITHUB_ENV`,
`$GITHUB_PATH`, `$GITHUB_OUTPUT`, `$GITHUB_STATE` and `$GITHUB_STEP_SUMMARY` files. The workspace is
`/workspace` and jobs have Internet access. A job's `outputs` are worked out when its steps are done; one
holding a secret isn't passed on.

Not supported yet: `services`, `container`, `concurrency`, `environment`, `run-name`, reusable
workflows, `workflow_dispatch` inputs, `vars`, a matrix built by an expression, and Docker actions.

## When workflows run

- **push**: each branch a push (HTTPS, SSH, web edit or merge) moves, using the workflow files at the new commit. Pushes and edits to the wiki start nothing.
- **pull_request**: when a pull request is opened or reopened, and on new pushes to its head
  (`synchronize`), filtered by the workflow's `branches` (matched against the base branch) and
  `types`. The head commit's workflow files are used, as on GitHub. A workflow the base branch has
  (see [Requiring Actions to pass](#requiring-actions-to-pass)) that the head lacks runs from the base's
  file, on the head's code. Events are recorded and retried until their runs start, and acted on only
  while their commit is still the pull request's head, so a late one can't touch a newer head's runs.
- **workflow_dispatch**: Run workflow on the Actions tab (write access), on any branch.
- **schedule**: at the times its `cron` entries name (five fields, UTC; lists, ranges, steps and
  names like `MON-FRI`), on the default branch's latest commit, as on GitHub. Schedules are read from the
  default branch's workflow files whenever it moves. Runs are at least 5 minutes apart; one that's more
  than 15 minutes late (megit was busy) is skipped to the next time, and nothing is scheduled while the
  repository has no runner set up.

A pull request's runs wait as **Waiting for approval** unless whoever caused them can write to the
repository: one opened by a reader (from a fork or from a branch here) and new pushes to a fork's
branch wait. Someone who can merge reads the workflow and approves it, from the run page or the checks
box on the pull request. Runs from forks never get the repository's secrets; an approved run for a
reader's pull request from a branch here does (its code was pushed by someone who can write). At most
100 runs wait at once per repository (20 per pull request author); past that, the pull request's required
runs show as missing, and **Start missing checks** creates them, still waiting for approval. Runs nobody
approves within 7 days are cancelled. Closing a pull request cancels its waiting and running runs
(merging cancels the waiting ones); reopening it starts them again (waiting, if they'd wait).

Cancel stops a queued or running run. Re-run starts a new run with the definition the run ran with, on
the same commit, keeping the original trigger. A job's conclusion is success, failure, cancelled or
skipped (skipped: its `if` was false, which by default means a job it `needs` didn't succeed); a run's is
failure if any job failed, else cancelled if any was cancelled, else success. A matrix with `fail-fast`
cancels its other jobs when one fails.

The 300 newest finished runs that someone who can write started or approved are kept per repository,
with up to 5 MB of log per job and 512 MB per repository (the oldest logs go first). Runs on an open
pull request's head commit are kept whatever their age. Finished runs nobody approved (a reader's or
fork's broken workflow files, expired or cancelled waiting runs) are kept apart, at most 100 per
repository and 20 per author, so they can't push other runs out.

## Actions

`uses: owner/repo@ref` (or `owner/repo/path@ref`) runs an action from GitHub: a JavaScript action
(`runs.using: node12` … `node24`, run with Node.js 20 or later) or a composite action. Before a job
starts, megit pins each action to a commit (a tag first, then a branch; or a full commit hash) and reads
its `action.yml`, so a job runs exactly what it resolved. A job whose actions can't be resolved fails
before any machine starts, saying why. During setup the job downloads each action's files from megit,
which keeps a copy of every action commit in R2 after fetching it from GitHub once; it also uses the
machine's Node.js if it's 20 or later, and installs Node.js 24 if not.

JavaScript actions get their inputs as `INPUT_<NAME>` (defaults from `action.yml` filled in), run from
the workspace, and can use `pre` and `post` scripts (with `pre-if` and `post-if`): pre steps run before
the job's steps and post steps after them, in reverse order, each shown as its own step. What a main or
pre script writes to `$GITHUB_STATE` reaches its post script as `STATE_<name>`. Composite actions run
their steps (each `run` step names its `shell`) in their own `steps` context, with `inputs`, and show as
one step; their `outputs` become that step's outputs. Actions may use actions, nine deep.
`uses: ./path` runs an action from the repository at the run's commit, the same ways.

Actions that talk to GitHub's own services (its cache or artifact services, its API with
`GITHUB_TOKEN`) won't find them; megit doesn't hand jobs a `GITHUB_TOKEN`. Docker container actions
aren't supported. Workflow commands written to the log (`::add-mask::`, `::set-output::`) aren't acted on;
use the `$GITHUB_*` files.

## Caches

`actions/cache` restores a cache when its step runs and saves one after the job's steps (as a post step,
when the job is succeeding and the key wasn't restored exactly); `actions/cache/restore` and
`actions/cache/save` do the two halves. Inputs: `key`, `path` (lines, globs, `~`, `!` to exclude),
`restore-keys` (prefixes, tried in order), `fail-on-cache-miss`, `lookup-only`; outputs: `cache-hit`
(`true` only for an exact match on `key`), `cache-primary-key` and `cache-matched-key`. Caches are
`.tar.gz` archives kept in R2, uploaded in parts through megit.

As on GitHub, caches are scoped: a job saves to its branch (a pull request's job to the pull request)
and restores from its own scope first, then its base branch's, then the default branch's, trying the key
exactly, then as a prefix, then each restore key. So a branch never sees another branch's caches and a
fork's pull request can't change the base's. A key is saved once per scope; the version (the paths)
must match to restore. A cache unused for 7 days is deleted, and past 10 GB per repository the least
recently used go. The Actions tab lists caches to people who can write, who can delete them.

## Artifacts

`actions/upload-artifact` uploads files (`path`: lines, globs, `!` to exclude; `if-no-files-found`:
`warn`, `error` or `ignore`; `retention-days`, 30 by default and up to 90; `overwrite`;
`include-hidden-files`) as one `.tar.gz` named `name` (default `artifact`), with paths relative to the
folder all the files share. `actions/download-artifact` downloads one by `name`, or all of the run's
(those matching `pattern`), into `path` (a folder per artifact unless `merge-multiple`). Artifacts belong to
their run: the run page lists them for download, and people who can write can delete them. A repository
keeps at most 10 GB of artifacts, 100 per run and 5 GB each.

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
| GET | `/runs/:number/artifacts` | | `{ artifacts: CiArtifact[] }` |
| GET | `/runs/:number/artifacts/:id/download` | | The artifact's `.tar.gz` |
| DELETE | `/runs/:number/artifacts/:id` | | `{ deleted: true }` (write access) |
| GET | `/caches` | | `{ caches: CiCache[] }` |
| DELETE | `/caches/:id` | | `{ deleted: true }` (write access) |

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

Jobs reach megit at `/api/ci` with their own short-lived token (not a person's): for caches, artifacts
and actions' files. It works only for the job's repository, run and cache scopes, and expires soon after
the job's time limit. Caches, artifacts and actions' files are kept in the `CI_BUCKET` R2 bucket
(`megit-ci`), which `cloudflare.config.ts` binds.
