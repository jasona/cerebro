/**
 * Appearance preference: "system" follows the OS; "light"/"dark" set
 * `data-theme` on <html>, which `@cerebro/ui/tokens.css` honours. Stored per
 * browser in localStorage, so it also applies before sign-in.
 */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "cerebro-theme";

/** Inline <head> script: applies the saved theme before first paint (no flash). */
export const themeInitScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
