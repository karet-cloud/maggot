import { createFileRoute } from "@tanstack/react-router";
import { WikiGate, WikiPageView, wikiPageQuery, wikiQueries } from "../components/wiki.tsx";
import { preload } from "../lib/queries.ts";

export const Route = createFileRoute("/$owner/$repo/wiki/$page")({
	loader: ({ context, params }) => {
		const project = `${params.owner}/${params.repo}`;
		return preload(context.queryClient, ...wikiQueries(context.queryClient, project), wikiPageQuery(project, params.page));
	},
	component: WikiPageRoute,
});

function WikiPageRoute() {
	const { owner, repo, page } = Route.useParams();
	const project = `${owner}/${repo}`;
	return <WikiGate project={project}>{({ index, canEdit }) => <WikiPageView project={project} index={index.data} slug={page} canEdit={canEdit} />}</WikiGate>;
}
