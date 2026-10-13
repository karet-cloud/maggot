import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { GitFork } from "lucide-react";
import { RepoList } from "../components/repos.tsx";
import { ErrorNote, Panel, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";

export const Route = createFileRoute("/$owner/$repo/forks")({ component: Forks });

function Forks() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const forks = useQuery({ queryKey: keys.forks(project), queryFn: () => api.forks(project) });
	return (
		<Panel
			title={
				<span className="flex items-center gap-1.5">
					<GitFork className="size-3.5" />
					Forks
				</span>
			}
		>
			<div className="p-3">
				{forks.isPending ? <Spinner /> : <ErrorNote error={forks.error} />}
				{forks.data && <RepoList repos={forks.data} showOwner empty={{ title: "No forks yet", body: "Fork this repository to get your own copy of every branch." }} />}
			</div>
		</Panel>
	);
}
