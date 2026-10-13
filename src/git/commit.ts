// Commits made in the browser: builds the new blob, the trees above it and the commit, packs them, and
// pushes the pack with one receive-pack request. Nothing is cloned; only the trees on the edited
// path are read.
import type { ObjectReader, TreeEntry } from "./diff.ts";
import { pushPack } from "./protocol.ts";
import type { RemoteAccess } from "./workspace.ts";

export interface Identity {
	name: string;
	email: string;
}

/** A file to write (`content`) or delete (`content: null`), by path from the repository root. */
export interface FileChange {
	path: string;
	content: Uint8Array | null;
}

export interface CommitRequest {
	branch: string;
	/** The commit the change is based on; the push fails if `branch` has moved on since. */
	parent: { hash: string; treeHash: string } | null;
	/** Create `branch` instead of updating it. */
	create: boolean;
	changes: FileChange[];
	message: string;
	author: Identity;
	/** Unix seconds. */
	time: number;
}

type ObjectType = "commit" | "tree" | "blob";
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3 };

interface GitObject {
	type: ObjectType;
	body: Uint8Array;
	hash: string;
}

const encoder = new TextEncoder();

/** Builds the commit and pushes it. Returns the new commit's hash and the pack's size in bytes. */
export async function commitChanges(repo: ObjectReader, remote: RemoteAccess, req: CommitRequest): Promise<{ commit: string; packBytes: number }> {
	const objects: GitObject[] = [];
	const add = async (type: ObjectType, body: Uint8Array) => {
		const object = { type, body, hash: await objectHash(type, body) };
		objects.push(object);
		return object.hash;
	};

	const root = await writeTree(repo, req.parent?.treeHash ?? null, "", req.changes, add);
	const tree = root ?? (await add("tree", new Uint8Array()));
	const who = `${req.author.name.replace(/[<>\n]/g, "")} <${req.author.email.replace(/[<>\n]/g, "")}> ${req.time} +0000`;
	const commit = await add(
		"commit",
		encoder.encode(`tree ${tree}\n${req.parent ? `parent ${req.parent.hash}\n` : ""}author ${who}\ncommitter ${who}\n\n${req.message.trim()}\n`),
	);
	const pack = await packObjects(objects);
	await pushPack(remote, `refs/heads/${req.branch}`, req.create || !req.parent ? null : req.parent.hash, commit, pack);
	return { commit, packBytes: pack.length };
}

/**
 * Applies the changes under `prefix` to the tree `hash` (null for none) and returns the new tree's
 * hash, or null if it ends up empty. Unchanged subtrees keep their hashes and aren't read.
 */
async function writeTree(
	repo: ObjectReader,
	hash: string | null,
	prefix: string,
	changes: FileChange[],
	add: (type: ObjectType, body: Uint8Array) => Promise<string>,
): Promise<string | null> {
	const entries = new Map<string, TreeEntry>();
	if (hash) {
		const tree = await repo.readTree(hash);
		if (!tree) throw new Error(`Tree ${hash} is missing`);
		for (const e of tree) entries.set(e.name, e);
	}
	const direct = new Map<string, FileChange>();
	const nested = new Map<string, FileChange[]>();
	for (const change of changes) {
		const rest = change.path.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash === -1) direct.set(rest, change);
		else nested.set(rest.slice(0, slash), [...(nested.get(rest.slice(0, slash)) ?? []), change]);
	}
	for (const [name, change] of direct) {
		const existing = entries.get(name);
		if (existing?.type === "tree") throw new PathError(`${prefix}${name} is a directory`);
		if (change.content === null) {
			if (!existing) throw new PathError(`${prefix}${name} doesn't exist`);
			entries.delete(name);
			continue;
		}
		const blob = await add("blob", change.content);
		// Edits keep the file's mode (an executable stays executable); new files are plain files.
		const mode = existing?.type === "exec" ? "100755" : "100644";
		entries.set(name, { name, mode, type: mode === "100755" ? "exec" : "blob", hash: blob });
	}
	for (const [name, sub] of nested) {
		const existing = entries.get(name);
		if (existing && existing.type !== "tree") throw new PathError(`${prefix}${name} is a file, not a directory`);
		const child = await writeTree(repo, existing?.hash ?? null, `${prefix}${name}/`, sub, add);
		if (child) entries.set(name, { name, mode: "40000", type: "tree", hash: child });
		else entries.delete(name);
	}
	if (entries.size === 0) return null;
	return add("tree", serializeTree([...entries.values()]));
}

export class PathError extends Error {}

/** Git's tree format: entries sorted by name, directories compared as if their names ended in "/". */
function serializeTree(entries: TreeEntry[]): Uint8Array {
	const key = (e: TreeEntry) => (e.type === "tree" ? `${e.name}/` : e.name);
	const sorted = entries.sort((a, b) => compareBytes(encoder.encode(key(a)), encoder.encode(key(b))));
	const parts: Uint8Array[] = [];
	for (const e of sorted) {
		parts.push(encoder.encode(`${modeOf(e)} ${e.name}\0`), hexToBytes(e.hash));
	}
	return concat(parts);
}

function modeOf(e: TreeEntry): string {
	switch (e.type) {
		case "tree":
			return "40000";
		case "exec":
			return "100755";
		case "symlink":
			return "120000";
		case "gitlink":
			return "160000";
		default:
			return "100644";
	}
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

async function objectHash(type: ObjectType, body: Uint8Array): Promise<string> {
	return toHex(await sha1(concat([encoder.encode(`${type} ${body.length}\0`), body])));
}

/** A version 2 pack of whole (undeltified) objects, zlib-compressed, with its SHA-1 trailer. */
async function packObjects(objects: GitObject[]): Promise<Uint8Array> {
	const header = new Uint8Array(12);
	header.set(encoder.encode("PACK"));
	new DataView(header.buffer).setUint32(4, 2);
	new DataView(header.buffer).setUint32(8, objects.length);
	const parts: Uint8Array[] = [header];
	for (const o of objects) parts.push(objectHeader(TYPE_CODE[o.type], o.body.length), await zlib(o.body));
	const body = concat(parts);
	return concat([body, await sha1(body)]);
}

/** Type and size: 3 bits of type and 4 of size in the first byte, then 7 bits of size per byte. */
function objectHeader(type: number, size: number): Uint8Array {
	const bytes = [((type & 7) << 4) | (size & 15)];
	let rest = Math.floor(size / 16);
	while (rest > 0) {
		bytes[bytes.length - 1] |= 0x80;
		bytes.push(rest & 0x7f);
		rest = Math.floor(rest / 128);
	}
	return Uint8Array.from(bytes);
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
