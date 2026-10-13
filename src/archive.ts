// Streams a tree as a .tar.gz or .zip, reading blobs a few at a time so memory stays bounded.
import { mapLimit, type ObjectReader, type TreeEntry } from "./git/diff.ts";

export type ArchiveFormat = "tar.gz" | "zip";

const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
/**
 * A Worker isolate has 128 MB. Reading ahead keeps the stream busy, but at most PREFETCH files of up
 * to MAX_FILE_BYTES each are held at once (plus one compressed copy for zip), so this stays well under.
 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const PREFETCH = 3;

interface ArchiveEntry {
	path: string;
	hash: string;
	type: "blob" | "exec" | "symlink";
}

/** Lists every file under a root tree; submodules are skipped, as `git archive` does. */
export async function listFiles(repo: ObjectReader, tree: string, prefix = "", out: ArchiveEntry[] = []): Promise<ArchiveEntry[]> {
	const entries = (await repo.readTree(tree)) ?? [];
	const dirs: TreeEntry[] = [];
	for (const e of entries) {
		if (e.type === "tree") dirs.push(e);
		else if (e.type !== "gitlink") out.push({ path: prefix + e.name, hash: e.hash, type: e.type });
		if (out.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files; clone the repository instead`);
	}
	await mapLimit(dirs, 4, (d) => listFiles(repo, d.hash, `${prefix}${d.name}/`, out));
	return out;
}

export function archiveStream(
	repo: ObjectReader,
	files: ArchiveEntry[],
	opts: { format: ArchiveFormat; root: string; mtime: number; onDone?: () => void },
): ReadableStream<Uint8Array> {
	files.sort((a, b) => a.path.localeCompare(b.path));
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		reads.clear();
		opts.onDone?.();
	};
	const reads = new Map<number, Promise<Uint8Array>>();
	const read = (i: number) => {
		if (i < files.length && !reads.has(i) && !finished) {
			const pending = repo.readBlob(files[i].hash).then(async (b) => {
				if (!b) throw new Error(`Blob ${files[i].hash} is missing`);
				if (b.size > MAX_FILE_BYTES) throw new Error(`${files[i].path} is over ${MAX_FILE_BYTES >> 20} MB; clone the repository instead`);
				return new Uint8Array(await b.arrayBuffer());
			});
			// Observed now so a read-ahead failure is never unhandled; the pull that needs it rethrows it.
			pending.catch(() => {});
			reads.set(i, pending);
		}
		return reads.get(i);
	};
	const zip = new ZipWriter();
	let next = 0;
	let total = 0;
	const raw = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (next === files.length) {
					controller.enqueue(opts.format === "zip" ? zip.finish() : new Uint8Array(1024));
					controller.close();
					finish();
					return;
				}
				for (let i = next; i < next + PREFETCH; i++) read(i);
				const file = files[next];
				const data = (await read(next)) as Uint8Array;
				if (finished) return; // cancelled while the read was in flight
				reads.delete(next);
				next++;
				total += data.length;
				if (total > MAX_BYTES) throw new Error("Archive is too large; clone the repository instead");
				const path = `${opts.root}/${file.path}`;
				const mode = file.type === "exec" ? 0o755 : file.type === "symlink" ? 0o777 : 0o644;
				const symlink = file.type === "symlink";
				const chunks = opts.format === "zip" ? [await zip.add(path, data, mode, symlink, opts.mtime)] : tarEntry(path, data, mode, symlink, opts.mtime);
				if (finished) return;
				for (const chunk of chunks) controller.enqueue(chunk);
			} catch (err) {
				if (!finished) controller.error(err);
				finish();
			}
		},
		cancel() {
			finish();
		},
	});
	return opts.format === "zip" ? raw : raw.pipeThrough<Uint8Array>(new CompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
}

// ── tar (ustar, with a PAX header for paths over 100 bytes) ──────────────────

const encoder = new TextEncoder();

/** Header(s), data and padding for one file, as separate chunks so the file's bytes aren't copied. */
function tarEntry(path: string, data: Uint8Array, mode: number, symlink: boolean, mtime: number): Uint8Array[] {
	const name = encoder.encode(path);
	const link = symlink ? encoder.encode(new TextDecoder().decode(data)) : new Uint8Array();
	const parts: Uint8Array[] = [];
	if (name.length > 100 || link.length > 100) {
		let records = "";
		if (name.length > 100) records += paxRecord("path", path);
		if (link.length > 100) records += paxRecord("linkpath", new TextDecoder().decode(data));
		const body = encoder.encode(records);
		parts.push(tarHeader("pax", body.length, 0o644, "x", "", mtime), body, padding(body.length));
	}
	const linkname = symlink ? new TextDecoder().decode(data) : "";
	parts.push(tarHeader(path, symlink ? 0 : data.length, mode, symlink ? "2" : "0", linkname, mtime));
	if (!symlink) parts.push(data, padding(data.length));
	return parts;
}

function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	// The length prefix counts its own digits.
	const bytes = encoder.encode(body).length;
	let len = bytes + 1;
	while (String(len).length + bytes !== len) len = String(len).length + bytes;
	return `${len}${body}`;
}

function tarHeader(name: string, size: number, mode: number, type: string, linkname: string, mtime: number): Uint8Array {
	const h = new Uint8Array(512);
	const put = (offset: number, length: number, value: string) => h.set(encoder.encode(value).subarray(0, length), offset);
	const octal = (offset: number, length: number, value: number) => put(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
	put(0, 100, name);
	octal(100, 8, mode);
	octal(108, 8, 0);
	octal(116, 8, 0);
	octal(124, 12, size);
	octal(136, 12, mtime);
	put(148, 8, "        ");
	put(156, 1, type);
	put(157, 100, linkname);
	put(257, 6, "ustar\0");
	put(263, 2, "00");
	put(265, 32, "megit");
	put(297, 32, "megit");
	const sum = h.reduce((n, b) => n + b, 0);
	put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return h;
}

const padding = (size: number) => new Uint8Array((512 - (size % 512)) % 512);

// ── zip (deflate, UTF-8 names, unix modes) ───────────────────────────────────

class ZipWriter {
	private offset = 0;
	private readonly central: Uint8Array[] = [];
	private count = 0;

	async add(path: string, data: Uint8Array, mode: number, symlink: boolean, mtime: number): Promise<Uint8Array> {
		const name = encoder.encode(path);
		const crc = crc32(data);
		const compressed = data.length > 0 ? await deflate(data) : data;
		const method = compressed.length < data.length ? 8 : 0;
		const body = method === 8 ? compressed : data;
		const [time, date] = dosTime(mtime);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, 0x0800, true);
		local.setUint16(8, method, true);
		local.setUint16(10, time, true);
		local.setUint16(12, date, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, body.length, true);
		local.setUint32(22, data.length, true);
		local.setUint16(26, name.length, true);
		local.setUint16(28, 0, true);

		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true);
		entry.setUint16(4, (3 << 8) | 20, true); // made by unix, so external attributes carry the mode
		entry.setUint16(6, 20, true);
		entry.setUint16(8, 0x0800, true);
		entry.setUint16(10, method, true);
		entry.setUint16(12, time, true);
		entry.setUint16(14, date, true);
		entry.setUint32(16, crc, true);
		entry.setUint32(20, body.length, true);
		entry.setUint32(24, data.length, true);
		entry.setUint16(28, name.length, true);
		entry.setUint32(38, ((symlink ? 0o120000 : 0o100000) | mode) * 0x10000, true);
		entry.setUint32(42, this.offset, true);
		this.central.push(new Uint8Array(entry.buffer), name);
		this.count++;

		const out = concat([new Uint8Array(local.buffer), name, body]);
		this.offset += out.length;
		return out;
	}

	finish(): Uint8Array {
		const dir = concat(this.central);
		const end = new DataView(new ArrayBuffer(22));
		end.setUint32(0, 0x06054b50, true);
		end.setUint16(8, this.count, true);
		end.setUint16(10, this.count, true);
		end.setUint32(12, dir.length, true);
		end.setUint32(16, this.offset, true);
		return concat([dir, new Uint8Array(end.buffer)]);
	}
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosTime(unix: number): [number, number] {
	const d = new Date(Math.max(unix, 315532800) * 1000);
	const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
	const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
	return [time, date];
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
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
