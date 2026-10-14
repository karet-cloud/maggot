import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, keys, type BranchRule } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { Button, Empty, ErrorNote, Field, Input, Panel, Spinner } from "./ui.tsx";

const OPTIONS: { id: keyof Omit<BranchRule, "pattern" | "createdAt">; label: string; hint: string }[] = [
	{ id: "blockForcePushes", label: "Block force pushes", hint: "Pushes may only add commits; a push that rewrites history is put back and refused" },
	{ id: "blockDeletions", label: "Block deletion", hint: "Nobody can delete the branch, from git or the web" },
	{ id: "requireMergeQueue", label: "No direct pushes", hint: "No pushes or web commits; work lands through pull requests or agent tasks" },
	{ id: "requireReview", label: "Require an approving review", hint: "Changes land only through pull requests approved by someone who can merge (no changes requested): no direct pushes, web commits or merge queue" },
	{ id: "requireChecks", label: "Require Actions to pass", hint: "Changes land only through pull requests whose latest run of every megit Actions workflow on the head commit succeeded: no direct pushes, web commits or merge queue" },
];

export const branchRulesQuery = (project: string) => queryOptions({ queryKey: keys.branchRules(project), queryFn: () => api.branchRules(project) });

/** A repository's branch protection rules: add, change and remove them. */
export function BranchProtection({ project, defaultBranch }: { project: string; defaultBranch: string }) {
	const queryClient = useQueryClient();
	const rules = useQuery(branchRulesQuery(project));
	const [pattern, setPattern] = useState(defaultBranch);
	const [flags, setFlags] = useState({ blockForcePushes: true, blockDeletions: true, requireMergeQueue: false, requireReview: false, requireChecks: false });
	const set = (rules: BranchRule[]) => {
		queryClient.setQueryData(keys.branchRules(project), rules);
		void queryClient.invalidateQueries({ queryKey: keys.branches(project) });
	};
	// A new rule waits for the server, which checks the pattern; changing or removing one shows at once.
	const save = useMutation({ mutationFn: (rule: Omit<BranchRule, "createdAt">) => api.setBranchRule(project, rule), onSuccess: set });
	const change = useOptimistic({
		mutationFn: (rule: BranchRule) => api.setBranchRule(project, rule),
		apply: (rule) => [patch<BranchRule[]>(keys.branchRules(project), (old) => old.map((r) => (r.pattern === rule.pattern ? rule : r)))],
		invalidate: () => [keys.branches(project)],
		action: "change the rule",
	});
	const remove = useOptimistic({
		mutationFn: (p: string) => api.deleteBranchRule(project, p),
		apply: (p) => [patch<BranchRule[]>(keys.branchRules(project), (old) => old.filter((r) => r.pattern !== p))],
		invalidate: () => [keys.branches(project)],
		action: "remove the rule",
	});

	return (
		<Panel title="Branch protection" actions={<span className="text-[11px] text-faint">The merge queue is never blocked</span>}>
			{rules.isPending ? (
				<Spinner className="m-4" />
			) : rules.data?.length ? (
				<ul className="divide-y divide-line/60">
					{rules.data.map((r) => (
						<li key={r.pattern} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
							<ShieldCheck className="size-4 text-emerald-300" />
							<span className="font-mono text-fg">{r.pattern}</span>
							<span className="flex flex-1 flex-wrap gap-1.5">
								{OPTIONS.filter((o) => r[o.id]).map((o) => (
									<button
										key={o.id}
										type="button"
										title="Click to turn off"
										onClick={() => {
											const next = { ...r, [o.id]: false };
											// Turning off the last protection removes the rule.
											if (!OPTIONS.some((option) => next[option.id])) {
												if (confirm(`Stop protecting ${r.pattern}?`)) remove.mutate(r.pattern);
											} else change.mutate(next);
										}}
										className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-dim hover:text-fg"
									>
										{o.label}
									</button>
								))}
							</span>
							<Button
								variant="ghost"
								className="px-2 text-xs hover:text-red-300"
								onClick={() => confirm(`Stop protecting ${r.pattern}?`) && remove.mutate(r.pattern)}
								aria-label={`Remove the rule for ${r.pattern}`}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</li>
					))}
				</ul>
			) : (
				<div className="p-4">
					<Empty icon={<ShieldCheck className="size-6" />} title="No protected branches">
						Protect {defaultBranch} so history can't be rewritten or deleted by mistake.
					</Empty>
				</div>
			)}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					save.mutate({ pattern: pattern.trim(), ...flags });
				}}
				className="space-y-3 border-t border-line p-4"
			>
				<Field label="Branch name or pattern" hint="* matches within one path segment (release/*), ** across them (release/**)">
					<Input value={pattern} onChange={(e) => setPattern(e.target.value)} required className="font-mono" />
				</Field>
				<fieldset className="space-y-2">
					{OPTIONS.map((o) => (
						<label key={o.id} className="flex items-start gap-2 text-sm">
							<input type="checkbox" className="mt-1" checked={flags[o.id]} onChange={(e) => setFlags({ ...flags, [o.id]: e.target.checked })} />
							<span>
								<span className="text-fg">{o.label}</span>
								<span className="block text-[11px] text-faint">{o.hint}</span>
							</span>
						</label>
					))}
				</fieldset>
				<ErrorNote error={save.error ?? rules.error} />
				<Button type="submit" busy={save.isPending}>
					<Plus className="size-4" />
					Save rule
				</Button>
			</form>
		</Panel>
	);
}
