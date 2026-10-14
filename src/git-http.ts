// Git smart HTTP at `<origin>/<owner>/<repo>.git`: plain `git clone`, `fetch` and `push` against megit
// URLs. The Worker checks who may do what, then streams the exchange to the repository in Artifacts
// with a short-lived internal token, so users only ever hold megit credentials.
import { apiKey, canRead, canWrite, resolvePrincipal, type Principal } from "./auth.ts";
import { CHECKOUT_TOKEN_PREFIX, verifyCheckoutToken } from "./ci/token.ts";
import { addRepoBytes, db, ensureSchema, findRepo, type RepoRow } from "./db.ts";
import { toHttpError } from "./errors.ts";
import { clientIp, formatBytes, guardCredentials, limit, policy, pushBlocked, RateLimited, rules, verificationRequired } from "./policy.ts";
import { listRefs, pushAccepted, RefUpdateRejected, setRef } from "./git/protocol.ts";
import { checkPush, isAncestor, mapReport, parseCommands, quarantine, refusalReport, type Staged } from "./protection.ts";
import { repoStore } from "./store.ts";
import type { RemoteAccess } from "./git/workspace.ts";
import type { BranchRule } from "./api.ts";
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
	/** `wiki`: the request is for the repository's wiki (`<name>.wiki.git`). */
	| { ok: true; row: RepoRow; wiki: boolean }
	/** `inProtocol`: say it as a git protocol error (for pushes refused by policy rather than permissions). */
	| { ok: false; status: 401 | 403 | 404; message: string; inProtocol?: boolean };

/** The checks git over HTTP and over SSH share: visibility, ownership, archiving, email verification and quotas. */
export async function authorizeGit(env: Env, principal: Principal, owner: string, name: string, pushing: boolean, origin: string): Promise<GitAccess> {
	await ensureSchema(db(env));
	const viewer = principal.kind === "user" ? principal.id : null;
	let row = await findRepo(db(env), owner, name, viewer);
	// `<name>.wiki` is the wiki of `<name>`. New repositories can't be named like that (assertRepoName),
	// so only one named so before the rule (or an old name that redirects) takes the name first.
	let wiki = false;
	if (!row && /\.wiki$/i.test(name)) {
		row = await findRepo(db(env), owner, name.slice(0, -".wiki".length), viewer);
		wiki = row !== null;
	}
	// Like GitHub, a repository the caller can't see asks for credentials rather than confirming it exists.
	// A wiki that's turned off is as good as missing (its pages are kept).
	if (!row || !canRead(principal, row) || (wiki && !row.hasWiki)) {
		return principal.kind === "anonymous"
			? { ok: false, status: 401, message: "Authentication required." }
			: { ok: false, status: 404, message: `Repository ${owner}/${name} not found.` };
	}
	if (!pushing) return { ok: true, row, wiki };
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
	return { ok: true, row, wiki };
}

/**
 * Where an authorized git request goes: the repository's storage, with its branch rules for pushes,
 * or its wiki's, which has neither branch rules nor Actions. Null for a clone of a wiki with no pages yet.
 */
export async function gitUpstream(env: Env, access: Extract<GitAccess, { ok: true }>, pushing: boolean): Promise<{ remote: RemoteAccess; rules: BranchRule[] } | null> {
	const coordinator = (env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(access.row.id);
	if (access.wiki) {
		const remote = await coordinator.wikiRemote(pushing ? "write" : "read");
		return remote ? { remote, rules: [] } : null;
	}
	return pushing ? coordinator.pushContext() : { remote: await coordinator.gitRemote("read"), rules: [] };
}

/** What git hears when it clones a wiki nobody has written a page in yet. */
export const EMPTY_WIKI = "This wiki has no pages yet. Create the first page on the web, or push one.";

/** The Actions checkout token (`mgci_…`) a request carries as its Basic password, if it carries one. */
function checkoutToken(request: Request): string | null {
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Basic ")) return null;
	let decoded: string;
	try {
		decoded = atob(header.slice(6).trim());
	} catch {
		return null;
	}
	const secret = decoded.slice(decoded.indexOf(":") + 1);
	return secret.startsWith(CHECKOUT_TOKEN_PREFIX) ? secret : null;
}

/**
 * An Actions job checking out its commit: the token is read-only, for the repositories it names (by
 * id, so a rename doesn't matter), and expires soon after the job's time limit. It works whatever the
 * repository's visibility, since the job's run was already allowed to read it.
 */
async function authorizeCheckout(env: Env, token: string, route: GitRoute, pushing: boolean): Promise<{ ok: true; row: RepoRow } | { ok: false; status: 401 | 403 | 404; message: string }> {
	const grant = await verifyCheckoutToken(apiKey(env), token);
	if (!grant) return { ok: false, status: 401, message: "That Actions checkout token is invalid or has expired." };
	if (pushing) return { ok: false, status: 403, message: "Actions checkout tokens are read-only." };
	await ensureSchema(db(env));
	const row = await findRepo(db(env), route.owner, route.repo, null);
	if (!row || !grant.repos.includes(row.id)) return { ok: false, status: 404, message: `Repository ${route.owner}/${route.repo} not found.` };
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
export function watchPush(env: Env, ctx: ExecutionContext, row: RepoRow, body: ReadableStream<Uint8Array>, sent: () => number, actor: string | null, wiki = false): ReadableStream<Uint8Array> {
	const coordinator = (env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(row.id);
	const [client, watcher] = body.tee();
	ctx.waitUntil(
		new Response(watcher)
			.arrayBuffer()
			.then(async (report) => {
				if (!pushAccepted(new Uint8Array(report))) return;
				const bytes = sent();
				// A push to the wiki counts toward the repository's size, like one to its code.
				await Promise.all([wiki ? coordinator.wikiPushed(actor) : coordinator.pushed(actor), bytes > 0 ? addRepoBytes(db(env), row.id, bytes) : null]);
			})
			.catch((err) => console.error("recording push failed", err)),
	);
	return client;
}

/** The longest command list a push may start with before its pack. */
const MAX_COMMANDS_BYTES = 4 * 1024 * 1024;

/** Splits a receive-pack request body into its commands (through the first flush) and the rest. */
export async function splitCommands(body: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
	const reader = body.getReader();
	let buffer = new Uint8Array(0);
	const more = async (): Promise<boolean> => {
		const { done, value } = await reader.read();
		if (done) return false;
		const next = new Uint8Array(buffer.length + value.length);
		next.set(buffer);
		next.set(value, buffer.length);
		buffer = next;
		if (buffer.length > MAX_COMMANDS_BYTES) throw new Error("Push commands too long");
		return true;
	};
	const decoder = new TextDecoder();
	let end = 0;
	for (let offset = 0; ; ) {
		while (buffer.length < offset + 4) if (!(await more())) break;
		if (buffer.length < offset + 4) {
			end = buffer.length;
			break;
		}
		const size = Number.parseInt(decoder.decode(buffer.subarray(offset, offset + 4)), 16);
		if (Number.isNaN(size)) throw new Error("Malformed push request");
		if (size === 0) {
			end = offset + 4;
			break;
		}
		offset += Math.max(size, 4);
		while (buffer.length < offset) if (!(await more())) break;
		if (buffer.length < offset) {
			end = buffer.length;
			break;
		}
	}
	const head = buffer.slice(0, end);
	const leftover = buffer.slice(end);
	const rest = new ReadableStream<Uint8Array>({
		start(controller) {
			if (leftover.length > 0) controller.enqueue(leftover);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { head, rest };
}

/** Reads and drops what's left of a request, up to `max` bytes, so the client gets to read the answer. */
export async function discard(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, max: number): Promise<void> {
	let total = 0;
	for await (const chunk of stream as AsyncIterable<Uint8Array>) {
		total += chunk.length;
		if (total > max) break;
	}
}

/**
 * After a push whose fast-forward-only updates went to holding refs (see `quarantine`): each one that
 * landed is checked, and its branch moves (compare-and-swap, from the value the client saw) only if
 * the new commits descend from the old head. The holding refs are removed either way, and git's
 * report names the real branches with the real outcome. Nothing depends on the client having asked
 * for a report: what landed is read back from storage.
 */
export async function settleStaged(env: Env, row: RepoRow, upstream: RemoteAccess, response: Uint8Array, staged: Staged[], capabilities: string[]): Promise<Uint8Array> {
	if (staged.length === 0) return response;
	const { branches } = await listRefs(upstream, true);
	const outcomes = new Map<string, string>();
	using repo = await repoStore(env).get(row.id);
	for (const { command, temp } of staged) {
		const ref = command.ref;
		if (branches.get(temp.slice("refs/heads/".length)) !== command.new) continue; // storage refused it; its report says why
		const fastForward = await isAncestor(repo, command.old, command.new).catch(() => null);
		if (fastForward === true) {
			try {
				await setRef(upstream, ref, command.old, command.new);
				outcomes.set(temp, `ok ${ref}`);
			} catch (err) {
				outcomes.set(temp, err instanceof RefUpdateRejected ? `ng ${ref} fetch first: the branch moved while you were pushing` : `ng ${ref} couldn't update the branch; try again`);
			}
		} else {
			outcomes.set(
				temp,
				`ng ${ref} ${fastForward === null ? "protected branch: too many new commits to confirm a fast-forward; push fewer at a time" : "protected branch: force pushes aren't allowed"}`,
			);
		}
		await setRef(upstream, temp, command.new, null).catch((err) => console.error("removing a holding ref failed", err));
	}
	const real = new Map(staged.map((s) => [s.temp, s.command.ref]));
	return mapReport(response, capabilities, (line) => {
		const [status, ref] = line.split(" ", 2);
		if ((status === "ok" || status === "ng") && real.has(ref)) return outcomes.get(ref) ?? line.replace(ref, real.get(ref) as string);
		// report-status-v2 option lines name refs too.
		for (const [temp, name] of real) if (line.includes(temp)) return line.replace(temp, name);
		return line;
	});
}

const RESULT_HEADERS = { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" };

export async function handleGit(request: Request, env: Env, ctx: ExecutionContext, route: GitRoute): Promise<Response> {
	const url = new URL(request.url);
	const service = route.endpoint === "info/refs" ? url.searchParams.get("service") : route.endpoint;
	// Only the smart protocol; the dumb one would need direct object access.
	if (!service || !SERVICES.has(service)) return deny(403, "Only smart HTTP is supported; upgrade git.");
	if (route.endpoint !== "info/refs" && request.method !== "POST") return deny(405, "Method not allowed");

	const pushing = service === "git-receive-pack";
	const checkout = checkoutToken(request);
	if (checkout !== null) {
		const ci = await authorizeCheckout(env, checkout, route, pushing);
		if (!ci.ok) return ci.status === 401 ? challenge(ci.message) : deny(ci.status, ci.message);
		const remote = await (env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(ci.row.id).gitRemote("read");
		const headers = Object.fromEntries(["user-agent", "content-type", "accept", "content-encoding", "git-protocol"].map((name) => [name, request.headers.get(name)]));
		const res = await upstreamFetch(remote, `${route.endpoint}${url.search}`, { method: request.method, headers, body: request.method === "POST" ? request.body : undefined });
		if (res.status === 401 || res.status === 403) return deny(502, "The storage backend refused the request.");
		const out = new Headers({ "cache-control": "no-cache" });
		for (const name of ["content-type", "expires", "pragma"]) {
			const value = res.headers.get(name);
			if (value) out.set(name, value);
		}
		return new Response(res.body, { status: res.status, headers: out });
	}

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
	const access = await authorizeGit(env, principal, route.owner, route.repo, pushing, url.origin);
	if (!access.ok) {
		if (access.status === 401) return challenge(access.message);
		return access.inProtocol ? refusePush(access.message) : deny(access.status, access.message);
	}
	const { row } = access;
	// Who pushed, for the runs a push starts.
	const pusher = principal.kind === "user" ? principal.username : null;
	const maxPush = policy(env).pushBytes;
	if (pushing && route.endpoint === "git-receive-pack" && Number(request.headers.get("content-length") ?? 0) > maxPush) {
		return deny(413, `A push can be at most ${formatBytes(maxPush)}.`);
	}

	const target = await gitUpstream(env, access, pushing);
	if (!target) return deny(404, EMPTY_WIKI);
	const { remote: upstream, rules: branchRules } = target;
	const headers = Object.fromEntries(["user-agent", "content-type", "accept", "content-encoding", "git-protocol"].map((name) => [name, request.headers.get(name)]));
	const receiving = pushing && route.endpoint === "git-receive-pack";
	let requestBody = request.body;
	// Protected branches: refuse what the commands alone show is not allowed, and note the branches
	// that may only fast-forward, to check once the push is stored.
	let protect: { staged: Staged[]; capabilities: string[] } | null = null;
	if (receiving && requestBody) {
		if (branchRules.length > 0) {
			if (headers["content-encoding"] === "gzip") {
				requestBody = requestBody.pipeThrough(new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
				headers["content-encoding"] = null;
			}
			const { head, rest } = await splitCommands(requestBody);
			const { commands, capabilities } = parseCommands(head);
			const { refused, fastForwardOnly } = checkPush(branchRules, commands);
			if (refused.size > 0) {
				await discard(rest, maxPush);
				return new Response(refusalReport(commands, refused, capabilities), { headers: RESULT_HEADERS });
			}
			const held = quarantine(head, fastForwardOnly);
			protect = { staged: held.staged, capabilities };
			requestBody = concatStreams(held.head, rest);
		}
	}
	// Counts what a push sends, for the repository's size, and stops one that runs past the limit.
	let sent = 0;
	const counted =
		requestBody && receiving
			? requestBody.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							sent += chunk.byteLength;
							if (sent > maxPush) controller.error(new Error(`A push can be at most ${formatBytes(maxPush)}`));
							else controller.enqueue(chunk);
						},
					}),
				)
			: requestBody;
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
	if (receiving && res.ok && res.body) {
		if (protect && protect.staged.length > 0) {
			// The report is small; hold it until the protected branches have been checked and moved.
			const report = await settleStaged(env, row, upstream, new Uint8Array(await res.arrayBuffer()), protect.staged, protect.capabilities);
			return new Response(watchPush(env, ctx, row, new Response(report).body as ReadableStream<Uint8Array>, () => sent, pusher), { status: res.status, headers: out });
		}
		return new Response(watchPush(env, ctx, row, res.body, () => sent, pusher, access.wiki), { status: res.status, headers: out });
	}
	return new Response(res.body, { status: res.status, headers: out });
}

/** `head`, then everything `rest` yields. */
function concatStreams(head: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = rest.getReader();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(head);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}
