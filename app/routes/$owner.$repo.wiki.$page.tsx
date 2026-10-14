import { createFileRoute } from "@tanstack/react-router";
import { WikiGate, WikiPageView } from "../components/wiki.tsx";

export const Route = createFileRoute("/$owner/$repo/wiki/$page")({ component: WikiPageRoute });

function WikiPageRoute() {
	const { owner, repo, page } = Route.useParams();
	const project = `${owner}/${repo}`;
	return <WikiGate project={project}>{({ index, canEdit }) => <WikiPageView project={project} index={index.data} slug={page} canEdit={canEdit} />}</WikiGate>;
}
