import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Landing } from "../components/landing/page.tsx";
import { RepoList } from "../components/repos.tsx";
import { buttonClass, ErrorNote, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { preload, viewerQuery } from "../lib/queries.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/")({
	loader: ({ context }) => {
		const me = context.queryClient.getQueryData(viewerQuery.queryKey);
		// Signed out, the home page is the landing page: nothing to load.
		return me ? preload(context.queryClient, reposQuery(me.username), reposQuery()) : undefined;
	},
	component: Home,
});

const reposQuery = (owner?: string) => queryOptions({ queryKey: keys.repos(owner), queryFn: () => api.repos(owner) });

function Home() {
	const viewer = useViewer();
	const me = viewer.data;
	const mine = useQuery({ ...reposQuery(me?.username), enabled: Boolean(me) });
	const explore = useQuery({ ...reposQuery(), enabled: Boolean(me) });
	const publicRepos = (explore.data ?? []).filter((r) => r.visibility === "public" && r.owner !== me?.username);

	if (viewer.isPending) {
		return (
			<main className="mx-auto max-w-[1100px] px-5 py-8">
				<Spinner />
			</main>
		);
	}
	if (!me) return <Landing />;

	return (
		<main className="mx-auto max-w-[1100px] space-y-8 px-5 py-8">
			<section className="space-y-3">
				<div className="flex items-center justify-between gap-3">
					<h1 className="text-2xl font-semibold tracking-tight">Your repositories</h1>
					<Link to="/new" className={buttonClass("primary")}>
						<Plus className="size-4" />
						New repository
					</Link>
				</div>
				{mine.isPending ? <Spinner /> : <ErrorNote error={mine.error} />}
				{mine.data && <RepoList repos={mine.data} empty={{ title: "No repositories yet", body: "Create one, then push to it with git." }} />}
			</section>

			<Link to="/parity" className="flex items-center justify-between rounded-lg border border-line bg-panel px-4 py-3 text-sm hover:border-line-strong">
				<span>
					<span className="font-medium text-fg">How close is maggot to GitHub?</span>
					<span className="ml-2 text-dim">The feature checklist, kept up to date.</span>
				</span>
				<span className="text-accent">See the checklist →</span>
			</Link>

			<section className="space-y-3">
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-sm font-semibold text-dim">Explore public repositories</h2>
					<Link to="/explore" search={{ sort: "created" }} className="text-sm text-accent hover:underline">
						See all →
					</Link>
				</div>
				{explore.isPending ? <Spinner /> : <ErrorNote error={explore.error} />}
				{explore.data && <RepoList repos={publicRepos} showOwner empty={{ title: "No public repositories yet" }} />}
			</section>
		</main>
	);
}
