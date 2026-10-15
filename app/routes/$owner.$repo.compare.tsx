import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, GitCompareArrows } from "lucide-react";
import { CommitList } from "../components/commits.tsx";
import { DiffView } from "../components/diff.tsx";
import { BranchSelect, branchNamesQuery, HeadPicker, usePullHead } from "../components/refs.tsx";
import { buttonClass, Empty, ErrorNote, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";
import { preload, projectQuery } from "../lib/queries.ts";

type Search = { base?: string; head?: string; headRepo?: string };

// `head` is any ref here, or a branch of a repository in the fork network: `owner:branch` as on GitHub, or with `headRepo`.
export const Route = createFileRoute("/$owner/$repo/compare")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		base: typeof s.base === "string" && s.base ? s.base : undefined,
		head: typeof s.head === "string" && s.head ? s.head : undefined,
		headRepo: typeof s.headRepo === "string" && s.headRepo ? s.headRepo : undefined,
	}),
	loaderDeps: ({ search }) => ({ base: search.base, head: search.head, headRepo: search.headRepo }),
	loader: ({ context, params, deps, preload: hover }) => {
		const project = `${params.owner}/${params.repo}`;
		// Without a base in the URL, compare against the default branch if the layout already knows it.
		const base = deps.base ?? context.queryClient.getQueryData(projectQuery(project).queryKey)?.defaultBranch;
		// A comparison is a diff, costly to work out: fetched on the visit, not the hover.
		// Only a branch of this repository; another repository's (owner:branch, headRepo) is resolved on the page.
		const local = Boolean(deps.head && !deps.head.includes(":") && !deps.headRepo);
		return preload(context.queryClient, branchNamesQuery(project), !hover && Boolean(base && local) && compareQuery(project, base as string, deps.head as string));
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
	const resolved = usePullHead(project, search);
	const head = resolved.branch;
	const headProject = resolved.repo ?? project;
	// Another repository's branch is compared as a pull request from it would be; refs here, as always.
	// Within this repository it's the same query the loader preloads.
	const comparison = useQuery({
		queryKey: resolved.fork ? [...keys.compare(project, base ?? "", head ?? ""), resolved.fork] : compareQuery(project, base ?? "", head ?? "").queryKey,
		queryFn: () => (resolved.fork ? api.pullPreview(project, base as string, head as string, resolved.fork) : api.compare(project, base as string, head as string)),
		enabled: Boolean(base && head && resolved.repo),
	});
	const headLabel = resolved.fork ? `${resolved.fork.split("/")[0]}:${head}` : head;

	return (
		<div className="space-y-4">
			<Link to="/$owner/$repo/branches" params={repoParams(project)} className="inline-flex items-center gap-1 text-xs text-dim hover:text-fg">
				<ArrowLeft className="size-3.5" />
				Branches
			</Link>
			<div className="flex flex-wrap items-center gap-2 text-xs text-dim">
				<GitCompareArrows className="size-4 text-faint" />
				<span>base</span>
				<BranchSelect project={project} value={base} onChange={(b) => void navigate({ search: { ...search, base: b } })} branchesOnly />
				<span>…</span>
				<span>compare</span>
				<HeadPicker project={project} repo={resolved.repo} branch={head} onChange={(h) => void navigate({ search: { base: search.base, ...h } })} />
			</div>
			{resolved.problem ? (
				<Empty icon={<GitCompareArrows className="size-6" />} title={resolved.problem === "ambiguous" ? `${resolved.owner} has more than one repository in this fork network; pick one` : `${resolved.owner} has no fork of ${project} that you can see`} />
			) : (
				!head && <Empty icon={<GitCompareArrows className="size-6" />} title="Pick a branch to compare" />
			)}
			{comparison.isPending && head && resolved.repo && <Spinner />}
			<ErrorNote error={resolved.error ?? comparison.error} />
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
								{headLabel} has nothing that {base} doesn't. {head?.startsWith("task:") ? "" : "It is already merged, or behind."}
							</p>
						) : (
							<CommitList commits={comparison.data.commits} project={headProject} refName={head?.startsWith("task:") ? head : undefined} />
						)}
					</Panel>
					{comparison.data.commits.length > 0 && head && !head.startsWith("task:") && (
						<div className="flex justify-end">
							<Link
								to="/$owner/$repo/pulls/new"
								params={repoParams(project)}
								search={{ base, head: search.head, headRepo: search.headRepo }}
								className={buttonClass("primary")}
							>
								Open a pull request
							</Link>
						</div>
					)}
					<DiffView diff={comparison.data.diff} project={headProject} viewRef={head} />
				</>
			)}
		</div>
	);
}
