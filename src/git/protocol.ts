// The two smart-HTTP exchanges the Artifacts binding has no method for: listing refs and deleting one.
import type { RemoteAccess } from "./workspace.ts";

const ZERO = "0".repeat(40);

function headers(remote: RemoteAccess, extra: Record<string, string> = {}) {
	// No token: a public repository elsewhere (an action on GitHub), asked anonymously.
	if (!remote.token) return { "user-agent": "git/maggot", ...extra };
	const secret = remote.token.split("?expires=")[0];
	return { authorization: `Basic ${btoa(`x:${secret}`)}`, "user-agent": "git/maggot", ...extra };
}

/** Branch name to head oid, as `git ls-remote --heads` reports them. */
export async function listBranches(remote: RemoteAccess): Promise<Map<string, string>> {
	return (await listRefs(remote)).branches;
}

export interface TagRef {
	/** What the tag ref points at: a commit, or an annotated tag object. */
	oid: string;
	/** The commit it names (the same as `oid` for a lightweight tag). */
	commit: string;
	annotated: boolean;
}

/** Branches holding pushes to protected branches while they're checked (see src/protection.ts); never listed. */
const INCOMING_BRANCHES = "maggot-incoming/";

/**
 * Branches and tags, from one ref advertisement. Annotated tags are peeled to their commits.
 * `incoming` includes the holding branches of pushes being checked.
 */
export async function listRefs(remote: RemoteAccess, incoming = false): Promise<{ branches: Map<string, string>; tags: Map<string, TagRef> }> {
	const res = await fetch(`${remote.url}/info/refs?service=git-upload-pack`, { headers: headers(remote) });
	if (!res.ok) throw new Error(`Listing refs failed: HTTP ${res.status}`);
	const branches = new Map<string, string>();
	const tags = new Map<string, TagRef>();
	for (const line of pktLines(new Uint8Array(await res.arrayBuffer()))) {
		const [oid, ref] = line.split("\0")[0].trimEnd().split(" ");
		if (!ref) continue;
		if (ref.startsWith("refs/heads/")) {
			const name = ref.slice("refs/heads/".length);
			if (incoming || !name.startsWith(INCOMING_BRANCHES)) branches.set(name, oid);
		}
		else if (ref.startsWith("refs/tags/")) {
			const peeled = ref.endsWith("^{}");
			const name = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
			const known = tags.get(name);
			if (peeled) tags.set(name, { oid: known?.oid ?? oid, commit: oid, annotated: true });
			else tags.set(name, { oid, commit: known?.annotated ? known.commit : oid, annotated: known?.annotated ?? false });
		}
	}
	return { branches, tags };
}

/**
 * The branch a public remote's HEAD points at, from the symref its smart HTTP advertisement carries
 * (`symref=HEAD:refs/heads/master`), or undefined when it can't be told.
 */
export async function remoteHead(url: string): Promise<string | undefined> {
	return (await probeRemote(url))?.head;
}

/** The most of an advertisement read to find its first ref line, which carries HEAD's symref. */
export const PROBE_LIMIT = 64 * 1024;

/**
 * Whether `url` serves Git's smart HTTP protocol to anyone (null if not), and the branch its HEAD names.
 * The remote is untrusted: at most PROBE_LIMIT bytes are buffered and inspected before cancelling
 * the stream (a delivered chunk may be larger). A malformed prefix is treated as no Git repository.
 */
export async function probeRemote(url: string): Promise<{ head?: string } | null> {
	try {
		const res = await fetch(`${url.replace(/\/+$/, "")}/info/refs?service=git-upload-pack`, {
			headers: { "user-agent": "git/2.45.0" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok || !res.body || !res.headers.get("content-type")?.startsWith("application/x-git-upload-pack-advertisement")) {
			void res.body?.cancel().catch(() => {});
			return null;
		}
		// HEAD's line comes first; a repository with many tags advertises megabytes after it.
		const reader = res.body.getReader();
		const scanner = new AdvertisementScanner();
		let first: string | null | undefined;
		try {
			while (first === undefined) {
				const { done, value } = await reader.read();
				first = done ? scanner.end() : scanner.push(value);
			}
		} finally {
			void reader.cancel().catch(() => {});
		}
		if (first === null) return null;
		const capabilities = first.split("\0")[1] ?? "";
		return { head: /(?:^| )symref=HEAD:refs\/heads\/(\S+)/.exec(capabilities)?.[1] };
	} catch {
		return null;
	}
}

const SERVICE_LINE = "# service=git-upload-pack";
const MAX_PKT = 65520;

/**
 * Reads a v0 smart HTTP advertisement (`# service=…`, a flush, then ref lines) a chunk at a time, up to
 * its first ref line. Each byte is copied and parsed once. `push` and `end` answer the first ref line, or
 * null for anything malformed or too long, or undefined while more is needed; an empty `""` stands for
 * an advertisement that ended without refs.
 */
class AdvertisementScanner {
	private readonly buffer = new Uint8Array(PROBE_LIMIT);
	private length = 0;
	/** Where the next packet starts. */
	private at = 0;
	private state: "start" | "flush" | "refs" | "end" = "start";
	private readonly decoder = new TextDecoder();

	push(chunk: Uint8Array): string | null | undefined {
		if (this.length + chunk.length > PROBE_LIMIT) {
			// Whatever fits may still hold the line; past it there's nothing more to wait for.
			const fits = chunk.subarray(0, PROBE_LIMIT - this.length);
			this.buffer.set(fits, this.length);
			this.length += fits.length;
			return this.scan() ?? null;
		}
		this.buffer.set(chunk, this.length);
		this.length += chunk.length;
		const found = this.scan();
		return found === undefined && this.length === PROBE_LIMIT ? null : found;
	}

	/** An empty advertisement still needs its terminating flush packet. */
	end(): string | null {
		const found = this.scan();
		if (found !== undefined) return found;
		return this.at === this.length && this.state === "end" ? "" : null;
	}

	private scan(): string | null | undefined {
		if (this.state === "end" && this.at !== this.length) return null;
		while (this.length - this.at >= 4) {
			const hex = this.decoder.decode(this.buffer.subarray(this.at, this.at + 4));
			if (!/^[0-9a-f]{4}$/.test(hex)) return null;
			const size = Number.parseInt(hex, 16);
			if (size === 0) {
				if (this.state === "flush") this.state = "refs";
				else if (this.state === "refs") this.state = "end";
				else return null;
				this.at += 4;
				if (this.state === "end") return this.at === this.length ? undefined : null;
				continue;
			}
			// Delimiter and response-end packets are protocol v2's; 3 and 4 hold no data.
			if (size <= 4 || size > MAX_PKT) return null;
			if (this.at + size > this.length) return undefined;
			const line = this.decoder.decode(this.buffer.subarray(this.at + 4, this.at + size));
			this.at += size;
			if (this.state === "flush") return null;
			if (this.state === "start" && line.replace(/\n$/, "") === SERVICE_LINE) {
				this.state = "flush";
				continue;
			}
			// Some servers leave the header out; either way this is the first ref: `<oid> <ref>[\0caps]`.
			return /^(?:[0-9a-f]{40}|[0-9a-f]{64}) [^\0\s]+(?:\0|\n|$)/.test(line) ? line : null;
		}
		return undefined;
	}
}

/**
 * How big a repository is, measured as the pack a full clone downloads: every branch and tag. Stops
 * reading once it passes `limit`, and returns `limit + 1` then.
 */
export async function measureRepository(remote: RemoteAccess, limit: number): Promise<number> {
	const res = await fetch(`${remote.url}/info/refs?service=git-upload-pack`, { headers: headers(remote) });
	if (!res.ok) throw new Error(`Listing refs failed: HTTP ${res.status}`);
	const wants = new Set<string>();
	for (const line of pktLines(new Uint8Array(await res.arrayBuffer()))) {
		const [oid, ref] = line.split("\0")[0].trimEnd().split(" ");
		if (/^[0-9a-f]{40}$/.test(oid) && oid !== ZERO && (ref?.startsWith("refs/heads/") || ref?.startsWith("refs/tags/"))) wants.add(oid);
	}
	if (wants.size === 0) return 0;
	const body = `${[...wants].map((oid) => pkt(`want ${oid}\n`)).join("")}0000${pkt("done\n")}`;
	const pack = await fetch(`${remote.url}/git-upload-pack`, {
		method: "POST",
		headers: headers(remote, { "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" }),
		body,
	});
	if (!pack.ok || !pack.body) throw new Error(`Measuring the repository failed: HTTP ${pack.status}`);
	let size = 0;
	const reader = pack.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return size;
			size += value.byteLength;
			if (size > limit) return limit + 1;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** Deletes `refs/heads/<branch>` if it still points at `oid`. */
export async function deleteBranch(remote: RemoteAccess, branch: string, oid: string): Promise<void> {
	await receivePack(remote, `refs/heads/${branch}`, oid, ZERO, new Uint8Array(), `Deleting ${branch}`);
}

/** A pack with no objects: what receive-pack needs to point a ref at an object it already has. */
const EMPTY_PACK = Uint8Array.from([
	0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0,
	// SHA-1 of the 12 bytes above.
	0x02, 0x9d, 0x08, 0x82, 0x3b, 0xd8, 0xa8, 0xea, 0xb5, 0x10, 0xad, 0x6a, 0xc7, 0x5c, 0x82, 0x3c, 0xfd, 0x3e, 0xd3, 0x1e,
]);

/**
 * Moves any ref from `from` to `to` (null creates or deletes it) when every object is already in the
 * repository: creating a tag, or putting a branch back. Refused if the ref has moved since.
 */
export async function setRef(remote: RemoteAccess, ref: string, from: string | null, to: string | null): Promise<void> {
	await receivePack(remote, ref, from ?? ZERO, to ?? ZERO, to ? EMPTY_PACK : new Uint8Array(), `Updating ${ref}`);
}

/**
 * Pushes `pack` and moves `ref` from `from` (null: create it) to `to`, atomically: the push is
 * refused if the ref has moved since.
 */
export async function pushPack(remote: RemoteAccess, ref: string, from: string | null, to: string, pack: Uint8Array): Promise<void> {
	await receivePack(remote, ref, from ?? ZERO, to, pack, `Updating ${ref.replace(/^refs\/heads\//, "")}`);
}

export class RefUpdateRejected extends Error {}

async function receivePack(remote: RemoteAccess, ref: string, from: string, to: string, pack: Uint8Array, what: string): Promise<void> {
	const capabilities = to === ZERO ? "report-status delete-refs agent=maggot" : "report-status agent=maggot";
	const commands = new TextEncoder().encode(`${pkt(`${from} ${to} ${ref}\0${capabilities}\n`)}0000`);
	const body = new Uint8Array(commands.length + pack.length);
	body.set(commands);
	body.set(pack, commands.length);
	const res = await fetch(`${remote.url}/git-receive-pack`, {
		method: "POST",
		headers: headers(remote, {
			"content-type": "application/x-git-receive-pack-request",
			accept: "application/x-git-receive-pack-result",
		}),
		body,
	});
	if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
	// report-status must say the pack unpacked and this exact ref updated; anything else is a failure.
	const report = pktLines(new Uint8Array(await res.arrayBuffer())).map((l) => l.trimEnd());
	if (report[0] !== "unpack ok" || !report.includes(`ok ${ref}`)) {
		const reason =
			report.find((l) => l.startsWith("ng ")) ?? report.find((l) => l.startsWith("unpack ") && l !== "unpack ok") ?? "no report-status in the response";
		throw reason.startsWith("ng ") ? new RefUpdateRejected(`${what} failed: ${reason}`) : new Error(`${what} failed: ${reason}`);
	}
}

/**
 * Whether a receive-pack response reports an accepted push: the pack unpacked and at least one ref
 * updated. Handles report-status sent plainly or inside side-band channel 1.
 */
export function pushAccepted(response: Uint8Array): boolean {
	let lines: string[];
	try {
		lines = pktLines(response, true);
		if (lines.some((l) => /^[\x01-\x03]/.test(l))) {
			// Side-band: channel 1 carries the report as pkt-lines of its own.
			const data = lines.filter((l) => l.startsWith("\x01")).map((l) => l.slice(1)).join("");
			lines = pktLines(new TextEncoder().encode(data));
		}
	} catch {
		return false;
	}
	const report = lines.map((l) => l.trimEnd());
	return report[0] === "unpack ok" && report.some((l) => l.startsWith("ok "));
}

function pkt(line: string): string {
	return (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line;
}

/** Data lines of a pkt-line stream, skipping flush packets and the `# service=` banner. */
function pktLines(bytes: Uint8Array, binary = false): string[] {
	// Side-band payloads aren't UTF-8 text; latin1 keeps every byte as one character.
	const decoder = new TextDecoder(binary ? "latin1" : "utf-8");
	const lines: string[] = [];
	for (let i = 0; i + 4 <= bytes.length; ) {
		const header = decoder.decode(bytes.subarray(i, i + 4));
		if (!/^[0-9a-f]{4}$/.test(header)) throw new Error("Malformed pkt-line response");
		const size = Number.parseInt(header, 16);
		if (size >= 4 && i + size > bytes.length) throw new Error("Truncated pkt-line response");
		if (size < 4) {
			i += 4;
			continue;
		}
		const line = decoder.decode(bytes.subarray(i + 4, i + size));
		if (!line.startsWith("# service=")) lines.push(line);
		i += size;
	}
	return lines;
}
