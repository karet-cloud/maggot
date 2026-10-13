// Outgoing email. Uses Cloudflare's send_email binding (EMAIL) when the deploy configured a sender
// (MEGIT_EMAIL_FROM, an address on a domain set up for Cloudflare Email Sending). Without one, nothing
// is sent: the reset link is logged, and an admin can issue it with the API key instead.

interface MailEnv {
	EMAIL?: SendEmail;
	EMAIL_FROM?: string;
}

export function emailConfigured(env: Env): boolean {
	const mail = env as MailEnv;
	return Boolean(mail.EMAIL && mail.EMAIL_FROM);
}

export async function sendMail(env: Env, message: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
	const mail = env as MailEnv;
	if (!mail.EMAIL || !mail.EMAIL_FROM) return false;
	await mail.EMAIL.send({ from: { name: "megit", email: mail.EMAIL_FROM }, to: message.to, subject: message.subject, text: message.text, html: message.html });
	return true;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function resetPasswordEmail(username: string, url: string) {
	const text = `Hi ${username},

Someone asked to reset the password for your megit account. To choose a new one, open this link within an hour:

${url}

If it wasn't you, ignore this email; your password stays the same.`;
	const html = `<p>Hi ${escape(username)},</p>
<p>Someone asked to reset the password for your megit account. To choose a new one, open this link within an hour:</p>
<p><a href="${escape(url)}">Reset your password</a></p>
<p>If it wasn't you, ignore this email; your password stays the same.</p>`;
	return { subject: "Reset your megit password", text, html };
}

export function verifyEmail(username: string, url: string) {
	const text = `Hi ${username},

Welcome to megit. To verify your email address, open this link within a day:

${url}

If you didn't create this account, ignore this email.`;
	const html = `<p>Hi ${escape(username)},</p>
<p>Welcome to megit. To verify your email address, open this link within a day:</p>
<p><a href="${escape(url)}">Verify your email address</a></p>
<p>If you didn't create this account, ignore this email.</p>`;
	return { subject: "Verify your megit email address", text, html };
}
