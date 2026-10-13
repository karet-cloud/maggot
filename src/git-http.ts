// Git smart HTTP at `<origin>/<owner>/<repo>.git`: plain `git clone`, `fetch` and `push` against megit
// URLs. The Worker checks who may do what, then streams the exchange to the repository in Artifacts
// with a short-lived internal token, so users only ever hold megit credentials.
import { canRead, canWrite, resolvePrincipal, type Principal } from "./auth.ts";
import { addRepoBytes, db, ensureSchema, findRepo, type RepoRow } from "./db.ts";
import { toHttpError } from "./errors.ts";
import { clientIp, formatBytes, guardCredentials, limit, policy, pushBlocked, RateLimited, rules, verificationRequired } from "./policy.ts";
import { pushAccepted } from "./git/protocol.ts";
import type { RemoteAccess } from "./git/workspace.ts";
import type { ProjectCoordinator } from "./project.ts";

const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

export interface GitRoute {
	owner: string;
	repo: string;
	/** `info/refs`, `git-upload-pack` or `git-receive-pack`. */
	endpoint: string;
}

export function matchGitPath(pathname: string): GitRoute | null {
	const m = GIT_PATH.exec(pathname);
	return m ? { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), endpoint: m[3] } : null;
}

const challenge = (message: string) =>
	new Response(`${message}\n`, { status: 401, headers: { "www-authenticate": 'Basic realm="megit"', "content-type": "text/plain" } });

const deny = (status: number, message: string) => new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });

const pkt = (line: string) => {
	const bytes = new TextEncoder().encode(line);
	return `${(bytes.length + 4).toString(16).padStart(4, "0")}${line}`;
};

/**
 * Refuses a push at the start, in the protocol itself: git prints "remote error: <message>" rather
 * than a bare HTTP status.
 */
const refusePush = (message: string) =>
	new Response(`${pkt("# service=git-receive-pack\n")}0000${pkt(`ERR ${message}\n`)}`, {
		headers: { "content-type": "application/x-git-receive-pack-advertisement", "cache-control": "no-cache" },
	});

/** Whether a caller may fetch from (or push to) a repository, and if not, what to tell them. */
export type GitAccess =
	| { ok: true; row: RepoRow }
	/** `inProtocol`: say it as a git protocol error (for pushes refused by policy rather than permissions). */
	| { ok: false; status: 401 | 403 | 404; message: string; inProtocol?: boolean };

/** The checks git over HTTP and over SSH share: visibility, ownership, archiving, email verification and quotas. */
export async function authorizeGit(env: Env, principal: Principal, owner: string, name: string, pushing: boolean, origin: string): Promise<GitAccess> {
	await ensureSchema(db(env));
	const row = await findRepo(db(env), owner, name);
	// Like GitHub, a repository the caller can't see asks for credentials rather than confirming it exists.
	if (!row || !canRead(principal, row)) {
		return principal.kind === "anonymous"
			? { ok: false, status: 401, message: "Authentication required." }
			: { ok: false, status: 404, message: `Repository ${owner}/${name} not found.` };
	}
	if (!pushing) return { ok: true, row };
	if (!canWrite(principal, row)) {
		return principal.kind === "anonymous"
			? { ok: false, status: 401, message: "Authentication required to push." }
			: { ok: false, status: 403, message: `You can't push to ${row.owner}/${row.name}.` };
	}
	if (row.archivedAt) return { ok: false, status: 403, inProtocol: true, message: `${row.owner}/${row.name} is archived, so it's read-only.` };
	if (principal.kind === "user") {
		if (!principal.verified && verificationRequired(env)) {
			return { ok: false, status: 403, inProtocol: true, message: `Verify your email address before pushing; the link is in the email megit sent when you signed up (${origin}).` };
		}
		const blocked = await pushBlocked(env, db(env), row);
		if (blocked) return { ok: false, status: 403, inProtocol: true, message: blocked };
	}
	return { ok: true, row };
}

/** A request to the repository's storage remote, as git would make it, with an internal token. */
export function upstreamFetch(
	upstream: RemoteAccess,
	endpoint: string,
	init: { method: string; headers?: Record<string, string | null | undefined>; body?: BodyInit | null; signal?: AbortSignal },
): Promise<Response> {
	const headers = new Headers({ authorization: `Basic ${btoa(`x:${upstream.token.split("?expires=")[0]}`)}` });
	for (const [name, value] of Object.entries(init.headers ?? {})) if (value) headers.set(name, value);
	if (!headers.has("user-agent")) headers.set("user-agent", "git/megit");
	return fetch(`${upstream.url}/${endpoint}`, { method: init.method, headers, body: init.body, signal: init.signal });
}

/**
 * Once storage has answered a push, records it: the size counts if the push was accepted, and the web
 * UI, its live feed and webhooks hear about it. Reads a copy of the response, so this happens even if
 * the client hangs up first. Returns the body to pass on.
 */
export function watchPush(env: Env, ctx: ExecutionContext, row: RepoRow, body: ReadableStream<Uint8Array>, sent: () => number): ReadableStream<Uint8Array> {
	const coordinator = (env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(row.id);
	const [client, watcher] = body.tee();
	ctx.waitUntil(
		new Response(watcher)
			.arrayBuffer()
			.then(async (report) => {
				if (!pushAccepted(new Uint8Array(report))) return;
				const bytes = sent();
				await Promise.all([coordinator.pushed(), bytes > 0 ? addRepoBytes(db(env), row.id, bytes) : null]);
			})
			.catch((err) => console.error("recording push failed", err)),
	);
	return client;
}

export async function handleGit(request: Request, env: Env, ctx: ExecutionContext, route: GitRoute): Promise<Response> {
	const url = new URL(request.url);
	const service = route.endpoint === "info/refs" ? url.searchParams.get("service") : route.endpoint;
	// Only the smart protocol; the dumb one would need direct object access.
	if (!service || !SERVICES.has(service)) return deny(403, "Only smart HTTP is supported; upgrade git.");
	if (route.endpoint !== "info/refs" && request.method !== "POST") return deny(405, "Method not allowed");

	let principal: Principal;
	try {
		principal = await guardCredentials(env, request, () => resolvePrincipal(env, request));
		if (principal.kind !== "admin") {
			const subject = principal.kind === "user" ? `user:${principal.id}` : `ip:${clientIp(request)}`;
			await limit(env, subject, rules.git(policy(env)), "Too many git requests");
		}
	} catch (err) {
		if (err instanceof RateLimited) return new Response(`${err.detail}\n`, { status: 429, headers: { "content-type": "text/plain", "retry-after": String(err.retryAfter) } });
		return toHttpError(err).status === 401 ? challenge("Invalid username or token.") : deny(500, "Authentication failed");
	}
	const pushing = service === "git-receive-pack";
	const access = await authorizeGit(env, principal, route.owner, route.repo, pushing, url.origin);
	if (!access.ok) {
		if (access.status === 401) return challenge(access.message);
		return access.inProtocol ? refusePush(access.message) : deny(access.status, access.message);
	}
	const { row } = access;
	const maxPush = policy(env).pushBytes;
	if (pushing && route.endpoint === "git-receive-pack" && Number(request.headers.get("content-length") ?? 0) > maxPush) {
		return deny(413, `A push can be at most ${formatBytes(maxPush)}.`);
	}

	const coordinator = (env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(row.id);
	const upstream = await coordinator.gitRemote(pushing ? "write" : "read");
	const headers = Object.fromEntries(["user-agent", "content-type", "accept", "content-encoding", "git-protocol"].map((name) => [name, request.headers.get(name)]));
	// Counts what a push sends, for the repository's size, and stops one that runs past the limit.
	let sent = 0;
	const counted =
		request.body && pushing && route.endpoint === "git-receive-pack"
			? request.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							sent += chunk.byteLength;
							if (sent > maxPush) controller.error(new Error(`A push can be at most ${formatBytes(maxPush)}`));
							else controller.enqueue(chunk);
						},
					}),
				)
			: request.body;
	let res: Response;
	try {
		res = await upstreamFetch(upstream, `${route.endpoint}${url.search}`, {
			method: request.method,
			headers,
			body: request.method === "POST" ? counted : undefined,
		});
	} catch (err) {
		if (sent > maxPush) return deny(413, `A push can be at most ${formatBytes(maxPush)}.`);
		throw err;
	}

	const out = new Headers({ "cache-control": "no-cache" });
	for (const name of ["content-type", "expires", "pragma"]) {
		const value = res.headers.get(name);
		if (value) out.set(name, value);
	}
	if (res.status === 401 || res.status === 403) return deny(502, "The storage backend refused the request.");
	if (pushing && route.endpoint === "git-receive-pack" && res.ok && res.body) {
		return new Response(watchPush(env, ctx, row, res.body, () => sent), { status: res.status, headers: out });
	}
	return new Response(res.body, { status: res.status, headers: out });
}
