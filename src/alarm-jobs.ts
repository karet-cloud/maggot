// When a coordinator's alarm runs its regular jobs (merges, provisioning, webhooks, Actions). The tree
// index wakes the alarm every few seconds while it works; those wake-ups run only the index, and the
// jobs run when something asked for them. Kept apart from the coordinator so it can be tested alone.
import type { Sql } from "./search.ts";

/** Stored when no job is waiting: later than any alarm. */
const NONE = Number.MAX_SAFE_INTEGER;

export class JobSchedule {
	private readonly sql: Sql;
	/** Requests seen by this instance, to tell whether any came in while the jobs ran. */
	private asked = 0;

	constructor(sql: Sql) {
		this.sql = sql;
	}

	/** When the jobs next need to run; null if unknown (as before anything was recorded), which counts as now. */
	due(): number | null {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'jobsDue'").toArray()[0];
		return row ? Number(row.value) : null;
	}

	private set(due: number) {
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('jobsDue', ?)", String(due));
	}

	/** The jobs must run by `at`. */
	want(at: number): void {
		this.asked++;
		const due = this.due();
		if (due === null || at < due) this.set(at);
	}

	/**
	 * Runs `jobs` if they're due. They count as done only once they've finished, and only if nothing
	 * asked for them again meanwhile: an alarm that dies partway (mid-merge, say) leaves them due, so
	 * the runtime's retry of the alarm runs them again rather than skipping them. True if they ran.
	 */
	async run(now: number, jobs: () => Promise<void>): Promise<boolean> {
		const due = this.due();
		if (due !== null && due > now) return false;
		const asked = this.asked;
		await jobs();
		if (this.asked === asked && this.due() === due) this.set(NONE);
		return true;
	}
}
