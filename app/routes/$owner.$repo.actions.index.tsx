import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, GitBranch, Play, Workflow, X } from "lucide-react";
import { useState } from "react";
import { CiIcon, ciLabel, ciState, Elapsed, isActive, NoWorkflows } from "../components/actions.tsx";
import { Button, cx, ErrorNote, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, repoParams, type CiRunSummary } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";

type Search = { sha?: string; pull?: number; help?: boolean };

export const Route = createFileRoute("/$owner/$repo/actions/")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		sha: typeof s.sha === "string" && /^[0-9a-f]{40}$/.test(s.sha) ? s.sha : undefined,
		pull: typeof s.pull === "number" && Number.isInteger(s.pull) && s.pull > 0 ? s.pull : undefined,
		help: s.help === true || undefined,
	}),
	component: Actions,
});

function Actions() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { sha, pull, help } = Route.useSearch();
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const runs = useInfiniteQuery({
		queryKey: [...keys.ciRuns(project), "list", sha ?? "", pull ?? 0],
		queryFn: ({ pageParam }) => api.ciRuns(project, { sha, pull, before: pageParam }),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (last) => last.next ?? undefined,
		placeholderData: keepPreviousData,
		// The live connection reports runs starting and finishing; this catches what it misses. Polling would
		// refetch every loaded page, so it stops once older ones are shown.
		refetchInterval: (q) => (q.state.data?.pages.length === 1 && q.state.data.pages[0].runs.some(isActive) ? 10_000 : false),
	});
	const list = runs.data?.pages.flatMap((p) => p.runs) ?? [];
	const branch = info.data?.defaultBranch ?? "";
	const filtered = Boolean(sha || pull);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm text-dim">
					Workflows in <code className="font-mono text-fg">.megit/workflows</code> run shell steps on pushes, pull requests and by hand.
				</p>
				<Link from={Route.fullPath} search={(s) => ({ ...s, help: help ? undefined : true })} className="flex items-center gap-1.5 text-xs text-accent hover:underline">
					<BookOpen className="size-3.5" />
					{help ? "Hide workflow syntax" : "Workflow syntax"}
				</Link>
			</div>
			{help && <SyntaxGuide />}
			{info.data && <Workflows project={project} defaultBranch={branch} canRun={info.data.repo.canWrite && !info.data.repo.archivedAt} />}
			<div className="overflow-hidden rounded-lg border border-line bg-panel">
				<div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 text-sm">
					<span className="font-medium text-fg">Runs</span>
					{filtered && (
						<Link
							from={Route.fullPath}
							search={(s) => ({ help: s.help })}
							className="flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] text-dim hover:text-fg"
							title="Show every run"
						>
							{sha ? <span className="font-mono">{shortOid(sha)}</span> : `pull request #${pull}`}
							<X className="size-3" />
						</Link>
					)}
					{runs.isFetching && <Spinner className="ml-auto" />}
				</div>
				{runs.isPending ? (
					<Spinner className="m-4" />
				) : runs.error ? (
					<div className="p-4">
						<ErrorNote error={runs.error} />
					</div>
				) : list.length === 0 ? (
					<div className="p-4">
						{filtered ? <p className="text-sm text-dim">No runs match.</p> : <NoWorkflows project={project} branch={branch || "the default branch"} />}
					</div>
				) : (
					<ul className="divide-y divide-line/60">
						{list.map((r) => (
							<RunRow key={r.number} project={project} run={r} />
						))}
					</ul>
				)}
				{runs.hasNextPage && (
					<div className="border-t border-line p-3 text-center">
						<Button onClick={() => void runs.fetchNextPage()} busy={runs.isFetchingNextPage} className="text-xs">
							Older runs
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

/** What started a run, in a few words. */
export function trigger(run: CiRunSummary) {
	if (run.event === "pull_request") return `Pull request #${run.pull}${run.fromFork ? " from a fork" : ""}`;
	if (run.event === "workflow_dispatch") return `Run by ${run.actor ?? "someone"}`;
	return `Push${run.actor ? ` by ${run.actor}` : ""}`;
}

function RunRow({ project, run }: { project: string; run: CiRunSummary }) {
	const state = ciState(run);
	return (
		<li className="flex items-start gap-3 px-4 py-3">
			<CiIcon state={state} className="mt-0.5" />
			<div className="min-w-0 flex-1">
				<Link to="/$owner/$repo/actions/runs/$number" params={{ ...repoParams(project), number: String(run.number) }} className="font-medium text-fg hover:text-accent">
					{run.workflow} <span className="font-normal text-faint">#{run.number}</span>
				</Link>
				<p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
					<span>{trigger(run)}</span>·
					<span className="flex items-center gap-1 font-mono">
						<GitBranch className="size-3" />
						{run.branch}
					</span>
					·
					<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: run.sha }} className="font-mono hover:text-accent">
						{shortOid(run.sha)}
					</Link>
					· <span className="font-mono">{run.path}</span>
				</p>
				{run.error && <p className="mt-1 text-xs text-rose-300">{run.error}</p>}
			</div>
			<div className="shrink-0 text-right text-[11px] text-faint">
				<p className={cx(state === "failure" && "text-rose-300", state === "success" && "text-emerald-300")}>{ciLabel(state)}</p>
				<p>
					<TimeAgo at={run.createdAt} />
					{run.startedAt && (
						<>
							{" · "}
							<Elapsed from={run.startedAt} to={run.finishedAt} />
						</>
					)}
				</p>
			</div>
		</li>
	);
}

/** The workflow files on a branch, why any can't run, and Run for those with workflow_dispatch. */
function Workflows({ project, defaultBranch, canRun }: { project: string; defaultBranch: string; canRun: boolean }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [ref, setRef] = useState(defaultBranch);
	const branches = useQuery({ queryKey: [...keys.branches(project), "names"], queryFn: () => api.branches(project, false), enabled: canRun });
	const workflows = useQuery({ queryKey: keys.ciWorkflows(project, ref), queryFn: () => api.ciWorkflows(project, ref), enabled: Boolean(ref) });
	const dispatch = useMutation({
		mutationFn: (path: string) => api.ciDispatch(project, path, ref),
		onSuccess: (runs) => {
			void queryClient.invalidateQueries({ queryKey: keys.ciRuns(project) });
			if (runs[0]) void navigate({ to: "/$owner/$repo/actions/runs/$number", params: { ...repoParams(project), number: String(runs[0].number) } });
		},
	});
	// Readers have nothing to do with an empty list; people who can run workflows may have them on another branch.
	if (!canRun && workflows.data?.length === 0 && ref === defaultBranch) return null;
	return (
		<Panel
			title="Workflows"
			actions={
				canRun && branches.data ? (
					<label className="flex items-center gap-1.5 text-[11px] text-faint">
						on
						<select value={ref} onChange={(e) => setRef(e.target.value)} className="rounded-md border border-line-strong bg-raised px-2 py-1 font-mono text-xs text-fg">
							{branches.data.branches.map((b) => (
								<option key={b.name} value={b.name}>
									{b.name}
								</option>
							))}
						</select>
					</label>
				) : (
					<span className="font-mono text-[11px] text-faint">{ref}</span>
				)
			}
		>
			{workflows.isPending ? (
				<Spinner className="m-4" />
			) : workflows.error ? (
				<div className="p-4">
					<ErrorNote error={workflows.error} />
				</div>
			) : workflows.data.length === 0 ? (
				<p className="p-4 text-sm text-dim">No workflows on {ref}.</p>
			) : (
				<ul className="divide-y divide-line/60">
					{workflows.data.map((w) => (
						<li key={w.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
							<Workflow className={cx("size-4 shrink-0", w.error ? "text-rose-300" : "text-faint")} />
							<div className="min-w-0 flex-1">
								<p className="text-fg">
									{w.name} <span className="font-mono text-[11px] text-faint">{w.path}</span>
								</p>
								{w.error && <p className="mt-0.5 font-mono text-[11px] break-words text-rose-300">{w.error}</p>}
							</div>
							{canRun && w.dispatch && !w.error && (
								<Button className="text-xs" busy={dispatch.isPending && dispatch.variables === w.path} onClick={() => dispatch.mutate(w.path)} title={`Run ${w.path} on ${ref} now`}>
									<Play className="size-3.5" />
									Run workflow
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			<div className="px-4 empty:hidden">
				<ErrorNote error={dispatch.error} />
			</div>
		</Panel>
	);
}

const EXAMPLE = `name: CI
on:
  push:
    branches: [master]
  pull_request:
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest   # the repository's default runner
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4   # built in: the commit is always checked out
      - name: Install
        run: npm ci
      - name: Test
        run: npm test
        env:
          NODE_ENV: test
      - name: Show disk usage
        if: \${{ always() }}   # runs even when an earlier step failed
        run: df -h /workspace
  build:
    needs: test
    runs-on: depot-4          # a 4 vCPU Depot sandbox
    steps:
      - run: npm ci && npm run build
        env:
          API_TOKEN: \${{ secrets.API_TOKEN }}`;

/** Exactly what megit Actions understands. Anything else in a workflow is reported as an error, not skipped. */
function SyntaxGuide() {
	const row = (key: string, text: string) => (
		<tr key={key} className="align-top">
			<td className="py-1 pr-4 font-mono text-[12px] whitespace-nowrap text-fg">{key}</td>
			<td className="py-1 text-xs text-dim">{text}</td>
		</tr>
	);
	return (
		<Panel title="Workflow syntax" actions={<span className="text-[11px] text-faint">A subset of GitHub Actions</span>}>
			<div className="grid gap-4 p-4 xl:grid-cols-2">
				<pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-[12px] leading-relaxed text-fg/90">{EXAMPLE}</pre>
				<div className="overflow-x-auto">
					<table className="w-full">
						<tbody className="divide-y divide-line/60">
							{row("on", "push and pull_request (branches or branches-ignore with * ** ? and !; pull_request types opened, synchronize, reopened), workflow_dispatch (no inputs)")}
							{row("name, env", "The workflow's name and environment")}
							{row("defaults.run", "shell and working-directory for run steps, at workflow or job level")}
							{row("permissions", "Read access only: read-all, or scopes set to read or none")}
							{row("jobs.<id>", "name, runs-on, needs, timeout-minutes (1–360, default 30), env, defaults, permissions, steps. At most 20 jobs")}
							{row("runs-on", "cloudflare, depot, depot-<2|4|8|16|32|64>, or ubuntu-latest / ubuntu-<version> / linux for the repository's default runner. x64 only")}
							{row("steps[]", "run (bash or sh), name, shell, working-directory, env, if, continue-on-error, id, timeout-minutes. At most 50")}
							{row("uses", "Only actions/checkout (built in), with fetch-depth (default 50, 0 for all history). Other actions aren't supported yet")}
							{row("steps[].if", "success(), always(), failure(), cancelled() or !cancelled(); no job-level if")}
							{row("${{ }}", "secrets.NAME, env.NAME, runner.os, runner.arch, github.sha / ref / ref_name / head_ref / base_ref / repository / event_name / run_number / actor / workspace")}
							{row("Not yet", "matrix, services, containers, concurrency, artifacts, caches, outputs, reusable workflows, schedules")}
						</tbody>
					</table>
					<p className="mt-3 text-[11px] text-faint">
						Jobs run on Linux in <code className="font-mono">/workspace</code> with Internet access. Runs from forks' pull requests wait for approval and
						never get secrets.
					</p>
				</div>
			</div>
		</Panel>
	);
}
