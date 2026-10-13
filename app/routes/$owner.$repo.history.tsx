import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { GitCommitHorizontal } from "lucide-react";
import { CommitList } from "../components/commits.tsx";
import { Empty, ErrorNote, Panel, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";

export const Route = createFileRoute("/$owner/$repo/history")({ component: HistoryPage });

function HistoryPage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const log = useQuery({ queryKey: keys.log(project), queryFn: () => api.log(project, undefined, 100) });

	if (log.isPending) return <Spinner />;
	if (log.error) return <ErrorNote error={log.error} />;
	if (log.data.length === 0) return <Empty icon={<GitCommitHorizontal className="size-6" />} title="No commits yet" />;

	return (
		<Panel title={`Default branch · ${log.data.length} most recent commits`}>
			<CommitList commits={log.data} project={project} />
		</Panel>
	);
}
