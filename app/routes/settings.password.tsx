import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { SettingsNav } from "../components/settings-nav.tsx";
import { Button, ErrorNote, Field, Input, Panel, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/settings/password")({ component: ChangePassword });

function ChangePassword() {
	const viewer = useViewer();
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const change = useMutation({
		mutationFn: () => {
			if (next !== confirm) throw new Error("The new passwords don't match.");
			return api.changePassword(current, next);
		},
		onSuccess: () => {
			setCurrent("");
			setNext("");
			setConfirm("");
		},
	});
	if (viewer.isPending) return <Spinner className="m-8" />;
	if (!viewer.data) {
		return (
			<main className="mx-auto max-w-md px-5 py-16 text-center text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to change your password.
			</main>
		);
	}
	return (
		<main className="mx-auto max-w-3xl space-y-5 px-5 py-8">
			<h1 className="text-lg font-semibold">Settings</h1>
			<SettingsNav />
			<Panel title="Change password">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						change.mutate();
					}}
					className="max-w-sm space-y-3 p-4"
				>
					<Field label="Current password" hint={<Link to="/forgot-password" className="text-accent hover:underline">Forgot it?</Link>}>
						<Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
					</Field>
					<Field label="New password" hint="At least 8 characters.">
						<Input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} autoComplete="new-password" required />
					</Field>
					<Field label="Confirm new password">
						<Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} autoComplete="new-password" required />
					</Field>
					<ErrorNote error={change.error} />
					{change.isSuccess && (
						<p className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
							Password changed. Other sessions were signed out; this one stays signed in.
						</p>
					)}
					<Button type="submit" variant="primary" busy={change.isPending}>
						Change password
					</Button>
				</form>
			</Panel>
		</main>
	);
}
