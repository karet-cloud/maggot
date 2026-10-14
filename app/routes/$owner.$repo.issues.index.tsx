import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleDot, MessageSquare, Plus, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { IssueStateIcon, Label } from "../components/issues.tsx";
import { cx, Empty, ErrorNote, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, repoParams, type IssueState } from "../lib/api.ts";
import { preload, projectQuery } from "../lib/queries.ts";

type Search = { state?: IssueState | "all"; q?: string; label?: string };

const issuesQuery = (project: string, state: IssueState | "all", q?: string, label?: string) =>
	queryOptions({ queryKey: [...keys.issues(project), state, q ?? "", label ?? ""], queryFn: () => api.issues(project, { state, q, label }) });

export const Route = createFileRoute("/$owner/$repo/issues/")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		state: s.state === "closed" || s.state === "all" ? s.state : undefined,
		q: typeof s.q === "string" && s.q ? s.q : undefined,
		label: typeof s.label === "string" && s.label ? s.label : undefined,
	}),
	loaderDeps: ({ search }) => ({ state: search.state ?? "open", q: search.q, label: search.label }),
	loader: ({ context, params, deps }) => {
		const project = `${params.owner}/${params.repo}`;
		return preload(context.queryClient, issuesQuery(project, deps.state, deps.q, deps.label), projectQuery(project));
	},
	component: Issues,
});

function Issues() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const state = search.state ?? "open";
	const list = useQuery({ ...issuesQuery(project, state, search.q, search.label), placeholderData: keepPreviousData });
	const info = useQuery(projectQuery(project));
	const [q, setQ] = useState(search.q ?? "");
	useEffect(() => setQ(search.q ?? ""), [search.q]);
	const archived = Boolean(info.data?.repo.archivedAt);

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void navigate({ search: { ...search, q: q.trim() || undefined } });
					}}
					className="relative min-w-56 flex-1"
				>
					<Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" />
					<input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search issues"
						aria-label="Search issues"
						className="w-full rounded-md border border-line-strong bg-bg py-1.5 pr-3 pl-8 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none"
					/>
				</form>
				{search.label && (
					<span className="flex items-center gap-1">
						<Label name={search.label} />
						<Link from={Route.fullPath} search={{ ...search, label: undefined }} className="rounded p-0.5 text-faint hover:text-fg" aria-label="Clear the label filter">
							<X className="size-3.5" />
						</Link>
					</span>
				)}
				{!archived && (
					<Link
						to="/$owner/$repo/issues/new"
						params={repoParams(project)}
						className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
					>
						<Plus className="size-4" />
						New issue
					</Link>
				)}
			</div>

			<div className="overflow-hidden rounded-lg border border-line bg-panel">
				<div className="flex items-center gap-4 border-b border-line px-4 py-2.5 text-sm">
					{(["open", "closed"] as const).map((s) => (
						<Link
							key={s}
							from={Route.fullPath}
							search={{ ...search, state: s === "open" ? undefined : s }}
							className={cx("flex items-center gap-1.5", state === s ? "font-medium text-fg" : "text-dim hover:text-fg")}
						>
							<IssueStateIcon state={s} className={cx("size-3.5", state !== s && "text-faint")} />
							{list.data ? (s === "open" ? list.data.open : list.data.closed) : "…"} {s === "open" ? "Open" : "Closed"}
						</Link>
					))}
					<Link from={Route.fullPath} search={{ ...search, state: "all" }} className={cx(state === "all" ? "font-medium text-fg" : "text-dim hover:text-fg")}>
						All
					</Link>
					{list.isFetching && <Spinner className="ml-auto" />}
				</div>
				{list.isPending ? (
					<Spinner className="m-4" />
				) : list.error ? (
					<div className="p-4">
						<ErrorNote error={list.error} />
					</div>
				) : list.data.issues.length === 0 ? (
					<div className="p-4">
						<Empty icon={<CircleDot className="size-6" />} title={search.q || search.label ? "No issues match" : state === "closed" ? "No closed issues" : "No open issues"}>
							{!search.q && !search.label && state !== "closed" && !archived && "Issues track bugs, ideas and questions about this repository."}
						</Empty>
					</div>
				) : (
					<ul className="divide-y divide-line/60">
						{list.data.issues.map((issue) => (
							<li key={issue.number} className="flex items-start gap-3 px-4 py-3">
								<IssueStateIcon state={issue.state} className="mt-0.5 shrink-0" />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
										<Link
											to="/$owner/$repo/issues/$number"
											params={{ ...repoParams(project), number: String(issue.number) }}
											className="font-medium text-fg hover:text-accent"
										>
											{issue.title}
										</Link>
										{issue.labels.map((l) => (
											<Label key={l} name={l} active={l === search.label} onClick={() => void navigate({ search: { ...search, label: l } })} />
										))}
									</div>
									<p className="mt-0.5 text-[11px] text-faint">
										#{issue.number} {issue.state === "open" ? "opened" : "closed"} <TimeAgo at={issue.state === "open" ? issue.createdAt : (issue.closedAt ?? issue.updatedAt)} /> by{" "}
										{issue.author ?? "a deleted account"}
									</p>
								</div>
								{issue.comments > 0 && (
									<span className="flex shrink-0 items-center gap-1 text-xs text-faint">
										<MessageSquare className="size-3.5" />
										{issue.comments}
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
