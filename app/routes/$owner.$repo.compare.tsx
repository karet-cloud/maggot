import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, GitCompareArrows } from "lucide-react";
import { CommitList } from "../components/commits.tsx";
import { DiffView } from "../components/diff.tsx";
import { BranchSelect } from "../components/refs.tsx";
import { Empty, ErrorNote, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";

type Search = { base?: string; head?: string };

export const Route = createFileRoute("/$owner/$repo/compare")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		base: typeof s.base === "string" && s.base ? s.base : undefined,
		head: typeof s.head === "string" && s.head ? s.head : undefined,
	}),
	component: ComparePage,
});

function ComparePage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const base = search.base ?? info.data?.defaultBranch;
	const head = search.head;
	const comparison = useQuery({
		queryKey: keys.compare(project, base ?? "", head ?? ""),
		queryFn: () => api.compare(project, base as string, head as string),
		enabled: Boolean(base && head),
	});

	return (
		<div className="space-y-4">
			<Link to="/$owner/$repo/branches" params={repoParams(project)} className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg">
				<ArrowLeft className="size-3.5" />
				Branches
			</Link>
			<div className="flex flex-wrap items-center gap-2 text-xs text-dim">
				<GitCompareArrows className="size-4 text-faint" />
				<span>base</span>
				<BranchSelect project={project} value={base} onChange={(b) => void navigate({ search: { base: b, head } })} branchesOnly />
				<span>…</span>
				<span>compare</span>
				<BranchSelect project={project} value={head} onChange={(h) => void navigate({ search: { base, head: h } })} placeholder="Pick a branch" />
			</div>
			{!head && <Empty icon={<GitCompareArrows className="size-6" />} title="Pick a branch to compare" />}
			{comparison.isPending && head && <Spinner />}
			<ErrorNote error={comparison.error} />
			{comparison.data && (
				<>
					<Panel
						title={`${comparison.data.commits.length}${comparison.data.capped ? "+" : ""} ${comparison.data.commits.length === 1 ? "commit" : "commits"}`}
						actions={
							<span className="text-[11px] text-faint">
								{comparison.data.mergeBase ? `since ${shortOid(comparison.data.mergeBase)}` : "no common ancestor found in recent history"}
							</span>
						}
					>
						{comparison.data.commits.length === 0 ? (
							<p className="px-4 py-6 text-center text-xs text-faint">
								{head} has nothing that {base} doesn't. {head?.startsWith("task:") ? "" : "It is already merged, or behind."}
							</p>
						) : (
							<CommitList commits={comparison.data.commits} project={project} refName={head?.startsWith("task:") ? head : undefined} />
						)}
					</Panel>
					{comparison.data.commits.length > 0 && head && !head.startsWith("task:") && (
						<div className="flex justify-end">
							<Link
								to="/$owner/$repo/pulls/new"
								params={repoParams(project)}
								search={{ base, head }}
								className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
							>
								Open a pull request
							</Link>
						</div>
					)}
					<DiffView diff={comparison.data.diff} project={project} viewRef={head} />
				</>
			)}
		</div>
	);
}
