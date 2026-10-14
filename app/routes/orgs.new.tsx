import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Field, Input, Spinner } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

export const Route = createFileRoute("/orgs/new")({
	head: () => ({ meta: [{ title: "New organization · maggot" }] }),
	component: NewOrg,
});

function NewOrg() {
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [displayName, setDisplayName] = useState("");
	const create = useMutation({
		mutationFn: () => api.createOrg(name.trim().toLowerCase(), displayName.trim()),
		onSuccess: (org) => {
			void queryClient.invalidateQueries({ queryKey: keys.myOrgs });
			void navigate({ to: "/$owner", params: { owner: org.name } });
		},
	});
	if (viewer.isPending) return <Spinner className="m-8" />;
	if (!viewer.data) {
		return (
			<main className="mx-auto max-w-md px-5 py-16 text-center text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to create an organization.
			</main>
		);
	}
	return (
		<main className="mx-auto max-w-xl px-5 py-8">
			<h1 className="flex items-center gap-2 text-lg font-semibold">
				<Building2 className="size-5 text-accent" />
				Create an organization
			</h1>
			<p className="mt-1 text-sm text-dim">
				An account repositories can belong to, shared by its members. Owners administer everything; members can read every repository, and teams
				give them write or admin access to particular ones.
			</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate();
				}}
				className="mt-6 space-y-4"
			>
				<Field label="Name" hint={`Its repositories live at /${name.trim().toLowerCase() || "name"}/…; lowercase letters, digits and hyphens.`}>
					<Input value={name} onChange={(e) => setName(e.target.value)} pattern="[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,37}[a-zA-Z0-9])?" placeholder="acme" required autoFocus />
				</Field>
				<Field label="Display name" hint="Optional.">
					<Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Acme Corporation" maxLength={100} />
				</Field>
				{needsVerification && <p className="text-xs text-amber-200">Verify your email address before creating an organization.</p>}
				<ErrorNote error={create.error} />
				<Button type="submit" variant="primary" busy={create.isPending} disabled={needsVerification}>
					Create organization
				</Button>
			</form>
		</main>
	);
}
