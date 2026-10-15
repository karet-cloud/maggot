// Light or dark, for every page. The visitor's choice is kept in localStorage; without one the page
// follows the system. THEME_SCRIPT runs in <head> before the first paint, so the server-rendered page
// never flashes the wrong theme, and it keeps following the system while the page is open.

export type Theme = "light" | "dark";

export const THEME_KEY = "maggot.theme";
// The landing page kept its own choice under this key before the whole site had themes.
const OLD_KEY = "maggot.landing.theme";

/** The saved choice, or null to follow the system. */
export function savedTheme(): Theme | null {
	try {
		const saved = localStorage.getItem(THEME_KEY) ?? localStorage.getItem(OLD_KEY);
		return saved === "light" || saved === "dark" ? saved : null;
	} catch {
		return null;
	}
}

export const systemTheme = (): Theme => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** Puts `light` or `dark` on <html>, which the stylesheet keys on. */
export function applyTheme(theme: Theme) {
	const root = document.documentElement.classList;
	root.toggle("dark", theme === "dark");
	root.toggle("light", theme === "light");
}

export function saveTheme(theme: Theme | null) {
	try {
		if (theme) localStorage.setItem(THEME_KEY, theme);
		else localStorage.removeItem(THEME_KEY);
		localStorage.removeItem(OLD_KEY);
	} catch {
		// Private browsing: the choice lasts until the page closes.
	}
	applyTheme(theme ?? systemTheme());
	window.dispatchEvent(new Event("maggot-theme"));
}

export const THEME_SCRIPT = `(function(){
var k=${JSON.stringify(THEME_KEY)},o=${JSON.stringify(OLD_KEY)},m=matchMedia("(prefers-color-scheme: dark)");
function s(){try{var t=localStorage.getItem(k)||localStorage.getItem(o);return t==="light"||t==="dark"?t:null}catch(e){return null}}
function a(){var d=(s()||(m.matches?"dark":"light"))==="dark",c=document.documentElement.classList;c.toggle("dark",d);c.toggle("light",!d)}
a();m.addEventListener("change",function(){if(!s()){a();dispatchEvent(new Event("maggot-theme"))}});
})()`;
