import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { copyFileToClipboard, copyImageToClipboard, copyText } from "../clipboard";
import { dirname } from "../fs";
import { unwrapImageDest } from "../imageSyntax";
import { isDraftPath, useAppStore } from "../../store/useAppStore";
import { imageAt } from "./imageAt";
import { isResourceLink, resourceSourceField } from "./resourcePreview";

export type ClipboardResource = { kind: "image" | "file"; url: string };

/** Only an entire rendered object uses binary copying. Prose, code, partial
 * selections and explicitly revealed source retain normal text copying. */
export function selectedClipboardResource(state: EditorState): ClipboardResource | null {
  const source = state.field(resourceSourceField, false);
  if (source === undefined || state.selection.ranges.length !== 1) return null;
  const range = state.selection.main;
  if (range.empty || source?.from === range.from) return null;
  const tree = ensureSyntaxTree(state, range.to, 50) ?? syntaxTree(state);
  const image = imageAt(state, range.from + 1);
  if (image?.from === range.from && image.to === range.to)
    return { kind: "image", url: image.url };
  let node = tree.resolveInner(range.from + 1, 1);
  while (node.parent && node.name !== "Link" && node.name !== "Image") node = node.parent;
  if (node.from !== range.from || node.to !== range.to) return null;
  if (node.name !== "Link" && node.name !== "Image") return null;
  const destination = node.getChildren("URL").find((url) =>
    url.prevSibling?.name === "LinkMark" &&
    state.sliceDoc(url.prevSibling.from, url.prevSibling.to) === "(",
  );
  if (!destination) return null;
  const url = state.sliceDoc(destination.from, destination.to);
  return node.name === "Image" ? { kind: "image", url }
    : isResourceLink(url) ? { kind: "file", url } : null;
}

/** Resolve note-relative destinations, preserving drive and UNC roots. */
export function resolveClipboardFilePath(raw: string, base: string | null): string {
  let path = unwrapImageDest(raw).split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch { /* Keep literal percent signs. */ }
  path = path.replace(/\\/g, "/");
  if (!path) throw new Error("文件路径为空");
  if (!path.startsWith("/") && !/^[a-z]:\//i.test(path)) {
    if (!base) throw new Error("无法解析文件路径，请先保存笔记或打开工程");
    path = `${base.replace(/\\/g, "/")}/${path}`;
  }
  const unc = path.startsWith("//");
  const drive = /^[a-z]:\//i.test(path);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > (unc ? 2 : drive ? 1 : 0)) parts.pop();
    } else parts.push(part);
  }
  return (unc ? "//" : drive ? "" : "/") + parts.join("/");
}

export async function copyEditorSelection(view: EditorView, textOnly = false): Promise<void> {
  const resource = textOnly ? null : selectedClipboardResource(view.state);
  if (!resource) {
    await copyText(view.state.selection.ranges.filter((r) => !r.empty)
      .map((r) => view.state.sliceDoc(r.from, r.to)).join("\n"));
  } else if (resource.kind === "image") {
    await copyImageToClipboard(resource.url);
  } else {
    const { activeFilePath, workspacePath } = useAppStore.getState();
    const base = activeFilePath && !isDraftPath(activeFilePath) ? dirname(activeFilePath) : workspacePath;
    await copyFileToClipboard(resolveClipboardFilePath(resource.url, base));
  }
}

export function copyEditorSelectionSafe(view: EditorView, textOnly = false): void {
  void copyEditorSelection(view, textOnly).catch((error) =>
    useAppStore.getState().showToast(`复制失败：${String(error)}`, "error"),
  );
}

/** Keep Ctrl/Cmd+C and the context menu's Copy action consistent. */
export const resourceClipboard = EditorView.domEventHandlers({
  copy(event, view) {
    if (!selectedClipboardResource(view.state)) return false;
    event.preventDefault();
    copyEditorSelectionSafe(view);
    return true;
  },
});
