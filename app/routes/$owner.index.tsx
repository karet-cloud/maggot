import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BookMarked, Star } from "lucide-react";
import type { ReactNode } from "react";
import { RepoList } from "../components/repos.tsx";
import { ErrorNote, Spinner } from "../components/ui.tsx";
import { api, keys, type RepoFilter } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/$owner/")({
	validateSearch: (search: Record<string, unknown>): { tab?: "stars" } => (search.tab === "stars" ? { tab: "stars" } : {}),
	component: Profile,
});

function Profile() {
	const { owner } = Route.useParams();
	const { tab } = Route.useSearch();
	const viewer = useViewer();
	const filter: RepoFilter = tab === "stars" ? { starredBy: owner } : { owner };
	const repos = useQuery({ queryKey: keys.repos(filter), queryFn: () => api.repos(filter) });
	const self = viewer.data?.username === owner;
	return (
		<main className="mx-auto max-w-[1100px] space-y-4 px-5 py-8">
			<div className="flex items-center gap-3">
				<div className="flex size-12 items-center justify-center rounded-full bg-accent/15 font-mono text-lg text-accent">{owner.slice(0, 2)}</div>
				<div>
					<h1 className="font-mono text-xl font-semibold">{owner}</h1>
					<p className="text-xs text-dim">{self ? "Your repositories, public and private" : "Public repositories"}</p>
				</div>
			</div>
			<nav className="flex gap-1 border-b border-line">
				<ProfileTab owner={owner} active={tab !== "stars"} icon={<BookMarked className="size-3.5" />} label="Repositories" />
				<ProfileTab owner={owner} tab="stars" active={tab === "stars"} icon={<Star className="size-3.5" />} label="Stars" />
			</nav>
			{repos.isPending ? <Spinner /> : <ErrorNote error={repos.error} />}
			{repos.data && (
				<RepoList
					repos={repos.data}
					showOwner={tab === "stars"}
					empty={
						tab === "stars"
							? { title: self ? "You haven't starred anything yet" : `${owner} hasn't starred any repositories you can see` }
							: { title: self ? "No repositories yet" : `${owner} has no public repositories` }
					}
				/>
			)}
		</main>
	);
}

function ProfileTab({ owner, tab, active, icon, label }: { owner: string; tab?: "stars"; active: boolean; icon: ReactNode; label: string }) {
	return (
		<Link
			to="/$owner"
			params={{ owner }}
			search={tab ? { tab } : {}}
			className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${active ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg"}`}
		>
			{icon}
			{label}
		</Link>
	);
}
