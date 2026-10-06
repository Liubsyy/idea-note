// There is one editor at a time; the toolbar reaches it through this singleton
// rather than threading the EditorView through React context.

import type { EditorView } from "@codemirror/view";

let current: EditorView | null = null;

export const setActiveView = (v: EditorView | null) => {
  current = v;
};
export const getActiveView = (): EditorView | null => current;

// A formatted preview can be searched without becoming the source-editing target.
let previewSearchView: EditorView | null = null;
export const setPreviewSearchView = (view: EditorView | null) => {
  previewSearchView = view;
};
export const getSearchView = (): EditorView | null => previewSearchView ?? current;
