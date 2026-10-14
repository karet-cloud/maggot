// Storage can't move a repository's HEAD, so when its default branch is changed, the ref
// advertisements git reads on the way to a clone are rewritten to point HEAD at the new one: the
// protocol v0 advertisement (`info/refs`) and protocol v2's `ls-refs` answer.

type Packet = { data: string } | { special: string };

function packets(bytes: Uint8Array): Packet[] | null {
	const decoder = new TextDecoder();
	const out: Packet[] = [];
	for (let i = 0; i < bytes.length; ) {
		if (i + 4 > bytes.length) return null;
		const header = decoder.decode(bytes.subarray(i, i + 4));
		if (!/^[0-9a-f]{4}$/.test(header)) return null;
		const size = Number.parseInt(header, 16);
		if (size < 4) {
			out.push({ special: header });
			i += 4;
			continue;
		}
		if (i + size > bytes.length) return null;
		out.push({ data: decoder.decode(bytes.subarray(i + 4, i + size)) });
		i += size;
	}
	return out;
}

function encode(list: Packet[]): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(
		list
			.map((p) => {
				if ("special" in p) return p.special;
				return `${(encoder.encode(p.data).length + 4).toString(16).padStart(4, "0")}${p.data}`;
			})
			.join(""),
	);
}

const REF = /^([0-9a-f]{40}|[0-9a-f]{64}) ([^\0\s]+)/;

/** A protocol v0 ref advertisement (with or without the HTTP `# service=` banner) with HEAD at `branch`. */
export function pointHeadV0(bytes: Uint8Array, branch: string): Uint8Array {
	const list = packets(bytes);
	if (!list) return bytes;
	const refs = list.flatMap((p, i) => ("data" in p && REF.test(p.data) ? [i] : []));
	if (refs.length === 0) return bytes;
	const parse = (i: number) => {
		const data = (list[i] as { data: string }).data.replace(/\n$/, "");
		const [ref, caps] = data.split("\0");
		const [, oid, name] = REF.exec(ref) as RegExpExecArray;
		return { oid, name, caps };
	};
	const target = refs.map(parse).find((r) => r.name === `refs/heads/${branch}`);
	if (!target) return bytes;
	const first = refs[0];
	const caps = (parse(first).caps ?? "")
		.split(" ")
		.filter((c) => c && !c.startsWith("symref=HEAD:"))
		.concat(`symref=HEAD:refs/heads/${branch}`)
		.join(" ");
	const out: Packet[] = [];
	for (const [i, p] of list.entries()) {
		if (i === first) out.push({ data: `${target.oid} HEAD\0${caps}\n` });
		if (!refs.includes(i)) {
			out.push(p);
			continue;
		}
		const { oid, name } = parse(i);
		if (name !== "HEAD") out.push({ data: `${oid} ${name}\n` });
	}
	return encode(out);
}

/** Whether a protocol v2 request is an `ls-refs` command, whose answer names HEAD. */
export function isLsRefs(request: Uint8Array): boolean {
	return new TextDecoder().decode(request.subarray(4, 4 + "command=ls-refs".length)) === "command=ls-refs";
}

/**
 * A protocol v2 `ls-refs` answer with HEAD at `branch`, when the answer also lists that branch. HEAD
 * is added if storage left it out (its own HEAD names a branch that doesn't exist) and `request` asked for it.
 */
export function pointHeadV2(bytes: Uint8Array, branch: string, request: Uint8Array): Uint8Array {
	const list = packets(bytes);
	const args = packets(request)?.flatMap((p) => ("data" in p ? [p.data.replace(/\n$/, "")] : [])) ?? [];
	if (!list) return bytes;
	const lines = list.map((p) => ("data" in p ? p.data.replace(/\n$/, "") : null));
	const target = lines.find((l) => l !== null && l.split(" ")[1] === `refs/heads/${branch}`)?.split(" ")[0];
	if (!target) return bytes;
	const symref = args.includes("symrefs") ? ` symref-target:refs/heads/${branch}` : "";
	const line = { data: `${target} HEAD${symref}\n` };
	const head = lines.findIndex((l) => l !== null && l.split(" ")[1] === "HEAD");
	const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
	if (head !== -1) list[head] = line;
	else if (prefixes.length === 0 || prefixes.some((prefix) => "HEAD".startsWith(prefix))) list.unshift(line);
	return encode(list);
}
