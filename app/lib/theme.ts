// Light or dark, for every page. The visitor's choice is kept in localStorage; without one the page
// follows the system. THEME_SCRIPT runs in <head> before the first paint, so the server-rendered page
// never flashes the wrong theme. It keeps following the system, and other tabs' choices, while the
// page is open. Where storage is blocked, the choice lives on <html> (data-theme) for the visit.

export type Theme = "light" | "dark";

export const THEME_KEY = "maggot.theme";
// The landing page kept its own choice under this key before the whole site had themes.
const OLD_KEY = "maggot.landing.theme";

/** Puts `dark` on <html> or takes it off; the stylesheet keys on it. */
function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
}

/** The theme showing now. */
export const currentTheme = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/** Picks a theme for this visitor, on every page and in every tab. */
export function saveTheme(theme: Theme) {
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(THEME_KEY, theme);
		localStorage.removeItem(OLD_KEY);
	} catch {
		// Private browsing: data-theme keeps the choice until the page closes.
	}
	applyTheme(theme);
}

export const THEME_SCRIPT = `(function(){
var k=${JSON.stringify(THEME_KEY)},o=${JSON.stringify(OLD_KEY)},r=document.documentElement,m=matchMedia("(prefers-color-scheme: dark)");
function s(){var t=r.dataset.theme;if(!t)try{t=localStorage.getItem(k)||localStorage.getItem(o)}catch(e){}return t==="light"||t==="dark"?t:null}
function a(){r.classList.toggle("dark",(s()||(m.matches?"dark":"light"))==="dark")}
a();m.addEventListener("change",a);
addEventListener("storage",function(e){if(e.key===k){delete r.dataset.theme;a()}});
})()`;
