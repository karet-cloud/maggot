import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RepoList } from "../components/repos.tsx";
import { cx, ErrorNote, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";

type Search = { sort?: "stars" };

// Public repositories, newest or most starred first, signed in or not.
export const Route = createFileRoute("/explore")({
	validateSearch: (s: Record<string, unknown>): Search => (s.sort === "stars" ? { sort: "stars" } : {}),
	head: () => ({ meta: [{ title: "Explore · maggot" }] }),
	component: Explore,
});

function Explore() {
	const { sort } = Route.useSearch();
	const filter = { sort: sort ?? ("created" as const) };
	const repos = useQuery({ queryKey: keys.repos(filter), queryFn: () => api.repos(filter) });
	const publicRepos = repos.data?.filter((r) => r.visibility === "public");
	return (
		<main className="mx-auto max-w-[1100px] space-y-4 px-5 py-8">
			<div className="flex items-center justify-between gap-3">
				<h1 className="text-lg font-semibold">Explore public repositories</h1>
				<div className="flex overflow-hidden rounded-md border border-line-strong text-xs">
					{(
						[
							[undefined, "Newest"],
							["stars", "Most stars"],
						] as const
					).map(([value, label]) => (
						<Link
							key={label}
							from={Route.fullPath}
							search={value ? { sort: value } : {}}
							className={cx("px-2.5 py-1", sort === value ? "bg-raised text-fg" : "text-faint hover:text-fg")}
						>
							{label}
						</Link>
					))}
				</div>
			</div>
			{repos.isPending ? <Spinner /> : <ErrorNote error={repos.error} />}
			{publicRepos && <RepoList repos={publicRepos} showOwner empty={{ title: "No public repositories yet" }} />}
		</main>
	);
}
