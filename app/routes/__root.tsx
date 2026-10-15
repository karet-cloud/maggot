/// <reference types="vite/client" />
import { QueryClientProvider, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Bell, KeyRound, LogOut, MailWarning, Plus, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, buttonClass, ThemeToggle } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { THEME_SCRIPT } from "../lib/theme.ts";
import css from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "maggot" },
			{ name: "description", content: "Git hosting for people and many concurrent agents, on Cloudflare Artifacts." },
		],
		links: [
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{ rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
			{ rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" },
			{ rel: "stylesheet", href: css },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
		],
	}),
	shellComponent: Shell,
	component: Root,
	notFoundComponent: () => (
		<div className="mx-auto max-w-md px-5 py-28 text-center">
			<h1 className="text-3xl font-semibold tracking-tight">Nothing here</h1>
			<p className="mt-3 text-[15px] text-dim">The page you followed doesn't exist, or you can't see it.</p>
			<Link to="/" className={buttonClass("primary", "mt-7 px-5 py-2.5")}>
				Back home
			</Link>
		</div>
	),
});

function Shell({ children }: { children: ReactNode }) {
	return (
		// The theme script sets <html>'s class before React hydrates, so the server's lack of one isn't a mismatch.
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* A constant script, so the first paint is already in the right theme. */}
				<script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
				<HeadContent />
			</head>
			<body className="flex min-h-screen flex-col">
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
			<Frame />
		</QueryClientProvider>
	);
}

/** The top bar, banners and footer, except on the signed-out home page, which brings its own. */
function Frame() {
	const home = useLocation({ select: (l) => l.pathname === "/" });
	const viewer = useViewer();
	const landing = home && !viewer.data;
	return (
		<>
			{!landing && <TopBar />}
			{!landing && <VerifyBanner />}
			<div className="flex-1">
				<Outlet />
			</div>
			{!landing && <Footer />}
		</>
	);
}

/** The landing page's footer, for every other page. */
function Footer() {
	return (
		<footer className="mt-16 border-t border-line">
			<div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-5 py-8 text-[12.5px] text-faint">
				<Link to="/" className="font-semibold text-fg">
					maggot
				</Link>
				<nav className="flex flex-wrap items-center gap-5">
					<Link to="/explore" className="hover:text-fg">
						Explore
					</Link>
					<Link to="/parity" className="hover:text-fg">
						GitHub parity
					</Link>
					<span>Git hosting on Cloudflare.</span>
				</nav>
			</div>
		</footer>
	);
}

/** The signed-in user, or null. Shared by every page through the query cache. */
export function useViewer() {
	return useQuery({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000 });
}

export function useConfig() {
	return useQuery({ queryKey: keys.config, queryFn: api.config, staleTime: Infinity });
}

/** Whether the signed-in user still has to verify their email before creating or pushing. */
export function useNeedsVerification(): boolean {
	const me = useViewer().data;
	const config = useConfig().data;
	return Boolean(me && !me.emailVerified && config?.verificationRequired);
}

function VerifyBanner() {
	const me = useViewer().data;
	const config = useConfig().data;
	const needed = useNeedsVerification();
	const resend = useMutation({ mutationFn: () => api.resendVerification(me?.email ?? "") });
	if (!needed || !me || !config) return null;
	return (
		<div className="border-b border-amber-400/20 bg-amber-400/10">
			<div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 text-xs text-amber-200">
				<MailWarning className="size-4 shrink-0" />
				<span>
					Verify your email address to create repositories and push.{" "}
					{config.emailDelivery ? (
						<>
							We sent a link to <span className="font-medium text-amber-100">{me.email}</span>.
						</>
					) : (
						"This server can't send email yet, so ask its administrator for a verification link."
					)}
				</span>
				{config.emailDelivery && (
					<button
						type="button"
						onClick={() => resend.mutate()}
						disabled={resend.isPending || resend.isSuccess}
						className="ml-auto rounded-md px-2 py-1 font-medium text-amber-100 hover:bg-amber-400/10 disabled:opacity-60"
					>
						{resend.isSuccess ? "Sent" : resend.isError ? "Couldn't send; try again" : "Resend the email"}
					</button>
				)}
			</div>
		</div>
	);
}

/** Searches repositories from anywhere; the results page refines it. */
function SearchBox() {
	const navigate = useNavigate();
	const [q, setQ] = useState("");
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void navigate({ to: "/search", search: { q: q.trim() || undefined } });
				setQ("");
			}}
			className="relative mr-1 hidden md:block"
		>
			<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
			<input
				value={q}
				onChange={(e) => setQ(e.target.value)}
				placeholder="Search repositories"
				aria-label="Search repositories"
				className="h-8 w-56 rounded-md border border-line-strong bg-bg pr-2 pl-8 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
			/>
		</form>
	);
}

function NotificationBell() {
	const unread = useQuery({ queryKey: [...keys.notifications, "unread"], queryFn: () => api.notifications(true), refetchInterval: 60_000 });
	const count = unread.data?.unread ?? 0;
	return (
		<Link
			to="/notifications"
			className="relative flex items-center rounded-md px-2 py-1.5 text-dim hover:bg-raised hover:text-fg"
			title={count ? `${count} unread notifications` : "Notifications"}
		>
			<Bell className="size-4" />
			{count > 0 && (
				<span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-on-accent">
					{count > 99 ? "99+" : count}
				</span>
			)}
		</Link>
	);
}

function TopBar() {
	const params = useParams({ strict: false }) as { owner?: string; repo?: string };
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const viewer = useViewer();
	const signOut = useMutation({
		mutationFn: api.signOut,
		onSuccess: async () => {
			await queryClient.resetQueries();
			void navigate({ to: "/" });
		},
	});
	const me = viewer.data;
	return (
		// 56px plus its border: --header-h in styles.css, which sticky elements below it use.
		<header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
			<div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 sm:px-5">
				<Link to="/" className="shrink-0 text-[15px] font-semibold">
					maggot
				</Link>
				{params.owner && (
					<nav className="hidden min-w-0 items-center gap-1.5 font-mono text-sm sm:flex">
						<span className="text-faint">/</span>
						<Link to="/$owner" params={{ owner: params.owner }} className="truncate text-dim hover:text-fg">
							{params.owner}
						</Link>
						{params.repo && (
							<>
								<span className="text-faint">/</span>
								<Link to="/$owner/$repo" params={{ owner: params.owner, repo: params.repo }} className="truncate font-semibold text-fg hover:text-accent">
									{params.repo}
								</Link>
							</>
						)}
					</nav>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<Link to="/explore" className="hidden rounded-md px-2.5 py-1.5 text-[13.5px] text-dim hover:text-fg sm:block">
						Explore
					</Link>
					{me && (
						<Link to="/parity" className="hidden rounded-md px-2.5 py-1.5 text-[13.5px] text-dim hover:text-fg lg:block">
							GitHub parity
						</Link>
					)}
					<SearchBox />
					<ThemeToggle />
					<Link to="/search" className="rounded-md p-2 text-dim hover:bg-raised hover:text-fg md:hidden" title="Search repositories">
						<Search className="size-4" />
					</Link>
					{viewer.isPending ? null : me ? (
						<>
							<NotificationBell />
							<Link to="/new" className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-dim hover:bg-raised hover:text-fg">
								<Plus className="size-3.5" />
								<span className="hidden sm:inline">New repository</span>
							</Link>
							<Link to="/settings/tokens" className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-dim hover:bg-raised hover:text-fg">
								<KeyRound className="size-3.5" />
								<span className="hidden sm:inline">Settings</span>
							</Link>
							<Link to="/$owner" params={{ owner: me.username }} className="max-w-28 truncate rounded-md px-2.5 py-1.5 font-mono text-[13px] text-fg hover:bg-raised">
								{me.username}
							</Link>
							<Button variant="ghost" onClick={() => signOut.mutate()} className="px-2" title="Sign out" aria-label="Sign out">
								<LogOut className="size-3.5" />
							</Button>
						</>
					) : (
						<>
							<Link to="/login" className="px-3 py-1.5 text-[13.5px] text-dim hover:text-fg">
								Sign in
							</Link>
							<Link to="/signup" className={buttonClass("primary", "px-3.5 text-[13.5px]")}>
								Sign up
							</Link>
						</>
					)}
				</div>
			</div>
		</header>
	);
}
