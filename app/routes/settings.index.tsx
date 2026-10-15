import { createFileRoute, redirect } from "@tanstack/react-router";

// Without this, /settings on its own would match the `$owner` profile; the first settings tab stands in for it.
export const Route = createFileRoute("/settings/")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/tokens", replace: true });
	},
});
