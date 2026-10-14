import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, keys, type GitCredentials, type RepoInfo } from "../lib/api.ts";
import { Button, CopyField, cx, ErrorNote } from "./ui.tsx";

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
				<SshSection repo={repo} />
				<p className="text-faint">
					{repo.visibility === "public" ? "Anyone can clone this repository. Only its owner can push." : "Only the owner can push."}
				</p>
			</div>
		);
	}
	return (
		<div className="space-y-4 text-xs">
			<Section title="Push an existing repository">
				<CopyField value={`git remote add maggot ${remote}`} secret={secret} />
				<CopyField value={`git branch -M ${branch}`} />
				<CopyField value={`git push -u maggot ${branch}`} />
				<p className="text-faint">
					Other branches and tags: <code className="font-mono text-dim">git push maggot --all && git push maggot --tags</code>
				</p>
			</Section>
			{empty ? (
				<Section title="Or start a new one">
					<CopyField value={`git init -b ${branch} ${dir} && cd ${dir}`} />
					<CopyField value={`echo ${sh(`# ${repo.name}`)} > README.md && git add . && git commit -m "Initial commit"`} />
					<CopyField value={`git remote add maggot ${remote} && git push -u maggot ${branch}`} secret={secret} />
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
			<SshSection repo={repo} />
		</div>
	);
}

function SshSection({ repo }: { repo: RepoInfo }) {
	return (
		<Section title="Or over SSH">
			<CopyField value={`git clone ${sh(repo.sshUrl)}`} />
			<p className="text-faint">
				Needs an SSH key on your account and a short ssh config entry; both are on the{" "}
				<Link to="/settings/ssh" className="text-accent hover:underline">
					SSH keys
				</Link>{" "}
				page.
			</p>
		</Section>
	);
}

const CLONE_KIND = "maggot.cloneKind";

/** The repository's clone URL, HTTPS or SSH; the choice is remembered in this browser. */
export function CloneUrl({ repo }: { repo: RepoInfo }) {
	const [kind, setKind] = useState<"https" | "ssh">("https");
	// Read after mounting, so the server-rendered page and the first client render agree.
	useEffect(() => {
		if (localStorage.getItem(CLONE_KIND) === "ssh") setKind("ssh");
	}, []);
	const choose = (next: "https" | "ssh") => {
		setKind(next);
		localStorage.setItem(CLONE_KIND, next);
	};
	const option = (value: "https" | "ssh", label: string) => (
		<button
			type="button"
			onClick={() => choose(value)}
			aria-pressed={kind === value}
			className={cx("rounded px-2 py-1 text-[11px] font-medium", kind === value ? "bg-raised text-fg" : "text-faint hover:text-dim")}
		>
			{label}
		</button>
	);
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<div className="flex shrink-0 rounded-md border border-line p-0.5" role="group" aria-label="Clone over">
				{option("https", "HTTPS")}
				{option("ssh", "SSH")}
			</div>
			<div className="min-w-0 flex-1">
				<CopyField value={kind === "ssh" ? repo.sshUrl : repo.cloneUrl} />
			</div>
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
