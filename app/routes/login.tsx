import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthForm, authLink } from "../components/auth-form.tsx";
import { Field, Input } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

export const Route = createFileRoute("/login")({
	validateSearch: (s: Record<string, unknown>): { reset?: boolean } => ({ reset: s.reset === true || s.reset === "1" ? true : undefined }),
	component: Login,
});

function Login() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { reset } = Route.useSearch();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const signIn = useMutation({
		mutationFn: () => api.signIn({ username: username.trim().toLowerCase(), password }),
		onSuccess: async () => {
			await queryClient.resetQueries();
			void navigate({ to: "/" });
		},
	});
	return (
		<AuthForm
			title="Sign in to megit"
			subtitle="Browse, push and review your repositories."
			onSubmit={() => signIn.mutate()}
			busy={signIn.isPending}
			error={signIn.error}
			submit="Sign in"
			footer={<>New here? {authLink("/signup", "Create an account")}</>}
		>
			<Field label="Username">
				<Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
			</Field>
			<Field
				label="Password"
				hint={
					<Link to="/forgot-password" className="text-accent hover:underline">
						Forgot your password?
					</Link>
				}
			>
				<Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
			</Field>
			{reset && <p className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">Password changed. Sign in with the new one.</p>}
		</AuthForm>
	);
}
