// Lays out a commit graph in lanes, one row per commit, newest first: each lane is waiting for the
// commit it will reach next, so a branch keeps its column until it merges into another.

export interface GraphRow {
	hash: string;
	/** The lane the commit's dot sits in. */
	col: number;
	/** What each lane was waiting for coming into this row. */
	before: (string | null)[];
	/** And going out of it, towards older commits. */
	after: (string | null)[];
	/** Lanes that end here, joining the commit's lane (branches that split from this commit). */
	joining: number[];
	/** The lane each parent continues in. */
	parentCols: number[];
	/** No lane was waiting for this commit: it's a branch head (or the newest commit listed). */
	head: boolean;
}

export function layoutGraph(commits: { hash: string; parents: string[] }[]): { rows: GraphRow[]; width: number } {
	const lanes: (string | null)[] = [];
	const rows: GraphRow[] = [];
	let width = 1;
	const free = () => {
		const i = lanes.indexOf(null);
		return i === -1 ? lanes.length : i;
	};
	for (const c of commits) {
		let col = lanes.indexOf(c.hash);
		const head = col === -1;
		if (head) {
			col = free();
			lanes[col] = c.hash;
		}
		const before = lanes.slice();
		const joining: number[] = [];
		before.forEach((h, i) => {
			if (h === c.hash && i !== col) {
				joining.push(i);
				lanes[i] = null;
			}
		});
		lanes[col] = c.parents[0] ?? null;
		const parentCols: number[] = c.parents.length > 0 ? [col] : [];
		for (const parent of c.parents.slice(1)) {
			let j = lanes.indexOf(parent);
			if (j === -1) {
				j = free();
				lanes[j] = parent;
			}
			parentCols.push(j);
		}
		while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
		width = Math.max(width, before.length, lanes.length);
		rows.push({ hash: c.hash, col, before, after: lanes.slice(), joining, parentCols, head });
	}
	return { rows, width };
}
