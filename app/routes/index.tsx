import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Landing } from "../components/landing/page.tsx";
import { RepoList } from "../components/repos.tsx";
import { ErrorNote, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/")({
	head: () => ({
		links: [
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{ rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
			{ rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" },
		],
	}),
	component: Home,
});

function Home() {
	const viewer = useViewer();
	const me = viewer.data;
	const mine = useQuery({ queryKey: keys.repos(me?.username), queryFn: () => api.repos(me?.username), enabled: Boolean(me) });
	const explore = useQuery({ queryKey: keys.repos(), queryFn: () => api.repos(), enabled: Boolean(me) });
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
					<h1 className="text-lg font-semibold">Your repositories</h1>
					<Link to="/new" className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400">
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
				<h2 className="text-sm font-semibold text-dim">Explore public repositories</h2>
				{explore.isPending ? <Spinner /> : <ErrorNote error={explore.error} />}
				{explore.data && <RepoList repos={publicRepos} showOwner empty={{ title: "No public repositories yet" }} />}
			</section>
		</main>
	);
}
