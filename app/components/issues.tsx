import type { QueryKey } from "@tanstack/react-query";
import { CircleCheck, CircleDot } from "lucide-react";
import { keys, type api, type IssueComment, type IssueState, type IssueSummary, type PullSummary } from "../lib/api.ts";
import { patch, type Patch } from "../lib/optimistic.ts";
import { cx } from "./ui.tsx";

export function IssueStateIcon({ state, className }: { state: IssueState; className?: string }) {
	return state === "open" ? (
		<CircleDot className={cx("size-4 text-emerald-300", className)} aria-label="Open" />
	) : (
		<CircleCheck className={cx("size-4 text-violet-300", className)} aria-label="Closed" />
	);
}

export function IssueStateBadge({ state }: { state: IssueState }) {
	return (
		<span
			className={cx(
				"flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
				state === "open" ? "bg-emerald-500/15 text-emerald-300" : "bg-violet-500/15 text-violet-300",
			)}
		>
			<IssueStateIcon state={state} className="size-3.5 text-current" />
			{state === "open" ? "Open" : "Closed"}
		</span>
	);
}

/** A label chip; its color comes from the name, so the same label always looks the same. */
export function Label({ name, onClick, active }: { name: string; onClick?: () => void; active?: boolean }) {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	const hue = hash % 360;
	const style = { backgroundColor: `hsl(${hue} 70% 55% / 0.15)`, color: `hsl(${hue} 80% 75%)`, boxShadow: `inset 0 0 0 1px hsl(${hue} 70% 60% / 0.35)` };
	const className = cx("inline-flex max-w-48 items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium", active && "ring-2 ring-accent");
	return onClick ? (
		<button type="button" onClick={onClick} className={className} style={style}>
			{name}
		</button>
	) : (
		<span className={className} style={style}>
			{name}
		</span>
	);
}

/** A comment shown while it posts; the refetch replaces it. */
export function pendingComment(body: string, author: string | null): IssueComment {
	const now = new Date().toISOString();
	return { id: `optimistic-${Date.now()}`, author, body, createdAt: now, updatedAt: now, canEdit: false };
}

/** What closing or reopening sets on an issue or pull request. */
export function stateChange(state: IssueState, by: string | null) {
	const closed = state === "closed";
	return { state, closedAt: closed ? new Date().toISOString() : null, closedBy: closed ? by : null };
}

/** Moves the repository tab's open count when an issue or pull request closes or reopens. */
export function openCountPatch(project: string, field: "openIssues" | "openPulls", state: IssueState | undefined): Patch[] {
	if (!state) return [];
	const delta = state === "open" ? 1 : -1;
	return [
		patch<Awaited<ReturnType<typeof api.project>>>(keys.project(project), (old) => ({ ...old, repo: { ...old.repo, [field]: Math.max(0, old.repo[field] + delta) } }), true),
	];
}

/**
 * Edits one issue's or pull request's row in every cached list under `listKey` (keyed by the state
 * filter first), moving it between the open and closed counts and out of lists of the other state.
 */
export function listPatches(listKey: QueryKey, field: "issues" | "pulls", number: number, edit: (row: IssueSummary) => Partial<PullSummary>): Patch[] {
	const update = (filter: IssueState | "all") =>
		patch<Record<string, any>>([...listKey, filter], (old) => {
			const rows = old[field] as IssueSummary[] | undefined;
			const row = rows?.find((r) => r.number === number);
			if (!rows || !row) return old;
			const next = { ...row, ...edit(row) };
			const moved = next.state === row.state ? 0 : next.state === "open" ? 1 : -1;
			return {
				...old,
				open: old.open + moved,
				closed: old.closed - moved,
				[field]: filter !== "all" && next.state !== filter ? rows.filter((r) => r !== row) : rows.map((r) => (r === row ? next : r)),
			};
		});
	return [update("open"), update("closed"), update("all")];
}
