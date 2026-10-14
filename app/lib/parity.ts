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

export const PARITY_UPDATED = "2026-10-14";

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
			{ feature: "Blame", status: "done", comment: "On any file: each run of lines with the commit that last changed it, shaded by age. Follows the first-parent history; files up to 512 KB." },
			{ feature: "File history", status: "done", comment: "History on any file lists the commits that changed it, paging further back on request. Doesn't follow renames yet." },
			{ feature: "Go to file", status: "done", comment: "Press t on the code page: fuzzy search over every path, ranked like GitHub's file finder." },
			{ feature: "Code search in a repository", status: "done", comment: "The default branch, in an FTS5 trigram index updated on every change. Any substring of 3+ characters." },
			{ feature: "Code search across all repositories", status: "missing", comment: "Repository search covers names and descriptions only." },
		],
	},
	{
		title: "History, branches and tags",
		items: [
			{ feature: "Commit history", status: "done", comment: "Per branch, tag or agent fork, plus a graph of every branch." },
			{ feature: "Commit page with diff", status: "done", comment: "Unified or split." },
			{ feature: "Compare branches", status: "done", comment: "Commits and diff since the merge base." },
			{ feature: "Branches page", status: "done", comment: "Ahead and behind counts, and delete." },
			{ feature: "Tags and releases", status: "done", comment: "Tags from git or the web; releases with Markdown notes, pre-releases and source downloads. No uploaded release files yet." },
			{ feature: "Commit graph", status: "done", comment: "History → Graph: recent commits across every branch in lanes, with branch and tag labels." },
			{ feature: "Branch protection rules", status: "done", comment: "Per branch or pattern: block force pushes (put back if one lands), block deletion, only the merge queue, or only reviewed pull requests (an approval of the head commit). Enforced for HTTPS, SSH and the web. Can require megit Actions runs on the head commit to pass (pull requests only, then). No statuses from external CI yet." },
			{ feature: "Verified (signed) commit badges", status: "missing", comment: "" },
		],
	},
	{
		title: "Collaboration",
		items: [
			{ feature: "Pull requests", status: "done", comment: "From a branch or a fork, with conversation, commits and files tabs; merge commit or squash; conflicts named; \"fixes #n\" closes issues. Agents also land work through the merge queue." },
			{ feature: "Code review", status: "done", comment: "Line comments gathered into a review, then comment, approve or request changes. A branch rule can require an approval from someone who can merge. No suggested changes or threaded replies yet." },
			{ feature: "Issues", status: "done", comment: "Markdown, comments, labels, close and reopen, search, notifications, webhooks, and \"fixes #n\" closing on the default branch. No assignees or milestones yet." },
			{
				feature: "Wiki",
				status: "done",
				comment:
					"Markdown pages in a repository of their own, edited on the web (with preview, history, rename and delete; stale edits refused) or cloned and pushed at <repo>.wiki.git over HTTPS and SSH. [[Page]] links, _Sidebar and _Footer, gollum webhooks, and a switch in Settings. Markdown only (GitHub also renders other markups), and no wiki search yet.",
			},
			{ feature: "Discussions", status: "missing", comment: "" },
			{ feature: "Collaborators with write access", status: "done", comment: "Invite people with read, write or admin access; they accept from Invitations." },
			{ feature: "Organizations and teams", status: "done", comment: "Organizations own repositories; owners administer them all and members read them all; teams grant read, write or admin to particular repositories. Members join by invitation." },
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
			{ feature: "Upload files", status: "done", comment: "Drag files or whole folders in, any kind, up to 10 MB each and 25 MB per commit; bigger files go through git." },
		],
	},
	{
		title: "Automation and integrations",
		items: [
			{ feature: "Webhooks", status: "done", comment: "Push (branches and tags), merge, release, issue, task, workflow_run and gollum (wiki) events. HMAC-signed, retried for about nine hours, with a delivery log and redeliver." },
			{
				feature: "Actions / built-in CI",
				status: "partial",
				comment:
					"Workflows in .megit/workflows: push, pull_request, workflow_dispatch and schedule triggers; matrices (include, exclude, fail-fast, max-parallel); job if and outputs; GitHub's expression language with steps, needs and hashFiles; JavaScript and composite actions from GitHub or the repository; built-in checkout, cache and artifact actions kept in R2. Jobs run in a Depot sandbox on your Depot token, or a Cloudflare container where the deploy enables it. Live logs, cancel, re-run, approval for readers' and forks' pull requests, and Run workflow. No services, containers, environments, concurrency, reusable workflows, dispatch inputs or Docker actions.",
			},
			{ feature: "Actions caches and artifacts", status: "done", comment: "actions/cache (restore, save, restore-keys, scoped by branch like GitHub's) and upload/download-artifact, stored in R2. Artifacts download from the run page; caches are listed and deletable on the Actions tab." },
			{ feature: "Checks on commits and pull requests", status: "partial", comment: "megit Actions runs show on commit pages and pull requests. A branch rule can require the base branch's pull request workflows (and every other run on the head) to pass; missing ones can be started from the pull request. No status API for external CI to report into yet." },
			{ feature: "Actions secrets", status: "done", comment: "Per repository, encrypted, write-only, masked in logs, withheld from forks' runs. No organization or environment secrets." },
			{ feature: "Self-hosted runners", status: "missing", comment: "Jobs run in a Cloudflare container or a Depot sandbox. Blacksmith isn't an option: it only runs GitHub Actions jobs for GitHub organizations." },
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
