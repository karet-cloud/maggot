import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BookMarked, GitFork, Search as SearchIcon, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { ArchivedBadge, ForkedFrom } from "../components/repos.tsx";
import { buttonClass, cx, Empty, ErrorNote, Input, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, type RepoInfo } from "../lib/api.ts";

type Search = { q?: string; sort?: "created" };

// Every public repository, most starred first, open to anyone signed in or not. The search box narrows
// the list in place; /search is the one that also finds your private repositories.
export const Route = createFileRoute("/explore")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		q: typeof s.q === "string" && s.q ? s.q : undefined,
		sort: s.sort === "created" ? "created" : undefined,
	}),
	head: () => ({ meta: [{ title: "Explore · maggot" }] }),
	component: Explore,
});

const SORTS = [
	[undefined, "Most stars"],
	["created", "Newest"],
] as const;

function Explore() {
	const { q = "", sort } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [text, setText] = useState(q);
	useEffect(() => setText(q), [q]);
	const filter = { q: q || undefined, sort: sort ?? ("stars" as const), visibility: "public" as const };
	const repos = useQuery({ queryKey: keys.repos(filter), queryFn: () => api.repos(filter) });
	return (
		<main className="mx-auto max-w-[1080px] px-5">
			<section className="pt-16 pb-10 text-center">
				<h1 className="text-[34px] leading-[1.1] font-semibold tracking-[-0.02em] sm:text-[44px]">Explore repositories</h1>
				<p className="mx-auto mt-4 max-w-[52ch] text-[16px] leading-relaxed text-dim">
					Everything public on maggot. Browse the code, read the issues and pull requests, or fork one to start your own.
				</p>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void navigate({ search: { q: text.trim() || undefined, sort } });
					}}
					className="relative mx-auto mt-8 max-w-[560px]"
				>
					<SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
					<Input
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder="Filter by owner, name or description"
						aria-label="Filter repositories"
						className="h-11 rounded-lg pl-10 text-[15px]"
					/>
				</form>
			</section>

			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
				<p className="text-[13px] text-dim">
					{repos.data ? `${repos.data.length}${repos.data.length === 100 ? "+" : ""} public repositories` : " "}
					{q && (
						<>
							{" "}
							matching <span className="text-fg">“{q}”</span>
						</>
					)}
				</p>
				<div className="flex overflow-hidden rounded-md border border-line-strong text-[13px]">
					{SORTS.map(([value, label]) => (
						<button
							key={label}
							type="button"
							onClick={() => void navigate({ search: { q: q || undefined, sort: value } })}
							className={cx("px-3 py-1.5", sort === value ? "bg-raised font-medium text-fg" : "text-dim hover:text-fg")}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			<div className="py-6">
				{repos.isPending ? <Spinner /> : <ErrorNote error={repos.error} />}
				{repos.data &&
					(repos.data.length === 0 ? (
						<Empty icon={<BookMarked className="size-6" />} title={q ? "No public repositories match" : "No public repositories yet"}>
							{q ? (
								"Try a shorter or different word."
							) : (
								<Link to="/new" className={buttonClass("primary", "mt-3")}>
									Create the first one
								</Link>
							)}
						</Empty>
					) : (
						<ul className="grid gap-4 md:grid-cols-2">
							{repos.data.map((r) => (
								<RepoCard key={r.fullName} repo={r} />
							))}
						</ul>
					))}
			</div>
		</main>
	);
}

/** A public repository as a card: the landing page's framed boxes, linking to the repository. */
function RepoCard({ repo: r }: { repo: RepoInfo }) {
	return (
		<li className="flex min-w-0 flex-col rounded-xl border border-line bg-panel p-5 shadow-(--shadow-frame) transition-colors hover:border-line-strong">
			<div className="flex min-w-0 items-center gap-2">
				<Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="min-w-0 truncate font-mono text-[14px] hover:text-accent">
					<span className="text-dim">{r.owner} / </span>
					<span className="font-semibold">{r.name}</span>
				</Link>
				{r.archivedAt && <ArchivedBadge />}
			</div>
			{r.forkOf && <ForkedFrom source={r.forkOf} className="mt-1" />}
			<p className={cx("mt-2 line-clamp-2 flex-1 text-[14px] leading-relaxed", r.description ? "text-dim" : "text-faint")}>{r.description || "No description"}</p>
			<p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-faint">
				<span className="flex items-center gap-1">
					<Star className="size-3.5" />
					{r.stars}
				</span>
				<span className="flex items-center gap-1">
					<GitFork className="size-3.5" />
					{r.forks}
				</span>
				<span className="font-mono">{r.defaultBranch}</span>
				<span>
					created <TimeAgo at={r.createdAt} />
				</span>
			</p>
		</li>
	);
}
