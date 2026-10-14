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

import type { ResolvedAction } from "./plan.ts";
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
const STATE_FILE = `${USER_DIR}/github-state`;
const SUMMARY_FILE = `${USER_DIR}/github-step-summary`;
/** RUNNER_TEMP and RUNNER_TOOL_CACHE: the steps' user's, kept for the whole job. */
const TEMP_DIR = `${USER_DIR}/temp`;
const TOOL_CACHE = `${USER_DIR}/tool-cache`;
/** The $GITHUB_* files and runner folders every step gets. */
const STEP_FILES = {
	GITHUB_ENV: ENV_FILE,
	GITHUB_PATH: PATH_FILE,
	GITHUB_OUTPUT: OUTPUT_FILE,
	GITHUB_STATE: STATE_FILE,
	GITHUB_STEP_SUMMARY: SUMMARY_FILE,
	RUNNER_TEMP: TEMP_DIR,
	RUNNER_TOOL_CACHE: TOOL_CACHE,
};
/** Where actions' files are downloaded to, and where the Node.js that runs JavaScript actions is. */
export const ACTIONS_DIR = `${USER_DIR}/actions`;
const NODE = `${USER_DIR}/node/bin/node`;
/** The files a step's results are read back from after it, in COLLECT_SCRIPT's order. */
export const COLLECTED = ["env", "path", "output", "state"] as const;
/** Where a step's $GITHUB_ENV, $GITHUB_PATH, $GITHUB_OUTPUT and $GITHUB_STATE are copied after it, to be read back as files. */
export const collectedPath = (id: string, which: (typeof COLLECTED)[number]) => `${USER_DIR}/collect-${id}.${which}`;

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
# git checks the commit out; curl fetches actions, caches and artifacts.
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "Installing git and curl…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git curl ca-certificates >/dev/null
  else
    echo "git or curl isn't installed in this image and there's no apt-get to install it" >&2
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
export function stepFile(step: Pick<StepSpec, "run" | "env" | "workingDirectory">, env: Record<string, string>, added: Record<string, string> = {}, path: string[] = []): string {
	const lines = exports({ ...env, ...added, ...step.env, ...STEP_FILES });
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
for g in ${ENV_FILE} ${PATH_FILE} ${OUTPUT_FILE} ${STATE_FILE} ${SUMMARY_FILE}; do
  [ -e "$g" ] || { : > "$g" && own "$owner" "$g"; } || broken "Couldn't create the step's environment files"
done
for d in ${TEMP_DIR} ${TOOL_CACHE}; do
  [ -d "$d" ] || { mkdir -p "$d" && own "$owner" "$d"; } || broken "Couldn't create the runner's folders"
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
kill -"$MEGIT_SIGNAL" "-$pid" 2>/dev/null || kill -"$MEGIT_SIGNAL" "$pid" 2>/dev/null || true
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
  for g in ${COLLECTED.join(" ")}; do
    case "$g" in env) src=${ENV_FILE} ;; path) src=${PATH_FILE} ;; output) src=${OUTPUT_FILE} ;; *) src=${STATE_FILE} ;; esac
    wc -c < "$src" 2>/dev/null >> "$out.sizes.tmp" || echo 0 >> "$out.sizes.tmp"
    head -c ${COLLECT_BYTES} "$src" > "$out.$g.tmp" 2>/dev/null || : > "$out.$g.tmp"
    # Readable by whichever user the provider reads files as; it's what the step itself wrote.
    chmod 644 "$out.$g.tmp"
    mv "$out.$g.tmp" "$out.$g"
  done
  mv "$out.sizes.tmp" "$out.sizes"
  for src in ${ENV_FILE} ${PATH_FILE} ${OUTPUT_FILE} ${STATE_FILE}; do : > "$src" 2>/dev/null || true; done
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

/** The full sizes of the files COLLECT_SCRIPT copies (in COLLECTED's order), one per line. */
export function parseCollectSizes(stdout: string): number[] {
	const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length < COLLECTED.length || lines.slice(0, COLLECTED.length).some((l) => !/^\d+$/.test(l))) {
		throw new ScriptOutputError("Collecting the step's $GITHUB_* files printed something unexpected");
	}
	return lines.slice(0, COLLECTED.length).map(Number);
}

/** Names $GITHUB_ENV may not set, as on GitHub. */
const PROTECTED = new Set(["NODE_OPTIONS", "PATH", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]);

/**
 * Reads $GITHUB_ENV (and $GITHUB_OUTPUT and $GITHUB_STATE, which share its format): `NAME=value` lines
 * and `NAME<<DELIMITER` blocks. Anything malformed is reported rather than guessed at. Environment
 * variables can't set the names in PROTECTED; outputs may have - in their names.
 */
export function parseEnvFile(text: string, label = "$GITHUB_ENV", variables = true): { env: Record<string, string>; errors: string[] } {
	const env = new Map<string, string>();
	const errors: string[] = [];
	const lines = text.split(/\r?\n/);
	const name = variables ? "[A-Za-z_][A-Za-z0-9_]*" : "[A-Za-z_][A-Za-z0-9_-]*";
	const heredocLine = new RegExp(`^(${name})<<(.+)$`);
	const assignLine = new RegExp(`^(${name})=(.*)$`);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const heredoc = heredocLine.exec(line);
		const assign = assignLine.exec(line);
		let key: string;
		let value: string;
		if (heredoc) {
			key = heredoc[1];
			const end = lines.indexOf(heredoc[2], i + 1);
			if (end === -1) {
				errors.push(`${label}: ${key}'s value never ends (no line with just ${heredoc[2]})`);
				break;
			}
			value = lines.slice(i + 1, end).join("\n");
			i = end;
		} else if (assign) [, key, value] = assign;
		else {
			errors.push(`${label}: "${line.slice(0, 80)}" isn't NAME=value or NAME<<DELIMITER`);
			continue;
		}
		if (variables && PROTECTED.has(key)) errors.push(`${label} can't set ${key}`);
		else env.set(key, value);
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

// ── Expressions, actions, caches and artifacts ───────────────────────────────

/**
 * hashFiles(): the files under the workspace that $MEGIT_PATTERNS (one per line; `!` excludes) match,
 * each hashed, then the list hashed: one SHA-256, or an empty line when nothing matches. Run as root
 * with exec; it prints only the hash.
 */
export const HASH_SCRIPT = `set -euo pipefail
cd "$MEGIT_WORKSPACE" 2>/dev/null || { echo; exit 0; }
shopt -s globstar nullglob
declare -A keep=()
# Globs expand into whole lines (names with spaces stay whole).
IFS=$'\\n'
# Read line by line: an unquoted $MEGIT_PATTERNS would be globbed before the loop sees it.
while IFS= read -r p; do
  [ -z "$p" ] && continue
  neg=0
  case "$p" in '!'*) neg=1; p="\${p:1}" ;; esac
  p="\${p#./}"
  case "$p" in "$MEGIT_WORKSPACE"/*) p="\${p#"$MEGIT_WORKSPACE"/}" ;; /*) continue ;; esac
  for f in $p; do
    [ -f "$f" ] || continue
    if [ "$neg" = 1 ]; then unset 'keep[$f]'; else keep[$f]=1; fi
  done
done <<< "$MEGIT_PATTERNS"
if [ \${#keep[@]} -eq 0 ]; then echo; exit 0; fi
# As GitHub does: each file's SHA-256 as bytes, in order, hashed together. Names pass NUL-separated (any name
# works), and files are read from stdin, so sha256sum never escapes an unusual name.
for f in "\${!keep[@]}"; do printf '%s\\0' "$f"; done | LC_ALL=C sort -z | while IFS= read -r -d '' f; do
  h=$(sha256sum < "$f" | cut -c1-64)
  printf "$(printf '%s' "$h" | sed 's/../\\\\x&/g')"
done | sha256sum | cut -c1-64
`;

export function parseHashOutput(stdout: string): string {
	const hash = stdout.trim();
	if (hash && !/^[0-9a-f]{64}$/.test(hash)) throw new ScriptOutputError(`hashFiles printed ${JSON.stringify(hash.slice(0, 80))}`);
	return hash;
}

/** The version of Node.js installed for JavaScript actions when the machine has none (or one older than 20). */
const NODE_VERSION = "24";

/**
 * Setup's second half, run as the steps' user: downloads the actions the steps use (from megit, which
 * keeps a copy of each in R2) and makes sure Node.js 20 or later is at hand for JavaScript actions.
 * Null when there's nothing to do.
 */
export function prepareActionsFile(actions: ResolvedAction[], api: { url: string; token: string }): string | null {
	const downloads = new Map<string, { owner: string; repo: string; sha: string }>();
	for (const a of actions) if (a.archive) downloads.set(a.archive.root, a.archive);
	const node = actions.some((a) => a.meta.runs.using === "node");
	if (downloads.size === 0 && !node) return null;
	const lines = [
		...exports({ MEGIT_API: api.url, MEGIT_TOKEN: api.token }),
		`mkdir -p ${ACTIONS_DIR}`,
		`fetch_action() {
  [ -d "$4" ] && return 0
  echo "Downloading $1/$2@\${3:0:7}"
  rm -rf "$4.tmp" && mkdir -p "$4.tmp"
  curl -fsSL --retry 3 -H "Authorization: Bearer $MEGIT_TOKEN" "$MEGIT_API/api/ci/actions/$1/$2/$3" | tar -xzf - -C "$4.tmp" --strip-components=1
  mv "$4.tmp" "$4"
}`,
		...[...downloads].map(([dir, a]) => `fetch_action ${shellQuote(a.owner)} ${shellQuote(a.repo)} ${shellQuote(a.sha)} ${shellQuote(dir)}`),
	];
	if (node) {
		lines.push(`mkdir -p ${USER_DIR}/node/bin
if [ ! -x ${NODE} ]; then
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    ln -sf "$(command -v node)" ${NODE}
  else
    echo "Installing Node.js ${NODE_VERSION} for the JavaScript actions…"
    base=https://nodejs.org/dist/latest-v${NODE_VERSION}.x
    file=$(curl -fsSL --retry 3 "$base/SHASUMS256.txt" | awk '/linux-x64\\.tar\\.gz$/ { print $2; exit }')
    [ -n "$file" ] || { echo "Couldn't find Node.js ${NODE_VERSION} for linux-x64" >&2; exit 1; }
    curl -fsSL --retry 3 "$base/$file" | tar -xzf - -C ${USER_DIR}/node --strip-components=1
  fi
fi
echo "Node.js $(${NODE} --version) runs the JavaScript actions"`);
	}
	return `${lines.join("\n")}\n`;
}

/** The INPUT_<NAME> variable a JavaScript action reads an input from, as GitHub names it. */
export const inputVariable = (name: string) => `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;

/** A JavaScript action's pre, main or post script, run with Node.js from the workspace, as on GitHub. */
export function actionStepFile(o: {
	env: Record<string, string>;
	path: string[];
	inputs: Record<string, string>;
	/** What its main (and pre) script saved with $GITHUB_STATE; post scripts read it as STATE_<name>. */
	saved: Record<string, string>;
	action: { dir: string; script: string; repository: string; ref: string };
}): string {
	const vars: Record<string, string> = {
		...o.env,
		...STEP_FILES,
		...Object.fromEntries(Object.entries(o.inputs).map(([k, v]) => [inputVariable(k), v])),
		...Object.fromEntries(Object.entries(o.saved).map(([k, v]) => [`STATE_${k}`, v])),
		GITHUB_ACTION_PATH: o.action.dir,
		GITHUB_ACTION_REPOSITORY: o.action.repository,
		GITHUB_ACTION_REF: o.action.ref,
	};
	// Variable names a shell can't export (inputs with dashes) go through env(1) instead.
	const plain = Object.entries(vars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
	const odd = Object.entries(vars).filter(([k]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
	const lines = exports(Object.fromEntries(plain));
	if (o.path.length) lines.push(`export PATH=${shellQuote(o.path.toReversed().join(":"))}:"$PATH"`);
	lines.push(`cd ${WORKSPACE}`);
	const script = `${o.action.dir}/${o.action.script}`;
	const viaEnv = odd.length ? `env ${odd.map(([k, v]) => shellQuote(`${k}=${v}`)).join(" ")} ` : "";
	lines.push(`exec ${viaEnv}${NODE} ${shellQuote(script)}`);
	return `${lines.join("\n")}\n`;
}

/** The R2-backed caches and artifacts: how big a piece of an upload is (R2 multipart parts, under the Workers request limit). */
export const UPLOAD_PART_BYTES = 64 * 1024 * 1024;

/** Shell helpers the cache and artifact steps share: matching paths, and talking to megit's API. */
const STORAGE_HELPERS = `api() { curl -sS --retry 3 -H "Authorization: Bearer $MEGIT_TOKEN" "$@"; }
out() { printf '%s<<MEGIT_EOF\\n%s\\nMEGIT_EOF\\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }
keep() { printf '%s<<MEGIT_EOF\\n%s\\nMEGIT_EOF\\n' "$1" "$2" >> "$GITHUB_STATE"; }
# The files (and empty folders) in folder $1; hidden ones only when $2 is "hidden".
list_dir() {
  if [ "$2" = hidden ]; then find "$1" \\( -type f -o -type l -o -type d -empty \\) -print0
  else find "$1" -mindepth 1 -name '.*' -prune -o \\( -type f -o -type l -o -type d -empty \\) -print0
  fi
}
# Every file (and empty folder) the path lines in $1 match, as absolute paths ending in NUL (so any name
# works); ! lines exclude.
matches() {
  local p f neg
  shopt -s globstar nullglob
  [ "\${2:-}" = hidden ] && shopt -s dotglob
  declare -A seen=()
  local IFS=$'\\n'
  cd "$GITHUB_WORKSPACE"
  # Line by line, so the patterns aren't globbed before they're looked at.
  while IFS= read -r p; do
    p="\${p#"\${p%%[![:space:]]*}"}"; p="\${p%"\${p##*[![:space:]]}"}"
    [ -z "$p" ] && continue
    neg=0; case "$p" in '!'*) neg=1; p="\${p:1}" ;; esac
    case "$p" in '~') p="$HOME" ;; '~/'*) p="$HOME/\${p:2}" ;; esac
    for f in $p; do
      [ -e "$f" ] || continue
      case "$f" in /*) ;; *) f="$GITHUB_WORKSPACE/\${f#./}" ;; esac
      if [ -d "$f" ]; then
        while IFS= read -r -d '' g; do if [ "$neg" = 1 ]; then unset 'seen[$g]'; else seen[$g]=1; fi; done < <(list_dir "$f" "\${2:-}")
      elif [ "$neg" = 1 ]; then unset 'seen[$f]'
      else seen[$f]=1
      fi
    done
  done <<< "$1"
  [ \${#seen[@]} -gt 0 ] && for f in "\${!seen[@]}"; do printf '%s\\0' "$f"; done | LC_ALL=C sort -z
  return 0
}
# Uploads the file $1 in parts to the upload $2 (cache or artifact $3), then finishes it.
upload() {
  local dir n=0 part code
  dir=$(mktemp -d "$RUNNER_TEMP/megit-parts.XXXXXX")
  split -b ${UPLOAD_PART_BYTES} -a 4 -d "$1" "$dir/part-"
  for part in "$dir"/part-*; do
    n=$((n + 1))
    code=$(api -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$part" -H 'content-type: application/octet-stream' "$MEGIT_API/api/ci/$3/$2/parts/$n")
    [ "$code" = 200 ] || { echo "Uploading part $n failed (HTTP $code)" >&2; rm -rf "$dir"; return 1; }
  done
  rm -rf "$dir"
  code=$(api -o "$RUNNER_TEMP/megit-commit" -w '%{http_code}' -X POST "$MEGIT_API/api/ci/$3/$2/commit")
  [ "$code" = 200 ] || { echo "Finishing the upload failed (HTTP $code): $(head -c 300 "$RUNNER_TEMP/megit-commit")" >&2; return 1; }
}
cache_version() { printf '%s\\n%s\\n' "$1" "megit-tar-gz-1" | sha256sum | cut -c1-64; }
`;

const CACHE_RESTORE = `key="$MEGIT_IN_KEY"
version=$(cache_version "$MEGIT_IN_PATH")
keys=$(printf '%s\\n%s' "$key" "\${MEGIT_IN_RESTORE_KEYS:-}")
keep key "$key"
keep version "$version"
out cache-primary-key "$key"
code=$(api -o "$RUNNER_TEMP/megit-cache" -w '%{http_code}' -G "$MEGIT_API/api/ci/caches" --data-urlencode "keys=$keys" --data-urlencode "version=$version" || echo 000)
if [ "$code" = 204 ]; then
  echo "No cache was found for $key"
  out cache-hit false
  [ "\${MEGIT_IN_FAIL_ON_CACHE_MISS:-false}" = true ] && { echo "fail-on-cache-miss is set, so the step fails" >&2; exit 1; }
  exit 0
fi
if [ "$code" != 200 ]; then
  echo "Warning: looking up the cache failed (HTTP $code), so the step goes on without it"
  out cache-hit false
  exit 0
fi
IFS=$'\\t' read -r id matched size < "$RUNNER_TEMP/megit-cache"
out cache-matched-key "$matched"
exact=false; [ "$matched" = "$key" ] && exact=true
out cache-hit "$exact"
keep exact "$exact"
if [ "\${MEGIT_IN_LOOKUP_ONLY:-false}" = true ]; then
  echo "A cache was found for $matched (not downloaded: lookup-only)"
  exit 0
fi
echo "Restoring the cache for $matched ($size bytes)"
if ! api -f -L "$MEGIT_API/api/ci/caches/$id" | tar -xzf - -P; then
  echo "Warning: restoring the cache failed, so the step goes on without it"
  out cache-hit false
  keep exact false
  exit 0
fi
echo "Restored the cache for $matched"
`;

const CACHE_SAVE = `key="\${MEGIT_SAVED_KEY:-$MEGIT_IN_KEY}"
version=$(cache_version "$MEGIT_IN_PATH")
list="$RUNNER_TEMP/megit-cache-files"
matches "$MEGIT_IN_PATH" hidden > "$list"
if [ ! -s "$list" ]; then
  echo "Warning: nothing matched the cache's path, so nothing was saved"
  exit 0
fi
archive="$RUNNER_TEMP/megit-cache.tar.gz"
tar -czf "$archive" -P --null --verbatim-files-from -T "$list"
size=$(wc -c < "$archive" | tr -d ' ')
code=$(api -o "$RUNNER_TEMP/megit-reserve" -w '%{http_code}' -X POST "$MEGIT_API/api/ci/caches" --data-urlencode "key=$key" --data-urlencode "version=$version" --data-urlencode "size=$size" || echo 000)
if [ "$code" = 409 ]; then
  echo "A cache for $key already exists, so it isn't saved again"
  rm -f "$archive"
  exit 0
fi
if [ "$code" != 201 ]; then
  echo "Warning: saving the cache failed (HTTP $code): $(head -c 300 "$RUNNER_TEMP/megit-reserve")"
  rm -f "$archive"
  exit 0
fi
read -r id < "$RUNNER_TEMP/megit-reserve"
if upload "$archive" "$id" caches; then echo "Saved the cache for $key ($size bytes)"; else echo "Warning: saving the cache failed"; fi
rm -f "$archive"
`;

const UPLOAD_ARTIFACT = `name="\${MEGIT_IN_NAME:-artifact}"
list="$RUNNER_TEMP/megit-artifact-files"
hidden=""; [ "\${MEGIT_IN_INCLUDE_HIDDEN_FILES:-false}" = true ] && hidden=hidden
matches "$MEGIT_IN_PATH" $hidden > "$list"
if [ ! -s "$list" ]; then
  case "\${MEGIT_IN_IF_NO_FILES_FOUND:-warn}" in
    error) echo "No files were found for the path given, so there's nothing to upload" >&2; exit 1 ;;
    ignore) echo "No files were found for the path given; nothing was uploaded"; exit 0 ;;
    *) echo "Warning: no files were found for the path given, so there's nothing to upload"; exit 0 ;;
  esac
fi
# Paths inside the artifact are relative to the folder all the files share, as on GitHub.
IFS= read -r -d '' first < "$list" || true
root=$(dirname -- "$first")
while IFS= read -r -d '' f; do while [ "$root" != / ] && case "$f" in "$root"/*) false ;; *) true ;; esac; do root=$(dirname -- "$root"); done; done < "$list"
rel="$RUNNER_TEMP/megit-artifact-rel"
prefix="\${root%/}/"
while IFS= read -r -d '' f; do printf '%s\\0' "\${f#"$prefix"}"; done < "$list" > "$rel"
archive="$RUNNER_TEMP/megit-artifact.tar.gz"
tar -czf "$archive" -C "$root" --null --verbatim-files-from -T "$rel"
size=$(wc -c < "$archive" | tr -d ' ')
count=$(tr -cd '\\0' < "$list" | wc -c | tr -d ' ')
code=$(api -o "$RUNNER_TEMP/megit-reserve" -w '%{http_code}' -X POST "$MEGIT_API/api/ci/artifacts" --data-urlencode "name=$name" --data-urlencode "size=$size" --data-urlencode "retention-days=\${MEGIT_IN_RETENTION_DAYS:-}" --data-urlencode "overwrite=\${MEGIT_IN_OVERWRITE:-false}" || echo 000)
if [ "$code" != 201 ]; then
  echo "Uploading the artifact failed (HTTP $code): $(head -c 300 "$RUNNER_TEMP/megit-reserve")" >&2
  exit 1
fi
read -r id < "$RUNNER_TEMP/megit-reserve"
upload "$archive" "$id" artifacts || exit 1
rm -f "$archive"
echo "Uploaded $name: $count files, $size bytes compressed"
out artifact-id "$id"
out artifact-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
`;

const DOWNLOAD_ARTIFACT = `dest="\${MEGIT_IN_PATH:-$GITHUB_WORKSPACE}"
case "$dest" in '~') dest="$HOME" ;; '~/'*) dest="$HOME/\${dest:2}" ;; /*) ;; *) dest="$GITHUB_WORKSPACE/$dest" ;; esac
code=$(api -o "$RUNNER_TEMP/megit-artifacts" -w '%{http_code}' "$MEGIT_API/api/ci/artifacts" || echo 000)
[ "$code" = 200 ] || { echo "Listing the run's artifacts failed (HTTP $code)" >&2; exit 1; }
found=0
while IFS=$'\\t' read -r id name size; do
  [ -z "$id" ] && continue
  if [ -n "\${MEGIT_IN_NAME:-}" ]; then [ "$name" = "$MEGIT_IN_NAME" ] || continue
  elif [ -n "\${MEGIT_IN_PATTERN:-}" ]; then [[ "$name" == $MEGIT_IN_PATTERN ]] || continue
  fi
  target="$dest"
  if [ -z "\${MEGIT_IN_NAME:-}" ] && [ "\${MEGIT_IN_MERGE_MULTIPLE:-false}" != true ]; then target="$dest/$name"; fi
  mkdir -p "$target"
  echo "Downloading $name ($size bytes) into $target"
  api -f -L "$MEGIT_API/api/ci/artifacts/$id" | tar -xzf - -C "$target" || { echo "Downloading $name failed" >&2; exit 1; }
  found=$((found + 1))
done < "$RUNNER_TEMP/megit-artifacts"
if [ "$found" = 0 ]; then
  if [ -n "\${MEGIT_IN_NAME:-}" ]; then echo "This run has no artifact called $MEGIT_IN_NAME" >&2; exit 1; fi
  echo "No artifacts matched"
fi
out download-path "$dest"
`;

const BUILT_IN_SCRIPTS = {
	"cache-restore": CACHE_RESTORE,
	"cache-save": CACHE_SAVE,
	"upload-artifact": UPLOAD_ARTIFACT,
	"download-artifact": DOWNLOAD_ARTIFACT,
};

/** The variable a built-in action's script reads an input from. */
const builtInVariable = (name: string) => `MEGIT_IN_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;

/** The script of one of megit's own actions (cache, artifacts), with its inputs and megit's API. */
export function builtInStepFile(
	kind: keyof typeof BUILT_IN_SCRIPTS,
	o: { env: Record<string, string>; path: string[]; inputs: Record<string, string>; api: { url: string; token: string }; github: Record<string, string>; saved: Record<string, string> },
): string {
	const vars: Record<string, string> = {
		...o.env,
		...STEP_FILES,
		...Object.fromEntries(Object.entries(o.inputs).map(([k, v]) => [builtInVariable(k), v])),
		MEGIT_API: o.api.url,
		MEGIT_TOKEN: o.api.token,
		GITHUB_WORKSPACE: WORKSPACE,
		...(kind === "cache-save" && o.saved.key ? { MEGIT_SAVED_KEY: o.saved.key } : {}),
	};
	const lines = exports(vars);
	if (o.path.length) lines.push(`export PATH=${shellQuote(o.path.toReversed().join(":"))}:"$PATH"`);
	return `${lines.join("\n")}\nset -uo pipefail\n${STORAGE_HELPERS}${BUILT_IN_SCRIPTS[kind]}`;
}
