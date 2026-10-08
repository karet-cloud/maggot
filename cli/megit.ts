#!/usr/bin/env node
// megit agent CLI. Each agent runs `megit start` to get its own fork + checkout, commits with plain
// git, and runs `megit submit` to land work through the project's merge queue.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import type { GitCredentials, ProjectEvent, Task, TaskAccess } from "../src/api.ts";

const exec = promisify(execFile);
const API = (process.env.MEGIT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const KEY = process.env.MEGIT_API_KEY ?? "dev";

interface Checkout {
	api: string;
	project: string;
	taskId: string;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${API}/api${path}`, {
		method,
		headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await res.json()) as T & { error?: { code: string; message: string } };
	if (!res.ok) throw new Error(`${json.error?.code ?? res.status}: ${json.error?.message ?? res.statusText}`);
	return json;
}

async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	return stdout.trim();
}

/** Waits out the project's fork queue. Returns credentials once the task's fork exists. */
async function waitForFork(project: string, access: TaskAccess, timeoutMs = 180_000): Promise<TaskAccess & { fork: GitCredentials; base: GitCredentials }> {
	const deadline = Date.now() + timeoutMs;
	let current = access;
	while (current.task.status === "provisioning") {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for task ${current.task.id} to get its fork`);
		await new Promise((r) => setTimeout(r, 1000));
		const { task } = await api<{ task: Task }>("GET", `/projects/${project}/tasks/${current.task.id}`);
		current = { ...current, task };
	}
	// Past provisioning, the access endpoint itself rejects closed tasks and tasks whose fork failed.
	if (!current.fork || !current.base) current = await api<TaskAccess>("POST", `/projects/${project}/tasks/${current.task.id}/access`);
	if (!current.fork || !current.base) throw new Error(`Task ${current.task.id} has no credentials yet`);
	return current as TaskAccess & { fork: GitCredentials; base: GitCredentials };
}

/** Remote URL with the token secret in the password slot, so plain `git push`/`pull` just work. */
function authRemote(creds: GitCredentials): string {
	const url = new URL(creds.remote);
	url.username = "x";
	url.password = creds.token.split("?expires=")[0];
	return url.toString();
}

async function loadCheckout(dir: string): Promise<Checkout> {
	const path = join(await git(["rev-parse", "--absolute-git-dir"], dir), "megit.json");
	if (!existsSync(path)) throw new Error(`${dir} is not a megit task checkout (run \`megit start\`)`);
	return JSON.parse(await readFile(path, "utf8"));
}

/** Mints fresh tokens and rewrites the `origin` (fork) and `base` (project) remotes. */
async function refreshAccess(dir: string, co: Checkout) {
	const access = await waitForFork(co.project, await api<TaskAccess>("POST", `/projects/${co.project}/tasks/${co.taskId}/access`));
	await git(["remote", "set-url", "origin", authRemote(access.fork)], dir);
	await git(["remote", "set-url", "base", authRemote(access.base)], dir);
	return access;
}

function printTask(t: Task) {
	const retried = t.forkAttempts > 1 ? ` (fork attempts: ${t.forkAttempts})` : "";
	const extra = t.status === "conflict" ? ` conflicts: ${t.conflict?.files.join(", ")}` : t.error ? ` error: ${t.error}` : "";
	console.log(`${t.id}  ${t.status.padEnd(12)}  ${t.agent ?? "-"}  ${t.title}${extra}${retried}`);
}

async function waitForTask(co: Checkout, timeoutMs = 300_000): Promise<Task> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const { task } = await api<{ task: Task }>("GET", `/projects/${co.project}/tasks/${co.taskId}`);
		if (!["queued", "merging"].includes(task.status)) return task;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${task.id} (still ${task.status})`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
	async projects() {
		const { projects } = await api<{ projects: { name: string; head: string | null; queueLength: number }[] }>("GET", "/projects");
		for (const p of projects) console.log(`${p.name}  head=${p.head?.slice(0, 8) ?? "-"}  queue=${p.queueLength}`);
	},

	async init(args) {
		const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { import: { type: "string" }, description: { type: "string" } } });
		const [name] = positionals;
		if (!name) throw new Error("usage: megit init <project> [--import <https-url>] [--description <text>]");
		const { project } = await api<{ project: { name: string; remote: string } }>("POST", "/projects", {
			name,
			description: values.description,
			importUrl: values.import,
		});
		console.log(`Created project ${project.name} (${project.remote})`);
	},

	async start(args) {
		const { positionals, values } = parseArgs({
			args,
			allowPositionals: true,
			options: { agent: { type: "string" }, paths: { type: "string" }, dir: { type: "string" } },
		});
		const [project, ...titleWords] = positionals;
		const title = titleWords.join(" ");
		if (!project || !title) throw new Error('usage: megit start <project> "<title>" [--agent name] [--paths a,b/] [--dir path]');
		const created = await api<TaskAccess>("POST", `/projects/${project}/tasks`, {
			title,
			agent: values.agent ?? process.env.MEGIT_AGENT,
			paths: values.paths?.split(",").filter(Boolean),
		});
		if (created.task.status === "provisioning") console.error(`Task ${created.task.id} is waiting for its fork…`);
		const access = await waitForFork(project, created);
		const dir = resolve(values.dir ?? `${project}-${access.task.id}`);
		await git(["clone", "--quiet", authRemote(access.fork), dir]);
		await git(["remote", "add", "base", authRemote(access.base)], dir);
		if (values.agent) {
			await git(["config", "user.name", values.agent], dir);
			await git(["config", "user.email", `${values.agent}@agents.megit.dev`], dir);
		}
		const co: Checkout = { api: API, project, taskId: access.task.id };
		await writeFile(join(dir, ".git", "megit.json"), JSON.stringify(co, null, 2));
		console.log(`Task ${access.task.id} ready in ${dir}`);
		for (const o of access.overlaps) console.log(`  warning: overlaps ${o.id} (${o.agent ?? "-"}, ${o.status}) on ${o.paths.join(", ")}`);
		console.log(dir);
	},

	async status(args) {
		const co = await loadCheckout(args[0] ?? ".");
		const { task } = await api<{ task: Task }>("GET", `/projects/${co.project}/tasks/${co.taskId}`);
		printTask(task);
	},

	async sync(args) {
		const dir = args[0] ?? ".";
		const co = await loadCheckout(dir);
		const access = await refreshAccess(dir, co);
		await git(["fetch", "--quiet", "base", access.base.branch], dir);
		try {
			await git(["merge", "--no-edit", "--quiet", `base/${access.base.branch}`], dir);
			console.log(`Synced with base/${access.base.branch}`);
		} catch {
			const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], dir);
			console.log(`Merge conflicts to resolve, then commit and \`megit submit\`:\n${conflicted}`);
			process.exitCode = 2;
		}
	},

	async submit(args) {
		const { positionals, values } = parseArgs({
			args,
			allowPositionals: true,
			options: { message: { type: "string", short: "m" }, wait: { type: "boolean", short: "w" } },
		});
		const dir = positionals[0] ?? ".";
		const co = await loadCheckout(dir);
		const access = await refreshAccess(dir, co);
		if (await git(["status", "--porcelain"], dir)) {
			await git(["add", "-A"], dir);
			await git(["commit", "--quiet", "-m", values.message ?? access.task.title], dir);
		}
		await git(["push", "--quiet", "origin", `HEAD:${access.fork.branch}`], dir);
		await api("POST", `/projects/${co.project}/tasks/${co.taskId}/submit`);
		if (!values.wait) return console.log(`Submitted ${co.taskId}`);
		const task = await waitForTask(co);
		printTask(task);
		if (task.status !== "merged") process.exitCode = task.status === "conflict" ? 2 : 1;
	},

	async abandon(args) {
		const co = await loadCheckout(args[0] ?? ".");
		const { task } = await api<{ task: Task }>("POST", `/projects/${co.project}/tasks/${co.taskId}/abandon`);
		printTask(task);
	},

	async tasks(args) {
		const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { status: { type: "string" } } });
		if (!positionals[0]) throw new Error("usage: megit tasks <project> [--status <status>]");
		const q = values.status ? `?status=${values.status}` : "";
		const { tasks } = await api<{ tasks: Task[] }>("GET", `/projects/${positionals[0]}/tasks${q}`);
		tasks.forEach(printTask);
	},

	async queue(args) {
		if (!args[0]) throw new Error("usage: megit queue <project>");
		const { queue } = await api<{ queue: { position: number; taskId: string; status: string; title: string }[] }>("GET", `/projects/${args[0]}/queue`);
		for (const q of queue) console.log(`${q.position}. ${q.taskId}  ${q.status}  ${q.title}`);
	},

	async watch(args) {
		if (!args[0]) throw new Error("usage: megit watch <project>");
		const url = new URL(`${API}/api/projects/${args[0]}/live`);
		url.protocol = url.protocol.replace("http", "ws");
		url.searchParams.set("key", KEY);
		const ws = new WebSocket(url);
		ws.onopen = () => console.log(`Watching ${args[0]}…`);
		ws.onmessage = (m) => {
			const e = JSON.parse(String(m.data)) as ProjectEvent;
			console.log(`#${e.seq} ${e.ts} ${e.type}${e.taskId ? ` ${e.taskId}` : ""} ${JSON.stringify(e.data)}`);
		};
		ws.onclose = () => process.exit(0);
		await new Promise(() => {});
	},
};

const [command, ...rest] = process.argv.slice(2);
const run = commands[command ?? ""];
if (!run) {
	console.log(`megit <command>

  projects                                   List projects
  init <project> [--import url]              Create a project (or import a public Git repo)
  start <project> "<title>" [--agent a]      Fork the project for a new task and clone it
        [--paths src/,README.md] [--dir d]   (paths are advisory claims used for overlap warnings)
  status [dir]                               Show the task for a checkout
  sync [dir]                                 Merge the latest default branch into the checkout
  submit [dir] [-m msg] [--wait]             Commit, push to the fork, and enqueue for merge
  abandon [dir]                              Drop the task and delete its fork
  tasks <project> [--status s]               List tasks
  queue <project>                            Show the merge queue
  watch <project>                            Stream live project events

  env: MEGIT_URL (default http://127.0.0.1:8787), MEGIT_API_KEY (default "dev"), MEGIT_AGENT`);
	process.exit(command ? 1 : 0);
}
run(rest).catch((err) => {
	console.error(`megit: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
