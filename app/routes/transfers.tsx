import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, BookMarked, Check, Users, X } from "lucide-react";
import { useState } from "react";
import { VisibilityBadge } from "../components/repos.tsx";
import { Button, Empty, ErrorNote, Field, Input, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, keys, type Invitation, type RepoTransfer } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { preload } from "../lib/queries.ts";
import { signedIn, useNeedsVerification, useViewer } from "./__root.tsx";

export const Route = createFileRoute("/transfers")({
	head: () => ({ meta: [{ title: "Invitations and transfers · maggot" }] }),
	loader: ({ context }) => (signedIn(context.queryClient) ? preload(context.queryClient, transfersQuery, invitationsQuery) : undefined),
	component: Transfers,
});

const transfersQuery = queryOptions({ queryKey: keys.transfers, queryFn: api.transfers });
const invitationsQuery = queryOptions({ queryKey: keys.invitations, queryFn: api.invitations });

function Transfers() {
	const viewer = useViewer();
	const list = useQuery({ ...transfersQuery, enabled: Boolean(viewer.data) });
	const invitations = useQuery({ ...invitationsQuery, enabled: Boolean(viewer.data) });
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
				<h1 className="text-lg font-semibold">Invitations</h1>
				<p className="mt-1 text-sm text-dim">Organizations and repositories you've been invited to join.</p>
			</div>
			<ErrorNote error={invitations.error} />
			{invitations.data?.length === 0 && <p className="text-sm text-faint">No invitations.</p>}
			<ul className="space-y-3">
				{invitations.data?.map((i) => (
					<li key={`${i.kind}:${i.id}`}>
						<InvitationCard invitation={i} />
					</li>
				))}
			</ul>
			<div className="border-t border-line pt-5">
				<h2 className="text-base font-semibold">Repository transfers</h2>
				<p className="mt-1 text-sm text-dim">
					Repositories other people want to hand to you. Accepting moves the repository, its history, issues and stars into your account,
					and counts it against your quota; the old address keeps working. Its webhooks come along paused, since they point at the
					previous owner's endpoints.
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

function InvitationCard({ invitation: i }: { invitation: Invitation }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const needsVerification = useNeedsVerification();
	// Accepting waits for the server, since it navigates into what was joined; declining just goes away.
	const accept = useMutation({
		mutationFn: () => api.answerInvitation(i, true),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: keys.invitations });
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
			void queryClient.invalidateQueries({ queryKey: keys.myOrgs });
			if (i.kind === "org") void navigate({ to: "/$owner", params: { owner: i.name } });
			else {
				const [owner, repo] = i.name.split("/");
				void navigate({ to: "/$owner/$repo", params: { owner, repo } });
			}
		},
	});
	const decline = useOptimistic({
		mutationFn: () => api.answerInvitation(i, false),
		apply: () => [patch<Invitation[]>(keys.invitations, (old) => old.filter((x) => x.kind !== i.kind || x.id !== i.id))],
		invalidate: () => [["repos"], keys.myOrgs],
		action: "decline the invitation",
	});
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-4">
			{i.kind === "org" ? <Users className="size-4 text-sky-300" /> : <BookMarked className="size-4 text-sky-300" />}
			<div className="min-w-0 flex-1 text-sm">
				<p>
					<span className="font-mono font-medium">{i.name}</span>{" "}
					<span className="text-dim">
						{i.kind === "org" ? `as ${i.access === "owner" ? "an owner" : "a member"}` : `with ${i.access} access`}
					</span>
				</p>
				<p className="text-xs text-faint">
					{i.from ? `From ${i.from}, ` : ""}
					<TimeAgo at={i.createdAt} />
				</p>
			</div>
			<ErrorNote error={accept.error} />
			<Button variant="primary" busy={accept.isPending} disabled={needsVerification} onClick={() => accept.mutate()}>
				<Check className="size-4" />
				Accept
			</Button>
			<Button disabled={accept.isPending} onClick={() => decline.mutate()}>
				<X className="size-4" />
				Decline
			</Button>
		</div>
	);
}

function Offer({ transfer }: { transfer: RepoTransfer }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const needsVerification = useNeedsVerification();
	const [name, setName] = useState(transfer.repo.split("/")[1] ?? "");
	const accept = useMutation({
		mutationFn: () => api.acceptTransfer(transfer.id, name.trim()),
		onSuccess: (repo) => {
			void queryClient.invalidateQueries({ queryKey: keys.transfers });
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
			void queryClient.invalidateQueries({ queryKey: keys.me });
			void navigate({ to: "/$owner/$repo", params: { owner: repo.owner, repo: repo.name } });
		},
	});
	const decline = useOptimistic({
		mutationFn: () => api.declineTransfer(transfer.id),
		apply: () => [patch<RepoTransfer[]>(keys.transfers, (old) => old.filter((t) => t.id !== transfer.id))],
		action: "decline the transfer",
	});
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
			<ErrorNote error={accept.error} />
			<div className="flex gap-2">
				<Button variant="primary" busy={accept.isPending} disabled={needsVerification} onClick={() => accept.mutate()}>
					<Check className="size-4" />
					Accept
				</Button>
				<Button disabled={accept.isPending} onClick={() => decline.mutate()}>
					<X className="size-4" />
					Decline
				</Button>
			</div>
		</div>
	);
}
