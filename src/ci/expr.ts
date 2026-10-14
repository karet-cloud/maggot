/**
 * GitHub Actions expressions: what goes inside `${{ … }}` and in `if:`. Literals (null, booleans,
 * numbers, 'strings'), contexts (`github.sha`, `steps.build.outputs.dir`, `matrix['node']`,
 * `needs.*.result`), the operators ! < <= > >= == != && || and parentheses, and GitHub's functions:
 * contains, startsWith, endsWith, format, join, toJSON, fromJSON, hashFiles and the status checks
 * success(), failure(), cancelled() and always().
 *
 * Values follow GitHub's rules: comparisons coerce mismatched types to numbers, strings compare
 * without regard to case, && and || give back an operand rather than a boolean, and a property that
 * isn't there is null rather than an error. Parsing is separate from evaluating, so a workflow's
 * mistakes show when it's read. Evaluating is synchronous: hashFiles, which needs the machine, is
 * answered from hashes worked out beforehand (see hashFileCalls).
 */

export class ExpressionError extends Error {}

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

type Node =
	| { kind: "literal"; value: Value }
	| { kind: "context"; name: string }
	| { kind: "property"; object: Node; name: string }
	| { kind: "index"; object: Node; index: Node }
	/** `.*`: the values of an object (or the items of an array), as an array. */
	| { kind: "star"; object: Node }
	| { kind: "not"; operand: Node }
	| { kind: "binary"; op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||"; left: Node; right: Node }
	| { kind: "call"; name: string; args: Node[] };

export type Expression = Node;

/** Function names, lower-cased, with how many arguments they take. */
const FUNCTIONS: Record<string, { name: string; min: number; max: number }> = {
	contains: { name: "contains", min: 2, max: 2 },
	startswith: { name: "startsWith", min: 2, max: 2 },
	endswith: { name: "endsWith", min: 2, max: 2 },
	format: { name: "format", min: 1, max: 32 },
	join: { name: "join", min: 1, max: 2 },
	tojson: { name: "toJSON", min: 1, max: 1 },
	fromjson: { name: "fromJSON", min: 1, max: 1 },
	hashfiles: { name: "hashFiles", min: 1, max: 32 },
	success: { name: "success", min: 0, max: 0 },
	failure: { name: "failure", min: 0, max: 0 },
	cancelled: { name: "cancelled", min: 0, max: 0 },
	always: { name: "always", min: 0, max: 0 },
};

export const STATUS_FUNCTIONS = ["success", "failure", "cancelled", "always"];

type Token =
	| { t: "num"; v: number }
	| { t: "str"; v: string }
	| { t: "id"; v: string }
	| { t: "op"; v: string }
	| { t: "end" };

/** The longest expression megit reads; GitHub's own limit is about the same. */
const MAX_LENGTH = 21_000;
/** How deeply expressions may nest, so a hostile one can't overflow the stack. */
const MAX_DEPTH = 50;

function tokenize(text: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "'") {
			let s = "";
			i++;
			for (;;) {
				if (i >= text.length) throw new ExpressionError("a string isn't closed with '");
				if (text[i] === "'") {
					if (text[i + 1] === "'") {
						s += "'";
						i += 2;
						continue;
					}
					i++;
					break;
				}
				s += text[i++];
			}
			out.push({ t: "str", v: s });
			continue;
		}
		const two = text.slice(i, i + 2);
		if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
			out.push({ t: "op", v: two });
			i += 2;
			continue;
		}
		if ("!<>()[],.*".includes(c)) {
			out.push({ t: "op", v: c });
			i++;
			continue;
		}
		const num = /^(?:0x[0-9a-fA-F]+|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(text.slice(i));
		// A number can't follow a value directly (`a.5`), so `-` only starts one where a value could begin.
		const prev = out.at(-1);
		const valueCanStart = !prev || (prev.t === "op" && prev.v !== ")" && prev.v !== "]");
		if (num && (/\d/.test(c) || (valueCanStart && (c === "-" || c === "+" || c === ".")))) {
			const v = num[0].toLowerCase().startsWith("0x") ? Number.parseInt(num[0], 16) : Number(num[0]);
			out.push({ t: "num", v });
			i += num[0].length;
			continue;
		}
		const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i));
		if (id) {
			out.push({ t: "id", v: id[0] });
			i += id[0].length;
			continue;
		}
		throw new ExpressionError(`unexpected "${c}"`);
	}
	out.push({ t: "end" });
	return out;
}

class Parser {
	private pos = 0;
	private depth = 0;
	private readonly tokens: Token[];
	constructor(tokens: Token[]) {
		this.tokens = tokens;
	}

	private peek(): Token {
		return this.tokens[this.pos];
	}

	private next(): Token {
		return this.tokens[this.pos++];
	}

	private isOp(v: string): boolean {
		const t = this.peek();
		return t.t === "op" && t.v === v;
	}

	private expectOp(v: string) {
		if (!this.isOp(v)) throw new ExpressionError(`expected "${v}"`);
		this.pos++;
	}

	parse(): Node {
		const node = this.or();
		if (this.peek().t !== "end") throw new ExpressionError(`unexpected ${describe(this.peek())}`);
		return node;
	}

	private nest<T>(fn: () => T): T {
		if (++this.depth > MAX_DEPTH) throw new ExpressionError("the expression nests too deeply");
		try {
			return fn();
		} finally {
			this.depth--;
		}
	}

	private or(): Node {
		let left = this.and();
		while (this.isOp("||")) {
			this.pos++;
			left = { kind: "binary", op: "||", left, right: this.and() };
		}
		return left;
	}

	private and(): Node {
		let left = this.equality();
		while (this.isOp("&&")) {
			this.pos++;
			left = { kind: "binary", op: "&&", left, right: this.equality() };
		}
		return left;
	}

	private equality(): Node {
		let left = this.comparison();
		while (this.isOp("==") || this.isOp("!=")) {
			const op = (this.next() as { v: "==" | "!=" }).v;
			left = { kind: "binary", op, left, right: this.comparison() };
		}
		return left;
	}

	private comparison(): Node {
		let left = this.unary();
		while (this.isOp("<") || this.isOp("<=") || this.isOp(">") || this.isOp(">=")) {
			const op = (this.next() as { v: "<" | "<=" | ">" | ">=" }).v;
			left = { kind: "binary", op, left, right: this.unary() };
		}
		return left;
	}

	private unary(): Node {
		if (this.isOp("!")) {
			this.pos++;
			return this.nest(() => ({ kind: "not", operand: this.unary() }));
		}
		return this.postfix();
	}

	private postfix(): Node {
		let node = this.primary();
		for (;;) {
			if (this.isOp(".")) {
				this.pos++;
				if (this.isOp("*")) {
					this.pos++;
					node = { kind: "star", object: node };
					continue;
				}
				const t = this.next();
				if (t.t !== "id") throw new ExpressionError(`expected a property name after "."`);
				node = { kind: "property", object: node, name: t.v };
			} else if (this.isOp("[")) {
				this.pos++;
				if (this.isOp("*")) {
					this.pos++;
					this.expectOp("]");
					node = { kind: "star", object: node };
					continue;
				}
				const index = this.nest(() => this.or());
				this.expectOp("]");
				node = { kind: "index", object: node, index };
			} else return node;
		}
	}

	private primary(): Node {
		const t = this.next();
		if (t.t === "num") return { kind: "literal", value: t.v };
		if (t.t === "str") return { kind: "literal", value: t.v };
		if (t.t === "op" && t.v === "(") {
			const inner = this.nest(() => this.or());
			this.expectOp(")");
			return inner;
		}
		if (t.t === "id") {
			const lower = t.v.toLowerCase();
			if (this.isOp("(")) {
				this.pos++;
				const fn = FUNCTIONS[lower];
				if (!fn) throw new ExpressionError(`${t.v}() isn't a function (try contains, startsWith, endsWith, format, join, toJSON, fromJSON, hashFiles, success, failure, cancelled or always)`);
				const args: Node[] = [];
				if (!this.isOp(")")) {
					for (;;) {
						args.push(this.nest(() => this.or()));
						if (this.isOp(",")) {
							this.pos++;
							continue;
						}
						break;
					}
				}
				this.expectOp(")");
				if (args.length < fn.min || args.length > fn.max) {
					throw new ExpressionError(`${fn.name}() takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} argument${fn.max === 1 ? "" : "s"}`);
				}
				return { kind: "call", name: fn.name, args };
			}
			if (lower === "true") return { kind: "literal", value: true };
			if (lower === "false") return { kind: "literal", value: false };
			if (lower === "null") return { kind: "literal", value: null };
			if (lower === "nan") return { kind: "literal", value: Number.NaN };
			if (lower === "infinity") return { kind: "literal", value: Number.POSITIVE_INFINITY };
			return { kind: "context", name: lower };
		}
		throw new ExpressionError(`unexpected ${describe(t)}`);
	}
}

function describe(t: Token): string {
	if (t.t === "end") return "end of expression";
	if (t.t === "str") return `'${t.v}'`;
	return `"${t.v}"`;
}

/** Parses one expression (what's inside `${{ }}`). */
export function parseExpression(text: string): Expression {
	if (text.length > MAX_LENGTH) throw new ExpressionError(`the expression is longer than ${MAX_LENGTH} characters`);
	return new Parser(tokenize(text)).parse();
}

/** The context names (github, steps, …) and functions an expression uses. */
export function usage(node: Expression): { contexts: Set<string>; functions: Set<string> } {
	const contexts = new Set<string>();
	const functions = new Set<string>();
	const walk = (n: Node) => {
		switch (n.kind) {
			case "context":
				contexts.add(n.name);
				break;
			case "property":
			case "star":
				walk(n.object);
				break;
			case "index":
				walk(n.object);
				walk(n.index);
				break;
			case "not":
				walk(n.operand);
				break;
			case "binary":
				walk(n.left);
				walk(n.right);
				break;
			case "call":
				functions.add(n.name);
				n.args.forEach(walk);
				break;
		}
	};
	walk(node);
	return { contexts, functions };
}

/** The `name` in each `<context>.name` (or `<context>['name']`) an expression reads, like the secrets it uses. */
export function propertiesOf(node: Expression, context: string): string[] {
	const out: string[] = [];
	const walk = (n: Node) => {
		if ((n.kind === "property" || n.kind === "index") && n.object.kind === "context" && n.object.name === context) {
			if (n.kind === "property") out.push(n.name);
			else if (n.index.kind === "literal" && typeof n.index.value === "string") out.push(n.index.value);
		}
		if (n.kind === "property" || n.kind === "star") walk(n.object);
		else if (n.kind === "index") (walk(n.object), walk(n.index));
		else if (n.kind === "not") walk(n.operand);
		else if (n.kind === "binary") (walk(n.left), walk(n.right));
		else if (n.kind === "call") n.args.forEach(walk);
	};
	walk(node);
	return out;
}

/** What an expression is evaluated against. */
export interface Scope {
	/** Context values by lower-cased name: github, env, secrets, matrix, steps, needs, job, runner, inputs, strategy. */
	contexts: Record<string, Value>;
	/** Status checks; leave out where they mean nothing (they're then an error). */
	status?: { success: boolean; failure: boolean; cancelled: boolean };
	/** hashFiles' answers, worked out beforehand (see hashFileCalls), keyed by hashKey(patterns). */
	hashes?: Map<string, string>;
}

/** The key a hashFiles call's patterns are looked up by. */
export const hashKey = (patterns: string[]) => JSON.stringify(patterns);

const isObject = (v: Value): v is { [key: string]: Value } => typeof v === "object" && v !== null && !Array.isArray(v);

/** Property lookup the way GitHub does it: case-insensitive, own properties only, null when missing. */
function lookup(object: Value, key: Value): Value {
	if (Array.isArray(object)) {
		const n = toNumber(key);
		return Number.isInteger(n) && n >= 0 && n < object.length ? object[n] : null;
	}
	if (!isObject(object)) return null;
	const name = toText(key);
	if (Object.hasOwn(object, name)) return object[name];
	const lower = name.toLowerCase();
	for (const k of Object.keys(object)) if (k.toLowerCase() === lower) return object[k];
	return null;
}

export function truthy(v: Value): boolean {
	if (v === null || v === false || v === "") return false;
	if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
	return true;
}

function toNumber(v: Value): number {
	if (v === null) return 0;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const s = v.trim();
		if (s === "") return 0;
		if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s, 16);
		return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : Number.NaN;
	}
	return Number.NaN;
}

/** A value as text, the way `${{ }}` writes it into a string. */
export function toText(v: Value): string {
	if (v === null) return "";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") return Number.isInteger(v) || !Number.isFinite(v) ? String(v) : String(Number(v.toFixed(15)));
	if (typeof v === "string") return v;
	return JSON.stringify(v, null, 2);
}

function equal(a: Value, b: Value): boolean {
	if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
	if ((a === null || typeof a !== "object") && (b === null || typeof b !== "object")) {
		if (typeof a === typeof b) return a === b;
		const x = toNumber(a);
		const y = toNumber(b);
		return x === y;
	}
	// Arrays and objects are equal only to themselves.
	return a === b;
}

function compare(op: "<" | "<=" | ">" | ">=", a: Value, b: Value): boolean {
	let x: number | string;
	let y: number | string;
	if (typeof a === "string" && typeof b === "string") {
		x = a.toLowerCase();
		y = b.toLowerCase();
	} else {
		x = toNumber(a);
		y = toNumber(b);
		if (Number.isNaN(x) || Number.isNaN(y)) return false;
	}
	if (op === "<") return x < y;
	if (op === "<=") return x <= y;
	if (op === ">") return x > y;
	return x >= y;
}

const MAX_FROM_JSON = 1024 * 1024;

/** Whether a node's value is the list a `.*` filter made (so lookups on it apply to each item). */
function filtered(node: Node): boolean {
	if (node.kind === "star") return true;
	return (node.kind === "property" || node.kind === "index") && filtered(node.object);
}

export function evaluate(node: Expression, scope: Scope, depth = 0): Value {
	if (depth > MAX_DEPTH * 2) throw new ExpressionError("the expression nests too deeply");
	const ev = (n: Node) => evaluate(n, scope, depth + 1);
	switch (node.kind) {
		case "literal":
			return node.value;
		case "context": {
			if (!Object.hasOwn(scope.contexts, node.name)) throw new ExpressionError(`${node.name} isn't available here (${Object.keys(scope.contexts).sort().join(", ")} are)`);
			return scope.contexts[node.name];
		}
		// After a `.*` filter, property lookups apply to each item: needs.*.result is every result.
		case "property": {
			const object = ev(node.object);
			return filtered(node.object) && Array.isArray(object) ? object.map((v) => lookup(v, node.name)) : lookup(object, node.name);
		}
		case "index": {
			const object = ev(node.object);
			const index = ev(node.index);
			return filtered(node.object) && Array.isArray(object) ? object.map((v) => lookup(v, index)) : lookup(object, index);
		}
		case "star": {
			const v = ev(node.object);
			const items = (x: Value): Value[] => (Array.isArray(x) ? x : isObject(x) ? Object.values(x) : []);
			return filtered(node.object) && Array.isArray(v) ? v.flatMap(items) : items(v);
		}
		case "not":
			return !truthy(ev(node.operand));
		case "binary": {
			if (node.op === "&&") {
				const left = ev(node.left);
				return truthy(left) ? ev(node.right) : left;
			}
			if (node.op === "||") {
				const left = ev(node.left);
				return truthy(left) ? left : ev(node.right);
			}
			const [a, b] = [ev(node.left), ev(node.right)];
			if (node.op === "==") return equal(a, b);
			if (node.op === "!=") return !equal(a, b);
			return compare(node.op, a, b);
		}
		case "call":
			return call(node.name, node.args, scope, ev);
	}
}

function call(name: string, args: Node[], scope: Scope, ev: (n: Node) => Value): Value {
	if (STATUS_FUNCTIONS.includes(name)) {
		if (!scope.status) throw new ExpressionError(`${name}() can only be used in if:`);
		if (name === "always") return true;
		if (name === "cancelled") return scope.status.cancelled;
		if (name === "failure") return scope.status.failure;
		return scope.status.success;
	}
	if (name === "hashFiles") {
		if (!scope.hashes) throw new ExpressionError("hashFiles() can only be used in steps, where there's a checkout to hash");
		const hash = scope.hashes.get(hashKey(args.map(ev).map(toText)));
		if (hash === undefined) throw new ExpressionError("hashFiles() wasn't worked out before the expression was evaluated");
		return hash;
	}
	const values = args.map(ev);
	switch (name) {
		case "contains": {
			const [haystack, needle] = values;
			if (Array.isArray(haystack)) return haystack.some((item) => equal(item, needle));
			return toText(haystack).toLowerCase().includes(toText(needle).toLowerCase());
		}
		case "startsWith":
			return toText(values[0]).toLowerCase().startsWith(toText(values[1]).toLowerCase());
		case "endsWith":
			return toText(values[0]).toLowerCase().endsWith(toText(values[1]).toLowerCase());
		case "format": {
			const [template, ...rest] = values;
			return toText(template).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, i: string | undefined) => {
				if (m === "{{") return "{";
				if (m === "}}") return "}";
				const n = Number(i);
				if (n >= rest.length) throw new ExpressionError(`format(): {${n}} has no argument`);
				return toText(rest[n]);
			});
		}
		case "join": {
			const [items, sep] = values;
			const separator = values.length > 1 ? toText(sep) : ",";
			return Array.isArray(items) ? items.map(toText).join(separator) : toText(items);
		}
		case "toJSON":
			return JSON.stringify(values[0], null, 2);
		case "fromJSON": {
			const text = toText(values[0]);
			if (text.length > MAX_FROM_JSON) throw new ExpressionError("fromJSON(): the value is too large");
			try {
				return JSON.parse(text) as Value;
			} catch {
				throw new ExpressionError(`fromJSON(): "${text.slice(0, 60)}" isn't JSON`);
			}
		}
	}
	throw new ExpressionError(`${name}() isn't a function`);
}

/** A string with `${{ … }}` in it, split into its literal text and the expressions between. */
export type Template = (string | Expression)[];

/**
 * Splits `text` at each `${{ … }}`. The scanner knows about quoted strings, so `}}` inside one doesn't
 * end the expression.
 */
export function parseTemplate(text: string): Template {
	const out: Template = [];
	let i = 0;
	let literal = "";
	while (i < text.length) {
		const start = text.indexOf("${{", i);
		if (start === -1) break;
		literal += text.slice(i, start);
		let j = start + 3;
		let quoted = false;
		for (; j < text.length; j++) {
			if (text[j] === "'") quoted = !quoted;
			else if (!quoted && text[j] === "}" && text[j + 1] === "}") break;
		}
		if (j >= text.length) throw new ExpressionError("${{ isn't closed with }}");
		if (literal) out.push(literal);
		literal = "";
		const inner = text.slice(start + 3, j).trim();
		if (!inner) throw new ExpressionError("${{ }} is empty");
		out.push(parseExpression(inner));
		i = j + 2;
	}
	literal += text.slice(i);
	if (literal) out.push(literal);
	return out;
}

/** Whether a template has any expressions in it. */
export const hasExpressions = (t: Template) => t.some((part) => typeof part !== "string");

/** Fills a template in. */
export function render(template: Template, scope: Scope): string {
	let out = "";
	for (const part of template) out += typeof part === "string" ? part : toText(evaluate(part, scope));
	return out;
}

/** A template's value: a lone expression keeps its type (so `${{ matrix.n }}` is a number), anything else is text. */
export function renderValue(template: Template, scope: Scope): Value {
	if (template.length === 1 && typeof template[0] !== "string") return evaluate(template[0], scope);
	return render(template, scope);
}

/**
 * The patterns of each hashFiles call in `nodes`, evaluated in `scope`, for the machine to hash before
 * the expressions themselves are evaluated (with the answers in scope.hashes).
 */
export function hashFileCalls(nodes: Expression[], scope: Scope): string[][] {
	const out = new Map<string, string[]>();
	const walk = (n: Node) => {
		if (n.kind === "call" && n.name === "hashFiles") {
			const patterns = n.args.map((a) => toText(evaluate(a, scope)));
			out.set(hashKey(patterns), patterns);
			return;
		}
		if (n.kind === "property" || n.kind === "star") walk(n.object);
		else if (n.kind === "index") (walk(n.object), walk(n.index));
		else if (n.kind === "not") walk(n.operand);
		else if (n.kind === "binary") (walk(n.left), walk(n.right));
		else if (n.kind === "call") n.args.forEach(walk);
	};
	nodes.forEach(walk);
	return [...out.values()];
}

/** The expressions in a template. */
export const expressionsIn = (t: Template): Expression[] => t.filter((p): p is Expression => typeof p !== "string");

/**
 * Parses an `if:`. It may be written with or without `${{ }}`; without a status check in it, it means
 * `success() && (…)`, as on GitHub.
 */
export function parseCondition(text: string): Expression {
	const trimmed = text.trim();
	let node: Expression;
	if (trimmed.includes("${{")) {
		// One ${{ }} around it all is that expression (found with the quote-aware scanner, so '}}' in a
		// string is fine); text around ${{ }} makes a non-empty string, which is always true, as on GitHub.
		const template = parseTemplate(trimmed);
		node = template.length === 1 && typeof template[0] !== "string" ? template[0] : { kind: "literal", value: true };
	} else node = parseExpression(trimmed);
	const { functions } = usage(node);
	if (STATUS_FUNCTIONS.some((f) => functions.has(f))) return node;
	return { kind: "binary", op: "&&", left: { kind: "call", name: "success", args: [] }, right: node };
}
