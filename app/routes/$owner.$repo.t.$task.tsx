import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, FileCode2, Send, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { CommitList } from "../components/commits.tsx";
import { DiffView, type DiffSource } from "../components/diff.tsx";
import { EventRow } from "../components/events.tsx";
import { Connect } from "../components/new-task.tsx";
import { Button, ErrorNote, Oid, Panel, Spinner, StatusBadge, TimeAgo } from "../components/ui.tsx";
import { api, diffs, keys, type Branches, type ComparisonMeta, type Task, repoParams } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { browserOnly, diffQuery, preload, tasksQuery } from "../lib/queries.ts";

export const Route = createFileRoute("/$owner/$repo/t/$task")({
	loader: ({ context, params }) => {
		const project = `${params.owner}/${params.repo}`;
		// The changes only exist once there's a fork; go by whatever the cache already knows of the task.
		const known = context.queryClient.getQueryData(taskQuery(project, params.task).queryKey) ?? context.queryClient.getQueryData(tasksQuery(project).queryKey)?.find((t) => t.id === params.task);
		return preload(context.queryClient, taskQuery(project, params.task), known !== undefined && hasChanges(known) && browserOnly(false, taskChangesQuery(project, params.task)));
	},
	component: TaskPage,
});

const taskQuery = (project: string, id: string) => queryOptions({ queryKey: keys.task(project, id), queryFn: () => api.task(project, id) });
const taskDiff = (project: string, id: string): DiffSource => ({ key: keys.taskChanges(project, id), path: diffs.taskChanges(project, id) });
// Streamed: the commits (in the header) come at once, then each file as it's diffed.
const taskChangesQuery = (project: string, id: string) => diffQuery<ComparisonMeta>(keys.taskChanges(project, id), diffs.taskChanges(project, id));
const hasChanges = (t: Task) => t.status !== "provisioning" && (t.status !== "abandoned" || Boolean(t.mergedOid));

const SUBMITTABLE: Task["status"][] = ["open", "conflict", "failed"];
const ABANDONABLE: Task["status"][] = ["provisioning", "open", "queued", "conflict", "failed"];

function TaskPage() {
	const { owner, repo, task: id } = Route.useParams();
	const project = `${owner}/${repo}`;
	const queryClient = useQueryClient();
	const task = useQuery(taskQuery(project, id));
	const { events } = useLive();
	const onChange = (t: Task) => {
		queryClient.setQueryData(keys.task(project, id), t);
		void queryClient.invalidateQueries({ queryKey: keys.tasks(project) });
	};
	const submit = useMutation({ mutationFn: () => api.submit(project, id), onSuccess: onChange });
	const abandon = useOptimistic({
		mutationFn: () => api.abandon(project, id),
		apply: () => [
			patch<Task>(keys.task(project, id), (old) => ({ ...old, status: "abandoned" }), true),
			patch<Task[]>(keys.tasks(project), (old) => old.map((t) => (t.id === id ? { ...t, status: "abandoned" } : t)), true),
			patch<Branches>(keys.branches(project), (old) => ({ ...old, agents: old.agents.filter((a) => a.taskId !== id) })),
		],
		action: "abandon the task",
	});
	const status = task.data?.status;
	const withChanges = task.data !== undefined && hasChanges(task.data);
	const changes = useQuery({
		...taskChangesQuery(project, id),
		enabled: withChanges,
		// Agents push without telling the coordinator; re-read while the fork is live.
		refetchInterval: status === "open" || status === "conflict" ? 15_000 : false,
	});
	const comparison = changes.data?.meta ?? null;

	if (task.isPending) return <Spinner />;
	if (task.error) return <ErrorNote error={task.error} />;
	const t = task.data;
	const timeline = events.filter((e) => e.taskId === id);
	// Files live in the fork while it exists, and on the default branch once merged.
	const fileRef = t.status === "merged" ? (t.mergedOid ?? undefined) : `task:${id}`;
	const canBrowse = t.status !== "abandoned" && t.status !== "provisioning";

	return (
		<div className="space-y-4">
			<Link to="/$owner/$repo/agents" params={repoParams(project)} className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg">
				<ArrowLeft className="size-3.5" />
				Board
			</Link>

			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-2">
					<h2 className="text-lg leading-snug font-semibold">{t.title}</h2>
					<div className="flex flex-wrap items-center gap-3 text-xs text-dim">
						<StatusBadge status={t.status} />
						<span className="font-mono text-faint">{t.id}</span>
						{t.agent && (
							<span className="flex items-center gap-1">
								<Bot className="size-3.5" />
								{t.agent}
							</span>
						)}
						<span>
							opened <TimeAgo at={t.createdAt} />
						</span>
						{t.mergedAt && <span className="text-emerald-300">merged in {duration(t.createdAt, t.mergedAt)}</span>}
					</div>
				</div>
				<div className="flex gap-2">
					{SUBMITTABLE.includes(t.status) && (
						<Button variant="primary" onClick={() => submit.mutate()} busy={submit.isPending}>
							<Send className="size-4" />
							{t.status === "open" ? "Submit for merge" : "Resubmit"}
						</Button>
					)}
					{ABANDONABLE.includes(t.status) && (
						<Button
							variant="danger"
							onClick={() => confirm("Abandon this task and delete its fork?") && abandon.mutate()}
						>
							<Trash2 className="size-4" />
							Abandon
						</Button>
					)}
				</div>
			</div>
			<ErrorNote error={submit.error} />

			{t.status === "conflict" && t.conflict && (
				<div className="rounded-lg border border-rose-400/30 bg-rose-400/5 p-4 text-sm">
					<p className="font-medium text-rose-200">This task conflicts with work merged since it was forked.</p>
					<ul className="mt-2 space-y-1 font-mono text-xs text-rose-200/90">
						{t.conflict.files.map((f) => (
							<li key={f}>{f}</li>
						))}
					</ul>
					{t.conflict.withTasks.length > 0 && (
						<p className="mt-3 text-xs text-dim">
							Touched by{" "}
							{t.conflict.withTasks.map((w, i) => (
								<span key={w}>
									{i > 0 && ", "}
									<Link to="/$owner/$repo/t/$task" params={{ ...repoParams(project), task: w }} className="font-mono text-accent hover:underline">
										{w}
									</Link>
								</span>
							))}
							. Run <code className="font-mono text-fg">maggot sync</code> in the checkout, resolve, then resubmit.
						</p>
					)}
				</div>
			)}
			{t.status === "failed" && t.error && (
				<div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-200">
					<p className="font-medium">Merge failed</p>
					<p className="mt-1 font-mono text-xs break-all">{t.error}</p>
				</div>
			)}

			<div className="grid gap-4 xl:grid-cols-2">
				<Panel title="Git">
					<dl className="divide-y divide-line/60 text-xs">
						<Row label="Fork repo">
							<span className="font-mono">{t.repo}</span>
							{t.forkAttempts > 1 && <span className="ml-2 text-violet-300">({t.forkAttempts} attempts)</span>}
						</Row>
						<Row label="Base">
							<Oid oid={t.baseOid} />
						</Row>
						<Row label="Submitted head">
							<Oid oid={t.headOid} />
						</Row>
						<Row label="Merged as">
							<Oid oid={t.mergedOid} />
						</Row>
						<Row label="Path claims">
							{t.paths.length ? <span className="font-mono">{t.paths.join(", ")}</span> : <span className="text-faint">none</span>}
						</Row>
					</dl>
					{(t.status === "open" || t.status === "conflict" || t.status === "failed") && (
						<div className="border-t border-line p-4">
							<Connect project={project} taskId={id} />
						</div>
					)}
				</Panel>

				<Panel title={`Commits${comparison ? ` (${comparison.commits.length}${comparison.capped ? "+" : ""})` : ""}`}>
					{!withChanges ? (
						<p className="px-4 py-6 text-center text-xs text-faint">{t.status === "provisioning" ? "Waiting for the fork." : "The fork was deleted."}</p>
					) : changes.isPending ? (
						<Spinner className="m-4" />
					) : !comparison ? (
						<div className="p-3">
							<ErrorNote error={changes.error} />
						</div>
					) : comparison.commits.length === 0 ? (
						<p className="px-4 py-6 text-center text-xs text-faint">No commits yet. The agent's pushes show up here.</p>
					) : (
						<div className="max-h-80 overflow-y-auto">
							<CommitList commits={comparison.commits} project={project} refName={t.mergedOid ? undefined : `task:${id}`} />
						</div>
					)}
				</Panel>
			</div>

			{comparison && changes.data && (
				<DiffView
					diff={changes.data}
					source={taskDiff(project, id)}
					project={project}
					viewRef={fileRef}
					title="Files changed"
					error={changes.error}
					onRetry={() => void changes.refetch()}
				/>
			)}
			{!comparison && t.changedFiles.length > 0 && (
				<Panel title={`Changed files${t.changedFiles.length ? ` (${t.changedFiles.length})` : ""}`}>
					{t.changedFiles.length === 0 ? (
						<p className="px-4 py-6 text-center text-xs text-faint">Known once the task is submitted.</p>
					) : (
						<ul className="divide-y divide-line/60">
							{t.changedFiles.map((f) => (
								<li key={f}>
									{canBrowse ? (
										<Link
											to="/$owner/$repo"
											params={repoParams(project)}
											search={{ ref: fileRef, path: f.split("/").slice(0, -1).join("/") || undefined, file: f }}
											className="flex items-center gap-2 px-4 py-1.5 font-mono text-xs text-dim hover:bg-raised hover:text-fg"
										>
											<FileCode2 className="size-3.5 shrink-0 text-faint" />
											{f}
										</Link>
									) : (
										<span className="flex items-center gap-2 px-4 py-1.5 font-mono text-xs text-dim">{f}</span>
									)}
								</li>
							))}
						</ul>
					)}
				</Panel>
			)}

			<Panel title="Timeline">
				{timeline.length === 0 ? (
					<p className="px-4 py-6 text-center text-xs text-faint">No recent events for this task.</p>
				) : (
					<ol className="divide-y divide-line/60">
						{timeline.map((e) => (
							<EventRow key={e.seq} event={e} project={project} compact />
						))}
					</ol>
				)}
			</Panel>
		</div>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-4 px-4 py-2">
			<dt className="w-32 shrink-0 text-faint">{label}</dt>
			<dd className="min-w-0 flex-1 truncate text-dim">{children}</dd>
		</div>
	);
}
