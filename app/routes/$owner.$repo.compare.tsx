import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, GitCompareArrows } from "lucide-react";
import { CommitList } from "../components/commits.tsx";
import { DiffView } from "../components/diff.tsx";
import { BranchSelect, branchNamesQuery } from "../components/refs.tsx";
import { buttonClass, Empty, ErrorNote, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";
import { preload, projectQuery } from "../lib/queries.ts";

type Search = { base?: string; head?: string };

export const Route = createFileRoute("/$owner/$repo/compare")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		base: typeof s.base === "string" && s.base ? s.base : undefined,
		head: typeof s.head === "string" && s.head ? s.head : undefined,
	}),
	loaderDeps: ({ search }) => ({ base: search.base, head: search.head }),
	loader: ({ context, params, deps, preload: hover }) => {
		const project = `${params.owner}/${params.repo}`;
		// Without a base in the URL, compare against the default branch if the layout already knows it.
		const base = deps.base ?? context.queryClient.getQueryData(projectQuery(project).queryKey)?.defaultBranch;
		// A comparison is a diff, costly to work out: fetched on the visit, not the hover.
		return preload(context.queryClient, branchNamesQuery(project), !hover && Boolean(base && deps.head) && compareQuery(project, base as string, deps.head as string));
	},
	component: ComparePage,
});

const compareQuery = (project: string, base: string, head: string) =>
	queryOptions({ queryKey: keys.compare(project, base, head), queryFn: () => api.compare(project, base, head) });

function ComparePage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const info = useQuery(projectQuery(project));
	const base = search.base ?? info.data?.defaultBranch;
	const head = search.head;
	const comparison = useQuery({ ...compareQuery(project, base ?? "", head ?? ""), enabled: Boolean(base && head) });

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
								className={buttonClass("primary")}
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
