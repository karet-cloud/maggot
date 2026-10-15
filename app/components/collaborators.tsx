import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, UserMinus, Users } from "lucide-react";
import { useState } from "react";
import { api, keys, type Collaborator, type Permission } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { Button, Empty, ErrorNote, Input, Panel, Spinner } from "./ui.tsx";

const HINT: Record<Permission, string> = {
	read: "clone and browse",
	write: "push, merge pull requests, approve reviews",
	admin: "everything, including settings and collaborators",
};

export const collaboratorsQuery = (project: string) => queryOptions({ queryKey: keys.collaborators(project), queryFn: () => api.collaborators(project) });

/** People invited to a repository with read, write or admin access. */
export function Collaborators({ project }: { project: string }) {
	const queryClient = useQueryClient();
	const list = useQuery(collaboratorsQuery(project));
	const [username, setUsername] = useState("");
	const [permission, setPermission] = useState<Permission>("read");
	// Inviting waits for the server, which looks the user up.
	const add = useMutation({ mutationFn: () => api.setCollaborator(project, username.trim(), permission), onSuccess: (next) => {
		queryClient.setQueryData(keys.collaborators(project), next);
		setUsername("");
	} });
	const change = useOptimistic({
		mutationFn: ({ who, to }: { who: string; to: Permission }) => api.setCollaborator(project, who, to),
		apply: ({ who, to }) => [patch<Collaborator[]>(keys.collaborators(project), (old) => old.map((k) => (k.username === who ? { ...k, permission: to } : k)))],
		action: "change their access",
	});
	const remove = useOptimistic({
		mutationFn: (who: string) => api.removeCollaborator(project, who),
		apply: (who) => [patch<Collaborator[]>(keys.collaborators(project), (old) => old.filter((k) => k.username !== who))],
		action: "remove the collaborator",
	});
	return (
		<Panel title="Collaborators" actions={<span className="text-[11px] text-faint">Invited people accept before they get access</span>}>
			{list.isPending ? (
				<Spinner className="m-4" />
			) : list.data?.length ? (
				<ul className="divide-y divide-line/60">
					{list.data.map((k) => (
						<li key={k.username} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
							<span className="font-mono">{k.username}</span>
							{k.state === "invited" && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-300">invited</span>}
							<select
								value={k.permission}
								onChange={(e) => change.mutate({ who: k.username, to: e.target.value as Permission })}
								aria-label={`${k.username}'s access`}
								className="ml-auto rounded-md border border-line-strong bg-bg px-2 py-1 text-xs text-fg"
							>
								{(Object.keys(HINT) as Permission[]).map((p) => (
									<option key={p} value={p}>
										{p}
									</option>
								))}
							</select>
							<Button
								variant="ghost"
								className="px-2 text-xs hover:text-red-300"
								onClick={() => confirm(`Remove ${k.username}'s access?`) && remove.mutate(k.username)}
								aria-label={`Remove ${k.username}`}
							>
								<UserMinus className="size-3.5" />
							</Button>
						</li>
					))}
				</ul>
			) : (
				<div className="p-4">
					<Empty icon={<Users className="size-6" />} title="No collaborators">
						Invite people to work on this repository with you.
					</Empty>
				</div>
			)}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					add.mutate();
				}}
				className="flex flex-wrap gap-2 border-t border-line p-4"
			>
				<Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" required className="min-w-48 flex-1" aria-label="Username to invite" />
				<select value={permission} onChange={(e) => setPermission(e.target.value as Permission)} aria-label="Access" className="rounded-md border border-line-strong bg-bg px-2.5 text-sm text-fg">
					{(Object.keys(HINT) as Permission[]).map((p) => (
						<option key={p} value={p}>
							{p}: {HINT[p]}
						</option>
					))}
				</select>
				<Button type="submit" busy={add.isPending}>
					<Plus className="size-4" />
					Invite
				</Button>
			</form>
			<div className="px-4 pb-3">
				<ErrorNote error={add.error ?? list.error} />
			</div>
		</Panel>
	);
}
