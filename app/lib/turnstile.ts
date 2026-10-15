// Cloudflare Turnstile's invisible widget (see src/turnstile.ts): rendered without a challenge until a
// form is submitted, then run for a fresh single-use token.
import { useCallback, useEffect, useRef } from "react";

interface TurnstileApi {
	render(el: HTMLElement, options: Record<string, unknown>): string;
	execute(id: string): void;
	reset(id: string): void;
	remove(id: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	loading ??= new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT;
		script.async = true;
		const fail = (message: string) => {
			// Forgotten, so the next submit tries again.
			loading = null;
			script.remove();
			reject(new Error(message));
		};
		script.onload = () => (window.turnstile ? resolve(window.turnstile) : fail("The bot check didn't load; try again"));
		script.onerror = () => fail("Couldn't load the bot check; check your connection or blockers and try again");
		document.head.appendChild(script);
	});
	return loading;
}

type Widget = { api: TurnstileApi; id: string };
type Waiter = { resolve: (token: string) => void; reject: (err: Error) => void };

/** How long a check may run before it counts as stuck, unless it asks the person to interact. */
const STUCK_MS = 60_000;

/**
 * The widget for `action` when `siteKey` is set: put `ref` on an empty element in the form and await
 * `token()` when submitting. Without a site key, `token()` resolves to undefined.
 */
export function useTurnstile(siteKey: string | null | undefined, action: string) {
	const ref = useRef<HTMLDivElement>(null);
	const widget = useRef<Promise<Widget> | null>(null);
	const pending = useRef<Waiter | null>(null);
	const mounted = useRef(false);
	const stuck = useRef<ReturnType<typeof setTimeout>>(undefined);

	const settle = useCallback((outcome: { token: string } | { error: Error }) => {
		const waiter = pending.current;
		pending.current = null;
		if (!waiter) return;
		if ("token" in outcome) waiter.resolve(outcome.token);
		else waiter.reject(outcome.error);
	}, []);

	// Renders the widget once the script is in. A failed load is forgotten, so the next submit retries.
	const mount = useCallback((): Promise<Widget> | null => {
		if (!siteKey) return null;
		const ready = load().then((api) => {
			if (!mounted.current || !ref.current || widget.current !== ready) throw new Error("The form closed");
			const id = api.render(ref.current, {
				sitekey: siteKey,
				action,
				execution: "execute",
				appearance: "interaction-only",
				callback: (token: string) => settle({ token }),
				"error-callback": () => {
					settle({ error: new Error("The bot check failed; try again") });
					return true;
				},
				"timeout-callback": () => settle({ error: new Error("The bot check timed out; try again") }),
				"before-interactive-callback": () => clearTimeout(stuck.current),
			});
			return { api, id };
		});
		ready.catch(() => {
			if (widget.current === ready) widget.current = null;
		});
		widget.current = ready;
		return ready;
	}, [siteKey, action, settle]);
	useEffect(() => {
		mounted.current = true;
		const ready = mount();
		return () => {
			mounted.current = false;
			clearTimeout(stuck.current);
			settle({ error: new Error("The form closed") });
			if (widget.current === ready) widget.current = null;
			void ready?.then(({ api, id }) => api.remove(id)).catch(() => {});
		};
	}, [mount, settle]);

	const token = useCallback(async (): Promise<string | undefined> => {
		if (!siteKey) return undefined;
		const { api, id } = await (widget.current ?? mount())!;
		return new Promise<string>((resolve, reject) => {
			// A check still running for an earlier submit is dropped for this one.
			settle({ error: new Error("Superseded") });
			const waiter: Waiter = {
				resolve: (t) => (clearTimeout(stuck.current), resolve(t)),
				reject: (e) => (clearTimeout(stuck.current), reject(e)),
			};
			pending.current = waiter;
			clearTimeout(stuck.current);
			stuck.current = setTimeout(() => {
				if (pending.current === waiter) settle({ error: new Error("The bot check took too long; try again") });
			}, STUCK_MS);
			// Tokens work once, so each submit runs the check again.
			api.reset(id);
			api.execute(id);
		});
	}, [siteKey, mount, settle]);

	return { ref, token };
}
