import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GitBranch, Lock, Plus, Terminal } from "lucide-react";
import { RepoList } from "../components/repos.tsx";
import { ErrorNote, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	const viewer = useViewer();
	const me = viewer.data;
	const mine = useQuery({ queryKey: keys.repos(me?.username), queryFn: () => api.repos(me?.username), enabled: Boolean(me) });
	const explore = useQuery({ queryKey: keys.repos(), queryFn: () => api.repos() });
	const publicRepos = (explore.data ?? []).filter((r) => r.visibility === "public" && r.owner !== me?.username);

	return (
		<main className="mx-auto max-w-[1100px] space-y-8 px-5 py-8">
			{viewer.isPending ? (
				<Spinner />
			) : me ? (
				<section className="space-y-3">
					<div className="flex items-center justify-between gap-3">
						<h1 className="text-lg font-semibold">Your repositories</h1>
						<Link to="/new" className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400">
							<Plus className="size-4" />
							New repository
						</Link>
					</div>
					{mine.isPending ? <Spinner /> : <ErrorNote error={mine.error} />}
					{mine.data && (
						<RepoList repos={mine.data} empty={{ title: "No repositories yet", body: "Create one, then push to it with git." }} />
					)}
				</section>
			) : (
				<section className="rounded-xl border border-line bg-panel p-8">
					<h1 className="text-2xl font-semibold tracking-tight">Git hosting for people and their agents.</h1>
					<p className="mt-2 max-w-2xl text-sm text-dim">
						Create a repository, push to it with plain <code className="font-mono text-fg">git</code>, and browse it here. Hundreds of agents
						can work on the same repository at once, each on its own fork, landing through a merge queue. Runs on Cloudflare Artifacts.
					</p>
					<div className="mt-5 flex flex-wrap gap-2">
						<Link to="/signup" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400">
							Create an account
						</Link>
						<Link to="/login" className="rounded-md border border-line-strong bg-raised px-4 py-2 text-sm text-fg hover:border-faint">
							Sign in
						</Link>
					</div>
					<ul className="mt-6 grid gap-3 text-xs text-dim sm:grid-cols-3">
						<li className="flex gap-2">
							<Terminal className="size-4 shrink-0 text-accent" />
							<code className="font-mono">git push</code> over HTTPS with a personal access token
						</li>
						<li className="flex gap-2">
							<Lock className="size-4 shrink-0 text-accent" />
							Public or private repositories
						</li>
						<li className="flex gap-2">
							<GitBranch className="size-4 shrink-0 text-accent" />
							Branches, history, diffs, archives
						</li>
					</ul>
				</section>
			)}

			<section className="space-y-3">
				<h2 className="text-sm font-semibold text-dim">Explore public repositories</h2>
				{explore.isPending ? <Spinner /> : <ErrorNote error={explore.error} />}
				{explore.data && <RepoList repos={publicRepos} showOwner empty={{ title: "No public repositories yet" }} />}
			</section>
		</main>
	);
}
