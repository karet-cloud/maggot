import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GitPullRequest, MessageSquare, Plus } from "lucide-react";
import { Decision, PullStateIcon } from "../components/pulls.tsx";
import { cx, Empty, ErrorNote, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";

type Search = { state?: "closed" | "all" };

export const Route = createFileRoute("/$owner/$repo/pulls/")({
	validateSearch: (s: Record<string, unknown>): Search => (s.state === "closed" || s.state === "all" ? { state: s.state } : {}),
	component: Pulls,
});

function Pulls() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const search = Route.useSearch();
	const state = search.state ?? "open";
	const list = useQuery({ queryKey: [...keys.pulls(project), state], queryFn: () => api.pulls(project, { state }), placeholderData: keepPreviousData });
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm text-dim">Propose changes from a branch or a fork, discuss them line by line, and merge them.</p>
				{!info.data?.repo.archivedAt && (
					<Link to="/$owner/$repo/pulls/new" params={repoParams(project)} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90">
						<Plus className="size-4" />
						New pull request
					</Link>
				)}
			</div>
			<div className="overflow-hidden rounded-lg border border-line bg-panel">
				<div className="flex items-center gap-4 border-b border-line px-4 py-2.5 text-sm">
					{(["open", "closed", "all"] as const).map((s) => (
						<Link
							key={s}
							from={Route.fullPath}
							search={s === "open" ? {} : { state: s }}
							className={cx("flex items-center gap-1.5", state === s ? "font-medium text-fg" : "text-dim hover:text-fg")}
						>
							{s === "open" ? `${list.data?.open ?? "…"} Open` : s === "closed" ? `${list.data?.closed ?? "…"} Closed` : "All"}
						</Link>
					))}
					{list.isFetching && <Spinner className="ml-auto" />}
				</div>
				{list.isPending ? (
					<Spinner className="m-4" />
				) : list.error ? (
					<div className="p-4">
						<ErrorNote error={list.error} />
					</div>
				) : list.data.pulls.length === 0 ? (
					<div className="p-4">
						<Empty icon={<GitPullRequest className="size-6" />} title={state === "open" ? "No open pull requests" : "No pull requests here"} />
					</div>
				) : (
					<ul className="divide-y divide-line/60">
						{list.data.pulls.map((pull) => (
							<li key={pull.number} className="flex items-start gap-3 px-4 py-3">
								<PullStateIcon state={pull.pullState} className="mt-0.5 shrink-0" />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
										<Link to="/$owner/$repo/pull/$number" params={{ ...repoParams(project), number: String(pull.number) }} className="font-medium text-fg hover:text-accent">
											{pull.title}
										</Link>
										<Decision decision={pull.pullState === "open" ? pull.decision : null} />
									</div>
									<p className="mt-0.5 text-[11px] text-faint">
										#{pull.number} by {pull.author ?? "a deleted account"} <TimeAgo at={pull.createdAt} /> ·{" "}
										<span className="font-mono">
											{pull.headRepo ? (pull.head ? `${pull.headRepo}:` : "a private fork") : ""}
											{pull.head}
										</span>{" "}
										→ <span className="font-mono">{pull.base}</span>
									</p>
								</div>
								{pull.comments > 0 && (
									<span className="flex shrink-0 items-center gap-1 text-xs text-faint">
										<MessageSquare className="size-3.5" />
										{pull.comments}
									</span>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
