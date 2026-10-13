import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRightLeft, Bell, CheckCheck, GitFork, GitMerge, Star, TriangleAlert, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import { Button, cx, Empty, ErrorNote, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, type NotificationKind } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/notifications")({
	validateSearch: (s: Record<string, unknown>): { all?: true } => (s.all === true || s.all === "true" ? { all: true } : {}),
	component: Notifications,
});

const ICONS: Record<NotificationKind, ReactNode> = {
	star: <Star className="size-4 text-amber-300" />,
	fork: <GitFork className="size-4 text-sky-300" />,
	transfer: <ArrowRightLeft className="size-4 text-sky-300" />,
	"task.merged": <GitMerge className="size-4 text-emerald-300" />,
	"task.failed": <TriangleAlert className="size-4 text-rose-300" />,
	"task.conflict": <TriangleAlert className="size-4 text-amber-300" />,
	"webhook.failing": <Webhook className="size-4 text-rose-300" />,
};

function Notifications() {
	const { all } = Route.useSearch();
	const viewer = useViewer();
	const queryClient = useQueryClient();
	const list = useQuery({ queryKey: [...keys.notifications, all ? "all" : "unread"], queryFn: () => api.notifications(!all), enabled: Boolean(viewer.data) });
	const read = useMutation({
		mutationFn: (ids?: string[]) => api.markRead(ids),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.notifications }),
	});
	if (viewer.isPending) return <Spinner className="m-8" />;
	if (!viewer.data) {
		return (
			<main className="mx-auto max-w-md px-5 py-16 text-center text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to see your notifications.
			</main>
		);
	}
	return (
		<main className="mx-auto max-w-[900px] space-y-4 px-5 py-8">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="text-lg font-semibold">Notifications</h1>
				<nav className="flex overflow-hidden rounded-md border border-line-strong text-xs">
					<Link to="/notifications" search={{}} className={cx("px-2.5 py-1", !all ? "bg-raised text-fg" : "text-faint hover:text-fg")}>
						Unread
					</Link>
					<Link to="/notifications" search={{ all: true }} className={cx("px-2.5 py-1", all ? "bg-raised text-fg" : "text-faint hover:text-fg")}>
						All
					</Link>
				</nav>
				<Button onClick={() => read.mutate(undefined)} busy={read.isPending && !read.variables} className="ml-auto text-xs" disabled={!list.data?.unread}>
					<CheckCheck className="size-3.5" />
					Mark all read
				</Button>
			</div>
			{list.isPending ? <Spinner /> : <ErrorNote error={list.error ?? read.error} />}
			{list.data?.notifications.length === 0 && (
				<Empty icon={<Bell className="size-6" />} title={all ? "No notifications yet" : "You're all caught up"}>
					Stars, forks, agent merges and failing webhooks on your repositories show up here.
				</Empty>
			)}
			{list.data && list.data.notifications.length > 0 && (
				<ul className="divide-y divide-line/60 rounded-lg border border-line bg-panel">
					{list.data.notifications.map((n) => (
						<li key={n.id} className={cx("flex items-start gap-3 px-4 py-3", n.readAt && "opacity-60")}>
							<span className="mt-0.5">{ICONS[n.kind]}</span>
							<div className="min-w-0 flex-1">
								<a href={n.url} onClick={() => !n.readAt && read.mutate([n.id])} className="text-sm text-fg hover:text-accent">
									{n.title}
								</a>
								<p className="mt-0.5 text-[11px] text-faint">
									{n.repo && <span className="font-mono">{n.repo} · </span>}
									<TimeAgo at={n.createdAt} />
								</p>
							</div>
							{!n.readAt && (
								<button type="button" onClick={() => read.mutate([n.id])} className="text-[11px] text-faint hover:text-fg">
									Mark read
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</main>
	);
}
