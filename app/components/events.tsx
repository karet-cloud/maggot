import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	BookOpen,
	CircleCheck,
	CircleDot,
	GitBranchPlus,
	GitCommitHorizontal,
	GitMerge,
	GitPullRequest,
	Inbox,
	Loader,
	MessageSquare,
	Package,
	Send,
	Sparkles,
	Tag,
	Trash2,
	Upload,
	Workflow,
	XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type { EventType, ProjectEvent, Task, WikiPageChange } from "../lib/api.ts";
import { repoParams } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";
import { cx, TimeAgo } from "./ui.tsx";

const ICON: Record<EventType, { icon: ReactNode; tone: string }> = {
	"project.created": { icon: <Sparkles className="size-3.5" />, tone: "text-accent" },
	"repo.pushed": { icon: <Upload className="size-3.5" />, tone: "text-sky-300" },
	"task.created": { icon: <CircleDot className="size-3.5" />, tone: "text-violet-300" },
	"task.ready": { icon: <GitBranchPlus className="size-3.5" />, tone: "text-sky-300" },
	"task.submitted": { icon: <Send className="size-3.5" />, tone: "text-amber-300" },
	"task.merging": { icon: <Loader className="size-3.5" />, tone: "text-orange-300" },
	"task.merged": { icon: <GitMerge className="size-3.5" />, tone: "text-emerald-300" },
	"task.conflict": { icon: <AlertTriangle className="size-3.5" />, tone: "text-rose-300" },
	"task.failed": { icon: <XCircle className="size-3.5" />, tone: "text-red-400" },
	"task.abandoned": { icon: <Trash2 className="size-3.5" />, tone: "text-zinc-400" },
	"main.advanced": { icon: <GitCommitHorizontal className="size-3.5" />, tone: "text-emerald-300" },
	"tag.created": { icon: <Tag className="size-3.5" />, tone: "text-sky-300" },
	"tag.deleted": { icon: <Tag className="size-3.5" />, tone: "text-zinc-400" },
	"release.published": { icon: <Package className="size-3.5" />, tone: "text-emerald-300" },
	"release.edited": { icon: <Package className="size-3.5" />, tone: "text-dim" },
	"release.deleted": { icon: <Package className="size-3.5" />, tone: "text-faint" },
	"issue.opened": { icon: <CircleDot className="size-3.5" />, tone: "text-emerald-300" },
	"issue.closed": { icon: <CircleCheck className="size-3.5" />, tone: "text-violet-300" },
	"issue.reopened": { icon: <CircleDot className="size-3.5" />, tone: "text-emerald-300" },
	"issue.commented": { icon: <MessageSquare className="size-3.5" />, tone: "text-sky-300" },
	"pull.opened": { icon: <GitPullRequest className="size-3.5" />, tone: "text-emerald-300" },
	"pull.reviewed": { icon: <MessageSquare className="size-3.5" />, tone: "text-amber-300" },
	"pull.merged": { icon: <GitMerge className="size-3.5" />, tone: "text-violet-300" },
	"ci.completed": { icon: <Workflow className="size-3.5" />, tone: "text-sky-300" },
	"wiki.updated": { icon: <BookOpen className="size-3.5" />, tone: "text-sky-300" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One-line description of an event, without the task (shown separately). */
export function describe(e: ProjectEvent): string {
	const d = e.data as Record<string, unknown>;
	switch (e.type) {
		case "project.created":
			return d.imported ? "Repository imported" : "Repository created";
		case "repo.pushed": {
			// Newer events list every branch the push moved; the default branch gets the detail.
			const others = ((d.refs as { branch: string; to: string | null }[] | undefined) ?? []).filter((r) => r.branch !== d.branch);
			const names = others.map((r) => (r.to ? r.branch : `${r.branch} (deleted)`)).join(", ");
			if (d.moved === false) return names ? `Pushed ${names}` : "Pushed (no branch changed)";
			if (names) return `Pushed ${String(d.branch)} and ${names}`;
			if (!d.from) return d.to ? `Pushed ${String(d.branch)} at ${shortOid(d.to as string)}` : "Pushed";
			return `Pushed ${String(d.branch)} ${shortOid(d.from as string)} → ${shortOid(d.to as string)}`;
		}
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
		case "tag.created":
			return `Tagged ${String(d.tag)} at ${shortOid(d.commit as string)}`;
		case "tag.deleted":
			return `Deleted tag ${String(d.tag)}`;
		case "release.published":
			return `Released ${String(d.name ?? d.tag)}`;
		case "release.edited":
			return `Edited release ${String(d.name ?? d.tag)}`;
		case "release.deleted":
			return `Deleted release ${String(d.name ?? d.tag)}`;
		case "issue.opened":
		case "issue.closed":
		case "issue.reopened":
		case "issue.commented": {
			const issue = d.issue as { number: number; title: string } | undefined;
			if (e.type === "issue.closed" && d.commit) return `Commit ${shortOid(d.commit as string)} closed #${issue?.number ?? "?"} ${issue?.title ?? ""}`.trim();
			const verb = { "issue.opened": "opened", "issue.closed": "closed", "issue.reopened": "reopened", "issue.commented": "commented on" }[e.type];
			return `${String(d.sender ?? "Someone")} ${verb} #${issue?.number ?? "?"} ${issue?.title ?? ""}`.trim();
		}
		case "pull.opened":
		case "pull.reviewed":
		case "pull.merged": {
			const pull = d.pull as { number: number; title: string } | undefined;
			const verb =
				e.type === "pull.opened"
					? "opened pull request"
					: e.type === "pull.merged"
						? "merged pull request"
						: d.state === "approved"
							? "approved"
							: d.state === "changes_requested"
								? "requested changes on"
								: "reviewed";
			return `${String(d.sender ?? "Someone")} ${verb} #${pull?.number ?? "?"} ${pull?.title ?? ""}`.trim();
		}
		case "ci.completed": {
			const run = (d.run ?? {}) as { number?: number; workflow?: string; branch?: string; sha?: string; conclusion?: string; pull?: number | null };
			const results: Record<string, string> = { success: "passed", failure: "failed", cancelled: "was cancelled", skipped: "was skipped" };
			const result = results[run.conclusion ?? ""] ?? "finished";
			const where = run.pull ? `pull request #${run.pull}` : `${run.branch ?? "?"} at ${shortOid(run.sha)}`;
			return `${run.workflow ?? "A workflow"} #${run.number ?? "?"} ${result} on ${where}`;
		}
		case "wiki.updated": {
			const pages = (d.pages ?? []) as WikiPageChange[];
			const who = String(d.actor ?? "Someone");
			if (pages.length === 0) return `${who} updated the wiki`;
			if (pages.length > 1) return `${who} changed ${plural(pages.length, "wiki page")}`;
			return `${who} ${pages[0].action} the wiki page ${pages[0].title}`;
		}
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
						to="/$owner/$repo/t/$task"
						params={{ ...repoParams(project), task: event.taskId }}
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
