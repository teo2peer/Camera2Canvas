/**
 * App-chrome theming (light/dark).
 *
 * Applies a ``data-theme`` attribute on <html> and exposes CSS custom
 * properties used by the admin overlay, the instructions screen and any
 * other DOM chrome. Babylon scenes are unaffected — they have their own
 * `hubBg*` settings.
 *
 * Persistent setting: ``theme`` ("dark" | "light"). Defaults to dark.
 */
type ThemeName = "dark" | "light";

const STYLE_ID = "app-theme-vars";
const VARS = {
  dark: {
    "--bg-0":     "#08090f",
    "--bg-1":     "#11131c",
    "--bg-2":     "#15162028",
    "--border":   "#1f2233",
    "--text":     "#e8eaff",
    "--text-dim": "#cdd0e8",
    "--accent":   "#7fb0ff",
    "--input-bg": "#1a1d2c",
    "--input-bd": "#2a2e44",
    "--btn-bg":   "#2c3252",
    "--btn-bg-h": "#3a4276",
    "--btn-pri":  "#4a64d3",
    "--btn-dng":  "#9c2b3a",
    "--shadow":   "0 4px 24px rgba(0,0,0,.4)",
    // Flat colour — gradients on a centred flex layout draw a visible "ellipse"
    // shape behind the camera ring + title that some users read as a square.
    "--page-bg":  "#08090f",
  },
  light: {
    "--bg-0":     "#f6f7fb",
    "--bg-1":     "#ffffff",
    "--bg-2":     "#f0f2faaa",
    "--border":   "#dfe2ec",
    "--text":     "#181a24",
    "--text-dim": "#3d4254",
    "--accent":   "#3056d6",
    "--input-bg": "#ffffff",
    "--input-bd": "#cdd2e0",
    "--btn-bg":   "#e6eaf6",
    "--btn-bg-h": "#d6dbeb",
    "--btn-pri":  "#3056d6",
    "--btn-dng":  "#c0344c",
    "--shadow":   "0 4px 18px rgba(40,50,90,.10)",
    "--page-bg":  "#f6f7fb",
  },
};

function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  // Generate :root selectors for both themes from the VARS map.
  const block = (name: ThemeName) => {
    const v = VARS[name];
    return `:root[data-theme="${name}"] { ${
      Object.entries(v).map(([k, val]) => `${k}: ${val};`).join(" ")
    } }`;
  };
  s.textContent = [
    block("dark"),
    block("light"),
    // light-mode tweaks for the instructions screen body painted with --page-bg
    `:root[data-theme="light"] body.theme-aware { background: var(--page-bg); color: var(--text); }`,
    `:root[data-theme="dark"]  body.theme-aware { background: var(--page-bg); color: var(--text); }`,
  ].join("\n");
  document.head.appendChild(s);
}

export function applyTheme(name: ThemeName) {
  ensureStylesheet();
  document.documentElement.dataset.theme = name;
}

export async function applyThemeFromSettings() {
  const s = await (window as any).api?.getSettings?.();
  applyTheme((s?.theme as ThemeName) ?? "dark");
}

export function watchThemeSetting() {
  applyThemeFromSettings();
  addEventListener("settings:changed", applyThemeFromSettings as any);
  addEventListener("settings:live", (e: any) => {
    if (e.detail?.key === "theme") applyTheme(e.detail.value as ThemeName);
  });
}
