// Git's branch name rules (`git check-ref-format --branch`), for names that come from outside: forms,
// API calls and the HEAD of a repository being imported.

/** Longest branch name accepted, in UTF-8 bytes. Git has no limit of its own; storage and URLs do. */
export const MAX_BRANCH_BYTES = 200;

/** Whether `git check-ref-format --branch` would accept `name` (and it fits in MAX_BRANCH_BYTES). */
export function isGitBranchName(name: string): boolean {
	if (name === "" || new TextEncoder().encode(name).length > MAX_BRANCH_BYTES) return false;
	// `--branch` refuses these: `-x` reads as an option, `HEAD` and `@` as the symbolic ref.
	if (name.startsWith("-") || name === "HEAD" || name === "@") return false;
	// Control characters (DEL included), space, and the characters revision syntax uses.
	if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
	if (name.includes("..") || name.includes("@{")) return false;
	// Unpaired surrogates aren't text and can't be encoded in a ref.
	if (/\p{Cs}/u.test(name)) return false;
	if (name.endsWith(".")) return false;
	// Covers a leading or trailing `/` and `//`, which leave an empty component.
	return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}
