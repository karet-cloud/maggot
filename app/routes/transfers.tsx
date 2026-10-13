import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, Check, X } from "lucide-react";
import { useState } from "react";
import { VisibilityBadge } from "../components/repos.tsx";
import { Button, Empty, ErrorNote, Field, Input, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, keys, type RepoTransfer } from "../lib/api.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

export const Route = createFileRoute("/transfers")({
	head: () => ({ meta: [{ title: "Repository transfers · megit" }] }),
	component: Transfers,
});

function Transfers() {
	const viewer = useViewer();
	const list = useQuery({ queryKey: keys.transfers, queryFn: api.transfers, enabled: Boolean(viewer.data) });
	if (viewer.isPending) return <Spinner className="m-8" />;
	if (!viewer.data) {
		return (
			<main className="mx-auto max-w-md px-5 py-16 text-center text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to see repositories offered to you.
			</main>
		);
	}
	return (
		<main className="mx-auto max-w-3xl space-y-5 px-5 py-8">
			<div>
				<h1 className="text-lg font-semibold">Repository transfers</h1>
				<p className="mt-1 text-sm text-dim">
					Repositories other people want to hand to you. Accepting moves the repository, its history, stars and webhooks into your account,
					and counts it against your quota; the old address keeps working.
				</p>
			</div>
			{list.isPending && <Spinner />}
			<ErrorNote error={list.error} />
			{list.data?.length === 0 && (
				<Empty icon={<ArrowRightLeft className="size-6" />} title="Nothing waiting for you">
					Offers expire after a week.
				</Empty>
			)}
			<ul className="space-y-3">
				{list.data?.map((t) => (
					<li key={t.id}>
						<Offer transfer={t} />
					</li>
				))}
			</ul>
		</main>
	);
}

function Offer({ transfer }: { transfer: RepoTransfer }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const needsVerification = useNeedsVerification();
	const [name, setName] = useState(transfer.repo.split("/")[1] ?? "");
	const done = () => {
		void queryClient.invalidateQueries({ queryKey: keys.transfers });
		void queryClient.invalidateQueries({ queryKey: ["repos"] });
		void queryClient.invalidateQueries({ queryKey: keys.me });
	};
	const accept = useMutation({
		mutationFn: () => api.acceptTransfer(transfer.id, name.trim()),
		onSuccess: (repo) => {
			done();
			void navigate({ to: "/$owner/$repo", params: { owner: repo.owner, repo: repo.name } });
		},
	});
	const decline = useMutation({ mutationFn: () => api.declineTransfer(transfer.id), onSuccess: done });
	// Only ask for a name when the repository's own one is taken in this account.
	const clash = accept.error instanceof ApiError && accept.error.code === "ALREADY_EXISTS";
	return (
		<div className="space-y-3 rounded-lg border border-line bg-panel p-4">
			<div className="flex flex-wrap items-center gap-2">
				<ArrowRightLeft className="size-4 text-sky-300" />
				<span className="font-mono text-sm font-medium">{transfer.repo}</span>
				<VisibilityBadge visibility={transfer.visibility} />
			</div>
			{transfer.description && <p className="text-xs text-dim">{transfer.description}</p>}
			<p className="text-xs text-faint">
				Offered by <span className="text-dim">{transfer.from}</span> <TimeAgo at={transfer.createdAt} />; expires <TimeAgo at={transfer.expiresAt} />.
			</p>
			{clash && (
				<Field label="Name in your account" hint="You already have a repository with this name.">
					<Input value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9._\-]{1,100}" required />
				</Field>
			)}
			{needsVerification && <p className="text-xs text-amber-200">Verify your email address before accepting.</p>}
			<ErrorNote error={accept.error ?? decline.error} />
			<div className="flex gap-2">
				<Button variant="primary" busy={accept.isPending} disabled={needsVerification} onClick={() => accept.mutate()}>
					<Check className="size-4" />
					Accept
				</Button>
				<Button busy={decline.isPending} onClick={() => decline.mutate()}>
					<X className="size-4" />
					Decline
				</Button>
			</div>
		</div>
	);
}
