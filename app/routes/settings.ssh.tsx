import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, KeySquare, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { SettingsNav } from "../components/settings-nav.tsx";
import { Button, CopyField, Empty, ErrorNote, Field, Input, Panel, Spinner, TimeAgo, useCopy } from "../components/ui.tsx";
import { api, keys, type SshKey } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { preload } from "../lib/queries.ts";
import { signedIn, useViewer } from "./__root.tsx";

export const Route = createFileRoute("/settings/ssh")({
	head: () => ({ meta: [{ title: "SSH keys · maggot" }] }),
	loader: ({ context }) => preload(context.queryClient, infoQuery, signedIn(context.queryClient) && keysQuery),
	component: SshKeys,
});

const infoQuery = queryOptions({ queryKey: keys.ssh, queryFn: api.ssh, staleTime: Number.POSITIVE_INFINITY });
const keysQuery = queryOptions({ queryKey: keys.sshKeys, queryFn: api.sshKeys });

function SshKeys() {
	const viewer = useViewer();
	const queryClient = useQueryClient();
	const info = useQuery(infoQuery);
	const list = useQuery({ ...keysQuery, enabled: Boolean(viewer.data) });
	const [key, setKey] = useState("");
	const [name, setName] = useState("");
	const add = useMutation({
		mutationFn: () => api.addSshKey(key.trim(), name.trim() || undefined),
		onSuccess: () => {
			setKey("");
			setName("");
			void queryClient.invalidateQueries({ queryKey: keys.sshKeys });
		},
	});
	const remove = useOptimistic({
		mutationFn: (id: string) => api.deleteSshKey(id),
		apply: (id) => [patch<SshKey[]>(keys.sshKeys, (old) => old.filter((k) => k.id !== id))],
		action: "remove the key",
	});

	if (viewer.isPending) return <Spinner className="m-8" />;
	if (!viewer.data) {
		return (
			<main className="mx-auto max-w-md px-5 py-16 text-center text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to manage SSH keys.
			</main>
		);
	}
	const host = info.data?.host ?? "maggot";
	const origin = typeof location === "undefined" ? "" : location.origin;
	return (
		<main className="mx-auto max-w-3xl space-y-5 px-5 py-8">
			<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
			<SettingsNav />
			<p className="text-sm text-dim">
				Clone and push with an SSH key instead of a token. maggot runs on Cloudflare Workers, which can't take connections on port 22, so{" "}
				<code className="font-mono text-fg">ssh</code> reaches it through a small proxy over HTTPS. The connection is still SSH, encrypted from your
				machine to maggot.
			</p>

			<Panel title="Add a key">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						add.mutate();
					}}
					className="space-y-3 p-4"
				>
					<Field
						label="Public key"
						hint={
							<>
								The contents of a <code className="font-mono">.pub</code> file, for example{" "}
								<code className="font-mono text-dim">cat ~/.ssh/id_ed25519.pub</code>. No key yet?{" "}
								<code className="font-mono text-dim">ssh-keygen -t ed25519</code>
							</>
						}
					>
						<textarea
							value={key}
							onChange={(e) => setKey(e.target.value)}
							required
							rows={3}
							spellCheck={false}
							placeholder="ssh-ed25519 AAAA… you@laptop"
							className="w-full rounded-md border border-line-strong bg-bg px-3 py-2 font-mono text-xs text-fg placeholder:text-faint focus:border-accent focus:outline-none"
						/>
					</Field>
					<Field label="Name" hint="Optional; the key's comment is used if you leave it empty.">
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop" maxLength={80} />
					</Field>
					<ErrorNote error={add.error} />
					<Button type="submit" variant="primary" busy={add.isPending}>
						<Plus className="size-4" />
						Add key
					</Button>
				</form>
			</Panel>

			<Panel title="Your keys">
				{list.isPending ? (
					<Spinner className="m-4" />
				) : list.data?.length ? (
					<ul className="divide-y divide-line/60">
						{list.data.map((k) => (
							<li key={k.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
								<KeySquare className="size-4 shrink-0 text-faint" />
								<div className="min-w-0 flex-1">
									<p className="truncate">
										{k.name} <span className="text-[11px] text-faint">{k.type}</span>
									</p>
									<p className="truncate font-mono text-[11px] text-faint">{k.fingerprint}</p>
									<p className="text-[11px] text-faint">
										added <TimeAgo at={k.createdAt} /> ·{" "}
										{k.lastUsedAt ? (
											<>
												last used <TimeAgo at={k.lastUsedAt} />
											</>
										) : (
											"never used"
										)}
									</p>
								</div>
								<Button
									variant="ghost"
									className="px-2 text-xs hover:text-red-300"
									onClick={() => confirm(`Remove "${k.name}"? It won't be able to reach your repositories any more.`) && remove.mutate(k.id)}
									title="Remove key"
									aria-label={`Remove ${k.name}`}
								>
									<Trash2 className="size-3.5" />
								</Button>
							</li>
						))}
					</ul>
				) : (
					<div className="p-4">
						<Empty icon={<KeySquare className="size-6" />} title="No SSH keys yet" />
					</div>
				)}
				<div className="px-4 pb-3">
					<ErrorNote error={list.error} />
				</div>
			</Panel>

			<Panel title="Set up ssh (once per machine)">
				{info.data ? (
					<ol className="space-y-4 p-4 text-xs">
						<Step n={1} title="Save the proxy (needs Node.js 22 or newer)">
							<CopyField value={`curl -fsSo ~/.ssh/maggot-proxy.mjs ${origin}/ssh-proxy.mjs`} />
						</Step>
						<Step n={2} title="Add this to ~/.ssh/config">
							<CopyBlock text={`Host ${host}\n  User git\n  ProxyCommand node ~/.ssh/maggot-proxy.mjs ${info.data.url}`} />
						</Step>
						<Step n={3} title="Check it works">
							<CopyField value={`ssh -T git@${host}`} />
							<p className="text-faint">
								The first time, ssh asks whether to trust the server. Its key fingerprint is{" "}
								<span className="break-all font-mono text-dim">{info.data.fingerprint}</span>. If it matches, type yes. maggot
								then greets you by name.
							</p>
						</Step>
						<Step n={4} title="Clone with SSH URLs">
							<CopyField value={`git clone git@${host}:${viewer.data.username}/<repository>.git`} />
						</Step>
					</ol>
				) : (
					<div className="p-4">{info.error ? <ErrorNote error={info.error} /> : <Spinner />}</div>
				)}
			</Panel>
		</main>
	);
}

function CopyBlock({ text }: { text: string }) {
	const { copied, copy } = useCopy();
	return (
		<div className="flex items-start overflow-hidden rounded-md border border-line bg-bg">
			<pre className="min-w-0 flex-1 overflow-x-auto px-3 py-2 font-mono text-[12px] text-fg">{text}</pre>
			<button type="button" onClick={() => copy(text)} className="flex shrink-0 items-center gap-1.5 border-l border-line px-3 py-2 text-xs text-dim hover:text-fg">
				{copied ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />}
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-medium text-dim">{n}</span>
			<div className="min-w-0 flex-1 space-y-1.5">
				<p className="font-medium text-dim">{title}</p>
				{children}
			</div>
		</li>
	);
}
