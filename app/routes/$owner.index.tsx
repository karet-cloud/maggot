import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { BookMarked, Building2, Star, Users, UsersRound } from "lucide-react";
import { OrgHeader, People, Teams } from "../components/org.tsx";
import type { ReactNode } from "react";
import { RepoList } from "../components/repos.tsx";
import { ErrorNote, Spinner } from "../components/ui.tsx";
import { routeName } from "../../src/names.ts";
import { api, keys, type RepoFilter } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/$owner/")({
	// A page's own first segment with no page of its own (/orgs, say) isn't a profile: no account can have that name.
	beforeLoad: ({ params }) => {
		if (routeName(params.owner)) throw notFound();
	},
	validateSearch: (search: Record<string, unknown>): { tab?: "stars" | "people" | "teams" } =>
		search.tab === "stars" || search.tab === "people" || search.tab === "teams" ? { tab: search.tab } : {},
	component: Profile,
});

function Profile() {
	const { owner } = Route.useParams();
	const { tab } = Route.useSearch();
	const viewer = useViewer();
	const filter: RepoFilter = tab === "stars" ? { starredBy: owner } : { owner };
	const repos = useQuery({ queryKey: keys.repos(filter), queryFn: () => api.repos(filter), enabled: tab !== "people" && tab !== "teams" });
	// The same URLs serve people and organizations; an organization answers this.
	const org = useQuery({ queryKey: keys.org(owner), queryFn: () => api.org(owner), retry: false });
	const self = viewer.data?.username === owner;
	if (org.data) {
		const o = org.data;
		return (
			<main className="mx-auto max-w-[1100px] space-y-4 px-5 py-8">
				<OrgHeader org={o} />
				<nav className="flex gap-1 border-b border-line">
					<ProfileTab owner={owner} active={!tab || tab === "stars" || !o.role} icon={<BookMarked className="size-3.5" />} label="Repositories" />
					{o.role && <ProfileTab owner={owner} tab="people" active={tab === "people"} icon={<Users className="size-3.5" />} label="People" />}
					{o.role && <ProfileTab owner={owner} tab="teams" active={tab === "teams"} icon={<UsersRound className="size-3.5" />} label="Teams" />}
				</nav>
				{tab === "people" && o.role ? (
					<People org={o} />
				) : tab === "teams" && o.role ? (
					<Teams org={o} />
				) : (
					<>
						{repos.isPending ? <Spinner /> : <ErrorNote error={repos.error} />}
						{repos.data && <RepoList repos={repos.data} empty={{ title: o.role ? "No repositories yet" : `${o.displayName} has no public repositories` }} />}
					</>
				)}
			</main>
		);
	}
	return (
		<main className="mx-auto max-w-[1100px] space-y-4 px-5 py-8">
			<div className="flex items-center gap-3">
				<div className="flex size-12 items-center justify-center rounded-full bg-accent/15 font-mono text-lg text-accent">{owner.slice(0, 2)}</div>
				<div>
					<h1 className="font-mono text-xl font-semibold">{owner}</h1>
					<p className="text-xs text-dim">{tab === "stars" ? (self ? "Repositories you starred" : "Repositories they starred") : self ? "Your repositories, public and private" : "Public repositories"}</p>
				</div>
				{self && (
					<Link to="/orgs/new" className="ml-auto flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-fg hover:border-faint">
						<Building2 className="size-3.5" />
						New organization
					</Link>
				)}
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

function ProfileTab({ owner, tab, active, icon, label }: { owner: string; tab?: "stars" | "people" | "teams"; active: boolean; icon: ReactNode; label: string }) {
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
