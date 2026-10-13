import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { RepoList } from "../components/repos.tsx";
import { cx, ErrorNote, Input, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";

type Search = { q?: string; sort?: "stars" };

// Finds repositories by owner, name or description. Code search lives inside each repository.
export const Route = createFileRoute("/search")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		q: typeof s.q === "string" && s.q ? s.q : undefined,
		sort: s.sort === "stars" ? "stars" : undefined,
	}),
	component: SearchPage,
});

function SearchPage() {
	const { q = "", sort } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [text, setText] = useState(q);
	useEffect(() => setText(q), [q]);
	const filter = { q, sort: sort ?? ("created" as const) };
	const repos = useQuery({ queryKey: keys.repos(filter), queryFn: () => api.repos(filter), enabled: q.length > 0 });
	return (
		<main className="mx-auto max-w-[1100px] space-y-4 px-5 py-8">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void navigate({ search: { q: text.trim() || undefined, sort } });
				}}
				className="flex items-center gap-2"
			>
				<div className="relative flex-1">
					<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
					<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search repositories" className="pl-9" autoFocus aria-label="Search repositories" />
				</div>
			</form>
			{q && (
				<div className="flex items-center justify-between text-xs text-dim">
					<span>
						{repos.data ? `${repos.data.length}${repos.data.length === 100 ? "+" : ""} repositories` : " "} matching <span className="text-fg">“{q}”</span>
					</span>
					<div className="flex overflow-hidden rounded-md border border-line-strong">
						{(
							[
								[undefined, "Newest"],
								["stars", "Most stars"],
							] as const
						).map(([value, label]) => (
							<button
								key={label}
								type="button"
								onClick={() => void navigate({ search: { q, sort: value } })}
								className={cx("px-2.5 py-1", sort === value ? "bg-raised text-fg" : "text-faint hover:text-fg")}
							>
								{label}
							</button>
						))}
					</div>
				</div>
			)}
			{!q && <p className="text-sm text-dim">Search public repositories (and your own private ones) by owner, name or description. To search code, open a repository and use its code search.</p>}
			{q && (repos.isPending ? <Spinner /> : <ErrorNote error={repos.error} />)}
			{repos.data && <RepoList repos={repos.data} showOwner empty={{ title: "No repositories match", body: "Try a shorter or different word." }} />}
		</main>
	);
}
