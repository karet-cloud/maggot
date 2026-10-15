import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { GitBranch, GitCommitHorizontal, Tag } from "lucide-react";
import { useMemo } from "react";
import { CommitList } from "../components/commits.tsx";
import { BranchSelect } from "../components/refs.tsx";
import { Button, cx, Empty, ErrorNote, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, repoParams, type GraphCommit } from "../lib/api.ts";
import { layoutGraph, type GraphRow } from "../lib/graph-layout.ts";

type Search = { ref?: string; view?: "graph"; path?: string };

export const Route = createFileRoute("/$owner/$repo/history")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		ref: typeof s.ref === "string" && s.ref ? s.ref : undefined,
		view: s.view === "graph" ? "graph" : undefined,
		path: typeof s.path === "string" && s.path ? s.path : undefined,
	}),
	component: HistoryPage,
});

function HistoryPage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { ref, view, path } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const sub = (active: boolean) =>
		cx("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", active ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg");
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line">
				<nav className="flex gap-1">
					<Link from={Route.fullPath} search={{ ref, path }} className={sub(view !== "graph")}>
						<GitCommitHorizontal className="size-3.5" />
						Commits
					</Link>
					<Link from={Route.fullPath} search={{ view: "graph" }} className={sub(view === "graph")}>
						<GitBranch className="size-3.5" />
						Graph
					</Link>
				</nav>
				{view !== "graph" && (
					<div className="mb-1.5">
						<BranchSelect project={project} value={ref} onChange={(next) => void navigate({ search: { ref: next, path } })} />
					</div>
				)}
			</div>
			{view === "graph" ? <GraphView project={project} /> : path ? <FileCommits project={project} refName={ref} path={path} /> : <Commits project={project} refName={ref} />}
		</div>
	);
}

function Commits({ project, refName }: { project: string; refName?: string }) {
	const log = useQuery({ queryKey: keys.log(project, refName), queryFn: () => api.log(project, refName, 100) });
	if (log.isPending) return <Spinner />;
	if (log.error) return <ErrorNote error={log.error} />;
	if (log.data.length === 0) return <Empty icon={<GitCommitHorizontal className="size-6" />} title="No commits yet" />;
	return (
		<Panel title={`${refName ?? "Default branch"} · ${log.data.length === 1 ? "1 commit" : `${log.data.length} most recent commits`} (first parents)`}>
			<CommitList commits={log.data} project={project} refName={refName} />
		</Panel>
	);
}

/** The commits that changed one file, a page at a time. */
function FileCommits({ project, refName, path }: { project: string; refName?: string; path: string }) {
	const pages = useInfiniteQuery({
		queryKey: keys.fileHistory(project, path, refName),
		queryFn: ({ pageParam }) => api.fileHistory(project, path, refName, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next ?? undefined,
	});
	if (pages.isPending) return <Spinner />;
	if (pages.error) return <ErrorNote error={pages.error} />;
	const commits = pages.data.pages.flatMap((p) => p.commits);
	return (
		<Panel
			title={
				<span className="normal-case tracking-normal">
					History of <span className="font-mono text-fg">{path}</span>
				</span>
			}
			actions={
				<Link from={Route.fullPath} search={{ ref: refName }} className="text-[11px] text-faint hover:text-fg" aria-label="Show all commits">
					All files
				</Link>
			}
		>
			{commits.length === 0 ? (
				<p className="p-4 text-sm text-faint">{pages.hasNextPage ? "No changes in the commits looked at so far." : "No commits changed this file."}</p>
			) : (
				<CommitList commits={commits} project={project} refName={refName} />
			)}
			{pages.hasNextPage && (
				<div className="border-t border-line p-3 text-center">
					<Button className="text-xs" busy={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
						Look further back
					</Button>
				</div>
			)}
		</Panel>
	);
}

const ROW = 36;
const LANE = 14;
// Lane colours come from styles.css, so each theme gets shades that read on its background.
const COLORS = Array.from({ length: 10 }, (_, i) => `var(--lane-${i})`);
const laneX = (i: number) => LANE / 2 + i * LANE + 4;
const color = (i: number) => COLORS[i % COLORS.length];

function GraphView({ project }: { project: string }) {
	const graph = useQuery({ queryKey: keys.graph(project), queryFn: () => api.graph(project, 200) });
	const layout = useMemo(() => (graph.data ? layoutGraph(graph.data.commits) : null), [graph.data]);
	if (graph.isPending) return <Spinner />;
	if (graph.error) return <ErrorNote error={graph.error} />;
	if (!layout || graph.data.commits.length === 0) return <Empty icon={<GitBranch className="size-6" />} title="No commits yet" />;
	const width = laneX(Math.min(layout.width, 16) - 1) + LANE;
	return (
		<Panel title={`Every branch · ${graph.data.commits.length} most recent commits`}>
			<ol className="overflow-x-auto py-1">
				{graph.data.commits.map((c, i) => (
					<li key={c.hash} className="flex items-center gap-3 pr-4 hover:bg-raised/40" style={{ height: ROW }}>
						<GraphCell row={layout.rows[i]} width={width} merge={c.parents.length > 1} />
						<CommitLine project={project} commit={c} />
					</li>
				))}
			</ol>
			{graph.data.truncated && <p className="border-t border-line px-4 py-2 text-[11px] text-faint">Older history isn't shown; the commit list has more per branch.</p>}
		</Panel>
	);
}

function GraphCell({ row, width, merge }: { row: GraphRow; width: number; merge: boolean }) {
	const mid = ROW / 2;
	const x = laneX(row.col);
	const lines: { d: string; lane: number }[] = [];
	row.before.forEach((h, i) => {
		if (h === null) return;
		// Passing through, or joining this commit's lane.
		if (h === row.hash) {
			if (i !== row.col || !row.head) lines.push({ d: `M${laneX(i)} 0 C${laneX(i)} ${mid / 2} ${x} ${mid / 2} ${x} ${mid}`, lane: i });
		} else if (row.after[i] === h) lines.push({ d: `M${laneX(i)} 0 L${laneX(i)} ${ROW}`, lane: i });
	});
	for (const j of row.parentCols) {
		lines.push({ d: j === row.col ? `M${x} ${mid} L${x} ${ROW}` : `M${x} ${mid} C${x} ${ROW} ${laneX(j)} ${mid} ${laneX(j)} ${ROW}`, lane: j });
	}
	return (
		<svg width={width} height={ROW} className="shrink-0" aria-hidden>
			{lines.map((l, k) => (
				<path key={k} d={l.d} style={{ stroke: color(l.lane) }} strokeWidth={2} fill="none" />
			))}
			<circle cx={x} cy={mid} r={merge ? 3.5 : 4} style={{ fill: merge ? "var(--color-bg)" : color(row.col), stroke: color(row.col) }} strokeWidth={2} />
		</svg>
	);
}

function CommitLine({ project, commit: c }: { project: string; commit: GraphCommit }) {
	const subject = c.message.split("\n")[0];
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			{c.branches.map((b) => (
				<Link
					key={b}
					to="/$owner/$repo/history"
					params={repoParams(project)}
					search={{ ref: b }}
					className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[11px] text-accent ring-1 ring-accent/30 ring-inset hover:bg-accent/25"
				>
					{b}
				</Link>
			))}
			{c.tags.map((t) => (
				<span key={t} className="flex shrink-0 items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 font-mono text-[11px] text-amber-300 ring-1 ring-amber-400/30 ring-inset">
					<Tag className="size-3" />
					{t}
				</span>
			))}
			<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: c.hash }} className="min-w-0 truncate text-[13px] text-fg hover:text-accent">
				{subject}
			</Link>
			<span className="ml-auto hidden shrink-0 text-[11px] text-faint sm:inline">
				{c.author.name} · <TimeAgo at={c.committedAt} />
			</span>
			<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: c.hash }} className="shrink-0 font-mono text-[12px] text-dim hover:text-accent">
				{c.hash.slice(0, 7)}
			</Link>
		</div>
	);
}
