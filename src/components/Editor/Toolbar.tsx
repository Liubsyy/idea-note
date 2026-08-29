import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Quote,
  List,
  ListOrdered,
  Braces,
  Minus,
  Link as LinkIcon,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Heading,
  ChevronDown,
  Shapes,
  Table,
  ListChecks,
  Sigma,
  Workflow,
  ChevronRight,
  Highlighter,
  StickyNote,
  Pipette,
  Ban,
} from "lucide-react";

import type { EditorView } from "@codemirror/view";
import { md } from "../../lib/codemirror/markdownCommands";
import { getActiveView } from "../../lib/codemirror/activeView";
import { CodeComponentModal } from "./CodeComponentModal";
import {
  hasActiveTableCell,
  prepareActiveTableCellSelection,
  restoreActiveTableCell,
} from "../../lib/codemirror/tablePreview";
import {
  commandTitle,
  runEditorCommand,
} from "../../lib/codemirror/keybindings";
import {
  loadLastMarkdownColors,
  MERMAID_TYPES,
  saveLastMarkdownColors,
} from "../../lib/codemirror/markdownActions";
import { useAppStore } from "../../store/useAppStore";
import { ColorPicker } from "./ColorPicker";
import {
  highlightColorCss,
  parseHighlightColor,
  type HighlightColor,
} from "../../lib/highlightBlock";

// GFM cells support inline content only. Running a block command such as a
// heading or list against a cell would rewrite the table row's prefix and break
// the table, so only commands that stay within the current cell are admitted.
const TABLE_CELL_COMMANDS = new Set([
  "undo",
  "redo",
  "markdownBold",
  "markdownItalic",
  "markdownStrike",
  "markdownInlineCode",
  "markdownTextColor",
  "markdownBgColor",
  "markdownClearColor",
  "markdownLink",
  "markdownImage",
]);

/** Text-colour glyph without the extra baseline drawn by Lucide's Baseline icon. */
function TextColorIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 20 7-16 7 16" />
      <path d="M7.5 14h9" />
    </svg>
  );
}

function Divider() {
  return (
    <span
      className="mx-1 h-5 w-px shrink-0"
      style={{ background: "var(--border)" }}
    />
  );
}

interface BtnProps {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}
function Btn({ title, onClick, children, active }: BtnProps) {
  return (
    <button
      title={title}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md transition-colors"
      style={{
        color: active ? "var(--accent)" : "var(--text)",
        background: active ? "var(--active)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active
          ? "var(--active)"
          : "transparent";
      }}
    >
      {children}
    </button>
  );
}

/**
 * Icon-and-chevron trigger that opens a portaled menu below it. The menu is
 * portaled to body so the toolbar's `overflow-x` can't clip it; clicking
 * outside, scrolling or resizing closes it. `render` receives a `close`
 * callback so items can dismiss the menu after acting.
 *
 * With `onPrimary` the control splits in two: the icon repeats that action
 * directly and only the chevron opens the menu — the colour tools use it to
 * reapply the last colour without going through the palette again.
 */
function Dropdown({
  title,
  primaryTitle,
  active,
  menuWidth,
  trigger,
  render,
  onPrimary,
  onClose,
}: {
  title: string;
  primaryTitle?: string;
  active?: boolean;
  menuWidth: number;
  trigger: React.ReactNode;
  render: (close: () => void) => React.ReactNode;
  onPrimary?: () => void;
  /** Fired whenever the menu closes, so `render` can reset its own view. */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Held in a ref so the listener effect below doesn't re-run when the callback
  // identity changes on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    return () => onCloseRef.current?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t))
        setOpen(false);
    };
    const onLeave = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onLeave);
    window.addEventListener("scroll", onLeave, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("scroll", onLeave, true);
    };
  }, [open]);

  const toggle = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left, y: r.bottom + 4 });
    setOpen((v) => !v);
  };

  // Shared by both halves of a split control, and by the whole button otherwise.
  const half = (
    label: string,
    onClick: () => void,
    className: string,
    children: React.ReactNode,
  ) => (
    <button
      title={label}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      className={`flex h-8 items-center transition-colors ${className}`}
      style={{
        color: active ? "var(--accent)" : "var(--text)",
        background: active ? "var(--active)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active
          ? "var(--active)"
          : "transparent";
      }}
    >
      {children}
    </button>
  );

  return (
    <>
      <div ref={triggerRef} className="flex shrink-0 items-center">
        {onPrimary ? (
          <>
            {half(
              primaryTitle ?? title,
              onPrimary,
              "rounded-l-md pl-1.5 pr-1",
              trigger,
            )}
            {half(title, toggle, "rounded-r-md pr-1", <ChevronDown size={13} />)}
          </>
        ) : (
          half(
            title,
            toggle,
            "gap-0.5 rounded-md px-1.5",
            <>
              {trigger}
              <ChevronDown size={13} />
            </>,
          )
        )}
      </div>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 rounded-lg py-1"
            style={{
              left: pos.x,
              top: pos.y,
              width: menuWidth,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
          >
            {render(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A labelled row in a dropdown menu, optionally with a leading icon. */
function MenuItem({
  icon,
  label,
  title,
  active,
  onClick,
  style,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  title?: string;
  active?: boolean;
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
      style={{
        color: active ? "var(--accent)" : "var(--text)",
        background: active ? "var(--active)" : "transparent",
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active
          ? "var(--active)"
          : "transparent";
      }}
    >
      {icon}
      <span className="flex-1">{label}</span>
    </button>
  );
}

/**
 * A menu row that expands a second panel to its right on hover. The sub-panel
 * is a DOM descendant, so the pointer moving onto it never fires this row's
 * mouseleave, and it stays inside the parent dropdown for outside-click checks.
 */
function SubMenu({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm"
        style={{
          color: "var(--text)",
          background: open ? "var(--hover)" : "transparent",
        }}
      >
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight size={13} style={{ color: "var(--text-muted)" }} />
      </div>
      {open && (
        <div
          className="absolute rounded-lg py-1"
          style={{
            left: "100%",
            top: -5,
            width: 132,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 24px var(--shadow)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Colour palette grid inside the text/background colour menus. Swatches are
 * literal hex — the colour is written into the note as `<span style>`, so it
 * has to survive export and being opened in another editor, where the app's
 * theme variables mean nothing.
 */
function Swatches({
  colors,
  current,
  onPick,
}: {
  colors: string[];
  current: string | null;
  onPick: (color: string) => void;
}) {
  const active = current?.toLowerCase();
  return (
    <div className="grid grid-cols-8 gap-1 px-2 py-1.5">
      {colors.map((c) => (
        <button
          key={c}
          title={c}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
          className="h-5 w-5 rounded transition-transform hover:scale-110"
          style={{
            background: c,
            border: "1px solid var(--border)",
            outline: active === c ? "2px solid var(--accent)" : "none",
            outlineOffset: 1,
          }}
        />
      ))}
    </div>
  );
}

// Both palettes are a grid: one hue per column (red → pink), one shade per row,
// over a row of neutrals. Picking down a column keeps the hue and changes only
// how strong it is.
const TEXT_COLORS = [
  "#000000", "#404040", "#737373", "#a3a3a3", "#d4d4d4", "#e5e5e5", "#f5f5f5", "#ffffff",
  "#9f1239", "#9a3412", "#854d0e", "#166534", "#155e75", "#1e40af", "#5b21b6", "#9d174d",
  "#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777",
  "#fb7185", "#fb923c", "#facc15", "#4ade80", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6",
];

// Highlighter tints — lighter than the text palette so the text on top stays
// legible, with the neutrals reversed to lead with the pale ones.
const BG_COLORS = [
  "#ffffff", "#f5f5f5", "#e5e5e5", "#d4d4d4", "#a3a3a3", "#737373", "#404040", "#000000",
  "#fee2e2", "#ffedd5", "#fef9c3", "#dcfce7", "#cffafe", "#dbeafe", "#ede9fe", "#fce7f3",
  "#fecaca", "#fed7aa", "#fef08a", "#bbf7d0", "#a5f3fc", "#bfdbfe", "#ddd6fe", "#fbcfe8",
  "#fca5a5", "#fdba74", "#fde047", "#86efac", "#67e8f9", "#93c5fd", "#c4b5fd", "#f9a8d4",
];

const HIGHLIGHT_OPTIONS: {
  color: HighlightColor;
  label: string;
  swatch: string;
}[] = [
  { color: "blue", label: "蓝色", swatch: "#3b82f6" },
  { color: "yellow", label: "黄色", swatch: "#eab308" },
  { color: "green", label: "绿色", swatch: "#22c55e" },
  { color: "red", label: "红色", swatch: "#ef4444" },
  { color: "purple", label: "紫色", swatch: "#a855f7" },
];

/**
 * A colour tool: a split button whose icon half reapplies `last` and whose
 * chevron opens the menu. The menu shows the palette, and swaps to the custom
 * colour panel in place when 自定义 is chosen — no second dialog on top.
 */
function ColorDropdown({
  title,
  primaryTitle,
  clearTitle,
  icon,
  colors,
  last,
  current,
  onPrimary,
  onPick,
  onClear,
}: {
  title: string;
  primaryTitle: string;
  clearTitle: string;
  icon: React.ReactNode;
  colors: string[];
  /** Colour the icon half applies, drawn as the bar under it. */
  last: string;
  /** Colour at the cursor, ringed in the palette; null outside a coloured span. */
  current: string | null;
  onPrimary: () => void;
  onPick: (color: string) => void;
  onClear: () => void;
}) {
  const [custom, setCustom] = useState(false);
  return (
    <Dropdown
      title={title}
      primaryTitle={primaryTitle}
      active={!!current}
      menuWidth={212}
      onPrimary={onPrimary}
      onClose={() => setCustom(false)}
      trigger={
        <span className="flex flex-col items-center">
          {icon}
          <span
            className="mt-px h-[3px] w-4 rounded-sm"
            style={{ background: last }}
          />
        </span>
      }
      render={(close) =>
        custom ? (
          <ColorPicker
            initial={current ?? last}
            onBack={() => setCustom(false)}
            onSubmit={(c) => {
              onPick(c);
              close();
            }}
          />
        ) : (
          <>
            <Swatches
              colors={colors}
              current={current}
              onPick={(c) => {
                onPick(c);
                close();
              }}
            />
            <div className="my-1 h-px" style={{ background: "var(--border)" }} />
            <MenuItem
              icon={<Pipette size={15} />}
              label="自定义…"
              onClick={() => setCustom(true)}
            />
            <MenuItem
              icon={<Ban size={15} />}
              label="清除颜色"
              title={clearTitle}
              onClick={() => {
                onClear();
                close();
              }}
            />
          </>
        )
      }
    />
  );
}

/** Highlight-block colour picker with named shortcuts, a broad palette and a
 * custom panel. Every non-preset choice is stored as a validated hex value. */
function HighlightBlockDropdown({
  current,
  iconSize,
  primaryTitle,
  onPrimary,
  onPick,
}: {
  current: HighlightColor | null;
  iconSize: number;
  primaryTitle: string;
  onPrimary: () => void;
  onPick: (color: HighlightColor) => void;
}) {
  const [custom, setCustom] = useState(false);
  const defaultColor = highlightColorCss("blue");
  const pickerColor = highlightColorCss(current ?? "blue");

  return (
    <Dropdown
      title="高亮块颜色"
      primaryTitle={primaryTitle}
      active={current !== null}
      menuWidth={212}
      onPrimary={onPrimary}
      onClose={() => setCustom(false)}
      trigger={
        <span className="flex flex-col items-center">
          <StickyNote size={iconSize} />
          <span
            className="mt-px h-[3px] w-4 rounded-sm"
            style={{ background: defaultColor }}
          />
        </span>
      }
      render={(close) =>
        custom ? (
          <ColorPicker
            initial={pickerColor}
            onBack={() => setCustom(false)}
            onSubmit={(color) => {
              const parsed = parseHighlightColor(color);
              if (parsed) onPick(parsed);
              close();
            }}
          />
        ) : (
          <>
            {HIGHLIGHT_OPTIONS.map((item) => (
              <MenuItem
                key={item.color}
                icon={
                  <span
                    className="h-3.5 w-3.5 rounded-sm"
                    style={{ background: item.swatch }}
                  />
                }
                label={item.label}
                active={current === item.color}
                onClick={() => {
                  onPick(item.color);
                  close();
                }}
              />
            ))}
            <div className="my-1 h-px" style={{ background: "var(--border)" }} />
            <div
              className="px-2 pt-1 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              更多颜色
            </div>
            <Swatches
              colors={BG_COLORS}
              current={current}
              onPick={(color) => {
                const parsed = parseHighlightColor(color);
                if (parsed) onPick(parsed);
                close();
              }}
            />
            <div className="my-1 h-px" style={{ background: "var(--border)" }} />
            <MenuItem
              icon={<Pipette size={15} />}
              label="自定义…"
              onClick={() => setCustom(true)}
            />
          </>
        )
      }
    />
  );
}

export function Toolbar() {
  const active = useAppStore((s) => s.activeFormats);
  const editorKeybindings = useAppStore((s) => s.editorKeybindings);
  const [lastColors, setLastColors] = useState(loadLastMarkdownColors);
  const [componentOpen, setComponentOpen] = useState(false);

  const iconSize = 15;
  // Apply a colour and make it the button's one-click default from now on.
  const applyColor = (kind: "text" | "bg", color: string) => {
    const next = { ...lastColors, [kind]: color };
    setLastColors(next);
    saveLastMarkdownColors(next);
    run((v) =>
      kind === "text" ? md.textColor(v, color) : md.bgColor(v, color),
    );
  };
  // Run a command against the active editor view, if any.
  const run = (fn: (v: EditorView) => void) => {
    const v = getActiveView();
    if (!v || v.state.readOnly) return;
    const inTable = hasActiveTableCell(v);
    const cell = prepareActiveTableCellSelection(v);
    if (inTable && !cell) {
      useAppStore
        .getState()
        .showToast("请只选择一个表格单元格", "error");
      return;
    }
    fn(v);
    if (cell) restoreActiveTableCell(v, cell);
  };
  const runCommand = (id: string) => {
    const v = getActiveView();
    if (!v) return;
    const inTable = hasActiveTableCell(v);
    if (inTable && !TABLE_CELL_COMMANDS.has(id)) {
      useAppStore
        .getState()
        .showToast("表格单元格仅支持行内格式", "error");
      return;
    }
    const cell = prepareActiveTableCellSelection(v);
    if (inTable && !cell) {
      useAppStore
        .getState()
        .showToast("请只选择一个表格单元格", "error");
      return;
    }
    const handled = runEditorCommand(id, v);
    if (cell && handled) restoreActiveTableCell(v, cell);
  };
  const shortcut = (label: string, id: string) =>
    commandTitle(label, id, editorKeybindings);
  const applyHighlightColor = (color: HighlightColor) => {
    const v = getActiveView();
    if (!v || v.state.readOnly) return;
    if (hasActiveTableCell(v)) {
      useAppStore
        .getState()
        .showToast("表格单元格仅支持行内格式", "error");
      return;
    }
    md.highlightBlockColor(v, color);
  };

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto px-2">
      {/* Heading dropdown */}
      <Dropdown
        title="标题"
        active={active.heading > 0}
        menuWidth={128}
        trigger={<Heading size={iconSize} />}
        render={(close) => (
          <>
            {[1, 2, 3, 4, 5, 6].map((lvl) => (
              <MenuItem
                key={lvl}
                label={`标题 ${lvl}`}
                title={shortcut(`标题 ${lvl}`, `markdownHeading${lvl}`)}
                active={active.heading === lvl}
                style={{ fontSize: `${20 - lvl}px` }}
                onClick={() => {
                  runCommand(`markdownHeading${lvl}`);
                  close();
                }}
              />
            ))}
            <div
              className="my-1 h-px"
              style={{ background: "var(--border)" }}
            />
            <MenuItem
              label="正文"
              title={shortcut("正文", "markdownParagraph")}
              onClick={() => {
                runCommand("markdownParagraph");
                close();
              }}
            />
          </>
        )}
      />

      <Divider />

      <Btn
        title={shortcut("加粗", "markdownBold")}
        active={active.bold}
        onClick={() => runCommand("markdownBold")}
      >
        <Bold size={iconSize} />
      </Btn>
      <Btn
        title={shortcut("斜体", "markdownItalic")}
        active={active.italic}
        onClick={() => runCommand("markdownItalic")}
      >
        <Italic size={iconSize} />
      </Btn>
      <Btn
        title={shortcut("删除线", "markdownStrike")}
        active={active.strike}
        onClick={() => runCommand("markdownStrike")}
      >
        <Strikethrough size={iconSize} />
      </Btn>
      <Btn
        title={shortcut("行内代码", "markdownInlineCode")}
        active={active.code}
        onClick={() => runCommand("markdownInlineCode")}
      >
        <Code size={iconSize} />
      </Btn>

      {/* Text / background colour — both write a `<span style>` around the
          selection, the one form every markdown renderer understands. The icon
          half reapplies the colour under the bar; the chevron opens the palette. */}
      <ColorDropdown
        title="文字颜色"
        primaryTitle={shortcut(
          `应用文字颜色 ${lastColors.text}`,
          "markdownTextColor",
        )}
        clearTitle={shortcut("清除颜色", "markdownClearColor")}
        icon={<TextColorIcon size={iconSize} />}
        colors={TEXT_COLORS}
        last={lastColors.text}
        current={active.textColor}
        onPrimary={() => runCommand("markdownTextColor")}
        onPick={(c) => applyColor("text", c)}
        onClear={() => runCommand("markdownClearColor")}
      />
      <ColorDropdown
        title="背景色"
        primaryTitle={shortcut(
          `应用背景色 ${lastColors.bg}`,
          "markdownBgColor",
        )}
        clearTitle={shortcut("清除颜色", "markdownClearColor")}
        icon={<Highlighter size={iconSize} />}
        colors={BG_COLORS}
        last={lastColors.bg}
        current={active.bgColor}
        onPrimary={() => runCommand("markdownBgColor")}
        onPick={(c) => applyColor("bg", c)}
        onClear={() => runCommand("markdownClearColor")}
      />

      <Divider />

      <Btn
        title={shortcut("无序列表", "markdownBulletList")}
        active={active.bulletList}
        onClick={() => runCommand("markdownBulletList")}
      >
        <List size={iconSize} />
      </Btn>
      <Btn
        title={shortcut("有序列表", "markdownOrderedList")}
        active={active.orderedList}
        onClick={() => runCommand("markdownOrderedList")}
      >
        <ListOrdered size={iconSize} />
      </Btn>
      <Btn
        title={shortcut("任务列表", "markdownTaskList")}
        onClick={() => runCommand("markdownTaskList")}
      >
        <ListChecks size={iconSize} />
      </Btn>

      <Divider />

      <Btn
        title={shortcut("引用", "markdownQuote")}
        active={active.blockquote}
        onClick={() => runCommand("markdownQuote")}
      >
        <Quote size={iconSize} />
      </Btn>
      <HighlightBlockDropdown
        primaryTitle={shortcut("高亮块", "markdownHighlightBlock")}
        current={active.highlightColor}
        iconSize={iconSize}
        onPrimary={() => runCommand("markdownHighlightBlock")}
        onPick={applyHighlightColor}
      />
      {/* Code block: the icon inserts a plain fence (unchanged), the chevron
          offers the parameterised component, whose fence attributes nobody
          should have to remember. */}
      <Dropdown
        title="代码块"
        primaryTitle={shortcut("代码块", "markdownCodeBlock")}
        active={active.codeBlock}
        menuWidth={168}
        trigger={<Braces size={iconSize} />}
        onPrimary={() => runCommand("markdownCodeBlock")}
        render={(close) => (
          <>
            <MenuItem
              label="普通代码块"
              title={shortcut("代码块", "markdownCodeBlock")}
              onClick={() => {
                runCommand("markdownCodeBlock");
                close();
              }}
            />
            <MenuItem
              label="可交互组件"
              title="带参数控件和输出渲染的可交互代码块"
              onClick={() => {
                close();
                setComponentOpen(true);
              }}
            />
          </>
        )}
      />
      <Btn
        title={shortcut("分割线", "markdownHr")}
        onClick={() => runCommand("markdownHr")}
      >
        <Minus size={iconSize} />
      </Btn>

      <Divider />

      <Btn
        title={shortcut("链接", "markdownLink")}
        active={active.link}
        onClick={() => runCommand("markdownLink")}
      >
        <LinkIcon size={iconSize} />
      </Btn>
      <Btn
        title={shortcut(active.image ? "编辑图片" : "图片", "markdownImage")}
        active={active.image}
        onClick={() => runCommand("markdownImage")}
      >
        <ImageIcon size={iconSize} />
      </Btn>

      {/* Insert dropdown — block templates the editor renders but that have no
          single-key syntax: table, task list, math, mermaid. */}
      <Dropdown
        title="插入"
        menuWidth={168}
        trigger={<Shapes size={iconSize} />}
        render={(close) => (
          <>
            <MenuItem
              icon={<Table size={15} />}
              label="表格"
              title={shortcut("表格", "markdownTable")}
              onClick={() => {
                runCommand("markdownTable");
                close();
              }}
            />
            <MenuItem
              icon={<Sigma size={15} />}
              label="数学公式"
              title={shortcut("数学公式", "markdownMathBlock")}
              onClick={() => {
                runCommand("markdownMathBlock");
                close();
              }}
            />
            <SubMenu icon={<Workflow size={15} />} label="Mermaid 图表">
              {MERMAID_TYPES.map((t) => (
                <MenuItem
                  key={t.label}
                  label={t.label}
                  title={shortcut(t.label, t.commandId)}
                  onClick={() => {
                    runCommand(t.commandId);
                    close();
                  }}
                />
              ))}
            </SubMenu>
          </>
        )}
      />

      <Divider />

      <Btn title={shortcut("撤销", "undo")} onClick={() => runCommand("undo")}>
        <Undo2 size={iconSize} />
      </Btn>
      <Btn title={shortcut("重做", "redo")} onClick={() => runCommand("redo")}>
        <Redo2 size={iconSize} />
      </Btn>

      {componentOpen && (
        <CodeComponentModal
          onClose={() => setComponentOpen(false)}
          onInsert={(snippet) => {
            setComponentOpen(false);
            run((v) => md.codeComponent(v, snippet));
          }}
        />
      )}
    </div>
  );
}
