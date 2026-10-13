import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, CircleCheck, CircleDashed, CircleMinus, CirclePause, CircleX, KeyRound, LoaderCircle, Play, Plus, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { api, keys, repoParams, type CiConclusion, type CiRunner, type CiRunSummary, type CiSettings, type CiStatus, type PullChecks } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { Button, cx, Empty, ErrorNote, Field, Input, Panel, Spinner } from "./ui.tsx";

/** One word for where a run, job or step stands: its conclusion once finished, else its status. */
export type CiState = CiConclusion | Exclude<CiStatus, "completed"> | "pending";

export const ciState = (x: { status: CiStatus | "pending"; conclusion: CiConclusion | null }): CiState =>
	x.status === "completed" ? (x.conclusion ?? "failure") : x.status;

const STATE: Record<CiState, { label: string; tone: string }> = {
	success: { label: "Succeeded", tone: "text-emerald-300" },
	failure: { label: "Failed", tone: "text-rose-300" },
	cancelled: { label: "Cancelled", tone: "text-zinc-400" },
	skipped: { label: "Skipped", tone: "text-zinc-500" },
	queued: { label: "Queued", tone: "text-amber-300" },
	waiting: { label: "Waiting for approval", tone: "text-amber-300" },
	in_progress: { label: "In progress", tone: "text-sky-300" },
	pending: { label: "Pending", tone: "text-faint" },
};

export const ciLabel = (state: CiState) => STATE[state].label;

export function CiIcon({ state, className }: { state: CiState; className?: string }) {
	const c = cx("size-4 shrink-0", STATE[state].tone, className);
	const title = STATE[state].label;
	switch (state) {
		case "success":
			return <CircleCheck className={c} aria-label={title} />;
		case "failure":
			return <CircleX className={c} aria-label={title} />;
		case "cancelled":
			return <Ban className={c} aria-label={title} />;
		case "skipped":
			return <CircleMinus className={c} aria-label={title} />;
		case "waiting":
			return <CirclePause className={c} aria-label={title} />;
		case "in_progress":
			return <LoaderCircle className={cx(c, "animate-spin")} aria-label={title} />;
		default:
			return <CircleDashed className={c} aria-label={title} />;
	}
}

/** How long something ran, ticking while it still runs. */
export function Elapsed({ from, to }: { from: string | null; to: string | null }) {
	if (!from) return null;
	return <span className="tabular-nums">{duration(from, to ?? new Date().toISOString())}</span>;
}

export const isActive = (r: { status: CiStatus }) => r.status !== "completed";

/**
 * The newest run of each workflow and event, which is what a commit's checks are (the server's merge
 * rule counts the same). Runs come newest first.
 */
export function latestPerWorkflow(runs: CiRunSummary[]): CiRunSummary[] {
	const seen = new Map<string, CiRunSummary>();
	for (const r of runs) if (!seen.has(`${r.path}\0${r.event}`)) seen.set(`${r.path}\0${r.event}`, r);
	return [...seen.values()];
}

/** Overall state of a set of checks. Like the server's merge rule, only success passes. */
export function combined(runs: CiRunSummary[]): CiState {
	if (runs.some((r) => r.status === "completed" && r.conclusion !== "success")) return "failure";
	if (runs.some((r) => r.status === "waiting")) return "waiting";
	if (runs.some(isActive)) return "in_progress";
	return "success";
}

/** A commit's checks: the newest run of each workflow on it. Polls while any is unfinished. */
export function useChecks(project: string, sha: string) {
	return useQuery({
		queryKey: keys.ciChecks(project, { sha }),
		queryFn: async () => latestPerWorkflow((await api.ciRuns(project, { sha })).runs),
		refetchInterval: (q) => (q.state.data?.some(isActive) ? 5000 : false),
		// Repositories without Actions answer with no runs; an older server without the API, with an error: show nothing either way.
		retry: false,
	});
}

/** A pull request's checks on its head, as the server judges them (the merge gets the same answer). Polls while they're unsettled. */
export function usePullChecks(project: string, number: number, enabled: boolean) {
	return useQuery({
		queryKey: keys.pullChecks(project, number),
		queryFn: () => api.pullChecks(project, number),
		enabled,
		// Runs waiting for approval change only when someone approves them, which the live connection reports.
		refetchInterval: (q) => (q.state.data?.state === "pending" ? 5000 : false),
		retry: false,
	});
}

/** A commit's checks as one icon with a count, linking to the run (or the list of them). Nothing when there are none. */
export function ChecksBadge({ project, sha }: { project: string; sha: string }) {
	const checks = useChecks(project, sha);
	const runs = checks.data;
	if (!runs?.length) return null;
	const state = combined(runs);
	const passed = runs.filter((r) => r.conclusion === "success").length;
	const title = runs.map((r) => `${r.workflow}: ${ciLabel(ciState(r))}`).join("\n");
	const body = (
		<>
			<CiIcon state={state} className="size-3.5" />
			<span className="tabular-nums">
				{passed}/{runs.length}
			</span>
		</>
	);
	const className = "inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] text-dim hover:text-fg";
	return runs.length === 1 ? (
		<Link to="/$owner/$repo/actions/runs/$number" params={{ ...repoParams(project), number: String(runs[0].number) }} className={className} title={title}>
			{body}
		</Link>
	) : (
		<Link to="/$owner/$repo/actions" params={repoParams(project)} search={{ sha }} className={className} title={title}>
			{body}
		</Link>
	);
}

const CHECKS_TITLE: Record<PullChecks["state"], string> = {
	none: "No checks",
	success: "All checks have passed",
	failure: "Some checks failed",
	waiting: "Checks are waiting for approval",
	pending: "Checks are running",
	missing: "Some required checks haven't run",
};

/**
 * The checks box on a pull request: what the server counts on the head (every workflow's newest run on
 * it, whatever started it), the required workflows that haven't run, approval for waiting runs, and a
 * way for people who can merge to start what's missing.
 */
export function PullChecksBox({ project, number, checks, canApprove }: { project: string; number: number; checks: PullChecks | undefined; canApprove: boolean }) {
	const queryClient = useQueryClient();
	const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.ciRuns(project) });
	const approve = useMutation({ mutationFn: (run: number) => api.ciRunAction(project, run, "approve"), onSuccess: refresh });
	const start = useMutation({
		mutationFn: () => api.startPullChecks(project, number),
		onSuccess: (c) => {
			queryClient.setQueryData(keys.pullChecks(project, number), c);
			refresh();
		},
	});
	if (!checks || (checks.runs.length === 0 && checks.missing.length === 0)) return null;
	const state: CiState = checks.state === "missing" ? "pending" : checks.state === "none" ? "success" : checks.state;
	return (
		<Panel
			title={
				<span className="flex items-center gap-2 normal-case tracking-normal">
					<CiIcon state={state} />
					{CHECKS_TITLE[checks.state]}
				</span>
			}
			actions={checks.required && <span className="text-[11px] text-faint">Required to merge</span>}
		>
			<ul className="divide-y divide-line/60">
				{checks.runs.map((r) => (
					<li key={r.number} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
						<CiIcon state={ciState(r)} />
						<Link to="/$owner/$repo/actions/runs/$number" params={{ ...repoParams(project), number: String(r.number) }} className="min-w-0 flex-1 truncate text-fg hover:text-accent">
							{r.workflow} <span className="text-faint">#{r.number}</span>{" "}
							<span className="text-[11px] text-faint">{r.event === "pull_request" ? "" : r.event === "push" ? "· push" : "· run by hand"}</span>
						</Link>
						<span className="text-xs text-faint">{r.error ?? ciLabel(ciState(r))}</span>
						{r.status === "waiting" && canApprove && (
							<Button className="text-xs" busy={approve.isPending && approve.variables === r.number} onClick={() => approve.mutate(r.number)}>
								<ShieldCheck className="size-3.5" />
								Approve and run
							</Button>
						)}
					</li>
				))}
				{checks.missing.map((path) => (
					<li key={path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
						<CiIcon state="pending" />
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{path}</span>
						<span className="text-xs text-faint">Required, not started</span>
					</li>
				))}
			</ul>
			{checks.missing.length > 0 && (
				<div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
					<span className="flex-1">
						The base branch requires {checks.missing.length === 1 ? "this workflow" : "these workflows"} on pull requests, but {checks.missing.length === 1 ? "it hasn't" : "they haven't"} run on
						this commit: usually because {checks.missing.length === 1 ? "it was" : "they were"} added to the base branch after the pull request's last push, or the author already had
						too many runs waiting for approval. Starting creates only {checks.missing.length === 1 ? "this run" : "these runs"}; for a fork or a pull request opened by someone who can't
						write here, they wait for approval like its other runs.
					</span>
					{checks.canStart && (
						<Button className="text-xs" busy={start.isPending} onClick={() => start.mutate()}>
							<Play className="size-3.5" />
							Start missing checks
						</Button>
					)}
				</div>
			)}
			{checks.runs.some((r) => r.status === "waiting") && (
				<p className="border-t border-line px-4 py-2 text-[11px] text-faint">
					Runs for pull requests from people who can't write here wait until someone who can merge has read the workflow and approves. Runs from forks never get
					this repository's secrets.
				</p>
			)}
			<div className="px-4 empty:hidden">
				<ErrorNote error={approve.error ?? start.error} />
			</div>
		</Panel>
	);
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** Settings → Actions: the default runner, the Depot connection and secrets. Admins only; values are never sent back. */
export function ActionsSettings({ project, archived }: { project: string; archived: boolean }) {
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: keys.ciSettings(project), queryFn: () => api.ciSettings(project) });
	const set = (s: CiSettings) => queryClient.setQueryData(keys.ciSettings(project), s);
	const runner = useMutation({ mutationFn: (r: CiRunner) => api.ciSetDefaultRunner(project, r), onSuccess: set });
	const s = settings.data;
	return (
		<Panel title="Actions" actions={<span className="text-[11px] text-faint">Workflows live in .megit/workflows</span>}>
			{settings.isPending ? (
				<Spinner className="m-4" />
			) : !s ? (
				<div className="p-4">
					<ErrorNote error={settings.error} />
				</div>
			) : (
				<div className="divide-y divide-line">
					<div className="space-y-2 p-4 text-sm">
						<Field
							label="Default runner"
							hint={
								<>
									Where jobs with <code className="font-mono">runs-on: ubuntu-latest</code> (or no runs-on) go. A job can still pick{" "}
									<code className="font-mono">cloudflare</code> or <code className="font-mono">depot</code> itself.
								</>
							}
						>
							<select
								value={s.defaultRunner}
								onChange={(e) => runner.mutate(e.target.value as CiRunner)}
								disabled={archived || runner.isPending}
								className="w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm text-fg"
							>
								<option value="cloudflare" disabled={!s.cloudflareAvailable}>
									Cloudflare container{s.cloudflareAvailable ? "" : " (not available on this server)"}
								</option>
								<option value="depot">Depot sandbox{s.depot.configured ? "" : " (connect Depot below, or its jobs fail)"}</option>
							</select>
						</Field>
						{!s.cloudflareAvailable && (
							<p className="text-xs text-amber-200">This server doesn't run Cloudflare containers for CI, so jobs need Depot.</p>
						)}
						<ErrorNote error={runner.error} />
					</div>
					{archived && (
						<p className="p-4 text-xs text-amber-200">
							This repository is archived, so nothing runs and settings can't change. You can still disconnect Depot and delete secrets.
						</p>
					)}
					<DepotSettings project={project} settings={s} onSaved={set} archived={archived} />
					<Secrets project={project} settings={s} onSaved={set} archived={archived} />
				</div>
			)}
		</Panel>
	);
}

function DepotSettings({ project, settings, onSaved, archived }: { project: string; settings: CiSettings; onSaved: (s: CiSettings) => void; archived: boolean }) {
	const [token, setToken] = useState("");
	const [org, setOrg] = useState(settings.depot.orgId ?? "");
	const connect = useMutation({
		mutationFn: () => api.ciSetDepot(project, token.trim(), org.trim() || null),
		onSuccess: (s) => {
			setToken("");
			onSaved(s);
		},
	});
	const disconnect = useMutation({ mutationFn: () => api.ciRemoveDepot(project), onSuccess: onSaved });
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				connect.mutate();
			}}
			className="space-y-3 p-4 text-sm"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="font-medium text-fg">Depot sandboxes</p>
				{settings.depot.configured ? (
					<span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300 ring-1 ring-emerald-400/30 ring-inset">
						Connected{settings.depot.orgId ? ` · org ${settings.depot.orgId}` : ""}
					</span>
				) : (
					<span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-faint">Not connected</span>
				)}
			</div>
			<p className="text-xs text-dim">
				Jobs with <code className="font-mono text-fg">runs-on: depot</code> or <code className="font-mono text-fg">depot-&lt;vcpus&gt;</code> (2, 4, 8, 16, 32
				or 64) run in a{" "}
				<a href="https://depot.dev/docs/api/sandbox-sdk-reference" target="_blank" rel="noreferrer" className="text-accent hover:underline">
					Depot sandbox
				</a>
				, billed to your Depot account. Create an organization token in Depot under <b className="text-fg">Organization Settings → API Tokens</b>, or a user
				token under <b className="text-fg">Settings → Personal settings</b>. App and service tokens, and user tokens in more than one organization, also need
				the organization ID: <code className="font-mono text-fg">depot org show</code> prints the current organization's ID (
				<code className="font-mono text-fg">depot org switch</code> changes which one that is). megit checks the token with Depot before keeping it,
				encrypted; it's never shown again.
			</p>
			<div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<Field label={settings.depot.configured ? "Replace token" : "Depot token"}>
					<Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" required disabled={archived} />
				</Field>
				<Field label="Organization ID" hint="For app and service tokens, and multi-organization user tokens">
					<Input value={org} onChange={(e) => setOrg(e.target.value)} pattern="[A-Za-z0-9_\-]{1,64}" className="font-mono" disabled={archived} />
				</Field>
			</div>
			<ErrorNote error={connect.error ?? disconnect.error} />
			<div className="flex flex-wrap gap-2">
				<Button type="submit" busy={connect.isPending} disabled={archived || !token.trim()}>
					{settings.depot.configured ? "Replace token" : "Connect Depot"}
				</Button>
				{settings.depot.configured && (
					<Button
						variant="ghost"
						className="hover:text-rose-300"
						busy={disconnect.isPending}
						onClick={() => confirm("Disconnect Depot? Jobs that run on Depot will fail until you connect it again.") && disconnect.mutate()}
					>
						Disconnect
					</Button>
				)}
			</div>
		</form>
	);
}

function Secrets({ project, settings, onSaved, archived }: { project: string; settings: CiSettings; onSaved: (s: CiSettings) => void; archived: boolean }) {
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const save = useMutation({
		mutationFn: () => api.ciSetSecret(project, name.trim(), value),
		onSuccess: (s) => {
			setName("");
			setValue("");
			onSaved(s);
		},
	});
	const remove = useMutation({ mutationFn: (n: string) => api.ciDeleteSecret(project, n), onSuccess: onSaved });
	return (
		<div className="space-y-3 p-4 text-sm">
			<p className="font-medium text-fg">Secrets</p>
			<p className="text-xs text-dim">
				Use them in a workflow as <code className="font-mono text-fg">{"${{ secrets.NAME }}"}</code>. Values are encrypted, masked in logs, and never shown again;
				runs from forks' pull requests don't get them.
			</p>
			{settings.secrets.length === 0 ? (
				<Empty icon={<KeyRound className="size-6" />} title="No secrets" />
			) : (
				<ul className="divide-y divide-line/60 rounded-lg border border-line">
					{settings.secrets.map((s) => (
						<li key={s} className="flex items-center gap-3 px-3 py-2">
							<KeyRound className="size-3.5 text-faint" />
							<span className="flex-1 font-mono text-xs text-fg">{s}</span>
							<span className="text-[11px] text-faint">value hidden</span>
							<Button
								variant="ghost"
								className="px-2 text-xs hover:text-rose-300"
								busy={remove.isPending && remove.variables === s}
								onClick={() => confirm(`Delete the secret ${s}?`) && remove.mutate(s)}
								aria-label={`Delete ${s}`}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					save.mutate();
				}}
				className="grid gap-3 rounded-lg border border-dashed border-line-strong p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end"
			>
				<Field label="Name" hint="Saving an existing name replaces its value">
					<Input
						value={name}
						onChange={(e) => setName(e.target.value.toUpperCase())}
						pattern="[A-Za-z_][A-Za-z0-9_]{0,99}"
						placeholder="NPM_TOKEN"
						className="font-mono"
						required
						disabled={archived}
					/>
				</Field>
				<Field label="Value">
					<Input value={value} onChange={(e) => setValue(e.target.value)} type="password" autoComplete="off" required disabled={archived} />
				</Field>
				<Button type="submit" busy={save.isPending} disabled={archived} className="sm:mb-[18px]">
					<Plus className="size-4" />
					Save secret
				</Button>
				<div className="sm:col-span-3 empty:hidden">
					<ErrorNote error={save.error ?? remove.error} />
				</div>
			</form>
		</div>
	);
}

export function NoWorkflows({ project, branch }: { project: string; branch: string }) {
	return (
		<Empty icon={<Workflow className="size-6" />} title="No workflows yet">
			Add a YAML file under <code className="font-mono text-dim">.megit/workflows/</code> on {branch}, then push. See{" "}
			<Link to="/$owner/$repo/actions" params={repoParams(project)} search={{ help: true }} className="text-accent hover:underline">
				the supported syntax
			</Link>
			.
		</Empty>
	);
}
