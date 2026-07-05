// Cmd/Ctrl+click opens markdown links (Typora-style; plain click still just
// moves the cursor so the text stays editable). External URLs go to the system
// browser via the opener plugin; relative paths resolve against the current
// file's directory (workspace root for drafts) and open in the editor.
//
// Links in regular text are located through the syntax tree at the clicked
// position. Links inside block widgets (table cells) can't be — widget DOM has
// no precise syntax-tree position and widgets swallow events before they reach
// the editor — so the widget attaches its own listener and calls
// openLinkTargetSafe with the cell's `data-href` (see tablePreview.ts).

import { syntaxTree } from "@codemirror/language";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";

import { isDraftPath, useAppStore } from "../../store/useAppStore";
import { fileStat, pathIsDir } from "../fs";

const EXTERNAL = /^(https?|mailto|tel):/i;

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

/** Directory of `path`, handling both `/` and `\` separators. */
function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/** Collapse `.` and `..` segments (segments themselves are kept verbatim). */
function normalize(path: string): string {
  const isWinAbs = /^[A-Za-z]:/.test(path);
  const out: string[] = [];
  for (const seg of path.split(/[/\\]/)) {
    if (!seg || seg === ".") continue;
    if (seg === ".." && out.length > (isWinAbs ? 1 : 0)) out.pop();
    else if (seg !== "..") out.push(seg);
  }
  return (path.startsWith("/") ? "/" : "") + out.join("/");
}

/** The link destination at `pos`, or null when the position isn't in a link. */
function linkTargetAt(view: EditorView, pos: number): string | null {
  for (
    let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(
      view.state,
    ).resolveInner(pos, 0);
    n;
    n = n.parent
  ) {
    if (n.name === "Link" || n.name === "Image") {
      // A GFM autolink in the label adds an extra URL child; the destination
      // is the URL right after the "(" mark, so prefer that one.
      const urls = n.getChildren("URL");
      const url =
        urls.find(
          (u) =>
            u.prevSibling?.name === "LinkMark" &&
            view.state.sliceDoc(u.prevSibling.from, u.prevSibling.to) === "(",
        ) ?? urls[0];
      return url ? view.state.sliceDoc(url.from, url.to) : null;
    }
    if (n.name === "Autolink") {
      const t = view.state.sliceDoc(n.from, n.to);
      return t.startsWith("<") && t.endsWith(">") ? t.slice(1, -1) : t;
    }
    // A bare URL opens itself — unless it's a link label, where the click
    // should open the link's destination (handled by the Link ancestor).
    if (n.name === "URL" && n.parent?.name !== "Link")
      return view.state.sliceDoc(n.from, n.to);
  }
  return null;
}

/** Open a markdown link destination; also used by widget DOM (tablePreview). */
export async function openLinkTarget(raw: string): Promise<void> {
  const store = useAppStore.getState();
  let target = raw.trim();
  // A <…>-wrapped destination is CommonMark's way to allow spaces; unwrap it.
  if (target.startsWith("<") && target.endsWith(">"))
    target = target.slice(1, -1).trim();
  if (EXTERNAL.test(target)) {
    await openUrl(target);
    return;
  }
  // Bare www. autolinks (GFM) have no scheme but are clearly external.
  if (/^www\./i.test(target)) {
    await openUrl(`https://${target}`);
    return;
  }
  if (target.startsWith("#")) return; // in-document anchors: not supported
  const hash = target.indexOf("#");
  if (hash >= 0) target = target.slice(0, hash);
  if (!target) return;
  try {
    target = decodeURI(target);
  } catch {
    // Malformed percent-encoding: try the raw text as a literal path.
  }
  const active = store.activeFilePath;
  const base =
    active && !isDraftPath(active) ? dirname(active) : store.workspacePath;
  const abs = isAbsolute(target)
    ? normalize(target)
    : base
      ? normalize(`${base}/${target}`)
      : null;
  if (!abs) {
    store.showToast("无法解析链接路径", "error");
    return;
  }
  if (await pathIsDir(abs).catch(() => false)) {
    store.showToast("链接指向文件夹，暂不支持打开", "error");
    return;
  }
  if (!(await fileStat(abs))) {
    store.showToast(`文件不存在：${abs}`, "error");
    return;
  }
  await store.openFile(abs);
}

/** Fire-and-forget open with a toast on failure. */
export function openLinkTargetSafe(target: string): void {
  void openLinkTarget(target).catch((e) =>
    useAppStore.getState().showToast(`打开链接失败：${String(e)}`, "error"),
  );
}

const clickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const target = pos == null ? null : linkTargetAt(view, pos);
    if (!target) return false;
    event.preventDefault();
    openLinkTargetSafe(target);
    return true;
  },
});

// Toggle `cm-mod-down` on the editor while Cmd/Ctrl is held, so links only
// show the pointer cursor when a click would actually open them (editor.css).
// Listeners live on window: the modifier is often pressed before the editor
// has focus. window blur clears the state when a Cmd+Tab eats the keyup.
const modifierCursor = ViewPlugin.fromClass(
  class {
    private sync = (e: KeyboardEvent | MouseEvent) =>
      this.view.dom.classList.toggle("cm-mod-down", e.metaKey || e.ctrlKey);
    private clear = () => this.view.dom.classList.remove("cm-mod-down");
    constructor(private view: EditorView) {
      window.addEventListener("keydown", this.sync);
      window.addEventListener("keyup", this.sync);
      window.addEventListener("blur", this.clear);
    }
    destroy() {
      window.removeEventListener("keydown", this.sync);
      window.removeEventListener("keyup", this.sync);
      window.removeEventListener("blur", this.clear);
    }
  },
);

export const markdownLinkClick = [clickHandler, modifierCursor];
