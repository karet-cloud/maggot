import { Link } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { api, repoParams } from "../lib/api.ts";
import { highlightCode } from "../lib/highlight.ts";

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

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
export function Markdown({ source, project, path, refName }: { source: string; project: string; path: string; refName?: string }) {
	const dir = path.split("/").slice(0, -1).join("/");
	return (
		<div className="markdown">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA]]}
				components={{
					a({ href = "", children }) {
						if (href.startsWith("#") || EXTERNAL.test(href)) {
							const external = EXTERNAL.test(href);
							return (
								<a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>
									{children}
								</a>
							);
						}
						const target = resolvePath(dir, href.split("#")[0]);
						const name = target.split("/").pop() ?? "";
						const isFile = name.includes(".");
						const parent = target.split("/").slice(0, -1).join("/") || undefined;
						return (
							<Link
								to="/$owner/$repo"
								params={repoParams(project)}
								search={isFile ? { ref: refName, path: parent, file: target } : { ref: refName, path: target || undefined }}
							>
								{children}
							</Link>
						);
					},
					img({ src = "", alt }) {
						const url = typeof src !== "string" || EXTERNAL.test(src) ? src : api.rawUrl(project, resolvePath(dir, src), refName);
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
				{source}
			</ReactMarkdown>
		</div>
	);
}
