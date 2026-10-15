import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthForm, authLink } from "../components/auth-form.tsx";
import { Field, Input } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

// The emailed link goes through /api/auth/reset-password/<token>, which checks the token and lands
// here with ?token=… (or ?error=INVALID_TOKEN when it's expired or already used).
export const Route = createFileRoute("/reset-password")({
	validateSearch: (s: Record<string, unknown>): { token?: string; error?: string } => ({
		token: typeof s.token === "string" ? s.token : undefined,
		error: typeof s.error === "string" ? s.error : undefined,
	}),
	component: ResetPassword,
});

function ResetPassword() {
	const { token, error } = Route.useSearch();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const reset = useMutation({
		mutationFn: () => {
			if (password !== confirm) throw new Error("The passwords don't match.");
			return api.resetPassword(token as string, password);
		},
		// The reset signed this browser out too (every session is revoked), so forget the cached user.
		onSuccess: async () => {
			await queryClient.resetQueries();
			void navigate({ to: "/login", search: { reset: true } });
		},
	});
	if (!token || error) {
		return (
			<main className="mx-auto max-w-sm px-5 py-24 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">This reset link doesn't work</h1>
				<p className="mt-2 text-sm text-dim">It may have expired (links last an hour) or already been used.</p>
				<p className="mt-6 text-xs text-dim">{authLink("/forgot-password", "Get a new link")}</p>
			</main>
		);
	}
	return (
		<AuthForm
			title="Choose a new password"
			subtitle="You'll be signed out everywhere else. Personal access tokens keep working."
			onSubmit={() => reset.mutate()}
			busy={reset.isPending}
			error={reset.error}
			submit="Change password"
			footer={authLink("/login", "Back to sign in")}
		>
			<Field label="New password" hint="At least 8 characters.">
				<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" autoFocus required />
			</Field>
			<Field label="Confirm it">
				<Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} autoComplete="new-password" required />
			</Field>
		</AuthForm>
	);
}
