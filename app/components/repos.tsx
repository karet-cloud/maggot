import { Link } from "@tanstack/react-router";
import { BookLock, BookMarked } from "lucide-react";
import type { RepoInfo } from "../lib/api.ts";
import { cx, Empty, TimeAgo } from "./ui.tsx";

export function VisibilityBadge({ visibility }: { visibility: RepoInfo["visibility"] }) {
	return (
		<span
			className={cx(
				"rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
				visibility === "private" ? "bg-amber-400/10 text-amber-300 ring-amber-400/30" : "bg-zinc-500/10 text-dim ring-zinc-500/30",
			)}
		>
			{visibility === "private" ? "Private" : "Public"}
		</span>
	);
}

/** Repositories as a list of cards; `showOwner` prefixes each name with its owner. */
export function RepoList({ repos, showOwner, empty }: { repos: RepoInfo[]; showOwner?: boolean; empty: { title: string; body?: string } }) {
	if (repos.length === 0) return <Empty icon={<BookMarked className="size-6" />} title={empty.title}>{empty.body}</Empty>;
	return (
		<ul className="divide-y divide-line/60 rounded-lg border border-line bg-panel">
			{repos.map((r) => (
				<li key={r.fullName} className="flex items-start gap-3 px-4 py-3">
					{r.visibility === "private" ? <BookLock className="mt-0.5 size-4 text-amber-300" /> : <BookMarked className="mt-0.5 size-4 text-faint" />}
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="font-mono text-sm font-medium text-accent hover:underline">
								{showOwner ? r.fullName : r.name}
							</Link>
							<VisibilityBadge visibility={r.visibility} />
						</div>
						{r.description && <p className="mt-1 text-xs text-dim">{r.description}</p>}
						<p className="mt-1 text-[11px] text-faint">
							<span className="font-mono">{r.defaultBranch}</span> · created <TimeAgo at={r.createdAt} />
						</p>
					</div>
				</li>
			))}
		</ul>
	);
}
