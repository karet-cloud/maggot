import { createFileRoute, Link } from "@tanstack/react-router";
import { HOME } from "../../src/wiki-pages.ts";
import { WikiGate, WikiPageView, wikiPageQuery, wikiQueries, wikiQuery, WikiShell, WikiWelcome } from "../components/wiki.tsx";
import { Panel } from "../components/ui.tsx";
import { repoParams } from "../lib/api.ts";
import { preload } from "../lib/queries.ts";

// The wiki's landing page: Home, or the list of pages when there's no Home, or the welcome when there's nothing yet.
export const Route = createFileRoute("/$owner/$repo/wiki/")({
	loader: ({ context, params }) => {
		const project = `${params.owner}/${params.repo}`;
		// Home's exact name is known once the index is cached.
		const home = context.queryClient.getQueryData(wikiQuery(project).queryKey)?.pages.find(isHome);
		return preload(context.queryClient, ...wikiQueries(context.queryClient, project), home && wikiPageQuery(project, home.slug));
	},
	component: WikiHome,
});

const isHome = (p: { slug: string }) => p.slug.toLowerCase() === HOME.toLowerCase();

function WikiHome() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	return (
		<WikiGate project={project}>
			{({ index: { data: index }, canEdit }) => {
				if (index.pages.length === 0) return <WikiWelcome project={project} canEdit={canEdit} />;
				const home = index.pages.find(isHome);
				if (home) return <WikiPageView project={project} index={index} slug={home.slug} canEdit={canEdit} />;
				return (
					<WikiShell project={project} index={index}>
						<Panel title="Pages">
							<ul className="divide-y divide-line text-sm">
								{index.pages.map((p) => (
									<li key={p.slug}>
										<Link to="/$owner/$repo/wiki/$page" params={{ ...repoParams(project), page: p.slug }} className="block px-4 py-2 text-accent hover:bg-raised">
											{p.title}
										</Link>
									</li>
								))}
							</ul>
						</Panel>
					</WikiShell>
				);
			}}
		</WikiGate>
	);
}
