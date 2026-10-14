import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "../components/ui.tsx";
import { WikiEditor, WikiGate, WikiShell } from "../components/wiki.tsx";

type Search = { title?: string };

// A new page; `title` comes from a link to a page that doesn't exist yet. "_new" can't be a page's name.
export const Route = createFileRoute("/$owner/$repo/wiki/_new")({
	validateSearch: (s: Record<string, unknown>): Search => ({ title: typeof s.title === "string" && s.title ? s.title : undefined }),
	component: NewWikiPage,
});

function NewWikiPage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { title } = Route.useSearch();
	return (
		<WikiGate project={project}>
			{({ index: { data: index }, canEdit }) =>
				canEdit ? (
					<WikiShell project={project} index={index}>
						{/* Edits elsewhere don't get in the way of a new page; one with the same name does. */}
						<WikiEditor key={title} project={project} index={index} initialTitle={title ?? (index.pages.length === 0 ? "Home" : "")} />
					</WikiShell>
				) : (
					<Empty title="You can't edit this wiki">People with write access to the repository can, unless it's archived.</Empty>
				)
			}
		</WikiGate>
	);
}
