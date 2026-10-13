import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Bot, FileWarning, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { RepoCommands } from "../components/repo-access.tsx";
import { cx, Panel, Spinner, StatusBadge, TimeAgo } from "../components/ui.tsx";
import { api, keys, type Task, repoParams } from "../lib/api.ts";
import { STATUS } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { useProjectTasks } from "../lib/queries.ts";

export const Route = createFileRoute("/$owner/$repo/agents")({ component: Board });

const MERGED_SHOWN = 12;

function Board() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const tasks = useProjectTasks(project);
	const queue = useQuery({ queryKey: keys.queue(project), queryFn: () => api.queue(project) });
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });

	if (tasks.isPending || info.isPending) return <Spinner />;
	if (info.data && !info.data.head) {
		return (
			<Panel title="Quick setup">
				<div className="space-y-4 p-4">
					<p className="text-sm text-dim">
						This repository is empty. Push your code to it with git; agents can start opening tasks once the first commit
						lands.
					</p>
					<RepoCommands repo={info.data.repo} empty />
				</div>
			</Panel>
		);
	}
	const all = tasks.data ?? [];
	const by = (...statuses: Task["status"][]) => all.filter((t) => statuses.includes(t.status));

	const position = new Map((queue.data ?? []).map((q) => [q.taskId, q.position]));
	const inQueue = by("merging", "queued").sort(
		(a, b) => Number(b.status === "merging") - Number(a.status === "merging") || (position.get(a.id) ?? 1e9) - (position.get(b.id) ?? 1e9),
	);
	const merged = by("merged").sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
	const abandoned = by("abandoned").length;

	return (
		<div className="space-y-5">
			<div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<Column
					title="Working"
					tone="open"
					// Tasks still waiting for their fork (max 2 at a time per project) sit at the top.
					tasks={[...by("provisioning").reverse(), ...by("open")]}
					project={project}
					hint="Each agent pushes to its own fork"
				/>
				<Column title="Merge queue" tone="queued" tasks={inQueue} project={project} hint="Merged one at a time" positions={position} />
				<Column title="Needs attention" tone="conflict" tasks={by("conflict", "failed")} project={project} hint="Sync, fix and resubmit" />
				<Column
					title="Merged"
					tone="merged"
					tasks={merged.slice(0, MERGED_SHOWN)}
					count={merged.length}
					project={project}
					footer={
						(merged.length > MERGED_SHOWN || abandoned > 0) && (
							<p className="px-1 pt-1 text-[11px] text-faint">
								{merged.length > MERGED_SHOWN && `${merged.length - MERGED_SHOWN} older merged. `}
								{abandoned > 0 && `${abandoned} abandoned.`}
							</p>
						)
					}
				/>
			</div>
		</div>
	);
}

function Column({
	title,
	tone,
	tasks,
	count,
	project,
	hint,
	positions,
	footer,
}: {
	title: string;
	tone: Task["status"];
	tasks: Task[];
	count?: number;
	project: string;
	hint?: string;
	positions?: Map<string, number>;
	footer?: ReactNode;
}) {
	return (
		<section className="flex min-h-40 flex-col rounded-lg border border-line bg-panel/60">
			<header className="flex items-center gap-2 px-3 pt-3 pb-2" title={hint}>
				<span className={cx("size-2 rounded-full", STATUS[tone].dot)} />
				<h2 className="text-xs font-semibold uppercase tracking-wide text-dim">{title}</h2>
				<span className="ml-auto rounded-full bg-raised px-1.5 text-[11px] font-medium text-dim tabular-nums">{count ?? tasks.length}</span>
			</header>
			<div className="flex flex-1 flex-col gap-2 px-2 pb-2">
				{tasks.length === 0 && <p className="px-1 py-6 text-center text-[11px] text-faint">{hint}</p>}
				{tasks.map((t) => (
					<TaskCard key={t.id} task={t} project={project} position={positions?.get(t.id)} />
				))}
				{footer}
			</div>
		</section>
	);
}

function TaskCard({ task: t, project, position }: { task: Task; project: string; position?: number }) {
	const { touched } = useLive();
	const at = touched.get(t.id);
	const fresh = at !== undefined && Date.now() - at < 2400;
	return (
		<Link
			// Re-keying on each event restarts the highlight animation.
			key={fresh ? at : undefined}
			to="/$owner/$repo/t/$task"
			params={{ ...repoParams(project), task: t.id }}
			className={cx(
				"block rounded-md border border-line bg-raised px-3 py-2.5 transition-colors hover:border-line-strong",
				fresh && "animate-fresh",
				t.status === "merging" && "border-orange-400/40",
			)}
		>
			<div className="flex items-start gap-2">
				<p className="min-w-0 flex-1 text-[13px] leading-snug font-medium text-fg">{t.title}</p>
				{position !== undefined && t.status === "queued" && <span className="font-mono text-[11px] text-amber-300">#{position}</span>}
			</div>
			<div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
				{t.agent && (
					<span className="flex items-center gap-1 text-dim">
						<Bot className="size-3" />
						{t.agent}
					</span>
				)}
				<span className="font-mono">{t.id}</span>
				{t.forkAttempts > 1 && (
					<span className="flex items-center gap-0.5 text-violet-300" title="Artifacts fork retried">
						<RotateCw className="size-3" />
						{t.forkAttempts}
					</span>
				)}
				<TimeAgo at={t.mergedAt ?? t.updatedAt} className="ml-auto" />
			</div>
			{(t.status === "conflict" || t.status === "failed") && (
				<div className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-300">
					{t.status === "conflict" ? <FileWarning className="mt-px size-3 shrink-0" /> : <AlertTriangle className="mt-px size-3 shrink-0" />}
					<span className="line-clamp-2 break-all">{t.status === "conflict" ? t.conflict?.files.join(", ") : t.error}</span>
				</div>
			)}
			{t.status === "merged" && t.changedFiles.length > 0 && (
				<p className="mt-1.5 truncate font-mono text-[11px] text-faint">{t.changedFiles.join(" ")}</p>
			)}
			{(t.status === "merging" || t.status === "provisioning") && (
				<div className="mt-2">
					<StatusBadge status={t.status} />
				</div>
			)}
		</Link>
	);
}
