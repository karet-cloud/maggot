import { Link } from "@tanstack/react-router";
import { Archive, BookLock, BookMarked, GitFork, Star } from "lucide-react";
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

/** Archived repositories are read-only. */
export function ArchivedBadge() {
	return (
		<span className="flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
			<Archive className="size-3" />
			Archived
		</span>
	);
}

export function ForkedFrom({ source, className }: { source: { owner: string; name: string }; className?: string }) {
	return (
		<p className={cx("flex items-center gap-1 text-[11px] text-faint", className)}>
			<GitFork className="size-3" />
			forked from{" "}
			<Link to="/$owner/$repo" params={{ owner: source.owner, repo: source.name }} className="font-mono text-dim hover:text-accent hover:underline">
				{source.owner}/{source.name}
			</Link>
		</p>
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
							{r.archivedAt && <ArchivedBadge />}
						</div>
						{r.forkOf && <ForkedFrom source={r.forkOf} className="mt-0.5" />}
						{r.description && <p className="mt-1 text-xs text-dim">{r.description}</p>}
						<p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-faint">
							<span className="font-mono">{r.defaultBranch}</span>
							{r.stars > 0 && (
								<span className="flex items-center gap-1">
									<Star className="size-3" />
									{r.stars}
								</span>
							)}
							{r.forks > 0 && (
								<span className="flex items-center gap-1">
									<GitFork className="size-3" />
									{r.forks}
								</span>
							)}
							<span>
								created <TimeAgo at={r.createdAt} />
							</span>
						</p>
					</div>
				</li>
			))}
		</ul>
	);
}
