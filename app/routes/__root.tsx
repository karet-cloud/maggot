/// <reference types="vite/client" />
import { QueryClientProvider, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts, useParams } from "@tanstack/react-router";
import { KeyRound, LogOut } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, ErrorNote, Input, Spinner } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import css from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "megit" },
			{ name: "description", content: "A Git platform for many concurrent agents, on Cloudflare Artifacts." },
		],
		links: [
			{ rel: "stylesheet", href: css },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
		],
	}),
	shellComponent: Shell,
	component: Root,
	notFoundComponent: () => (
		<div className="mx-auto max-w-md py-24 text-center">
			<p className="text-sm text-dim">Nothing here.</p>
			<Link to="/" className="mt-3 inline-block text-sm text-accent hover:underline">
				Back to projects
			</Link>
		</div>
	),
});

function Shell({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body className="min-h-screen">
				{children}
				<Scripts />
			</body>
		</html>
	);
}

function Root() {
	const { queryClient } = Route.useRouteContext();
	return (
		<QueryClientProvider client={queryClient}>
			<AuthGate>
				<TopBar />
				<Outlet />
			</AuthGate>
		</QueryClientProvider>
	);
}

function TopBar() {
	const params = useParams({ strict: false }) as { project?: string };
	const queryClient = useQueryClient();
	const logout = useMutation({
		mutationFn: api.logout,
		onSuccess: () => queryClient.resetQueries(),
	});
	return (
		<header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
			<div className="mx-auto flex h-12 max-w-[1600px] items-center gap-3 px-5">
				<Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
					<img src="/favicon.svg" alt="" className="size-6" />
					megit
				</Link>
				{params.project && (
					<>
						<span className="text-faint">/</span>
						<Link to="/p/$project" params={{ project: params.project }} className="font-mono text-sm text-fg hover:text-accent">
							{params.project}
						</Link>
					</>
				)}
				<div className="ml-auto">
					<Button variant="ghost" onClick={() => logout.mutate()} className="text-xs">
						<LogOut className="size-3.5" />
						Sign out
					</Button>
				</div>
			</div>
		</header>
	);
}

function AuthGate({ children }: { children: ReactNode }) {
	const session = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: Infinity, retry: false });
	if (session.isPending) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<Spinner />
			</div>
		);
	}
	if (session.error instanceof ApiError && session.error.status === 401) return <Login />;
	if (session.error) {
		return (
			<div className="mx-auto max-w-md py-24">
				<ErrorNote error={session.error} />
			</div>
		);
	}
	return children;
}

function Login() {
	const queryClient = useQueryClient();
	const [key, setKey] = useState("");
	const login = useMutation({
		mutationFn: (k: string) => api.login(k),
		onSuccess: () => queryClient.resetQueries(),
	});
	// The local stack (`npm run dev`) always uses the key "dev"; sign in with it silently so local
	// development skips this screen. Against a real deployment this just fails and the form shows.
	const [tryingDev, setTryingDev] = useState(true);
	useEffect(() => {
		api.login("dev").then(
			() => queryClient.resetQueries(),
			() => setTryingDev(false),
		);
	}, [queryClient]);
	if (tryingDev) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<Spinner />
			</div>
		);
	}
	return (
		<div className="flex min-h-screen items-center justify-center px-5">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					login.mutate(key.trim());
				}}
				className="w-full max-w-sm space-y-5"
			>
				<div className="space-y-2 text-center">
					<img src="/favicon.svg" alt="" className="mx-auto size-10" />
					<h1 className="text-lg font-semibold">megit</h1>
					<p className="text-sm text-dim">Git for hundreds of agents at once, on Cloudflare Artifacts.</p>
				</div>
				<div className="space-y-3 rounded-xl border border-line bg-panel p-5">
					<label className="block space-y-1.5">
						<span className="text-xs font-medium text-dim">API key</span>
						<Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="MEGIT_API_KEY" autoFocus required />
					</label>
					<ErrorNote error={login.error} />
					<Button type="submit" variant="primary" busy={login.isPending} className="w-full">
						<KeyRound className="size-4" />
						Sign in
					</Button>
				</div>
				<p className="text-center text-[11px] text-faint">Local dev key is "dev". In production it's in .secrets/prod.env.</p>
			</form>
		</div>
	);
}
