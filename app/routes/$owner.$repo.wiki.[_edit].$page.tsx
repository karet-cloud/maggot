import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Empty, ErrorNote, Spinner } from "../components/ui.tsx";
import { WikiEditor, WikiGate, WikiShell } from "../components/wiki.tsx";
import { api, type WikiIndex } from "../lib/api.ts";

// Edits (or renames) a page. Page names can't start with "_", so "_edit" never shadows one.
export const Route = createFileRoute("/$owner/$repo/wiki/_edit/$page")({ component: EditWikiPage });

function EditWikiPage() {
	const { owner, repo, page } = Route.useParams();
	const project = `${owner}/${repo}`;
	return (
		<WikiGate project={project}>
			{({ index: { data: index }, canEdit }) =>
				canEdit ? (
					<WikiShell project={project} index={index} current={page}>
						<EditForm project={project} index={index} slug={page} />
					</WikiShell>
				) : (
					<Empty title="You can't edit this wiki">People with write access to the repository can, unless it's archived.</Empty>
				)
			}
		</WikiGate>
	);
}

/**
 * The page as it was when editing started, outside the wiki's query keys, so live updates never move
 * the base under an open draft: saving after someone else's edit is refused instead.
 */
function EditForm({ project, index, slug }: { project: string; index: WikiIndex; slug: string }) {
	const [session] = useState(() => crypto.randomUUID());
	const page = useQuery({ queryKey: ["wiki-edit", project, session, slug], queryFn: () => api.wikiPage(project, slug), staleTime: Infinity, gcTime: 0 });
	if (page.isPending) return <Spinner />;
	if (page.error) return <ErrorNote error={page.error} />;
	return <WikiEditor project={project} index={index} page={page.data} baseCommit={page.data.head} />;
}
