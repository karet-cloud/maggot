// What GitHub does and how far megit is with it. The /parity page renders this; update it in the same
// commit as the feature it describes.

export type ParityStatus = "done" | "partial" | "missing" | "different";

export interface ParityItem {
	feature: string;
	status: ParityStatus;
	/** Where megit stands: what works, what's left, or why it differs. */
	comment: string;
}

export interface ParitySection {
	title: string;
	items: ParityItem[];
}

export const PARITY_UPDATED = "2026-10-13";

export const PARITY: ParitySection[] = [
	{
		title: "Repositories and Git",
		items: [
			{ feature: "Create a repository", status: "done", comment: "Empty, with a README, or imported from a public Git URL. The default branch is master unless you choose another." },
			{ feature: "Public and private repositories", status: "done", comment: "Private repositories answer 404 to anyone but the owner, on the web, the API and git." },
			{ feature: "git clone, fetch and push over HTTPS", status: "done", comment: "At /<owner>/<repo>.git with a personal access token as the password. The Worker proxies smart HTTP to Cloudflare Artifacts." },
			{ feature: "Git over SSH", status: "done", comment: "git@host:owner/repo.git with an SSH key. Workers can't listen on port 22, so ssh connects through a one-line ProxyCommand over a WebSocket; it's real SSH end to end, with post-quantum key exchange." },
			{ feature: "Git LFS", status: "missing", comment: "Planned: large files in R2 behind the LFS batch API." },
			{ feature: "Import from another host", status: "done", comment: "Public URLs only; the import is measured against your storage quota." },
			{ feature: "Rename or transfer a repository", status: "done", comment: "Old names keep redirecting, for the web, the API and git. Transfers wait for the new owner to accept, within a week, and count against their quota." },
			{ feature: "Archive a repository (read-only)", status: "done", comment: "Pushes, web edits, branch deletes and agent tasks are refused; cloning, forking and starring still work." },
			{ feature: "Template repositories", status: "missing", comment: "" },
			{ feature: "Delete a repository", status: "done", comment: "From Settings, with the name typed to confirm." },
			{ feature: "Size limits", status: "done", comment: "Per push, per repository and per account; git prints why a push is refused." },
		],
	},
	{
		title: "Browsing code",
		items: [
			{ feature: "File tree and file view", status: "done", comment: "Any branch, commit or agent fork." },
			{ feature: "Syntax highlighting", status: "done", comment: "26 languages. Files over 256 KB are shown without highlighting." },
			{ feature: "README rendering", status: "done", comment: "GitHub-flavoured Markdown, sanitized like GitHub, with heading anchors and relative links." },
			{ feature: "Line links and permalinks", status: "done", comment: "#L10-L20 ranges; Permalink pins the link to the commit." },
			{ feature: "Raw files and downloads", status: "done", comment: "Served sandboxed, so repository HTML can't run as a page." },
			{ feature: "Download as .zip or .tar.gz", status: "done", comment: "Streamed. Capped at 20,000 files and 256 MB." },
			{ feature: "Blame", status: "missing", comment: "" },
			{ feature: "File history", status: "missing", comment: "" },
			{ feature: "Go to file", status: "done", comment: "Press t on the code page: fuzzy search over every path, ranked like GitHub's file finder." },
			{ feature: "Code search in a repository", status: "done", comment: "The default branch, in an FTS5 trigram index updated on every change. Any substring of 3+ characters." },
			{ feature: "Code search across all repositories", status: "missing", comment: "Repository search covers names and descriptions only." },
		],
	},
	{
		title: "History, branches and tags",
		items: [
			{ feature: "Commit history", status: "partial", comment: "First-parent history of the default branch. No per-branch history page yet." },
			{ feature: "Commit page with diff", status: "done", comment: "Unified or split." },
			{ feature: "Compare branches", status: "done", comment: "Commits and diff since the merge base." },
			{ feature: "Branches page", status: "done", comment: "Ahead and behind counts, and delete." },
			{ feature: "Tags and releases", status: "missing", comment: "Tags are stored, but not listed or released." },
			{ feature: "Commit graph", status: "missing", comment: "" },
			{ feature: "Branch protection rules", status: "missing", comment: "The owner is the only writer today." },
			{ feature: "Verified (signed) commit badges", status: "missing", comment: "" },
		],
	},
	{
		title: "Collaboration",
		items: [
			{ feature: "Pull requests", status: "partial", comment: "Agents land work through tasks and a merge queue. Pull requests between people are next." },
			{ feature: "Code review", status: "missing", comment: "Line comments, approvals and requested changes; comes after pull requests." },
			{ feature: "Issues", status: "missing", comment: "" },
			{ feature: "Discussions", status: "missing", comment: "" },
			{ feature: "Collaborators with write access", status: "missing", comment: "One owner per repository for now." },
			{ feature: "Organizations and teams", status: "missing", comment: "" },
			{ feature: "Forks", status: "done", comment: "Every branch and tag. A fork of a private repository stays private." },
			{ feature: "Stars", status: "done", comment: "Counts everywhere, and a Stars tab on profiles." },
			{ feature: "Watching repositories", status: "missing", comment: "Notifications cover your own repositories only." },
			{ feature: "@mentions", status: "missing", comment: "" },
		],
	},
	{
		title: "Editing on the web",
		items: [
			{ feature: "Edit a file", status: "done", comment: "Refused if the branch moved since the editor opened. CRLF files stay CRLF." },
			{ feature: "Create and delete files", status: "done", comment: "" },
			{ feature: "Rename and move files", status: "done", comment: "Keeps the file's mode, and won't overwrite another file." },
			{ feature: "Commit to a new branch", status: "done", comment: "" },
			{ feature: "Upload files", status: "missing", comment: "Text up to 1 MB only; binary files go through git." },
		],
	},
	{
		title: "Automation and integrations",
		items: [
			{ feature: "Webhooks", status: "done", comment: "Push, merge and task events. HMAC-signed, retried for about nine hours, with a delivery log and redeliver." },
			{ feature: "Actions / built-in CI", status: "missing", comment: "Planned: tests in Cloudflare Sandbox or Containers." },
			{ feature: "Commit status checks API", status: "missing", comment: "For external CI to report into, and to gate merges." },
			{ feature: "REST API", status: "partial", comment: "Everything the UI does goes through /api. No API reference page yet." },
			{ feature: "GraphQL API", status: "missing", comment: "" },
			{ feature: "Deploy keys", status: "missing", comment: "" },
			{ feature: "OAuth and GitHub-style apps", status: "missing", comment: "" },
		],
	},
	{
		title: "Accounts and security",
		items: [
			{ feature: "Sign up and sign in", status: "done", comment: "Username, email and password (Better Auth)." },
			{ feature: "Email verification", status: "done", comment: "Required to create repositories or push whenever the server can send email." },
			{ feature: "Password reset and change", status: "done", comment: "Emails need a sending domain; without one, an admin can issue the link." },
			{ feature: "Personal access tokens", status: "partial", comment: "Full access to your account. No scopes or expiry yet." },
			{ feature: "Two-factor authentication", status: "missing", comment: "Better Auth has a plugin for it." },
			{ feature: "Sign in with GitHub or Google", status: "missing", comment: "" },
			{ feature: "SSH keys", status: "done", comment: "Ed25519, ECDSA and RSA (SHA-2 signatures) keys, with fingerprints and last-used times." },
			{ feature: "Change username", status: "different", comment: "Deliberately locked, because repository URLs are built from it." },
			{ feature: "Delete account", status: "missing", comment: "" },
			{ feature: "Avatars and profile details", status: "missing", comment: "Profiles list repositories and stars only." },
			{ feature: "Rate limits and abuse protection", status: "done", comment: "Sign-ups, sign-ins, emails, the API, git and search are limited. Quotas on repository count and size." },
		],
	},
	{
		title: "Notifications and discovery",
		items: [
			{ feature: "In-app notifications", status: "done", comment: "Stars, forks, agent task results and failing webhooks." },
			{ feature: "Email notifications", status: "missing", comment: "" },
			{ feature: "Repository search", status: "done", comment: "By owner, name or description; newest or most starred first." },
			{ feature: "Explore page", status: "partial", comment: "The home page lists the newest public repositories. No trending." },
			{ feature: "Follow people", status: "missing", comment: "" },
			{ feature: "Activity feed", status: "partial", comment: "Live per repository. No personal dashboard feed." },
			{ feature: "Works on phones", status: "partial", comment: "Usable; some wide tables still need horizontal scrolling." },
		],
	},
	{
		title: "Beyond GitHub: agents",
		items: [
			{ feature: "Many agents on one repository", status: "done", comment: "Each task gets its own fork, so agents never push to the same branch." },
			{ feature: "Merge queue for agent work", status: "done", comment: "One at a time, with conflict detection that names the tasks it collided with." },
			{ feature: "Path claims and overlap warnings", status: "done", comment: "" },
			{ feature: "Live board of agent tasks", status: "done", comment: "Updated over a WebSocket." },
		],
	},
];
