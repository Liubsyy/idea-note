import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type StateEffect } from "@codemirror/state";
import {
  EditorView,
  dropCursor,
  lineNumbers,
} from "@codemirror/view";
import { history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";

import { livePreview, syntaxParseDriver } from "../../lib/codemirror/livePreview";
import { markdownAutoCloseFences } from "../../lib/codemirror/autoClose";
import { markdownParagraphEnter } from "../../lib/codemirror/paragraphEnter";
import { paragraphSoftWrap } from "../../lib/codemirror/paragraphWrap";
import { editorSearch } from "../../lib/codemirror/searchPanel";
import { buildEditorKeymap } from "../../lib/codemirror/keybindings";
import { EditorContextMenu, type EditorMenuState } from "./EditorContextMenu";
import { tablePreview } from "../../lib/codemirror/tablePreview";
import { markdownLinkClick } from "../../lib/codemirror/linkClick";
import { htmlPreview } from "../../lib/codemirror/htmlPreview";
import { inlineMath, mathBlock } from "../../lib/codemirror/math";
import { mermaidBlock } from "../../lib/codemirror/diagram";
import { cmTheme, cmHighlighting, cmPlainTextTheme } from "../../lib/codemirror/theme";
import { setActiveView, getActiveView } from "../../lib/codemirror/activeView";
import { handleEditorPaste } from "../../lib/attachments";
import { computeActiveFormats, emptyFormats } from "../../lib/codemirror/activeFormats";
import { isDraftPath, useAppStore, type MdViewMode } from "../../store/useAppStore";
import { basename, isMarkdownFile } from "../../lib/fs";
import { ArrowDownUp } from "lucide-react";
import logoUrl from "../../assets/logo.png";
import "../../lib/codemirror/editor.css";

// Typora-style rendering plugins; gated behind a compartment so source mode can
// drop them while keeping the markdown grammar (and its syntax highlighting) live.
const previewPlugins = [
  syntaxParseDriver,
  livePreview,
  paragraphSoftWrap,
  tablePreview,
  htmlPreview,
  mathBlock,
  mermaidBlock,
];

// Extensions for a markdown view mode, swapped in/out via the compartment:
// "live" renders + editable, "source" drops rendering, "readonly" renders but
// locks editing.
function modeExtensions(mode: MdViewMode) {
  if (mode === "source") return [];
  if (mode === "readonly")
    return [
      ...previewPlugins,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ];
  return previewPlugins;
}

// Per-file cursor + scroll position, captured when a file's editor unmounts
// and restored when that file mounts again. The editor is recreated on every
// tab switch (App keys it on docKey), so without this each switch would land
// at the top of the document.
const viewStateCache = new Map<
  string,
  { anchor: number; head: number; scroll: StateEffect<unknown> }
>();

/**
 * CodeMirror 6 surface with Typora-style live preview: the document is plain
 * markdown, the cursor's line shows source, every other line renders. Mounted
 * fresh per file (App keys it on docKey).
 */
export function CodeMirrorEditor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<EditorMenuState | null>(null);
  const setContent = useAppStore((s) => s.setContent);
  const setActiveFormats = useAppStore((s) => s.setActiveFormats);
  const editorLineNumbers = useAppStore((s) => s.editorLineNumbers);
  const editorKeybindings = useAppStore((s) => s.editorKeybindings);
  const mdViewMode = useAppStore((s) => s.mdViewMode);
  // Compartment holding the view-mode extensions for markdown files, so switching
  // mode reconfigures them in place (no remount, cursor/scroll/edits kept).
  const previewCompartment = useRef(new Compartment());

  useEffect(() => {
    if (!hostRef.current) return;

    const path = useAppStore.getState().activeFilePath;
    // Untitled drafts get the full markdown live-preview, same as .md files.
    const isMd = !!path && (isMarkdownFile(path) || isDraftPath(path));

    // Keep the cache current while the view is alive (on cursor moves and on
    // scroll, below). It can't be captured at unmount: React runs this
    // effect's cleanup after the host div is detached, when scrollTop already
    // reads 0, so a snapshot taken there would always point at the top.
    const captureViewState = (v: EditorView) => {
      if (!path) return;
      const { anchor, head } = v.state.selection.main;
      viewStateCache.set(path, { anchor, head, scroll: v.scrollSnapshot() });
    };

    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) setContent(u.state.doc.toString());
      if (u.docChanged || u.selectionSet) {
        // Read-only mode never edits, so the toolbar shows no active formats
        // even when the user selects rendered content.
        setActiveFormats(
          u.state.readOnly ? emptyFormats : computeActiveFormats(u.state),
        );
        captureViewState(u.view);
      }
    });

    const common = [
      history(),
      // No drawSelection(): it paints a custom selection band that extends into
      // .cm-content's horizontal padding, so the band bleeds past the inset
      // code-block card's background. Native browser selection hugs the text /
      // line boxes instead (colored via the theme's `.cm-content ::selection`),
      // which lines up with the code card and shows over its opaque background.
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      cmHighlighting,
      cmTheme,
      // Before defaultKeymap so the search panel wins Escape (it falls
      // through to simplifySelection when the panel is closed).
      editorSearch,
      // Curated, user-customisable keymap (Settings › 快捷键) + the stock
      // bindings for everything it doesn't manage.
      buildEditorKeymap(editorKeybindings),
      updateListener,
    ];

    // Markdown files get the full Typora-style live preview. Any other file
    // opens as editable plain text, with syntax highlighting picked from the
    // filename when a matching CodeMirror language exists.
    const langCompartment = new Compartment();
    // cmPlainTextTheme must come BEFORE common (which contains cmTheme):
    // earlier extensions take precedence in CodeMirror, so this order is what
    // lets its full-width layout override cmTheme's centered prose padding.
    const plainText = [
      cmPlainTextTheme,
      ...common,
      ...(editorLineNumbers ? [lineNumbers()] : []),
      langCompartment.of([]),
    ];

    const extensions = isMd
      ? [
          // Highest precedence so a paragraph Enter inserts a blank line before
          // the stock keymap's Enter can fire; it defers (returns false) inside
          // lists/code/quotes/tables.
          markdownParagraphEnter,
          markdownAutoCloseFences,
          ...common,
          markdown({
            base: markdownLanguage,
            codeLanguages: languages,
            extensions: [GFM, inlineMath],
          }),
          // Pasting an image/file writes the real file into the configured
          // directory and inserts a markdown reference (markdown notes only).
          EditorView.domEventHandlers({
            paste: (event, view) => handleEditorPaste(view, event),
          }),
          // Cmd/Ctrl+click opens links: external URLs in the browser,
          // relative paths as editor tabs. Works in every view mode.
          markdownLinkClick,
          previewCompartment.current.of(
            modeExtensions(useAppStore.getState().mdViewMode),
          ),
        ]
      : plainText;

    const state = EditorState.create({
      doc: useAppStore.getState().content,
      extensions,
    });

    const view = new EditorView({ state, parent: hostRef.current });
    setActiveView(view);
    // Intentionally not focused on open: the whole document stays rendered and
    // no caret shows until the user clicks into the text.

    // Restore the cursor and scroll position this file had when it was last
    // active. The scroll snapshot re-anchors itself during measure cycles, so
    // it holds even while images/diagrams are still settling their heights;
    // out-of-range targets (file changed on disk) are clipped by the view.
    const cached = path ? viewStateCache.get(path) : undefined;
    if (cached) {
      const len = state.doc.length;
      view.dispatch({
        selection: {
          anchor: Math.min(cached.anchor, len),
          head: Math.min(cached.head, len),
        },
        effects: cached.scroll,
      });
    }

    // Auto-hiding scrollbar: reveal the thumb while scrolling, hide it after a
    // short idle pause — same behavior as the sidebar tree.
    const scroller = view.scrollDOM;
    scroller.classList.add("scroll-auto-hide");
    let scrollTimer: number | undefined;
    const onScroll = () => {
      scroller.classList.add("is-scrolling");
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(
        () => scroller.classList.remove("is-scrolling"),
        800,
      );
      captureViewState(view);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });

    // Lazily load a syntax-highlighting language for non-markdown files.
    if (!isMd && path) {
      const desc = LanguageDescription.matchFilename(languages, basename(path));
      if (desc) {
        desc
          .load()
          .then((lang) =>
            view.dispatch({ effects: langCompartment.reconfigure(lang) }),
          )
          .catch(() => {});
      }
    }

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.clearTimeout(scrollTimer);
      setActiveView(null);
      view.destroy();
    };
  }, [setContent, setActiveFormats, editorLineNumbers, editorKeybindings]);

  // Swap view-mode extensions when the user switches the editor mode tab,
  // reconfiguring in place so the cursor, scroll position and history survive.
  useEffect(() => {
    const view = getActiveView();
    if (!view) return;
    const path = useAppStore.getState().activeFilePath;
    if (!path || (!isMarkdownFile(path) && !isDraftPath(path))) return;
    view.dispatch({
      effects: previewCompartment.current.reconfigure(modeExtensions(mdViewMode)),
    });
    // Reconfiguring doesn't fire a selection/doc change, so sync the toolbar's
    // active-format highlight to the new mode: cleared in read-only, otherwise
    // recomputed for the current selection.
    setActiveFormats(
      mdViewMode === "readonly"
        ? emptyFormats
        : computeActiveFormats(view.state),
    );
  }, [mdViewMode, setActiveFormats]);

  // Right-click: keep the selection when clicking inside it, otherwise move
  // the caret to the click point (native text-field behavior), then show the
  // clipboard menu.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const view = getActiveView();
    if (!view) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const inSelection =
      pos != null &&
      view.state.selection.ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to);
    if (pos != null && !inSelection) {
      view.dispatch({ selection: { anchor: pos } });
    }
    setMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: view.state.selection.ranges.some((r) => !r.empty),
    });
  };

  return (
    <>
      <div ref={hostRef} className="cm-host" onContextMenu={onContextMenu} />
      {menu && <EditorContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

/** Placeholder shown when no file is open. */
export function EmptyEditor() {
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const requestNewFile = useAppStore((s) => s.requestNewFile);
  const openSettings = useAppStore((s) => s.openSettings);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center select-none">
      <img
        src={logoUrl}
        alt="Idea Note"
        className="h-20 w-20 object-contain"
        draggable={false}
      />
      <p className="text-lg font-medium" style={{ color: "var(--text)" }}>
        Idea Note
      </p>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {workspacePath
          ? "从左侧选择一篇笔记，或新建一篇开始写作"
          : "打开一个文件夹作为你的笔记工作区，或克隆一个远程仓库"}
      </p>
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => (workspacePath ? requestNewFile() : openWorkspace())}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--accent)" }}
        >
          {workspacePath ? "新建笔记" : "打开文件夹"}
        </button>
        {!workspacePath && (
          <button
            onClick={() => void openSettings("sync")}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            style={{
              border: "1px solid var(--border)",
              color: "var(--text)",
            }}
          >
            <ArrowDownUp size={15} />
            远程同步
          </button>
        )}
      </div>
    </div>
  );
}
