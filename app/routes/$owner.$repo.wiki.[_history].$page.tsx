import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GitCommitHorizontal } from "lucide-react";
import { pageTitle } from "../../src/wiki-pages.ts";
import { Button, cx, ErrorNote, Oid, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { WikiGate, wikiQueries, WikiShell } from "../components/wiki.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { preload } from "../lib/queries.ts";

// The edits to one page, newest first, a page of history at a time.
export const Route = createFileRoute("/$owner/$repo/wiki/_history/$page")({
	loader: ({ context, params }) => {
		const project = `${params.owner}/${params.repo}`;
		return preload(context.queryClient, ...wikiQueries(context.queryClient, project), historyQuery(project, params.page));
	},
	component: WikiPageHistory,
});

const historyQuery = (project: string, slug: string) =>
	infiniteQueryOptions({
		queryKey: keys.wikiHistory(project, slug),
		queryFn: ({ pageParam }) => api.wikiHistory(project, slug, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next ?? undefined,
	});

function WikiPageHistory() {
	const { owner, repo, page } = Route.useParams();
	const project = `${owner}/${repo}`;
	return (
		<WikiGate project={project}>
			{({ index: { data: index } }) => (
				<WikiShell project={project} index={index} current={page}>
					<Edits project={project} slug={page} />
				</WikiShell>
			)}
		</WikiGate>
	);
}

function Edits({ project, slug }: { project: string; slug: string }) {
	const history = useInfiniteQuery(historyQuery(project, slug));
	if (history.isPending) return <Spinner />;
	if (history.error) return <ErrorNote error={history.error} />;
	const commits = history.data.pages.flatMap((p) => p.commits);
	return (
		<Panel
			title={
				<span className="normal-case tracking-normal">
					History of{" "}
					<Link to="/$owner/$repo/wiki/$page" params={{ ...repoParams(project), page: slug }} className="text-fg hover:underline">
						{pageTitle(slug)}
					</Link>
				</span>
			}
		>
			{commits.length === 0 ? (
				<p className="p-4 text-sm text-faint">{history.hasNextPage ? "No edits in the history looked at so far." : "No edits to this page."}</p>
			) : (
				<ol className="divide-y divide-line">
					{commits.map((c) => (
						<li key={c.hash} className="flex items-start gap-3 px-4 py-2.5">
							<GitCommitHorizontal className={cx("mt-0.5 size-4 shrink-0", c.change === "deleted" ? "text-rose-300" : "text-faint")} />
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm text-fg">{c.message.split("\n")[0]}</p>
								<p className="text-xs text-faint">
									{c.author.name} · <TimeAgo at={c.committedAt} />
									{c.change === "deleted" && " · deleted the page"}
								</p>
							</div>
							<Oid oid={c.hash} />
						</li>
					))}
				</ol>
			)}
			{history.hasNextPage && (
				<div className="border-t border-line p-3 text-center">
					<Button className="text-xs" busy={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
						Look further back
					</Button>
				</div>
			)}
		</Panel>
	);
}
