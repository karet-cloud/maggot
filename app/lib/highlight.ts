// Syntax highlighting with highlight.js core and a fixed set of languages, so the bundle stays small.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
	bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, php,
	python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

const BY_EXTENSION: Record<string, string> = {
	sh: "bash", bash: "bash", zsh: "bash", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", css: "css",
	diff: "diff", patch: "diff", go: "go", ini: "ini", toml: "ini", cfg: "ini", java: "java", js: "javascript",
	mjs: "javascript", cjs: "javascript", jsx: "javascript", json: "json", jsonc: "json", kt: "kotlin", kts: "kotlin",
	md: "markdown", mdx: "markdown", php: "php", py: "python", rb: "ruby", rs: "rust", scss: "scss", sql: "sql",
	swift: "swift", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", html: "xml", htm: "xml",
	xml: "xml", svg: "xml", vue: "xml", yml: "yaml", yaml: "yaml",
};
const BY_NAME: Record<string, string> = { Dockerfile: "dockerfile", Makefile: "makefile", Gemfile: "ruby", Rakefile: "ruby" };

export function languageFor(path: string): string | undefined {
	const name = path.split("/").pop() ?? "";
	return BY_NAME[name] ?? BY_EXTENSION[name.split(".").pop()?.toLowerCase() ?? ""];
}

/** Highlighted HTML (already escaped by highlight.js), one string per line. Null when the language is unknown. */
export function highlightLines(code: string, language: string | undefined): string[] | null {
	if (!language || !hljs.getLanguage(language)) return null;
	return splitLines(hljs.highlight(code, { language, ignoreIllegals: true }).value);
}

/** highlight.js spans can cross lines; close them at each line end and reopen them on the next. */
function splitLines(html: string): string[] {
	const lines: string[] = [];
	const open: string[] = [];
	let line = "";
	for (const token of html.split(/(<span [^>]*>|<\/span>|\n)/)) {
		if (token === "\n") {
			lines.push(line + "</span>".repeat(open.length));
			line = open.join("");
		} else {
			if (token.startsWith("<span ")) open.push(token);
			else if (token === "</span>") open.pop();
			line += token;
		}
	}
	lines.push(line);
	return lines;
}

export function highlightCode(code: string, language: string | undefined): string | null {
	if (!language || !hljs.getLanguage(language)) return null;
	return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
