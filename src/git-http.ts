// Git smart HTTP at `<origin>/<owner>/<repo>.git`: plain `git clone`, `fetch` and `push` against megit
// URLs. The Worker checks who may do what, then streams the exchange to the repository in Artifacts
// with a short-lived internal token, so users only ever hold megit credentials.
import { canRead, canWrite, resolvePrincipal, type Principal } from "./auth.ts";
import { addRepoBytes, db, ensureSchema, findRepo } from "./db.ts";
import { toHttpError } from "./errors.ts";
import { clientIp, formatBytes, guardCredentials, limit, policy, pushBlocked, RateLimited, rules, verificationRequired } from "./policy.ts";
import { pushAccepted } from "./git/protocol.ts";
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
	await ensureSchema(db(env));
	const row = await findRepo(db(env), route.owner, route.repo);
	const pushing = service === "git-receive-pack";
	// Like GitHub, a repository the caller can't see asks for credentials rather than confirming it exists.
	if (!row || !canRead(principal, row)) {
		return principal.kind === "anonymous" ? challenge("Authentication required.") : deny(404, `Repository ${route.owner}/${route.repo} not found.`);
	}
	if (pushing && !canWrite(principal, row)) {
		return principal.kind === "anonymous" ? challenge("Authentication required to push.") : deny(403, `You can't push to ${row.owner}/${row.name}.`);
	}
	if (pushing && principal.kind === "user") {
		if (!principal.verified && verificationRequired(env)) {
			return refusePush(`Verify your email address before pushing; the link is in the email megit sent when you signed up (${url.origin}).`);
		}
		const blocked = await pushBlocked(env, db(env), row);
		if (blocked) return refusePush(blocked);
	}
	const maxPush = policy(env).pushBytes;
	if (pushing && route.endpoint === "git-receive-pack" && Number(request.headers.get("content-length") ?? 0) > maxPush) {
		return deny(413, `A push can be at most ${formatBytes(maxPush)}.`);
	}

	const coordinator = (env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(row.id);
	const upstream = await coordinator.gitRemote(pushing ? "write" : "read");
	const headers = new Headers({
		authorization: `Basic ${btoa(`x:${upstream.token.split("?expires=")[0]}`)}`,
		"user-agent": request.headers.get("user-agent") ?? "git/megit",
	});
	for (const name of ["content-type", "accept", "content-encoding", "git-protocol"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const target = `${upstream.url}/${route.endpoint}${url.search}`;
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
		res = await fetch(target, {
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
	// Once the backend has answered a push, record it: the size counts if the push was accepted, and
	// the web UI and its live feed update. A second copy of the response is read in the background, so
	// this happens even if git hangs up first.
	if (pushing && route.endpoint === "git-receive-pack" && res.ok && res.body) {
		const [client, watcher] = res.body.tee();
		ctx.waitUntil(
			new Response(watcher)
				.arrayBuffer()
				.then(async (report) => {
					if (!pushAccepted(new Uint8Array(report))) return;
					await Promise.all([coordinator.pushed(), sent > 0 ? addRepoBytes(db(env), row.id, sent) : null]);
				})
				.catch((err) => console.error("recording push failed", err)),
		);
		return new Response(client, { status: res.status, headers: out });
	}
	return new Response(res.body, { status: res.status, headers: out });
}
