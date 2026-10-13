import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RepoList } from "../components/repos.tsx";
import { ErrorNote, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/$owner/")({ component: Profile });

function Profile() {
	const { owner } = Route.useParams();
	const viewer = useViewer();
	const repos = useQuery({ queryKey: keys.repos(owner), queryFn: () => api.repos(owner) });
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
			{repos.isPending ? <Spinner /> : <ErrorNote error={repos.error} />}
			{repos.data && <RepoList repos={repos.data} empty={{ title: self ? "No repositories yet" : `${owner} has no public repositories` }} />}
		</main>
	);
}
