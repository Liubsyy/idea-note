// Customisable editor keymap. A curated registry of high-value editing commands
// is exposed in Settings (快捷键 tab); each one keeps its CodeMirror default but
// can be rebound. The override map (command id -> key string) is persisted in
// app settings; everything not in the registry keeps the stock defaultKeymap.
//
// Defaults are cross-platform: "Mod" resolves to ⌘ on macOS and Ctrl on
// Windows/Linux, and a few commands carry explicit per-platform keys (mac / win
// / linux) to mirror exactly what CodeMirror binds on each OS.
import { keymap, type Command, type KeyBinding } from "@codemirror/view";
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
}

/**
 * The curated "快捷键大全". Defaults mirror what `defaultKeymap` /
 * `historyKeymap` bind on each platform today, so an untouched setup behaves
 * exactly as before — on macOS, Windows and Linux alike.
 */
export const EDITOR_COMMANDS: EditorCommandDef[] = [
  { id: "undo", label: "撤销", desc: "撤销上一次编辑", defaultKey: "Mod-z", run: undo },
  // Redo: ⌘⇧Z on mac, Ctrl+Y on Windows, Ctrl+Shift+Z on Linux.
  { id: "redo", label: "重做", desc: "重做被撤销的编辑", defaultKey: "Mod-y", mac: "Mod-Shift-z", linux: "Ctrl-Shift-z", run: redo },
  { id: "selectAll", label: "全选", desc: "选中整个文档", defaultKey: "Mod-a", run: selectAll },
  // Select line: ⌃L on mac, Alt+L on Windows/Linux.
  { id: "selectLine", label: "选中整行", desc: "选中光标所在行", defaultKey: "Alt-l", mac: "Ctrl-l", run: selectLine },
  { id: "selectParentSyntax", label: "选中父级语法", desc: "向外扩展选区到父级语法节点", defaultKey: "Mod-i", run: selectParentSyntax },
  { id: "copyLineUp", label: "向上复制行", desc: "复制当前行并插入到上方", defaultKey: "Shift-Alt-ArrowUp", run: copyLineUp },
  { id: "copyLineDown", label: "向下复制行", desc: "复制当前行并插入到下方", defaultKey: "Shift-Alt-ArrowDown", run: copyLineDown },
  { id: "moveLineUp", label: "上移当前行", desc: "把当前行与上一行互换", defaultKey: "Alt-ArrowUp", run: moveLineUp },
  { id: "moveLineDown", label: "下移当前行", desc: "把当前行与下一行互换", defaultKey: "Alt-ArrowDown", run: moveLineDown },
  { id: "deleteLine", label: "删除整行", desc: "删除光标所在行", defaultKey: "Shift-Mod-k", run: deleteLine },
  { id: "indentMore", label: "增加缩进", desc: "向右缩进所选行", defaultKey: "Mod-]", run: indentMore },
  { id: "indentLess", label: "减少缩进", desc: "向左缩进所选行", defaultKey: "Mod-[", run: indentLess },
  { id: "toggleComment", label: "注释/取消注释", desc: "切换当前行或选区的注释", defaultKey: "Mod-/", run: toggleComment },
  { id: "cursorMatchingBracket", label: "跳到匹配括号", desc: "把光标移到配对的括号处", defaultKey: "Shift-Mod-\\", run: cursorMatchingBracket },
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
export function buildEditorKeymap(overrides: Record<string, string>) {
  const custom: KeyBinding[] = EDITOR_COMMANDS.map((cmd) => {
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
  if (k === " " || k === "Spacebar") base = "Space";
  else if (k.length === 1) base = k.toLowerCase();
  else base = k; // ArrowUp, Enter, Backspace, Tab, F1...

  parts.push(base);
  return parts.join("-");
}
