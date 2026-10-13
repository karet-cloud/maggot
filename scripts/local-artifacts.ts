#!/usr/bin/env node
// Local stand-in for Cloudflare Artifacts, for development and tests without a Cloudflare account.
// Serves real Git smart HTTP via `git http-backend` with Artifacts-style repo tokens, plus a small
// JSON control API that mirrors the subset of the Workers binding megit uses (see src/store.ts).
import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

interface RepoMeta {
	id: string;
	name: string;
	description: string | null;
	defaultBranch: string;
	createdAt: string;
	updatedAt: string;
	lastPushAt: string | null;
	source: string | null;
	readOnly: boolean;
}

interface TokenRecord {
	id: string;
	repo: string;
	secret: string;
	scope: "read" | "write";
	expiresAt: string;
}

interface State {
	repos: Record<string, RepoMeta>;
	tokens: TokenRecord[];
}

export interface LocalArtifactsOptions {
	root: string;
	port: number;
	host?: string;
	namespace?: string;
	/** Base URL put into repo remotes, when agents reach the server by a different name than it binds. */
	publicUrl?: string;
	quiet?: boolean;
	/** Reproduce Cloudflare Artifacts' fork behaviour for testing. */
	simulate?: {
		/** Extra latency per fork (real forks take ~2-3s). */
		forkDelayMs?: number;
		/**
		 * Fail forks while more than this many forks of the same source are in flight, the way real
		 * Artifacts does: INTERNAL_ERROR, and the target name is left half-created (create says
		 * ALREADY_EXISTS, get says NOT_FOUND) until deleted.
		 */
		forkFailAbove?: number;
	};
}

export async function startLocalArtifacts(opts: LocalArtifactsOptions): Promise<{ url: string; server: Server; close(): Promise<void> }> {
	const root = resolve(opts.root);
	const namespace = opts.namespace ?? "megit";
	const host = opts.host ?? "127.0.0.1";
	const reposDir = join(root, "repos");
	const statePath = join(root, "state.json");
	await mkdir(reposDir, { recursive: true });
	const state: State = existsSync(statePath)
		? JSON.parse(await readFile(statePath, "utf8"))
		: { repos: {}, tokens: [] };
	let baseUrl = "";
	const forksInFlight = new Map<string, number>();
	const ghosts = new Set<string>();
	const stats = { forks: 0, forkFailures: 0, maxConcurrentForks: 0 };

	const save = () => writeFile(statePath, JSON.stringify(state, null, 2));
	const repoPath = (name: string) => join(reposDir, `${name}.git`);
	const remote = (name: string) => `${baseUrl}/git/${namespace}/${name}.git`;
	const info = (meta: RepoMeta) => ({ ...meta, remote: remote(meta.name) });
	const git = (args: string[], cwd?: string) => exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
	const gitBytes = (args: string[], cwd?: string) => exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });

	function issueToken(repo: string, scope: "read" | "write", ttl = 86400) {
		const record: TokenRecord = {
			id: randomUUID().slice(0, 16),
			repo,
			secret: `art_v1_${randomBytes(20).toString("hex")}`,
			scope,
			expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
		};
		state.tokens.push(record);
		state.tokens = state.tokens.filter((t) => Date.parse(t.expiresAt) > Date.now());
		const plaintext = `${record.secret}?expires=${Math.floor(Date.parse(record.expiresAt) / 1000)}`;
		return { id: record.id, plaintext, scope, expiresAt: record.expiresAt };
	}

	function fail(status: number, code: string, message: string): never {
		throw Object.assign(new Error(message), { status, code });
	}

	function requireRepo(name: string): RepoMeta {
		const meta = state.repos[name];
		if (!meta) fail(404, "NOT_FOUND", `Repository ${name} not found`);
		return meta;
	}

	async function createMeta(name: string, extra: Partial<RepoMeta>) {
		if (!NAME.test(name)) fail(400, "INVALID_REPO_NAME", `Invalid repo name: ${name}`);
		if (state.repos[name] || ghosts.has(name)) fail(409, "ALREADY_EXISTS", `Repository ${name} already exists`);
		const now = new Date().toISOString();
		const meta: RepoMeta = {
			id: randomUUID().slice(0, 16),
			name,
			description: null,
			defaultBranch: "main",
			createdAt: now,
			updatedAt: now,
			lastPushAt: null,
			source: null,
			readOnly: false,
			...extra,
		};
		state.repos[name] = meta;
		await git(["config", "http.receivepack", "true"], repoPath(name));
		await git(["symbolic-ref", "HEAD", `refs/heads/${meta.defaultBranch}`], repoPath(name));
		const token = issueToken(name, "write");
		await save();
		return { ...info(meta), token: token.plaintext };
	}

	const control: Record<string, (body: any, params: URLSearchParams, name: string) => Promise<unknown>> = {
		async "POST /repos"(body) {
			await rm(repoPath(body.name), { recursive: true, force: true });
			await git(["init", "--bare", "--quiet", repoPath(body.name)]);
			return createMeta(body.name, { description: body.description ?? null, defaultBranch: body.defaultBranch ?? "main" });
		},
		async "POST /import"(body) {
			const args = ["clone", "--bare", "--quiet", "--single-branch"];
			if (body.branch) args.push("--branch", body.branch);
			if (body.depth) args.push("--depth", String(body.depth));
			await git([...args, body.url, repoPath(body.name)]);
			const { stdout } = await git(["symbolic-ref", "--short", "HEAD"], repoPath(body.name));
			return createMeta(body.name, { description: body.description ?? null, defaultBranch: stdout.trim(), source: body.url });
		},
		async "GET /stats"() {
			return { ...stats, ghosts: [...ghosts] };
		},
		async "POST /simulate"(body) {
			opts.simulate = body;
			Object.assign(stats, { forks: 0, forkFailures: 0, maxConcurrentForks: 0 });
			return opts.simulate;
		},
		async "GET /repos/:name"(_b, _p, name) {
			return info(requireRepo(name));
		},
		async "DELETE /repos/:name"(_b, _p, name) {
			if (ghosts.delete(name)) return true;
			if (!state.repos[name]) return false;
			delete state.repos[name];
			state.tokens = state.tokens.filter((t) => t.repo !== name);
			await rm(repoPath(name), { recursive: true, force: true });
			await save();
			return true;
		},
		async "POST /repos/:name/tokens"(body, _p, name) {
			requireRepo(name);
			const token = issueToken(name, body.scope ?? "write", body.ttl);
			await save();
			return token;
		},
		async "POST /repos/:name/fork"(body, _p, name) {
			const source = requireRepo(name);
			if (state.repos[body.name] || ghosts.has(body.name)) fail(409, "ALREADY_EXISTS", `Repository ${body.name} already exists`);
			const inFlight = (forksInFlight.get(name) ?? 0) + 1;
			forksInFlight.set(name, inFlight);
			stats.forks++;
			stats.maxConcurrentForks = Math.max(stats.maxConcurrentForks, inFlight);
			try {
				if (opts.simulate?.forkDelayMs) await new Promise((r) => setTimeout(r, opts.simulate?.forkDelayMs));
				if (opts.simulate?.forkFailAbove !== undefined && inFlight > opts.simulate.forkFailAbove) {
					stats.forkFailures++;
					ghosts.add(body.name);
					fail(500, "INTERNAL_ERROR", "An internal error occurred.");
				}
			} finally {
				forksInFlight.set(name, (forksInFlight.get(name) ?? 1) - 1);
			}
			await git(["clone", "--bare", "--quiet", "--single-branch", "--branch", source.defaultBranch, repoPath(name), repoPath(body.name)]);
			return createMeta(body.name, {
				description: body.description ?? null,
				defaultBranch: source.defaultBranch,
				source: `artifacts:${namespace}/${name}`,
			});
		},
		async "GET /repos/:name/log"(_b, params, name) {
			requireRepo(name);
			const ref = params.get("ref") || "HEAD";
			const limit = Math.min(Number(params.get("limit") || 50), 1000);
			const offset = Number(params.get("offset") || 0);
			const sep = "\x1f";
			const format = ["%H", "%T", "%an", "%ae", "%cn", "%ce", "%P", "%at", "%ct", "%B"].join(sep) + "\x1e";
			try {
				const { stdout } = await git(["log", "--first-parent", `--skip=${offset}`, `-n${limit}`, `--format=${format}`, ref, "--"], repoPath(name));
				return stdout
					.split("\x1e")
					.map((s) => s.replace(/^\n/, ""))
					.filter(Boolean)
					.map((record) => {
						const [hash, treeHash, an, ae, cn, ce, parents, at, ct, message] = record.split(sep);
						return {
							hash,
							treeHash,
							author: { name: an, email: ae },
							committer: { name: cn, email: ce },
							parents: parents ? parents.split(" ") : [],
							authoredAt: Number(at),
							committedAt: Number(ct),
							message: message.replace(/\n$/, ""),
						};
					});
			} catch {
				return [];
			}
		},
		async "GET /repos/:name/tree"(_b, params, name) {
			requireRepo(name);
			try {
				const { stdout } = await git(["ls-tree", "-z", `${params.get("hash")}^{tree}`], repoPath(name));
				return stdout
					.split("\0")
					.filter(Boolean)
					.map((line) => {
						const [meta, entryName] = line.split("\t");
						const [mode, , hash] = meta.split(" ");
						return { name: entryName, mode: mode.replace(/^0+/, ""), hash, type: treeEntryType(mode) };
					});
			} catch {
				return null;
			}
		},
		async "GET /repos/:name/file"(_b, params, name) {
			requireRepo(name);
			try {
				const file = String(params.get("path"));
				const { stdout } = await gitBytes(["show", `${params.get("ref")}:${file}`], repoPath(name));
				return { content: stdout.toString("base64"), type: contentType(file, stdout) };
			} catch {
				return null;
			}
		},
		async "GET /repos/:name/blob"(_b, params, name) {
			requireRepo(name);
			try {
				const { stdout } = await gitBytes(["cat-file", "blob", String(params.get("hash"))], repoPath(name));
				return { content: stdout.toString("base64") };
			} catch {
				return null;
			}
		},
	};

	async function handleControl(req: IncomingMessage, res: ServerResponse, url: URL) {
		const path = url.pathname.slice("/api".length);
		const match = /^\/repos\/([^/]+)(\/.*)?$/.exec(path);
		const name = match ? decodeURIComponent(match[1]) : "";
		const route = `${req.method} ${match ? `/repos/:name${match[2] ?? ""}` : path}`;
		const handler = control[route];
		if (!handler) return json(res, 404, { error: { code: "NOT_FOUND", message: `No route ${route}` } });
		try {
			const body = req.method === "POST" ? JSON.parse((await readBody(req)).toString() || "{}") : {};
			json(res, 200, { result: await handler(body, url.searchParams, name) });
		} catch (err) {
			const e = err as { status?: number; code?: string; message: string };
			json(res, e.status ?? 500, { error: { code: e.code ?? "INTERNAL_ERROR", message: e.message } });
		}
	}

	function authorize(req: IncomingMessage, repo: string, needWrite: boolean): boolean {
		const header = req.headers.authorization ?? "";
		let secret = "";
		if (header.startsWith("Bearer ")) secret = header.slice(7);
		else if (header.startsWith("Basic ")) secret = Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":");
		secret = secret.split("?expires=")[0];
		const token = state.tokens.find((t) => t.secret === secret && t.repo === repo);
		if (!token || Date.parse(token.expiresAt) < Date.now()) return false;
		return !needWrite || token.scope === "write";
	}

	async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL) {
		const match = new RegExp(`^/git/${namespace}/([^/]+)\\.git(/.*)$`).exec(url.pathname);
		if (!match || !state.repos[match[1]]) return json(res, 404, { error: { code: "NOT_FOUND", message: "Unknown repository" } });
		const [, repo, rest] = match;
		const pushing = rest === "/git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
		if (!authorize(req, repo, pushing)) {
			res.writeHead(401, { "WWW-Authenticate": 'Basic realm="artifacts"' });
			return res.end("Unauthorized");
		}
		const child = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: reposDir,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: `/${repo}.git${rest}`,
				REQUEST_METHOD: req.method,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: req.headers["content-type"] ?? "",
				HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
				GIT_PROTOCOL: (req.headers["git-protocol"] as string) ?? "",
				REMOTE_USER: "agent",
				REMOTE_ADDR: req.socket.remoteAddress ?? "",
			},
		});
		req.pipe(child.stdin);
		let head = Buffer.alloc(0);
		let headersSent = false;
		child.stdout.on("data", (chunk: Buffer) => {
			if (headersSent) return void res.write(chunk);
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n\r\n");
			if (end === -1) return;
			let status = 200;
			for (const line of head.subarray(0, end).toString().split("\r\n")) {
				const i = line.indexOf(":");
				const key = line.slice(0, i).trim();
				const value = line.slice(i + 1).trim();
				if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
				else res.setHeader(key, value);
			}
			res.writeHead(status);
			headersSent = true;
			res.write(head.subarray(end + 4));
		});
		child.stderr.on("data", (d) => opts.quiet || process.stderr.write(d));
		child.on("close", async () => {
			if (!headersSent) res.writeHead(500);
			res.end();
			if (pushing && req.method === "POST") {
				const meta = state.repos[repo];
				if (meta) {
					meta.lastPushAt = meta.updatedAt = new Date().toISOString();
					await save();
				}
			}
		});
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://local");
		if (!opts.quiet) console.log(`[artifacts] ${req.method} ${url.pathname}${url.search}`);
		if (url.pathname.startsWith("/api/")) return void handleControl(req, res, url);
		if (url.pathname.startsWith("/git/")) return void handleGit(req, res, url);
		json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
	});

	await new Promise<void>((ok, err) => server.once("error", err).listen(opts.port, host, ok));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : opts.port;
	baseUrl = opts.publicUrl ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
	return { url: baseUrl, server, close: () => new Promise((ok) => server.close(() => ok())) };
}

function treeEntryType(mode: string): string {
	if (mode === "040000") return "tree";
	if (mode === "100755") return "exec";
	if (mode === "120000") return "symlink";
	if (mode === "160000") return "gitlink";
	return "blob";
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/** Roughly what Artifacts' readFile reports: an image type by extension, else text or binary. */
function contentType(path: string, bytes: Buffer): string {
	const image = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
	if (image) return image;
	return bytes.subarray(0, 8000).includes(0) ? "application/octet-stream" : "text/plain;charset=utf-8";
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((ok, err) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c)).on("end", () => ok(Buffer.concat(chunks))).on("error", err);
	});
}

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

if (import.meta.main) {
	const port = Number(process.env.LOCAL_ARTIFACTS_PORT ?? 8789);
	const root = process.env.LOCAL_ARTIFACTS_ROOT ?? ".megit-local/artifacts";
	const { url } = await startLocalArtifacts({
		root,
		port,
		host: process.env.LOCAL_ARTIFACTS_HOST,
		publicUrl: process.env.LOCAL_ARTIFACTS_PUBLIC_URL,
		simulate: simulateFromEnv(),
	});
	console.log(`Local Artifacts listening on ${url} (data in ${root})`);
}

/** LOCAL_ARTIFACTS_FORK_DELAY_MS / LOCAL_ARTIFACTS_FORK_FAIL_ABOVE switch on fork failure simulation. */
export function simulateFromEnv(): LocalArtifactsOptions["simulate"] {
	const delay = process.env.LOCAL_ARTIFACTS_FORK_DELAY_MS;
	const failAbove = process.env.LOCAL_ARTIFACTS_FORK_FAIL_ABOVE;
	return {
		forkDelayMs: delay ? Number(delay) : undefined,
		forkFailAbove: failAbove ? Number(failAbove) : undefined,
	};
}
