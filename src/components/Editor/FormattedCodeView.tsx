import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { cmHighlighting, cmPlainTextTheme, cmTheme } from "../../lib/codemirror/theme";
import type { StructuredKind } from "../../lib/structuredPreview";
import { useAppStore } from "../../store/useAppStore";
import { editorSearch } from "../../lib/codemirror/searchPanel";
import { buildEditorKeymap, commandTitle } from "../../lib/codemirror/keybindings";
import { getSearchView, setPreviewSearchView } from "../../lib/codemirror/activeView";

/** A separate read-only document, never registered as the source editor. */
export function FormattedCodeView({ text, kind, active = true }: { text: string; kind: StructuredKind; active?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initialText = useRef(text);
  const editorKeybindings = useAppStore(s => s.editorKeybindings);
  const searchBindings = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const editor = new EditorView({ parent: host.current, state: EditorState.create({
      doc: initialText.current,
      extensions: [cmPlainTextTheme, cmTheme, cmHighlighting, lineNumbers(),
        EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": `${kind.toUpperCase()} 格式化视图（只读）`, tabindex: "0" }),
        editorSearch(commandTitle("切换替换", "replace", useAppStore.getState().editorKeybindings)),
        searchBindings.current.of(buildEditorKeymap(useAppStore.getState().editorKeybindings)),
        language.of([])],
    }) });
    view.current = editor;
    void LanguageDescription.matchFilename(languages, `file.${kind}`)?.load().then(support => {
      if (view.current === editor) editor.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => {});
    return () => { view.current = null; editor.destroy(); };
  }, [kind]);
  useEffect(() => {
    view.current?.dispatch({ effects: searchBindings.current.reconfigure(buildEditorKeymap(editorKeybindings)) });
  }, [editorKeybindings, kind]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !active) return;
    setPreviewSearchView(editor);
    editor.requestMeasure();
    return () => {
      if (getSearchView() === editor) setPreviewSearchView(null);
    };
  }, [active, kind]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== text)
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  }, [text]);
  return <div className="cm-host structured-formatted-view" ref={host} />;
}
