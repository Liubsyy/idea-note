// Customisable editor keymap. A curated registry of high-value editing commands
// is exposed in Settings (快捷键 tab); each one keeps its CodeMirror default but
// can be rebound. The override map (command id -> key string) is persisted in
// app settings; everything not in the registry keeps the stock defaultKeymap.
//
// Defaults are cross-platform: "Mod" resolves to ⌘ on macOS and Ctrl on
// Windows/Linux, and a few commands carry explicit per-platform keys (mac / win
// / linux) to mirror exactly what CodeMirror binds on each OS.
import {
  keymap,
  type Command,
  type EditorView,
  type KeyBinding,
} from "@codemirror/view";
import {
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  selectAll,
  selectLine,
  selectParentSyntax,
  moveLineUp,
  moveLineDown,
  copyLineUp,
  copyLineDown,
  deleteLine,
  indentMore,
  indentLess,
  toggleComment,
  cursorMatchingBracket,
} from "@codemirror/commands";
import { MARKDOWN_ACTIONS } from "./markdownActions";

type Platform = "mac" | "win" | "linux";

const PLATFORM: Platform =
  typeof navigator === "undefined"
    ? "linux"
    : /Mac|iP(hone|ad)/.test(navigator.platform)
      ? "mac"
      : /Win/.test(navigator.platform)
        ? "win"
        : "linux";

const IS_MAC = PLATFORM === "mac";

export interface EditorCommandDef {
  /** Stable id, used as the key in the persisted override map. */
  id: string;
  /** Chinese label shown in Settings. */
  label: string;
  /** One-line description. */
  desc: string;
  /** Default key in CodeMirror notation; "Mod" = ⌘ on mac, Ctrl elsewhere. */
  defaultKey: string;
  /** Per-platform default overrides (used for both binding and display). */
  mac?: string;
  win?: string;
  linux?: string;
  /** The command to run. */
  run: Command;
  /** Settings section and whether the binding only applies to Markdown. */
  group: "general" | "markdown";
}

/**
 * The curated "快捷键大全". General defaults mirror CodeMirror except that
 * select-parent moves to Mod-Shift-I so Markdown can use the conventional
 * Mod-I for italic. Markdown defaults are shared with the toolbar tooltips.
 */
export const EDITOR_COMMANDS: EditorCommandDef[] = [
  { id: "undo", label: "撤销", desc: "撤销上一次编辑", defaultKey: "Mod-z", run: undo, group: "general" },
  // Redo: ⌘⇧Z on mac, Ctrl+Y on Windows, Ctrl+Shift+Z on Linux.
  { id: "redo", label: "重做", desc: "重做被撤销的编辑", defaultKey: "Mod-y", mac: "Mod-Shift-z", linux: "Ctrl-Shift-z", run: redo, group: "general" },
  { id: "selectAll", label: "全选", desc: "选中整个文档", defaultKey: "Mod-a", run: selectAll, group: "general" },
  // Select line: ⌃L on mac, Alt+L on Windows/Linux.
  { id: "selectLine", label: "选中整行", desc: "选中光标所在行", defaultKey: "Alt-l", mac: "Ctrl-l", run: selectLine, group: "general" },
  { id: "selectParentSyntax", label: "选中父级语法", desc: "向外扩展选区到父级语法节点", defaultKey: "Mod-Shift-i", run: selectParentSyntax, group: "general" },
  { id: "copyLineUp", label: "向上复制行", desc: "复制当前行并插入到上方", defaultKey: "Shift-Alt-ArrowUp", run: copyLineUp, group: "general" },
  { id: "copyLineDown", label: "向下复制行", desc: "复制当前行并插入到下方", defaultKey: "Shift-Alt-ArrowDown", run: copyLineDown, group: "general" },
  { id: "moveLineUp", label: "上移当前行", desc: "把当前行与上一行互换", defaultKey: "Alt-ArrowUp", run: moveLineUp, group: "general" },
  { id: "moveLineDown", label: "下移当前行", desc: "把当前行与下一行互换", defaultKey: "Alt-ArrowDown", run: moveLineDown, group: "general" },
  { id: "deleteLine", label: "删除整行", desc: "删除光标所在行", defaultKey: "Shift-Mod-k", run: deleteLine, group: "general" },
  { id: "indentMore", label: "增加缩进", desc: "向右缩进所选行", defaultKey: "Mod-]", run: indentMore, group: "general" },
  { id: "indentLess", label: "减少缩进", desc: "向左缩进所选行", defaultKey: "Mod-[", run: indentLess, group: "general" },
  { id: "toggleComment", label: "注释/取消注释", desc: "切换当前行或选区的注释", defaultKey: "Mod-/", run: toggleComment, group: "general" },
  { id: "cursorMatchingBracket", label: "跳到匹配括号", desc: "把光标移到配对的括号处", defaultKey: "Shift-Mod-\\", run: cursorMatchingBracket, group: "general" },

  { id: "markdownParagraph", label: "正文", desc: "把所选行设为正文", defaultKey: "Mod-0", run: MARKDOWN_ACTIONS.markdownParagraph, group: "markdown" },
  ...[1, 2, 3, 4, 5, 6].map((level): EditorCommandDef => ({
    id: `markdownHeading${level}`,
    label: `标题 ${level}`,
    desc: `把所选行设为 ${level} 级标题`,
    defaultKey: `Mod-${level}`,
    run: MARKDOWN_ACTIONS[`markdownHeading${level}`],
    group: "markdown",
  })),
  { id: "markdownBold", label: "加粗", desc: "加粗或取消加粗所选内容", defaultKey: "Mod-b", run: MARKDOWN_ACTIONS.markdownBold, group: "markdown" },
  { id: "markdownItalic", label: "斜体", desc: "设为斜体或取消斜体", defaultKey: "Mod-i", run: MARKDOWN_ACTIONS.markdownItalic, group: "markdown" },
  { id: "markdownStrike", label: "删除线", desc: "添加或取消删除线", defaultKey: "Mod-Shift-x", run: MARKDOWN_ACTIONS.markdownStrike, group: "markdown" },
  { id: "markdownInlineCode", label: "行内代码", desc: "添加或取消行内代码", defaultKey: "Mod-e", run: MARKDOWN_ACTIONS.markdownInlineCode, group: "markdown" },
  { id: "markdownTextColor", label: "应用文字颜色", desc: "应用最近使用的文字颜色", defaultKey: "Mod-Shift-c", run: MARKDOWN_ACTIONS.markdownTextColor, group: "markdown" },
  { id: "markdownBgColor", label: "应用背景色", desc: "应用最近使用的背景颜色", defaultKey: "Mod-Shift-h", run: MARKDOWN_ACTIONS.markdownBgColor, group: "markdown" },
  { id: "markdownClearColor", label: "清除颜色", desc: "清除文字颜色和背景色", defaultKey: "Mod-Alt-0", run: MARKDOWN_ACTIONS.markdownClearColor, group: "markdown" },
  { id: "markdownBulletList", label: "无序列表", desc: "切换所选行为无序列表", defaultKey: "Mod-Shift-8", run: MARKDOWN_ACTIONS.markdownBulletList, group: "markdown" },
  { id: "markdownOrderedList", label: "有序列表", desc: "切换所选行为有序列表", defaultKey: "Mod-Shift-7", run: MARKDOWN_ACTIONS.markdownOrderedList, group: "markdown" },
  { id: "markdownTaskList", label: "任务列表", desc: "插入任务列表项", defaultKey: "Mod-Shift-9", run: MARKDOWN_ACTIONS.markdownTaskList, group: "markdown" },
  { id: "markdownQuote", label: "引用", desc: "切换所选行为引用", defaultKey: "Mod-Shift-q", run: MARKDOWN_ACTIONS.markdownQuote, group: "markdown" },
  { id: "markdownCodeBlock", label: "代码块", desc: "插入代码块", defaultKey: "Mod-Alt-c", run: MARKDOWN_ACTIONS.markdownCodeBlock, group: "markdown" },
  { id: "markdownHr", label: "分割线", desc: "插入水平分割线", defaultKey: "Mod-Alt-h", run: MARKDOWN_ACTIONS.markdownHr, group: "markdown" },
  { id: "markdownLink", label: "链接", desc: "插入 Markdown 链接", defaultKey: "Mod-k", run: MARKDOWN_ACTIONS.markdownLink, group: "markdown" },
  { id: "markdownImage", label: "图片", desc: "插入 Markdown 图片", defaultKey: "Mod-Alt-i", run: MARKDOWN_ACTIONS.markdownImage, group: "markdown" },
  { id: "markdownTable", label: "表格", desc: "插入 Markdown 表格", defaultKey: "Mod-Alt-t", run: MARKDOWN_ACTIONS.markdownTable, group: "markdown" },
  { id: "markdownMathBlock", label: "数学公式", desc: "插入块级数学公式", defaultKey: "Mod-Alt-m", run: MARKDOWN_ACTIONS.markdownMathBlock, group: "markdown" },
  { id: "markdownMermaidFlowchart", label: "Mermaid 流程图", desc: "插入 Mermaid 流程图模板", defaultKey: "Mod-Alt-1", run: MARKDOWN_ACTIONS.markdownMermaidFlowchart, group: "markdown" },
  { id: "markdownMermaidSequence", label: "Mermaid 时序图", desc: "插入 Mermaid 时序图模板", defaultKey: "Mod-Alt-2", run: MARKDOWN_ACTIONS.markdownMermaidSequence, group: "markdown" },
  { id: "markdownMermaidGantt", label: "Mermaid 甘特图", desc: "插入 Mermaid 甘特图模板", defaultKey: "Mod-Alt-3", run: MARKDOWN_ACTIONS.markdownMermaidGantt, group: "markdown" },
  { id: "markdownMermaidPie", label: "Mermaid 饼图", desc: "插入 Mermaid 饼图模板", defaultKey: "Mod-Alt-4", run: MARKDOWN_ACTIONS.markdownMermaidPie, group: "markdown" },
  { id: "markdownMermaidClass", label: "Mermaid 类图", desc: "插入 Mermaid 类图模板", defaultKey: "Mod-Alt-5", run: MARKDOWN_ACTIONS.markdownMermaidClass, group: "markdown" },
  { id: "markdownMermaidState", label: "Mermaid 状态图", desc: "插入 Mermaid 状态图模板", defaultKey: "Mod-Alt-6", run: MARKDOWN_ACTIONS.markdownMermaidState, group: "markdown" },
];

/** Run-functions the registry owns, so we can strip their stock bindings. */
const managedRuns = new Set<Command>(EDITOR_COMMANDS.map((c) => c.run));

/** This platform's built-in default for a command. */
export function platformDefault(cmd: EditorCommandDef): string {
  return cmd[PLATFORM] ?? cmd.defaultKey;
}

/** The effective key for a command: a user override if present, else default. */
export function effectiveKey(
  cmd: EditorCommandDef,
  overrides: Record<string, string>,
): string {
  const o = overrides[cmd.id];
  return o && o.trim() ? o : platformDefault(cmd);
}

/**
 * Build the editor's keymap extension from the persisted overrides. The curated
 * commands come first (so an override wins), then the stock keymaps minus the
 * commands we manage (so their old default key no longer fires after a rebind).
 */
export function buildEditorKeymap(
  overrides: Record<string, string>,
  includeMarkdown = false,
) {
  const commands = EDITOR_COMMANDS.filter(
    (cmd) => cmd.group === "general" || includeMarkdown,
  );
  const custom: KeyBinding[] = commands.map((cmd) => {
    const o = overrides[cmd.id];
    // An override applies on every platform; otherwise let CodeMirror pick the
    // platform-specific default via the mac/win/linux fields.
    if (o && o.trim()) return { key: o, run: cmd.run, preventDefault: true };
    return {
      key: cmd.defaultKey,
      mac: cmd.mac,
      win: cmd.win,
      linux: cmd.linux,
      run: cmd.run,
      preventDefault: true,
    };
  });

  const rest = [...defaultKeymap, ...historyKeymap].filter(
    (b) => !b.run || !managedRuns.has(b.run),
  );

  return keymap.of([...custom, ...rest, indentWithTab]);
}

export function runEditorCommand(id: string, view: EditorView): boolean {
  return EDITOR_COMMANDS.find((cmd) => cmd.id === id)?.run(view) ?? false;
}

/** A native tooltip containing the command's current platform-aware binding. */
export function commandTitle(
  label: string,
  id: string,
  overrides: Record<string, string>,
): string {
  const cmd = EDITOR_COMMANDS.find((item) => item.id === id);
  return cmd ? `${label} (${formatKey(effectiveKey(cmd, overrides))})` : label;
}

const KEY_SYMBOLS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
  Space: "Space",
};

/** Render a CodeMirror key string for display, e.g. "Shift-Mod-k" -> "⇧⌘K". */
export function formatKey(key: string): string {
  if (!key) return "";
  return key
    .split("-")
    .map((part) => {
      if (part === "Mod") return IS_MAC ? "⌘" : "Ctrl";
      if (part === "Cmd" || part === "Meta") return IS_MAC ? "⌘" : "Win";
      if (part === "Ctrl") return IS_MAC ? "⌃" : "Ctrl";
      if (part === "Alt") return IS_MAC ? "⌥" : "Alt";
      if (part === "Shift") return IS_MAC ? "⇧" : "Shift";
      if (KEY_SYMBOLS[part]) return KEY_SYMBOLS[part];
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(IS_MAC ? "" : "+");
}

/**
 * Turn a keydown event into a CodeMirror key string, or null if it carries no
 * usable non-modifier key yet (e.g. the user only pressed ⌘ so far). The
 * platform's primary modifier (⌘ on mac, Ctrl elsewhere) is stored as "Mod" so
 * a binding stays sensible across operating systems.
 */
export function keyFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return null;

  const parts: string[] = [];
  if (IS_MAC) {
    if (e.metaKey) parts.push("Mod");
    if (e.ctrlKey) parts.push("Ctrl");
  } else {
    if (e.ctrlKey) parts.push("Mod");
    if (e.metaKey) parts.push("Meta");
  }
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let base: string;
  const primaryModifier = IS_MAC
    ? e.metaKey || e.ctrlKey
    : e.ctrlKey || e.metaKey;
  const codePunctuation: Record<string, string> = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  // Cmd/Ctrl combined with Shift or Option may turn event.key into a symbol
  // ("*", "¡", …). CodeMirror matches the physical letter/digit fallback,
  // so store that same base key when a command modifier is present.
  const shiftedSymbol =
    primaryModifier &&
    e.shiftKey &&
    (/^Digit\d$/.test(e.code) || !!codePunctuation[e.code]);
  const macAltCharacter = IS_MAC && e.metaKey && e.altKey;
  if (macAltCharacter && /^Key[A-Z]$/.test(e.code))
    base = e.code.slice(3).toLowerCase();
  else if (
    (shiftedSymbol || macAltCharacter) &&
    /^Digit\d$/.test(e.code)
  )
    base = e.code.slice(5);
  else if ((shiftedSymbol || macAltCharacter) && codePunctuation[e.code])
    base = codePunctuation[e.code];
  else if (k === " " || k === "Spacebar") base = "Space";
  else if (k.length === 1) base = k.toLowerCase();
  else base = k; // ArrowUp, Enter, Backspace, Tab, F1...

  parts.push(base);
  return parts.join("-");
}

/** Canonicalise modifier aliases/order so equivalent bindings conflict. */
export function canonicalKey(key: string): string {
  const parts = key.split(/-(?!$)/);
  const base = parts.pop()?.toLowerCase() ?? "";
  let alt = false;
  let ctrl = false;
  let meta = false;
  let shift = false;
  for (const part of parts) {
    if (/^mod$/i.test(part)) IS_MAC ? (meta = true) : (ctrl = true);
    else if (/^(cmd|meta|m)$/i.test(part)) meta = true;
    else if (/^(ctrl|control|c)$/i.test(part)) ctrl = true;
    else if (/^(alt|a)$/i.test(part)) alt = true;
    else if (/^(shift|s)$/i.test(part)) shift = true;
  }
  return [
    meta ? "Meta" : "",
    ctrl ? "Ctrl" : "",
    alt ? "Alt" : "",
    shift ? "Shift" : "",
    base,
  ]
    .filter(Boolean)
    .join("-");
}
