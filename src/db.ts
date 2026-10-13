// D1: Better Auth's tables (users, sessions, accounts), repository records and personal access tokens.
// The schema is created idempotently on first use in each isolate, so deploys need no migration step.
import type { RepoInfo, Visibility } from "./api.ts";
import { HttpError } from "./errors.ts";

// Generated from Better Auth 1.7 (email/password + username plugin) with getMigrations().compileMigrations().
const AUTH_SCHEMA = [
	`create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "username" text unique, "displayUsername" text)`,
	`create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade)`,
	`create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)`,
	`create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)`,
	`create index if not exists "session_userId_idx" on "session" ("userId")`,
	`create index if not exists "account_userId_idx" on "account" ("userId")`,
	`create index if not exists "verification_identifier_idx" on "verification" ("identifier")`,
];

const APP_SCHEMA = [
	// `id` is the internal project name: the coordinator Durable Object and the Artifacts repo use it,
	// so owner/name can change later without moving any Git data.
	`create table if not exists "repo" ("id" text not null primary key, "ownerId" text not null references "user" ("id") on delete cascade, "owner" text not null, "name" text not null collate nocase, "description" text, "visibility" text not null check ("visibility" in ('public', 'private')), "defaultBranch" text not null, "createdAt" text not null, unique ("owner", "name"))`,
	`create index if not exists "repo_public_idx" on "repo" ("visibility", "createdAt")`,
	`create index if not exists "repo_owner_idx" on "repo" ("ownerId")`,
	`create table if not exists "token" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "name" text not null, "hash" text not null unique, "prefix" text not null, "createdAt" text not null, "lastUsedAt" text)`,
	`create index if not exists "token_userId_idx" on "token" ("userId")`,
];

/** Columns added after a table was first created; adding one that exists fails harmlessly. */
const COLUMNS = [
	// Bytes pushed to the repository, which quotas are checked against.
	`alter table "repo" add column "bytes" integer not null default 0`,
];

const ready = new WeakMap<D1Database, Promise<void>>();

export function db(env: Env): D1Database {
	const database = (env as { DB?: D1Database }).DB;
	if (!database) throw new HttpError(500, "MISCONFIGURED", "No DB binding configured");
	return database;
}

/** Creates any missing tables. Cheap after the first call in an isolate. */
export function ensureSchema(database: D1Database): Promise<void> {
	let pending = ready.get(database);
	if (!pending) {
		pending = database
			.batch([...AUTH_SCHEMA, ...APP_SCHEMA].map((sql) => database.prepare(sql)))
			.then(() => Promise.all(COLUMNS.map((sql) => database.prepare(sql).run().catch(ignoreDuplicateColumn))))
			.then(() => undefined)
			.catch((err) => {
				ready.delete(database);
				throw err;
			});
		ready.set(database, pending);
	}
	return pending;
}

function ignoreDuplicateColumn(err: unknown) {
	if (!/duplicate column/i.test(String(err))) throw err;
}

// ── Repositories ─────────────────────────────────────────────────────────────

export interface RepoRow {
	id: string;
	ownerId: string;
	owner: string;
	name: string;
	description: string | null;
	visibility: Visibility;
	defaultBranch: string;
	createdAt: string;
	bytes: number;
}

/** GitHub's rule: letters, digits, '.', '-', '_'; not "." or "..", and not ending in ".git". */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function assertRepoName(name: string): string {
	if (!REPO_NAME.test(name) || name === "." || name === ".." || name.toLowerCase().endsWith(".git")) {
		throw new HttpError(400, "INVALID_NAME", "Repository names are 1-100 letters, digits, '.', '-' or '_', and can't end in .git.");
	}
	return name;
}

export async function findRepo(database: D1Database, owner: string, name: string): Promise<RepoRow | null> {
	return database.prepare(`select * from "repo" where "owner" = ? and "name" = ?`).bind(owner.toLowerCase(), name).first<RepoRow>();
}

export async function insertRepo(database: D1Database, row: RepoRow): Promise<void> {
	try {
		await database
			.prepare(`insert into "repo" ("id", "ownerId", "owner", "name", "description", "visibility", "defaultBranch", "createdAt") values (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(row.id, row.ownerId, row.owner, row.name, row.description, row.visibility, row.defaultBranch, row.createdAt)
			.run();
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", `${row.owner}/${row.name} already exists`);
		throw err;
	}
}

export async function updateRepo(database: D1Database, id: string, patch: { visibility?: Visibility; description?: string | null }): Promise<void> {
	if (patch.visibility !== undefined) await database.prepare(`update "repo" set "visibility" = ? where "id" = ?`).bind(patch.visibility, id).run();
	if (patch.description !== undefined) await database.prepare(`update "repo" set "description" = ? where "id" = ?`).bind(patch.description, id).run();
}

/** Adds a push's size to the repository's total. */
export async function addRepoBytes(database: D1Database, id: string, bytes: number): Promise<void> {
	await database.prepare(`update "repo" set "bytes" = "bytes" + ? where "id" = ?`).bind(bytes, id).run();
}

export async function deleteRepo(database: D1Database, id: string): Promise<void> {
	await database.prepare(`delete from "repo" where "id" = ?`).bind(id).run();
}

/** Public repositories plus, when `viewerId` is given, that user's private ones. Newest first. */
export async function listRepos(database: D1Database, opts: { owner?: string; viewerId?: string | null; limit?: number }): Promise<RepoRow[]> {
	const where: string[] = [];
	const args: unknown[] = [];
	if (opts.owner) {
		where.push(`"owner" = ?`);
		args.push(opts.owner.toLowerCase());
	}
	where.push(`("visibility" = 'public' or "ownerId" = ?)`);
	args.push(opts.viewerId ?? "");
	const { results } = await database
		.prepare(`select * from "repo" where ${where.join(" and ")} order by "createdAt" desc limit ?`)
		.bind(...args, opts.limit ?? 100)
		.all<RepoRow>();
	return results;
}

export function toRepoInfo(row: RepoRow, origin: string, canWrite: boolean): RepoInfo {
	return {
		owner: row.owner,
		name: row.name,
		fullName: `${row.owner}/${row.name}`,
		description: row.description,
		visibility: row.visibility,
		defaultBranch: row.defaultBranch,
		createdAt: row.createdAt,
		cloneUrl: `${origin}/${row.owner}/${row.name}.git`,
		canWrite,
	};
}

// ── Personal access tokens ───────────────────────────────────────────────────

export const TOKEN_PREFIX = "megit_pat_";

export interface TokenInfo {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mints a token. Only its hash is stored; the plaintext is returned once. */
export async function createToken(database: D1Database, userId: string, name: string): Promise<{ token: string; info: TokenInfo }> {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const token = TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	const info: TokenInfo = { id: crypto.randomUUID(), name, prefix: token.slice(0, TOKEN_PREFIX.length + 4), createdAt: new Date().toISOString(), lastUsedAt: null };
	await database
		.prepare(`insert into "token" ("id", "userId", "name", "hash", "prefix", "createdAt") values (?, ?, ?, ?, ?, ?)`)
		.bind(info.id, userId, name, await sha256(token), info.prefix, info.createdAt)
		.run();
	return { token, info };
}

export async function listTokens(database: D1Database, userId: string): Promise<TokenInfo[]> {
	const { results } = await database
		.prepare(`select "id", "name", "prefix", "createdAt", "lastUsedAt" from "token" where "userId" = ? order by "createdAt" desc`)
		.bind(userId)
		.all<TokenInfo>();
	return results;
}

export async function revokeToken(database: D1Database, userId: string, id: string): Promise<boolean> {
	const result = await database.prepare(`delete from "token" where "id" = ? and "userId" = ?`).bind(id, userId).run();
	return result.meta.changes > 0;
}

/** The user a token belongs to, or null. Records when it was last used (at most once a minute). */
export async function userForToken(database: D1Database, token: string): Promise<{ id: string; username: string; verified: boolean } | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const row = await database
		.prepare(`select "token"."id" as "tokenId", "token"."lastUsedAt", "user"."id", "user"."username", "user"."emailVerified" from "token" join "user" on "user"."id" = "token"."userId" where "token"."hash" = ?`)
		.bind(await sha256(token))
		.first<{ tokenId: string; lastUsedAt: string | null; id: string; username: string | null; emailVerified: number }>();
	if (!row?.username) return null;
	if (!row.lastUsedAt || Date.parse(row.lastUsedAt) < Date.now() - 60_000) {
		await database.prepare(`update "token" set "lastUsedAt" = ? where "id" = ?`).bind(new Date().toISOString(), row.tokenId).run();
	}
	return { id: row.id, username: row.username, verified: Boolean(row.emailVerified) };
}
