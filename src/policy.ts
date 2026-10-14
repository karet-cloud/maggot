// Abuse protection: request rate limits, per-account quotas, and whether accounts must verify their
// email before they can create or push. Defaults suit a public instance; MAGGOT_POLICY (JSON, set at
// deploy time) overrides any of them.
import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./errors.ts";
import { emailConfigured } from "./mail.ts";

export interface Policy {
	/** Accounts per IP address per hour. */
	signUpsPerHour: number;
	/** Sign-in attempts per IP address per 5 minutes. */
	signInsPerIp: number;
	/** Sign-in attempts per username or email per 15 minutes, from anywhere. */
	signInsPerAccount: number;
	/** Password reset and verification emails per IP address, and per address, per hour. */
	emailsPerHour: number;
	/** API requests per user (or per IP address when signed out) per minute. */
	apiPerMinute: number;
	/** API writes (anything but GET) per user per minute. */
	writesPerMinute: number;
	/** Repositories created per user per hour (deleting one doesn't give the slot back). */
	repoCreatesPerHour: number;
	/** Git requests (clone, fetch, push) per user or IP address per minute. A clone is two or three. */
	gitPerMinute: number;
	/** Code searches per user or IP address per minute. */
	searchesPerMinute: number;
	/** Issues and comments one user may post per hour, across all repositories. */
	postsPerHour: number;
	/** Requests with a wrong token or password per IP address per 5 minutes, before the address is refused. */
	authFailuresPerIp: number;
	reposPerUser: number;
	/** Bytes one push may send. */
	pushBytes: number;
	/** Bytes pushed to one repository, in total; pushes stop once it is reached. */
	repoBytes: number;
	/** Bytes pushed across all of a user's repositories. */
	userBytes: number;
	/** Unverified accounts can't create repositories, push, or fork. Defaults to on when email can be sent. */
	requireVerifiedEmail?: boolean;
}

const MB = 1024 * 1024;

export const DEFAULT_POLICY: Policy = {
	signUpsPerHour: 5,
	signInsPerIp: 20,
	signInsPerAccount: 10,
	emailsPerHour: 5,
	apiPerMinute: 600,
	writesPerMinute: 60,
	repoCreatesPerHour: 20,
	gitPerMinute: 120,
	authFailuresPerIp: 30,
	searchesPerMinute: 30,
	postsPerHour: 60,
	reposPerUser: 50,
	pushBytes: 100 * MB,
	repoBytes: 1024 * MB,
	userBytes: 2048 * MB,
};

const parsed = new Map<string, Policy>();

export function policy(env: Env): Policy {
	const raw = (env as { MAGGOT_POLICY?: string }).MAGGOT_POLICY ?? "";
	let found = parsed.get(raw);
	if (!found) {
		let overrides: Partial<Policy> = {};
		try {
			overrides = raw ? (JSON.parse(raw) as Partial<Policy>) : {};
		} catch {
			console.error("MAGGOT_POLICY is not valid JSON; using the defaults");
		}
		found = { ...DEFAULT_POLICY, ...overrides };
		parsed.set(raw, found);
	}
	return found;
}

/** Whether new accounts have to verify their email address before creating anything. */
export function verificationRequired(env: Env): boolean {
	return policy(env).requireVerifiedEmail ?? emailConfigured(env);
}

export function clientIp(request: Request): string {
	return request.headers.get("cf-connecting-ip") ?? "local";
}

export interface Rule {
	/** Bucket name within the subject, e.g. "sign-in". */
	name: string;
	limit: number;
	windowSeconds: number;
}

export type Verdict = { ok: true } | { ok: false; rule: string; retryAfter: number };

/**
 * Counts `rules` against `subject` (an IP address, user or account) and throws 429 if any is over its
 * limit. A request that is refused doesn't count.
 */
export async function limit(env: Env, subject: string, rules: Rule[], message = "Too many requests"): Promise<void> {
	if (rules.length === 0) return;
	const limiter = (env.LIMITER as DurableObjectNamespace<Limiter>).getByName(subject);
	const verdict = await limiter.take(rules);
	if (!verdict.ok) throw new RateLimited(`${message}; try again in ${formatWait(verdict.retryAfter)}.`, verdict.retryAfter);
}

/**
 * Resolves credentials without letting one address guess tokens cheaply: an address that has sent too
 * many wrong ones is refused before the lookup, and each wrong one counts.
 */
export async function guardCredentials<T>(env: Env, request: Request, resolve: () => Promise<T>): Promise<T> {
	const header = request.headers.get("authorization");
	const presented = Boolean(header) || new URL(request.url).searchParams.has("key");
	if (!presented) return resolve();
	const subject = `ip:${clientIp(request)}`;
	const failures = rules.authFailure(policy(env));
	const limiter = (env.LIMITER as DurableObjectNamespace<Limiter>).getByName(subject);
	const verdict = await limiter.peek(failures);
	if (!verdict.ok) throw new RateLimited(`Too many wrong credentials from your network; try again in ${formatWait(verdict.retryAfter)}.`, verdict.retryAfter);
	try {
		return await resolve();
	} catch (err) {
		if (err instanceof HttpError && err.status === 401) await limiter.take(failures);
		throw err;
	}
}

export class RateLimited extends HttpError {
	readonly retryAfter: number;
	constructor(message: string, retryAfter: number) {
		super(429, "RATE_LIMITED", message);
		this.retryAfter = retryAfter;
	}
}

function formatWait(seconds: number): string {
	if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
	const minutes = Math.ceil(seconds / 60);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Fixed-window counters for one subject. Each subject gets its own instance, so a busy client only
 * contends with itself. Counters are stored so an evicted instance doesn't forget them, and the
 * instance clears its storage once every window has ended.
 */
export class Limiter extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.createTable();
	}

	private createTable() {
		this.sql.exec("CREATE TABLE IF NOT EXISTS hits (bucket TEXT PRIMARY KEY, window_end INTEGER NOT NULL, count INTEGER NOT NULL)");
	}

	/** Whether `rules` have room left, without counting this call. */
	async peek(rules: Rule[]): Promise<Verdict> {
		return this.check(Date.now(), this.windows(rules, Date.now()));
	}

	private windows(rules: Rule[], now: number) {
		return rules.map((r) => {
			const ms = r.windowSeconds * 1000;
			return { rule: r, end: (Math.floor(now / ms) + 1) * ms };
		});
	}

	private check(now: number, windows: { rule: Rule; end: number }[]): Verdict {
		for (const { rule, end } of windows) {
			const row = this.sql.exec<{ window_end: number; count: number }>("SELECT window_end, count FROM hits WHERE bucket = ?", rule.name).toArray()[0];
			const count = row && row.window_end === end ? row.count : 0;
			if (count >= rule.limit) return { ok: false, rule: rule.name, retryAfter: Math.max(1, Math.ceil((end - now) / 1000)) };
		}
		return { ok: true };
	}

	async take(rules: Rule[]): Promise<Verdict> {
		const now = Date.now();
		const windows = this.windows(rules, now);
		const verdict = this.check(now, windows);
		if (!verdict.ok) return verdict;
		for (const { rule, end } of windows) {
			this.sql.exec(
				`INSERT INTO hits (bucket, window_end, count) VALUES (?, ?, 1)
				 ON CONFLICT (bucket) DO UPDATE SET count = CASE WHEN window_end = excluded.window_end THEN count + 1 ELSE 1 END, window_end = excluded.window_end`,
				rule.name,
				end,
			);
		}
		const latest = Math.max(...windows.map((w) => w.end));
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || alarm < latest) await this.ctx.storage.setAlarm(latest);
		return { ok: true };
	}

	async alarm(): Promise<void> {
		this.sql.exec("DELETE FROM hits WHERE window_end <= ?", Date.now());
		const left = this.sql.exec<{ end: number | null }>("SELECT MAX(window_end) AS end FROM hits").one().end;
		// Expired rows are gone; an empty table costs nothing. (Dropping all storage and recreating the
		// table raced requests arriving meanwhile.)
		if (left !== null) await this.ctx.storage.setAlarm(left);
	}
}

// ── Rules ────────────────────────────────────────────────────────────────────

const MINUTE = 60;
const HOUR = 3600;

export const rules = {
	signUp: (p: Policy): Rule[] => [{ name: "sign-up", limit: p.signUpsPerHour, windowSeconds: HOUR }],
	signInIp: (p: Policy): Rule[] => [{ name: "sign-in", limit: p.signInsPerIp, windowSeconds: 5 * MINUTE }],
	signInAccount: (p: Policy): Rule[] => [{ name: "sign-in", limit: p.signInsPerAccount, windowSeconds: 15 * MINUTE }],
	email: (p: Policy): Rule[] => [{ name: "email", limit: p.emailsPerHour, windowSeconds: HOUR }],
	api: (p: Policy, write: boolean): Rule[] => [
		{ name: "api", limit: p.apiPerMinute, windowSeconds: MINUTE },
		...(write ? [{ name: "api-write", limit: p.writesPerMinute, windowSeconds: MINUTE }] : []),
	],
	repoCreate: (p: Policy): Rule[] => [{ name: "repo-create", limit: p.repoCreatesPerHour, windowSeconds: HOUR }],
	git: (p: Policy): Rule[] => [{ name: "git", limit: p.gitPerMinute, windowSeconds: MINUTE }],
	search: (p: Policy): Rule[] => [{ name: "search", limit: p.searchesPerMinute, windowSeconds: MINUTE }],
	post: (p: Policy): Rule[] => [{ name: "post", limit: p.postsPerHour, windowSeconds: HOUR }],
	authFailure: (p: Policy): Rule[] => [{ name: "auth-failure", limit: p.authFailuresPerIp, windowSeconds: 5 * MINUTE }],
};

// ── Quotas ───────────────────────────────────────────────────────────────────

export interface Usage {
	repos: number;
	bytes: number;
}

export async function usage(database: D1Database, userId: string): Promise<Usage> {
	const row = await database
		.prepare(`select count(*) as "repos", coalesce(sum("bytes"), 0) as "bytes" from "repo" where "ownerId" = ?`)
		.bind(userId)
		.first<Usage>();
	return { repos: row?.repos ?? 0, bytes: row?.bytes ?? 0 };
}

/** Throws unless the user may create one more repository. */
export async function assertCanCreateRepo(env: Env, database: D1Database, userId: string): Promise<void> {
	const p = policy(env);
	const used = await usage(database, userId);
	if (used.repos >= p.reposPerUser) {
		throw new HttpError(403, "QUOTA_EXCEEDED", `You have ${used.repos} repositories, the most an account can have. Delete one to make room.`);
	}
	if (used.bytes >= p.userBytes) {
		throw new HttpError(403, "QUOTA_EXCEEDED", `Your repositories use all of your ${formatBytes(p.userBytes)} of storage.`);
	}
}

/** Why a push to this repository would be refused for size, or null if it may go ahead. */
export async function pushBlocked(env: Env, database: D1Database, repo: { ownerId: string; bytes: number }): Promise<string | null> {
	const p = policy(env);
	if (repo.bytes >= p.repoBytes) return `This repository has reached its ${formatBytes(p.repoBytes)} size limit.`;
	const used = await usage(database, repo.ownerId);
	if (used.bytes >= p.userBytes) return `The owner's repositories use all of their ${formatBytes(p.userBytes)} of storage.`;
	return null;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < MB) return `${Math.round(n / 1024)} KB`;
	if (n < 1024 * MB) return `${Math.round(n / MB)} MB`;
	return `${+(n / (1024 * MB)).toFixed(1)} GB`;
}
