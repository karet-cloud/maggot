// SSH keys: users' public keys (parsing, fingerprints, checking signatures) and the server's host key.
import { HttpError } from "../errors.ts";
import { base64, base64url, concat, fromBase64, fromBase64url, Reader, sha256, Writer } from "./wire.ts";

/** Where the SSH-over-WebSocket endpoint lives. */
export const SSH_PATH = "/_ssh";

/** Key types users may add, and the signature algorithms each can sign with. */
const KEY_TYPES: Record<string, { algorithms: string[] }> = {
	"ssh-ed25519": { algorithms: ["ssh-ed25519"] },
	"ecdsa-sha2-nistp256": { algorithms: ["ecdsa-sha2-nistp256"] },
	"ecdsa-sha2-nistp384": { algorithms: ["ecdsa-sha2-nistp384"] },
	"ecdsa-sha2-nistp521": { algorithms: ["ecdsa-sha2-nistp521"] },
	// SHA-1 signatures (plain "ssh-rsa") aren't accepted, as OpenSSH no longer is by default.
	"ssh-rsa": { algorithms: ["rsa-sha2-512", "rsa-sha2-256"] },
};

/** Signature algorithms the server accepts, in the order it lists them (server-sig-algs). */
export const SIGNATURE_ALGORITHMS = Object.values(KEY_TYPES).flatMap((t) => t.algorithms);

const CURVES: Record<string, { curve: string; hash: string; size: number }> = {
	"ecdsa-sha2-nistp256": { curve: "P-256", hash: "SHA-256", size: 32 },
	"ecdsa-sha2-nistp384": { curve: "P-384", hash: "SHA-384", size: 48 },
	"ecdsa-sha2-nistp521": { curve: "P-521", hash: "SHA-512", size: 66 },
};

export interface ParsedKey {
	type: string;
	/** The key blob, base64 (as in authorized_keys). */
	blob: string;
	fingerprint: string;
	comment: string;
}

/** `SHA256:<base64 without padding>`, as `ssh-keygen -l` prints it. */
export async function fingerprint(blob: Uint8Array): Promise<string> {
	return `SHA256:${base64(await sha256(blob)).replace(/=+$/, "")}`;
}

/** Parses an authorized_keys-style line (`ssh-ed25519 AAAA... comment`) and checks the key is usable. */
export async function parsePublicKey(line: string): Promise<ParsedKey> {
	const parts = line.trim().split(/\s+/);
	const [type, data, ...comment] = parts;
	const invalid = (why: string) => new HttpError(400, "INVALID_KEY", `That isn't a public key megit can use: ${why}`);
	if (!type || !data) throw invalid("paste the whole line from your .pub file, starting with its type (for example ssh-ed25519)");
	if (type.includes("PRIVATE")) throw invalid("that's a private key; paste the .pub file instead");
	if (!KEY_TYPES[type]) throw invalid(`${type} keys aren't supported; use ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa`);
	let blob: Uint8Array;
	try {
		blob = fromBase64(data);
	} catch {
		throw invalid("the key data isn't valid base64");
	}
	try {
		const inner = new Reader(blob).text();
		if (inner !== type) throw invalid(`the data is a ${inner} key, not ${type}`);
		await importPublicKey(blob, KEY_TYPES[type].algorithms[0]);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw invalid(err instanceof Error ? err.message : "it couldn't be read");
	}
	return { type, blob: base64(blob), fingerprint: await fingerprint(blob), comment: comment.join(" ") };
}

/** Whether a key of type `keyType` may sign with `algorithm`. */
export function algorithmFits(keyType: string, algorithm: string): boolean {
	return KEY_TYPES[keyType]?.algorithms.includes(algorithm) ?? false;
}

/** Imports a public key blob as a WebCrypto verification key for `algorithm`. */
async function importPublicKey(blob: Uint8Array, algorithm: string): Promise<CryptoKey> {
	const r = new Reader(blob);
	const type = r.text();
	if (type === "ssh-ed25519") {
		const key = r.string();
		if (key.length !== 32) throw new Error("an Ed25519 key is 32 bytes");
		return crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
	}
	const curve = CURVES[type];
	if (curve) {
		const name = r.text();
		if (`ecdsa-sha2-${name}` !== type) throw new Error("the curve doesn't match the key type");
		const point = r.string();
		return crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: curve.curve }, false, ["verify"]);
	}
	if (type === "ssh-rsa") {
		const e = r.mpint();
		const n = r.mpint();
		if (n.length * 8 < 2048) throw new Error("RSA keys need at least 2048 bits");
		if (n.length * 8 > 16384) throw new Error("RSA keys can have at most 16384 bits");
		const hash = algorithm === "rsa-sha2-256" ? "SHA-256" : "SHA-512";
		return crypto.subtle.importKey("jwk", { kty: "RSA", e: base64url(e), n: base64url(n), ext: true }, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
	}
	throw new Error(`${type} keys aren't supported`);
}

/** Checks an SSH signature blob (`string algorithm, string signature`) by the key `blob` over `data`. */
export async function verifySignature(blob: Uint8Array, algorithm: string, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
	try {
		const s = new Reader(signature);
		if (s.text() !== algorithm) return false;
		const sig = s.string();
		const key = await importPublicKey(blob, algorithm);
		const keyType = new Reader(blob).text();
		const curve = CURVES[keyType];
		if (curve) {
			// SSH carries r and s as mpints; WebCrypto wants them as fixed-width halves.
			const parts = new Reader(sig);
			const raw = concat([fixedWidth(parts.mpint(), curve.size), fixedWidth(parts.mpint(), curve.size)]);
			return await crypto.subtle.verify({ name: "ECDSA", hash: curve.hash }, key, raw, data);
		}
		return await crypto.subtle.verify(key.algorithm.name, key, sig, data);
	} catch {
		return false;
	}
}

function fixedWidth(magnitude: Uint8Array, size: number): Uint8Array {
	if (magnitude.length > size) throw new Error("Signature value too large");
	const out = new Uint8Array(size);
	out.set(magnitude, size - magnitude.length);
	return out;
}

// ── Host key ─────────────────────────────────────────────────────────────────

export interface HostKey {
	privateKey: CryptoKey;
	/** The public key blob (`string "ssh-ed25519", string key`). */
	blob: Uint8Array;
	/** `ssh-ed25519 AAAA...`, for known_hosts. */
	line: string;
	fingerprint: string;
}

const hostKeys = new Map<string, Promise<HostKey>>();

/**
 * The server's Ed25519 host key. It's derived from MEGIT_API_KEY (or MEGIT_SSH_HOST_KEY_SEED, if set),
 * so every isolate has the same key without storing a private key anywhere; rotating the secret
 * changes the host key, and clients will warn about it.
 */
export function hostKey(env: Env): Promise<HostKey> {
	const secret = (env as { MEGIT_SSH_HOST_KEY_SEED?: string }).MEGIT_SSH_HOST_KEY_SEED || env.MEGIT_API_KEY;
	if (!secret) throw new HttpError(500, "MISCONFIGURED", "MEGIT_API_KEY is not set");
	let key = hostKeys.get(secret);
	if (!key) {
		key = deriveHostKey(secret);
		key.catch(() => hostKeys.delete(secret));
		hostKeys.set(secret, key);
	}
	return key;
}

async function deriveHostKey(secret: string): Promise<HostKey> {
	const mac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const seed = new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode("megit-ssh-host-key-v1")));
	// PKCS#8 for an Ed25519 private key is a fixed prefix and the 32-byte seed (RFC 8410).
	const pkcs8 = concat([Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]), seed]);
	const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
	const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
	const publicKey = fromBase64url(jwk.x as string);
	const blob = new Writer().string("ssh-ed25519").string(publicKey).finish();
	return { privateKey, blob, line: `ssh-ed25519 ${base64(blob)}`, fingerprint: await fingerprint(blob) };
}

/** Signs `data` with the host key, as an SSH signature blob. */
export async function signWithHostKey(key: HostKey, data: Uint8Array): Promise<Uint8Array> {
	const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, data));
	return new Writer().string("ssh-ed25519").string(signature).finish();
}
