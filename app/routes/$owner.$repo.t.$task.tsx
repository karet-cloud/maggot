import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, FileCode2, Send, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { CommitList } from "../components/commits.tsx";
import { DiffView } from "../components/diff.tsx";
import { EventRow } from "../components/events.tsx";
import { Connect } from "../components/new-task.tsx";
import { Button, ErrorNote, Oid, Panel, Spinner, StatusBadge, TimeAgo } from "../components/ui.tsx";
import { api, keys, type Task, repoParams } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";

export const Route = createFileRoute("/$owner/$repo/t/$task")({ component: TaskPage });

const SUBMITTABLE: Task["status"][] = ["open", "conflict", "failed"];
const ABANDONABLE: Task["status"][] = ["provisioning", "open", "queued", "conflict", "failed"];

function TaskPage() {
	const { owner, repo, task: id } = Route.useParams();
	const project = `${owner}/${repo}`;
	const queryClient = useQueryClient();
	const task = useQuery({ queryKey: keys.task(project, id), queryFn: () => api.task(project, id) });
	const { events } = useLive();
	const onChange = (t: Task) => {
		queryClient.setQueryData(keys.task(project, id), t);
		void queryClient.invalidateQueries({ queryKey: keys.tasks(project) });
	};
	const submit = useMutation({ mutationFn: () => api.submit(project, id), onSuccess: onChange });
	const abandon = useMutation({ mutationFn: () => api.abandon(project, id), onSuccess: onChange });
	const status = task.data?.status;
	const hasChanges = status !== undefined && status !== "provisioning" && (status !== "abandoned" || Boolean(task.data?.mergedOid));
	const changes = useQuery({
		queryKey: keys.taskChanges(project, id),
		queryFn: () => api.taskChanges(project, id),
		enabled: hasChanges,
		// Agents push without telling the coordinator; re-read while the fork is live.
		refetchInterval: status === "open" || status === "conflict" ? 15_000 : false,
	});

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
							busy={abandon.isPending}
							onClick={() => confirm("Abandon this task and delete its fork?") && abandon.mutate()}
						>
							<Trash2 className="size-4" />
							Abandon
						</Button>
					)}
				</div>
			</div>
			<ErrorNote error={submit.error ?? abandon.error} />

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

				<Panel title={`Commits${changes.data ? ` (${changes.data.commits.length}${changes.data.capped ? "+" : ""})` : ""}`}>
					{!hasChanges ? (
						<p className="px-4 py-6 text-center text-xs text-faint">{t.status === "provisioning" ? "Waiting for the fork." : "The fork was deleted."}</p>
					) : changes.isPending ? (
						<Spinner className="m-4" />
					) : changes.error ? (
						<div className="p-3">
							<ErrorNote error={changes.error} />
						</div>
					) : changes.data.commits.length === 0 ? (
						<p className="px-4 py-6 text-center text-xs text-faint">No commits yet. The agent's pushes show up here.</p>
					) : (
						<div className="max-h-80 overflow-y-auto">
							<CommitList commits={changes.data.commits} project={project} refName={t.mergedOid ? undefined : `task:${id}`} />
						</div>
					)}
				</Panel>
			</div>

			{changes.data && <DiffView diff={changes.data.diff} project={project} viewRef={fileRef} title="Files changed" />}
			{!changes.data && t.changedFiles.length > 0 && (
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
