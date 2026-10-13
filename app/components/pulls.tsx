import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import type { PullState } from "../lib/api.ts";
import { cx } from "./ui.tsx";

export function PullStateIcon({ state, className }: { state: PullState; className?: string }) {
	const Icon = state === "merged" ? GitMerge : state === "closed" ? GitPullRequestClosed : GitPullRequest;
	const tone = state === "merged" ? "text-violet-300" : state === "closed" ? "text-rose-300" : "text-emerald-300";
	return <Icon className={cx("size-4", tone, className)} aria-label={state === "merged" ? "Merged" : state === "closed" ? "Closed" : "Open"} />;
}

export function PullStateBadge({ state }: { state: PullState }) {
	return (
		<span
			className={cx(
				"flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
				state === "merged" ? "bg-violet-500/15 text-violet-300" : state === "closed" ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300",
			)}
		>
			<PullStateIcon state={state} className="size-3.5 text-current" />
			{state === "merged" ? "Merged" : state === "closed" ? "Closed" : "Open"}
		</span>
	);
}

export function Decision({ decision }: { decision: "approved" | "changes_requested" | null }) {
	if (!decision) return null;
	return (
		<span className={cx("rounded-full px-2 py-0.5 text-[11px] font-medium", decision === "approved" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-400/15 text-amber-300")}>
			{decision === "approved" ? "Approved" : "Changes requested"}
		</span>
	);
}
