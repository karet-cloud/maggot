import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startLocalArtifacts } from "../scripts/local-artifacts.ts";

const exec = promisify(execFile);

export async function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
	const { stdout } = await exec(cmd, args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test Agent",
			GIT_AUTHOR_EMAIL: "agent@example.com",
			GIT_COMMITTER_NAME: "Test Agent",
			GIT_COMMITTER_EMAIL: "agent@example.com",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
	return stdout.trim();
}

export async function localArtifacts() {
	const root = await mkdtemp(join(tmpdir(), "maggot-test-"));
	const server = await startLocalArtifacts({ root: join(root, "artifacts"), port: 0, quiet: true });
	async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(`${server.url}/api${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
		const json = (await res.json()) as { result: T; error?: { message: string } };
		if (json.error) throw new Error(json.error.message);
		return json.result;
	}
	return {
		url: server.url,
		root,
		call,
		async close() {
			await server.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

export function authUrl(remote: string, token: string): string {
	const url = new URL(remote);
	url.username = "x";
	url.password = token.split("?expires=")[0];
	return url.toString();
}
