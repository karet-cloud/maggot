import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { MarkdownEditor } from "../components/markdown-editor.tsx";
import { Button, Empty, ErrorNote, Field, Input, Panel } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { preload, projectQuery } from "../lib/queries.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

export const Route = createFileRoute("/$owner/$repo/issues/new")({
	loader: ({ context, params }) => preload(context.queryClient, projectQuery(`${params.owner}/${params.repo}`)),
	component: NewIssue,
});

function NewIssue() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const info = useQuery(projectQuery(project));
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [labels, setLabels] = useState("");
	const create = useMutation({
		mutationFn: () =>
			api.createIssue(project, {
				title: title.trim(),
				body,
				labels: info.data?.repo.canWrite ? labels.split(",").map((l) => l.trim()).filter(Boolean) : undefined,
			}),
		onSuccess: (issue) => {
			void queryClient.invalidateQueries({ queryKey: keys.issues(project) });
			void queryClient.invalidateQueries({ queryKey: keys.project(project) });
			void navigate({ to: "/$owner/$repo/issues/$number", params: { ...repoParams(project), number: String(issue.number) } });
		},
	});

	if (!viewer.isPending && !viewer.data) {
		return (
			<Empty title="Sign in to open an issue">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				or create an account first.
			</Empty>
		);
	}
	if (info.data?.repo.archivedAt) return <Empty title="This repository is archived">It's read-only, so new issues can't be opened.</Empty>;
	return (
		<Panel title="New issue">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate();
				}}
				className="space-y-3 p-4"
			>
				<Field label="Title">
					<Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={256} autoFocus placeholder="What's wrong, or what would help?" />
				</Field>
				<MarkdownEditor value={body} onChange={setBody} project={project} label="Description" placeholder="Steps to reproduce, what you expected, what happened…" rows={10} />
				{info.data?.repo.canWrite && (
					<Field label="Labels" hint="Comma-separated, e.g. bug, help wanted">
						<Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Optional" />
					</Field>
				)}
				{needsVerification && <p className="text-xs text-amber-200">Verify your email address before opening issues.</p>}
				<ErrorNote error={create.error} />
				<div className="flex justify-end gap-2">
					<Link to="/$owner/$repo/issues" params={repoParams(project)} className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-fg">
						Cancel
					</Link>
					<Button type="submit" variant="primary" busy={create.isPending} disabled={!title.trim() || needsVerification}>
						Open issue
					</Button>
				</div>
			</form>
		</Panel>
	);
}
