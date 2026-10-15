import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { SettingsNav } from "../components/settings-nav.tsx";
import { Button, CopyField, Empty, ErrorNote, Input, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/settings/tokens")({ component: Tokens });

function Tokens() {
	const viewer = useViewer();
	const queryClient = useQueryClient();
	const tokens = useQuery({ queryKey: keys.tokens, queryFn: api.tokens, enabled: Boolean(viewer.data) });
	const [name, setName] = useState("");
	const create = useMutation({
		mutationFn: () => api.createToken(name.trim()),
		onSuccess: () => {
			setName("");
			void queryClient.invalidateQueries({ queryKey: keys.tokens });
		},
	});
	const revoke = useMutation({
		mutationFn: (id: string) => api.revokeToken(id),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tokens }),
	});

	if (viewer.isPending) return <Spinner className="m-8" />;
	if (!viewer.data) {
		return (
			<main className="mx-auto max-w-md px-5 py-16 text-center text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to manage tokens.
			</main>
		);
	}
	return (
		<main className="mx-auto max-w-3xl space-y-5 px-5 py-8">
			<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
			<SettingsNav />
			<div>
				<p className="text-sm text-dim">
					Git asks for a username and password when you clone a private repository or push. Use your username,{" "}
					<span className="font-mono text-fg">{viewer.data.username}</span>, and a token as the password. Tokens also work as{" "}
					<code className="font-mono text-fg">Authorization: Bearer</code> for the API.
				</p>
			</div>
			<Panel title="New token">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						create.mutate();
					}}
					className="flex gap-2 p-4"
				>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="What's it for? e.g. laptop" required />
					<Button type="submit" variant="primary" busy={create.isPending} className="shrink-0">
						<KeyRound className="size-4" />
						Generate
					</Button>
				</form>
				{create.data && (
					<div className="space-y-2 border-t border-line p-4">
						<p className="text-xs text-amber-300">Copy it now. It isn't shown again.</p>
						<CopyField value={create.data.token} />
						<p className="text-[11px] text-faint">
							To save it so git doesn't ask each time: <code className="font-mono text-dim">git config --global credential.helper store</code>{" "}
							(or your OS keychain helper), then enter it once at the password prompt.
						</p>
					</div>
				)}
				<div className="px-4 pb-3">
					<ErrorNote error={create.error} />
				</div>
			</Panel>
			<Panel title="Your tokens">
				{tokens.isPending ? (
					<Spinner className="m-4" />
				) : tokens.data?.length ? (
					<ul className="divide-y divide-line/60">
						{tokens.data.map((t) => (
							<li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
								<KeyRound className="size-4 text-faint" />
								<div className="min-w-0 flex-1">
									<p className="truncate">{t.name}</p>
									<p className="text-[11px] text-faint">
										<span className="font-mono">{t.prefix}…</span> · created <TimeAgo at={t.createdAt} /> ·{" "}
										{t.lastUsedAt ? (
											<>
												last used <TimeAgo at={t.lastUsedAt} />
											</>
										) : (
											"never used"
										)}
									</p>
								</div>
								<Button
									variant="ghost"
									className="px-2 text-xs hover:text-red-300"
									busy={revoke.isPending && revoke.variables === t.id}
									onClick={() => confirm(`Revoke "${t.name}"? Anything using it stops working.`) && revoke.mutate(t.id)}
								>
									<Trash2 className="size-3.5" />
								</Button>
							</li>
						))}
					</ul>
				) : (
					<div className="p-4">
						<Empty icon={<KeyRound className="size-6" />} title="No tokens yet" />
					</div>
				)}
				<div className="px-4 pb-3">
					<ErrorNote error={tokens.error ?? revoke.error} />
				</div>
			</Panel>
		</main>
	);
}
