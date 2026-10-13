import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect } from "react";
import { keys } from "../lib/api.ts";

// Where the link in a verification email lands, after the server has checked it.
export const Route = createFileRoute("/verify-email")({
	validateSearch: (search: Record<string, unknown>) => ({ error: typeof search.error === "string" ? search.error : undefined }),
	component: VerifyEmail,
});

const REASONS: Record<string, string> = {
	TOKEN_EXPIRED: "The link has expired.",
	INVALID_TOKEN: "The link isn't valid; it may have been copied incompletely.",
	USER_NOT_FOUND: "The account no longer exists.",
	INVALID_USER: "You're signed in to a different account than the one the link is for.",
};

function VerifyEmail() {
	const { error } = Route.useSearch();
	const queryClient = useQueryClient();
	useEffect(() => {
		// Verifying may have signed the user in, and certainly changed what they may do.
		void queryClient.invalidateQueries({ queryKey: keys.me });
	}, [queryClient]);
	return (
		<main className="mx-auto max-w-sm px-5 py-24 text-center">
			{error ? (
				<>
					<CircleAlert className="mx-auto size-8 text-rose-300" />
					<h1 className="mt-3 text-lg font-semibold">Couldn't verify your email</h1>
					<p className="mt-2 text-sm text-dim">
						{REASONS[error] ?? "Something went wrong."} Sign in and use “Resend the email” at the top of the page to get a new link.
					</p>
				</>
			) : (
				<>
					<CheckCircle2 className="mx-auto size-8 text-emerald-300" />
					<h1 className="mt-3 text-lg font-semibold">Email verified</h1>
					<p className="mt-2 text-sm text-dim">You can create repositories and push to them now.</p>
				</>
			)}
			<Link to="/new" className="mt-6 inline-block text-sm text-accent hover:underline">
				Create a repository
			</Link>
		</main>
	);
}
