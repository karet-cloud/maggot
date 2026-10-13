// Branch protection: rules that refuse deleting a branch, rewriting its history (force pushes), or
// pushing to it at all (so changes only land through the merge queue). Pushes are checked from the
// commands at the start of a receive-pack request; force pushes, which need the new commits to tell,
// are checked once they're stored, and put back if they rewrote history.
import type { BranchRule } from "./api.ts";
import type { ObjectReader } from "./git/diff.ts";

const ZERO = "0".repeat(40);

/** Whether a branch name matches a rule's pattern: `*` stays within one path segment, `**` crosses them. */
export function patternMatches(pattern: string, branch: string): boolean {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*" && pattern[i + 1] === "*") {
			re += ".*";
			i++;
		} else if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
	}
	return new RegExp(`^${re}$`).test(branch);
}

export function validPattern(pattern: string): boolean {
	return /^[A-Za-z0-9._/*?-]{1,200}$/.test(pattern) && !pattern.includes("..") && !pattern.startsWith("/") && !pattern.endsWith("/");
}

/** What applies to a branch: every rule whose pattern matches it, combined. */
export function protectionFor(rules: BranchRule[], branch: string): Omit<BranchRule, "pattern" | "createdAt"> & { patterns: string[] } {
	const matching = rules.filter((r) => patternMatches(r.pattern, branch));
	return {
		patterns: matching.map((r) => r.pattern),
		blockDeletions: matching.some((r) => r.blockDeletions),
		blockForcePushes: matching.some((r) => r.blockForcePushes),
		requireMergeQueue: matching.some((r) => r.requireMergeQueue),
	};
}

export interface RefCommand {
	old: string;
	new: string;
	ref: string;
}

/** The ref updates and capabilities at the start of a receive-pack request (up to its first flush). */
export function parseCommands(head: Uint8Array): { commands: RefCommand[]; capabilities: string[] } {
	const commands: RefCommand[] = [];
	let capabilities: string[] = [];
	const decoder = new TextDecoder("latin1");
	for (let i = 0; i + 4 <= head.length; ) {
		const size = Number.parseInt(decoder.decode(head.subarray(i, i + 4)), 16);
		if (!(size >= 4)) break;
		const line = decoder.decode(head.subarray(i + 4, i + size)).replace(/\n$/, "");
		i += size;
		if (line.startsWith("shallow ")) continue;
		const [command, caps] = line.split("\0");
		if (caps !== undefined && commands.length === 0) capabilities = caps.split(" ").filter(Boolean);
		const [oldOid, newOid, ref] = command.split(" ");
		if (oldOid && newOid && ref) commands.push({ old: oldOid, new: newOid, ref });
	}
	return { commands, capabilities };
}

/**
 * Checks a push's commands against the rules: the refs refused outright (with why), and the branch
 * updates that may only fast-forward, to check once their commits are stored.
 */
export function checkPush(rules: BranchRule[], commands: RefCommand[]): { refused: Map<string, string>; fastForwardOnly: RefCommand[] } {
	const refused = new Map<string, string>();
	const fastForwardOnly: RefCommand[] = [];
	for (const c of commands) {
		if (!c.ref.startsWith("refs/heads/")) continue;
		const branch = c.ref.slice("refs/heads/".length);
		const p = protectionFor(rules, branch);
		if (p.patterns.length === 0) continue;
		if (p.requireMergeQueue) refused.set(c.ref, `protected branch: changes to ${branch} go through the merge queue`);
		else if (c.new === ZERO && p.blockDeletions) refused.set(c.ref, `protected branch: ${branch} can't be deleted`);
		else if (c.new !== ZERO && c.old !== ZERO && p.blockForcePushes) fastForwardOnly.push(c);
	}
	return { refused, fastForwardOnly };
}

/**
 * Whether `ancestor` is in `descendant`'s history. The first-parent log answers the usual case (a
 * fast-forward) in one request; otherwise the walk follows every parent, not going past commits much
 * older than `ancestor` (they can't lead to it, clocks permitting). Null if it ran out of budget.
 */
export async function isAncestor(
	repo: ObjectReader & { log?(opts: { ref: string; limit: number }): Promise<{ hash: string }[]> },
	ancestor: string,
	descendant: string,
	budget = 2000,
): Promise<boolean | null> {
	if (ancestor === descendant) return true;
	if (repo.log) {
		const line = await repo.log({ ref: descendant, limit: 500 }).catch(() => []);
		if (line.some((c) => c.hash === ancestor)) return true;
	}
	const target = await repo.readCommit(ancestor);
	if (!target) return false;
	// A day of slack for clocks that disagree.
	const oldest = target.committedAt - 86400;
	const seen = new Set<string>([descendant]);
	let frontier = [descendant];
	let reads = 0;
	while (frontier.length > 0) {
		if (reads + frontier.length > budget) return null;
		reads += frontier.length;
		const commits = await Promise.all(frontier.map((hash) => repo.readCommit(hash)));
		const next: string[] = [];
		for (const commit of commits) {
			if (!commit) continue;
			if (commit.parents.includes(ancestor)) return true;
			if (commit.committedAt < oldest) continue;
			for (const parent of commit.parents) {
				if (seen.has(parent)) continue;
				seen.add(parent);
				next.push(parent);
			}
		}
		frontier = next;
	}
	return false;
}

// ── report-status ────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function pkt(payload: Uint8Array | string): Uint8Array {
	const body = typeof payload === "string" ? encoder.encode(payload) : payload;
	const out = new Uint8Array(body.length + 4);
	out.set(encoder.encode((body.length + 4).toString(16).padStart(4, "0")));
	out.set(body, 4);
	return out;
}

function join(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** report-status lines as pkt-lines, inside side-band channel 1 when the client asked for side-band. */
function frame(lines: string[], capabilities: string[], progress: Uint8Array[] = []): Uint8Array {
	const inner = join([...lines.map((l) => pkt(`${l}\n`)), encoder.encode("0000")]);
	const sideband = capabilities.includes("side-band-64k") || capabilities.includes("side-band");
	if (!sideband) return inner;
	const max = capabilities.includes("side-band-64k") ? 65515 : 995;
	const chunks: Uint8Array[] = [...progress];
	for (let i = 0; i < inner.length; i += max) chunks.push(pkt(join([Uint8Array.of(1), inner.subarray(i, i + max)])));
	return join([...chunks, encoder.encode("0000")]);
}

/** A whole push refused: every ref named, each with its reason (or the reason another ref was refused). */
export function refusalReport(commands: RefCommand[], refused: Map<string, string>, capabilities: string[]): Uint8Array {
	const lines = ["unpack ok", ...commands.map((c) => `ng ${c.ref} ${refused.get(c.ref) ?? "another ref in this push was refused"}`)];
	return frame(lines, capabilities);
}

/** Reads a receive-pack response: its report-status lines, and any side-band progress packets as they were. */
export function readReport(response: Uint8Array): { lines: string[]; progress: Uint8Array[]; sideband: boolean } {
	const decoder = new TextDecoder("latin1");
	const outer: { channel: number | null; data: Uint8Array; raw: Uint8Array }[] = [];
	for (let i = 0; i + 4 <= response.length; ) {
		const size = Number.parseInt(decoder.decode(response.subarray(i, i + 4)), 16);
		if (!(size >= 4)) {
			i += 4;
			continue;
		}
		const data = response.subarray(i + 4, i + size);
		outer.push({ channel: data[0] ?? null, data, raw: response.subarray(i, i + size) });
		i += size;
	}
	const sideband = outer.length > 0 && outer.every((p) => p.channel !== null && p.channel >= 1 && p.channel <= 3);
	const progress = sideband ? outer.filter((p) => p.channel === 2).map((p) => p.raw) : [];
	const report = sideband ? join(outer.filter((p) => p.channel === 1).map((p) => p.data.subarray(1))) : response;
	const lines: string[] = [];
	for (let i = 0; i + 4 <= report.length; ) {
		const size = Number.parseInt(decoder.decode(report.subarray(i, i + 4)), 16);
		if (!(size >= 4)) {
			i += 4;
			continue;
		}
		lines.push(new TextDecoder().decode(report.subarray(i + 4, i + size)).replace(/\n$/, ""));
		i += size;
	}
	return { lines, progress, sideband };
}

/** The response with the given refs turned from "ok" to "ng <reason>". */
export function rewriteReport(response: Uint8Array, refused: Map<string, string>, capabilities: string[]): Uint8Array {
	if (refused.size === 0) return response;
	const { lines, progress } = readReport(response);
	const rewritten = lines.map((line) => {
		const ref = line.startsWith("ok ") ? line.slice(3) : null;
		return ref && refused.has(ref) ? `ng ${ref} ${refused.get(ref)}` : line;
	});
	return frame(rewritten, capabilities, progress);
}

/** The refs a report says were updated. */
export function acceptedRefs(response: Uint8Array): Set<string> {
	const { lines } = readReport(response);
	if (lines[0] !== "unpack ok") return new Set();
	return new Set(lines.filter((l) => l.startsWith("ok ")).map((l) => l.slice(3)));
}
