import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { api, type GitCredentials } from "../lib/api.ts";
import { Button, CopyField, ErrorNote, Spinner } from "./ui.tsx";

/** A remote URL with the token as the password, so plain `git push` works without a credential helper. */
export function authUrl(creds: GitCredentials) {
	const url = new URL(creds.remote);
	url.username = "x";
	url.password = creds.token.split("?expires=")[0];
	return url.toString();
}

/**
 * Commands for working with the project repo directly with git: push an existing repository, or clone.
 * Mints a write token when shown; tokens last 30 days.
 */
export function RepoCommands({ project, empty }: { project: string; empty: boolean }) {
	const creds = useQuery({
		queryKey: ["credentials", project],
		queryFn: () => api.credentials(project),
		staleTime: Infinity,
		gcTime: 0,
	});
	if (creds.isPending) return <Spinner />;
	if (creds.error) return <ErrorNote error={creds.error} />;
	const c = creds.data;
	const url = authUrl(c);
	const secret = c.token.split("?expires=")[0];
	return (
		<div className="space-y-4 text-xs">
			<Section title="Push an existing repository">
				<CopyField value={`git remote add megit ${url}`} secret={secret} />
				<CopyField value={`git branch -M ${c.branch}`} />
				<CopyField value={`git push -u megit ${c.branch}`} />
			</Section>
			{empty ? (
				<Section title="Or start a new one">
					<CopyField value={`git init -b ${c.branch} ${project} && cd ${project}`} />
					<CopyField value={`echo "# ${project}" > README.md && git add . && git commit -m "Initial commit"`} />
					<CopyField value={`git remote add megit ${url} && git push -u megit ${c.branch}`} secret={secret} />
				</Section>
			) : (
				<Section title="Clone">
					<CopyField value={`git clone ${url} ${project}`} secret={secret} />
				</Section>
			)}
			<div className="flex items-start justify-between gap-3 text-faint">
				<p>
					The token in these URLs can write to <span className="font-mono text-dim">{c.branch}</span> directly and expires{" "}
					{new Date(c.expiresAt).toLocaleDateString()}. Pushes here skip the merge queue; agents should open tasks instead.
				</p>
				<Button variant="ghost" className="shrink-0 text-xs" onClick={() => void creds.refetch()} busy={creds.isFetching}>
					<RefreshCw className="size-3.5" />
					New token
				</Button>
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
