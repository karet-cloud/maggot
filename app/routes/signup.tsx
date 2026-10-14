import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthForm, authLink } from "../components/auth-form.tsx";
import { Field, Input } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

export const Route = createFileRoute("/signup")({ component: SignUp });

function SignUp() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [form, setForm] = useState({ username: "", name: "", email: "", password: "" });
	const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
	const signUp = useMutation({
		mutationFn: () =>
			api.signUp({
				username: form.username.trim().toLowerCase(),
				name: form.name.trim() || form.username.trim(),
				email: form.email.trim(),
				password: form.password,
			}),
		onSuccess: () => {
			// Everything cached was read signed out; drop it rather than wait for every query to refetch first.
			queryClient.removeQueries();
			void navigate({ to: "/new" });
		},
	});
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
