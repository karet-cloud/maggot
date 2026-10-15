// D1: Better Auth's tables (users, sessions, accounts), repository records and personal access tokens.
// The schema is created idempotently when it changes (see ensureSchema), so deploys need no migration step.
import type {
	Issue,
	IssueComment,
	IssueList,
	IssueState,
	DashboardItem,
	IssueSummary,
	Notification,
	NotificationKind,
	Pull,
	PullList,
	PullSummary,
	RepoInfo,
	RepoTransfer,
	Review,
	ReviewComment,
	ReviewState,
	SshKey,
	Visibility,
} from "./api.ts";
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
	`create table if not exists "star" ("userId" text not null references "user" ("id") on delete cascade, "repoId" text not null references "repo" ("id") on delete cascade, "createdAt" text not null, primary key ("userId", "repoId"))`,
	`create index if not exists "star_repoId_idx" on "star" ("repoId")`,
	`create table if not exists "notification" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "kind" text not null, "repoId" text references "repo" ("id") on delete cascade, "title" text not null, "url" text not null, "actor" text, "createdAt" text not null, "readAt" text)`,
	`create index if not exists "notification_user_idx" on "notification" ("userId", "createdAt")`,
	// Old owner/name pairs of renamed and transferred repositories, so links and remotes keep working.
	`create table if not exists "repo_redirect" ("owner" text not null, "name" text not null collate nocase, "repoId" text not null references "repo" ("id") on delete cascade, "createdAt" text not null, primary key ("owner", "name"))`,
	`create index if not exists "repo_redirect_repoId_idx" on "repo_redirect" ("repoId")`,
	// A repository its owner offered to another user; one at a time, until accepted, declined or expired.
	`create table if not exists "repo_transfer" ("repoId" text not null primary key references "repo" ("id") on delete cascade, "fromUserId" text not null references "user" ("id") on delete cascade, "toUserId" text not null references "user" ("id") on delete cascade, "createdAt" text not null)`,
	`create index if not exists "repo_transfer_to_idx" on "repo_transfer" ("toUserId")`,
	`create table if not exists "ssh_key" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "name" text not null, "type" text not null, "fingerprint" text not null unique, "publicKey" text not null, "createdAt" text not null, "lastUsedAt" text)`,
	`create index if not exists "ssh_key_userId_idx" on "ssh_key" ("userId")`,
	// Issues are numbered per repository; `comments` is kept in step with issue_comment for listing.
	`create table if not exists "issue" ("id" text not null primary key, "repoId" text not null references "repo" ("id") on delete cascade, "number" integer not null, "title" text not null, "body" text not null, "state" text not null check ("state" in ('open', 'closed')), "labels" text not null default '[]', "authorId" text references "user" ("id") on delete set null, "comments" integer not null default 0, "createdAt" text not null, "updatedAt" text not null, "closedAt" text, "closedById" text references "user" ("id") on delete set null, unique ("repoId", "number"))`,
	`create index if not exists "issue_repo_state_idx" on "issue" ("repoId", "state", "number")`,
	`create table if not exists "issue_comment" ("id" text not null primary key, "issueId" text not null references "issue" ("id") on delete cascade, "authorId" text references "user" ("id") on delete set null, "body" text not null, "createdAt" text not null, "updatedAt" text not null)`,
	`create index if not exists "issue_comment_issue_idx" on "issue_comment" ("issueId", "createdAt")`,
	// A pull request is an issue (same numbers, comments, labels) with a base and a head branch.
	`create table if not exists "pull" ("issueId" text not null primary key references "issue" ("id") on delete cascade, "repoId" text not null references "repo" ("id") on delete cascade, "headRepoId" text references "repo" ("id") on delete set null, "headBranch" text not null, "baseBranch" text not null, "mergedAt" text, "mergedById" text references "user" ("id") on delete set null, "mergeCommit" text)`,
	`create table if not exists "review" ("id" text not null primary key, "issueId" text not null references "issue" ("id") on delete cascade, "authorId" text references "user" ("id") on delete set null, "state" text not null check ("state" in ('approved', 'changes_requested', 'commented')), "body" text not null, "commitSha" text, "createdAt" text not null)`,
	`create index if not exists "review_issue_idx" on "review" ("issueId", "createdAt")`,
	`create table if not exists "review_comment" ("id" text not null primary key, "issueId" text not null references "issue" ("id") on delete cascade, "reviewId" text not null references "review" ("id") on delete cascade, "authorId" text references "user" ("id") on delete set null, "path" text not null, "line" integer not null, "side" text not null check ("side" in ('new', 'old')), "body" text not null, "commitSha" text, "createdAt" text not null)`,
	`create index if not exists "review_comment_issue_idx" on "review_comment" ("issueId", "path")`,
	// Organizations are rows in "user" (kind 'org') so repositories, quotas and URLs work the same; nobody signs in as one.
	`create table if not exists "org_member" ("orgId" text not null references "user" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null check ("role" in ('owner', 'member')), "state" text not null check ("state" in ('active', 'invited')), "invitedBy" text, "createdAt" text not null, primary key ("orgId", "userId"))`,
	`create index if not exists "org_member_user_idx" on "org_member" ("userId")`,
	`create table if not exists "team" ("id" text not null primary key, "orgId" text not null references "user" ("id") on delete cascade, "name" text not null collate nocase, "createdAt" text not null, unique ("orgId", "name"))`,
	`create table if not exists "team_member" ("teamId" text not null references "team" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, primary key ("teamId", "userId"))`,
	`create index if not exists "team_member_user_idx" on "team_member" ("userId")`,
	`create table if not exists "team_repo" ("teamId" text not null references "team" ("id") on delete cascade, "repoId" text not null references "repo" ("id") on delete cascade, "permission" text not null check ("permission" in ('read', 'write', 'admin')), primary key ("teamId", "repoId"))`,
	`create index if not exists "team_repo_repo_idx" on "team_repo" ("repoId")`,
	// People a repository's admins invited to it, with read, write or admin access.
	`create table if not exists "repo_collaborator" ("repoId" text not null references "repo" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "permission" text not null check ("permission" in ('read', 'write', 'admin')), "state" text not null check ("state" in ('active', 'invited')), "invitedBy" text, "createdAt" text not null, primary key ("repoId", "userId"))`,
	`create index if not exists "repo_collaborator_user_idx" on "repo_collaborator" ("userId")`,
];

/** Columns added after a table was first created; adding one that exists fails harmlessly. */
const COLUMNS = [
	// Bytes pushed to the repository, which quotas are checked against.
	`alter table "repo" add column "bytes" integer not null default 0`,
	`alter table "repo" add column "forkOf" text references "repo" ("id") on delete set null`,
	// Archived repositories are read-only.
	`alter table "repo" add column "archivedAt" text`,
	// The wiki is on unless an admin turned it off (its pages are kept either way).
	`alter table "repo" add column "hasWiki" integer not null default 1`,
	// The commit whose "fixes #n" closed the issue, when one did.
	`alter table "issue" add column "closedByCommit" text`,
	// Pull requests share the issue table (and its numbers).
	`alter table "issue" add column "isPull" integer not null default 0`,
	// 'user' or 'org'.
	`alter table "user" add column "kind" text not null default 'user'`,
];

/** Indexes on added columns, created once the columns exist. */
const LATE_INDEXES = [`create index if not exists "repo_forkOf_idx" on "repo" ("forkOf")`];

const VERSION_TABLE = `create table if not exists "maggot_schema" ("id" integer not null primary key check ("id" = 1), "version" text not null)`;

export function db(env: Env): D1Database {
	const database = (env as { DB?: D1Database }).DB;
	if (!database) throw new HttpError(500, "MISCONFIGURED", "No DB binding configured");
	return database;
}

export interface SchemaStatements {
	/** Tables and indexes, created idempotently in one batch. */
	tables: string[];
	/** Columns added later; adding one that exists fails harmlessly. */
	columns: string[];
	/** Indexes on added columns, created once the columns exist. */
	lateIndexes: string[];
}

/** How long a request waits on another request's schema check before running one itself. */
const SHARED_CHECK_WAIT_MS = 3_000;

/**
 * An `ensureSchema` for these statements. The database records which schema it has (a fingerprint of
 * the statements), so a deploy that changes any of them runs them once, and every other cold start
 * reads one row instead of rerunning them all (each a D1 write that queues behind everyone else's).
 *
 * Free after the first success in an isolate. Until then concurrent requests share one check, so a
 * deploy doesn't set every cold request running the DDL, but each waits on it only briefly before
 * checking for itself: in Workers, a promise whose I/O belongs to a request that was cancelled
 * meanwhile may never settle, and every request waiting on it would hang with it.
 */
export function schemaEnsurer(statements: SchemaStatements, waitMs = SHARED_CHECK_WAIT_MS): (database: D1Database) => Promise<void> {
	const version = fnv1a([...statements.tables, ...statements.columns, ...statements.lateIndexes].join("\n"));
	const migrated = new WeakSet<D1Database>();
	const inflight = new WeakMap<D1Database, Promise<void>>();

	async function check(database: D1Database): Promise<void> {
		const current = await database
			.prepare(`select "version" from "maggot_schema" where "id" = 1`)
			.first<{ version: string }>()
			.catch(() => null);
		if (current?.version !== version) await migrate(database);
		migrated.add(database);
	}

	async function migrate(database: D1Database): Promise<void> {
		await database.batch([...statements.tables, VERSION_TABLE].map((sql) => database.prepare(sql)));
		await Promise.all(statements.columns.map((sql) => database.prepare(sql).run().catch(ignoreDuplicateColumn)));
		// The version is recorded last, with the late indexes: a migration that fails partway runs again.
		await database.batch([
			...statements.lateIndexes.map((sql) => database.prepare(sql)),
			database.prepare(`insert into "maggot_schema" ("id", "version") values (1, ?) on conflict ("id") do update set "version" = excluded."version"`).bind(version),
		]);
	}

	return async function ensureSchema(database: D1Database): Promise<void> {
		if (migrated.has(database)) return;
		const shared = inflight.get(database);
		if (shared) {
			let timer: ReturnType<typeof setTimeout> | null = null;
			await Promise.race([shared.catch(() => {}), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
			if (timer !== null) clearTimeout(timer);
			if (migrated.has(database)) return;
		}
		const own = check(database);
		if (!inflight.has(database)) {
			inflight.set(database, own);
			own.catch(() => {}).finally(() => {
				if (inflight.get(database) === own) inflight.delete(database);
			});
		}
		await own;
	};
}

/** Creates any missing tables (see schemaEnsurer). */
export const ensureSchema = schemaEnsurer({ tables: [...AUTH_SCHEMA, ...APP_SCHEMA], columns: COLUMNS, lateIndexes: LATE_INDEXES });

/** FNV-1a, as hex: a cheap, stable fingerprint of the schema statements. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
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
	/** The repository this one was forked from; null if it wasn't, or the source was deleted. */
	forkOf: string | null;
	/** When it was archived (made read-only), or null. */
	archivedAt: string | null;
	/** 1 while the wiki is on, 0 once an admin turned it off. */
	hasWiki: number;
	/**
	 * The viewer's access, when the row was read for one: 0 none, 1 read, 2 write, 3 admin (public
	 * visibility aside). See `accessLevel`.
	 */
	level?: number;
}

/** A repository with what lists and its page show: star and fork counts, and the fork's source. */
export interface RepoListing extends RepoRow {
	stars: number;
	forks: number;
	/** Whether the viewer has starred it (0 or 1). */
	starred: number;
	parentOwner: string | null;
	parentName: string | null;
	parentVisibility: Visibility | null;
	parentOwnerId: string | null;
	parentLevel: number;
	openIssues: number;
	openPulls: number;
}

/**
 * GitHub's rule: letters, digits, '.', '-', '_'; not "." or "..", and not ending in ".git" or ".wiki"
 * (`<name>.wiki.git` is the repository's wiki, so no repository may be called `<name>.wiki`).
 */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function assertRepoName(name: string): string {
	if (!REPO_NAME.test(name) || name === "." || name === ".." || /\.(git|wiki)$/i.test(name)) {
		throw new HttpError(400, "INVALID_NAME", "Repository names are 1-100 letters, digits, '.', '-' or '_', and can't end in .git or .wiki.");
	}
	return name;
}

/**
 * A repository by owner and name, following the redirect a rename or transfer left behind when no
 * repository has that name now.
 */
/**
 * A viewer's access to the repository aliased `r` in a query, from ownership, organization membership
 * (owners administer every repository, members read them all), teams and collaborator grants:
 * 0 none, 1 read, 2 write, 3 admin. Public visibility is separate.
 */
export const accessLevel = (r: string, viewer: string) => `max(
	case when ${r}."ownerId" = ${viewer} then 3 else 0 end,
	coalesce((select case m."role" when 'owner' then 3 else 1 end from "org_member" m where m."orgId" = ${r}."ownerId" and m."userId" = ${viewer} and m."state" = 'active'), 0),
	coalesce((select max(case tr."permission" when 'admin' then 3 when 'write' then 2 else 1 end) from "team_repo" tr join "team_member" tm on tm."teamId" = tr."teamId" where tr."repoId" = ${r}."id" and tm."userId" = ${viewer}), 0),
	coalesce((select case k."permission" when 'admin' then 3 when 'write' then 2 else 1 end from "repo_collaborator" k where k."repoId" = ${r}."id" and k."userId" = ${viewer} and k."state" = 'active'), 0)
)`;

/**
 * A repository by owner and name, following the redirect a rename or transfer left behind when no
 * repository has that name now. With `viewerId`, the row carries that viewer's access `level`.
 */
export async function findRepo(database: D1Database, owner: string, name: string, viewerId: string | null = null): Promise<RepoRow | null> {
	const row = await database
		.prepare(
			`select *, ${accessLevel("x", "?3")} as "level" from (
				select r.*, 0 as "redirected" from "repo" r where r."owner" = ?1 and r."name" = ?2
				union all
				select r.*, 1 as "redirected" from "repo_redirect" d join "repo" r on r."id" = d."repoId" where d."owner" = ?1 and d."name" = ?2
			) x order by "redirected" limit 1`,
		)
		.bind(owner.toLowerCase(), name, viewerId ?? "")
		.first<RepoRow & { redirected?: number }>();
	if (row) delete row.redirected;
	return row;
}

/** Renames a repository, keeping the old name as a redirect. */
export async function renameRepo(database: D1Database, row: RepoRow, name: string): Promise<void> {
	const now = new Date().toISOString();
	const statements = [
		database.prepare(`update "repo" set "name" = ? where "id" = ?`).bind(name, row.id),
		// The new name is a real repository now, so an old redirect under it would never be reached.
		database.prepare(`delete from "repo_redirect" where "owner" = ? and "name" = ?`).bind(row.owner, name),
	];
	// A change of case only is the same name.
	if (name.toLowerCase() !== row.name.toLowerCase()) {
		statements.push(database.prepare(`insert or replace into "repo_redirect" ("owner", "name", "repoId", "createdAt") values (?, ?, ?, ?)`).bind(row.owner, row.name, row.id, now));
	}
	try {
		await database.batch(statements);
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", `${row.owner}/${name} already exists`);
		throw err;
	}
}

export async function setArchived(database: D1Database, id: string, archived: boolean): Promise<void> {
	await database.prepare(`update "repo" set "archivedAt" = ? where "id" = ?`).bind(archived ? new Date().toISOString() : null, id).run();
}

// ── Transfers ────────────────────────────────────────────────────────────────

/** How long the recipient has to accept a transfer. */
export const TRANSFER_DAYS = 7;

const TRANSFER = `select t."repoId" as "id", r."owner" || '/' || r."name" as "repo", f."username" as "from", u."username" as "to",
	r."description", r."visibility", t."createdAt", t."fromUserId", t."toUserId"
	from "repo_transfer" t join "repo" r on r."id" = t."repoId" join "user" f on f."id" = t."fromUserId" join "user" u on u."id" = t."toUserId"`;

type TransferRow = Omit<RepoTransfer, "expiresAt"> & { fromUserId: string; toUserId: string };

function toTransfer({ fromUserId: _from, toUserId: _to, ...row }: TransferRow): RepoTransfer {
	return { ...row, expiresAt: new Date(Date.parse(row.createdAt) + TRANSFER_DAYS * 86400_000).toISOString() };
}

const transferLive = () => new Date(Date.now() - TRANSFER_DAYS * 86400_000).toISOString();

/** Offers a repository to another user, replacing any earlier offer for it. */
export async function offerTransfer(database: D1Database, repoId: string, fromUserId: string, toUserId: string): Promise<void> {
	await database.batch([
		// Expired offers are only ever filtered out; clear them away as new ones are made.
		database.prepare(`delete from "repo_transfer" where "createdAt" <= ?`).bind(transferLive()),
		database
			.prepare(`insert or replace into "repo_transfer" ("repoId", "fromUserId", "toUserId", "createdAt") values (?, ?, ?, ?)`)
			.bind(repoId, fromUserId, toUserId, new Date().toISOString()),
	]);
}

/** The live offer for a repository, if there is one. */
export async function getTransfer(database: D1Database, repoId: string): Promise<(RepoTransfer & { fromUserId: string; toUserId: string }) | null> {
	const row = await database.prepare(`${TRANSFER} where t."repoId" = ? and t."createdAt" > ?`).bind(repoId, transferLive()).first<TransferRow>();
	return row ? { ...toTransfer(row), fromUserId: row.fromUserId, toUserId: row.toUserId } : null;
}

/** Live offers made to a user. */
export async function incomingTransfers(database: D1Database, userId: string): Promise<RepoTransfer[]> {
	const { results } = await database
		.prepare(
			`${TRANSFER} where (t."toUserId" = ?1 or t."toUserId" in (select "orgId" from "org_member" where "userId" = ?1 and "role" = 'owner' and "state" = 'active'))
			 and t."createdAt" > ?2 order by t."createdAt" desc`,
		)
		.bind(userId, transferLive())
		.all<TransferRow>();
	return results.map(toTransfer);
}

/** Withdraws the offer for a repository; with `toUserId`, only if it's still the one made to that user (declining). */
export async function cancelTransfer(database: D1Database, repoId: string, toUserId?: string): Promise<boolean> {
	const result = toUserId
		? await database.prepare(`delete from "repo_transfer" where "repoId" = ? and "toUserId" = ?`).bind(repoId, toUserId).run()
		: await database.prepare(`delete from "repo_transfer" where "repoId" = ?`).bind(repoId).run();
	return result.meta.changes > 0;
}

/**
 * Hands a repository to the user a transfer was offered to, if they have room for it (the same
 * count and size quotas as creating one) and it still belongs to whoever offered it. The old
 * owner/name becomes a redirect, and the old owner's notifications about it go.
 */
export async function completeTransfer(
	database: D1Database,
	transfer: { id: string; fromUserId: string; createdAt: string },
	to: { id: string; username: string },
	name: string,
	limits: { maxRepos: number; maxBytes: number },
): Promise<void> {
	const before = await database.prepare(`select * from "repo" where "id" = ?`).bind(transfer.id).first<RepoRow>();
	if (!before || before.ownerId !== transfer.fromUserId) throw new HttpError(409, "TRANSFER_STALE", "That repository has changed hands since the offer was made");
	let changed: number;
	try {
		const result = await database
			.prepare(
				`update "repo" set "ownerId" = ?1, "owner" = ?2, "name" = ?3
				 where "id" = ?4 and "ownerId" = ?5
				 and exists (select 1 from "repo_transfer" where "repoId" = ?4 and "toUserId" = ?1 and "fromUserId" = ?5 and "createdAt" = ?8 and "createdAt" > ?9)
				 and (select count(*) from "repo" where "ownerId" = ?1) < ?6
				 and (select coalesce(sum("bytes"), 0) from "repo" where "ownerId" = ?1) + "bytes" <= ?7`,
			)
			// The exact offer this user saw, still live: a replaced, cancelled or expired one doesn't count.
			.bind(to.id, to.username, name, transfer.id, transfer.fromUserId, limits.maxRepos, limits.maxBytes, transfer.createdAt, transferLive())
			.run();
		changed = result.meta.changes;
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", `You already have a repository called ${name}; pick another name`);
		throw err;
	}
	if (changed === 0) {
		const live = await database
			.prepare(`select 1 from "repo_transfer" where "repoId" = ? and "toUserId" = ? and "createdAt" = ? and "createdAt" > ?`)
			.bind(transfer.id, to.id, transfer.createdAt, transferLive())
			.first();
		if (!live) throw new HttpError(409, "TRANSFER_STALE", "That offer was withdrawn or replaced");
		throw new HttpError(403, "QUOTA_EXCEEDED", "You don't have room for this repository: you're at your repository count or storage quota.");
	}
	const now = new Date().toISOString();
	await database.batch([
		database.prepare(`delete from "repo_redirect" where "owner" = ? and "name" = ?`).bind(to.username, name),
		database.prepare(`insert or replace into "repo_redirect" ("owner", "name", "repoId", "createdAt") values (?, ?, ?, ?)`).bind(before.owner, before.name, before.id, now),
		database.prepare(`delete from "repo_transfer" where "repoId" = ?`).bind(before.id),
		database.prepare(`delete from "notification" where "repoId" = ? and "userId" = ?`).bind(before.id, before.ownerId),
	]);
}

/**
 * Records a new repository, unless its owner already has `maxRepos`. The count and the insert are one
 * statement, so concurrent creates can't both take the last slot.
 */
export async function insertRepo(database: D1Database, row: RepoRow, maxRepos: number, maxBytes: number): Promise<void> {
	let inserted: boolean;
	try {
		const result = await database
			.prepare(
				`insert into "repo" ("id", "ownerId", "owner", "name", "description", "visibility", "defaultBranch", "createdAt", "bytes", "forkOf")
				 select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 where (select count(*) from "repo" where "ownerId" = ?) < ?
				 and (select coalesce(sum("bytes"), 0) from "repo" where "ownerId" = ?) + ? <= ?`,
			)
			.bind(
				row.id, row.ownerId, row.owner, row.name, row.description, row.visibility, row.defaultBranch, row.createdAt, row.bytes, row.forkOf,
				row.ownerId, maxRepos,
				row.ownerId, row.bytes, maxBytes,
			)
			.run();
		inserted = result.meta.changes > 0;
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", `${row.owner}/${row.name} already exists`);
		throw err;
	}
	if (!inserted) {
		throw new HttpError(403, "QUOTA_EXCEEDED", `That would take you past ${maxRepos} repositories or your storage quota. Delete a repository to make room.`);
	}
	// A real repository now has this name, so an old redirect under it is gone for good (it would come
	// back to life if this one were deleted).
	await database.prepare(`delete from "repo_redirect" where "owner" = ? and "name" = ?`).bind(row.owner, row.name).run();
}

/** Sets a repository's recorded size (after an import is measured). */
export async function setRepoBytes(database: D1Database, id: string, bytes: number): Promise<void> {
	await database.prepare(`update "repo" set "bytes" = ? where "id" = ?`).bind(bytes, id).run();
}

export async function updateRepo(database: D1Database, id: string, patch: { visibility?: Visibility; description?: string | null; hasWiki?: boolean; defaultBranch?: string }): Promise<void> {
	if (patch.defaultBranch !== undefined) await database.prepare(`update "repo" set "defaultBranch" = ? where "id" = ?`).bind(patch.defaultBranch, id).run();
	if (patch.hasWiki !== undefined) await database.prepare(`update "repo" set "hasWiki" = ? where "id" = ?`).bind(patch.hasWiki ? 1 : 0, id).run();
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

/** Repository columns plus counts; the one placeholder is the viewer's user id (for `starred`). */
const LISTING = `select r.*, ${accessLevel("r", "?1")} as "level",
	(select count(*) from "star" s where s."repoId" = r."id") as "stars",
	(select count(*) from "repo" f where f."forkOf" = r."id" and (f."visibility" = 'public' or ${accessLevel("f", "?1")} > 0)) as "forks",
	exists (select 1 from "star" s where s."repoId" = r."id" and s."userId" = ?1) as "starred",
	(select count(*) from "issue" i where i."repoId" = r."id" and i."state" = 'open' and i."isPull" = 0) as "openIssues",
	(select count(*) from "issue" i where i."repoId" = r."id" and i."state" = 'open' and i."isPull" = 1) as "openPulls",
	p."owner" as "parentOwner", p."name" as "parentName", p."visibility" as "parentVisibility", p."ownerId" as "parentOwnerId",
	case when p."id" is null then 0 else ${accessLevel("p", "?1")} end as "parentLevel"
	from "repo" r left join "repo" p on p."id" = r."forkOf"`;

export async function getListing(database: D1Database, id: string, viewerId: string | null): Promise<RepoListing | null> {
	return database.prepare(`${LISTING} where r."id" = ?`).bind(viewerId ?? "", id).first<RepoListing>();
}

export interface ListOptions {
	owner?: string;
	viewerId?: string | null;
	/** Only repositories this user id has starred, most recently starred first. */
	starredBy?: string;
	/** Only forks of this repository id. */
	forksOf?: string;
	/** Matches owner, name or description (case-insensitive substring). */
	query?: string;
	sort?: "created" | "stars";
	/** Only public repositories, whatever the viewer can also see. */
	publicOnly?: boolean;
	limit?: number;
}

/** Public repositories plus, when `viewerId` is given, that user's private ones. Newest first unless sorted. */
export async function listRepos(database: D1Database, opts: ListOptions): Promise<RepoListing[]> {
	const where: string[] = [];
	const args: unknown[] = [opts.viewerId ?? ""];
	let join = "";
	if (opts.owner) {
		where.push(`r."owner" = ?`);
		args.push(opts.owner.toLowerCase());
	}
	if (opts.starredBy) {
		join = ` join "star" mine on mine."repoId" = r."id" and mine."userId" = ?`;
		args.splice(1, 0, opts.starredBy);
	}
	if (opts.forksOf) {
		where.push(`r."forkOf" = ?`);
		args.push(opts.forksOf);
	}
	if (opts.query) {
		where.push(`(r."owner" || '/' || r."name" || ' ' || coalesce(r."description", '')) like ? escape '\\'`);
		args.push(`%${opts.query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
	}
	where.push(opts.publicOnly ? `r."visibility" = 'public'` : `(r."visibility" = 'public' or ${accessLevel("r", "?1")} > 0)`);
	const order = opts.starredBy ? `mine."createdAt" desc` : opts.sort === "stars" ? `"stars" desc, r."createdAt" desc` : `r."createdAt" desc`;
	const listing = LISTING.replace(`left join "repo" p`, `${join} left join "repo" p`);
	const { results } = await database
		.prepare(`${listing} where ${where.join(" and ")} order by ${order} limit ?`)
		.bind(...args, opts.limit ?? 100)
		.all<RepoListing>();
	return results;
}

/**
 * `id`'s (?2) fork network as CTEs: `up`, what it was forked from; `root`, where that ends (a repository
 * forked from nothing, or from one since deleted); `down`, every repository forked from the root at any
 * depth. `forkOf` is set once, when a repository is created, so there are no cycles; `union` (not
 * `union all`) ends the walk even if there were, and `root` falls back to `id` then.
 */
const NETWORK = `up("id", "forkOf") as (
	select "id", "forkOf" from "repo" where "id" = ?2
	union select r."id", r."forkOf" from "repo" r join up on r."id" = up."forkOf"
),
root("id") as (select coalesce((select "id" from up where "forkOf" is null or "forkOf" not in (select "id" from "repo") limit 1), ?2)),
down("id") as (
	select "id" from root
	union select r."id" from "repo" r join down on r."forkOf" = down."id"
)`;

/**
 * The root of `id`'s fork network: the repository everything in it was forked from, directly or not.
 * A deleted fork in the middle splits a network, as its forks lose their `forkOf`.
 */
export async function networkRoot(database: D1Database, id: string): Promise<string> {
	const row = await database
		.prepare(`with recursive ${NETWORK} select "id" from root`)
		.bind("", id)
		.first<{ id: string }>();
	return row?.id ?? id;
}

/** Whether two repositories are in the same fork network (so pull requests can go between them). */
export async function sameNetwork(database: D1Database, a: Pick<RepoRow, "id" | "forkOf">, b: Pick<RepoRow, "id" | "forkOf">): Promise<boolean> {
	if (a.id === b.id || a.forkOf === b.id || b.forkOf === a.id) return true;
	const [ra, rb] = await Promise.all([networkRoot(database, a.id), networkRoot(database, b.id)]);
	return ra === rb;
}

/**
 * `owner`'s repositories in `id`'s fork network, `id` included, with `viewerId`'s access `level`: what
 * `owner:branch` can mean. Only ones the viewer may see, unless `everything` (the server's admin key).
 * Lean (no listing counts), as it runs for every `owner:branch`.
 */
export async function ownerInNetwork(database: D1Database, id: string, owner: string, viewerId: string | null, everything = false): Promise<RepoRow[]> {
	const { results } = await database
		.prepare(
			`with recursive ${NETWORK}
			select r.*, ${accessLevel("r", "?1")} as "level" from "repo" r
			where r."id" in (select "id" from down) and r."owner" = ?3${everything ? "" : ` and (r."visibility" = 'public' or ${accessLevel("r", "?1")} > 0)`}
			order by r."createdAt" limit 10`,
		)
		.bind(viewerId ?? "", id, owner.toLowerCase())
		.all<RepoRow>();
	return results;
}

/**
 * The repositories in `id`'s fork network (the root and its forks, forks of forks included) that
 * `viewerId` can see, or all of them when `everything`: where a pull request into `id` can come from.
 * `id` first, then the newest; `query` matches owner/name, for networks too big to list.
 */
export async function listNetwork(
	database: D1Database,
	id: string,
	viewerId: string | null,
	opts: { limit?: number; query?: string; everything?: boolean } = {},
): Promise<RepoListing[]> {
	const where = [`r."id" in (select "id" from down)`];
	if (!opts.everything) where.push(`(r."visibility" = 'public' or ${accessLevel("r", "?1")} > 0)`);
	if (opts.query) where.push(`(r."owner" || '/' || r."name") like ?4 escape '\\'`);
	const { results } = await database
		.prepare(`with recursive ${NETWORK} ${LISTING} where ${where.join(" and ")} order by r."id" = ?2 desc, r."createdAt" desc limit ?3`)
		.bind(viewerId ?? "", id, opts.limit ?? 100, ...(opts.query ? [`%${opts.query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`] : []))
		.all<RepoListing>();
	return results;
}

/** Stars or unstars; returns whether anything changed. */
export async function setStar(database: D1Database, userId: string, repoId: string, starred: boolean): Promise<boolean> {
	const result = starred
		? await database.prepare(`insert or ignore into "star" ("userId", "repoId", "createdAt") values (?, ?, ?)`).bind(userId, repoId, new Date().toISOString()).run()
		: await database.prepare(`delete from "star" where "userId" = ? and "repoId" = ?`).bind(userId, repoId).run();
	return result.meta.changes > 0;
}

export function toRepoInfo(row: RepoRow & Partial<RepoListing>, origin: string, canWrite: boolean, viewerId: string | null = null, canAdmin = false, isOwner = false): RepoInfo {
	// Where a fork came from is shown only to people who can see the source.
	const parentVisible = row.parentOwner && (row.parentVisibility === "public" || (row.parentLevel ?? 0) > 0 || row.parentOwnerId === viewerId);
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
		canAdmin,
		isOwner,
		stars: row.stars ?? 0,
		forks: row.forks ?? 0,
		starred: Boolean(row.starred),
		forkOf: parentVisible ? { owner: row.parentOwner as string, name: row.parentName as string } : null,
		sizeBytes: row.bytes,
		sshUrl: `git@${new URL(origin).hostname}:${row.owner}/${row.name}.git`,
		archivedAt: row.archivedAt ?? null,
		openIssues: row.openIssues ?? 0,
		openPulls: row.openPulls ?? 0,
		hasWiki: row.hasWiki !== 0,
		wikiUrl: `${origin}/${row.owner}/${row.name}.wiki.git`,
	};
}

// ── Notifications ────────────────────────────────────────────────────────────

/** How many notifications a user keeps; older ones are dropped as new ones arrive. */
const KEEP_NOTIFICATIONS = 200;

/** Adds a notification for a user, about one of their repositories. */
export async function notifyUser(
	database: D1Database,
	n: { userId: string; kind: NotificationKind; repoId: string | null; title: string; url: string; actor: string | null },
): Promise<void> {
	// Nobody reads an organization's notifications: its owners get them.
	const org = await database.prepare(`select 1 from "user" where "id" = ? and "kind" = 'org'`).bind(n.userId).first();
	if (org) {
		const { results } = await database.prepare(`select "userId" from "org_member" where "orgId" = ? and "role" = 'owner' and "state" = 'active' limit 20`).bind(n.userId).all<{ userId: string }>();
		await Promise.all(results.map((r) => notifyUser(database, { ...n, userId: r.userId })));
		return;
	}
	await database.batch([
		database
			.prepare(`insert into "notification" ("id", "userId", "kind", "repoId", "title", "url", "actor", "createdAt") values (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(crypto.randomUUID(), n.userId, n.kind, n.repoId, n.title.slice(0, 300), n.url, n.actor, new Date().toISOString()),
		database
			.prepare(
				`delete from "notification" where "userId" = ? and "id" not in (select "id" from "notification" where "userId" = ? order by "createdAt" desc limit ?)`,
			)
			.bind(n.userId, n.userId, KEEP_NOTIFICATIONS),
	]);
}

/** From a repository's coordinator (which knows only the internal id): tells its owner. Admin projects have no owner. */
export async function notify(env: Env, repoId: string, n: { kind: NotificationKind; title: string; path: string }): Promise<void> {
	const database = db(env);
	await ensureSchema(database);
	const repo = await database.prepare(`select "ownerId", "owner", "name" from "repo" where "id" = ?`).bind(repoId).first<{ ownerId: string; owner: string; name: string }>();
	if (!repo) return;
	await notifyUser(database, { userId: repo.ownerId, kind: n.kind, repoId, title: n.title, url: `/${repo.owner}/${repo.name}/${n.path}`, actor: null });
}

/** Whether `actor` already caused this kind of notification about this repository in the last day (star, unstar, star again). */
export async function notifiedRecently(database: D1Database, userId: string, kind: NotificationKind, repoId: string, actor: string): Promise<boolean> {
	const since = new Date(Date.now() - 24 * 3600_000).toISOString();
	const row = await database
		.prepare(`select 1 from "notification" where "userId" = ? and "kind" = ? and "repoId" = ? and "actor" = ? and "createdAt" > ? limit 1`)
		.bind(userId, kind, repoId, actor, since)
		.first();
	return row !== null;
}

export async function listNotifications(database: D1Database, userId: string, unreadOnly: boolean): Promise<{ notifications: Notification[]; unread: number }> {
	const [list, count] = await database.batch<Record<string, unknown>>([
		database
			.prepare(
				`select n."id", n."kind", n."title", n."url", n."actor", n."createdAt", n."readAt", r."owner" || '/' || r."name" as "repo"
				 from "notification" n left join "repo" r on r."id" = n."repoId"
				 where n."userId" = ? ${unreadOnly ? `and n."readAt" is null` : ""} order by n."createdAt" desc limit 100`,
			)
			.bind(userId),
		database.prepare(`select count(*) as "n" from "notification" where "userId" = ? and "readAt" is null`).bind(userId),
	]);
	return { notifications: list.results as unknown as Notification[], unread: Number((count.results[0] as { n: number } | undefined)?.n ?? 0) };
}

/** Marks some (or, with no ids, all) of a user's notifications read. */
export async function markRead(database: D1Database, userId: string, ids?: string[]): Promise<void> {
	const now = new Date().toISOString();
	if (!ids) {
		await database.prepare(`update "notification" set "readAt" = ? where "userId" = ? and "readAt" is null`).bind(now, userId).run();
		return;
	}
	if (ids.length === 0) return;
	await database
		.prepare(`update "notification" set "readAt" = ? where "userId" = ? and "readAt" is null and "id" in (${ids.map(() => "?").join(", ")})`)
		.bind(now, userId, ...ids)
		.run();
}

// ── Personal access tokens ───────────────────────────────────────────────────

export const TOKEN_PREFIX = "maggot_pat_";

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

// ── SSH keys ─────────────────────────────────────────────────────────────────

export const MAX_SSH_KEYS = 50;

export async function listSshKeys(database: D1Database, userId: string): Promise<SshKey[]> {
	const { results } = await database
		.prepare(`select "id", "name", "type", "fingerprint", "createdAt", "lastUsedAt" from "ssh_key" where "userId" = ? order by "createdAt" desc`)
		.bind(userId)
		.all<SshKey>();
	return results;
}

/** Adds a key; one key belongs to one account, since it's how SSH tells who is connecting. */
export async function addSshKey(database: D1Database, userId: string, key: { name: string; type: string; fingerprint: string; publicKey: string }): Promise<SshKey> {
	const info: SshKey = { id: crypto.randomUUID(), name: key.name, type: key.type, fingerprint: key.fingerprint, createdAt: new Date().toISOString(), lastUsedAt: null };
	let inserted: boolean;
	try {
		const result = await database
			.prepare(
				`insert into "ssh_key" ("id", "userId", "name", "type", "fingerprint", "publicKey", "createdAt")
				 select ?, ?, ?, ?, ?, ?, ? where (select count(*) from "ssh_key" where "userId" = ?) < ?`,
			)
			.bind(info.id, userId, info.name, info.type, info.fingerprint, key.publicKey, info.createdAt, userId, MAX_SSH_KEYS)
			.run();
		inserted = result.meta.changes > 0;
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", "That key is already in use on maggot");
		throw err;
	}
	if (!inserted) throw new HttpError(403, "QUOTA_EXCEEDED", `An account can have at most ${MAX_SSH_KEYS} SSH keys`);
	return info;
}

export async function deleteSshKey(database: D1Database, userId: string, id: string): Promise<boolean> {
	const result = await database.prepare(`delete from "ssh_key" where "id" = ? and "userId" = ?`).bind(id, userId).run();
	return result.meta.changes > 0;
}

/** The account a public key (by fingerprint) belongs to, with the key as stored. */
export async function userForSshKey(
	database: D1Database,
	fingerprint: string,
): Promise<{ keyId: string; publicKey: string; lastUsedAt: string | null; id: string; username: string; verified: boolean } | null> {
	const row = await database
		.prepare(
			`select k."id" as "keyId", k."publicKey", k."lastUsedAt", u."id", u."username", u."emailVerified"
			 from "ssh_key" k join "user" u on u."id" = k."userId" where k."fingerprint" = ?`,
		)
		.bind(fingerprint)
		.first<{ keyId: string; publicKey: string; lastUsedAt: string | null; id: string; username: string | null; emailVerified: number }>();
	if (!row?.username) return null;
	return { keyId: row.keyId, publicKey: row.publicKey, lastUsedAt: row.lastUsedAt, id: row.id, username: row.username, verified: Boolean(row.emailVerified) };
}

/** Records that a key was used (at most once a minute). */
export async function touchSshKey(database: D1Database, keyId: string, lastUsedAt: string | null): Promise<void> {
	if (lastUsedAt && Date.parse(lastUsedAt) > Date.now() - 60_000) return;
	await database.prepare(`update "ssh_key" set "lastUsedAt" = ? where "id" = ?`).bind(new Date().toISOString(), keyId).run();
}

// ── Issues ───────────────────────────────────────────────────────────────────

export const MAX_ISSUE_TITLE = 256;
export const MAX_ISSUE_BODY = 64 * 1024;
export const MAX_LABELS = 10;

export interface IssueRow {
	id: string;
	repoId: string;
	number: number;
	title: string;
	body: string;
	state: IssueState;
	labels: string;
	authorId: string | null;
	comments: number;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
	closedById: string | null;
	closedByCommit: string | null;
	author: string | null;
	closedBy: string | null;
}

const ISSUE = `select i.*, a."username" as "author", c."username" as "closedBy" from "issue" i
	left join "user" a on a."id" = i."authorId" left join "user" c on c."id" = i."closedById"`;

/**
 * Open issues or pull requests for someone's home page: everything in repositories they can push to
 * (owner, organization, team or collaborator), and what they opened anywhere they can still read.
 */
export async function listDashboard(database: D1Database, userId: string, pulls: boolean, limit = 20): Promise<DashboardItem[]> {
	const { results } = await database
		.prepare(
			`select * from (
				select i.*, a."username" as "author", r."owner" || '/' || r."name" as "repo", r."visibility" as "repoVisibility", ${accessLevel("r", "?1")} as "level"
				from "issue" i join "repo" r on r."id" = i."repoId" left join "user" a on a."id" = i."authorId"
				where i."state" = 'open' and i."isPull" = ?2
			) x
			where x."level" >= 2 or (x."authorId" = ?1 and (x."repoVisibility" = 'public' or x."level" > 0))
			order by x."updatedAt" desc limit ?3`,
		)
		.bind(userId, pulls ? 1 : 0, limit)
		.all<IssueRow & { repo: string }>();
	return results.map((row) => ({ ...toIssueSummary(row), repo: row.repo }));
}

export function toIssueSummary(row: IssueRow): IssueSummary {
	return {
		number: row.number,
		title: row.title,
		state: row.state,
		labels: JSON.parse(row.labels),
		author: row.author,
		comments: row.comments,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		closedAt: row.closedAt,
	};
}

export function toIssue(row: IssueRow, canEdit: boolean, canLabel: boolean): Issue {
	return { ...toIssueSummary(row), body: row.body, closedBy: row.closedBy, closedByCommit: row.closedByCommit ?? null, canEdit, canLabel };
}

/** Labels as given: trimmed, deduplicated, each up to 50 characters, at most MAX_LABELS. */
export function cleanLabels(labels: unknown): string[] {
	if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) throw new HttpError(400, "INVALID_INPUT", "labels is a list of strings");
	const clean = [...new Set((labels as string[]).map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean))];
	if (clean.length > MAX_LABELS || clean.some((l) => l.length > 50)) throw new HttpError(400, "INVALID_INPUT", `Up to ${MAX_LABELS} labels of up to 50 characters`);
	return clean;
}

/** Opens an issue with the repository's next number. */
export async function createIssue(
	database: D1Database,
	repoId: string,
	authorId: string,
	title: string,
	body: string,
	labels: string[],
	pull?: { headRepoId: string | null; headBranch: string; baseBranch: string },
): Promise<IssueRow> {
	const now = new Date().toISOString();
	// Two issues opened at once can pick the same number; the unique index refuses one, which tries again.
	for (let attempt = 0; ; attempt++) {
		const id = crypto.randomUUID();
		try {
			const insert = database
				.prepare(
					`insert into "issue" ("id", "repoId", "number", "title", "body", "state", "labels", "authorId", "createdAt", "updatedAt", "isPull")
					 select ?1, ?2, coalesce(max("number"), 0) + 1, ?3, ?4, 'open', ?5, ?6, ?7, ?7, ?8 from "issue" where "repoId" = ?2`,
				)
				.bind(id, repoId, title, body, JSON.stringify(labels), authorId, now, pull ? 1 : 0);
			if (pull) {
				await database.batch([
					insert,
					database
						.prepare(`insert into "pull" ("issueId", "repoId", "headRepoId", "headBranch", "baseBranch") values (?, ?, ?, ?, ?)`)
						.bind(id, repoId, pull.headRepoId, pull.headBranch, pull.baseBranch),
				]);
			} else await insert.run();
			return (await database.prepare(`${ISSUE} where i."id" = ?`).bind(id).first<IssueRow>()) as IssueRow;
		} catch (err) {
			if (attempt < 4 && /unique/i.test(String(err))) continue;
			throw err;
		}
	}
}

export async function getIssue(database: D1Database, repoId: string, number: number): Promise<IssueRow | null> {
	return database.prepare(`${ISSUE} where i."repoId" = ? and i."number" = ?`).bind(repoId, number).first<IssueRow>();
}

/** A page of issues, newest first, with the open and closed counts for the same search. */
export async function listIssues(
	database: D1Database,
	repoId: string,
	opts: { state?: IssueState | "all"; query?: string; label?: string; limit?: number },
): Promise<IssueList> {
	const where = [`i."repoId" = ?`, `i."isPull" = 0`];
	const args: unknown[] = [repoId];
	if (opts.query) {
		where.push(`(i."title" || ' ' || i."body") like ? escape '\\'`);
		args.push(`%${opts.query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
	}
	if (opts.label) {
		where.push(`exists (select 1 from json_each(i."labels") where json_each.value = ?)`);
		args.push(opts.label);
	}
	const filter = where.join(" and ");
	const state = opts.state === "closed" || opts.state === "all" ? opts.state : "open";
	const [list, counts] = await database.batch<Record<string, unknown>>([
		database
			.prepare(`${ISSUE} where ${filter}${state === "all" ? "" : ` and i."state" = '${state}'`} order by i."number" desc limit ?`)
			.bind(...args, opts.limit ?? 50),
		database.prepare(`select i."state", count(*) as "n" from "issue" i where ${filter} group by i."state"`).bind(...args),
	]);
	const count = (s: IssueState) => Number((counts.results as { state: string; n: number }[]).find((r) => r.state === s)?.n ?? 0);
	return { issues: (list.results as unknown as IssueRow[]).map(toIssueSummary), open: count("open"), closed: count("closed") };
}

export async function updateIssue(
	database: D1Database,
	row: IssueRow,
	patch: { title?: string; body?: string; state?: IssueState; labels?: string[]; by: string },
): Promise<IssueRow> {
	const now = new Date().toISOString();
	const closing = patch.state === "closed" && row.state === "open";
	const reopening = patch.state === "open" && row.state === "closed";
	await database
		.prepare(
			`update "issue" set "title" = ?, "body" = ?, "state" = ?, "labels" = ?, "updatedAt" = ?, "closedAt" = ?, "closedById" = ?, "closedByCommit" = ? where "id" = ?`,
		)
		.bind(
			patch.title ?? row.title,
			patch.body ?? row.body,
			patch.state ?? row.state,
			patch.labels ? JSON.stringify(patch.labels) : row.labels,
			now,
			closing ? now : reopening ? null : row.closedAt,
			closing ? patch.by : reopening ? null : row.closedById,
			closing || reopening ? null : (row.closedByCommit ?? null),
			row.id,
		)
		.run();
	return (await database.prepare(`${ISSUE} where i."id" = ?`).bind(row.id).first<IssueRow>()) as IssueRow;
}

interface CommentRow {
	id: string;
	issueId: string;
	authorId: string | null;
	author: string | null;
	body: string;
	createdAt: string;
	updatedAt: string;
}

const COMMENT = `select k.*, u."username" as "author" from "issue_comment" k left join "user" u on u."id" = k."authorId"`;

export const COMMENT_PAGE = 100;

/**
 * The newest page of an issue's comments (or the page before comment `before`), oldest first, and
 * whether there are earlier ones.
 */
export async function listComments(
	database: D1Database,
	issueId: string,
	viewer: { id: string | null; owner: boolean },
	before?: string,
): Promise<{ comments: IssueComment[]; earlier: boolean }> {
	const cursor = before ? await database.prepare(`select "createdAt", "id" from "issue_comment" where "id" = ? and "issueId" = ?`).bind(before, issueId).first<{ createdAt: string; id: string }>() : null;
	if (before && !cursor) throw new HttpError(404, "NOT_FOUND", "No such comment");
	const { results } = await database
		.prepare(
			`${COMMENT} where k."issueId" = ?1 ${cursor ? `and (k."createdAt" < ?2 or (k."createdAt" = ?2 and k."id" < ?3))` : ""}
			 order by k."createdAt" desc, k."id" desc limit ${COMMENT_PAGE + 1}`,
		)
		.bind(issueId, ...(cursor ? [cursor.createdAt, cursor.id] : []))
		.all<CommentRow>();
	const page = results.slice(0, COMMENT_PAGE).reverse();
	return { comments: page.map((r) => toComment(r, viewer)), earlier: results.length > COMMENT_PAGE };
}

function toComment(r: CommentRow, viewer: { id: string | null; owner: boolean }): IssueComment {
	return { id: r.id, author: r.author, body: r.body, createdAt: r.createdAt, updatedAt: r.updatedAt, canEdit: viewer.owner || (viewer.id !== null && viewer.id === r.authorId) };
}

export async function getComment(database: D1Database, issueId: string, id: string): Promise<CommentRow | null> {
	return database.prepare(`${COMMENT} where k."issueId" = ? and k."id" = ?`).bind(issueId, id).first<CommentRow>();
}

export const MAX_COMMENTS = 2_000;

export async function addComment(database: D1Database, issue: IssueRow, authorId: string, body: string, viewer: { id: string; owner: boolean }): Promise<IssueComment> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const [inserted] = await database.batch([
		database
			.prepare(
				`insert into "issue_comment" ("id", "issueId", "authorId", "body", "createdAt", "updatedAt")
				 select ?, ?, ?, ?, ?, ? where (select "comments" from "issue" where "id" = ?) < ?`,
			)
			.bind(id, issue.id, authorId, body, now, now, issue.id, MAX_COMMENTS),
		database.prepare(`update "issue" set "comments" = (select count(*) from "issue_comment" where "issueId" = ?1), "updatedAt" = ?2 where "id" = ?1`).bind(issue.id, now),
	]);
	if (inserted.meta.changes === 0) throw new HttpError(403, "QUOTA_EXCEEDED", `An issue can have at most ${MAX_COMMENTS} comments`);
	return toComment((await getComment(database, issue.id, id)) as CommentRow, viewer);
}

export async function editComment(database: D1Database, comment: CommentRow, body: string, viewer: { id: string; owner: boolean }): Promise<IssueComment> {
	const now = new Date().toISOString();
	await database.prepare(`update "issue_comment" set "body" = ?, "updatedAt" = ? where "id" = ?`).bind(body, now, comment.id).run();
	return toComment({ ...comment, body, updatedAt: now }, viewer);
}

export async function deleteComment(database: D1Database, issueId: string, id: string): Promise<void> {
	await database.batch([
		database.prepare(`delete from "issue_comment" where "id" = ? and "issueId" = ?`).bind(id, issueId),
		database.prepare(`update "issue" set "comments" = (select count(*) from "issue_comment" where "issueId" = ?1) where "id" = ?1`).bind(issueId),
	]);
}

/** Who to tell about activity on an issue: its author and everyone who commented. */
export async function issueParticipants(database: D1Database, issueId: string): Promise<string[]> {
	const { results } = await database
		.prepare(
			`select "authorId" from "issue" where "id" = ?1 and "authorId" is not null
			 union select "authorId" from "issue_comment" where "issueId" = ?1 and "authorId" is not null limit 50`,
		)
		.bind(issueId)
		.all<{ authorId: string }>();
	return results.map((r) => r.authorId);
}

/** Closes open issues named by commits that landed on the default branch ("fixes #12"). Returns the ones it closed. */
export async function closeIssuesByCommits(
	env: Env,
	repoId: string,
	refs: [number, string][],
): Promise<{ number: number; title: string; authorId: string | null; commit: string; owner: string; name: string }[]> {
	const database = db(env);
	await ensureSchema(database);
	const repo = await database.prepare(`select "owner", "name" from "repo" where "id" = ?`).bind(repoId).first<{ owner: string; name: string }>();
	if (!repo) return [];
	const now = new Date().toISOString();
	const results = await database.batch<{ number: number; title: string; authorId: string | null }>(
		refs.map(([number, commit]) =>
			database
				.prepare(
					`update "issue" set "state" = 'closed', "closedAt" = ?, "closedById" = null, "closedByCommit" = ?, "updatedAt" = ?
					 where "repoId" = ? and "number" = ? and "state" = 'open' and "isPull" = 0 returning "number", "title", "authorId"`,
				)
				.bind(now, commit, now, repoId, number),
		),
	);
	return results.flatMap((r, i) => r.results.map((row) => ({ ...row, commit: refs[i][1], ...repo })));
}

// ── Pull requests and reviews ────────────────────────────────────────────────

export interface PullRow extends IssueRow {
	headRepoId: string | null;
	headBranch: string;
	baseBranch: string;
	mergedAt: string | null;
	mergedById: string | null;
	mergeCommit: string | null;
	mergedBy: string | null;
	headOwner: string | null;
	headName: string | null;
	headVisibility: Visibility | null;
	decision: "approved" | "changes_requested" | null;
}

/**
 * Each reviewer's latest approval or request for changes counts, from people who could merge (write
 * access or more). Changes requested by anyone counting outweighs approvals.
 */
const DECISION = `(select case
		when exists (select 1 from "review" v where v."issueId" = i."id" and v."state" = 'changes_requested' and ${accessLevel("r", 'v."authorId"')} >= 2
			and not exists (select 1 from "review" w where w."issueId" = i."id" and w."authorId" = v."authorId" and w."state" <> 'commented' and w."createdAt" > v."createdAt")) then 'changes_requested'
		when exists (select 1 from "review" v where v."issueId" = i."id" and v."state" = 'approved' and ${accessLevel("r", 'v."authorId"')} >= 2
			and not exists (select 1 from "review" w where w."issueId" = i."id" and w."authorId" = v."authorId" and w."state" <> 'commented' and w."createdAt" > v."createdAt")) then 'approved'
	end)`;

const PULL = `select i.*, a."username" as "author", c."username" as "closedBy", p."headRepoId", p."headBranch", p."baseBranch", p."mergedAt", p."mergedById", p."mergeCommit",
	m."username" as "mergedBy", h."owner" as "headOwner", h."name" as "headName", h."visibility" as "headVisibility", ${DECISION} as "decision"
	from "issue" i join "pull" p on p."issueId" = i."id" join "repo" r on r."id" = i."repoId"
	left join "user" a on a."id" = i."authorId" left join "user" c on c."id" = i."closedById" left join "user" m on m."id" = p."mergedById"
	left join "repo" h on h."id" = p."headRepoId"`;

/** Who sees pull requests: a user's id, or null; `everything` for the server's admin key. */
export interface PullViewer {
	viewerId: string | null;
	everything?: boolean;
}

/**
 * The private forks among `rows`' heads that the viewer can't read. Their names and branches are
 * hidden: a pull request into a repository you can read doesn't tell you what's in one you can't.
 */
export async function hiddenHeads(database: D1Database, rows: PullRow[], viewer: PullViewer): Promise<Set<string>> {
	return unreadableRepos(database, rows.filter((r) => r.headRepoId && r.headRepoId !== r.repoId && r.headVisibility !== "public").map((r) => r.headRepoId as string), viewer);
}

/**
 * Which of these repository ids the viewer can't read: private ones they have no access to, and ones
 * since deleted (nobody can say any more who could). `{ viewerId: null }` is nobody in particular, as
 * for webhooks: every private repository is hidden then.
 */
export async function unreadableRepos(database: D1Database, ids: string[], viewer: PullViewer): Promise<Set<string>> {
	const unique = [...new Set(ids)];
	if (viewer.everything || unique.length === 0) return new Set();
	const readable = new Set<string>();
	// D1 permits at most 100 bound parameters per query.
	for (let offset = 0; offset < unique.length; offset += 90) {
		const batch = unique.slice(offset, offset + 90);
		const { results } = await database
			.prepare(`select r."id" from "repo" r where r."id" in (${batch.map((_, i) => `?${i + 2}`).join(", ")}) and (r."visibility" = 'public' or ${accessLevel("r", "?1")} > 0)`)
			.bind(viewer.viewerId ?? "", ...batch)
			.all<{ id: string }>();
		for (const row of results) readable.add(row.id);
	}
	return new Set(unique.filter((id) => !readable.has(id)));
}

export function toPullSummary(row: PullRow, hidden?: Set<string>): PullSummary {
	const secret = row.headRepoId !== null && Boolean(hidden?.has(row.headRepoId));
	return {
		...toIssueSummary(row),
		pullState: row.mergedAt ? "merged" : row.state,
		base: row.baseBranch,
		head: secret ? "" : row.headBranch,
		headRepo: row.headRepoId !== row.repoId ? (secret ? "(private fork)" : row.headOwner ? `${row.headOwner}/${row.headName}` : "(deleted fork)") : null,
		decision: row.decision,
	};
}

export function toPull(row: PullRow, can: { edit: boolean; label: boolean; merge: boolean }, required: { review: boolean; checks: boolean }, hidden?: Set<string>): Pull {
	return {
		...toPullSummary(row, hidden),
		body: row.body,
		closedBy: row.closedBy,
		mergedAt: row.mergedAt,
		mergedBy: row.mergedBy,
		mergeCommit: row.mergeCommit,
		canEdit: can.edit,
		canLabel: can.label,
		canMerge: can.merge,
		reviewRequired: required.review,
		checksRequired: required.checks,
	};
}

export async function getPull(database: D1Database, repoId: string, number: number): Promise<PullRow | null> {
	return database.prepare(`${PULL} where i."repoId" = ? and i."number" = ?`).bind(repoId, number).first<PullRow>();
}

/** Pull requests newest first: open, closed (merged or not) or all, with the counts. */
export async function listPulls(database: D1Database, repoId: string, viewer: PullViewer, opts: { state?: "open" | "closed" | "all"; query?: string; limit?: number }): Promise<PullList> {
	const where = [`i."repoId" = ?`];
	const args: unknown[] = [repoId];
	if (opts.query) {
		where.push(`(i."title" || ' ' || i."body") like ? escape '\\'`);
		args.push(`%${opts.query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
	}
	const filter = where.join(" and ");
	const state = opts.state === "closed" || opts.state === "all" ? opts.state : "open";
	const [list, counts] = await database.batch<Record<string, unknown>>([
		database.prepare(`${PULL} where ${filter}${state === "all" ? "" : ` and i."state" = '${state}'`} order by i."number" desc limit ?`).bind(...args, opts.limit ?? 50),
		database.prepare(`select i."state", count(*) as "n" from "issue" i where ${filter} and i."isPull" = 1 group by i."state"`).bind(...args),
	]);
	const count = (s: IssueState) => Number((counts.results as { state: string; n: number }[]).find((r) => r.state === s)?.n ?? 0);
	const rows = list.results as unknown as PullRow[];
	const hidden = await hiddenHeads(database, rows, viewer);
	return { pulls: rows.map((r) => toPullSummary(r, hidden)), open: count("open"), closed: count("closed") };
}

/** Records a merge: the pull request is closed and marked merged by `userId` at `commit`. */
export async function markPullMerged(database: D1Database, pull: PullRow, userId: string, commit: string): Promise<void> {
	const now = new Date().toISOString();
	await database.batch([
		database
			.prepare(`update "issue" set "state" = 'closed', "closedAt" = ?, "closedById" = ?, "updatedAt" = ? where "id" = ?`)
			.bind(now, userId, now, pull.id),
		database.prepare(`update "pull" set "mergedAt" = ?, "mergedById" = ?, "mergeCommit" = ? where "issueId" = ?`).bind(now, userId, commit, pull.id),
	]);
}

/**
 * Whether someone who can merge approved `head` itself and hasn't changed their mind since: approvals
 * of earlier commits don't count once the branch moves on.
 */
export async function approvedAt(database: D1Database, pull: PullRow, head: string): Promise<boolean> {
	const row = await database
		.prepare(
			`select 1 from "review" v join "issue" i on i."id" = v."issueId" join "repo" r on r."id" = i."repoId"
			where v."issueId" = ? and v."state" = 'approved' and v."commitSha" = ? and ${accessLevel("r", 'v."authorId"')} >= 2
			and not exists (select 1 from "review" w where w."issueId" = v."issueId" and w."authorId" = v."authorId" and w."state" <> 'commented' and w."createdAt" > v."createdAt")
			limit 1`,
		)
		.bind(pull.id, head)
		.first();
	return row !== null;
}

export const MAX_REVIEW_COMMENTS = 100;

export async function addReview(
	database: D1Database,
	pull: PullRow,
	authorId: string,
	review: { state: ReviewState; body: string; commit: string | null; comments: { path: string; line: number; side: "new" | "old"; body: string }[] },
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await database.batch([
		database
			.prepare(`insert into "review" ("id", "issueId", "authorId", "state", "body", "commitSha", "createdAt") values (?, ?, ?, ?, ?, ?, ?)`)
			.bind(id, pull.id, authorId, review.state, review.body, review.commit, now),
		...review.comments.map((c) =>
			database
				.prepare(
					`insert into "review_comment" ("id", "issueId", "reviewId", "authorId", "path", "line", "side", "body", "commitSha", "createdAt") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(crypto.randomUUID(), pull.id, id, authorId, c.path, c.line, c.side, c.body, review.commit, now),
		),
		database.prepare(`update "issue" set "updatedAt" = ? where "id" = ?`).bind(now, pull.id),
	]);
	return id;
}

export async function listReviews(database: D1Database, issueId: string): Promise<{ reviews: Review[]; comments: ReviewComment[] }> {
	const [reviews, comments] = await database.batch<Record<string, unknown>>([
		database
			.prepare(`select v."id", u."username" as "author", v."state", v."body", v."commitSha" as "commit", v."createdAt" from "review" v left join "user" u on u."id" = v."authorId" where v."issueId" = ? order by v."createdAt" limit 500`)
			.bind(issueId),
		database
			.prepare(
				`select k."id", k."reviewId", u."username" as "author", k."path", k."line", k."side", k."body", k."commitSha" as "commit", k."createdAt"
				 from "review_comment" k left join "user" u on u."id" = k."authorId" where k."issueId" = ? order by k."createdAt" limit 2000`,
			)
			.bind(issueId),
	]);
	return { reviews: reviews.results as unknown as Review[], comments: comments.results as unknown as ReviewComment[] };
}
