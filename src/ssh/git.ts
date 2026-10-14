// git over SSH: `git-upload-pack` and `git-receive-pack` commands, bridged to the repository's smart
// HTTP remote in Artifacts. Fetches use protocol v2, which is stateless, so each request the client
// sends becomes one HTTP request. Pushes are one request: the commands, then the pack.
import type { Principal } from "../auth.ts";
import { formatBytes, limit, policy, RateLimited, rules } from "../policy.ts";
import { authorizeGit, EMPTY_WIKI, gitUpstream, settleStaged, upstreamFetch, watchPush } from "../git-http.ts";
import { checkPush, parseCommands, quarantine, refusalReport, type Staged } from "../protection.ts";
import type { Session, SshUser } from "./server.ts";
import { concat } from "./wire.ts";

export interface GitUser extends SshUser {
	principal: Extract<Principal, { kind: "user" }>;
}

const ZERO = "0".repeat(40);
/** A fetch request (wants and haves) or a push's commands; packs aren't buffered. */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** `git-upload-pack 'owner/repo.git'` and the like, as git sends them. */
export function parseGitCommand(command: string): { service: "git-upload-pack" | "git-receive-pack"; owner: string; repo: string } | null {
	const m = /^(git[- ](?:upload|receive)-pack) '([^']*)'$/.exec(command.trim()) ?? /^(git[- ](?:upload|receive)-pack) "?([^"' ]+)"?$/.exec(command.trim());
	if (!m) return null;
	const service = m[1].replace(" ", "-") as "git-upload-pack" | "git-receive-pack";
	const path = m[2].replace(/^\/+/, "").replace(/\/+$/, "");
	const parts = path.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { service, owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

/** Runs one git command for an authenticated user; resolves to the exit status. */
export async function runGitCommand(env: Env, ctx: ExecutionContext, origin: string, session: Session<GitUser>, command: string): Promise<number> {
	const fail = async (message: string) => {
		await session.stderr(`${message}\n`);
		return 1;
	};
	const principal = session.user.principal;
	if (command.trim() === "") {
		return fail(`Hi ${principal.username}! You've successfully authenticated, but megit doesn't provide shell access.`);
	}
	const parsed = parseGitCommand(command);
	if (!parsed) return fail("megit only runs git-upload-pack and git-receive-pack over SSH, for git fetch, clone and push.");
	try {
		await limit(env, `user:${principal.id}`, rules.git(policy(env)), "Too many git requests");
	} catch (err) {
		if (err instanceof RateLimited) return fail(`${err.detail} Try again in ${err.retryAfter} seconds.`);
		throw err;
	}
	const pushing = parsed.service === "git-receive-pack";
	const access = await authorizeGit(env, principal, parsed.owner, parsed.repo, pushing, origin);
	if (!access.ok) return fail(`ERROR: ${access.message}`);
	// `owner/name.wiki.git` reaches the wiki, as over HTTPS.
	const target = await gitUpstream(env, access, pushing);
	if (!target) return fail(`ERROR: ${EMPTY_WIKI}`);
	const { remote: upstream, rules: branchRules } = target;
	const input = new PktReader(session);
	const protocol = session.env.get("GIT_PROTOCOL") ?? "";

	if (!pushing) {
		// Protocol v1 fetches keep state between rounds of negotiation, which HTTP requests to storage can't.
		if (!/(^|:)version=2(:|$)/.test(protocol)) {
			return fail("ERROR: megit's SSH needs Git protocol version 2. Use git 2.26 or newer, or run: git config --global protocol.version 2");
		}
		const headers = { "git-protocol": "version=2" };
		const advertised = await upstreamFetch(upstream, "info/refs?service=git-upload-pack", { method: "GET", headers, signal: session.signal });
		if (!advertised.ok) return fail("ERROR: The storage backend refused the request.");
		await session.write(stripServiceBanner(new Uint8Array(await advertised.arrayBuffer())));
		for (;;) {
			const request = await input.untilFlush();
			// The client ends the session by hanging up, or with a lone flush.
			if (!request || request.length === 4) return 0;
			const res = await upstreamFetch(upstream, "git-upload-pack", {
				method: "POST",
				headers: { ...headers, "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" },
				body: request,
				signal: session.signal,
			});
			if (!res.ok || !res.body) return fail(`ERROR: The storage backend answered ${res.status}.`);
			await pipe(res.body, session);
		}
	}

	const advertised = await upstreamFetch(upstream, "info/refs?service=git-receive-pack", {
		method: "GET",
		headers: { "git-protocol": /version=1/.test(protocol) ? "version=1" : null },
		signal: session.signal,
	});
	if (!advertised.ok) return fail("ERROR: The storage backend refused the request.");
	await session.write(stripServiceBanner(new Uint8Array(await advertised.arrayBuffer())));
	const commands = await input.untilFlush();
	// Nothing to update: git hangs up after the advertisement, or sends just a flush.
	if (!commands || commands.length === 4) return 0;
	const lines = pktPayloads(commands);
	const { commands: updates, capabilities } = parseCommands(commands);
	let head = commands;
	if (capabilities.includes("push-options")) {
		const options = await input.untilFlush();
		if (!options) return 1;
		head = concat([commands, options]);
	}
	// Deleting branches sends no pack, and git then waits for the report without closing its side.
	const withPack = lines.some((l) => !l.startsWith("shallow ") && l.split(" ")[1] !== ZERO);
	const maxPush = policy(env).pushBytes;
	// Protected branches, as over HTTPS: refuse what the commands show isn't allowed, and check
	// fast-forward-only branches once the push is stored.
	let staged: Staged[] = [];
	if (branchRules.length > 0) {
		const checked = checkPush(branchRules, updates);
		if (checked.refused.size > 0) {
			// git sends the whole pack before it reads the answer.
			for (let read = 0; withPack && read <= maxPush; ) {
				const chunk = await input.raw();
				if (!chunk) break;
				read += chunk.length;
			}
			await session.write(refusalReport(updates, checked.refused, capabilities));
			return 0;
		}
		if (checked.fastForwardOnly.length > 0) {
			const held = quarantine(commands, checked.fastForwardOnly);
			staged = held.staged;
			head = concat([held.head, head.subarray(commands.length)]);
		}
	}
	let sent = head.length;
	const body = withPack
		? new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(head);
				},
				async pull(controller) {
					const chunk = await input.raw();
					if (!chunk) return controller.close();
					sent += chunk.length;
					if (sent > maxPush) controller.error(new Error("push too large"));
					else controller.enqueue(chunk);
				},
			})
		: head;
	let res: Response;
	try {
		res = await upstreamFetch(upstream, "git-receive-pack", {
			method: "POST",
			headers: { "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result" },
			body,
			signal: session.signal,
		});
	} catch (err) {
		if (sent > maxPush) return fail(`ERROR: A push can be at most ${formatBytes(maxPush)}.`);
		throw err;
	}
	if (!res.ok || !res.body) return fail(`ERROR: The storage backend answered ${res.status}.`);
	let report = res.body;
	if (staged.length > 0) {
		const checked = await settleStaged(env, access.row, upstream, new Uint8Array(await res.arrayBuffer()), staged, capabilities);
		report = new Response(checked).body as ReadableStream<Uint8Array>;
	}
	await pipe(watchPush(env, ctx, access.row, report, () => sent, principal.username, access.wiki), session);
	return 0;
}

async function pipe(body: ReadableStream<Uint8Array>, session: Session<GitUser>) {
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			await session.write(value);
		}
	} finally {
		reader.releaseLock();
	}
}

/** Smart HTTP starts a ref advertisement with `# service=...` and a flush; over SSH there's neither. */
function stripServiceBanner(bytes: Uint8Array): Uint8Array {
	const header = new TextDecoder().decode(bytes.subarray(4, 14));
	if (header !== "# service=") return bytes;
	const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(0, 4)), 16);
	let rest = bytes.subarray(length);
	if (new TextDecoder().decode(rest.subarray(0, 4)) === "0000") rest = rest.subarray(4);
	return rest;
}

/** The text of each data packet in a pkt-line sequence. */
function pktPayloads(bytes: Uint8Array): string[] {
	const out: string[] = [];
	const decoder = new TextDecoder("latin1");
	for (let i = 0; i + 4 <= bytes.length; ) {
		const size = Number.parseInt(decoder.decode(bytes.subarray(i, i + 4)), 16);
		if (size < 4) {
			i += 4;
			continue;
		}
		out.push(decoder.decode(bytes.subarray(i + 4, i + size)).replace(/\n$/, ""));
		i += size;
	}
	return out;
}

/** Reads pkt-lines from a session's input. */
class PktReader {
	/** Unread input is `store[start, end)`; the store grows by doubling, so filling it stays linear. */
	private store = new Uint8Array(64 * 1024);
	private start = 0;
	private end = 0;
	private readonly session: Session<GitUser>;

	constructor(session: Session<GitUser>) {
		this.session = session;
	}

	private get buffer(): Uint8Array {
		return this.store.subarray(this.start, this.end);
	}

	private consume(n: number) {
		this.start += n;
		if (this.start === this.end) this.start = this.end = 0;
	}

	private async fill(n: number): Promise<boolean> {
		while (this.end - this.start < n) {
			const chunk = await this.session.read();
			if (!chunk) return false;
			if (this.end + chunk.length > this.store.length) {
				const live = this.end - this.start;
				const next = live + chunk.length > this.store.length / 2 ? new Uint8Array(Math.max(this.store.length * 2, live + chunk.length)) : this.store;
				next.set(this.store.subarray(this.start, this.end), 0);
				this.store = next;
				this.start = 0;
				this.end = live;
			}
			this.store.set(chunk, this.end);
			this.end += chunk.length;
		}
		return true;
	}

	/** Everything up to and including the next flush packet; null if input ends first. */
	async untilFlush(): Promise<Uint8Array | null> {
		let offset = 0;
		for (;;) {
			if (!(await this.fill(offset + 4))) return null;
			const header = new TextDecoder().decode(this.buffer.subarray(offset, offset + 4));
			if (!/^[0-9a-f]{4}$/.test(header)) throw new Error("Malformed pkt-line from the client");
			const size = Number.parseInt(header, 16);
			if (size === 0) {
				const out = this.buffer.slice(0, offset + 4);
				this.consume(offset + 4);
				return out;
			}
			const end = offset + (size < 4 ? 4 : size);
			if (end > MAX_REQUEST_BYTES) throw new Error("Request too large");
			if (!(await this.fill(end))) return null;
			offset = end;
		}
	}

	/** The next raw bytes (what's buffered first), or null at end of input. */
	async raw(): Promise<Uint8Array | null> {
		if (this.end > this.start) {
			const out = this.buffer.slice();
			this.consume(this.end - this.start);
			return out;
		}
		return this.session.read();
	}
}
