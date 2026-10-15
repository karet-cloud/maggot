import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderCode } from "lucide-react";
import { ChecksBadge } from "../components/actions.tsx";
import { DiffView } from "../components/diff.tsx";
import { ErrorNote, Oid, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";
import { preload } from "../lib/queries.ts";

type Search = { ref?: string };

export const Route = createFileRoute("/$owner/$repo/commit/$hash")({
	validateSearch: (s: Record<string, unknown>): Search => ({ ref: typeof s.ref === "string" && s.ref ? s.ref : undefined }),
	loaderDeps: ({ search }) => ({ ref: search.ref }),
	loader: ({ context, params, deps }) => preload(context.queryClient, commitQuery(`${params.owner}/${params.repo}`, params.hash, deps.ref)),
	component: CommitPage,
});

const commitQuery = (project: string, hash: string, ref?: string) =>
	queryOptions({ queryKey: [...keys.commit(project, hash), ref ?? ""], queryFn: () => api.commit(project, hash, ref), staleTime: Infinity });

const TASK_MERGE = /^Merge task (t[0-9a-f]+): /;

function CommitPage() {
	const { owner, repo, hash } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { ref } = Route.useSearch();
	const result = useQuery(commitQuery(project, hash, ref));

	if (result.isPending) return <Spinner />;
	if (result.error) return <ErrorNote error={result.error} />;
	const { commit: c, diff } = result.data;
	const [subject, ...rest] = c.message.split("\n");
	const body = rest.join("\n").trim();
	const taskId = TASK_MERGE.exec(subject)?.[1];
	const sameCommitter = c.committer.email === c.author.email && c.committer.name === c.author.name;

	return (
		<div className="space-y-4">
			<Panel>
				<div className="space-y-3 p-4">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<h2 className="min-w-0 text-lg leading-snug font-semibold break-words">{subject}</h2>
						<Link
							to="/$owner/$repo"
							params={repoParams(project)}
							search={{ ref: ref?.startsWith("task:") ? ref : c.hash }}
							className="flex shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 py-1 text-xs text-fg hover:border-faint"
						>
							<FolderCode className="size-3.5" />
							Browse files
						</Link>
					</div>
					{body && <pre className="font-sans text-sm whitespace-pre-wrap text-dim">{body}</pre>}
					{taskId && (
						<p className="text-xs text-dim">
							Merged by the queue for task{" "}
							<Link to="/$owner/$repo/t/$task" params={{ ...repoParams(project), task: taskId }} className="font-mono text-accent hover:underline">
								{taskId}
							</Link>
						</p>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-4 py-2.5 text-xs text-dim">
					<span>
						<b className="font-medium text-fg">{c.author.name}</b> authored <TimeAgo at={c.authoredAt} />
					</span>
					{!sameCommitter && (
						<span>
							<b className="font-medium text-fg">{c.committer.name}</b> committed <TimeAgo at={c.committedAt} />
						</span>
					)}
					<span className="flex items-center gap-1.5">
						{c.parents.length === 0 ? "root commit" : c.parents.length > 1 ? "parents" : "parent"}
						{c.parents.map((p) => (
							<Link
								key={p}
								to="/$owner/$repo/commit/$hash"
								params={{ ...repoParams(project), hash: p }}
								search={{ ref }}
								className="font-mono text-[12px] text-accent hover:underline"
							>
								{shortOid(p)}
							</Link>
						))}
					</span>
					<span className="ml-auto flex items-center gap-1.5">
						<ChecksBadge project={project} sha={c.hash} />
						commit <Oid oid={c.hash} />
					</span>
				</div>
			</Panel>
			{c.parents.length > 1 && (
				<p className="text-xs text-faint">Showing changes against the first parent ({shortOid(c.parents[0])}), the branch this was merged into.</p>
			)}
			<DiffView diff={diff} project={project} viewRef={ref?.startsWith("task:") ? ref : c.hash} />
		</div>
	);
}
