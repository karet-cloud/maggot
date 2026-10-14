import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Terminal } from "lucide-react";
import { useState } from "react";
import { api, keys, type TaskAccess, repoParams } from "../lib/api.ts";
import { authUrl, sh } from "./repo-access.tsx";
import { Button, CopyField, ErrorNote, Field, Input, Spinner, StatusBadge } from "./ui.tsx";

export function NewTask({ project, onClose }: { project: string; onClose: () => void }) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState("");
	const [agent, setAgent] = useState("");
	const [paths, setPaths] = useState("");
	const create = useMutation({
		mutationFn: () =>
			api.createTask(project, {
				title: title.trim(),
				agent: agent.trim() || undefined,
				paths: paths
					.split(/[\s,]+/)
					.map((p) => p.trim())
					.filter(Boolean),
			}),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tasks(project) }),
	});

	if (create.data) return <Created project={project} created={create.data} onClose={onClose} />;

	return (
		<div className="space-y-5">
			<form
				className="space-y-4"
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate();
				}}
			>
				<Field label="Title">
					<Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add rate limiting to the API" required autoFocus />
				</Field>
				<div className="grid grid-cols-2 gap-3">
					<Field label="Agent">
						<Input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="claude-1" />
					</Field>
					<Field label="Path claims" hint="Advisory; overlaps are reported.">
						<Input value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="src/api/, README.md" />
					</Field>
				</div>
				<ErrorNote error={create.error} />
				<div className="flex justify-end gap-2">
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={create.isPending}>
						Create task
					</Button>
				</div>
			</form>
			<div className="rounded-lg border border-line bg-bg p-3">
				<p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-dim">
					<Terminal className="size-3.5" />
					Or let an agent open its own task
				</p>
				<CopyField value={`MAGGOT_URL=${typeof location === "undefined" ? "" : location.origin} maggot start ${project} "${title || "<title>"}"`} />
			</div>
		</div>
	);
}

function Created({ project, created, onClose }: { project: string; created: TaskAccess; onClose: () => void }) {
	const id = created.task.id;
	const task = useQuery({
		queryKey: keys.task(project, id),
		queryFn: () => api.task(project, id),
		initialData: created.task,
		refetchInterval: (q) => (q.state.data?.status === "provisioning" ? 1000 : false),
	});
	const status = task.data?.status ?? created.task.status;
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{created.task.title}</p>
					<p className="font-mono text-xs text-faint">{id}</p>
				</div>
				<StatusBadge status={status} />
			</div>
			{created.overlaps.length > 0 && (
				<div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
					Overlaps with {created.overlaps.map((o) => `${o.title} (${o.agent ?? o.id})`).join(", ")}
				</div>
			)}
			{status === "provisioning" ? (
				<p className="flex items-center gap-2 text-sm text-dim">
					<Spinner /> Waiting in the fork queue…
				</p>
			) : (
				<Connect project={project} taskId={id} />
			)}
			<div className="flex justify-end gap-2">
				<Link to="/$owner/$repo/t/$task" params={{ ...repoParams(project), task: id }} onClick={onClose} className="text-sm text-accent hover:underline">
					Open task →
				</Link>
			</div>
		</div>
	);
}

/** Fresh fork + base credentials as copyable git commands. Tokens are shown masked. */
export function Connect({ project, taskId }: { project: string; taskId: string }) {
	const access = useMutation({ mutationFn: () => api.access(project, taskId) });
	if (!access.data) {
		return (
			<div className="space-y-2">
				<Button onClick={() => access.mutate()} busy={access.isPending}>
					<Terminal className="size-4" />
					Get git credentials
				</Button>
				<ErrorNote error={access.error} />
			</div>
		);
	}
	const { fork, base } = access.data;
	if (!fork || !base) return <p className="text-sm text-dim">The fork isn't ready yet.</p>;
	const forkSecret = fork.token.split("?expires=")[0];
	const baseSecret = base.token.split("?expires=")[0];
	return (
		<div className="space-y-3 text-xs">
			<div className="space-y-1.5">
				<p className="text-dim">Clone the task's fork (read/write)</p>
				<CopyField value={`git clone ${sh(authUrl(fork))} ${sh(`${project}-${taskId}`)}`} secret={forkSecret} />
			</div>
			<div className="space-y-1.5">
				<p className="text-dim">Sync with the latest {base.branch} (read-only)</p>
				<CopyField value={`git pull ${sh(authUrl(base))} ${sh(base.branch)}`} secret={baseSecret} />
			</div>
			<p className="text-faint">
				Tokens expire {new Date(fork.expiresAt).toLocaleString()}. Push to the fork, then submit it for merge.
			</p>
		</div>
	);
}
