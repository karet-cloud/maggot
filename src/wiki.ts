// A repository's wiki: a second Artifacts repo, created when its first page is saved (from the web or
// by a push), with Markdown pages at the root of master. The coordinator owns it, as it owns the code;
// this module keeps it apart behind a small host interface, the way ci/runs.ts does for Actions.
import type { Commit, FileHistory, WikiIndex, WikiPage, WikiPageChange } from "./api.ts";
import { errorCode, HttpError } from "./errors.ts";
import { commitChanges, NoChanges, PathError, TooLarge, type FileChange, type Identity } from "./git/commit.ts";
import { listBranches, RefUpdateRejected } from "./git/protocol.ts";
import type { RemoteAccess } from "./git/workspace.ts";
import type { RepoHandle, RepoStore } from "./store.ts";
import { FOOTER, findPageFile, isSpecialFile, pageFile, pageFromFile, pageNameProblem, pageSlug, pageTitle, SIDEBAR, sortPages, WIKI_BRANCH } from "./wiki-pages.ts";

const TOKEN_TTL = 900;

export interface WikiHost {
	sql: SqlStorage;
	store: RepoStore;
	/** The wiki's storage name (see wikiRepoName). */
	name(): string;
	/** Waits until a just-created Artifacts repo accepts Git traffic. */
	ready(name: string): Promise<void>;
	/** Throws if the repository is archived: its wiki is read-only too. */
	assertWritable(): void;
	/** Commits that changed `path`, from `start`; the coordinator caches them. */
	history(repo: RepoHandle, start: string, path: string): Promise<FileHistory>;
	/** Pages changed: for the feed, open pages and `gollum` webhooks. */
	emit(data: { pages: WikiPageChange[]; actor: string | null; head: string | null }): void;
}

export interface SavePageInput {
	/** The page being edited; absent to create one. */
	page?: string;
	/** The page's title; a different one renames it. Defaults to the current one when editing. */
	title?: string;
	/** New Markdown; absent keeps the page's content (a rename only). */
	content?: string;
	message?: string;
	/** The wiki head the edit started from (null: it had no pages); if it has moved, nothing is written. */
	baseCommit?: string | null;
	author: Identity;
	maxPackBytes: number;
}

export class Wiki {
	private readonly host: WikiHost;
	private tokens: Partial<Record<"read" | "write", { token: string; expires: number }>> = {};

	constructor(host: WikiHost) {
		this.host = host;
		host.sql.exec("CREATE TABLE IF NOT EXISTS wiki (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	}

	/** The storage remote, once the wiki exists. */
	private storedRemote(): string | null {
		return this.host.sql.exec<{ value: string }>("SELECT value FROM wiki WHERE key = 'remote'").toArray()[0]?.value ?? null;
	}

	private setState(key: "remote" | "head", value: string | null) {
		if (value === null) this.host.sql.exec("DELETE FROM wiki WHERE key = ?", key);
		else this.host.sql.exec("INSERT OR REPLACE INTO wiki (key, value) VALUES (?, ?)", key, value);
	}

	/** Creates the wiki's repository (or adopts one a create that died partway left behind). */
	private async create(): Promise<string> {
		const name = this.host.name();
		try {
			await this.host.store.create(name, { description: "Wiki", setDefaultBranch: WIKI_BRANCH });
		} catch (err) {
			if (errorCode(err) !== "ALREADY_EXISTS") throw err;
		}
		await this.host.ready(name);
		using repo = await this.host.store.get(name);
		const { remote } = await repo.info();
		this.setState("remote", remote);
		return remote;
	}

	/**
	 * Where git (the proxy's or a web edit's) reaches the wiki, with a cached short-lived token. Write
	 * access creates the wiki if it doesn't exist yet, so a first push works like a first page; read
	 * access to a wiki with no pages is null.
	 */
	async remote(scope: "read" | "write"): Promise<RemoteAccess | null> {
		if (scope === "write") this.host.assertWritable();
		const url = this.storedRemote() ?? (scope === "write" ? await this.create() : null);
		if (!url) return null;
		const cached = this.tokens[scope];
		if (cached && cached.expires > Date.now() + 120_000) return { url, token: cached.token };
		using repo = await this.host.store.get(this.host.name());
		const token = await repo.createToken(scope, TOKEN_TTL);
		this.tokens[scope] = { token: token.plaintext, expires: Date.parse(token.expiresAt) };
		return { url, token: token.plaintext };
	}

	/** The head commit and the files at the wiki's root, or null while it has no pages. */
	private async root(repo: RepoHandle): Promise<{ head: ArtifactsCommitMetadata; files: ArtifactsTreeEntry[] } | null> {
		const [head] = await repo.log({ ref: WIKI_BRANCH, limit: 1 });
		if (!head) return null;
		const files = ((await repo.readTree(head.treeHash)) ?? []).filter((e) => e.type !== "tree");
		return { head, files };
	}

	private async open(): Promise<RepoHandle | null> {
		if (!this.storedRemote()) return null;
		try {
			return await this.host.store.get(this.host.name());
		} catch (err) {
			if (errorCode(err) === "NOT_FOUND") return null;
			throw err;
		}
	}

	async index(): Promise<WikiIndex> {
		using repo = await this.open();
		const root = repo ? await this.root(repo) : null;
		if (!repo || !root) return { head: null, pages: [], sidebar: null, footer: null };
		const text = async (name: string) => {
			const entry = root.files.find((f) => isSpecialFile(f.name, name));
			return entry ? ((await (await repo.readBlob(entry.hash))?.text()) ?? null) : null;
		};
		const pages = root.files.flatMap((f) => {
			const page = pageFromFile(f.name);
			return page ? [{ ...page, path: f.name }] : [];
		});
		const [sidebar, footer] = await Promise.all([text(SIDEBAR), text(FOOTER)]);
		return { head: root.head.hash, pages: sortPages(pages), sidebar, footer };
	}

	async page(slug: string): Promise<WikiPage> {
		using repo = await this.open();
		const root = repo ? await this.root(repo) : null;
		const path = root ? findPageFile(root.files.map((f) => f.name), slug) : null;
		if (!repo || !root || !path) throw new HttpError(404, "NOT_FOUND", `There's no wiki page called ${pageTitle(slug)}`);
		const entry = root.files.find((f) => f.name === path) as ArtifactsTreeEntry;
		const source = (await (await repo.readBlob(entry.hash))?.text()) ?? "";
		const history = await this.host.history(repo, root.head.hash, path);
		const last = history.commits[0];
		const lastCommit: Commit | null = last ? { hash: last.hash, message: last.message, author: last.author, parents: last.parents, committedAt: last.committedAt } : null;
		const page = pageFromFile(path) as { slug: string; title: string };
		return { ...page, path, source, head: root.head.hash, lastCommit };
	}

	/** The commits that changed a page (by its current file, or the name it would have), from `from` for older ones. */
	async history(slug: string, from?: string): Promise<FileHistory> {
		using repo = await this.open();
		const root = repo ? await this.root(repo) : null;
		if (!repo || !root) throw new HttpError(404, "NOT_FOUND", "This wiki has no pages yet");
		const path = findPageFile(root.files.map((f) => f.name), slug) ?? pageFile(slug);
		const start = from && /^[0-9a-f]{40}$/.test(from) ? from : root.head.hash;
		return this.host.history(repo, start, path);
	}

	/** Creates, edits or renames a page in one commit. */
	async save(input: SavePageInput): Promise<{ page: string; commit: string; packBytes: number }> {
		const editing = input.page !== undefined;
		const title = (input.title ?? (editing ? pageTitle(input.page as string) : "")).trim();
		const problem = pageNameProblem(title);
		if (problem) throw new HttpError(400, "INVALID_INPUT", problem);
		if (!editing && input.content === undefined) throw new HttpError(400, "INVALID_INPUT", "A new page needs content");
		return this.write(input, async (files, read) => {
			const slug = pageSlug(title);
			const current = editing ? findPageFile(files, input.page as string) : null;
			if (editing && !current) throw new HttpError(404, "NOT_FOUND", `There's no wiki page called ${pageTitle(input.page as string)}`);
			const currentSlug = current ? (pageFromFile(current) as { slug: string }).slug : null;
			// A new title that only changes the name's case is still a rename of the file.
			const renamed = current !== null && currentSlug !== slug;
			const taken = findPageFile(files, slug);
			if ((!editing || renamed) && taken && taken !== current) throw new HttpError(409, "ALREADY_EXISTS", `A page called ${pageTitle(slug)} already exists`);
			const path = current && !renamed ? current : pageFile(title);
			const content = input.content ?? (await read(current as string));
			const changes: FileChange[] = [{ path, content: new TextEncoder().encode(content), create: !editing || renamed }];
			if (renamed) changes.push({ path: current as string, content: null });
			const oldTitle = currentSlug ? pageTitle(currentSlug) : null;
			const message = !editing ? `Created ${pageTitle(slug)}` : renamed ? `Renamed ${oldTitle} to ${pageTitle(slug)}` : `Updated ${pageTitle(slug)}`;
			const pages = (sha: string): WikiPageChange[] => [
				...(renamed ? [{ page_name: currentSlug as string, title: oldTitle as string, action: "deleted" as const, sha }] : []),
				{ page_name: slug, title: pageTitle(slug), action: editing && !renamed ? "edited" : "created", sha },
			];
			return { changes, message, slug, pages };
		});
	}

	async remove(input: { page: string; message?: string; baseCommit?: string | null; author: Identity; maxPackBytes: number }): Promise<{ commit: string; packBytes: number }> {
		const { commit, packBytes } = await this.write(input, async (files) => {
			const path = findPageFile(files, input.page);
			if (!path) throw new HttpError(404, "NOT_FOUND", `There's no wiki page called ${pageTitle(input.page)}`);
			const { slug, title } = pageFromFile(path) as { slug: string; title: string };
			return {
				changes: [{ path, content: null }],
				message: `Deleted ${title}`,
				slug,
				pages: (sha: string): WikiPageChange[] => [{ page_name: slug, title, action: "deleted", sha }],
			};
		});
		return { commit, packBytes };
	}

	/** One web commit to the wiki: checks the base, builds the changes from the root's files, commits and reports it. */
	private async write(
		input: { message?: string; baseCommit?: string | null; author: Identity; maxPackBytes: number },
		plan: (
			files: string[],
			read: (path: string) => Promise<string>,
		) => Promise<{ changes: FileChange[]; message: string; slug: string; pages: (sha: string) => WikiPageChange[] }>,
	): Promise<{ page: string; commit: string; packBytes: number }> {
		this.host.assertWritable();
		const access = (await this.remote("write")) as RemoteAccess;
		const head = (await listBranches(access)).get(WIKI_BRANCH) ?? null;
		if (input.baseCommit !== undefined && input.baseCommit !== head) {
			throw new HttpError(409, "BRANCH_MOVED", "The wiki has changed since you started editing; reload to see the changes");
		}
		using repo = await this.host.store.get(this.host.name());
		const parent = head ? await repo.readCommit(head) : null;
		if (head && !parent) throw new HttpError(409, "BRANCH_MOVED", "The wiki changed while saving; reload and try again");
		const entries = parent ? ((await repo.readTree(parent.treeHash)) ?? []).filter((e) => e.type !== "tree") : [];
		const read = async (path: string) => {
			const entry = entries.find((e) => e.name === path);
			return (entry && (await (await repo.readBlob(entry.hash))?.text())) ?? "";
		};
		const planned = await plan(
			entries.map((e) => e.name),
			read,
		);
		try {
			const result = await commitChanges(repo, access, {
				branch: WIKI_BRANCH,
				parent: parent ? { hash: parent.hash, treeHash: parent.treeHash } : null,
				create: !head,
				maxPackBytes: input.maxPackBytes,
				changes: planned.changes,
				message: input.message?.trim() || planned.message,
				author: input.author,
				time: Math.floor(Date.now() / 1000),
			});
			this.setState("head", result.commit);
			this.host.emit({ pages: planned.pages(result.commit), actor: input.author.name, head: result.commit });
			return { page: planned.slug, commit: result.commit, packBytes: result.packBytes };
		} catch (err) {
			if (err instanceof PathError) {
				throw /already exists/.test(err.message) ? new HttpError(409, "ALREADY_EXISTS", `${err.message}; pick another title`) : new HttpError(400, "INVALID_PATH", err.message);
			}
			if (err instanceof NoChanges) throw new HttpError(400, "NO_CHANGES", "Nothing changed, so there's nothing to save");
			if (err instanceof TooLarge) throw new HttpError(413, "TOO_LARGE", `${err.message}; push it with git, or make room under the size limits`);
			if (err instanceof RefUpdateRejected) throw new HttpError(409, "BRANCH_MOVED", "The wiki changed while saving; reload and try again");
			throw err;
		}
	}

	/**
	 * After a push to the wiki: compares master's root with what was seen last and reports the pages
	 * that appeared, changed or went away.
	 */
	async pushed(actor: string | null): Promise<void> {
		const access = await this.remote("read");
		if (!access) return;
		const head = (await listBranches(access)).get(WIKI_BRANCH) ?? null;
		const before = this.host.sql.exec<{ value: string }>("SELECT value FROM wiki WHERE key = 'head'").toArray()[0]?.value ?? null;
		if (head === before) return;
		this.setState("head", head);
		using repo = await this.host.store.get(this.host.name());
		const filesAt = async (hash: string | null) => {
			const commit = hash ? await repo.readCommit(hash) : null;
			const entries = commit ? ((await repo.readTree(commit.treeHash)) ?? []) : [];
			return new Map(entries.filter((e) => e.type !== "tree" && pageFromFile(e.name)).map((e) => [e.name, e.hash]));
		};
		const [old, now] = await Promise.all([filesAt(before).catch(() => new Map<string, string>()), filesAt(head)]);
		const sha = head ?? "0".repeat(40);
		const pages: WikiPageChange[] = [];
		for (const [file, blob] of now) {
			if (old.get(file) === blob) continue;
			const { slug, title } = pageFromFile(file) as { slug: string; title: string };
			pages.push({ page_name: slug, title, action: old.has(file) ? "edited" : "created", sha });
		}
		for (const file of old.keys()) {
			if (now.has(file)) continue;
			const { slug, title } = pageFromFile(file) as { slug: string; title: string };
			pages.push({ page_name: slug, title, action: "deleted", sha });
		}
		// Sidebars, footers and images change the wiki too: open pages still refresh.
		this.host.emit({ pages, actor, head });
	}

	/** Deletes the wiki's repository, with the rest of the repository. */
	async destroy(): Promise<void> {
		await this.host.store.delete(this.host.name()).catch(() => false);
	}
}
