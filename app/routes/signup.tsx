import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AuthForm, authLink } from "../components/auth-form.tsx";
import { ErrorNote, Field, Input, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { ApiError } from "../lib/api-error.ts";
import { configQuery } from "../lib/queries.ts";
import { useTurnstile } from "../lib/turnstile.ts";

export const Route = createFileRoute("/signup")({
	// Invite links an admin hands out land here with the code filled in.
	validateSearch: (s: Record<string, unknown>): { invite?: string } => ({ invite: typeof s.invite === "string" && s.invite ? s.invite : undefined }),
	component: SignUpPage,
});

function SignUpPage() {
	const { invite } = Route.useSearch();
	const config = useQuery(configQuery);
	// Someone who says they have a code gets the sign-up form even when only invites get in.
	const [haveCode, setHaveCode] = useState(Boolean(invite));
	if (!config.data) {
		return (
			<main className="flex justify-center px-5 py-24">
				{config.error ? <ErrorNote error={config.error} /> : <Spinner className="size-6" />}
			</main>
		);
	}
	const { signUps, turnstileSiteKey } = config.data;
	if (signUps === "closed") {
		return (
			<Notice title="Sign-ups are closed">
				maggot isn't taking new accounts right now. Public repositories are still open to browse and clone.
			</Notice>
		);
	}
	if (signUps === "open" || haveCode) {
		return <SignUp invite={invite} needsCode={signUps !== "open"} siteKey={turnstileSiteKey} onWaitlist={() => setHaveCode(false)} />;
	}
	return <Waitlist full={signUps === "waitlist"} siteKey={turnstileSiteKey} onHaveCode={() => setHaveCode(true)} />;
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
	return (
		<main className="mx-auto max-w-sm px-5 py-24 text-center">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			<p className="mt-2 text-sm text-dim">{children}</p>
			<p className="mt-6 text-xs text-dim">Already have an account? {authLink("/login", "Sign in")}</p>
		</main>
	);
}

function SignUp({ invite, needsCode, siteKey, onWaitlist }: { invite?: string; needsCode: boolean; siteKey: string | null; onWaitlist: () => void }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const turnstile = useTurnstile(siteKey, "sign-up");
	const [form, setForm] = useState({ username: "", name: "", email: "", password: "", inviteCode: invite ?? "" });
	const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
	const showCode = needsCode || Boolean(invite);
	const signUp = useMutation({
		mutationFn: async () =>
			api.signUp({
				username: form.username.trim().toLowerCase(),
				name: form.name.trim() || form.username.trim(),
				email: form.email.trim(),
				password: form.password,
				...(showCode && form.inviteCode.trim() ? { inviteCode: form.inviteCode.trim() } : {}),
				turnstileToken: await turnstile.token(),
			}),
		onSuccess: () => {
			// Everything cached was read signed out; drop it rather than wait for every query to refetch first.
			queryClient.removeQueries();
			void navigate({ to: "/new" });
		},
		onError: (err) => {
			// The last open account went to someone else meanwhile: offer the waitlist.
			if (err instanceof ApiError && err.code === "SIGN_UPS_FULL") void queryClient.invalidateQueries({ queryKey: keys.config });
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
			footer={
				<>
					Already have an account? {authLink("/login", "Sign in")}
					{needsCode && (
						<>
							<span className="mx-1.5">·</span>
							<button type="button" onClick={onWaitlist} className="text-accent hover:underline">
								No code? Join the waitlist
							</button>
						</>
					)}
				</>
			}
		>
			{showCode && (
				<Field label="Invite code" hint={needsCode ? "New accounts need an invite code for now." : undefined}>
					<Input value={form.inviteCode} onChange={set("inviteCode")} autoComplete="off" spellCheck={false} required={needsCode} autoFocus={!form.inviteCode} />
				</Field>
			)}
			<Field label="Username" hint="Lowercase letters, digits and single hyphens. It's in your repository URLs.">
				<Input
					value={form.username}
					onChange={set("username")}
					pattern="[a-z0-9]([a-z0-9\-]{0,37}[a-z0-9])?"
					autoComplete="username"
					autoFocus={!showCode || Boolean(form.inviteCode)}
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
			<div ref={turnstile.ref} />
		</AuthForm>
	);
}

function Waitlist({ full, siteKey, onHaveCode }: { full: boolean; siteKey: string | null; onHaveCode: () => void }) {
	const turnstile = useTurnstile(siteKey, "waitlist");
	const [email, setEmail] = useState("");
	const [note, setNote] = useState("");
	const join = useMutation({ mutationFn: async () => api.joinWaitlist({ email: email.trim(), note: note.trim(), turnstileToken: await turnstile.token() }) });
	if (join.isSuccess) {
		return (
			<Notice title="You're on the waitlist">
				We'll send an invite to <span className="text-fg">{email.trim()}</span> when there's room.
			</Notice>
		);
	}
	return (
		<AuthForm
			title="Join the waitlist"
			subtitle={
				full
					? "maggot has all the accounts it can take for now. Leave your email and we'll send an invite when there's room."
					: "maggot is invite-only for now. Leave your email and we'll send you an invite."
			}
			onSubmit={() => join.mutate()}
			busy={join.isPending}
			error={join.error}
			submit={join.isPending ? "Joining…" : "Join the waitlist"}
			footer={
				<>
					Already have an account? {authLink("/login", "Sign in")}
					<span className="mx-1.5">·</span>
					<button type="button" onClick={onHaveCode} className="text-accent hover:underline">
						Have an invite code?
					</button>
				</>
			}
		>
			<Field label="Email">
				<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} autoFocus required />
			</Field>
			<Field label="What would you use maggot for?">
				<Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Optional" />
			</Field>
			<div ref={turnstile.ref} />
		</AuthForm>
	);
}
