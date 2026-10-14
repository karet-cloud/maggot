import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { AppDemo } from "./demos.tsx";
import { AGENT_POINTS, API_POINTS, GROUPS, STACK } from "./content.ts";

/*
 * The signed-out home page. Grey and one green; centered and typographic. The hero is the repository
 * as the app shows it, working: browse files, open issues, review a pull request. Light or dark,
 * following the system unless the visitor picks one.
 */

const DARK = `
	--bg: #0b0d10; --fg: #e6e8eb; --muted: #9aa3ad; --faint: #6b7480; --line: #232830; --line-strong: #2f3540; --soft: #111418;
	--green: #4ade80; --btn: #e6e8eb; --btn-fg: #0b0d10; --btn-hover: #4ade80; --shadow: 0 1px 0 rgba(0,0,0,0.3), 0 24px 48px -32px rgba(0,0,0,0.8);
	color-scheme: dark;`;

const CSS = `
.pp {
	--bg: #ffffff; --fg: #0f1115; --muted: #4b5563; --faint: #6b7280; --line: #e4e7eb; --line-strong: #d9dde3; --soft: #f8f9fa;
	--green: #15803d; --btn: #0f1115; --btn-fg: #ffffff; --btn-hover: #15803d; --shadow: 0 1px 0 rgba(15,17,21,0.04), 0 24px 48px -32px rgba(15,17,21,0.25);
	color-scheme: light;
	background: var(--bg); color: var(--fg); font-family: "Instrument Sans", "Inter", ui-sans-serif, system-ui, sans-serif;
}
.pp.dark { ${DARK} }
@media (prefers-color-scheme: dark) { .pp:not(.light) { ${DARK} } }
.pp .mono { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; }
.pp .green { color: var(--green); }
.pp .muted { color: var(--muted); }
.pp .faint { color: var(--faint); }
.pp .line { border-color: var(--line); }
.pp .soft { background: var(--soft); }
.pp .btn { background: var(--btn); color: var(--btn-fg); }
.pp .btn:hover { background: var(--btn-hover); color: #fff; }
.pp .ghost { border: 1px solid var(--line-strong); }
.pp .ghost:hover { border-color: var(--fg); }
.pp .frame { border: 1px solid var(--line); box-shadow: var(--shadow); }
.pp .hover-fg:hover { color: var(--fg); }
.pp .divide > * + * { border-top: 1px solid var(--line); }
`;

type Theme = "light" | "dark";
const THEME_KEY = "maggot.landing.theme";

/** The visitor's choice, if they made one; otherwise the page follows the system. */
function useTheme(): [Theme | null, (t: Theme | null) => void] {
	const [theme, setTheme] = useState<Theme | null>(null);
	useEffect(() => {
		const saved = localStorage.getItem(THEME_KEY);
		if (saved === "light" || saved === "dark") setTheme(saved);
	}, []);
	return [
		theme,
		(t) => {
			setTheme(t);
			if (t) localStorage.setItem(THEME_KEY, t);
			else localStorage.removeItem(THEME_KEY);
		},
	];
}

function ThemeToggle({ theme, onChange }: { theme: Theme | null; onChange: (t: Theme | null) => void }) {
	// What's showing right now, so the button offers the other one.
	const [system, setSystem] = useState<Theme>("light");
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const sync = () => setSystem(mq.matches ? "dark" : "light");
		sync();
		mq.addEventListener("change", sync);
		return () => mq.removeEventListener("change", sync);
	}, []);
	const current = theme ?? system;
	return (
		<button
			type="button"
			onClick={() => onChange(current === "dark" ? "light" : "dark")}
			className="muted hover-fg rounded-md p-2"
			title={current === "dark" ? "Switch to light" : "Switch to dark"}
			aria-label={current === "dark" ? "Switch to light" : "Switch to dark"}
		>
			{current === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
		</button>
	);
}

export function Landing() {
	const [theme, setTheme] = useTheme();
	return (
		<div className={`pp min-h-screen ${theme ?? ""}`}>
			<style>{CSS}</style>
			<header className="mx-auto flex h-16 max-w-[1080px] items-center justify-between px-5">
				<Link to="/" className="text-[15px] font-semibold">
					maggot
				</Link>
				<nav className="muted hidden items-center gap-7 text-[14px] md:flex">
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
					<ThemeToggle theme={theme} onChange={setTheme} />
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
					<a href="#features" className="ghost rounded-md px-5 py-2.5 text-sm">
						See what's included
					</a>
				</div>
				<div className="mx-auto mt-16 max-w-[1000px]">
					<p className="faint mb-3 text-[13px]">The app, live: browse the files, open an issue, review pull request #48. Nothing here is a picture.</p>
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
				<span>Git hosting on Cloudflare.</span>
			</footer>
		</div>
	);
}
