import { DurableObject } from "cloudflare:workers";
import type { ProjectCoordinator } from "../project.ts";
import { CloudflareMachine, DepotMachine, JobRunner, newJobState, type JobLaunch, type JobState, type Machine } from "./runner.ts";

export type { Conclusion, JobLaunch, JobReport, StepState, StepStatus } from "./runner.ts";
export { completeUtf8 } from "./script.ts";

/**
 * Runs one CI job: one Durable Object per job, driven by its alarm. It brings up a machine (a
 * Cloudflare container attached to this object, or a Depot sandbox), checks the commit out, then runs
 * the steps one after another, each detached on the machine while the alarm reads its log every couple
 * of seconds (runner.ts). Progress and logs go back to the repository's coordinator, which owns the run.
 *
 * The launch (which holds secrets and the steps) and the job's state are saved under separate keys, so
 * neither grows with the other; the log waiting to be reported is kept small by reading no further
 * while it's large.
 */

/** Log text sent to the coordinator per report at most. */
const REPORT_BYTES = 256 * 1024;
/** Ticks run back to back while a step prints faster than one tick reads. */
const BURST = 6;

export class CiJob extends DurableObject<Env> {
	private machine: Machine | undefined;

	private machineFor(launch: JobLaunch): Machine {
		if (this.machine) return this.machine;
		if (launch.runner.kind === "depot") this.machine = new DepotMachine(launch.runner.credentials, launch.runner.vcpus);
		else {
			const container = this.ctx.container;
			if (!container) throw new Error("This server has no Cloudflare container runner configured");
			this.machine = new CloudflareMachine(container);
		}
		return this.machine;
	}

	private async load(): Promise<{ launch: JobLaunch; state: JobState } | undefined> {
		const [launch, state] = await Promise.all([this.ctx.storage.get<JobLaunch>("launch"), this.ctx.storage.get<JobState>("state")]);
		return launch && state ? { launch, state } : undefined;
	}

	/** Starts the job. Calling it again for the same job does nothing, even after it has settled. */
	async start(launch: JobLaunch): Promise<void> {
		const [state, settled] = await Promise.all([this.ctx.storage.get("state"), this.ctx.storage.get("settled")]);
		if (state || settled) return;
		await this.ctx.storage.put({ launch, state: newJobState(launch) });
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** Cancels the job: the running step is stopped, then always() and cancelled() steps run before the machine goes. */
	async cancel(): Promise<void> {
		const state = await this.ctx.storage.get<JobState>("state");
		if (!state) return;
		if (state.phase === "done") {
			// Already over, but the machine may still be up: try stopping it again now.
			if (!state.machineStopped) {
				state.nextCleanupAt = 0;
				await this.ctx.storage.put("state", state);
				await this.ctx.storage.setAlarm(Date.now());
			}
			return;
		}
		// Its own key: an alarm in progress holds the state in memory and would write over a flag set in it.
		await this.ctx.storage.put("cancel", true);
		await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm(): Promise<void> {
		const loaded = await this.load();
		if (!loaded) return;
		const { launch, state } = loaded;
		const save = () => this.ctx.storage.put("state", state);
		let runner: JobRunner;
		try {
			runner = new JobRunner(launch, state, this.machineFor(launch), save);
		} catch (err) {
			// No machine to run on: settle the job as failed rather than retrying forever.
			runner = new JobRunner(launch, state, { provision: () => Promise.reject(err), sandbox: () => { throw err; }, alive: async () => false, destroy: async () => {}, describe: () => "a machine" }, save);
		}
		for (let burst = 0; burst < BURST; burst++) {
			if (!runner.done && (await this.ctx.storage.get<boolean>("cancel"))) runner.cancel();
			const more = await runner.tick();
			await save();
			// Once the coordinator has everything, later wakes only retry stopping the machine.
			let delivered = true;
			if (runner.reportsDue) {
				delivered = await this.report(runner, launch.repo, launch.jobId);
				await save();
			}
			if (!more || !delivered) break;
		}
		if (runner.done) {
			// The expanded steps (which may hold secrets) aren't needed any more; the provider's credentials
			// are, until the machine has been stopped.
			await this.ctx.storage.put("launch", scrub(launch, !state.machineStopped));
		}
		const wake = runner.nextWake();
		if (wake === null) {
			// Settled: the coordinator has everything and the machine is stopped. Only a marker stays, so a
			// late start() still does nothing.
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
			await this.ctx.storage.put("settled", true);
		} else await this.ctx.storage.setAlarm(wake);
	}

	/** Sends progress and new log text to the coordinator; whatever doesn't get through is sent again next time. */
	private async report(runner: JobRunner, repo: string, jobId: string): Promise<boolean> {
		const report = runner.nextReport(REPORT_BYTES);
		try {
			const ack = await (this.env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(repo).ciReport(jobId, report);
			runner.acked(report);
			// The run was cancelled (or is gone) even if the cancel call itself never arrived.
			if (ack?.cancel && !runner.done) runner.cancel();
			return true;
		} catch (err) {
			console.error("ci: reporting failed", err);
			return false;
		}
	}
}

function scrub(launch: JobLaunch, keepCredentials: boolean): JobLaunch {
	return {
		...launch,
		runner: launch.runner.kind === "depot" && !keepCredentials ? { kind: "depot", vcpus: launch.runner.vcpus, credentials: { token: "" } } : launch.runner,
		plan: { units: [], ui: launch.plan.ui, actions: [] },
		env: {},
		secrets: {},
		mask: [],
		checkout: { ...launch.checkout, auth: "" },
		api: { ...launch.api, token: "" },
	};
}
