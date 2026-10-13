// SSH's data types (RFC 4251 section 5): bytes, uint32, strings, mpints, name-lists and booleans.

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export class SshError extends Error {}

/** Reads SSH data types from a message; any read past the end throws SshError. */
export class Reader {
	private offset = 0;
	private readonly bytes: Uint8Array;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}

	get remaining(): number {
		return this.bytes.length - this.offset;
	}

	byte(): number {
		if (this.remaining < 1) throw new SshError("Message too short");
		return this.bytes[this.offset++];
	}

	bool(): boolean {
		return this.byte() !== 0;
	}

	uint32(): number {
		if (this.remaining < 4) throw new SshError("Message too short");
		const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
		this.offset += 4;
		return view.getUint32(0);
	}

	raw(length: number): Uint8Array {
		if (this.remaining < length) throw new SshError("Message too short");
		const out = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return out;
	}

	/** A length-prefixed byte string. */
	string(): Uint8Array {
		return this.raw(this.uint32());
	}

	text(): string {
		return fromUtf8.decode(this.string());
	}

	nameList(): string[] {
		const text = this.text();
		return text === "" ? [] : text.split(",");
	}

	/** An mpint's magnitude, without the sign byte (callers only read non-negative ones). */
	mpint(): Uint8Array {
		const bytes = this.string();
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		return bytes.subarray(start);
	}
}

/** Builds an SSH message. */
export class Writer {
	private chunks: Uint8Array[] = [];
	private length = 0;

	private push(bytes: Uint8Array): this {
		this.chunks.push(bytes);
		this.length += bytes.length;
		return this;
	}

	byte(value: number): this {
		return this.push(Uint8Array.of(value));
	}

	bool(value: boolean): this {
		return this.byte(value ? 1 : 0);
	}

	uint32(value: number): this {
		const out = new Uint8Array(4);
		new DataView(out.buffer).setUint32(0, value >>> 0);
		return this.push(out);
	}

	raw(bytes: Uint8Array): this {
		return this.push(bytes);
	}

	string(value: Uint8Array | string): this {
		const bytes = typeof value === "string" ? utf8.encode(value) : value;
		return this.uint32(bytes.length).push(bytes);
	}

	nameList(names: string[]): this {
		return this.string(names.join(","));
	}

	/** A non-negative integer given as big-endian bytes. */
	mpint(magnitude: Uint8Array): this {
		return this.string(mpintBytes(magnitude));
	}

	finish(): Uint8Array {
		return concat(this.chunks, this.length);
	}
}

/** An mpint's body: leading zeros dropped, and a zero byte added if the top bit would read as a sign. */
export function mpintBytes(magnitude: Uint8Array): Uint8Array {
	let start = 0;
	while (start < magnitude.length && magnitude[start] === 0) start++;
	const trimmed = magnitude.subarray(start);
	if (trimmed.length > 0 && trimmed[0] & 0x80) return concat([Uint8Array.of(0), trimmed]);
	return trimmed;
}

export function concat(chunks: Uint8Array[], length = chunks.reduce((n, c) => n + c.length, 0)): Uint8Array {
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function base64url(bytes: Uint8Array): string {
	return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
	return fromBase64(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(parts)));
}
