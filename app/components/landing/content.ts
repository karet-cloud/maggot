/** Copy shared by the landing page candidates. Every line here is backed by README.md or the code. */

export const GROUPS = [
	{
		key: "code",
		title: "Code",
		lead: "Repositories you push to with plain git and browse on the web.",
		items: [
			"Public and private repositories",
			"git over HTTPS with personal access tokens",
			"git over SSH with Ed25519, ECDSA or RSA keys, post-quantum key exchange",
			"Syntax highlighting, line permalinks, fuzzy “Go to file”",
			"Blame, file history and a commit graph across branches",
			"Code search across the default branch",
			"Edit, add, delete and upload files in the browser",
			"Releases, tags, and .zip / .tar.gz downloads",
		],
	},
	{
		key: "collaborate",
		title: "Collaborate",
		lead: "Issues, pull requests and review, with the conventions people already know.",
		items: [
			"Issues with labels, Markdown and a live preview",
			"Pull requests from branches or forks",
			"Line comments gathered into reviews: comment, approve, request changes",
			"Merge commits or squash; required reviews on protected branches",
			"“Fixes #12” in a commit or description closes the issue",
			"Stars, forks, notifications",
			"A wiki per repository, editable on the web or by git",
		],
	},
	{
		key: "automate",
		title: "Automate",
		lead: "CI in the workflow syntax you already have in your repositories.",
		items: [
			"Actions: workflow YAML with run steps, needs, matrices, if, outputs and expressions",
			"JavaScript and composite actions, published or from your repository",
			"Built-in checkout, cache and artifact actions",
			"Runs on push, pull request, schedule or by hand, with live logs",
			"Required checks before merging",
			"Webhooks signed with HMAC-SHA256, retried, redeliverable",
		],
	},
	{
		key: "administer",
		title: "Administer",
		lead: "Organizations, access control and the guard rails a team needs.",
		items: [
			"Organizations with owners and members; teams with read, write or admin access",
			"Collaborators on any repository",
			"Branch protection: block deletion, block force pushes, require reviews or checks",
			"Rename with redirects; transfer with acceptance; archive",
			"Per-account repository and storage quotas, rate limits, email verification",
		],
	},
] as const;

export const API_POINTS = [
	"The web UI is a plain client of the public API, so anything it shows you can build against.",
	"Every repository has an event stream, by polling or live over a WebSocket with replay.",
	"Personal access tokens for git and the API; an admin key for the instance.",
] as const;

export const AGENT_POINTS = [
	"Each agent task works in its own fork with a token scoped to it.",
	"A merge queue lands submissions one at a time; conflicts come back with the files involved.",
	"A small CLI: maggot start, submit, sync, watch. A live board shows the tasks.",
] as const;

export const STACK = [
	{ name: "Workers", role: "One Worker serves git, SSH, the API and the UI" },
	{ name: "Artifacts", role: "Stores every repository" },
	{ name: "Durable Objects", role: "Coordination, search index, rate limits" },
	{ name: "D1", role: "Accounts, issues, pull requests" },
	{ name: "R2", role: "Actions caches and artifacts" },
] as const;
