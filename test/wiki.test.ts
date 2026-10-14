import assert from "node:assert/strict";
import { test } from "node:test";
import { wikiRepoName } from "../src/names.ts";
import { findPageFile, isSpecialFile, pageFile, pageFromFile, pageLinkTarget, pageNameProblem, pageSlug, pageTitle, sortPages, wikiLinks } from "../src/wiki-pages.ts";

test("page names and file names map both ways, as on GitHub", () => {
	assert.equal(pageSlug("Getting Started"), "Getting-Started");
	assert.equal(pageSlug("  Getting   Started "), "Getting-Started");
	assert.equal(pageFile("Getting Started"), "Getting-Started.md");
	assert.equal(pageTitle("Getting-Started"), "Getting Started");
	assert.deepEqual(pageFromFile("Getting-Started.md"), { slug: "Getting-Started", title: "Getting Started" });
	assert.deepEqual(pageFromFile("Notes.markdown"), { slug: "Notes", title: "Notes" });
	assert.equal(pageFromFile("logo.png"), null);
	assert.equal(pageFromFile("_Sidebar.md"), null, "the sidebar isn't a page");
	assert.equal(pageFromFile("docs/Deep.md"), null, "only the root holds pages");
	assert.ok(isSpecialFile("_Sidebar.md", "_Sidebar"));
	assert.ok(isSpecialFile("_footer.markdown", "_Footer"));
	assert.ok(!isSpecialFile("Sidebar.md", "_Sidebar"));
});

test("page titles that can't be file names are refused", () => {
	assert.equal(pageNameProblem("Getting Started"), null);
	assert.equal(pageNameProblem("Ünïcödé ok"), null);
	assert.match(pageNameProblem("") ?? "", /title/);
	assert.match(pageNameProblem("a/b") ?? "", /can't contain/);
	assert.match(pageNameProblem("What?") ?? "", /can't contain/);
	assert.match(pageNameProblem("_Sidebar") ?? "", /start with/);
	assert.match(pageNameProblem(".hidden") ?? "", /start with/);
	assert.match(pageNameProblem("Home.md") ?? "", /extension/);
	assert.match(pageNameProblem("x".repeat(201)) ?? "", /200/);
});

test("pages are found by name, exactly first and then ignoring case, and listed Home first", () => {
	const files = ["home.md", "Home.md", "Install.md", "_Sidebar.md", "logo.png"];
	assert.equal(findPageFile(files, "Home"), "Home.md");
	assert.equal(findPageFile(files, "install"), "Install.md");
	assert.equal(findPageFile(files, "Sidebar"), null);
	assert.equal(findPageFile(files, "logo"), null);
	const sorted = sortPages([{ slug: "Zeta", title: "Zeta" }, { slug: "alpha", title: "alpha" }, { slug: "Home", title: "Home" }, { slug: "Page-10", title: "Page 10" }, { slug: "Page-9", title: "Page 9" }]);
	assert.deepEqual(sorted.map((p) => p.slug), ["Home", "alpha", "Page-9", "Page-10", "Zeta"]);
});

test("[[links]] become relative links to pages, outside code", () => {
	assert.equal(wikiLinks("See [[Getting Started]]."), "See [Getting Started](Getting-Started).");
	assert.equal(wikiLinks("See [[the guide|Getting Started]]."), "See [the guide](Getting-Started).");
	assert.equal(wikiLinks("[[Install#Upgrading from 1.x]]"), "[Install#Upgrading from 1.x](Install#upgrading-from-1.x)");
	assert.equal(wikiLinks("[[megit|https://example.com/x]]"), "[megit](<https://example.com/x>)");
	assert.equal(wikiLinks("[[A [b]]"), "[[A [b]]", "brackets inside aren't a link");
	assert.equal(wikiLinks("[[C++ & You]]"), `[C++ & You](${encodeURIComponent("C++-&-You")})`);
	assert.equal(wikiLinks("`[[Not a link]]` and [[Link]]"), "`[[Not a link]]` and [Link](Link)");
	assert.equal(wikiLinks("``a ` [[x]]`` [[y]]"), "``a ` [[x]]`` [y](y)");
	const fenced = "```\n[[Code]]\n```\n[[Text]]\n~~~md\n[[Also code]]\n~~~";
	assert.equal(wikiLinks(fenced), "```\n[[Code]]\n```\n[Text](Text)\n~~~md\n[[Also code]]\n~~~");
	assert.equal(wikiLinks("no links"), "no links");
});

test("relative links in pages resolve to page names; files, folders and URLs don't", () => {
	assert.deepEqual(pageLinkTarget("Getting-Started"), { slug: "Getting-Started", fragment: null });
	assert.deepEqual(pageLinkTarget("./Getting-Started.md#setup"), { slug: "Getting-Started", fragment: "setup" });
	assert.deepEqual(pageLinkTarget("Getting%20Started"), { slug: "Getting-Started", fragment: null });
	assert.deepEqual(pageLinkTarget(encodeURIComponent("C++-&-You")), { slug: "C++-&-You", fragment: null });
	assert.equal(pageLinkTarget("logo.png"), null);
	assert.equal(pageLinkTarget("Release-1.2"), null);
	assert.deepEqual(pageLinkTarget("Release-1.2", (slug) => slug === "Release-1.2"), { slug: "Release-1.2", fragment: null }, "unless a page has that name");
	assert.equal(pageLinkTarget("docs/page"), null);
	assert.equal(pageLinkTarget("/abs"), null);
	assert.equal(pageLinkTarget("#top"), null);
	assert.equal(pageLinkTarget("https://example.com"), null);
	assert.equal(pageLinkTarget("mailto:a@b.c"), null);
	assert.equal(pageLinkTarget("%E0%A4%A"), null, "malformed escapes aren't pages");
});

test("a wiki's storage name can't be a project's or a task fork's", () => {
	assert.equal(wikiRepoName("r0123456789abcde"), "r0123456789abcde--wiki");
});
