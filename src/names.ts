import { HttpError } from "./errors.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/** The first segment of each of the app's own pages (test/names.test.ts checks this against app/routes). */
export const ROUTE_NAMES: ReadonlySet<string> = new Set([
	"explore", "forgot-password", "login", "new", "notifications", "orgs", "parity", "reset-password", "search", "settings", "signup",
	"transfers", "verify-email",
]);

/**
 * Usernames and organization names become the first URL segment, so none may be a page's, the Worker's
 * own paths, or one kept for pages people expect (GitHub's, mostly).
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
	...ROUTE_NAMES,
	"api", "assets", "static", "public", "_build", "_serverfn", "_ssh", "ssh-proxy", "favicon.svg", "robots.txt", "sitemap.xml",
	"about", "account", "admin", "administrator", "blog", "dashboard", "docs", "features", "help", "home", "invitations", "issues",
	"join", "logout", "marketplace", "maggot", "organizations", "p", "pricing", "privacy", "pulls", "root", "security", "sessions",
	"signin", "signout", "site", "ssh", "stars", "status", "support", "system", "terms", "topics", "trending", "user", "users", "www",
]);

/** Whether `name` (any case) is a page's first URL segment. Some were reserved only when their page was added; production had no account with any of them on 2026-10-15. */
export function routeName(name: string): boolean {
	return ROUTE_NAMES.has(name.toLowerCase());
}

/** Whether `name` (any case) can't be taken by a new account or organization. */
export function reservedName(name: string): boolean {
	return RESERVED_NAMES.has(name.toLowerCase());
}

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

/**
 * A username's shape, which organization names share: lowercase letters, digits and single hyphens.
 * Better Auth checks sign-ins with it too, so it leaves out the reserved names: reserving one more
 * mustn't lock out an account that already has it.
 */
export function usernameShape(name: string): boolean {
	return USERNAME.test(name) && !name.includes("--");
}

/** A name a new account or organization may take. */
export function validUsername(name: string): boolean {
	return usernameShape(name) && !reservedName(name);
}

export function assertProjectName(name: string): string {
	if (!NAME.test(name) || name.includes("--")) {
		throw new HttpError(
			400,
			"INVALID_NAME",
			"Project names are 2-40 chars of lowercase letters, digits, '-' and '_', must start with a letter or digit, and may not contain '--'.",
		);
	}
	return name;
}

export function newTaskId(): string {
	return `t${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

/**
 * Artifacts repo name for a task fork. `--` never appears in project names, so it is unambiguous.
 * Retried fork attempts get a suffix because a failed attempt can leave its name unusable.
 */
export function forkRepoName(project: string, taskId: string, attempt = 1): string {
	return attempt > 1 ? `${project}--${taskId}-${attempt}` : `${project}--${taskId}`;
}

export function isForkRepoName(repo: string): boolean {
	return repo.includes("--");
}

export function normalizeClaim(path: string): string {
	return path.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

/** Two claims overlap when one is the other or a directory prefix of it. An empty claim set claims nothing. */
export function claimsOverlap(a: string[], b: string[]): boolean {
	return a.some((x) =>
		b.some((y) => x === y || x === "" || y === "" || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)),
	);
}

/**
 * Artifacts repo name for a repository's wiki. Like task forks it uses `--`, which never appears in
 * project names; task ids start with "t", so it can't be a fork's name either.
 */
export function wikiRepoName(project: string): string {
	return `${project}--wiki`;
}
