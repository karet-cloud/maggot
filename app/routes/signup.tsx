import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthForm, authLink } from "../components/auth-form.tsx";
import { Field, Input } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { configQuery } from "../lib/queries.ts";

export const Route = createFileRoute("/signup")({
	// Invite links an admin hands out land here with the code filled in.
	validateSearch: (s: Record<string, unknown>): { invite?: string } => ({ invite: typeof s.invite === "string" && s.invite ? s.invite : undefined }),
	component: SignUp,
});

function SignUp() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { invite } = Route.useSearch();
	const config = useQuery(configQuery);
	const mode = config.data?.signUps;
	const [form, setForm] = useState({ username: "", name: "", email: "", password: "", inviteCode: invite ?? "" });
	const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
	const signUp = useMutation({
		mutationFn: () =>
			api.signUp({
				username: form.username.trim().toLowerCase(),
				name: form.name.trim() || form.username.trim(),
				email: form.email.trim(),
				password: form.password,
				...(mode === "invite" ? { inviteCode: form.inviteCode.trim() } : {}),
			}),
		onSuccess: () => {
			// Everything cached was read signed out; drop it rather than wait for every query to refetch first.
			queryClient.removeQueries();
			void navigate({ to: "/new" });
		},
	});
	if (mode === "closed") {
		return (
			<main className="mx-auto max-w-sm px-5 py-24 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">Sign-ups are closed</h1>
				<p className="mt-2 text-sm text-dim">maggot isn't taking new accounts right now. Public repositories are still open to browse and clone.</p>
				<p className="mt-6 text-xs text-dim">Already have an account? {authLink("/login", "Sign in")}</p>
			</main>
		);
	}
	return (
		<AuthForm
			title="Create your account"
			subtitle="Host repositories, push with plain git, and let agents work on them."
			onSubmit={() => signUp.mutate()}
			busy={signUp.isPending}
			error={signUp.error}
			submit={signUp.isPending ? "Creating account…" : "Create account"}
			footer={<>Already have an account? {authLink("/login", "Sign in")}</>}
		>
			{mode === "invite" && (
				<Field label="Invite code" hint="maggot is invite-only for now. Ask its administrator for a code.">
					<Input value={form.inviteCode} onChange={set("inviteCode")} autoComplete="off" spellCheck={false} required />
				</Field>
			)}
			<Field label="Username" hint="Lowercase letters, digits and single hyphens. It's in your repository URLs.">
				<Input
					value={form.username}
					onChange={set("username")}
					pattern="[a-z0-9]([a-z0-9\-]{0,37}[a-z0-9])?"
					autoComplete="username"
					autoFocus
					required
				/>
			</Field>
			<Field label="Name">
				<Input value={form.name} onChange={set("name")} autoComplete="name" placeholder="Optional" />
			</Field>
			<Field label="Email">
				<Input type="email" value={form.email} onChange={set("email")} autoComplete="email" required />
			</Field>
			<Field label="Password" hint="At least 8 characters.">
				<Input type="password" value={form.password} onChange={set("password")} minLength={8} autoComplete="new-password" required />
			</Field>
		</AuthForm>
	);
}
