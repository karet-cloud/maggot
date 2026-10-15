// Organizations, teams and repository collaborators. An organization is a row in "user" with kind
// 'org': its repositories, quotas and URLs work exactly like a person's, and nobody signs in as it.
// Members are invited and accept; owners administer every repository, members read them all, and
// teams (and collaborators on any repository) add read, write or admin access to particular ones.
import type { Collaborator, Invitation, Org, OrgMember, OrgRole, Permission, Team } from "./api.ts";
import { HttpError } from "./errors.ts";
import { reservedName, validUsername } from "./names.ts";

export const MAX_ORGS_PER_USER = 10;
export const MAX_MEMBERS = 500;
export const MAX_TEAMS = 100;
const PERMISSIONS: Permission[] = ["read", "write", "admin"];

export function assertPermission(value: unknown): Permission {
	if (!PERMISSIONS.includes(value as Permission)) throw new HttpError(400, "INVALID_INPUT", "permission is read, write or admin");
	return value as Permission;
}

interface OrgRow {
	id: string;
	username: string;
	name: string;
	createdAt: string;
}

export async function findOrg(database: D1Database, name: string): Promise<OrgRow | null> {
	return database.prepare(`select "id", "username", "name", "createdAt" from "user" where "username" = ? and "kind" = 'org'`).bind(name.toLowerCase()).first<OrgRow>();
}

/** The caller's role in an organization, counting only accepted membership. */
export async function roleIn(database: D1Database, orgId: string, userId: string | null): Promise<OrgRole | null> {
	if (!userId) return null;
	const row = await database.prepare(`select "role" from "org_member" where "orgId" = ? and "userId" = ? and "state" = 'active'`).bind(orgId, userId).first<{ role: OrgRole }>();
	return row?.role ?? null;
}

export async function createOrg(database: D1Database, ownerId: string, name: string, displayName: string): Promise<OrgRow> {
	const username = name.trim().toLowerCase();
	if (reservedName(username)) throw new HttpError(400, "NAME_RESERVED", `${username} is reserved for maggot's own pages; pick another name`);
	if (!validUsername(username)) throw new HttpError(400, "INVALID_NAME", "Organization names are 2-39 lowercase letters, digits or single hyphens");
	const owned = await database.prepare(`select count(*) as "n" from "org_member" where "userId" = ? and "role" = 'owner'`).bind(ownerId).first<{ n: number }>();
	if ((owned?.n ?? 0) >= MAX_ORGS_PER_USER) throw new HttpError(403, "QUOTA_EXCEEDED", `You can own at most ${MAX_ORGS_PER_USER} organizations`);
	const id = `org_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
	const now = new Date().toISOString();
	try {
		await database.batch([
			database
				.prepare(
					`insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "username", "displayUsername", "kind") values (?, ?, ?, 1, ?, ?, ?, ?, 'org')`,
				)
				// A placeholder address on a reserved domain: nothing is ever sent to it, and nobody can sign in with it.
				.bind(id, displayName.trim().slice(0, 100) || username, `${id}@orgs.maggot.invalid`, now, now, username, username),
			database
				.prepare(`insert into "org_member" ("orgId", "userId", "role", "state", "invitedBy", "createdAt") values (?, ?, 'owner', 'active', null, ?)`)
				.bind(id, ownerId, now),
		]);
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", `The name ${username} is taken`);
		throw err;
	}
	return { id, username, name: displayName.trim() || username, createdAt: now };
}

/** An organization as `viewer` may see it: members and teams only for its members. */
export async function describeOrg(database: D1Database, org: OrgRow, viewerId: string | null): Promise<Org> {
	const role = await roleIn(database, org.id, viewerId);
	const [members, teams, teamMembers, teamRepos, invited] = await database.batch<Record<string, unknown>>([
		database
			.prepare(
				`select u."username", m."role", m."state", m."createdAt" from "org_member" m join "user" u on u."id" = m."userId"
				 where m."orgId" = ? order by m."role" desc, u."username" limit ${MAX_MEMBERS}`,
			)
			.bind(org.id),
		database.prepare(`select "id", "name", "createdAt" from "team" where "orgId" = ? order by "name"`).bind(org.id),
		database.prepare(`select tm."teamId", u."username" from "team_member" tm join "team" t on t."id" = tm."teamId" join "user" u on u."id" = tm."userId" where t."orgId" = ?`).bind(org.id),
		database
			.prepare(`select tr."teamId", r."name" as "repo", tr."permission" from "team_repo" tr join "team" t on t."id" = tr."teamId" join "repo" r on r."id" = tr."repoId" where t."orgId" = ?`)
			.bind(org.id),
		database.prepare(`select 1 from "org_member" where "orgId" = ? and "userId" = ? and "state" = 'invited'`).bind(org.id, viewerId ?? ""),
	]);
	const tm = teamMembers.results as { teamId: string; username: string }[];
	const tr = teamRepos.results as { teamId: string; repo: string; permission: Permission }[];
	return {
		name: org.username,
		displayName: org.name,
		createdAt: org.createdAt,
		role,
		invited: invited.results.length > 0,
		// Membership is private, as on GitHub by default: only members see who else is in.
		members: role ? (members.results as unknown as OrgMember[]) : [],
		teams: role
			? (teams.results as { id: string; name: string; createdAt: string }[]).map(
					(t): Team => ({
						id: t.id,
						name: t.name,
						members: tm.filter((m) => m.teamId === t.id).map((m) => m.username),
						repos: tr.filter((r) => r.teamId === t.id).map((r) => ({ repo: r.repo, permission: r.permission })),
					}),
				)
			: [],
	};
}

async function userId(database: D1Database, username: string): Promise<string> {
	const row = await database.prepare(`select "id" from "user" where "username" = ? and "kind" = 'user'`).bind(username.trim().toLowerCase()).first<{ id: string }>();
	if (!row) throw new HttpError(404, "NOT_FOUND", `There's no user called ${username}`);
	return row.id;
}

/** Invites someone to an organization; they join when they accept. Returns their id. */
export async function inviteMember(database: D1Database, orgId: string, username: string, role: OrgRole, invitedBy: string): Promise<string> {
	const id = await userId(database, username);
	const count = await database.prepare(`select count(*) as "n" from "org_member" where "orgId" = ?`).bind(orgId).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_MEMBERS) throw new HttpError(403, "QUOTA_EXCEEDED", `An organization can have at most ${MAX_MEMBERS} members`);
	const result = await database
		.prepare(`insert into "org_member" ("orgId", "userId", "role", "state", "invitedBy", "createdAt") values (?, ?, ?, 'invited', ?, ?) on conflict do nothing`)
		.bind(orgId, id, role, invitedBy, new Date().toISOString())
		.run();
	if (result.meta.changes === 0) throw new HttpError(409, "ALREADY_EXISTS", `${username} is already a member, or already invited`);
	return id;
}

/** Owners can't all leave: someone has to be able to administer the organization. */
async function assertAnotherOwner(database: D1Database, orgId: string, leaving: string) {
	const others = await database
		.prepare(`select count(*) as "n" from "org_member" where "orgId" = ? and "role" = 'owner' and "state" = 'active' and "userId" <> ?`)
		.bind(orgId, leaving)
		.first<{ n: number }>();
	if ((others?.n ?? 0) === 0) throw new HttpError(409, "LAST_OWNER", "An organization needs at least one owner; make someone else an owner first");
}

export async function setMemberRole(database: D1Database, orgId: string, username: string, role: OrgRole): Promise<void> {
	const id = await userId(database, username);
	if (role === "member") await assertAnotherOwner(database, orgId, id);
	const result = await database.prepare(`update "org_member" set "role" = ? where "orgId" = ? and "userId" = ?`).bind(role, orgId, id).run();
	if (result.meta.changes === 0) throw new HttpError(404, "NOT_FOUND", `${username} isn't a member`);
}

/** Removes a member (or withdraws an invitation), along with their team memberships. */
export async function removeMember(database: D1Database, orgId: string, username: string): Promise<void> {
	const id = await userId(database, username);
	const member = await database.prepare(`select "role", "state" from "org_member" where "orgId" = ? and "userId" = ?`).bind(orgId, id).first<{ role: OrgRole; state: string }>();
	if (!member) throw new HttpError(404, "NOT_FOUND", `${username} isn't a member`);
	if (member.role === "owner" && member.state === "active") await assertAnotherOwner(database, orgId, id);
	await database.batch([
		database.prepare(`delete from "org_member" where "orgId" = ? and "userId" = ?`).bind(orgId, id),
		database.prepare(`delete from "team_member" where "userId" = ? and "teamId" in (select "id" from "team" where "orgId" = ?)`).bind(id, orgId),
	]);
}

export async function createTeam(database: D1Database, orgId: string, name: string): Promise<string> {
	const clean = name.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/.test(clean)) throw new HttpError(400, "INVALID_NAME", "Team names are 1-50 letters, digits, spaces, '.', '-' or '_'");
	const count = await database.prepare(`select count(*) as "n" from "team" where "orgId" = ?`).bind(orgId).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_TEAMS) throw new HttpError(403, "QUOTA_EXCEEDED", `An organization can have at most ${MAX_TEAMS} teams`);
	const id = crypto.randomUUID();
	try {
		await database.prepare(`insert into "team" ("id", "orgId", "name", "createdAt") values (?, ?, ?, ?)`).bind(id, orgId, clean, new Date().toISOString()).run();
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", `There's already a team called ${clean}`);
		throw err;
	}
	return id;
}

async function teamOf(database: D1Database, orgId: string, teamId: string): Promise<void> {
	const team = await database.prepare(`select 1 from "team" where "id" = ? and "orgId" = ?`).bind(teamId, orgId).first();
	if (!team) throw new HttpError(404, "NOT_FOUND", "No such team");
}

export async function deleteTeam(database: D1Database, orgId: string, teamId: string): Promise<void> {
	await teamOf(database, orgId, teamId);
	await database.prepare(`delete from "team" where "id" = ?`).bind(teamId).run();
}

/** Adds an (accepted) member of the organization to one of its teams, or removes them. */
export async function setTeamMember(database: D1Database, orgId: string, teamId: string, username: string, member: boolean): Promise<void> {
	await teamOf(database, orgId, teamId);
	const id = await userId(database, username);
	if (member) {
		if (!(await roleIn(database, orgId, id))) throw new HttpError(400, "NOT_A_MEMBER", `${username} has to join the organization first`);
		await database.prepare(`insert or ignore into "team_member" ("teamId", "userId") values (?, ?)`).bind(teamId, id).run();
	} else {
		await database.prepare(`delete from "team_member" where "teamId" = ? and "userId" = ?`).bind(teamId, id).run();
	}
}

/** Gives a team access to one of the organization's repositories (null removes it). */
export async function setTeamRepo(database: D1Database, orgId: string, teamId: string, repoName: string, permission: Permission | null): Promise<void> {
	await teamOf(database, orgId, teamId);
	const repo = await database.prepare(`select "id" from "repo" where "ownerId" = ? and "name" = ?`).bind(orgId, repoName).first<{ id: string }>();
	if (!repo) throw new HttpError(404, "NOT_FOUND", `The organization has no repository called ${repoName}`);
	if (permission === null) await database.prepare(`delete from "team_repo" where "teamId" = ? and "repoId" = ?`).bind(teamId, repo.id).run();
	else {
		await database
			.prepare(`insert into "team_repo" ("teamId", "repoId", "permission") values (?, ?, ?) on conflict ("teamId", "repoId") do update set "permission" = excluded."permission"`)
			.bind(teamId, repo.id, permission)
			.run();
	}
}

export async function deleteOrg(database: D1Database, orgId: string): Promise<void> {
	const repos = await database.prepare(`select count(*) as "n" from "repo" where "ownerId" = ?`).bind(orgId).first<{ n: number }>();
	if ((repos?.n ?? 0) > 0) throw new HttpError(409, "NOT_EMPTY", "Delete or transfer the organization's repositories first");
	await database.prepare(`delete from "user" where "id" = ? and "kind" = 'org'`).bind(orgId).run();
}

// ── Collaborators ────────────────────────────────────────────────────────────

export const MAX_COLLABORATORS = 100;

export async function listCollaborators(database: D1Database, repoId: string): Promise<Collaborator[]> {
	const { results } = await database
		.prepare(`select u."username", k."permission", k."state", k."createdAt" from "repo_collaborator" k join "user" u on u."id" = k."userId" where k."repoId" = ? order by u."username"`)
		.bind(repoId)
		.all<Collaborator>();
	return results;
}

/** Invites someone to a repository with a permission, or changes an existing collaborator's. Returns their id. */
/** Invites `username` (with `permission`, read by default) or changes an existing grant (only when `permission` is given). */
export async function setCollaborator(database: D1Database, repo: { id: string; ownerId: string }, username: string, permission: Permission | undefined, invitedBy: string): Promise<{ id: string; invited: boolean }> {
	const id = await userId(database, username);
	if (id === repo.ownerId) throw new HttpError(400, "INVALID_INPUT", "That's the repository's owner");
	const existing = await database.prepare(`select "state" from "repo_collaborator" where "repoId" = ? and "userId" = ?`).bind(repo.id, id).first<{ state: string }>();
	if (existing) {
		if (permission === undefined) return { id, invited: false };
		await database.prepare(`update "repo_collaborator" set "permission" = ? where "repoId" = ? and "userId" = ?`).bind(permission, repo.id, id).run();
		return { id, invited: false };
	}
	const count = await database.prepare(`select count(*) as "n" from "repo_collaborator" where "repoId" = ?`).bind(repo.id).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_COLLABORATORS) throw new HttpError(403, "QUOTA_EXCEEDED", `A repository can have at most ${MAX_COLLABORATORS} collaborators`);
	await database
		.prepare(`insert into "repo_collaborator" ("repoId", "userId", "permission", "state", "invitedBy", "createdAt") values (?, ?, ?, 'invited', ?, ?)`)
		.bind(repo.id, id, permission ?? "read", invitedBy, new Date().toISOString())
		.run();
	return { id, invited: true };
}

export async function removeCollaborator(database: D1Database, repoId: string, username: string): Promise<void> {
	const id = await userId(database, username);
	const result = await database.prepare(`delete from "repo_collaborator" where "repoId" = ? and "userId" = ?`).bind(repoId, id).run();
	if (result.meta.changes === 0) throw new HttpError(404, "NOT_FOUND", `${username} isn't a collaborator`);
}

// ── Invitations (to organizations and repositories) ─────────────────────────

export async function invitationsFor(database: D1Database, userId: string): Promise<Invitation[]> {
	const [orgs, repos] = await database.batch<Record<string, unknown>>([
		database
			.prepare(
				`select 'org' as "kind", o."id", o."username" as "name", m."role" as "access", i."username" as "from", m."createdAt"
				 from "org_member" m join "user" o on o."id" = m."orgId" left join "user" i on i."id" = m."invitedBy" where m."userId" = ? and m."state" = 'invited'`,
			)
			.bind(userId),
		database
			.prepare(
				`select 'repo' as "kind", r."id", r."owner" || '/' || r."name" as "name", k."permission" as "access", i."username" as "from", k."createdAt"
				 from "repo_collaborator" k join "repo" r on r."id" = k."repoId" left join "user" i on i."id" = k."invitedBy" where k."userId" = ? and k."state" = 'invited'`,
			)
			.bind(userId),
	]);
	return [...(orgs.results as unknown as Invitation[]), ...(repos.results as unknown as Invitation[])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Accepts or declines an invitation addressed to `userId`. */
export async function answerInvitation(database: D1Database, userId: string, kind: "org" | "repo", id: string, accept: boolean): Promise<void> {
	const table = kind === "org" ? `"org_member"` : `"repo_collaborator"`;
	const key = kind === "org" ? `"orgId"` : `"repoId"`;
	const result = accept
		? await database.prepare(`update ${table} set "state" = 'active' where ${key} = ? and "userId" = ? and "state" = 'invited'`).bind(id, userId).run()
		: await database.prepare(`delete from ${table} where ${key} = ? and "userId" = ? and "state" = 'invited'`).bind(id, userId).run();
	if (result.meta.changes === 0) throw new HttpError(404, "NOT_FOUND", "No such invitation");
}

/** Organizations a user belongs to (accepted), with their role. */
export async function orgsOf(database: D1Database, userId: string): Promise<{ name: string; displayName: string; role: OrgRole }[]> {
	const { results } = await database
		.prepare(`select o."username" as "name", o."name" as "displayName", m."role" from "org_member" m join "user" o on o."id" = m."orgId" where m."userId" = ? and m."state" = 'active' order by o."username"`)
		.bind(userId)
		.all<{ name: string; displayName: string; role: OrgRole }>();
	return results;
}
