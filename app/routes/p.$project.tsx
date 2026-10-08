import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { FolderCode, History, LayoutGrid, Plus, Radio, Terminal } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { EventFeed } from "../components/events.tsx";
import { NewTask } from "../components/new-task.tsx";
import { RepoCommands } from "../components/repo-access.tsx";
import { Button, CopyField, cx, ErrorNote, Modal, Oid, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, type Task } from "../lib/api.ts";
import { useProjectTasks } from "../lib/queries.ts";
import { LiveContext, useProjectLive, type LiveStatus } from "../lib/live.ts";

export const Route = createFileRoute("/p/$project")({ component: ProjectLayout });

function ProjectLayout() {
	const { project } = Route.useParams();
	const live = useProjectLive(project);
	// Direct git pushes don't produce events yet, so poll the head (quickly while the repo is still empty).
	const info = useQuery({
		queryKey: keys.project(project),
		queryFn: () => api.project(project),
		refetchInterval: (q) => (q.state.data && !q.state.data.head ? 3000 : 15_000),
	});
	const tasks = useProjectTasks(project);
	const byId = useMemo(() => new Map<string, Task>((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
	const [creating, setCreating] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const p = info.data;

	if (info.error) {
		return (
			<main className="mx-auto max-w-[1600px] px-5 py-8">
				<ErrorNote error={info.error} />
			</main>
		);
	}

	return (
		<LiveContext.Provider value={live}>
			<div className="border-b border-line bg-panel/40">
				<div className="mx-auto max-w-[1600px] px-5 pt-5">
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div className="min-w-0">
							<div className="flex items-center gap-3">
								<h1 className="font-mono text-xl font-semibold tracking-tight">{project}</h1>
								<LiveDot status={live.status} />
							</div>
							<p className="mt-1 text-sm text-dim">{p ? p.description || "No description" : <Spinner className="inline" />}</p>
						</div>
						<div className="flex items-center gap-2">
							<Button onClick={() => setConnecting(true)}>
								<Terminal className="size-4" />
								Clone / push
							</Button>
							<Button variant="primary" onClick={() => setCreating(true)} disabled={p !== undefined && !p.head} title={p && !p.head ? "Push a first commit before creating tasks" : undefined}>
								<Plus className="size-4" />
								New task
							</Button>
						</div>
					</div>
					{p && (
						<div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-dim">
							<span>
								<span className="text-faint">branch</span> <span className="font-mono text-fg">{p.defaultBranch}</span>
							</span>
							<span className="flex items-center gap-1.5">
								<span className="text-faint">head</span> <Oid oid={p.head} />
							</span>
							<span>
								<span className="text-faint">active</span>{" "}
								<b className="font-medium text-fg">{p.stats.provisioning + p.stats.open + p.stats.queued + p.stats.merging}</b>
							</span>
							<span>
								<span className="text-faint">queue</span> <b className="font-medium text-fg">{p.queueLength}</b>
							</span>
							<span>
								<span className="text-faint">merged</span> <b className="font-medium text-emerald-300">{p.stats.merged}</b>
							</span>
							{p.stats.conflict + p.stats.failed > 0 && (
								<span>
									<span className="text-faint">attention</span> <b className="font-medium text-rose-300">{p.stats.conflict + p.stats.failed}</b>
								</span>
							)}
							<div className="w-full max-w-md sm:ml-auto sm:w-auto sm:min-w-80">
								<CopyField value={p.remote} />
							</div>
						</div>
					)}
					<nav className="mt-4 flex gap-1">
						<Tab to="/p/$project" project={project} icon={<LayoutGrid className="size-3.5" />} label="Board" exact />
						<Tab to="/p/$project/code" project={project} icon={<FolderCode className="size-3.5" />} label="Code" />
						<Tab to="/p/$project/history" project={project} icon={<History className="size-3.5" />} label="History" />
					</nav>
				</div>
			</div>

			<div className="mx-auto grid max-w-[1600px] gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="min-w-0">
					<Outlet />
				</div>
				<aside className="lg:sticky lg:top-17 lg:max-h-[calc(100vh-5.5rem)]">
					<Panel
						title="Activity"
						actions={<span className="text-[11px] text-faint">{live.events.length} events</span>}
						className="flex max-h-[inherit] flex-col overflow-hidden"
					>
						<div className="min-h-0 flex-1 overflow-y-auto">
							<EventFeed events={live.events} tasks={byId} project={project} />
						</div>
					</Panel>
				</aside>
			</div>

			<Modal open={connecting} onClose={() => setConnecting(false)} title={`Use ${project} with git`}>
				<RepoCommands project={project} empty={!p?.head} />
			</Modal>
			<Modal open={creating} onClose={() => setCreating(false)} title="New task">
				<NewTask project={project} onClose={() => setCreating(false)} />
			</Modal>
		</LiveContext.Provider>
	);
}

function Tab({ to, project, icon, label, exact }: { to: "/p/$project" | "/p/$project/code" | "/p/$project/history"; project: string; icon: ReactNode; label: string; exact?: boolean }) {
	return (
		<Link
			to={to}
			params={{ project }}
			activeOptions={{ exact, includeSearch: false }}
			className="-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-dim hover:text-fg data-[status=active]:border-accent data-[status=active]:text-fg"
		>
			{icon}
			{label}
		</Link>
	);
}

function LiveDot({ status }: { status: LiveStatus }) {
	const label = { connecting: "Connecting", live: "Live", offline: "Reconnecting" }[status];
	return (
		<span
			className={cx(
				"flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
				status === "live" ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30" : "bg-zinc-500/10 text-dim ring-zinc-500/30",
			)}
		>
			<Radio className={cx("size-3", status === "live" && "animate-pulse-dot")} />
			{label}
		</span>
	);
}
