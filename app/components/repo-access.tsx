import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { api, keys, type GitCredentials, type RepoInfo } from "../lib/api.ts";
import { Button, CopyField, ErrorNote } from "./ui.tsx";

/** An Artifacts remote URL with the token as the password (task forks; agents use these directly). */
export function authUrl(creds: GitCredentials) {
	const url = new URL(creds.remote);
	url.username = "x";
	url.password = creds.token.split("?expires=")[0];
	return url.toString();
}

/** Quotes a shell argument unless it is plainly safe; branch names like `$(id)` are valid in git. */
export function sh(arg: string): string {
	return /^[\w./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** A URL with `username:token@` added, so plain `git push` works without a credential prompt. */
function withToken(cloneUrl: string, username: string, token: string) {
	const url = new URL(cloneUrl);
	url.username = username;
	url.password = token;
	return url.toString();
}

/**
 * How to use a repository with git: push an existing project, start a new one, or clone. Git asks for
 * a username and password; the password is a personal access token, which can be generated here.
 */
export function RepoCommands({ repo, empty }: { repo: RepoInfo; empty: boolean }) {
	const viewer = useQuery({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000 });
	const token = useMutation({ mutationFn: () => api.createToken(`git for ${repo.fullName}`) });
	const me = viewer.data;
	const secret = token.data?.token;
	const remote = sh(secret && me ? withToken(repo.cloneUrl, me.username, secret) : repo.cloneUrl);
	const branch = sh(repo.defaultBranch);
	const dir = sh(repo.name);
	if (!repo.canWrite) {
		return (
			<div className="space-y-4 text-xs">
				<Section title="Clone">
					<CopyField value={`git clone ${sh(repo.cloneUrl)}`} />
				</Section>
				<p className="text-faint">
					{repo.visibility === "public" ? "Anyone can clone this repository. Only its owner can push." : "Only the owner can push."}
				</p>
			</div>
		);
	}
	return (
		<div className="space-y-4 text-xs">
			<Section title="Push an existing repository">
				<CopyField value={`git remote add megit ${remote}`} secret={secret} />
				<CopyField value={`git branch -M ${branch}`} />
				<CopyField value={`git push -u megit ${branch}`} />
				<p className="text-faint">
					Other branches and tags: <code className="font-mono text-dim">git push megit --all && git push megit --tags</code>
				</p>
			</Section>
			{empty ? (
				<Section title="Or start a new one">
					<CopyField value={`git init -b ${branch} ${dir} && cd ${dir}`} />
					<CopyField value={`echo ${sh(`# ${repo.name}`)} > README.md && git add . && git commit -m "Initial commit"`} />
					<CopyField value={`git remote add megit ${remote} && git push -u megit ${branch}`} secret={secret} />
				</Section>
			) : (
				<Section title="Clone">
					<CopyField value={`git clone ${remote}`} secret={secret} />
				</Section>
			)}
			<div className="flex items-start justify-between gap-3 rounded-md border border-line bg-bg p-3 text-faint">
				{secret ? (
					<p>
						These commands now include a new personal access token (shown masked; Copy includes it). It's stored in the remote URL in{" "}
						<code className="font-mono">.git/config</code>; revoke it any time under{" "}
						<Link to="/settings/tokens" className="text-accent hover:underline">
							Tokens
						</Link>
						.
					</p>
				) : (
					<p>
						When git asks, sign in with your username <span className="font-mono text-dim">{me?.username}</span> and a{" "}
						<Link to="/settings/tokens" className="text-accent hover:underline">
							personal access token
						</Link>{" "}
						as the password. Or put a token straight into these commands:
					</p>
				)}
				{!secret && (
					<Button className="shrink-0 text-xs" onClick={() => token.mutate()} busy={token.isPending}>
						<KeyRound className="size-3.5" />
						Add a token
					</Button>
				)}
			</div>
			<ErrorNote error={token.error} />
		</div>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="space-y-1.5">
			<p className="font-medium text-dim">{title}</p>
			{children}
		</div>
	);
}
