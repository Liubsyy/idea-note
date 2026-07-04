// Theme system. The per-theme colour palettes live in builtins.json (data,
// no logic) so the "差异化" between themes is a plain editable file. This module
// adds the types, the editor metadata (Chinese labels + grouping), and the
// helpers used by the store to resolve and apply a theme at runtime.
//
// A theme = a base mode (`dark`, which drives the `.dark` class used by diff
// colours / mermaid) plus a full set of CSS-variable colour values. Applying a
// theme writes those variables inline on <html>, overriding the light fallback
// kept in globals.css. Font-size tokens (--editor-font-size, etc.) are NOT
// theme data — they are user settings applied separately.

import builtinsRaw from "./builtins.json";

export type ThemeColors = Record<string, string>;

export interface ThemeDef {
  /** Stable id; also the value stored in settings.themeId. */
  id: string;
  /** Display name shown on the theme tile. */
  name: string;
  /** Base mode. Toggles the `.dark` class and the editor syntax baseline. */
  dark: boolean;
  /** True for user-created themes (editable / deletable). Absent on built-ins. */
  custom?: boolean;
  /** Every key in THEME_TOKENS maps to a CSS colour value. */
  colors: ThemeColors;
}

/**
 * The themeable CSS variables, grouped with Chinese labels for the custom-theme
 * editor. This is the canonical token list: every theme must supply a value for
 * each key (built-ins do; custom themes are normalised to fill any gaps).
 */
export const THEME_TOKEN_GROUPS: {
  group: string;
  tokens: { key: string; label: string }[];
}[] = [
  {
    group: "基础",
    tokens: [
      { key: "--bg", label: "背景" },
      { key: "--bg-elev", label: "次级背景" },
      { key: "--sidebar-bg", label: "侧边栏背景" },
      { key: "--border", label: "边框" },
      { key: "--shadow", label: "阴影" },
      { key: "--toolbar-bg", label: "工具栏背景" },
    ],
  },
  {
    group: "文字",
    tokens: [
      { key: "--text", label: "正文" },
      { key: "--text-soft", label: "次要文字" },
      { key: "--text-muted", label: "弱化文字" },
    ],
  },
  {
    group: "强调与交互",
    tokens: [
      { key: "--accent", label: "主题色" },
      { key: "--hover", label: "悬停" },
      { key: "--active", label: "选中" },
      { key: "--selection", label: "文本选区" },
      { key: "--search-mark", label: "搜索高亮" },
    ],
  },
  {
    group: "列表与图标",
    tokens: [
      { key: "--tree-text", label: "列表文字" },
      { key: "--tree-icon", label: "列表图标" },
      { key: "--note-icon", label: "笔记图标" },
      { key: "--folder-icon", label: "文件夹图标" },
      { key: "--card-border", label: "卡片边框" },
      { key: "--file-image", label: "图片文件" },
      { key: "--file-code", label: "代码文件" },
      { key: "--file-config", label: "配置文件" },
    ],
  },
  {
    group: "代码",
    tokens: [
      { key: "--code-bg", label: "代码块背景" },
      { key: "--code-text", label: "代码块文字" },
      { key: "--inline-code-bg", label: "行内代码背景" },
    ],
  },
];

/** Flat ordered list of every themeable token key. */
export const THEME_TOKENS: string[] = THEME_TOKEN_GROUPS.flatMap((g) =>
  g.tokens.map((t) => t.key),
);

/** Built-in themes, in display order. The first one (light) is the ultimate
 *  fallback when a stored themeId no longer resolves. */
export const BUILTIN_THEMES: ThemeDef[] = (
  builtinsRaw as { themes: ThemeDef[] }
).themes;

const LIGHT_BASE = BUILTIN_THEMES.find((t) => t.id === "light")!;
const DARK_BASE = BUILTIN_THEMES.find((t) => t.id === "dark")!;

const THEME_ID_ALIASES: Record<string, string> = {
  sepia: "light",
  "pro-apricot-paper": "light",
  "solarized-light": "light",
  "solarized-dark": "dark",
  "pro-celadon-study": "light",
  "pro-graphite-light": "light",
  "pro-ink-command": "dark",
  "pro-tungsten-gray": "dark",
  "pro-pine-night": "dark",
  "pro-rosewood-night": "dark",
};

export function canonicalThemeId(id: string): string {
  return THEME_ID_ALIASES[id] ?? id;
}

/** Resolve a stored id against custom themes first, then built-ins, then light. */
export function resolveTheme(id: string, custom: ThemeDef[]): ThemeDef {
  const canonicalId = canonicalThemeId(id);
  return (
    custom.find((t) => t.id === canonicalId) ??
    BUILTIN_THEMES.find((t) => t.id === canonicalId) ??
    LIGHT_BASE
  );
}

/** Write a theme's colours onto <html> and toggle the base-mode class. */
export function applyThemeColors(def: ThemeDef): void {
  const root = document.documentElement;
  for (const key of THEME_TOKENS) {
    const val = def.colors[key];
    if (val) root.style.setProperty(key, val);
  }
  root.classList.toggle("dark", def.dark);
}

/** Coerce arbitrary persisted/imported data into a valid custom ThemeDef, or
 *  null if it has no usable id. Missing colours are filled from the matching
 *  base mode so a partial palette still renders. */
export function normalizeCustomTheme(
  raw: unknown,
  fallbackId?: string,
): ThemeDef | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : fallbackId;
  if (!id) return null;
  const dark = typeof o.dark === "boolean" ? o.dark : false;
  const name =
    typeof o.name === "string" && o.name.trim() ? o.name.trim() : "自定义主题";
  const base = (dark ? DARK_BASE : LIGHT_BASE).colors;
  const colors: ThemeColors = { ...base };
  if (o.colors && typeof o.colors === "object") {
    const src = o.colors as Record<string, unknown>;
    for (const key of THEME_TOKENS) {
      const v = src[key];
      if (typeof v === "string" && v.trim()) colors[key] = v.trim();
    }
  }
  return { id, name, dark, custom: true, colors };
}

/** Build a fresh custom theme cloned from an existing one. */
export function makeCustomTheme(
  source: ThemeDef,
  id: string,
  name: string,
): ThemeDef {
  return { id, name, dark: source.dark, custom: true, colors: { ...source.colors } };
}

/** A short unique id for a new custom theme. */
export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
