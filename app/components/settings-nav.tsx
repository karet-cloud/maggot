import { Link } from "@tanstack/react-router";
import { KeyRound, LockKeyhole } from "lucide-react";

/** Tabs across the account settings pages. */
export function SettingsNav() {
	const tab =
		"-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-dim hover:text-fg data-[status=active]:border-accent data-[status=active]:text-fg";
	return (
		<nav className="flex gap-1 border-b border-line">
			<Link to="/settings/tokens" className={tab}>
				<KeyRound className="size-3.5" />
				Access tokens
			</Link>
			<Link to="/settings/password" className={tab}>
				<LockKeyhole className="size-3.5" />
				Password
			</Link>
		</nav>
	);
}
