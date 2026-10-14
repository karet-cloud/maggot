import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, CircleDashed, CircleDot, type LucideIcon } from "lucide-react";
import { PARITY, PARITY_UPDATED, type ParityStatus } from "../lib/parity.ts";
import { cx } from "../components/ui.tsx";

type Filter = ParityStatus | "all";

// A checklist of GitHub's features and where maggot is with each, from app/lib/parity.ts.
export const Route = createFileRoute("/parity")({
	validateSearch: (s: Record<string, unknown>): { show?: ParityStatus } =>
		s.show === "done" || s.show === "partial" || s.show === "missing" || s.show === "different" ? { show: s.show } : {},
	head: () => ({ meta: [{ title: "GitHub feature parity · maggot" }] }),
	component: Parity,
});

const STATUS: Record<ParityStatus, { label: string; icon: LucideIcon; tone: string }> = {
	done: { label: "Done", icon: CheckCircle2, tone: "text-emerald-300" },
	partial: { label: "Partly", icon: CircleDot, tone: "text-amber-300" },
	missing: { label: "Not yet", icon: Circle, tone: "text-faint" },
	different: { label: "On purpose", icon: CircleDashed, tone: "text-sky-300" },
};

function Parity() {
	const { show } = Route.useSearch();
	const filter: Filter = show ?? "all";
	const all = PARITY.flatMap((s) => s.items);
	const count = (status: ParityStatus) => all.filter((i) => i.status === status).length;
	// Partly done counts as half.
	const score = Math.round(((count("done") + count("partial") / 2) / (all.length - count("different"))) * 100);

	return (
		<main className="mx-auto max-w-[900px] space-y-6 px-5 py-8">
			<header className="space-y-3">
				<h1 className="text-xl font-semibold tracking-tight">GitHub feature parity</h1>
				<p className="text-sm text-dim">
					Everything GitHub does, and how far maggot has got with each. It's updated alongside the code. Last updated {PARITY_UPDATED}.
				</p>
				<div className="space-y-1.5">
					<div className="flex h-2 overflow-hidden rounded-full bg-raised" aria-label={`${score}% of GitHub's features`}>
						<div className="bg-emerald-400" style={{ width: `${(count("done") / all.length) * 100}%` }} />
						<div className="bg-amber-400/70" style={{ width: `${(count("partial") / all.length) * 100}%` }} />
					</div>
					<p className="text-xs text-dim">
						<span className="font-semibold text-fg">{score}%</span> of the way there, counting partly done features as half: {count("done")} done,{" "}
						{count("partial")} partly done, {count("missing")} not yet, {count("different")} different on purpose.
					</p>
				</div>
				<nav className="flex flex-wrap gap-1 text-xs">
					{(["all", "done", "partial", "missing", "different"] as const).map((f) => (
						<Link
							key={f}
							to="/parity"
							search={f === "all" ? {} : { show: f }}
							className={cx("rounded-md border px-2.5 py-1", filter === f ? "border-accent bg-accent/10 text-fg" : "border-line text-dim hover:text-fg")}
						>
							{f === "all" ? `All ${all.length}` : `${STATUS[f].label} ${count(f)}`}
						</Link>
					))}
				</nav>
			</header>

			{PARITY.map((section) => {
				const items = section.items.filter((i) => filter === "all" || i.status === filter);
				if (items.length === 0) return null;
				const done = section.items.filter((i) => i.status === "done").length;
				return (
					<section key={section.title} className="rounded-lg border border-line bg-panel">
						<h2 className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-dim uppercase">
							{section.title}
							<span className="font-normal normal-case text-faint">
								{done} of {section.items.length} done
							</span>
						</h2>
						<ul className="divide-y divide-line/60">
							{items.map((item) => {
								const s = STATUS[item.status];
								return (
									<li key={item.feature} className="flex gap-3 px-4 py-2.5">
										<s.icon className={cx("mt-0.5 size-4 shrink-0", s.tone)} aria-label={s.label} />
										<div className="min-w-0">
											<p className={cx("text-sm", item.status === "missing" ? "text-dim" : "text-fg")}>
												{item.feature}
												<span className={cx("ml-2 text-[11px]", s.tone)}>{s.label}</span>
											</p>
											{item.comment && <p className="mt-0.5 text-xs text-dim">{item.comment}</p>}
										</div>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
		</main>
	);
}
