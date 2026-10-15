import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Trash2, UserMinus, Users, X } from "lucide-react";
import { useState } from "react";
import { api, keys, type Org, type OrgRole, type Permission } from "../lib/api.ts";
import { Button, Empty, ErrorNote, Input, Panel } from "./ui.tsx";

export function OrgHeader({ org }: { org: Org }) {
	return (
		<div className="flex items-center gap-3">
			<div className="flex size-12 items-center justify-center rounded-lg bg-accent/15 text-accent">
				<Building2 className="size-6" />
			</div>
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">{org.displayName}</h1>
				<p className="font-mono text-xs text-dim">
					{org.name} · organization{org.role ? ` · you're ${org.role === "owner" ? "an owner" : "a member"}` : ""}
				</p>
			</div>
		</div>
	);
}

function useOrgMutation<T>(org: string, fn: (input: T) => Promise<Org>) {
	const queryClient = useQueryClient();
	return useMutation({ mutationFn: fn, onSuccess: (next) => queryClient.setQueryData(keys.org(org), next) });
}

/** Members (and pending invitations, for members); owners invite, promote and remove. */
export function People({ org }: { org: Org }) {
	const owner = org.role === "owner";
	const [username, setUsername] = useState("");
	const [role, setRole] = useState<OrgRole>("member");
	const invite = useOrgMutation(org.name, () => api.inviteMember(org.name, username.trim(), role));
	const change = useOrgMutation(org.name, ({ who, to }: { who: string; to: OrgRole }) => api.setMemberRole(org.name, who, to));
	const remove = useOrgMutation(org.name, (who: string) => api.removeMember(org.name, who));
	return (
		<Panel title={`People (${org.members.filter((m) => m.state === "active").length})`}>
			<ul className="divide-y divide-line/60">
				{org.members.map((m) => (
					<li key={m.username} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
						<span className="font-mono">{m.username}</span>
						{m.state === "invited" && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-300">invited</span>}
						<span className="ml-auto text-xs text-dim">{m.role}</span>
						{owner && m.state === "active" && (
							<Button className="text-xs" busy={change.isPending && change.variables?.who === m.username} onClick={() => change.mutate({ who: m.username, to: m.role === "owner" ? "member" : "owner" })}>
								{m.role === "owner" ? "Make member" : "Make owner"}
							</Button>
						)}
						{owner && (
							<Button
								variant="ghost"
								className="px-2 text-xs hover:text-red-300"
								busy={remove.isPending && remove.variables === m.username}
								onClick={() => confirm(m.state === "invited" ? `Withdraw ${m.username}'s invitation?` : `Remove ${m.username} from ${org.name}?`) && remove.mutate(m.username)}
								aria-label={`Remove ${m.username}`}
							>
								<UserMinus className="size-3.5" />
							</Button>
						)}
					</li>
				))}
			</ul>
			{owner && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						invite.mutate(undefined, { onSuccess: () => setUsername("") });
					}}
					className="flex flex-wrap gap-2 border-t border-line p-4"
				>
					<Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username to invite" required className="min-w-48 flex-1" aria-label="Username to invite" />
					<select value={role} onChange={(e) => setRole(e.target.value as OrgRole)} aria-label="Role" className="rounded-md border border-line-strong bg-bg px-2.5 text-sm text-fg">
						<option value="member">Member</option>
						<option value="owner">Owner</option>
					</select>
					<Button type="submit" busy={invite.isPending}>
						<Plus className="size-4" />
						Invite
					</Button>
				</form>
			)}
			<div className="px-4 pb-3">
				<ErrorNote error={invite.error ?? change.error ?? remove.error} />
			</div>
		</Panel>
	);
}

const PERMISSIONS: Permission[] = ["read", "write", "admin"];

/** Teams, with their members and the repositories they can reach; owners change them. */
export function Teams({ org }: { org: Org }) {
	const owner = org.role === "owner";
	const [name, setName] = useState("");
	const create = useOrgMutation(org.name, () => api.createTeam(org.name, name.trim()));
	return (
		<div className="space-y-3">
			{org.teams.length === 0 && (
				<Empty icon={<Users className="size-6" />} title="No teams yet">
					Teams give groups of members write or admin access to particular repositories. Every member can already read them all.
				</Empty>
			)}
			{org.teams.map((t) => (
				<TeamCard key={t.id} org={org} team={t} owner={owner} />
			))}
			{owner && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						create.mutate(undefined, { onSuccess: () => setName("") });
					}}
					className="flex gap-2"
				>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New team name" required aria-label="New team name" />
					<Button type="submit" busy={create.isPending} className="shrink-0">
						<Plus className="size-4" />
						Create team
					</Button>
				</form>
			)}
			<ErrorNote error={create.error} />
		</div>
	);
}

function TeamCard({ org, team, owner }: { org: Org; team: Org["teams"][number]; owner: boolean }) {
	const [member, setMember] = useState("");
	const [repo, setRepo] = useState("");
	const [permission, setPermission] = useState<Permission>("write");
	const repos = useQuery({ queryKey: keys.repos({ owner: org.name }), queryFn: () => api.repos({ owner: org.name }), enabled: owner });
	const members = useOrgMutation(org.name, ({ who, add }: { who: string; add: boolean }) => api.setTeamMember(org.name, team.id, who, add));
	const access = useOrgMutation(org.name, ({ name, to }: { name: string; to: Permission | null }) => api.setTeamRepo(org.name, team.id, name, to));
	const remove = useOrgMutation(org.name, () => api.deleteTeam(org.name, team.id));
	const candidates = org.members.filter((m) => m.state === "active" && !team.members.includes(m.username));
	const addable = repos.data?.filter((r) => !team.repos.some((x) => x.repo === r.name)) ?? [];
	return (
		<Panel
			title={team.name}
			actions={
				owner && (
					<Button variant="ghost" className="px-2 text-xs hover:text-red-300" busy={remove.isPending} onClick={() => confirm(`Delete the team ${team.name}?`) && remove.mutate()} aria-label={`Delete ${team.name}`}>
						<Trash2 className="size-3.5" />
					</Button>
				)
			}
		>
			<div className="grid gap-4 p-4 text-sm md:grid-cols-2">
				<div className="space-y-2">
					<p className="text-xs font-medium text-dim">Members</p>
					{team.members.length === 0 && <p className="text-xs text-faint">Nobody yet.</p>}
					<ul className="flex flex-wrap gap-1.5">
						{team.members.map((m) => (
							<li key={m} className="flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 font-mono text-xs">
								{m}
								{owner && (
									<button type="button" onClick={() => members.mutate({ who: m, add: false })} className="text-faint hover:text-fg" aria-label={`Remove ${m} from ${team.name}`}>
										<X className="size-3" />
									</button>
								)}
							</li>
						))}
					</ul>
					{owner && candidates.length > 0 && (
						<div className="flex gap-2">
							<select value={member} onChange={(e) => setMember(e.target.value)} aria-label="Member to add" className="flex-1 rounded-md border border-line-strong bg-bg px-2 py-1 text-xs text-fg">
								<option value="">Add a member…</option>
								{candidates.map((m) => (
									<option key={m.username} value={m.username}>
										{m.username}
									</option>
								))}
							</select>
							<Button className="text-xs" disabled={!member} busy={members.isPending} onClick={() => members.mutate({ who: member, add: true }, { onSuccess: () => setMember("") })}>
								Add
							</Button>
						</div>
					)}
				</div>
				<div className="space-y-2">
					<p className="text-xs font-medium text-dim">Repositories</p>
					{team.repos.length === 0 && <p className="text-xs text-faint">None yet.</p>}
					<ul className="space-y-1">
						{team.repos.map((r) => (
							<li key={r.repo} className="flex items-center gap-2 text-xs">
								<span className="flex-1 font-mono">{r.repo}</span>
								{owner ? (
									<select value={r.permission} onChange={(e) => access.mutate({ name: r.repo, to: e.target.value as Permission })} aria-label={`Access to ${r.repo}`} className="rounded border border-line-strong bg-bg px-1.5 py-0.5 text-xs">
										{PERMISSIONS.map((p) => (
											<option key={p} value={p}>
												{p}
											</option>
										))}
									</select>
								) : (
									<span className="text-dim">{r.permission}</span>
								)}
								{owner && (
									<button type="button" onClick={() => access.mutate({ name: r.repo, to: null })} className="text-faint hover:text-fg" aria-label={`Remove ${r.repo} from ${team.name}`}>
										<X className="size-3" />
									</button>
								)}
							</li>
						))}
					</ul>
					{owner && addable.length > 0 && (
						<div className="flex gap-2">
							<select value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repository to add" className="flex-1 rounded-md border border-line-strong bg-bg px-2 py-1 text-xs text-fg">
								<option value="">Add a repository…</option>
								{addable.map((r) => (
									<option key={r.name} value={r.name}>
										{r.name}
									</option>
								))}
							</select>
							<select value={permission} onChange={(e) => setPermission(e.target.value as Permission)} aria-label="Access" className="rounded-md border border-line-strong bg-bg px-2 py-1 text-xs">
								{PERMISSIONS.map((p) => (
									<option key={p} value={p}>
										{p}
									</option>
								))}
							</select>
							<Button className="text-xs" disabled={!repo} busy={access.isPending} onClick={() => access.mutate({ name: repo, to: permission }, { onSuccess: () => setRepo("") })}>
								Add
							</Button>
						</div>
					)}
				</div>
			</div>
			<div className="px-4 pb-3">
				<ErrorNote error={members.error ?? access.error ?? remove.error} />
			</div>
		</Panel>
	);
}
