/**
 * Credentials a CI job uses inside its sandbox, all derived from MAGGOT_API_KEY:
 * - a checkout token (`mgci_…`): read-only, for named repositories, expiring with the job;
 * - a job token (`mgjob_…`): for maggot's Actions API (caches, artifacts, actions' files), for one job;
 * - an AES-GCM key per repository, which keeps CI secrets and the Depot token encrypted at rest.
 */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
	try {
		const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

async function hmacKey(apiKey: string, purpose = "maggot-ci-checkout-v1"): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const derived = new Uint8Array(await crypto.subtle.sign("HMAC", base, encoder.encode(purpose)));
	return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(apiKey: string, purpose: string, prefix: string, claims: unknown): Promise<string> {
	const payload = base64url(encoder.encode(JSON.stringify(claims)));
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(apiKey, purpose), encoder.encode(payload)));
	return `${prefix}${payload}.${base64url(mac)}`;
}

/** The claims in a token signed for `purpose`, or null if it's forged or malformed. */
async function open(apiKey: string, purpose: string, prefix: string, token: string): Promise<unknown> {
	if (!token.startsWith(prefix)) return null;
	const [payload, mac] = token.slice(prefix.length).split(".");
	const macBytes = mac ? fromBase64url(mac) : null;
	if (!payload || !macBytes) return null;
	if (!(await crypto.subtle.verify("HMAC", await hmacKey(apiKey, purpose), macBytes, encoder.encode(payload)))) return null;
	const json = fromBase64url(payload);
	if (!json) return null;
	try {
		return JSON.parse(new TextDecoder().decode(json)) as unknown;
	} catch {
		return null;
	}
}

export const JOB_TOKEN_PREFIX = "mgjob_";

/** What a job's token lets it do with maggot's Actions API. */
export interface JobGrant {
	/** The repository (coordinator) the job belongs to. */
	repo: string;
	run: number;
	job: string;
	/** Cache scopes it may restore from, in order (its own first), and the one it saves to. */
	read: string[];
	write: string;
	/** Milliseconds since the epoch. */
	expires: number;
}

export function mintJobToken(apiKey: string, grant: JobGrant): Promise<string> {
	return sign(apiKey, "maggot-ci-job-v1", JOB_TOKEN_PREFIX, grant);
}

/** The grant a job token carries, or null if it's forged, malformed or expired. */
export async function verifyJobToken(apiKey: string, token: string): Promise<JobGrant | null> {
	const g = (await open(apiKey, "maggot-ci-job-v1", JOB_TOKEN_PREFIX, token)) as Partial<JobGrant> | null;
	if (!g || typeof g !== "object") return null;
	const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
	if (typeof g.repo !== "string" || typeof g.run !== "number" || typeof g.job !== "string" || !strings(g.read) || typeof g.write !== "string" || typeof g.expires !== "number") return null;
	if (g.expires < Date.now()) return null;
	return g as JobGrant;
}

export const CHECKOUT_TOKEN_PREFIX = "mgci_";

export interface CheckoutGrant {
	/** Repository ids the token may read. */
	repos: string[];
	/** Milliseconds since the epoch. */
	expires: number;
}

export async function mintCheckoutToken(apiKey: string, grant: CheckoutGrant): Promise<string> {
	const payload = base64url(encoder.encode(JSON.stringify({ r: grant.repos, e: grant.expires })));
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(apiKey), encoder.encode(payload)));
	return `${CHECKOUT_TOKEN_PREFIX}${payload}.${base64url(mac)}`;
}

/** The grant a checkout token carries, or null if it's forged, malformed or expired. */
export async function verifyCheckoutToken(apiKey: string, token: string): Promise<CheckoutGrant | null> {
	if (!token.startsWith(CHECKOUT_TOKEN_PREFIX)) return null;
	const [payload, mac] = token.slice(CHECKOUT_TOKEN_PREFIX.length).split(".");
	const macBytes = mac ? fromBase64url(mac) : null;
	if (!payload || !macBytes) return null;
	if (!(await crypto.subtle.verify("HMAC", await hmacKey(apiKey), macBytes, encoder.encode(payload)))) return null;
	const json = fromBase64url(payload);
	if (!json) return null;
	try {
		const { r, e } = JSON.parse(new TextDecoder().decode(json)) as { r?: unknown; e?: unknown };
		if (!Array.isArray(r) || !r.every((x) => typeof x === "string") || typeof e !== "number" || e < Date.now()) return null;
		return { repos: r, expires: e };
	} catch {
		return null;
	}
}

/** Whether a verified grant lets its holder read (clone or fetch) this repository; it never allows writes. */
export function checkoutAllows(grant: CheckoutGrant | null, repo: string): boolean {
	return grant !== null && grant.expires >= Date.now() && grant.repos.includes(repo);
}

async function secretKey(apiKey: string, repo: string): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", encoder.encode(apiKey), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: encoder.encode(repo), info: encoder.encode("maggot-ci-secrets-v1") },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Encrypts a value for one repository; the repository id is bound in, so ciphertexts can't be moved between repositories. */
export async function sealSecret(apiKey: string, repo: string, value: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(repo) }, await secretKey(apiKey, repo), encoder.encode(value)));
	return `${base64url(iv)}.${base64url(sealed)}`;
}

export async function openSecret(apiKey: string, repo: string, sealed: string): Promise<string> {
	const [iv, data] = sealed.split(".").map(fromBase64url);
	if (!iv || !data) throw new Error("A stored secret is corrupt");
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(repo) }, await secretKey(apiKey, repo), data);
	return new TextDecoder().decode(plain);
}
