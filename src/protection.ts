// Branch protection: rules that refuse deleting a branch, rewriting its history (force pushes), or
// pushing to it at all (so changes only land through the merge queue). Pushes are checked from the
// commands at the start of a receive-pack request; force pushes, which need the new commits to tell,
// are checked once they're stored, and put back if they rewrote history.
import type { BranchRule } from "./api.ts";
import type { ObjectReader } from "./git/diff.ts";
import { protectionFor } from "./branch-rules.ts";

export { patternMatches, protectionFor, validPattern } from "./branch-rules.ts";

const ZERO = "0".repeat(40);

export interface RefCommand {
	old: string;
	new: string;
	ref: string;
}

/** The ref updates and capabilities at the start of a receive-pack request (up to its first flush). */
export function parseCommands(head: Uint8Array): { commands: RefCommand[]; capabilities: string[] } {
	const commands: RefCommand[] = [];
	let capabilities: string[] = [];
	// UTF-8, as git's reports are read, so a ref named in both is the same string.
	const decoder = new TextDecoder();
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
		if (c.ref.startsWith(INCOMING)) {
			refused.set(c.ref, "megit uses this branch name for pushes being checked");
			continue;
		}
		const branch = c.ref.slice("refs/heads/".length);
		const p = protectionFor(rules, branch);
		if (p.patterns.length === 0) continue;
		if (p.requireMergeQueue) refused.set(c.ref, `protected branch: changes to ${branch} go through pull requests or the merge queue`);
		else if (c.new === ZERO && p.blockDeletions) refused.set(c.ref, `protected branch: ${branch} can't be deleted`);
		else if (c.new !== ZERO && c.old !== ZERO && p.blockForcePushes) fastForwardOnly.push(c);
	}
	return { refused, fastForwardOnly };
}

/**
 * Whether `ancestor` is in `descendant`'s history. The first-parent log answers the usual case (a
 * fast-forward) in one request; otherwise the walk follows every parent. Null if it ran out of budget.
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
	// Dates can't prune the walk (they lie), so it's bounded by the budget alone.
	if (!(await repo.readCommit(ancestor))) return false;
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
	return mapReport(response, capabilities, (line) => {
		const ref = line.startsWith("ok ") ? line.slice(3) : null;
		return ref && refused.has(ref) ? `ng ${ref} ${refused.get(ref)}` : line;
	});
}

/** The response with each report-status line passed through `map`; progress packets are kept. */
export function mapReport(response: Uint8Array, capabilities: string[], map: (line: string) => string): Uint8Array {
	const { lines, progress } = readReport(response);
	if (lines.length === 0) return response;
	return frame(lines.map(map), capabilities, progress);
}

// ── Quarantine ───────────────────────────────────────────────────────────────

/** Where updates to fast-forward-only branches land first, to be checked before the branch moves. */
export const INCOMING = "refs/heads/megit-incoming/";

export interface Staged {
	command: RefCommand;
	/** The ref the push actually updates. */
	temp: string;
}

/**
 * Rewrites a push's commands so updates to fast-forward-only branches create a quarantine ref
 * instead: the pack is stored, but the branch only moves once the new commits are checked. The
 * rest of the push (other refs, capabilities, the pack) is unchanged.
 */
export function quarantine(head: Uint8Array, staged: RefCommand[]): { head: Uint8Array; staged: Staged[] } {
	const id = crypto.randomUUID().slice(0, 8);
	const out: Staged[] = [];
	const parts: Uint8Array[] = [];
	const decoder = new TextDecoder();
	for (let i = 0; i + 4 <= head.length; ) {
		const size = Number.parseInt(decoder.decode(head.subarray(i, i + 4)), 16);
		if (!(size >= 4)) {
			parts.push(head.subarray(i, i + 4));
			i += 4;
			continue;
		}
		const raw = head.subarray(i, i + size);
		i += size;
		const line = decoder.decode(raw.subarray(4)).replace(/\n$/, "");
		const [command, caps] = line.split("\0");
		const [oldOid, newOid, ref] = command.split(" ");
		const match = staged.find((c) => c.ref === ref && c.old === oldOid && c.new === newOid);
		if (!match) {
			parts.push(raw);
			continue;
		}
		const temp = `${INCOMING}${id}/${ref.slice("refs/heads/".length)}`;
		out.push({ command: match, temp });
		parts.push(pkt(`${ZERO} ${newOid} ${temp}${caps === undefined ? "" : `\0${caps}`}\n`));
	}
	return { head: join(parts), staged: out };
}

/** The refs a report says were updated. */
export function acceptedRefs(response: Uint8Array): Set<string> {
	const { lines } = readReport(response);
	if (lines[0] !== "unpack ok") return new Set();
	return new Set(lines.filter((l) => l.startsWith("ok ")).map((l) => l.slice(3)));
}
