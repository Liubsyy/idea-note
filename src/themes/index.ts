import { tr } from "../i18n/core.ts";
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
    get group() { return tr("基础"); },
    tokens: [
      { key: "--bg", get label() { return tr("背景"); } },
      { key: "--bg-elev", get label() { return tr("次级背景"); } },
      { key: "--sidebar-bg", get label() { return tr("侧边栏背景"); } },
      { key: "--border", get label() { return tr("边框"); } },
      { key: "--shadow", get label() { return tr("阴影"); } },
      { key: "--toolbar-bg", get label() { return tr("工具栏背景"); } },
    ],
  },
  {
    get group() { return tr("文字"); },
    tokens: [
      { key: "--text", get label() { return tr("正文"); } },
      { key: "--text-soft", get label() { return tr("次要文字"); } },
      { key: "--text-muted", get label() { return tr("弱化文字"); } },
    ],
  },
  {
    get group() { return tr("强调与交互"); },
    tokens: [
      { key: "--accent", get label() { return tr("主题色"); } },
      { key: "--hover", get label() { return tr("悬停"); } },
      { key: "--active", get label() { return tr("选中"); } },
      { key: "--selection", get label() { return tr("文本选区"); } },
      { key: "--search-mark", get label() { return tr("搜索高亮"); } },
    ],
  },
  {
    get group() { return tr("列表与图标"); },
    tokens: [
      { key: "--tree-text", get label() { return tr("列表文字"); } },
      { key: "--tree-icon", get label() { return tr("列表图标"); } },
      { key: "--note-icon", get label() { return tr("笔记图标"); } },
      { key: "--folder-icon", get label() { return tr("文件夹图标"); } },
      { key: "--card-border", get label() { return tr("卡片边框"); } },
      { key: "--file-image", get label() { return tr("图片文件"); } },
      { key: "--file-code", get label() { return tr("代码文件"); } },
      { key: "--file-config", get label() { return tr("配置文件"); } },
    ],
  },
  {
    get group() { return tr("代码"); },
    tokens: [
      { key: "--code-bg", get label() { return tr("代码块背景"); } },
      { key: "--code-text", get label() { return tr("代码块文字"); } },
      { key: "--inline-code-bg", get label() { return tr("行内代码背景"); } },
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
    typeof o.name === "string" && o.name.trim() ? o.name.trim() : tr("自定义主题");
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
