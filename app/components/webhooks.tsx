import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RotateCw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { useState } from "react";
import { api, keys, type Webhook, type WebhookDelivery, type WebhookEvent } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { Button, cx, Empty, ErrorNote, Field, Input, Panel, Spinner, TimeAgo } from "./ui.tsx";

const EVENTS: { id: WebhookEvent; label: string; hint: string }[] = [
	{ id: "push", label: "Pushes", hint: "One per branch or tag a push, web edit or merge moves" },
	{ id: "merge", label: "Merges", hint: "The merge queue landed an agent task" },
	{ id: "task", label: "Agent tasks", hint: "Created, ready, submitted, conflicts, failures" },
	{ id: "release", label: "Releases", hint: "A release was published" },
	{ id: "issues", label: "Issues", hint: "Opened, closed, reopened, commented on" },
	{ id: "pull_request", label: "Pull requests", hint: "Opened, reviewed, merged" },
	{ id: "gollum", label: "Wiki", hint: "Pages created or edited (GitHub's gollum event)" },
];

export const hooksQuery = (project: string) => queryOptions({ queryKey: keys.hooks(project), queryFn: () => api.hooks(project) });

/** A repository's webhooks: add, pause, test and inspect them. */
export function Webhooks({ project, archived = false }: { project: string; archived?: boolean }) {
	const hooks = useQuery(hooksQuery(project));
	return (
		<Panel title="Webhooks" actions={<span className="text-[11px] text-faint">POSTed as JSON, signed with your secret</span>}>
			<div className="space-y-4 p-4">
				<p className="text-xs text-dim">
					Each delivery carries <code className="font-mono text-fg">X-Maggot-Event</code>,{" "}
					<code className="font-mono text-fg">X-Maggot-Delivery</code> and{" "}
					<code className="font-mono text-fg">X-Maggot-Signature-256: sha256=&lt;HMAC of the body&gt;</code>. Failed deliveries are retried
					five times over about nine hours.
				</p>
				{hooks.isPending ? <Spinner /> : <ErrorNote error={hooks.error} />}
				{hooks.data?.length === 0 && (
					<Empty icon={<WebhookIcon className="size-6" />} title="No webhooks">
						Add one to have CI or a chat bot hear about pushes.
					</Empty>
				)}
				{hooks.data && hooks.data.length > 0 && (
					<ul className="divide-y divide-line/60 rounded-lg border border-line">
						{hooks.data.map((hook) => (
							<HookRow key={hook.id} project={project} hook={hook} />
						))}
					</ul>
				)}
				{archived ? (
					<p className="text-xs text-faint">The repository is archived: existing webhooks can be paused or removed, but not added or tested.</p>
				) : (
					<AddHook project={project} />
				)}
			</div>
		</Panel>
	);
}

function AddHook({ project }: { project: string }) {
	const queryClient = useQueryClient();
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState("");
	const [events, setEvents] = useState<WebhookEvent[]>(["push"]);
	const add = useMutation({
		mutationFn: () => api.createHook(project, { url: url.trim(), secret, events }),
		onSuccess: () => {
			setUrl("");
			setSecret("");
			void queryClient.invalidateQueries({ queryKey: keys.hooks(project) });
		},
	});
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				add.mutate();
			}}
			className="space-y-3 rounded-lg border border-dashed border-line-strong p-3"
		>
			<div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<Field label="Payload URL">
					<Input value={url} onChange={(e) => setUrl(e.target.value)} type="url" placeholder="https://ci.example.com/maggot" required />
				</Field>
				<Field label="Secret" hint="At least 8 characters; your receiver checks each payload's signature with it.">
					<Input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" autoComplete="off" minLength={8} required />
				</Field>
			</div>
			<fieldset className="flex flex-wrap gap-x-5 gap-y-2">
				{EVENTS.map((e) => (
					<label key={e.id} className="flex items-start gap-2 text-sm" title={e.hint}>
						<input
							type="checkbox"
							checked={events.includes(e.id)}
							onChange={(ev) => setEvents(ev.target.checked ? [...events, e.id] : events.filter((x) => x !== e.id))}
							className="mt-0.5 size-4 accent-accent"
						/>
						<span>
							{e.label}
							<span className="block text-[11px] text-faint">{e.hint}</span>
						</span>
					</label>
				))}
			</fieldset>
			<ErrorNote error={add.error} />
			<Button type="submit" variant="primary" busy={add.isPending} disabled={events.length === 0}>
				Add webhook
			</Button>
		</form>
	);
}

const STATUS_STYLE: Record<WebhookDelivery["status"], string> = {
	delivered: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
	pending: "bg-amber-400/10 text-amber-300 ring-amber-400/30",
	failed: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
};

function StatusPill({ status }: { status: WebhookDelivery["status"] }) {
	return <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset", STATUS_STYLE[status])}>{status}</span>;
}

function HookRow({ project, hook }: { project: string; hook: Webhook }) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: keys.hooks(project) });
		void queryClient.invalidateQueries({ queryKey: keys.deliveries(project, hook.id) });
	};
	// Exact: deliveries sit under the list's key.
	const edit = (update: (old: Webhook[]) => Webhook[]) => [patch<Webhook[]>(keys.hooks(project), update, true)];
	const toggle = useOptimistic({
		mutationFn: (active: boolean) => api.updateHook(project, hook.id, { active }),
		apply: (active) => edit((old) => old.map((h) => (h.id === hook.id ? { ...h, active } : h))),
		action: "update the webhook",
	});
	const remove = useOptimistic({
		mutationFn: () => api.deleteHook(project, hook.id),
		apply: () => edit((old) => old.filter((h) => h.id !== hook.id)),
		action: "delete the webhook",
	});
	const ping = useMutation({
		mutationFn: () => api.pingHook(project, hook.id),
		onSuccess: () => {
			setOpen(true);
			// The delivery goes out from the repository's queue a moment later.
			setTimeout(refresh, 1500);
		},
	});
	return (
		<li>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
				<button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 basis-full items-center gap-2 text-left sm:basis-0 sm:flex-1">
					<ChevronRight className={cx("size-4 shrink-0 text-faint transition-transform", open && "rotate-90")} />
					<span className={cx("truncate font-mono text-xs", hook.active ? "text-fg" : "text-faint line-through")}>{hook.url}</span>
				</button>
				<span className="text-[11px] text-faint">{hook.events.join(", ")}</span>
				{hook.lastStatus && <StatusPill status={hook.lastStatus} />}
				<div className="flex items-center gap-1">
					<Button variant="ghost" onClick={() => ping.mutate()} busy={ping.isPending} className="text-xs" title="Send a test delivery">
						<Send className="size-3.5" />
						Test
					</Button>
					<Button variant="ghost" onClick={() => toggle.mutate(!hook.active)} className="text-xs">
						{hook.active ? "Pause" : "Resume"}
					</Button>
					<Button
						variant="ghost"
						onClick={() => confirm(`Delete the webhook to ${hook.url}?`) && remove.mutate()}
						className="text-xs hover:text-rose-300"
						title="Delete"
					>
						<Trash2 className="size-3.5" />
					</Button>
				</div>
			</div>
			<ErrorNote error={ping.error} />
			{open && <Deliveries project={project} hookId={hook.id} />}
		</li>
	);
}

function Deliveries({ project, hookId }: { project: string; hookId: string }) {
	const deliveries = useQuery({
		queryKey: keys.deliveries(project, hookId),
		queryFn: () => api.deliveries(project, hookId),
		refetchInterval: (q) => (q.state.data?.some((d) => d.status === "pending") ? 3000 : false),
	});
	const [shown, setShown] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const redeliver = useMutation({
		mutationFn: (id: string) => api.redeliver(project, hookId, id),
		onSuccess: () => setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.deliveries(project, hookId) }), 1500),
	});
	if (deliveries.isPending) return <Spinner className="m-3" />;
	if (!deliveries.data?.length) return <p className="px-9 pb-3 text-xs text-faint">No deliveries yet. Use Test to send one.</p>;
	return (
		<ul className="space-y-1 px-3 pb-3">
			{deliveries.data.map((d) => (
				<li key={d.id} className="rounded-md bg-raised/40">
					<button type="button" onClick={() => setShown(shown === d.id ? null : d.id)} className="flex w-full flex-wrap items-center gap-3 px-3 py-1.5 text-left text-xs">
						<StatusPill status={d.status} />
						<span className="font-mono text-dim">{d.event}</span>
						<span className="text-faint">{d.responseStatus ? `HTTP ${d.responseStatus}` : d.status === "pending" ? "queued" : "no response"}</span>
						{d.durationMs !== null && <span className="text-faint">{d.durationMs} ms</span>}
						{d.attempts > 1 && <span className="text-faint">{d.attempts} attempts</span>}
						<TimeAgo at={d.createdAt} className="ml-auto text-faint" />
					</button>
					{shown === d.id && (
						<div className="space-y-2 border-t border-line/60 p-3">
							{d.nextAt && d.status === "pending" && (
								<p className="text-[11px] text-faint">Next attempt {new Date(d.nextAt).toLocaleString()}</p>
							)}
							<p className="text-[11px] font-medium text-dim">Payload</p>
							<pre className="max-h-64 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-fg/90">{JSON.stringify(d.payload, null, 2)}</pre>
							{d.response && (
								<>
									<p className="text-[11px] font-medium text-dim">Response</p>
									<pre className="max-h-32 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-fg/90">{d.response}</pre>
								</>
							)}
							<Button onClick={() => redeliver.mutate(d.id)} busy={redeliver.isPending} className="text-xs">
								<RotateCw className="size-3.5" />
								Redeliver
							</Button>
						</div>
					)}
				</li>
			))}
		</ul>
	);
}
