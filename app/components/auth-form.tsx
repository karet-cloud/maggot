import { Link, useHydrated } from "@tanstack/react-router";
import type { FormEvent, ReactNode } from "react";
import { Button, ErrorNote } from "./ui.tsx";

/** The shared frame of the sign-in and sign-up pages. */
export function AuthForm({
	title,
	subtitle,
	onSubmit,
	busy,
	error,
	submit,
	footer,
	children,
}: {
	title: string;
	subtitle: string;
	onSubmit: () => void;
	busy: boolean;
	error: unknown;
	submit: string;
	footer: ReactNode;
	children: ReactNode;
}) {
	// Before hydration a submit would be the browser's own (a bare reload that loses what was typed).
	const hydrated = useHydrated();
	return (
		<main className="flex items-center justify-center px-5 py-20">
			<form
				onSubmit={(e: FormEvent) => {
					e.preventDefault();
					onSubmit();
				}}
				className="w-full max-w-sm space-y-5"
			>
				<div className="space-y-2 text-center">
					<img src="/favicon.svg" alt="" className="mx-auto size-10" />
					<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
					<p className="text-sm text-dim">{subtitle}</p>
				</div>
				{/* A disabled fieldset disables every field in it while the request is in flight. */}
				<fieldset disabled={busy} aria-busy={busy} className="space-y-3 rounded-xl border border-line bg-panel p-5 disabled:[&_input]:opacity-60">
					{children}
					<ErrorNote error={error} />
					<Button type="submit" variant="primary" busy={busy} disabled={!hydrated} className="w-full">
						{submit}
					</Button>
				</fieldset>
				<p className="text-center text-xs text-dim">{footer}</p>
			</form>
		</main>
	);
}

export const authLink = (to: "/login" | "/signup" | "/forgot-password", label: string) => (
	<Link to={to} className="text-accent hover:underline">
		{label}
	</Link>
);
