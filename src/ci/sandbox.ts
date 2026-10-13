/**
 * A Linux machine a CI job runs in: a Cloudflare container attached to the job's Durable Object, or a
 * Depot sandbox. Both only need to run short commands to completion; long steps are started detached
 * by one command and read back by others (see script.ts), so nothing depends on a request staying open.
 */

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Run as root. Cloudflare containers run as root already; Depot runs the command through `sudo -E`. */
	root?: boolean;
	/** Give up (and kill the command) after this long. */
	timeoutMs?: number;
	/**
	 * The command only starts something in the background, which must outlive it. A sandbox may then
	 * return as soon as it has started, with exit code 0 and no output (Depot documents that only
	 * detached commands' processes keep running), so the caller checks the outcome separately.
	 */
	detached?: boolean;
}

export interface Sandbox {
	exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
	/**
	 * Writes a private file (mode 0600, parent folders created). This is how scripts holding secrets
	 * reach the machine: a command's environment can be kept by the provider (Depot stores each
	 * command's env with its history), a file's content isn't.
	 */
	writeFile(path: string, content: string): Promise<void>;
	/**
	 * Reads a file back. This is how what steps write to $GITHUB_ENV (which may hold secrets) comes back:
	 * a command's output can be kept by the provider, a file read isn't.
	 */
	readFile(path: string): Promise<string>;
}

/** A command that took longer than its `timeoutMs`. */
export class ExecTimeoutError extends Error {}

/** How long a control command (launch, poll, kill) may take; steps themselves run detached. */
export const EXEC_TIMEOUT_MS = 60_000;

/**
 * Cloudflare's managed image: Node.js 24 on Debian Trixie slim, usable with the `durable-object`
 * scheduling policy without a registry. It has no git, so checkout installs it with apt-get.
 * https://developers.cloudflare.com/containers/guides/image-management/
 */
export const CLOUDFLARE_IMAGE = "cloudflare/debian-trixie";
/** The name of the image map entry (container/ci/Dockerfile) used in preference to the managed image. */
export const CLOUDFLARE_IMAGE_NAME = "ci";
/**
 * The machine size: 1 vCPU, 6 GiB of memory and 12 GB of disk. The default (`lite`, 1/16 vCPU and
 * 256 MiB) is too small to install a project's dependencies.
 */
export const CLOUDFLARE_INSTANCE = "standard-2" as const;
/** Containers keep running at most this long after the Durable Object goes idle (Cloudflare's limit). */
const MAX_INACTIVITY_MS = 6 * 3600_000;

/** The parts of `ctx.container` used here. https://developers.cloudflare.com/durable-objects/api/container/ */
export interface ContainerLike {
	readonly running: boolean;
	readonly images?: Record<string, string>;
	start(options: { image: string; entrypoint?: string[]; enableInternet: boolean; env?: Record<string, string>; instance?: "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4" }): void;
	exec(cmd: string[], options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; stdin?: ReadableStream }): Promise<{ output(): Promise<{ exitCode: number; stdout: ArrayBuffer; stderr: ArrayBuffer }> }>;
	destroy(reason?: unknown): Promise<void>;
	setInactivityTimeout(durationMs: number): Promise<void>;
}

export class CloudflareSandbox implements Sandbox {
	private readonly container: ContainerLike;

	constructor(container: ContainerLike) {
		this.container = container;
	}

	get running(): boolean {
		return this.container.running;
	}

	/** The image to boot: the deployment's CI image if it has one, else Cloudflare's managed Debian. */
	image(): string {
		return this.container.images?.[CLOUDFLARE_IMAGE_NAME] ?? CLOUDFLARE_IMAGE;
	}

	/**
	 * Starts the container if it isn't running. `start` returns before the container is ready, so the
	 * first commands may fail for a moment; callers retry. Jobs need the Internet for code and packages.
	 */
	start(): void {
		if (this.container.running) return;
		this.container.start({ image: this.image(), instance: CLOUDFLARE_INSTANCE, entrypoint: ["sleep", "infinity"], enableInternet: true });
	}

	/**
	 * Keeps the container alive while the Durable Object sleeps between alarms. The timeout belongs to
	 * the object instance, so it's set again after the object restarts.
	 */
	async keepAlive(untilMs: number): Promise<void> {
		const ms = Math.min(MAX_INACTIVITY_MS, Math.max(60_000, untilMs - Date.now()));
		await this.container.setInactivityTimeout(ms);
	}

	/** Container commands run as root, attached: a background process outlives them, so `detached` changes nothing. */
	exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
		return this.run(argv, opts);
	}

	/** Pipes the content to `cat` on stdin, so it never appears in an argument or the environment. */
	async writeFile(path: string, content: string): Promise<void> {
		const bytes = new TextEncoder().encode(content);
		const stdin = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
		const result = await this.run(["sh", "-c", 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv "$1.tmp" "$1"', "sh", path], {}, stdin);
		if (result.exitCode !== 0) throw new Error(`Writing ${path} in the container failed: ${result.stderr.trim().slice(0, 300)}`);
	}

	/** Container commands aren't kept anywhere, so this reads with `cat`. */
	async readFile(path: string): Promise<string> {
		const result = await this.run(["cat", path], {});
		if (result.exitCode !== 0) throw new Error(`Reading ${path} in the container failed: ${result.stderr.trim().slice(0, 300)}`);
		return result.stdout;
	}

	private async run(argv: string[], opts: ExecOptions, stdin?: ReadableStream<Uint8Array>): Promise<ExecResult> {
		// exec has no timeout of its own; aborting its signal SIGKILLs the command. Cloudflare warns that
		// aborting after the process has exited raises an uncaught error in the Durable Object, so this is
		// an AbortController whose timer is cleared the moment the command settles, never AbortSignal.timeout.
		const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const process = await this.container.exec(argv, { cwd: opts.cwd, env: opts.env, signal: controller.signal, ...(stdin ? { stdin } : {}) });
			const output = await process.output();
			const decoder = new TextDecoder();
			return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) };
		} catch (err) {
			if (controller.signal.aborted) throw new ExecTimeoutError(`A command in the container took longer than ${Math.round(timeoutMs / 1000)}s`);
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	async destroy(): Promise<void> {
		if (this.container.running) await this.container.destroy("The CI job ended");
	}
}
