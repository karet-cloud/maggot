import { X } from "lucide-react";
import { useSyncExternalStore } from "react";

interface Toast {
	id: number;
	message: string;
}

let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of listeners) l();
};
const dismiss = (id: number) => {
	toasts = toasts.filter((t) => t.id !== id);
	emit();
};

/** Says that something already shown (an optimistic update) didn't happen after all. */
export const toast = {
	error(message: string) {
		const id = nextId++;
		toasts = [...toasts.slice(-3), { id, message }];
		emit();
		setTimeout(() => dismiss(id), 6000);
	},
};

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
const NONE: Toast[] = [];

export function Toaster() {
	const list = useSyncExternalStore(subscribe, () => toasts, () => NONE);
	if (!list.length) return null;
	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2" role="alert">
			{list.map((t) => (
				<div key={t.id} className="pointer-events-auto flex items-start gap-2 rounded-md border border-red-500/40 bg-panel px-3 py-2 text-sm text-red-200 shadow-lg">
					<span className="min-w-0 flex-1 break-words">{t.message}</span>
					<button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-faint hover:text-fg">
						<X className="size-3.5" />
					</button>
				</div>
			))}
		</div>
	);
}
