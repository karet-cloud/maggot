import { useHydrated } from "@tanstack/react-router";
import { Check, Copy, LoaderCircle, Moon, Sun, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import type { TaskStatus } from "../lib/api.ts";
import { errorMessage, shortOid, STATUS, timeAgo } from "../lib/format.ts";
import { currentTheme, saveTheme } from "../lib/theme.ts";

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

export function StatusBadge({ status }: { status: TaskStatus }) {
	const s = STATUS[status];
	return (
		<span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", s.ring, s.text)}>
			<span className={cx("size-1.5 rounded-full", s.dot, status === "merging" || status === "provisioning" ? "animate-pulse-dot" : "")} />
			{s.label}
		</span>
	);
}

/**
 * A relative time. Server-rendered pages (and the browser's first pass over them) show the UTC date,
 * which both sides agree on; it turns relative once hydrated, in the visitor's own clock and locale.
 */
export function TimeAgo({ at, className }: { at: string | number; className?: string }) {
	const hydrated = useHydrated();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(t);
	}, []);
	const date = new Date(typeof at === "number" ? at * 1000 : at);
	return (
		<time dateTime={date.toISOString()} title={hydrated ? date.toLocaleString() : undefined} className={className}>
			{hydrated ? timeAgo(at, now) : date.toISOString().slice(0, 10)}
		</time>
	);
}

export function useCopy() {
	const [copied, setCopied] = useState(false);
	const copy = (text: string) => {
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		});
	};
	return { copied, copy };
}

export function Oid({ oid, className }: { oid: string | null | undefined; className?: string }) {
	const { copied, copy } = useCopy();
	if (!oid) return <span className={cx("font-mono text-faint", className)}>—</span>;
	return (
		<button
			type="button"
			onClick={() => copy(oid)}
			title={copied ? "Copied" : `${oid} (click to copy)`}
			className={cx("font-mono text-[12px] text-dim hover:text-fg transition-colors", copied && "text-emerald-300", className)}
		>
			{shortOid(oid)}
		</button>
	);
}

export function CopyField({ value, secret }: { value: string; secret?: string }) {
	const { copied, copy } = useCopy();
	const shown = secret ? value.replaceAll(secret, "•".repeat(12)) : value;
	return (
		<div className="flex items-stretch overflow-hidden rounded-md border border-line bg-bg">
			<code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-3 py-2 font-mono text-[12px] text-dim">{shown}</code>
			<button
				type="button"
				onClick={() => copy(value)}
				className="flex shrink-0 items-center gap-1.5 border-l border-line px-3 text-xs text-dim hover:bg-raised hover:text-fg"
			>
				{copied ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />}
				{copied ? "Copied" : "Copy"}
			</button>
		</div>
	);
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

/** A button's look, for links that act as buttons too. Primary is the landing page's: ink, turning green. */
export const buttonClass = (variant: Variant = "secondary", className?: string) =>
	cx(
		"inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
		variant === "primary" && "bg-btn font-semibold text-btn-fg hover:bg-accent hover:text-on-accent",
		variant === "secondary" && "border border-line-strong bg-panel text-fg hover:border-fg",
		variant === "ghost" && "text-dim hover:bg-raised hover:text-fg",
		variant === "danger" && "border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20",
		className,
	);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean };

export function Button({ variant = "secondary", busy, className, children, disabled, ...rest }: ButtonProps) {
	return (
		<button type="button" disabled={disabled || busy} className={buttonClass(variant, className)} {...rest}>
			{busy && <LoaderCircle className="size-3.5 animate-spin" />}
			{children}
		</button>
	);
}

/**
 * Switches between light and dark; the choice applies to every page. The icon follows `.dark` on <html>
 * in CSS, so it's right from the first paint and whenever another tab or the system changes the theme.
 */
export function ThemeToggle() {
	return (
		<button
			type="button"
			onClick={() => saveTheme(currentTheme() === "dark" ? "light" : "dark")}
			className="rounded-md p-2 text-dim hover:bg-raised hover:text-fg"
			title="Switch between light and dark"
			aria-label="Switch between light and dark"
		>
			<Moon className="size-4 [.dark_&]:hidden" />
			<Sun className="hidden size-4 [.dark_&]:block" />
		</button>
	);
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="block space-y-1.5">
			<span className="text-xs font-medium text-dim">{label}</span>
			{children}
			{hint && <span className="block text-[11px] text-faint">{hint}</span>}
		</label>
	);
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			className={cx(
				"w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none",
				className,
			)}
			{...rest}
		/>
	);
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);
	return (
		<dialog
			ref={ref}
			onClose={onClose}
			onClick={(e) => e.target === ref.current && onClose()}
			className="m-auto w-full max-w-lg rounded-xl border border-line bg-panel p-0 text-fg shadow-(--shadow-frame) backdrop:bg-black/50 backdrop:backdrop-blur-sm"
		>
			<div className="flex items-center justify-between border-b border-line px-5 py-3.5">
				<h2 className="text-[15px] font-semibold">{title}</h2>
				<button type="button" onClick={onClose} className="rounded p-1 text-faint hover:bg-raised hover:text-fg" aria-label="Close">
					<X className="size-4" />
				</button>
			</div>
			<div className="p-5">{open && children}</div>
		</dialog>
	);
}

export function ErrorNote({ error }: { error: unknown }) {
	if (!error) return null;
	return <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{errorMessage(error)}</p>;
}

export function Spinner({ className }: { className?: string }) {
	return <LoaderCircle className={cx("size-4 animate-spin text-faint", className)} />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
			{icon && <div className="text-faint">{icon}</div>}
			<p className="text-[15px] font-semibold text-fg">{title}</p>
			{children && <div className="max-w-md text-[13px] text-dim">{children}</div>}
		</div>
	);
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={cx("rounded-xl border border-line bg-panel", className)}>
			{(title || actions) && (
				<header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5">
					<h3 className="min-w-0 text-[13px] font-semibold break-all text-fg">{title}</h3>
					{actions}
				</header>
			)}
			{children}
		</section>
	);
}

export { shortOid };
