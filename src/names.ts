import { HttpError } from "./errors.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{1,39}$/;

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
