import { Link } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { api, repoParams } from "../lib/api.ts";
import { highlightCode } from "../lib/highlight.ts";
import { pageLinkTarget, pageTitle, wikiLinks } from "../../src/wiki-pages.ts";

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** Heading ids get this prefix, as on GitHub, so a heading can't shadow ids the page itself uses. */
const ID_PREFIX = "user-content-";

interface HastNode {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
}

const textOf = (node: HastNode): string => (node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join(""));

/** Gives headings GitHub's anchor ids (lowercased, punctuation dropped, spaces to hyphens, repeats numbered). */
function rehypeHeadingIds() {
	return (tree: HastNode) => {
		const seen = new Map<string, number>();
		const visit = (node: HastNode) => {
			if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "")) {
				const base = textOf(node).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
				const n = seen.get(base) ?? 0;
				seen.set(base, n + 1);
				node.properties = { ...node.properties, id: `${ID_PREFIX}${n ? `${base}-${n}` : base}` };
			}
			node.children?.forEach(visit);
		};
		visit(tree);
	};
}

/** Resolves `target` against the directory `dir` the way a repo-relative Markdown link does. */
function resolvePath(dir: string, target: string): string {
	const parts = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
	for (const part of target.split("/")) {
		if (part === "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return parts.join("/");
}

/** GitHub's allow-list (rehype-sanitize's default), plus `align` for the centered logos READMEs use. */
const SCHEMA = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		div: [...(defaultSchema.attributes?.div ?? []), "align"],
		p: [...(defaultSchema.attributes?.p ?? []), "align"],
		img: [...(defaultSchema.attributes?.img ?? []), "align", "width", "height"],
	},
};

/**
 * Renders a Markdown file from the repo (GitHub-flavored; inline HTML is sanitized like GitHub does). Relative links open in
 * the code browser and relative images load from the same ref.
 */
export function Markdown({
	source,
	project,
	path,
	refName,
	wiki,
}: {
	source: string;
	project: string;
	path: string;
	refName?: string;
	/**
	 * A wiki page: `[[Page]]` links work, relative links name pages (missing ones link to creating them,
	 * marked as such), and relative images load from the wiki. `pages` are the wiki's page slugs.
	 */
	wiki?: { pages: string[] };
}) {
	const dir = path.split("/").slice(0, -1).join("/");
	const pages = new Map((wiki?.pages ?? []).map((slug) => [slug.toLowerCase(), slug]));
	return (
		<div className="markdown">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA], rehypeHeadingIds]}
				components={{
					a({ href = "", children }) {
						if (href.startsWith("#")) return <a href={`#${ID_PREFIX}${decodeURIComponent(href.slice(1)).toLowerCase()}`}>{children}</a>;
						if (EXTERNAL.test(href)) {
							return (
								<a href={href} target="_blank" rel="noreferrer noopener">
									{children}
								</a>
							);
						}
						if (wiki) {
							const target = pageLinkTarget(href, (slug) => pages.has(slug.toLowerCase()));
							if (!target) return <a href={href}>{children}</a>;
							const page = pages.get(target.slug.toLowerCase());
							if (!page) {
								return (
									<Link
										to="/$owner/$repo/wiki/_new"
										params={repoParams(project)}
										search={{ title: pageTitle(target.slug) }}
										className="wiki-missing"
										title={`${pageTitle(target.slug)} doesn't exist yet`}
									>
										{children}
									</Link>
								);
							}
							return (
								<Link to="/$owner/$repo/wiki/$page" params={{ ...repoParams(project), page }} hash={target.fragment ? `${ID_PREFIX}${target.fragment.toLowerCase()}` : undefined}>
									{children}
								</Link>
							);
						}
						const [pathPart, fragment] = href.split("#");
						const target = resolvePath(dir, pathPart);
						// A guess from the name; the code view corrects it once it has listed the parent directory.
						const isFile = /\.[^/]+$/.test(target) || /^[A-Z][A-Z0-9_-]*$/.test(target.split("/").pop() ?? "");
						const parent = target.split("/").slice(0, -1).join("/") || undefined;
						return (
							<Link
								to="/$owner/$repo"
								params={repoParams(project)}
								search={isFile ? { ref: refName, path: parent, file: target } : { ref: refName, path: target || undefined }}
								hash={fragment ? `${ID_PREFIX}${fragment.toLowerCase()}` : undefined}
							>
								{children}
							</Link>
						);
					},
					img({ src = "", alt }) {
						const url =
							typeof src !== "string" || EXTERNAL.test(src)
								? src
								: wiki
									? api.wikiRawUrl(project, resolvePath("", src))
									: api.rawUrl(project, resolvePath(dir, src), refName);
						return <img src={url as string} alt={alt ?? ""} loading="lazy" />;
					},
					code({ className, children }) {
						const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
						const text = String(children ?? "");
						const html = language ? highlightCode(text.replace(/\n$/, ""), language) : null;
						return html ? <code className={className} dangerouslySetInnerHTML={{ __html: html }} /> : <code className={className}>{children}</code>;
					},
				}}
			>
				{wiki ? wikiLinks(source) : source}
			</ReactMarkdown>
		</div>
	);
}
