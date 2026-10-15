// Who is calling: a signed-in user (Better Auth session cookie), a user's personal access token, the
// admin API key (agents, scripts, tests), or nobody. Repository permissions are decided from that.
import { waitUntil } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins/username";
import type { Viewer } from "./api.ts";
import { db, ensureSchema, userForToken, type RepoRow } from "./db.ts";
import { HttpError } from "./errors.ts";
import { resetPasswordEmail, sendMail, verifyEmail } from "./mail.ts";
import { usernameShape } from "./names.ts";
import { verificationRequired } from "./policy.ts";

export type Principal =
	| { kind: "admin" }
	| { kind: "user"; id: string; username: string; via: "session" | "token" | "ssh"; verified: boolean }
	| { kind: "anonymous" };

const instances = new Map<string, ReturnType<typeof createAuth>>();

/**
 * Links being issued by an admin, keyed by `<kind>:<email>`, so the hooks hand them back instead of
 * mailing them.
 */
const capturing = new Map<string, (url: string) => void>();

/** Where reset links land: the page that asks for the new password. */
export const RESET_PAGE = "/reset-password";
/** Where verification links land once the address is verified (or with `?error=`). */
export const VERIFIED_PAGE = "/verify-email";

function createAuth(env: Env, origin: string, secret: string) {
	return betterAuth({
		database: db(env),
		secret,
		baseURL: origin,
		basePath: "/api/auth",
		trustedOrigins: [origin],
		emailAndPassword: {
			enabled: true,
			autoSignIn: true,
			minPasswordLength: 8,
			resetPasswordTokenExpiresIn: 3600,
			// A reset signs the account out everywhere; personal access tokens stay valid (revoke them on the Tokens page).
			revokeSessionsOnPasswordReset: true,
			async sendResetPassword({ user, url }) {
				const capture = capturing.get(`reset:${user.email.toLowerCase()}`);
				if (capture) return capture(url);
				const name = (user as { username?: string | null }).username ?? user.name;
				await deliver(env, "password reset", name, url, { to: user.email, ...resetPasswordEmail(name, url) });
			},
		},
		emailVerification: {
			// Without email delivery the link is only logged, so new accounts get one only when it's needed.
			sendOnSignUp: verificationRequired(env),
			autoSignInAfterVerification: true,
			expiresIn: 24 * 3600,
			async sendVerificationEmail({ user, url }) {
				const capture = capturing.get(`verify:${user.email.toLowerCase()}`);
				if (capture) return capture(url);
				const name = (user as { username?: string | null }).username ?? user.name;
				await deliver(env, "email verification", name, url, { to: user.email, ...verifyEmail(name, url) });
			},
		},
		session: { expiresIn: 30 * 24 * 3600, updateAge: 24 * 3600 },
		advanced: {
			cookiePrefix: "maggot",
			// Emails go out after the response (the request's waitUntil), so signing up or asking for a reset
			// doesn't wait on delivery, and a reset for an existing account takes as long as one for none.
			// Links an admin is issuing are still captured, synchronously, before anything is sent.
			backgroundTasks: { handler: (promise) => waitUntil(promise) },
			// ensureSchema creates these tables; Better Auth's own check would introspect every table in
			// the database (dozens of D1 queries) on each isolate's first auth request.
			database: { validateSchema: false },
		},
		// Repository URLs start with the username, so it can't change (renames would have to move them all).
		// Reserved names are refused at sign-up (src/index.ts), since this validator checks sign-ins too.
		plugins: [username({ minUsernameLength: 2, maxUsernameLength: 39, usernameValidator: usernameShape, immutableUsername: true })],
	});
}

/**
 * Sends an account email. It runs after the response (see backgroundTasks), so nothing retries it: a
 * failure is logged, without the link, and the person asks again (Resend on the verification banner,
 * or Forgot password). Without email delivery the link only reaches the server log (useful in local
 * development).
 */
async function deliver(env: Env, what: string, name: string, url: string, message: Parameters<typeof sendMail>[1]): Promise<void> {
	let sent: boolean;
	try {
		sent = await sendMail(env, message);
	} catch (err) {
		console.error(`[maggot] sending the ${what} email to ${name} failed; they can ask for another`, err);
		return;
	}
	if (!sent) console.log(`[maggot] ${what} link for ${name}: ${url}`);
}

/** One Better Auth instance per origin per isolate (the base URL is the request's own origin). */
export async function auth(env: Env, request: Request) {
	const origin = new URL(request.url).origin;
	let instance = instances.get(origin);
	if (!instance) {
		// Keyed by origin, which follows the Host header; keep the map from growing without bound.
		if (instances.size >= 8) instances.clear();
		instance = createAuth(env, origin, await authSecret(env));
		instances.set(origin, instance);
	}
	await ensureSchema(db(env));
	return instance;
}

/** BETTER_AUTH_SECRET if set; otherwise derived from the API key, so a deploy needs no extra secret. */
async function authSecret(env: Env): Promise<string> {
	const explicit = (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET;
	if (explicit) return explicit;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiKey(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("maggot-better-auth-secret-v1"));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function apiKey(env: Env): string {
	if (!env.MAGGOT_API_KEY) throw new HttpError(500, "MISCONFIGURED", "MAGGOT_API_KEY is not set");
	return env.MAGGOT_API_KEY;
}

/** Compares secrets without an early exit on the first differing byte. */
export function safeEqual(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	if (x.length !== y.length) return false;
	return crypto.subtle.timingSafeEqual(x, y);
}

/** Whether the request carries the admin API key as a bearer token (for routes that don't resolve a principal). */
export function isAdminKey(env: Env, request: Request): boolean {
	const header = request.headers.get("authorization") ?? "";
	return header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), apiKey(env));
}

/**
 * Resolves the caller from, in order: a bearer token (`?key=` too, since browsers can't set headers on
 * WebSockets), HTTP Basic credentials whose password is a token (git), then the session cookie.
 * A token that is present but wrong is an error rather than anonymous access.
 */
export async function resolvePrincipal(env: Env, request: Request): Promise<Principal> {
	const header = request.headers.get("authorization") ?? "";
	let secret: string | null = null;
	if (header.startsWith("Bearer ")) secret = header.slice(7).trim();
	else if (header.startsWith("Basic ")) {
		const decoded = safeAtob(header.slice(6).trim());
		secret = decoded === null ? "" : decoded.slice(decoded.indexOf(":") + 1);
	} else secret = new URL(request.url).searchParams.get("key");

	if (secret !== null) {
		if (safeEqual(secret, apiKey(env))) return { kind: "admin" };
		await ensureSchema(db(env));
		const user = await userForToken(db(env), secret);
		if (user) return { kind: "user", id: user.id, username: user.username, via: "token", verified: user.verified };
		throw new HttpError(401, "UNAUTHORIZED", "Invalid token");
	}
	if (!request.headers.get("cookie")?.includes("maggot.session_token")) return { kind: "anonymous" };
	const session = await (await auth(env, request)).api.getSession({ headers: request.headers });
	const name = (session?.user as { username?: string | null } | undefined)?.username;
	if (!session || !name) return { kind: "anonymous" };
	return { kind: "user", id: session.user.id, username: name, via: "session", verified: session.user.emailVerified };
}

function safeAtob(value: string): string | null {
	try {
		return atob(value);
	} catch {
		return null;
	}
}


/**
 * The caller's access to a repository: 3 admin (settings, transfer, delete, webhooks), 2 write (push,
 * merge, label), 1 read, 0 none. Rows read for the caller carry it (`level`, from organizations,
 * teams and collaborators); otherwise only the owner has any.
 */
export function accessTo(p: Principal, repo: RepoRow): number {
	if (p.kind === "admin") return 3;
	if (p.kind !== "user") return 0;
	if (p.id === repo.ownerId) return 3;
	return repo.level ?? 0;
}

export function canRead(p: Principal, repo: RepoRow): boolean {
	return repo.visibility === "public" || accessTo(p, repo) >= 1;
}

export function canWrite(p: Principal, repo: RepoRow): boolean {
	return accessTo(p, repo) >= 2;
}

export function canAdmin(p: Principal, repo: RepoRow): boolean {
	return accessTo(p, repo) >= 3;
}

/** Throws unless the user has verified their email address (when this server requires it). */
export function requireVerified(env: Env, principal: Principal): void {
	if (principal.kind === "user" && !principal.verified && verificationRequired(env)) {
		throw new HttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email address first; the link is in the email we sent when you signed up.");
	}
}

/**
 * A password reset or email verification link for a user, without emailing it: for an admin to pass
 * on when email isn't set up. Returns null if there is no such user (or, for verification, the
 * address is already verified).
 */
export async function issueLink(env: Env, request: Request, kind: "reset" | "verify", email: string): Promise<string | null> {
	const instance = await auth(env, request);
	const key = `${kind}:${email.toLowerCase()}`;
	let link: string | null = null;
	capturing.set(key, (url) => {
		link = url;
	});
	try {
		if (kind === "reset") await instance.api.requestPasswordReset({ body: { email, redirectTo: RESET_PAGE } });
		else await instance.api.sendVerificationEmail({ body: { email, callbackURL: VERIFIED_PAGE } });
	} finally {
		capturing.delete(key);
	}
	return link;
}
