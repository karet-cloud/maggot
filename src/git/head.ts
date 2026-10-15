// Storage can't move a repository's HEAD, so when its default branch is changed, the ref
// advertisements git reads on the way to a clone are rewritten to point HEAD at the new one: the
// protocol v0 advertisement (`info/refs`) and protocol v2's `ls-refs` answer. Only HEAD's line (and,
// in v0, the line that carried the capabilities) is re-encoded; every other packet is copied as is.

/** A pkt-line: its bytes, and its payload as text (null for flush, delim and response-end packets). */
type Packet = { raw: Uint8Array; text: string | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function packets(bytes: Uint8Array): Packet[] | null {
	const out: Packet[] = [];
	for (let i = 0; i < bytes.length; ) {
		if (i + 4 > bytes.length) return null;
		const header = decoder.decode(bytes.subarray(i, i + 4));
		if (!/^[0-9a-f]{4}$/.test(header)) return null;
		const size = Number.parseInt(header, 16);
		if (size < 4) {
			out.push({ raw: bytes.subarray(i, i + 4), text: null });
			i += 4;
			continue;
		}
		if (i + size > bytes.length) return null;
		out.push({ raw: bytes.subarray(i, i + size), text: decoder.decode(bytes.subarray(i + 4, i + size)) });
		i += size;
	}
	return out;
}

const line = (text: string): Packet => {
	const payload = encoder.encode(text);
	const raw = new Uint8Array(payload.length + 4);
	raw.set(encoder.encode((payload.length + 4).toString(16).padStart(4, "0")));
	raw.set(payload, 4);
	return { raw, text };
};

function encode(list: Packet[]): Uint8Array {
	const out = new Uint8Array(list.reduce((n, p) => n + p.raw.length, 0));
	let at = 0;
	for (const p of list) {
		out.set(p.raw, at);
		at += p.raw.length;
	}
	return out;
}

const REF = /^([0-9a-f]{40}|[0-9a-f]{64}) ([^\0\s]+)/;

/**
 * A protocol v0 ref advertisement (with or without the HTTP `# service=` banner) with HEAD at
 * `branch`. `fallbackOid` is the branch's head if the advertisement somehow doesn't list it.
 */
export function pointHeadV0(bytes: Uint8Array, branch: string, fallbackOid?: string): Uint8Array {
	const list = packets(bytes);
	if (!list) return bytes;
	const refs = new Map<number, { oid: string; name: string; caps?: string }>();
	for (const [i, p] of list.entries()) {
		const match = p.text === null ? null : REF.exec(p.text);
		if (match) refs.set(i, { oid: match[1], name: match[2], caps: p.text?.replace(/\n$/, "").split("\0")[1] });
	}
	if (refs.size === 0) return bytes;
	const oid = [...refs.values()].find((r) => r.name === `refs/heads/${branch}`)?.oid ?? fallbackOid;
	if (!oid) return bytes;
	const [first] = refs.keys();
	const caps = (refs.get(first)?.caps ?? "")
		.split(" ")
		.filter((c) => c && !c.startsWith("symref=HEAD:"))
		.concat(`symref=HEAD:refs/heads/${branch}`)
		.join(" ");
	const out: Packet[] = [];
	for (const [i, p] of list.entries()) {
		if (i === first) out.push(line(`${oid} HEAD\0${caps}\n`));
		const ref = refs.get(i);
		if (!ref) out.push(p);
		else if (ref.name === "HEAD") continue;
		else out.push(i === first ? line(`${ref.oid} ${ref.name}\n`) : p);
	}
	return encode(out);
}

/** Whether a protocol v2 request is an `ls-refs` command, whose answer names HEAD. */
export function isLsRefs(request: Uint8Array): boolean {
	return decoder.decode(request.subarray(4, 4 + "command=ls-refs".length)) === "command=ls-refs";
}

/**
 * A protocol v2 `ls-refs` answer with HEAD at `branch`. HEAD is added if storage left it out (its own
 * HEAD names a branch that doesn't exist) and `request` asked for it. The branch's head comes from the
 * answer, or `fallbackOid` when the request didn't ask for branches (`git ls-remote origin HEAD`).
 */
export function pointHeadV2(bytes: Uint8Array, branch: string, request: Uint8Array, fallbackOid?: string): Uint8Array {
	const list = packets(bytes);
	const args = packets(request)?.flatMap((p) => (p.text === null ? [] : [p.text.replace(/\n$/, "")])) ?? [];
	if (!list) return bytes;
	const names = list.map((p) => (p.text === null ? null : p.text.replace(/\n$/, "").split(" ")));
	const oid = names.find((n) => n?.[1] === `refs/heads/${branch}`)?.[0] ?? fallbackOid;
	if (!oid) return bytes;
	const symref = args.includes("symrefs") ? ` symref-target:refs/heads/${branch}` : "";
	const head = names.findIndex((n) => n?.[1] === "HEAD");
	const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
	if (head !== -1) list[head] = line(`${oid} HEAD${symref}\n`);
	else if (prefixes.length === 0 || prefixes.some((prefix) => "HEAD".startsWith(prefix))) list.unshift(line(`${oid} HEAD${symref}\n`));
	else return bytes;
	return encode(list);
}
