import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BookLock, BookMarked } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, cx, ErrorNote, Field, Input, Spinner } from "../components/ui.tsx";
import { api, keys, type Visibility } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { preload } from "../lib/queries.ts";
import { signedIn, useNeedsVerification, useViewer } from "./__root.tsx";

export const Route = createFileRoute("/new")({
	loader: ({ context }) => preload(context.queryClient, signedIn(context.queryClient) && myOrgsQuery),
	component: NewRepo,
});

const myOrgsQuery = queryOptions({ queryKey: keys.myOrgs, queryFn: api.myOrgs });

function NewRepo() {
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [visibility, setVisibility] = useState<Visibility>("public");
	const [defaultBranch, setDefaultBranch] = useState("master");
	const [importUrl, setImportUrl] = useState("");
	const [readme, setReadme] = useState(false);
	const [owner, setOwner] = useState("");
	const orgs = useQuery({ ...myOrgsQuery, enabled: Boolean(viewer.data) });
	const create = useMutation({
		mutationFn: () =>
			api.createRepo({
				name: name.trim(),
				description: description.trim() || undefined,
				visibility,
				defaultBranch: defaultBranch.trim() || undefined,
				importUrl: importUrl.trim() || undefined,
				readme,
				owner: owner || undefined,
			}),
		onSuccess: (repo) => {
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
			void queryClient.invalidateQueries({ queryKey: keys.me });
			void navigate({ to: "/$owner/$repo", params: { owner: repo.owner, repo: repo.name } });
		},
	});

	if (viewer.isPending) return <Spinner className="m-8" />;
	if (!viewer.data) {
		return (
			<main className="mx-auto max-w-md px-5 py-16 text-center text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to create a repository.
			</main>
		);
	}
	const importing = Boolean(importUrl.trim());
	const { usage } = viewer.data;
	const full = usage.repos >= usage.maxRepos;
	return (
		<main className="mx-auto max-w-2xl px-5 py-8">
			<h1 className="text-2xl font-semibold tracking-tight">Create a repository</h1>
			<p className="mt-1 text-sm text-dim">Push an existing project to it with git, start from a README, or import a public repository.</p>
			<p className="mt-2 text-xs text-faint">
				You have {usage.repos} of {usage.maxRepos} repositories, using {formatBytes(usage.bytes)} of {formatBytes(usage.maxBytes)}.
			</p>
			{needsVerification && (
				<p className="mt-4 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
					Verify your email address before creating a repository. The link is in the email we sent when you signed up.
				</p>
			)}
			{full && (
				<p className="mt-4 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
					You've reached the most repositories an account can have. Delete one in its settings to make room.
				</p>
			)}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate();
				}}
				className="mt-6 space-y-5"
			>
				<div className="flex items-end gap-2">
					{orgs.data?.length ? (
						<div className="pb-0.5">
							<Field label="Owner">
								<select
									value={owner}
									onChange={(e) => setOwner(e.target.value)}
									className="rounded-md border border-line-strong bg-bg px-2.5 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
								>
									<option value="">{viewer.data.username}</option>
									{orgs.data.map((o) => (
										<option key={o.name} value={o.name}>
											{o.name}
										</option>
									))}
								</select>
							</Field>
						</div>
					) : (
						<div className="pb-2 font-mono text-sm text-dim">{viewer.data.username} /</div>
					)}
					<div className="flex-1">
						<Field label="Repository name">
							<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" pattern="[A-Za-z0-9._\-]{1,100}" autoFocus required />
						</Field>
					</div>
				</div>
				<Field label="Description">
					<Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
				</Field>
				<fieldset className="space-y-2">
					<legend className="text-xs font-medium text-dim">Visibility</legend>
					<Choice
						checked={visibility === "public"}
						onSelect={() => setVisibility("public")}
						icon={<BookMarked className="size-4" />}
						title="Public"
						body="Anyone can browse and clone it. Only you can push."
					/>
					<Choice
						checked={visibility === "private"}
						onSelect={() => setVisibility("private")}
						icon={<BookLock className="size-4" />}
						title="Private"
						body="Only you can see, clone and push it."
					/>
				</fieldset>
				<Field
					label="Import from (optional)"
					hint="Any public Git URL: GitHub, GitLab, Codeberg, a self-hosted server. Its history and default branch come along; a link to a branch (…/tree/dev) imports that branch."
				>
					<Input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://github.com/owner/repo" inputMode="url" autoComplete="off" spellCheck={false} />
				</Field>
				{!importing && (
					<>
						<Field label="Default branch" hint="Use the branch name your existing repository uses (often main or master).">
							<Input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} className="font-mono" required />
						</Field>
						<label className="flex items-start gap-2 text-sm text-dim">
							<input type="checkbox" checked={readme} onChange={(e) => setReadme(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
							<span>
								Add a README
								<span className="block text-[11px] text-faint">Leave this off to push an existing repository.</span>
							</span>
						</label>
					</>
				)}
				<ErrorNote error={create.error} />
				<Button type="submit" variant="primary" busy={create.isPending} disabled={needsVerification || full}>
					{importing ? "Import repository" : "Create repository"}
				</Button>
			</form>
		</main>
	);
}

function Choice({ checked, onSelect, icon, title, body }: { checked: boolean; onSelect: () => void; icon: ReactNode; title: string; body: string }) {
	return (
		<label className={cx("flex cursor-pointer items-start gap-3 rounded-lg border p-3", checked ? "border-accent bg-accent/5" : "border-line hover:border-line-strong")}>
			<input type="radio" checked={checked} onChange={onSelect} className="mt-1 accent-accent" />
			<span className="mt-0.5 text-dim">{icon}</span>
			<span>
				<span className="block text-sm font-medium">{title}</span>
				<span className="block text-xs text-dim">{body}</span>
			</span>
		</label>
	);
}
