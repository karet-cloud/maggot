import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, FilePlus2, History, PencilLine, Save, Trash2 } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { pageNameProblem, pageSlug, pageTitle } from "../../src/wiki-pages.ts";
import { api, ApiError, keys, repoParams, type WikiIndex, type WikiPage } from "../lib/api.ts";
import { useNeedsVerification } from "../routes/__root.tsx";
import { Markdown } from "./markdown.tsx";
import { Button, buttonClass, CopyField, cx, Empty, ErrorNote, Field, Input, Panel, Spinner, TimeAgo } from "./ui.tsx";

const MAX_PAGE_BYTES = 1024 * 1024;

/** The repository and its wiki's pages, which every wiki screen needs. */
export function useWiki(project: string) {
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const index = useQuery({ queryKey: keys.wiki(project), queryFn: () => api.wiki(project), enabled: info.data?.repo.hasWiki !== false });
	const repo = info.data?.repo;
	return {
		info,
		index,
		/** Writers edit; an archived repository's wiki is read-only for everyone. */
		canEdit: Boolean(repo?.canWrite && !repo.archivedAt),
		off: repo?.hasWiki === false || (index.error instanceof ApiError && index.error.status === 404),
	};
}

/** What a wiki screen shows while the repository loads, or when its wiki is turned off. */
export function WikiGate({ project, children }: { project: string; children: (wiki: ReturnType<typeof useWiki> & { index: { data: WikiIndex } }) => ReactNode }) {
	const wiki = useWiki(project);
	if (wiki.off) {
		return (
			<Empty icon={<BookOpen className="size-6" />} title="This repository's wiki is turned off">
				Its admins can turn it back on in Settings; the pages are kept.
			</Empty>
		);
	}
	if (wiki.info.error) return <ErrorNote error={wiki.info.error} />;
	if (wiki.index.error) return <ErrorNote error={wiki.index.error} />;
	if (!wiki.index.data) return <Spinner />;
	return children(wiki as ReturnType<typeof useWiki> & { index: { data: WikiIndex } });
}

/** A wiki screen: the page (or form) beside the page list, the wiki's own sidebar and how to clone it. */
export function WikiShell({ project, index, current, children }: { project: string; index: WikiIndex; current?: string; children: ReactNode }) {
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const slugs = index.pages.map((p) => p.slug);
	return (
		<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_240px]">
			<div className="min-w-0 space-y-4">{children}</div>
			<div className="space-y-4">
				{index.sidebar && (
					<Panel>
						<div className="px-4 py-3 text-sm">
							<Markdown source={index.sidebar} project={project} path="_Sidebar.md" wiki={{ pages: slugs }} />
						</div>
					</Panel>
				)}
				<Panel title={`Pages · ${index.pages.length}`}>
					{index.pages.length === 0 ? (
						<p className="px-4 py-3 text-xs text-faint">No pages yet.</p>
					) : (
						<ul className="max-h-[50vh] overflow-y-auto py-1 text-sm">
							{index.pages.map((p) => (
								<li key={p.slug}>
									<Link
										to="/$owner/$repo/wiki/$page"
										params={{ ...repoParams(project), page: p.slug }}
										className={cx("block truncate px-4 py-1 hover:bg-raised hover:text-fg", p.slug === current ? "text-fg" : "text-dim")}
									>
										{p.title}
									</Link>
								</li>
							))}
						</ul>
					)}
				</Panel>
				{info.data && (
					<Panel title="Clone this wiki">
						<div className="space-y-2 p-3 text-[11px] text-faint">
							<CopyField value={info.data.repo.wikiUrl} />
							<p>Pages are Markdown files at its root. Push to it like any repository.</p>
						</div>
					</Panel>
				)}
			</div>
		</div>
	);
}

/** A rendered page with its footer, for the page view and the wiki's home. */
export function WikiArticle({ project, index, page, actions }: { project: string; index: WikiIndex; page: WikiPage; actions?: ReactNode }) {
	const slugs = index.pages.map((p) => p.slug);
	return (
		<>
			<Panel
				title={<span className="text-sm normal-case tracking-normal text-fg">{page.title}</span>}
				actions={actions}
			>
				<div className="px-5 py-4">
					{page.source.trim() ? <Markdown source={page.source} project={project} path={page.path} wiki={{ pages: slugs }} /> : <p className="text-sm text-faint">This page is empty.</p>}
				</div>
			</Panel>
			{index.footer && (
				<Panel>
					<div className="px-5 py-3 text-sm">
						<Markdown source={index.footer} project={project} path="_Footer.md" wiki={{ pages: slugs }} />
					</div>
				</Panel>
			)}
		</>
	);
}

const action = "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-normal normal-case tracking-normal text-dim hover:bg-raised hover:text-fg";

/** One page, read live (edits elsewhere refresh it), with what writers can do to it. Also the wiki's home. */
export function WikiPageView({ project, index, slug, canEdit }: { project: string; index: WikiIndex; slug: string; canEdit: boolean }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const page = useQuery({
		queryKey: keys.wikiPage(project, slug),
		queryFn: () => api.wikiPage(project, slug),
		retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteWikiPage(project, page.data?.slug ?? slug, page.data?.head ?? null),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: keys.wiki(project) });
			void navigate({ to: "/$owner/$repo/wiki", params: repoParams(project) });
		},
	});
	const missing = page.error instanceof ApiError && page.error.status === 404;
	return (
		<WikiShell project={project} index={index} current={page.data?.slug ?? slug}>
			{page.isPending ? (
				<Spinner />
			) : missing ? (
				<Empty title={`There's no page called ${pageTitle(slug)}`}>
					{canEdit && (
						<Link to="/$owner/$repo/wiki/_new" params={repoParams(project)} search={{ title: pageTitle(slug) }} className="text-accent hover:underline">
							Create it
						</Link>
					)}
				</Empty>
			) : page.error ? (
				<ErrorNote error={page.error} />
			) : (
				<>
					<WikiArticle
						project={project}
						index={index}
						page={page.data}
						actions={
							<div className="flex flex-wrap items-center gap-1">
								<Link to="/$owner/$repo/wiki/_history/$page" params={{ ...repoParams(project), page: page.data.slug }} className={action}>
									<History className="size-3.5" />
									History
								</Link>
								{canEdit && (
									<>
										<Link to="/$owner/$repo/wiki/_edit/$page" params={{ ...repoParams(project), page: page.data.slug }} className={action}>
											<PencilLine className="size-3.5" />
											Edit
										</Link>
										<Link to="/$owner/$repo/wiki/_new" params={repoParams(project)} search={{}} className={action}>
											<FilePlus2 className="size-3.5" />
											New page
										</Link>
										<Button
											variant="ghost"
											className="px-2 py-1 text-[11px] font-normal"
											busy={remove.isPending}
											onClick={() => confirm(`Delete the page ${page.data.title}? Its history stays in the wiki's repository.`) && remove.mutate()}
										>
											<Trash2 className="size-3.5" />
											Delete
										</Button>
									</>
								)}
							</div>
						}
					/>
					<ErrorNote error={remove.error} />
					{page.data.lastCommit && (
						<p className="text-xs text-faint">
							Last edited by <span className="text-dim">{page.data.lastCommit.author.name}</span> <TimeAgo at={page.data.lastCommit.committedAt} />
							{" · "}
							{page.data.lastCommit.message.split("\n")[0]}
						</p>
					)}
				</>
			)}
		</WikiShell>
	);
}

/** The wiki with no pages: GitHub's welcome, with the first page for those who can write it. */
export function WikiWelcome({ project, canEdit }: { project: string; canEdit: boolean }) {
	return (
		<Empty icon={<BookOpen className="size-6" />} title="Welcome to the wiki">
			<p>Wikis hold the documentation of a repository: guides, how-tos, anything longer than a README.</p>
			{canEdit && (
				<Link
					to="/$owner/$repo/wiki/_new"
					params={repoParams(project)}
					search={{ title: "Home" }}
					className={buttonClass("primary", "mt-3")}
				>
					<FilePlus2 className="size-4" />
					Create the first page
				</Link>
			)}
		</Empty>
	);
}

/** A draft kept in session storage (null when there's none, or storage isn't available). */
function readDraft(key: string): { title: string; content: string } | null {
	try {
		const raw = sessionStorage.getItem(key);
		return raw ? (JSON.parse(raw) as { title: string; content: string }) : null;
	} catch {
		return null;
	}
}

function writeDraft(key: string, draft: { title: string; content: string } | null) {
	try {
		if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
		else sessionStorage.removeItem(key);
	} catch {
		// Storage full or blocked: the draft just isn't kept.
	}
}

/**
 * Creates (no `page`) or edits a page: its title (a new one renames it), its Markdown with a
 * preview, and a commit message. `baseCommit` is the wiki head an edit started from; if the wiki
 * moves on meanwhile, saving is refused rather than overwriting someone else's change.
 */
export function WikiEditor({ project, index, page, initialTitle = "", baseCommit }: { project: string; index: WikiIndex; page?: WikiPage; initialTitle?: string; baseCommit?: string | null }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const needsVerification = useNeedsVerification();
	// The text being written is kept in this tab's session storage, so a reload (after a conflict, say) doesn't lose it.
	const draftKey = `maggot-wiki-draft:${project}:${page?.slug ?? "_new"}`;
	const [draft] = useState(() => readDraft(draftKey));
	const [restored, setRestored] = useState(draft !== null && (draft.title !== (page?.title ?? initialTitle) || draft.content !== (page?.source ?? "")));
	const [title, setTitleState] = useState(restored ? draft!.title : (page?.title ?? initialTitle));
	const [content, setContentState] = useState(restored ? draft!.content : (page?.source ?? ""));
	const keep = (next: { title?: string; content?: string }) => writeDraft(draftKey, { title: next.title ?? title, content: next.content ?? content });
	const setTitle = (value: string) => {
		setTitleState(value);
		keep({ title: value });
	};
	const setContent = (value: string) => {
		setContentState(value);
		keep({ content: value });
	};
	const discard = () => {
		writeDraft(draftKey, null);
		setRestored(false);
		setTitleState(page?.title ?? initialTitle);
		setContentState(page?.source ?? "");
	};
	const [message, setMessage] = useState("");
	const [preview, setPreview] = useState(false);
	const problem = title.trim() ? pageNameProblem(title) : null;
	const renamed = page !== undefined && pageSlug(title) !== page.slug;
	const defaultMessage = !page ? `Created ${title.trim() || "page"}` : renamed ? `Renamed ${page.title} to ${title.trim()}` : `Updated ${page.title}`;
	const tooBig = new TextEncoder().encode(content).length > MAX_PAGE_BYTES;
	const unchanged = page !== undefined && !renamed && content === page.source;
	const save = useMutation({
		mutationFn: () => {
			const input = { title: title.trim(), content, message: message.trim() || undefined, baseCommit };
			return page ? api.editWikiPage(project, page.slug, input) : api.createWikiPage(project, input);
		},
		onSuccess: async (result) => {
			writeDraft(draftKey, null);
			await queryClient.invalidateQueries({ queryKey: keys.wiki(project) });
			void navigate({ to: "/$owner/$repo/wiki/$page", params: { ...repoParams(project), page: result.page } });
		},
	});
	const moved = save.error instanceof ApiError && save.error.code === "BRANCH_MOVED";
	const slugs = index.pages.map((p) => p.slug);

	// Tab inserts a tab instead of leaving the editor.
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
		e.preventDefault();
		const el = e.currentTarget;
		const { selectionStart: start, selectionEnd: end } = el;
		setContent(`${content.slice(0, start)}\t${content.slice(end)}`);
		requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
	};
	const tab = (on: boolean, text: string) => (
		<button
			type="button"
			onClick={() => setPreview(on)}
			aria-pressed={preview === on}
			className={cx("rounded px-2.5 py-1 text-xs", preview === on ? "bg-raised text-fg" : "text-faint hover:text-dim")}
		>
			{text}
		</button>
	);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				save.mutate();
			}}
			className="space-y-3"
		>
			<Panel title={<span className="normal-case tracking-normal text-fg">{page ? `Edit ${page.title}` : "New page"}</span>}>
				<div className="space-y-3 p-3">
					{restored && (
						<p className="flex flex-wrap items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
							Your unsaved text from before was restored{page ? "; the page may have changed since, so check it against the current version" : ""}.
							<button type="button" onClick={discard} className="text-accent hover:underline">
								Discard it
							</button>
						</p>
					)}
					<Field label="Title" hint={problem ?? (renamed ? `Saving renames the page (its file becomes ${pageSlug(title)}.md).` : "Spaces become hyphens in the page's address and file name.")}>
						<Input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus={!page} placeholder="Getting Started" />
					</Field>
					<div className="overflow-hidden rounded-md border border-line-strong bg-bg focus-within:border-accent">
						<div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
							{tab(false, "Write")}
							{tab(true, "Preview")}
							<span className="ml-auto text-[11px] text-faint">
								Markdown · <code className="font-mono">[[Page name]]</code> links to a page
							</span>
						</div>
						{preview ? (
							<div className="min-h-[50vh] px-4 py-3">
								{content.trim() ? <Markdown source={content} project={project} path={page?.path ?? ""} wiki={{ pages: slugs }} /> : <p className="text-sm text-faint">Nothing to preview.</p>}
							</div>
						) : (
							<textarea
								value={content}
								onChange={(e) => setContent(e.target.value)}
								onKeyDown={onKeyDown}
								aria-label="Page content"
								autoFocus={Boolean(page)}
								className="block min-h-[50vh] w-full resize-y bg-transparent p-3 font-mono text-[12px] leading-5 text-fg outline-none"
							/>
						)}
					</div>
					{tooBig && <p className="text-xs text-rose-300">Pages over 1 MB can't be edited here; push them with git.</p>}
				</div>
			</Panel>
			<Panel title="Save">
				<div className="space-y-3 p-3">
					<Field label="Edit message">
						<Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={defaultMessage} />
					</Field>
					{needsVerification && <p className="text-xs text-amber-200">Verify your email address before editing.</p>}
					<ErrorNote error={save.error} />
					{moved && (
						<button type="button" onClick={() => location.reload()} className="text-xs text-accent hover:underline">
							Reload to see the latest version (your text here is kept and comes back after reloading)
						</button>
					)}
					<div className="flex justify-end gap-2">
						<Link
							to={page ? "/$owner/$repo/wiki/$page" : "/$owner/$repo/wiki"}
							params={page ? { ...repoParams(project), page: page.slug } : repoParams(project)}
							className="rounded-md px-3 py-1.5 text-sm text-dim hover:bg-raised hover:text-fg"
						>
							Cancel
						</Link>
						<Button
							type="submit"
							variant="primary"
							busy={save.isPending}
							disabled={!title.trim() || Boolean(problem) || tooBig || unchanged || needsVerification}
							title={unchanged ? "Nothing has changed yet" : undefined}
						>
							<Save className="size-4" />
							Save page
						</Button>
					</div>
				</div>
			</Panel>
		</form>
	);
}
