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
		script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load")));
		script.onerror = () => {
			loading = null;
			reject(new Error("Couldn't load the bot check; check your connection or blockers and try again"));
		};
		document.head.appendChild(script);
	});
	return loading;
}

/**
 * The widget for `action` when `siteKey` is set: put `ref` on an empty element in the form and await
 * `token()` when submitting. Without a site key, `token()` resolves to undefined.
 */
export function useTurnstile(siteKey: string | null | undefined, action: string) {
	const ref = useRef<HTMLDivElement>(null);
	const widget = useRef<Promise<{ api: TurnstileApi; id: string }> | null>(null);
	const pending = useRef<{ resolve: (token: string) => void; reject: (err: Error) => void } | null>(null);

	useEffect(() => {
		if (!siteKey) return;
		let removed = false;
		const settle = (outcome: { token: string } | { error: Error }) => {
			const waiting = pending.current;
			pending.current = null;
			if (!waiting) return;
			if ("token" in outcome) waiting.resolve(outcome.token);
			else waiting.reject(outcome.error);
		};
		const ready = load().then((api) => {
			if (removed || !ref.current) throw new Error("The form closed");
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
			});
			return { api, id };
		});
		ready.catch(() => {});
		widget.current = ready;
		return () => {
			removed = true;
			widget.current = null;
			void ready.then(({ api, id }) => api.remove(id)).catch(() => {});
		};
	}, [siteKey, action]);

	const token = useCallback(async (): Promise<string | undefined> => {
		if (!siteKey) return undefined;
		if (!widget.current) throw new Error("The bot check isn't ready yet; try again");
		const { api, id } = await widget.current;
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.current = null;
				reject(new Error("The bot check took too long; try again"));
			}, 30_000);
			pending.current = {
				resolve: (t) => (clearTimeout(timer), resolve(t)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			};
			// Tokens work once, so each submit runs the check again.
			api.reset(id);
			api.execute(id);
		});
	}, [siteKey]);

	return { ref, token };
}
