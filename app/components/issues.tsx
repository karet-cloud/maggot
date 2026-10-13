import { CircleCheck, CircleDot } from "lucide-react";
import type { IssueState } from "../lib/api.ts";
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
