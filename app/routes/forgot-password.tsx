import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthForm, authLink } from "../components/auth-form.tsx";
import { Field, Input } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";

export const Route = createFileRoute("/forgot-password")({ component: ForgotPassword });

function ForgotPassword() {
	const [email, setEmail] = useState("");
	const config = useQuery({ queryKey: keys.config, queryFn: api.config, staleTime: Infinity });
	const request = useMutation({ mutationFn: () => api.requestPasswordReset(email.trim()) });
	if (request.isSuccess) {
		return (
			<main className="mx-auto max-w-sm px-5 py-24 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
				<p className="mt-2 text-sm text-dim">
					If an account uses <span className="text-fg">{email.trim()}</span>, a link to reset its password is on its way. It works for an
					hour.
				</p>
				<p className="mt-6 text-xs text-dim">{authLink("/login", "Back to sign in")}</p>
			</main>
		);
	}
	return (
		<AuthForm
			title="Reset your password"
			subtitle="Enter your account's email and we'll send you a link to choose a new password."
			onSubmit={() => request.mutate()}
			busy={request.isPending}
			error={request.error}
			submit="Send reset link"
			footer={<>Remembered it? {authLink("/login", "Sign in")}</>}
		>
			{config.data && !config.data.emailDelivery && (
				<p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
					This server can't send email yet. Ask its administrator for a reset link.
				</p>
			)}
			<Field label="Email">
				<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
			</Field>
		</AuthForm>
	);
}
