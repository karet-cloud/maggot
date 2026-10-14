import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, CircleStop, Cpu, GitBranch, RotateCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CiIcon, ciLabel, ciState, Elapsed, isActive, RunArtifacts, type CiState } from "../components/actions.tsx";
import { Button, cx, Empty, ErrorNote, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, keys, repoParams, type CiJob, type CiLogChunk } from "../lib/api.ts";
import { trigger } from "./$owner.$repo.actions.index.tsx";

type Search = { job?: string };

export const Route = createFileRoute("/$owner/$repo/actions/runs/$number")({
	validateSearch: (s: Record<string, unknown>): Search => ({ job: typeof s.job === "string" && s.job ? s.job : undefined }),
	component: RunPage,
});

function RunPage() {
	const { owner, repo, number: raw } = Route.useParams();
	const project = `${owner}/${repo}`;
	const number = Number(raw);
	const search = Route.useSearch();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const picked = useRef<{ run: number; job: string } | null>(null);
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const run = useQuery({
		queryKey: keys.ciRun(project, number),
		queryFn: () => api.ciRun(project, number),
		enabled: Number.isInteger(number),
		refetchInterval: (q) => (q.state.data && isActive(q.state.data) ? 3000 : false),
	});
	const act = useMutation({
		mutationFn: (action: "cancel" | "rerun" | "approve") => api.ciRunAction(project, number, action),
		onSuccess: (result, action) => {
			void queryClient.invalidateQueries({ queryKey: keys.ciRuns(project) });
			// A re-run is a new run with its own number.
			if (action === "rerun" && result.number !== number) {
				void navigate({ to: "/$owner/$repo/actions/runs/$number", params: { ...repoParams(project), number: String(result.number) } });
			} else queryClient.setQueryData(keys.ciRun(project, number), result);
		},
	});

	if (run.isPending) return <Spinner />;
	if (run.error) {
		return run.error instanceof ApiError && run.error.status === 404 ? (
			<Empty title={`Run #${raw} doesn't exist`}>
				<Link to="/$owner/$repo/actions" params={repoParams(project)} className="text-accent hover:underline">
					All runs
				</Link>
			</Empty>
		) : (
			<ErrorNote error={run.error} />
		);
	}
	const r = run.data;
	const state = ciState(r);
	const canWrite = Boolean(info.data?.repo.canWrite);
	// An archived repository starts nothing, but what's still going can be stopped.
	const canAct = canWrite && !info.data?.repo.archivedAt;
	// Without ?job, the first pick stays picked as jobs finish, so the log being read doesn't vanish.
	const selected =
		r.jobs.find((j) => j.key === search.job) ??
		r.jobs.find((j) => picked.current?.run === r.number && j.key === picked.current.job) ??
		r.jobs.find((j) => ciState(j) === "failure") ??
		r.jobs.find(isActive) ??
		r.jobs[0];
	if (!search.job && selected) picked.current = { run: r.number, job: selected.key };

	return (
		<div className="space-y-4">
			<Link to="/$owner/$repo/actions" params={repoParams(project)} className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg">
				<ArrowLeft className="size-3.5" />
				All runs
			</Link>
			<Panel>
				<div className="flex flex-wrap items-start justify-between gap-3 p-4">
					<div className="min-w-0 space-y-1">
						<h1 className="flex items-center gap-2 text-lg font-semibold">
							<CiIcon state={state} className="size-5" />
							{r.workflow} <span className="font-normal text-faint">#{r.number}</span>
						</h1>
						<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
							<span className={cx(state === "failure" && "text-rose-300", state === "success" && "text-emerald-300")}>{ciLabel(state)}</span>·
							<span>
								{r.pull ? (
									<Link to="/$owner/$repo/pull/$number" params={{ ...repoParams(project), number: String(r.pull) }} className="hover:text-accent">
										{trigger(r)}
									</Link>
								) : (
									trigger(r)
								)}
							</span>
							·
							<span className="flex items-center gap-1 font-mono">
								<GitBranch className="size-3" />
								{r.branch}
							</span>
							·
							<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: r.sha }} className="font-mono hover:text-accent">
								{r.sha.slice(0, 7)}
							</Link>
							· <span className="font-mono text-faint">{r.path}</span>
						</p>
						<p className="text-[11px] text-faint">
							Created <TimeAgo at={r.createdAt} />
							{r.startedAt && (
								<>
									{" · ran for "}
									<Elapsed from={r.startedAt} to={r.finishedAt} />
								</>
							)}
						</p>
					</div>
					{canWrite && (
						<div className="flex flex-wrap gap-2 empty:hidden">
							{canAct && r.status === "waiting" && (
								<Button variant="primary" busy={act.isPending && act.variables === "approve"} onClick={() => act.mutate("approve")}>
									<ShieldCheck className="size-4" />
									Approve and run
								</Button>
							)}
							{isActive(r) && (
								<Button variant="danger" busy={act.isPending && act.variables === "cancel"} onClick={() => confirm(`Cancel run #${r.number}?`) && act.mutate("cancel")}>
									<CircleStop className="size-4" />
									Cancel run
								</Button>
							)}
							{canAct && !isActive(r) && (
								<Button busy={act.isPending && act.variables === "rerun"} onClick={() => act.mutate("rerun")} title="Start a new run of this workflow on the same commit">
									<RotateCw className="size-4" />
									Re-run
								</Button>
							)}
						</div>
					)}
				</div>
				{r.status === "waiting" && (
					<p className="border-t border-line px-4 py-2.5 text-xs text-amber-200">
						{r.fromFork
							? "This run comes from a fork's pull request and runs the fork's version of the workflow, so someone who can merge needs to read it and approve first. It won't get this repository's secrets."
							: "This run is for a pull request opened by someone who can't write to this repository, so someone who can merge needs to read the workflow and approve first. Once approved it runs with this repository's secrets, like any run from a branch here."}
					</p>
				)}
				{r.error && <p className="border-t border-line px-4 py-2.5 text-xs text-rose-300">{r.error}</p>}
				{act.error && (
					<div className="border-t border-line px-4 py-2.5">
						<ErrorNote error={act.error} />
					</div>
				)}
			</Panel>

			{r.jobs.length === 0 ? (
				<Empty title="No jobs" />
			) : (
				<div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
					<nav className="space-y-0.5 self-start rounded-lg border border-line bg-panel p-1.5">
						{r.jobs.map((j) => (
							<Link
								key={j.id}
								from={Route.fullPath}
								search={{ job: j.key }}
								replace
								className={cx("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm", j.id === selected?.id ? "bg-raised text-fg" : "text-dim hover:bg-raised/60 hover:text-fg")}
							>
								<CiIcon state={ciState(j)} className="size-3.5" />
								<span className="min-w-0 flex-1 truncate">{j.name}</span>
								<span className="text-[11px] text-faint">
									<Elapsed from={j.startedAt} to={j.finishedAt} />
								</span>
							</Link>
						))}
					</nav>
					{selected && <JobView key={selected.id} project={project} run={r.number} job={selected} />}
				</div>
			)}
			<RunArtifacts project={project} run={r.number} active={isActive(r)} canWrite={canWrite && !info.data?.repo.archivedAt} />
		</div>
	);
}

function JobView({ project, run, job }: { project: string; run: number; job: CiJob }) {
	const logs = useJobLogs(project, run, job);
	// The runner's steps: setup, the workflow's steps, then cleanup. Log step i belongs to step i.
	const steps = job.steps.map((s) => ({ name: s.name, state: ciState(s), startedAt: s.startedAt, finishedAt: s.finishedAt }));
	// Rebuilt when the log grows, not on every poll of the run.
	const byStep = useMemo(() => {
		const out = new Map<number, string>();
		for (const c of logs.chunks) out.set(c.step, (out.get(c.step) ?? "") + c.text);
		return out;
	}, [logs.chunks]);
	return (
		<Panel
			title={
				<span className="flex items-center gap-2 normal-case tracking-normal">
					<CiIcon state={ciState(job)} />
					{job.name}
				</span>
			}
			actions={
				<span className="flex items-center gap-1.5 text-[11px] text-faint">
					<Cpu className="size-3" />
					{job.runner === "depot" ? `Depot${job.vcpus ? ` · ${job.vcpus} vCPU` : ""}` : "Cloudflare container"}
					{job.needs.length > 0 && <> · needs {job.needs.join(", ")}</>}
				</span>
			}
		>
			{job.error && <p className="border-b border-line px-4 py-2.5 text-xs text-rose-300">{job.error}</p>}
			{job.status === "waiting" || (job.status === "queued" && !logs.chunks.length) ? (
				<p className="p-4 text-sm text-dim">{job.status === "waiting" ? "Waiting for approval." : job.needs.length ? "Waiting for the jobs it needs." : "Waiting for a runner…"}</p>
			) : (
				<ol className="divide-y divide-line/60">
					{steps.map((s, i) => (
						<StepLog
							key={i}
							name={s.name}
							state={s.state}
							startedAt={s.startedAt}
							finishedAt={s.finishedAt}
							text={byStep.get(i) ?? ""}
						/>
					))}
				</ol>
			)}
			<div className="px-4 empty:hidden">
				<ErrorNote error={logs.error} />
			</div>
		</Panel>
	);
}

function StepLog({ name, state, startedAt, finishedAt, text }: { name: string; state: CiState; startedAt: string | null; finishedAt: string | null; text: string }) {
	const [open, setOpen] = useState<boolean | null>(null);
	// Failed and running steps start open, and a running one stays open when it ends; the reader's choice wins.
	useEffect(() => {
		if (state === "in_progress") setOpen((o) => o ?? true);
	}, [state]);
	const shown = open ?? (state === "failure" || state === "in_progress");
	const ref = useRef<HTMLPreElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el && state === "in_progress") el.scrollTop = el.scrollHeight;
	}, [text, state]);
	return (
		<li>
			<button type="button" onClick={() => setOpen(!shown)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-raised/40">
				<ChevronRight className={cx("size-3.5 shrink-0 text-faint transition-transform", shown && "rotate-90")} />
				<CiIcon state={state} className="size-3.5" />
				<span className="min-w-0 flex-1 truncate text-fg">{name}</span>
				<span className="text-[11px] text-faint">
					<Elapsed from={startedAt} to={finishedAt} />
				</span>
			</button>
			{shown && (
				<pre ref={ref} className="max-h-[32rem] overflow-auto bg-bg px-4 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-fg/90">
					{text || <span className="text-faint">{state === "pending" || state === "skipped" ? "Didn't run." : "No output."}</span>}
				</pre>
			)}
		</li>
	);
}

/**
 * A job's log, read in order. `next` is the cursor to ask with; it stays set while the job runs and
 * turns null once the job has finished and everything has been read.
 */
function useJobLogs(project: string, run: number, job: CiJob) {
	const [chunks, setChunks] = useState<CiLogChunk[]>([]);
	const [error, setError] = useState<unknown>(null);
	const after = useRef(0);
	const done = useRef(false);
	useEffect(() => {
		if (job.status === "waiting" || done.current) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async () => {
			try {
				const res = await api.ciLogs(project, run, job.id, after.current);
				if (cancelled) return;
				setError(null);
				if (res.logs.length) setChunks((prev) => [...prev, ...res.logs]);
				if (res.next === null) {
					done.current = true;
					return;
				}
				after.current = res.next;
				// A big batch may have more behind it; otherwise the job reports every couple of seconds.
				timer = setTimeout(load, res.logs.length >= 500 ? 250 : res.logs.length ? 1000 : 2000);
			} catch (err) {
				if (cancelled) return;
				setError(err);
				timer = setTimeout(load, 5000);
			}
		};
		void load();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [project, run, job.id, job.status]);
	return { chunks, error };
}
