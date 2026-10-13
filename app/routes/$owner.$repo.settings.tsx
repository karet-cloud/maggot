import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { VisibilityBadge } from "../components/repos.tsx";
import { Button, ErrorNote, Field, Input, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, type Visibility } from "../lib/api.ts";

export const Route = createFileRoute("/$owner/$repo/settings")({ component: RepoSettings });

function RepoSettings() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const [description, setDescription] = useState("");
	useEffect(() => setDescription(info.data?.repo.description ?? ""), [info.data?.repo.description]);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: keys.project(project) });
		void queryClient.invalidateQueries({ queryKey: ["repos"] });
	};
	const update = useMutation({
		mutationFn: (patch: { visibility?: Visibility; description?: string | null }) => api.updateRepo(project, patch),
		onSuccess: refresh,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteRepo(project),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
			void navigate({ to: "/$owner", params: { owner } });
		},
	});

	if (info.isPending) return <Spinner />;
	if (!info.data?.repo.canWrite) return <p className="text-sm text-dim">Only the owner can change settings.</p>;
	const current = info.data.repo;
	const other: Visibility = current.visibility === "public" ? "private" : "public";
	return (
		<div className="max-w-2xl space-y-4">
			<Panel title="General">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						update.mutate({ description: description.trim() || null });
					}}
					className="space-y-3 p-4"
				>
					<Field label="Description">
						<Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
					</Field>
					<Button type="submit" busy={update.isPending && update.variables?.description !== undefined}>
						Save
					</Button>
				</form>
			</Panel>
			<Panel title="Visibility">
				<div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
					<p className="flex items-center gap-2 text-dim">
						This repository is <VisibilityBadge visibility={current.visibility} />
						{current.visibility === "public" ? "Anyone can browse and clone it." : "Only you can see and clone it."}
					</p>
					<Button
						busy={update.isPending && update.variables?.visibility !== undefined}
						onClick={() => confirm(`Make ${project} ${other}?`) && update.mutate({ visibility: other })}
					>
						Make {other}
					</Button>
				</div>
			</Panel>
			<ErrorNote error={update.error} />
			<Panel title="Danger zone" className="border-red-500/30">
				<div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
					<p className="text-dim">Delete the repository, its history, every agent fork, and all task records. This can't be undone.</p>
					<Button
						variant="danger"
						busy={remove.isPending}
						onClick={() => prompt(`Type ${project} to delete it`) === project && remove.mutate()}
					>
						<Trash2 className="size-4" />
						Delete
					</Button>
				</div>
				<div className="px-4 pb-3">
					<ErrorNote error={remove.error} />
				</div>
			</Panel>
		</div>
	);
}
