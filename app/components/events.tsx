import { Link } from "@tanstack/react-router";
import { AlertTriangle, CircleDot, GitBranchPlus, GitCommitHorizontal, GitMerge, Inbox, Loader, Send, Sparkles, Trash2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { EventType, ProjectEvent, Task } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";
import { cx, TimeAgo } from "./ui.tsx";

const ICON: Record<EventType, { icon: ReactNode; tone: string }> = {
	"project.created": { icon: <Sparkles className="size-3.5" />, tone: "text-accent" },
	"task.created": { icon: <CircleDot className="size-3.5" />, tone: "text-violet-300" },
	"task.ready": { icon: <GitBranchPlus className="size-3.5" />, tone: "text-sky-300" },
	"task.submitted": { icon: <Send className="size-3.5" />, tone: "text-amber-300" },
	"task.merging": { icon: <Loader className="size-3.5" />, tone: "text-orange-300" },
	"task.merged": { icon: <GitMerge className="size-3.5" />, tone: "text-emerald-300" },
	"task.conflict": { icon: <AlertTriangle className="size-3.5" />, tone: "text-rose-300" },
	"task.failed": { icon: <XCircle className="size-3.5" />, tone: "text-red-400" },
	"task.abandoned": { icon: <Trash2 className="size-3.5" />, tone: "text-zinc-400" },
	"main.advanced": { icon: <GitCommitHorizontal className="size-3.5" />, tone: "text-emerald-300" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One-line description of an event, without the task (shown separately). */
export function describe(e: ProjectEvent): string {
	const d = e.data as Record<string, unknown>;
	switch (e.type) {
		case "project.created":
			return d.imported ? "Project imported" : "Project created";
		case "task.created":
			return `${(d.agent as string | null) ?? "Someone"} started a task`;
		case "task.ready": {
			const attempts = Number(d.forkAttempts ?? 1);
			return attempts > 1 ? `Fork ready after ${attempts} attempts` : "Fork ready";
		}
		case "task.submitted":
			return `Submitted, #${String(d.position ?? "?")} in the merge queue`;
		case "task.merging":
			return "Merging";
		case "task.merged":
			return `Merged ${plural(((d.changedFiles as string[] | undefined) ?? []).length, "file")}`;
		case "task.conflict":
			return `Conflict in ${((d.files as string[] | undefined) ?? []).join(", ") || "files"}`;
		case "task.failed":
			return `Failed: ${String(d.message ?? d.code ?? "unknown error")}`;
		case "task.abandoned":
			return "Abandoned";
		case "main.advanced":
			return `main ${shortOid(d.from as string | null)} → ${shortOid(d.to as string)}${d.fastForward ? " (fast-forward)" : ""}`;
	}
}

export function EventRow({ event, task, project, compact }: { event: ProjectEvent; task?: Task; project: string; compact?: boolean }) {
	const meta = ICON[event.type];
	return (
		<li className="flex gap-2.5 px-4 py-2">
			<span className={cx("mt-0.5 shrink-0", meta.tone)}>{meta.icon}</span>
			<div className="min-w-0 flex-1">
				{!compact && event.taskId && (
					<Link
						to="/p/$project/t/$task"
						params={{ project, task: event.taskId }}
						className="block truncate text-[13px] font-medium text-fg hover:text-accent"
					>
						{task?.title ?? event.taskId}
					</Link>
				)}
				<p className={cx("text-xs", event.type === "task.failed" || event.type === "task.conflict" ? meta.tone : "text-dim", "break-words")}>
					{describe(event)}
				</p>
			</div>
			<TimeAgo at={event.ts} className="shrink-0 text-[11px] text-faint" />
		</li>
	);
}

export function EventFeed({ events, tasks, project }: { events: ProjectEvent[]; tasks: Map<string, Task>; project: string }) {
	if (events.length === 0) {
		return (
			<div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-faint">
				<Inbox className="size-5" />
				No events yet
			</div>
		);
	}
	return (
		<ol className="divide-y divide-line/60">
			{[...events].reverse().map((e) => (
				<EventRow key={e.seq} event={e} task={e.taskId ? tasks.get(e.taskId) : undefined} project={project} />
			))}
		</ol>
	);
}
