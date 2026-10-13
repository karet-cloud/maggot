/**
 * The shell side of a CI job. Every step (the checkout too) runs detached inside the sandbox, in its
 * own process group, writing its output to a log file and its exit code to a file when it ends; the
 * job's Durable Object starts it with one short command and reads both in slices with others. Nothing
 * depends on one long request staying open, so long jobs and Durable Object restarts are fine.
 *
 * Secrets never go in a command's arguments, environment or output (Depot keeps all three with each
 * command): scripts arrive as files (Sandbox.writeFile), logs are masked on the machine, and what steps
 * write to $GITHUB_ENV comes back as files too (Sandbox.readFile).
 *
 * Control commands run as root (Depot: through sudo). Steps run as the machine's own user (Depot's
 * SUDO_UID; root on Cloudflare), dropped to with setpriv, so the state directory, the checkout's files
 * and the mask files, all root's and private, are out of their reach.
 */

import type { StepSpec } from "./workflow.ts";

export const WORKSPACE = "/workspace";
/** Root's: locks, logs, exit codes, masks, and the checkout's script. */
export const STATE_DIR = "/tmp/megit";
/** The steps' user's: their scripts and the $GITHUB_* files. */
export const USER_DIR = "/tmp/megit-user";
/**
 * Where scripts and masks are written (by Sandbox.writeFile, as whichever user the provider writes
 * files as) before a launch takes them. Each try at a launch writes its own files, so a slow launch
 * from an earlier try can never take a file that's being written again.
 */
export const INBOX_DIR = "/tmp/megit-inbox";

/** Where a process's script waits for its launch, for one try (`attempt`). */
export const inboxPath = (id: string, attempt: number) => `${INBOX_DIR}/step-${id}.${attempt}.sh`;
/** Where a process's mask file (values to hide in its log, one per line) waits for its launch. */
export const inboxMaskPath = (id: string, attempt: number) => `${INBOX_DIR}/step-${id}.${attempt}.mask`;

/** The mask file's content: what LogMasker would hide, longest first, one per line (multi-line values go by line). */
export function maskFile(secrets: string[]): string {
	const values = maskValues(secrets)
		.filter((v) => !/[\r\n]/.test(v))
		.sort((a, b) => b.length - a.length);
	return values.length ? `${values.join("\n")}\n` : "";
}

/** The secrets a script holds (as written in it, shell-quoted or not): all a step's log could show. */
export function secretsIn(script: string, secrets: string[]): string[] {
	const found = (v: string) => script.includes(v) || script.includes(v.replaceAll("'", `'\\''`));
	return secrets.filter((v) => v && (found(v) || v.split(/\r?\n/).some((line) => line.trim().length >= MIN_MASKED_LENGTH && found(line.trim()))));
}

/** Files steps append to, as on GitHub: `NAME=value` lines (or `NAME<<EOF` blocks) and PATH entries. */
export const ENV_FILE = `${USER_DIR}/github-env`;
export const PATH_FILE = `${USER_DIR}/github-path`;
const OUTPUT_FILE = `${USER_DIR}/github-output`;
const SUMMARY_FILE = `${USER_DIR}/github-step-summary`;
/** Where a step's $GITHUB_ENV and $GITHUB_PATH are copied after it, to be read back as files. */
export const collectedPath = (id: string, which: "env" | "path") => `${USER_DIR}/collect-${id}.${which}`;

/** The id of the checkout in the sandbox's state directory; steps use their index. */
export const SETUP_ID = "setup";

/** Single-quotes a value for sh. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const exports = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`);

/** The steps' user (Depot's sudo sets SUDO_UID), else whoever runs this. */
const OWNER = `owner="\${SUDO_UID:-$(id -u)}:\${SUDO_GID:-$(id -g)}"`;

/**
 * Checks out `sha` from `ref` of the repository at `url`, run as root: installs git if the image lacks
 * it, then hands the workspace to the steps' user. The token goes to git through GIT_CONFIG_*
 * variables, so it never shows in a process list, and the file holding it (root's, in the state
 * directory) is deleted when the checkout ends.
 */
export function checkoutFile(c: { url: string; auth: string; ref: string; sha: string; depth: number }): string {
	return `${exports({ MEGIT_CLONE_URL: c.url, MEGIT_CLONE_AUTH: c.auth, MEGIT_REF: c.ref, MEGIT_SHA: c.sha, MEGIT_DEPTH: String(c.depth) }).join("\n")}
${OWNER}
if ! command -v git >/dev/null 2>&1; then
  echo "Installing git…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
  else
    echo "git isn't installed in this image and there's no apt-get to install it" >&2
    exit 1
  fi
fi
git --version
mkdir -p ${WORKSPACE}
cd ${WORKSPACE}
git init -q
git remote add origin "$MEGIT_CLONE_URL" 2>/dev/null || git remote set-url origin "$MEGIT_CLONE_URL"
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $MEGIT_CLONE_AUTH"
target="+$MEGIT_REF:refs/remotes/origin/checkout"
echo "Fetching $MEGIT_REF from $MEGIT_CLONE_URL"
if [ "$MEGIT_DEPTH" = 0 ]; then
  git fetch -q --no-tags --prune origin "$target"
else
  git fetch -q --no-tags --prune --depth="$MEGIT_DEPTH" origin "$target"
  # The branch may have moved past the commit since the run started: dig further back for it.
  if ! git cat-file -e "$MEGIT_SHA^{commit}" 2>/dev/null; then
    git fetch -q --no-tags --unshallow origin "$target" || true
  fi
fi
if ! git cat-file -e "$MEGIT_SHA^{commit}" 2>/dev/null; then
  echo "$MEGIT_SHA isn't on $MEGIT_REF any more (was it force-pushed?)" >&2
  exit 1
fi
case "$MEGIT_REF" in
  refs/heads/*) git checkout -q -B "\${MEGIT_REF#refs/heads/}" "$MEGIT_SHA" ;;
  *) git -c advice.detachedHead=false checkout -q --detach "$MEGIT_SHA" ;;
esac
echo "Checked out $(git log -1 --format='%h %s')"
if [ "$(id -u)" = 0 ]; then chown -R "$owner" ${WORKSPACE}; fi
`;
}

/**
 * The file a step runs: its environment, then its script. GitHub runs bash steps with
 * `bash --noprofile --norc -eo pipefail` and sh steps with `sh -e`; so does this. `added` is what
 * earlier steps wrote to $GITHUB_ENV, and `path` what they wrote to $GITHUB_PATH.
 */
export function stepFile(step: StepSpec, env: Record<string, string>, added: Record<string, string> = {}, path: string[] = []): string {
	const files = { GITHUB_ENV: ENV_FILE, GITHUB_PATH: PATH_FILE, GITHUB_OUTPUT: OUTPUT_FILE, GITHUB_STEP_SUMMARY: SUMMARY_FILE };
	const lines = exports({ ...env, ...added, ...step.env, ...files });
	if (path.length) lines.push(`export PATH=${shellQuote(path.toReversed().join(":"))}:"$PATH"`);
	const dir = step.workingDirectory ? `${WORKSPACE}/${step.workingDirectory}` : WORKSPACE;
	lines.push(`cd ${shellQuote(dir)}`);
	return `${lines.join("\n")}\n${step.run ?? ""}\n`;
}

export function stepInterpreter(step: Pick<StepSpec, "shell">): string {
	return step.shell === "sh" ? "sh -e" : "bash --noprofile --norc -eo pipefail";
}

/**
 * Runs one detached command: `sh wrap.sh <base> <script> <interpreter…>`, as root. It runs the script
 * (as the user named in <base>.user, if any, through setpriv) with its output to the log, then writes
 * the exit code atomically. When a cancel signals the whole group, it outlives the script and records
 * how it ended: it catches SIGTERM with a handler that does nothing, rather than ignoring it, since an
 * ignored signal would stay ignored in the script too.
 *
 * With a mask file (root's, one value per line), output goes through awk, run as root, on its way to the
 * log, line by line, with each value replaced by ***: the log never holds a secret, so neither does
 * any command that reads it. The filter ignores SIGTERM so that it writes out everything the script
 * printed before a cancel; a partial last line shows once the line ends or the step does.
 */
const MASK_FILTER = `BEGIN { while ((getline line < masks) > 0) if (length(line) > 0) m[++n] = line }
{ for (i = 1; i <= n; i++) { rest = $0; out = ""; while ((p = index(rest, m[i])) > 0) { out = out substr(rest, 1, p - 1) "***"; rest = substr(rest, p + length(m[i])) } $0 = out rest } print; fflush() }`;

const WRAPPER = `f=$1; script=$2; shift 2
trap : TERM
if [ -s "$f.user" ]; then
  IFS=: read -r uid gid < "$f.user"
  entry=$(getent passwd "$uid" || true)
  name=$(printf '%s' "$entry" | cut -d: -f1)
  home=$(printf '%s' "$entry" | cut -d: -f6)
  if [ -n "$name" ]; then groups=--init-groups; else groups=--clear-groups; fi
  set -- env HOME="\${home:-/tmp}" USER="$name" LOGNAME="$name" setpriv --reuid="$uid" --regid="$gid" $groups -- "$@"
fi
if [ -s "$f.mask" ]; then
  { trap - TERM; "$@" "$script" < /dev/null; echo $? > "$f.code"; } 2>&1 | (trap '' TERM; exec awk -v masks="$f.mask" ${shellQuote(MASK_FILTER)}) > "$f.log"
  code=$(cat "$f.code" 2>/dev/null || echo 143)
else
  "$@" "$script" > "$f.log" 2>&1 < /dev/null
  code=$?
fi
rm -f "$script" "$f.mask" "$f.code"
echo "$code" > "$f.exit.tmp" && mv "$f.exit.tmp" "$f.exit"
`;

/**
 * Takes this try's script (and mask) from the inbox and starts it in the background, then returns; run
 * as root. A launch that's retried (the answer was lost, or the Durable Object restarted) finds the
 * lock and does nothing but clear the inbox, so a step never runs twice. Failing to take the lock for
 * any other reason (a full disk, say) is an error, and anything failing after it is recorded as the
 * step's own failure, so a poll never waits on a step that can't start. Without the tools to mask its
 * log (awk) or drop to the steps' user (setpriv), a step isn't started at all.
 *
 * State is created private (umask 077); the step itself runs with umask 022, as on GitHub.
 */
export const LAUNCH_SCRIPT = `set -e
umask 077
${OWNER}
own() { if [ "$(id -u)" = 0 ]; then chown "$@"; fi; }
mkdir -p ${STATE_DIR} ${USER_DIR}
chmod 700 ${STATE_DIR}
own "$owner" ${USER_DIR}
chmod 711 ${USER_DIR}
f=${STATE_DIR}/step-$MEGIT_ID
in=${INBOX_DIR}/step-$MEGIT_ID.$MEGIT_ATTEMPT
discard() { rm -f ${INBOX_DIR}/step-$MEGIT_ID.*; }
if [ -d "$f.lock" ]; then discard; exit 0; fi
if ! mkdir "$f.lock"; then
  [ -d "$f.lock" ] && { discard; exit 0; }
  echo "Couldn't take the lock for step $MEGIT_ID" >&2
  exit 1
fi
broken() { echo "$1" > "$f.log" || true; discard; echo 126 > "$f.exit.tmp" && mv "$f.exit.tmp" "$f.exit"; echo "$1" >&2; exit 1; }
[ -f "$in.sh" ] || broken "The step's script never reached the machine"
user=""
if [ "$MEGIT_AS_USER" = 1 ] && [ "\${SUDO_UID:-0}" != 0 ]; then
  command -v setpriv >/dev/null 2>&1 || broken "setpriv (util-linux) is needed to run steps as the machine's user"
  user="$SUDO_UID:\${SUDO_GID:-$SUDO_UID}"
  printf '%s\\n' "$user" > "$f.user"
fi
if [ -n "$user" ]; then script=${USER_DIR}/step-$MEGIT_ID.sh; else script="$f.sh"; fi
mv "$in.sh" "$script" || broken "Couldn't move the step's script into place"
if [ -n "$user" ]; then own "$user" "$script"; else own 0:0 "$script"; fi
chmod 600 "$script"
if [ -f "$in.mask" ]; then
  command -v awk >/dev/null 2>&1 || broken "awk is needed to hide secrets in the step's log, and this machine has none"
  mv "$in.mask" "$f.mask" || broken "Couldn't move the step's mask into place"
  own 0:0 "$f.mask"
  chmod 600 "$f.mask"
fi
discard
printf '%s' ${shellQuote(WRAPPER)} > "$f.wrap" || broken "Couldn't write the step's wrapper"
: > "$f.log" || broken "Couldn't create the step's log"
for g in ${ENV_FILE} ${PATH_FILE} ${OUTPUT_FILE} ${SUMMARY_FILE}; do
  [ -e "$g" ] || { : > "$g" && own "$owner" "$g"; } || broken "Couldn't create the step's environment files"
done
umask 022
if command -v setsid >/dev/null 2>&1; then
  setsid sh "$f.wrap" "$f" "$script" $MEGIT_INTERPRETER > /dev/null 2>&1 < /dev/null &
else
  nohup sh "$f.wrap" "$f" "$script" $MEGIT_INTERPRETER > /dev/null 2>&1 < /dev/null &
fi
echo $! > "$f.pid"
`;

/**
 * Prints the step's state, the log's size, then up to $MEGIT_MAX bytes of the log from $MEGIT_OFFSET
 * as base64, so byte counts stay exact even when a slice ends inside a UTF-8 character. The state is:
 * - its exit code, once it has ended (written only after the log is complete, and read before it);
 * - `running`, while its wrapper lives (or for a minute after the lock, before the pid is written);
 * - `lost`, if the wrapper died without recording an exit code (killed for memory, say);
 * - `pending`, if its script is waiting for a launch that hasn't run yet (Depot's start detached);
 * - `missing`, if the machine has no trace of it, as after it was replaced.
 */
export const POLL_SCRIPT = `f=${STATE_DIR}/step-$MEGIT_ID
if [ -e "$f.exit" ]; then
  head -n 1 "$f.exit"
elif [ -d "$f.lock" ]; then
  pid=$(cat "$f.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo running
  elif [ -e "$f.exit" ]; then head -n 1 "$f.exit"
  elif [ -z "$pid" ] && [ -n "$(find "$f.lock" -maxdepth 0 -mmin -1 2>/dev/null)" ]; then echo running
  else echo lost
  fi
elif ls ${INBOX_DIR}/step-$MEGIT_ID.*.sh > /dev/null 2>&1; then echo pending
else echo missing
fi
wc -c < "$f.log" 2>/dev/null || echo 0
if [ "$MEGIT_MAX" -gt 0 ]; then tail -c +$((MEGIT_OFFSET + 1)) "$f.log" 2>/dev/null | head -c "$MEGIT_MAX" | base64 | tr -d '\\n'; fi
echo
`;

/**
 * Signals the step's process group: TERM first; KILL later, which also takes the wrapper, so it records
 * the exit code itself (137, as a shell reports SIGKILL).
 */
export const KILL_SCRIPT = `f=${STATE_DIR}/step-$MEGIT_ID
[ -e "$f.exit" ] && exit 0
pid=$(cat "$f.pid" 2>/dev/null) || exit 0
[ -n "$pid" ] || exit 0
kill -"$MEGIT_SIGNAL" -- "-$pid" 2>/dev/null || kill -"$MEGIT_SIGNAL" "$pid" 2>/dev/null || true
if [ "$MEGIT_SIGNAL" = KILL ]; then
  sleep 1
  [ -e "$f.exit" ] || { echo 137 > "$f.exit.tmp" && mv "$f.exit.tmp" "$f.exit"; }
fi
exit 0
`;

/** Bytes of $GITHUB_ENV or $GITHUB_PATH read after a step; more is reported as cut off. */
export const COLLECT_BYTES = 64 * 1024;

/**
 * After step $MEGIT_ID: copies up to COLLECT_BYTES of $GITHUB_ENV and $GITHUB_PATH to files of their
 * own (collectedPath), to be read back with Sandbox.readFile, then empties both for the next step.
 * Prints only the two files' full sizes, never their content (which may hold secrets). Run again for the
 * same step (an answer lost), it prints the same sizes without copying again.
 */
export const COLLECT_SCRIPT = `set -e
${OWNER}
out=${USER_DIR}/collect-$MEGIT_ID
if [ ! -e "$out.sizes" ]; then
  umask 077
  rm -f "$out.sizes.tmp"
  for g in env path; do
    if [ "$g" = env ]; then src=${ENV_FILE}; else src=${PATH_FILE}; fi
    wc -c < "$src" 2>/dev/null >> "$out.sizes.tmp" || echo 0 >> "$out.sizes.tmp"
    head -c ${COLLECT_BYTES} "$src" > "$out.$g.tmp" 2>/dev/null || : > "$out.$g.tmp"
    # Readable by whichever user the provider reads files as; it's what the step itself wrote.
    chmod 644 "$out.$g.tmp"
    mv "$out.$g.tmp" "$out.$g"
  done
  mv "$out.sizes.tmp" "$out.sizes"
  for src in ${ENV_FILE} ${PATH_FILE}; do : > "$src"; done
fi
tr -d ' ' < "$out.sizes"
`;

/** Bytes of log read per poll. */
export const POLL_BYTES = 128 * 1024;

export type PollState = number | "running" | "lost" | "pending" | "missing";

export interface PollResult {
	/** The exit code once it has ended; otherwise what's known (see POLL_SCRIPT). */
	state: PollState;
	/** The whole log's size so far. */
	size: number;
	bytes: Uint8Array;
}

/** Output from a control script that isn't what it prints: the command failed in a way it didn't report. */
export class ScriptOutputError extends Error {}

export function decodeBase64(encoded: string): Uint8Array {
	const clean = encoded.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new ScriptOutputError("A control command printed something that isn't base64");
	const bin = atob(clean);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

export function parsePoll(stdout: string): PollResult {
	const lines = stdout.split("\n");
	if (lines.length < 3) throw new ScriptOutputError(`Checking on a step printed ${JSON.stringify(stdout.slice(0, 100))}`);
	const [first, second, encoded] = lines.map((l) => l.trim());
	let state: PollState;
	if (/^\d{1,3}$/.test(first)) state = Number(first);
	else if (first === "running" || first === "lost" || first === "pending" || first === "missing") state = first;
	else throw new ScriptOutputError(`Checking on a step found the state ${JSON.stringify(first.slice(0, 40))}`);
	if (!/^\d+$/.test(second)) throw new ScriptOutputError(`Checking on a step found the log size ${JSON.stringify(second.slice(0, 40))}`);
	return { state, size: Number(second), bytes: decodeBase64(encoded) };
}

/** The full sizes of $GITHUB_ENV and $GITHUB_PATH that COLLECT_SCRIPT prints, one per line. */
export function parseCollectSizes(stdout: string): { env: number; path: number } {
	const lines = stdout.split("\n").map((l) => l.trim());
	if (lines.length < 2 || !/^\d+$/.test(lines[0]) || !/^\d+$/.test(lines[1])) throw new ScriptOutputError("Collecting $GITHUB_ENV and $GITHUB_PATH printed something unexpected");
	return { env: Number(lines[0]), path: Number(lines[1]) };
}

/** Names $GITHUB_ENV may not set, as on GitHub. */
const PROTECTED = new Set(["NODE_OPTIONS", "PATH", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]);

/**
 * Reads $GITHUB_ENV: `NAME=value` lines and `NAME<<DELIMITER` blocks. Anything malformed is reported
 * rather than guessed at.
 */
export function parseEnvFile(text: string): { env: Record<string, string>; errors: string[] } {
	const env = new Map<string, string>();
	const errors: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const heredoc = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(line);
		const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		let name: string;
		let value: string;
		if (heredoc) {
			name = heredoc[1];
			const end = lines.indexOf(heredoc[2], i + 1);
			if (end === -1) {
				errors.push(`$GITHUB_ENV: ${name}'s value never ends (no line with just ${heredoc[2]})`);
				break;
			}
			value = lines.slice(i + 1, end).join("\n");
			i = end;
		} else if (assign) [, name, value] = assign;
		else {
			errors.push(`$GITHUB_ENV: "${line.slice(0, 80)}" isn't NAME=value or NAME<<DELIMITER`);
			continue;
		}
		if (PROTECTED.has(name)) errors.push(`$GITHUB_ENV can't set ${name}`);
		else env.set(name, value);
	}
	// fromEntries defines own properties, so a variable called __proto__ is kept rather than setting the prototype.
	return { env: Object.fromEntries(env), errors };
}

export function parsePathFile(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Splits off a trailing incomplete UTF-8 sequence, so a character cut by a slice decodes whole next time. */
export function completeUtf8(bytes: Uint8Array): [Uint8Array, Uint8Array] {
	let i = bytes.length - 1;
	let back = 0;
	while (i >= 0 && back < 3 && (bytes[i] & 0xc0) === 0x80) {
		i--;
		back++;
	}
	if (i < 0) return [bytes, new Uint8Array(0)];
	const lead = bytes[i];
	const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return bytes.length - i < need ? [bytes.subarray(0, i), bytes.subarray(i)] : [bytes, new Uint8Array(0)];
}

/**
 * Values shorter than this aren't masked: they'd blank out ordinary words. runs.ts keeps secrets of
 * this length and up for masking, and the settings should warn about a secret shorter than it.
 */
export const MIN_MASKED_LENGTH = 3;
const MIN_SECRET = MIN_MASKED_LENGTH;

/**
 * A value as shells and tools commonly escape it when printing it: bash's `set -x` trace (single-quoted,
 * or $'…' for control characters), `printf %q`, and JSON. The raw value alone would miss these.
 */
function escapedForms(v: string): string[] {
	const ansi = v.replace(/[\\']/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
	const backslashed = v.replace(/[^A-Za-z0-9_\-.,:/@%+=]/g, "\\$&");
	return [v.replaceAll("'", `'\\''`), ansi, backslashed, JSON.stringify(v).slice(1, -1)];
}

/**
 * What to mask for a set of values: each value, each line of a multi-line one (logs are read by line),
 * and the escaped forms of both.
 */
export function maskValues(values: string[]): string[] {
	const out = new Set<string>();
	const add = (s: string) => {
		if (s.length < MIN_SECRET) return;
		out.add(s);
		for (const e of escapedForms(s)) out.add(e);
	};
	for (const v of values) {
		add(v);
		add(v.trim());
		for (const line of v.split(/\r?\n/)) add(line.trim());
	}
	return [...out];
}

/**
 * Replaces secret values with `***` in streamed output. A secret split across two chunks would slip
 * through a chunk-by-chunk replace, so the end of a chunk that could be the start of a secret is held
 * back, unmasked, until the next chunk shows whether it is. Everything else is shown at once.
 */
export class LogMasker {
	private readonly secrets: string[];
	private pending: string;

	/** `tail` is what an earlier masker for the same stream held back (saved between alarms). */
	constructor(secrets: string[], tail = "") {
		this.pending = tail;
		// Longest first, so a secret containing another is masked whole.
		this.secrets = maskValues(secrets).sort((a, b) => b.length - a.length);
	}

	/** The length of the longest end of `text` that a secret starts with (but isn't all of). */
	private partial(text: string): number {
		let hold = 0;
		for (const s of this.secrets) {
			const from = Math.max(0, text.length - s.length + 1);
			for (let at = text.indexOf(s[0], from); at !== -1 && text.length - at > hold; at = text.indexOf(s[0], at + 1)) {
				if (s.startsWith(text.slice(at))) {
					hold = text.length - at;
					break;
				}
			}
		}
		return hold;
	}

	/**
	 * Masks `text` up to `cut`, and past it for a secret that starts before it and ends inside `text`.
	 * Returns the masked part and the raw rest.
	 */
	private mask(text: string, cut: number): [string, string] {
		const matches: [number, number][] = [];
		for (const s of this.secrets) {
			for (let at = text.indexOf(s); at !== -1; at = text.indexOf(s, at + 1)) matches.push([at, at + s.length]);
		}
		// Leftmost first, then longest; overlaps go to whichever came first.
		matches.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
		let out = "";
		let at = 0;
		for (const [start, end] of matches) {
			if (start < at) continue;
			if (start >= cut) break;
			out += `${text.slice(at, start)}***`;
			at = end;
		}
		const stop = Math.max(at, cut);
		return [out + text.slice(at, stop), text.slice(stop)];
	}

	/** Masks a chunk; returns what's safe to show now. */
	push(chunk: string): string {
		const text = this.pending + chunk;
		const [safe, rest] = this.mask(text, text.length - this.partial(text));
		this.pending = rest;
		return safe;
	}

	/** What's held back (unmasked), to hand to the next masker for this stream. */
	get tail(): string {
		return this.pending;
	}

	/** Whatever is still held back, masked. */
	flush(): string {
		const [out] = this.mask(this.pending, this.pending.length);
		this.pending = "";
		return out;
	}
}
