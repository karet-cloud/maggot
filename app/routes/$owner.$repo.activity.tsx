import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { EventFeed } from "../components/events.tsx";
import { cx, Panel } from "../components/ui.tsx";
import { useLive } from "../lib/live.ts";
import { useProjectTasks } from "../lib/queries.ts";
import type { Task } from "../lib/api.ts";

// The repository's event stream: pushes, issues, pull requests, releases and agent tasks, as they happen.
// The layout keeps the stream open on every tab, so nothing is missed while you're elsewhere.
export const Route = createFileRoute("/$owner/$repo/activity")({ component: ActivityPage });

function ActivityPage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const live = useLive();
	const tasks = useProjectTasks(project);
	const byId = useMemo(() => new Map<string, Task>((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
	const status = { connecting: "Connecting…", live: "Live", offline: "Reconnecting…" }[live.status];
	return (
		<Panel
			className="max-w-[900px]"
			title="Activity"
			actions={
				<span className="flex items-center gap-3 text-[11px] text-faint">
					<span className="flex items-center gap-1.5" title="New events appear here as they happen">
						<span className={cx("size-1.5 rounded-full", live.status === "live" ? "animate-pulse-dot bg-emerald-400" : "bg-zinc-500")} />
						{status}
					</span>
					<span>{live.events.length} events</span>
				</span>
			}
		>
			<EventFeed events={live.events} tasks={byId} project={project} />
		</Panel>
	);
}
