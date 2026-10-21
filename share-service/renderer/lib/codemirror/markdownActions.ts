import type { EditorView } from "@codemirror/view";
import { renderRuntime } from "../../runtime";
export const openImagePrompt = (view: EditorView) => renderRuntime.openImagePrompt(view);
export const openResourcePrompt = (view: EditorView, url: string, label: string) => renderRuntime.openResourcePrompt(view, url, label);
