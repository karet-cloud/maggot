// Wiki pages as GitHub keeps them: Markdown files at the root of the wiki repository's default branch,
// named after the page with spaces as hyphens ("Getting Started" is Getting-Started.md). Pure, so the
// API, the coordinator and the browser all name pages the same way.

/** The wiki repository's only branch; pages are read from it. */
export const WIKI_BRANCH = "master";
export const HOME = "Home";
/** Rendered beside and below every page when present; not pages themselves. */
export const SIDEBAR = "_Sidebar";
export const FOOTER = "_Footer";

const EXTENSIONS = [".md", ".markdown"];
/** Characters a page name can't have: path separators, what Windows refuses in file names, and link syntax. */
const FORBIDDEN = /[/\\:*?"<>|[\]#\u0000-\u001f\u007f]/;

/** "Getting Started" → "Getting-Started": a page's name in URLs and its file name without the extension. */
export function pageSlug(title: string): string {
	return title.trim().replace(/\s+/g, "-");
}

/** How a page's name reads: hyphens back to spaces. */
export function pageTitle(slug: string): string {
	return slug.replace(/-/g, " ");
}

/** Why `title` can't name a page, or null if it can. Names starting with "_" or "." are reserved (_Sidebar, _Footer). */
export function pageNameProblem(title: string): string | null {
	const slug = pageSlug(title);
	if (!slug) return "Give the page a title";
	if (slug.length > 200) return "Page titles are at most 200 characters";
	if (FORBIDDEN.test(slug)) return `Page titles can't contain / \\ : * ? " < > | [ ] or #`;
	if (slug.startsWith("_") || slug.startsWith(".")) return "Page titles can't start with _ or .";
	if (EXTENSIONS.some((ext) => slug.toLowerCase().endsWith(ext))) return "Leave the extension out of the title";
	return null;
}

/** The file a new page with this title is saved as. */
export function pageFile(title: string): string {
	return `${pageSlug(title)}.md`;
}

/** The page a file at the wiki's root is (Markdown files only; _Sidebar and _Footer aren't pages), or null. */
export function pageFromFile(file: string): { slug: string; title: string } | null {
	if (file.includes("/")) return null;
	const ext = EXTENSIONS.find((e) => file.toLowerCase().endsWith(e));
	if (!ext) return null;
	const slug = file.slice(0, -ext.length);
	if (!slug || slug.startsWith("_") || slug.startsWith(".")) return null;
	return { slug, title: pageTitle(slug) };
}

/** Whether a file is the special page `name` (_Sidebar, _Footer) in any of the extensions. */
export function isSpecialFile(file: string, name: string): boolean {
	return EXTENSIONS.some((ext) => file.toLowerCase() === `${name}${ext}`.toLowerCase());
}

/** Finds the file of page `slug` among root file names: the exact name first, then ignoring case. */
export function findPageFile(files: string[], slug: string): string | null {
	const pages = files.map((f) => ({ f, page: pageFromFile(f) })).filter((x) => x.page !== null);
	const exact = pages.find((x) => x.page?.slug === slug);
	if (exact) return exact.f;
	const lower = slug.toLowerCase();
	return pages.find((x) => x.page?.slug.toLowerCase() === lower)?.f ?? null;
}

/** Pages in the order a wiki lists them: Home first, then by title. */
export function sortPages<T extends { slug: string; title: string }>(pages: T[]): T[] {
	return [...pages].sort((a, b) => Number(b.slug === HOME) - Number(a.slug === HOME) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * The page a relative link in a wiki page points to (`Getting-Started`, `./Getting-Started.md`), or
 * null if it isn't one: an absolute or external URL, an anchor, or a path into a folder.
 */
export function pageLinkTarget(href: string, isPage?: (slug: string) => boolean): { slug: string; fragment: string | null } | null {
	if (!href || href.startsWith("#") || href.startsWith("/") || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null;
	const [path, fragment = null] = href.split("#", 2);
	const clean = path.replace(/^\.\//, "");
	if (!clean || clean.includes("/") || clean.includes("?")) return null;
	let slug: string;
	try {
		slug = decodeURIComponent(clean);
	} catch {
		return null;
	}
	const ext = EXTENSIONS.find((e) => slug.toLowerCase().endsWith(e));
	if (ext) slug = slug.slice(0, -ext.length);
	slug = pageSlug(slug);
	// Something with another extension (an image, a PDF) is a file, unless a page has that name ("Release-1.2").
	if (!ext && /\.[A-Za-z0-9]{1,5}$/.test(slug) && !isPage?.(slug)) return null;
	return { slug, fragment };
}

const LINK = /\[\[([^[\]\n]+?)\]\]/g;
const escapeText = (text: string) => text.replace(/[\\[\]]/g, (c) => `\\${c}`);

/** One `[[...]]` as a Markdown link: `[[Page Name]]`, `[[Link text|Page Name]]`, `[[Page#section]]`, or a URL. */
function wikiLink(inner: string): string {
	const bar = inner.indexOf("|");
	const text = (bar === -1 ? inner : inner.slice(0, bar)).trim();
	const target = (bar === -1 ? inner : inner.slice(bar + 1)).trim();
	if (!target) return `[[${inner}]]`;
	if (/^https?:\/\//i.test(target)) return `[${escapeText(text)}](<${target.replace(/[<>]/g, "")}>)`;
	const [page, fragment] = target.split("#", 2);
	const anchor = fragment ? `#${encodeURIComponent(pageSlug(fragment).toLowerCase())}` : "";
	if (!page.trim()) return `[${escapeText(text)}](${anchor || "#"})`;
	return `[${escapeText(text)}](${encodeURIComponent(pageSlug(page))}${anchor})`;
}

/** Rewrites `[[...]]` in a run of text outside code, leaving inline code spans as they are. */
function rewriteInline(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const tick = line.indexOf("`", i);
		if (tick === -1) {
			out += line.slice(i).replace(LINK, (_m, inner: string) => wikiLink(inner));
			break;
		}
		out += line.slice(i, tick).replace(LINK, (_m, inner: string) => wikiLink(inner));
		// A code span runs to the next run of exactly as many backticks; an unmatched run is literal.
		const run = /^`+/.exec(line.slice(tick))?.[0] ?? "`";
		const close = line.indexOf(run, tick + run.length);
		if (close === -1) {
			out += run;
			i = tick + run.length;
			continue;
		}
		out += line.slice(tick, close + run.length);
		i = close + run.length;
	}
	return out;
}

/**
 * Turns GitHub wiki links (`[[Page Name]]`, `[[text|Page Name]]`) into ordinary relative Markdown
 * links to the pages, outside fenced code blocks and code spans. The renderer then treats them like
 * any relative link to a page.
 */
export function wikiLinks(source: string): string {
	if (!source.includes("[[")) return source;
	let fence: string | null = null;
	return source
		.split("\n")
		.map((line) => {
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (fence) {
				if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
				return line;
			}
			if (marker) {
				fence = marker;
				return line;
			}
			return rewriteInline(line);
		})
		.join("\n");
}
