import type { EditorView } from "@codemirror/view";
import { renderRuntime } from "../../runtime";
export const runBlock = (view: EditorView, info: string, code: string) => renderRuntime.runBlock(view, info, code);
