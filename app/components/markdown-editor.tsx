import { useState } from "react";
import { Markdown } from "./markdown.tsx";
import { cx } from "./ui.tsx";

/** A Markdown textarea with a Preview tab, for issues, comments and release notes. */
export function MarkdownEditor({
	value,
	onChange,
	project,
	placeholder,
	rows = 8,
	label,
	autoFocus,
}: {
	value: string;
	onChange: (value: string) => void;
	project: string;
	placeholder?: string;
	rows?: number;
	label: string;
	autoFocus?: boolean;
}) {
	const [preview, setPreview] = useState(false);
	const tab = (on: boolean, text: string) => (
		<button
			type="button"
			onClick={() => setPreview(on)}
			aria-pressed={preview === on}
			className={cx("rounded px-2.5 py-1 text-xs", preview === on ? "bg-raised text-fg" : "text-faint hover:text-dim")}
		>
			{text}
		</button>
	);
	return (
		<div className="overflow-hidden rounded-md border border-line-strong bg-bg focus-within:border-accent">
			<div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
				{tab(false, "Write")}
				{tab(true, "Preview")}
				<span className="ml-auto text-[11px] text-faint">Markdown</span>
			</div>
			{preview ? (
				<div className="min-h-32 px-4 py-3">
					{value.trim() ? <Markdown source={value} project={project} path="" /> : <p className="text-sm text-faint">Nothing to preview.</p>}
				</div>
			) : (
				<textarea
					value={value}
					onChange={(e) => onChange(e.target.value)}
					rows={rows}
					placeholder={placeholder}
					aria-label={label}
					// biome-ignore lint/a11y/noAutofocus: opened on purpose to write in
					autoFocus={autoFocus}
					className="block w-full resize-y bg-transparent px-3 py-2 text-sm text-fg placeholder:text-faint focus:outline-none"
				/>
			)}
		</div>
	);
}
