import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { ThemeToggle } from "../ui.tsx";
import { AppDemo } from "./demos.tsx";
import { AGENT_POINTS, API_POINTS, GROUPS, STACK } from "./content.ts";

/*
 * The signed-out home page. Grey and one green; centered and typographic. The hero is the repository
 * as the app shows it, working: browse files, open issues, review a pull request. Its colours are the
 * site's own (app/styles.css), so light and dark follow the same choice as every other page.
 */

const CSS = `
.pp {
	--bg: var(--color-bg); --fg: var(--color-fg); --muted: var(--color-dim); --faint: var(--color-faint); --line: var(--color-line);
	--line-strong: var(--color-line-strong); --soft: var(--color-soft); --green: var(--color-accent); --btn: var(--color-btn);
	--btn-fg: var(--color-btn-fg); --btn-hover: var(--color-accent); --shadow: var(--shadow-frame);
	background: var(--bg); color: var(--fg);
}
.pp .mono { font-family: var(--font-mono); }
.pp .green { color: var(--green); }
.pp .muted { color: var(--muted); }
.pp .faint { color: var(--faint); }
.pp .line { border-color: var(--line); }
.pp .soft { background: var(--soft); }
.pp .btn { background: var(--btn); color: var(--btn-fg); }
.pp .btn:hover { background: var(--btn-hover); color: var(--color-on-accent); }
.pp .ghost { border: 1px solid var(--line-strong); }
.pp .ghost:hover { border-color: var(--fg); }
.pp .frame { border: 1px solid var(--line); box-shadow: var(--shadow); }
.pp .hover-fg:hover { color: var(--fg); }
.pp .divide > * + * { border-top: 1px solid var(--line); }
`;

export function Landing() {
	return (
		<div className="pp min-h-screen">
			<style>{CSS}</style>
			<header className="mx-auto flex h-16 max-w-[1080px] items-center justify-between px-5">
				<Link to="/" className="text-[15px] font-semibold">
					maggot
				</Link>
				<nav className="muted hidden items-center gap-7 text-[14px] md:flex">
					<Link to="/explore" className="hover-fg">
						Explore
					</Link>
					<a href="#features" className="hover-fg">
						Features
					</a>
					<a href="#cloudflare" className="hover-fg">
						Cloudflare
					</a>
					<a href="#api" className="hover-fg">
						API
					</a>
				</nav>
				<div className="flex items-center gap-1">
					<ThemeToggle />
					<Link to="/login" className="muted hover-fg px-3 py-1.5 text-[13.5px]">
						Sign in
					</Link>
					<Link to="/signup" className="btn rounded-md px-3.5 py-1.5 text-[13.5px] font-semibold">
						Sign up
					</Link>
				</div>
			</header>

			<section className="mx-auto max-w-[1080px] px-5 pt-20 pb-16 text-center">
				<h1 className="mx-auto max-w-[20ch] text-[42px] leading-[1.05] font-semibold tracking-[-0.03em] sm:text-[60px]">
					Git hosting, the familiar kind, on Cloudflare.
				</h1>
				<p className="muted mx-auto mt-6 max-w-[58ch] text-[17px] leading-relaxed">
					Repositories, pull requests, review, Actions, wikis and organizations, served by a single Cloudflare Worker. Push with git over HTTPS
					or SSH. Deploy it to your own account, or run it on your laptop.
				</p>
				<div className="mt-8 flex flex-wrap justify-center gap-3">
					<Link to="/signup" className="btn flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold">
						Create a repository <ArrowRight className="size-4" />
					</Link>
					<Link to="/explore" className="ghost rounded-md px-5 py-2.5 text-sm">
						Explore repositories
					</Link>
				</div>
				<div className="mx-auto mt-16 max-w-[1000px]">
					<p className="faint mb-3 text-[13px]">Browse a cached Linux kernel preview. Open files in the public mirror, or try the demo issue and review.</p>
					<div className="frame rounded-xl">
						<AppDemo />
					</div>
				</div>
			</section>

			<section id="features" className="line border-t">
				<div className="mx-auto max-w-[1080px] px-5 py-24">
					<div className="mx-auto max-w-[60ch] text-center">
						<h2 className="text-3xl font-semibold tracking-tight">Everything a team uses every day</h2>
						<p className="muted mt-3 text-[15px]">Nothing to relearn: the workflows your team already has. The list below is complete, not a highlight reel.</p>
					</div>
					<div className="mt-14 grid gap-x-12 gap-y-12 md:grid-cols-2">
						{GROUPS.map((g) => (
							<div key={g.key}>
								<h3 className="text-[20px] font-semibold">{g.title}</h3>
								<p className="muted mt-1 text-[14px]">{g.lead}</p>
								<ul className="divide mt-4 text-[14px]">
									{g.items.map((it) => (
										<li key={it} className="flex gap-2.5 py-2">
											<CheckCircle2 className="green mt-0.5 size-4 shrink-0" />
											{it}
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</div>
			</section>

			<section id="cloudflare" className="soft">
				<div className="mx-auto max-w-[1080px] px-5 py-24">
					<div className="grid grid-cols-1 gap-12 lg:grid-cols-2">
						<div>
							<h2 className="text-3xl font-semibold tracking-tight">Runs entirely on Cloudflare</h2>
							<p className="muted mt-4 text-[15px] leading-relaxed">
								One Worker serves git, SSH, the API and the web UI. Deploy it to your account with the Cloudflare CLI, or run the complete
								stack locally with no account at all.
							</p>
							<pre className="mono mt-6 block max-w-full overflow-x-auto rounded-lg border px-4 py-3 text-[12.5px] leading-6" style={{ borderColor: "var(--line)", background: "var(--bg)" }}>
								<span className="green">$ </span>npm run dev <span className="faint"># local, no account</span>
								{"\n"}
								<span className="green">$ </span>cf deploy <span className="faint"># your Cloudflare account</span>
							</pre>
						</div>
						<ul className="space-y-3 text-[14px]">
							{STACK.map((s) => (
								<li key={s.name} className="frame flex gap-3 rounded-lg px-4 py-3" style={{ background: "var(--bg)" }}>
									<span className="mono w-36 shrink-0">{s.name}</span>
									<span className="muted">{s.role}</span>
								</li>
							))}
						</ul>
					</div>
				</div>
			</section>

			<section id="api" className="mx-auto max-w-[1080px] px-5 py-24">
				<div className="grid gap-5 md:grid-cols-2">
					<div className="frame rounded-xl p-6">
						<h3 className="text-[18px] font-semibold">Built on its own API</h3>
						<ul className="muted mt-3 space-y-2 text-[14px]">
							{API_POINTS.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					</div>
					<div className="frame rounded-xl p-6">
						<h3 className="text-[18px] font-semibold">Optional: an agent layer</h3>
						<ul className="muted mt-3 space-y-2 text-[14px]">
							{AGENT_POINTS.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					</div>
				</div>
			</section>

			<section className="line border-t">
				<div className="mx-auto max-w-[1080px] px-5 py-20 text-center">
					<h2 className="text-3xl font-semibold tracking-tight">Create a repository</h2>
					<p className="muted mt-3 text-[14px]">A username, an email and a password. Then a token or an SSH key, and git does the rest.</p>
					<div className="mt-7 flex flex-wrap justify-center gap-3">
						<Link to="/signup" className="btn rounded-md px-5 py-2.5 text-sm font-semibold">
							Sign up
						</Link>
						<Link to="/login" className="ghost rounded-md px-5 py-2.5 text-sm">
							Sign in
						</Link>
					</div>
				</div>
			</section>

			<footer className="faint line mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-3 border-t px-5 py-8 text-[12.5px]">
				<span className="font-semibold" style={{ color: "var(--fg)" }}>
					maggot
				</span>
				<span className="flex flex-wrap items-center gap-5">
					<Link to="/explore" className="hover-fg">
						Explore
					</Link>
					<span>Git hosting on Cloudflare.</span>
				</span>
			</footer>
		</div>
	);
}
