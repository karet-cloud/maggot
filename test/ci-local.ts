// A Sandbox that runs commands on this machine, for testing the job scripts for real. The scripts use
// fixed paths (/tmp/megit, /tmp/megit-inbox, /tmp/megit-user, /workspace); these are swapped for a temporary directory in every argument
// and environment value, so tests don't touch the real ones or each other.
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecOptions, ExecResult, Sandbox } from "../src/ci/sandbox.ts";
import { INBOX_DIR, STATE_DIR, USER_DIR, WORKSPACE } from "../src/ci/script.ts";

export class LocalSandbox implements Sandbox {
	readonly root = mkdtempSync(join(tmpdir(), "mgci-test-"));
	readonly state = join(this.root, "state");
	readonly workspace = join(this.root, "workspace");
	readonly inbox = join(this.root, "inbox");
	readonly user = join(this.root, "user");
	/** Every command run, for assertions. */
	readonly calls: { argv: string[]; opts: ExecOptions }[] = [];
	/** Files written, by their unswapped path. */
	readonly files: { path: string; content: string }[] = [];
	/** Return from detached commands at once, without waiting for them, as Depot does. */
	asyncDetached = false;

	/** Only whole paths: the start of a value or after a space, quote or `=`, and not part of a longer name. */
	private swap(text: string): string {
		const path = (p: string) => new RegExp(`(^|[\\s"'=:;(])${p.replaceAll("/", "\\/")}(?![\\w.-])`, "gm");
		return text.replace(path(INBOX_DIR), `$1${this.inbox}`).replace(path(USER_DIR), `$1${this.user}`).replace(path(STATE_DIR), `$1${this.state}`).replace(path(WORKSPACE), `$1${this.workspace}`);
	}

	async readFile(path: string): Promise<string> {
		return readFileSync(this.swap(path), "utf8");
	}

	async writeFile(path: string, content: string): Promise<void> {
		this.files.push({ path, content });
		const target = this.swap(path);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(`${target}.tmp`, this.swap(content), { mode: 0o600 });
		renameSync(`${target}.tmp`, target);
	}

	exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
		this.calls.push({ argv, opts });
		return this.execRaw(argv, opts);
	}

	/** Runs a command with paths swapped, feeding `stdin` if given. */
	protected execRaw(argv: string[], opts: ExecOptions, stdin?: string): Promise<ExecResult> {
		const env = Object.fromEntries(Object.entries(opts.env ?? {}).map(([k, v]) => [k, this.swap(v)]));
		if (opts.detached && this.asyncDetached) {
			// Started a moment later, and never waited on.
			setTimeout(() => {
				spawn(argv[0], argv.slice(1).map((a) => this.swap(a)), { env: { PATH: process.env.PATH, HOME: this.root, ...env }, stdio: "ignore" }).unref();
			}, 100);
			return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
		}
		return new Promise((resolve, reject) => {
			const child = execFile(argv[0], argv.slice(1).map((a) => this.swap(a)), { env: { PATH: process.env.PATH, HOME: this.root, ...env }, cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err && typeof err.code !== "number") return reject(err);
				resolve({ exitCode: typeof err?.code === "number" ? err.code : 0, stdout, stderr });
			});
			if (stdin !== undefined) child.stdin?.end(this.swap(stdin));
			else child.stdin?.end();
		});
	}
}

/**
 * A sandbox with a real root and a real ordinary user, for testing what steps can and can't reach. Every
 * command runs inside one user namespace (kept open by a `sleep` this class starts and stops): root
 * there for `root` commands, which also get SUDO_UID=1000 as Depot's sudo would set, and uid 1000
 * otherwise. Files are written and read as uid 1000, as a provider's file API might. Needs unprivileged
 * user namespaces with subordinate ids (`unshare --map-auto`); `available()` says whether they work.
 */
export class NamespaceSandbox extends LocalSandbox {
	static readonly UID = 1000;
	private readonly holder;

	static available(): boolean {
		try {
			return execFileSync("unshare", ["--user", "--map-root-user", "--map-auto", "sh", "-c", "setpriv --reuid=1000 --regid=1000 --clear-groups id -u"]).toString().trim() === "1000";
		} catch {
			return false;
		}
	}

	constructor() {
		super();
		// Like /tmp: anyone may create files, only owners may remove them.
		chmodSync(this.root, 0o1777);
		this.holder = spawn("unshare", ["--user", "--map-root-user", "--map-auto", "sleep", "3600"], { stdio: "ignore" });
	}

	/** Waits until the namespace is up (its uid map written). */
	async ready(): Promise<void> {
		for (let i = 0; i < 100; i++) {
			try {
				// Root's mapping, then the subordinate range for everyone else.
				if (readFileSync(`/proc/${this.holder.pid}/uid_map`, "utf8").trim().split("\n").length >= 2) return;
			} catch {}
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error("the user namespace didn't come up");
	}

	/** Removes this sandbox's directory (some of it the namespace's users' own), then stops the namespace's own `sleep`. */
	close() {
		try {
			execFileSync("nsenter", ["--user", `--target=${this.holder.pid}`, "--", "rm", "-rf", this.root]);
		} finally {
			this.holder.kill("SIGKILL");
		}
	}

	private wrap(argv: string[], root: boolean): string[] {
		const as = root ? ["env", `SUDO_UID=${NamespaceSandbox.UID}`, `SUDO_GID=${NamespaceSandbox.UID}`] : ["setpriv", `--reuid=${NamespaceSandbox.UID}`, `--regid=${NamespaceSandbox.UID}`, "--clear-groups"];
		return ["nsenter", "--user", `--target=${this.holder.pid}`, "--", ...as, ...argv];
	}

	override exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
		this.calls.push({ argv, opts });
		const [cmd, ...rest] = this.wrap(argv, opts.root === true);
		return super.execRaw([cmd, ...rest], opts);
	}

	override async writeFile(path: string, content: string): Promise<void> {
		this.files.push({ path, content });
		const result = await super.execRaw(this.wrap(["sh", "-c", 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv "$1.tmp" "$1"', "sh", path], false), {}, content);
		if (result.exitCode !== 0) throw new Error(`writing ${path} failed: ${result.stderr}`);
	}

	override async readFile(path: string): Promise<string> {
		const result = await super.execRaw(this.wrap(["cat", path], false), {});
		if (result.exitCode !== 0) throw new Error(`reading ${path} failed: ${result.stderr}`);
		return result.stdout;
	}
}
