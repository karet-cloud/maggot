// Cloudflare Turnstile on sign-up and the waitlist: the page runs an invisible challenge and sends its
// token, which is checked here. Off unless the deploy sets both keys (MAGGOT_TURNSTILE_SITE_KEY at
// deploy time, TURNSTILE_SECRET_KEY as a secret), so local development and tests skip it.
import { HttpError } from "./errors.ts";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileEnv {
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
}

/** The site key pages render the widget with, or null when Turnstile is off. */
export function turnstileSiteKey(env: TurnstileEnv): string | null {
	return env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null;
}

/**
 * Throws 403 unless `token` is a fresh Turnstile token for `action` (tokens work once, for five
 * minutes). Does nothing when Turnstile is off.
 */
export async function verifyTurnstile(env: TurnstileEnv, token: unknown, action: string, ip: string, fetcher: typeof fetch = fetch): Promise<void> {
	const secret = env.TURNSTILE_SECRET_KEY;
	if (!turnstileSiteKey(env) || !secret) return;
	if (typeof token !== "string" || !token || token.length > 2048) throw failed();
	const form = new FormData();
	form.set("secret", secret);
	form.set("response", token);
	if (ip !== "local") form.set("remoteip", ip);
	let outcome: { success?: boolean; action?: string };
	try {
		const res = await fetcher(SITEVERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
		outcome = (await res.json()) as typeof outcome;
	} catch (err) {
		console.error("[maggot] Turnstile siteverify failed", err);
		throw new HttpError(503, "TURNSTILE_UNAVAILABLE", "Couldn't check that you're not a bot; try again in a moment");
	}
	if (!outcome.success || outcome.action !== action) throw failed();
}

const failed = () => new HttpError(403, "TURNSTILE_FAILED", "Couldn't check that you're not a bot; reload the page and try again");
