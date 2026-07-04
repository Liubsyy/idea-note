// CodeMirror structural theme. Colors come from our CSS variables so the
// existing light/dark tokens drive the editor. Markdown element styling lives
// in editor.css (keyed off the cm-md-* classes the live-preview plugin adds).

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const cmTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "transparent",
    fontSize: "var(--editor-font-size)",
  },
  ".cm-scroller": {
    // User-selectable body font (Settings › 编辑器); the var already ends in a
    // system fallback, and the literal here is a safety net if it's ever unset.
    fontFamily:
      'var(--editor-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif)',
    lineHeight: "var(--editor-line-height)",
    overflow: "auto",
  },
  ".cm-content": {
    maxWidth: "none",
    margin: "0 auto",
    // Side gutters scale with the editor width (min 40px, else 6%).
    padding: "40px max(40px, 6%) 30vh",
    caretColor: "var(--accent)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-muted)",
    borderRight: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-line": { padding: "0" },
});

// Theme applied ONLY to plain-text / code files (non-markdown). Must be placed
// BEFORE cmTheme in the extension list — earlier extensions win style
// conflicts in CodeMirror — or none of these overrides apply.
// Turns the bare textarea into a proper code editor layout while keeping the
// same user-configured font family, size, and line-height as markdown.
export const cmPlainTextTheme = EditorView.theme({
  ".cm-scroller": {
    fontFamily:
      'var(--editor-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif)',
    lineHeight: "var(--editor-line-height)",
  },
  // Override the centered prose layout with a left-aligned, full-width one.
  ".cm-content": {
    margin: "0",
    maxWidth: "none",
    padding: "12px 0 40vh",
  },
  ".cm-line": { padding: "0 18px 0 14px" },
  // Active line band (content side).
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  // Soft gutter panel with a hairline separator.
  ".cm-gutters": {
    backgroundColor: "var(--bg-elev)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
    userSelect: "none",
  },
  ".cm-lineNumbers": { minWidth: "3em" },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 12px 0 18px",
    textAlign: "right",
    fontSize: "0.85em",
    fontVariantNumeric: "tabular-nums",
    color: "var(--text-muted)",
    opacity: "0.5",
    transition: "color 0.12s ease, opacity 0.12s ease",
  },
  // Active line: band continues across the gutter, number turns accent.
  ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  ".cm-lineNumbers .cm-gutterElement.cm-activeLineGutter": {
    color: "var(--accent)",
    opacity: "1",
    fontWeight: "600",
  },
});

// Compact read-only editor styling used inside the history diff. It borrows
// the app colors and code/prose font choices without the main editor's
// centered, document-like padding.
export const cmHistoryDiffTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--bg)",
    fontSize: "12.5px",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, "SF Mono", SFMono-Regular, Menlo, "JetBrains Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace',
    lineHeight: "1.65",
    overflow: "auto",
  },
  "&.cm-history-markdown .cm-scroller": {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  ".cm-content": {
    margin: "0",
    maxWidth: "none",
    padding: "12px 0 40vh",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0 18px 0 14px" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-elev)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
    userSelect: "none",
  },
  ".cm-lineNumbers": { minWidth: "3em" },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 12px 0 18px",
    textAlign: "right",
    fontSize: "0.85em",
    fontVariantNumeric: "tabular-nums",
    color: "var(--text-muted)",
    opacity: "0.5",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--selection)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
});

// Syntax highlighting for fenced code blocks (markdown's nested languages).
const codeHighlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: "var(--heading)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, color: "var(--text)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--text-muted)" },
  { tag: t.keyword, color: "#c678dd" },
  { tag: [t.string, t.special(t.string)], color: "#98c379" },
  { tag: [t.number, t.bool, t.null], color: "#d19a66" },
  { tag: [t.comment], color: "var(--text-muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#61afef" },
  { tag: [t.typeName, t.className], color: "#e5c07b" },
  { tag: [t.operator, t.punctuation], color: "var(--text-muted)" },
  { tag: [t.propertyName, t.attributeName], color: "#e06c75" },
]);

export const cmHighlighting = syntaxHighlighting(codeHighlight, { fallback: true });
