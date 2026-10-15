import type { TaskStatus } from "./api.ts";

export const shortOid = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : "—");

export function timeAgo(at: string | number, now = Date.now()): string {
	const ms = typeof at === "number" ? at * 1000 : Date.parse(at);
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 5) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d}d ago`;
	return new Date(ms).toLocaleDateString();
}

export function duration(from: string, to: string): string {
	const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const STATUS: Record<TaskStatus, { label: string; dot: string; text: string; ring: string }> = {
	provisioning: { label: "Forking", dot: "bg-violet-400", text: "text-violet-300", ring: "ring-violet-400/30 bg-violet-400/10" },
	open: { label: "Open", dot: "bg-sky-400", text: "text-sky-300", ring: "ring-sky-400/30 bg-sky-400/10" },
	queued: { label: "Queued", dot: "bg-amber-400", text: "text-amber-300", ring: "ring-amber-400/30 bg-amber-400/10" },
	merging: { label: "Merging", dot: "bg-orange-400", text: "text-orange-300", ring: "ring-orange-400/40 bg-orange-400/10" },
	merged: { label: "Merged", dot: "bg-emerald-400", text: "text-emerald-300", ring: "ring-emerald-400/30 bg-emerald-400/10" },
	conflict: { label: "Conflict", dot: "bg-rose-400", text: "text-rose-300", ring: "ring-rose-400/40 bg-rose-400/10" },
	failed: { label: "Failed", dot: "bg-red-500", text: "text-red-300", ring: "ring-red-500/40 bg-red-500/10" },
	abandoned: { label: "Abandoned", dot: "bg-zinc-500", text: "text-zinc-400", ring: "ring-zinc-500/30 bg-zinc-500/10" },
};

/** Never empty, so an error box always says something. */
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err ?? "")) || "Something went wrong; try again";

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
	return `${+(n / 1024 ** 3).toFixed(1)} GB`;
}
