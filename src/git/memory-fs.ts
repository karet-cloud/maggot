// Minimal in-memory filesystem for isomorphic-git. Errors carry Node-style codes because
// isomorphic-git branches on `err.code` (for example ENOENT in FileSystem.exists).

type Entry =
	| { kind: "dir"; children: Set<string>; mtimeMs: number }
	| { kind: "file"; data: Uint8Array; mtimeMs: number }
	| { kind: "symlink"; target: string; mtimeMs: number };

function fsError(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

class Stats {
	private readonly entry: Entry;
	constructor(entry: Entry) {
		this.entry = entry;
	}
	get size() {
		return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
	}
	get mtimeMs() {
		return this.entry.mtimeMs;
	}
	get ctimeMs() {
		return this.entry.mtimeMs;
	}
	get mode() {
		return this.entry.kind === "dir" ? 0o040000 : this.entry.kind === "symlink" ? 0o120000 : 0o100644;
	}
	get dev() {
		return 0;
	}
	get ino() {
		return 0;
	}
	get uid() {
		return 0;
	}
	get gid() {
		return 0;
	}
	isFile() {
		return this.entry.kind === "file";
	}
	isDirectory() {
		return this.entry.kind === "dir";
	}
	isSymbolicLink() {
		return this.entry.kind === "symlink";
	}
}

export class MemoryFS {
	private readonly entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

	readonly promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
	};

	private normalize(input: string): string {
		const segments: string[] = [];
		for (const part of input.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") segments.pop();
			else segments.push(part);
		}
		return `/${segments.join("/")}`;
	}

	private split(path: string): [parent: string, base: string] {
		const normalized = this.normalize(path);
		const i = normalized.lastIndexOf("/");
		return [i <= 0 ? "/" : normalized.slice(0, i), normalized.slice(i + 1)];
	}

	private entry(path: string): Entry {
		const entry = this.entries.get(this.normalize(path));
		if (!entry) throw fsError("ENOENT", path);
		return entry;
	}

	private dir(path: string) {
		const entry = this.entry(path);
		if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
		return entry;
	}

	private put(path: string, entry: Entry) {
		const [parent, base] = this.split(path);
		this.dir(parent).children.add(base);
		this.entries.set(this.normalize(path), entry);
	}

	private remove(path: string) {
		const [parent, base] = this.split(path);
		this.entries.delete(this.normalize(path));
		this.dir(parent).children.delete(base);
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number) {
		const target = this.normalize(path);
		if (this.entries.has(target)) {
			if (typeof options === "object" && options?.recursive) return;
			throw fsError("EEXIST", path);
		}
		const [parent] = this.split(target);
		if (!this.entries.has(parent)) {
			if (!(typeof options === "object" && options?.recursive)) throw fsError("ENOENT", parent);
			await this.mkdir(parent, { recursive: true });
		}
		this.put(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
	}

	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, _options?: unknown) {
		const [parent] = this.split(path);
		await this.mkdir(parent, { recursive: true });
		const bytes =
			typeof data === "string"
				? new TextEncoder().encode(data)
				: data instanceof Uint8Array
					? data
					: new Uint8Array(data);
		this.put(path, { kind: "file", data: bytes, mtimeMs: Date.now() });
	}

	async readFile(path: string, options?: string | { encoding?: string }) {
		const entry = this.entry(path);
		if (entry.kind !== "file") throw fsError("EISDIR", path);
		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? new TextDecoder().decode(entry.data) : entry.data;
	}

	async readdir(path: string) {
		return [...this.dir(path).children].sort();
	}

	async unlink(path: string) {
		if (this.entry(path).kind === "dir") throw fsError("EISDIR", path);
		this.remove(path);
	}

	async rmdir(path: string) {
		if (this.dir(path).children.size > 0) throw fsError("ENOTEMPTY", path);
		this.remove(path);
	}

	async stat(path: string) {
		return new Stats(this.entry(path));
	}

	async lstat(path: string) {
		return this.stat(path);
	}

	async readlink(path: string) {
		const entry = this.entry(path);
		if (entry.kind !== "symlink") throw fsError("EINVAL", path);
		return entry.target;
	}

	async symlink(target: string, path: string) {
		this.put(path, { kind: "symlink", target, mtimeMs: Date.now() });
	}
}
