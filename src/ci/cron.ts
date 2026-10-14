/**
 * Cron schedules for `on: schedule`, as GitHub reads them: five fields (minute, hour, day of month,
 * month, day of week) in UTC, each `*`, a value, a range `a-b`, a step `*\/n` or `a-b/n`, or a list of
 * those; months and weekdays may be named (JAN, MON). When both day fields are restricted a day
 * matching either counts, as in every cron.
 */

export interface Cron {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	/** Whether the day-of-month and day-of-week fields were `*`. */
	anyDay: boolean;
	anyWeekday: boolean;
	/** The shortest time between two runs, in minutes. */
	minGapMinutes: number;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function field(text: string, name: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> {
	const out = new Set<number>();
	const value = (v: string): number => {
		const upper = v.toUpperCase();
		const named = names.indexOf(upper);
		if (named !== -1) return named + nameBase;
		if (!/^\d+$/.test(v)) throw new Error(`"${v}" isn't a valid ${name}`);
		const n = Number(v);
		if (n < min || n > max) throw new Error(`${name} is from ${min} to ${max}, not ${n}`);
		return n;
	};
	for (const part of text.split(",")) {
		if (!part) throw new Error(`the ${name} field has an empty item`);
		const [range, stepText] = part.split("/");
		let step = 1;
		if (stepText !== undefined) {
			if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`"/${stepText}" isn't a valid step in the ${name} field`);
			step = Number(stepText);
		}
		let lo: number;
		let hi: number;
		if (range === "*") [lo, hi] = [min, max];
		else if (range.includes("-")) {
			const [a, b] = range.split("-");
			[lo, hi] = [value(a), value(b)];
			if (lo > hi) throw new Error(`${a}-${b} runs backwards in the ${name} field`);
		} else {
			lo = value(range);
			// `5/15` means from 5 to the end, every 15.
			hi = stepText !== undefined ? max : lo;
		}
		for (let n = lo; n <= hi; n += step) out.add(n);
	}
	return out;
}

/** Parses a cron expression; throws with what's wrong. */
export function parseCron(text: string): Cron {
	const parts = text.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`a schedule has five fields (minute hour day month weekday), not ${parts.length}`);
	const weekdays = field(parts[4], "day of week", 0, 7, WEEKDAYS);
	// 7 is Sunday too.
	if (weekdays.delete(7)) weekdays.add(0);
	const cron: Cron = {
		minutes: field(parts[0], "minute", 0, 59),
		hours: field(parts[1], "hour", 0, 23),
		days: field(parts[2], "day of month", 1, 31),
		months: field(parts[3], "month", 1, 12, MONTHS, 1),
		weekdays,
		// As in classic cron, a field starting with * (even */2) doesn't restrict the day.
		anyDay: parts[2].startsWith("*"),
		anyWeekday: parts[4].startsWith("*"),
		minGapMinutes: 0,
	};
	// The gap between runs, from a sample of them: enough to see the tightest one.
	const start = Date.UTC(2026, 0, 1);
	let at = nextRun(cron, start);
	if (at === null) throw new Error("the schedule never runs (no day it names exists)");
	let gap = Number.POSITIVE_INFINITY;
	for (let i = 0; i < 400; i++) {
		const next = nextRun(cron, at);
		if (next === null) break;
		gap = Math.min(gap, (next - at) / 60_000);
		at = next;
	}
	cron.minGapMinutes = Number.isFinite(gap) ? gap : 365 * 24 * 60;
	return cron;
}

function dayMatches(cron: Cron, d: Date): boolean {
	const day = cron.days.has(d.getUTCDate());
	const weekday = cron.weekdays.has(d.getUTCDay());
	// As in classic cron: if either field starts with *, both must match (a * field matches every day);
	// when both are restricted, either will do.
	if (cron.anyDay || cron.anyWeekday) return day && weekday;
	return day || weekday;
}

/** The first time after `after` (milliseconds) the schedule runs, or null if it never does within five years. */
export function nextRun(cron: Cron, after: number): number | null {
	const d = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
	const limit = after + 5 * 366 * 24 * 60 * 60_000;
	while (d.getTime() <= limit) {
		if (!cron.months.has(d.getUTCMonth() + 1)) {
			d.setUTCMonth(d.getUTCMonth() + 1, 1);
			d.setUTCHours(0, 0, 0, 0);
			continue;
		}
		if (!dayMatches(cron, d)) {
			d.setUTCDate(d.getUTCDate() + 1);
			d.setUTCHours(0, 0, 0, 0);
			continue;
		}
		if (!cron.hours.has(d.getUTCHours())) {
			d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
			continue;
		}
		if (!cron.minutes.has(d.getUTCMinutes())) {
			d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
			continue;
		}
		return d.getTime();
	}
	return null;
}
