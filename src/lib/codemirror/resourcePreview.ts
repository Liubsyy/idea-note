import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { renderInlineHtml, sanitizeHtml } from "./inlineHtml";
import { openLinkTargetSafe } from "./linkClick";
import { openResourcePrompt } from "./markdownActions";

export type ResourceRange = { from: number; to: number };
export const setResourceSource = StateEffect.define<ResourceRange | null>();

/** Source is opt-in, and stays open until the selection leaves the resource. */
export const resourceSourceField = StateField.define<ResourceRange | null>({
  create: () => null,
  update(value, tr) {
    if (tr.state.readOnly) return null;
    for (const effect of tr.effects)
      if (effect.is(setResourceSource)) return effect.value;
    if (!value) return null;
    const mapped = tr.docChanged
      ? { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) }
      : value;
    if (mapped.from === mapped.to) return null;
    if (tr.selection && !tr.state.selection.ranges.some(
      (range) => range.from <= mapped.to && range.to >= mapped.from,
    )) return null;
    return mapped;
  },
});

export function resourceSourceVisible(state: EditorState, from: number): boolean {
  return !state.readOnly && state.field(resourceSourceField, false)?.from === from;
}

export function resourceSelected(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => !range.empty && range.from <= from && range.to >= to);
}

const SOURCE_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4M6 8l-4 4 4 4m8.5-12-5 16" /></svg>';

/** Shared interaction for image previews and file chips. Select the underlying
 * markdown so copy, cut, delete and toolbar commands keep working normally. */
export function bindResourcePreview(
  wrap: HTMLElement, view: EditorView, range: ResourceRange,
  url: string, label: string, selected: boolean,
  onEdit?: () => void,
): void {
  wrap.classList.add("cm-md-resource");
  wrap.setAttribute("data-resource-from", String(range.from));
  wrap.setAttribute("data-resource-to", String(range.to));
  wrap.classList.toggle("cm-md-resource-selected", selected);
  let editedOnPress = false;
  wrap.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      openLinkTargetSafe(url);
      return;
    }
    view.dispatch({
      selection: { anchor: event.shiftKey ? view.state.selection.main.anchor : range.from, head: range.to },
      effects: setResourceSource.of(null),
      userEvent: "select.pointer",
    });
    view.focus();
    // Selection can replace the widget DOM on the first press. The second
    // mousedown still carries the browser's click count, even if dblclick is lost.
    editedOnPress = event.detail === 2 && !event.shiftKey && !event.altKey && !view.state.readOnly;
    if (editedOnPress) onEdit?.();
  });
  if (view.state.readOnly) return;
  wrap.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!editedOnPress && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey)
      onEdit?.();
  });
  wrap.classList.add("cm-md-resource-editable");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-md-resource-source";
  button.title = `显示${label}源码`;
  button.setAttribute("aria-label", button.title);
  button.innerHTML = SOURCE_ICON;
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  for (const type of ["pointerdown", "mousedown", "touchstart"] as const)
    button.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    view.dispatch({
      effects: setResourceSource.of({ from: range.from, to: range.to }),
      selection: { anchor: range.from },
      scrollIntoView: true,
    });
    view.focus();
  });
  wrap.prepend(button);
}

/** Local Markdown links are resource files; ordinary web links keep their
 * existing text editing behaviour. Drive-letter paths are local as well. */
export function isResourceLink(raw: string): boolean {
  const path = raw.trim().replace(/^<|>$/g, "");
  return !!path && !path.startsWith("#") && !path.startsWith("//") &&
    !/^www\./i.test(path) &&
    (!/^[a-z][\w+.-]*:/i.test(path) || /^[a-z]:[\\/]/i.test(path));
}

const FILE_OUTLINE = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6"/>';
const FILE_TYPES = [
  { kind: "pdf", label: "PDF 文档", ext: /^(pdf)$/, glyph: '<path d="M8 16h8M8 12h5M8 19h5"/>' },
  { kind: "document", label: "文档", ext: /^(docx?|odt|rtf|pages)$/, glyph: '<path d="m7 12 2 7 3-5 3 5 2-7"/>' },
  { kind: "spreadsheet", label: "表格", ext: /^(xlsx?|xlsm|xlsb|csv|tsv|ods|numbers)$/, glyph: '<path d="M8 12h8v7H8zM8 15h8M12 12v7"/>' },
  { kind: "presentation", label: "演示文稿", ext: /^(pptx?|pptm|odp|key)$/, glyph: '<path d="M8 12h8v5H8zM12 17v3m-3 0h6"/>' },
  { kind: "archive", label: "压缩包", ext: /^(zip|rar|7z|tar|gz|bz2|xz|tgz|zst)$/, glyph: '<path d="M10 3h2m-2 3h2m-2 3h2m-2 3h2m-2 3h2v4h-2z"/>' },
  { kind: "image", label: "图片", ext: /^(png|jpe?g|gif|svg|webp|bmp|ico|avif|heic|tiff?|psd)$/, glyph: '<circle cx="9" cy="12" r="1"/><path d="m7 19 4-4 2 2 2-3 3 5"/>' },
  { kind: "audio", label: "音频", ext: /^(mp3|wav|flac|aac|ogg|m4a|wma|opus|aiff)$/, glyph: '<path d="M14 17v-6l3-1v6"/><circle cx="12" cy="18" r="2"/>' },
  { kind: "video", label: "视频", ext: /^(mp4|mkv|mov|avi|webm|wmv|m4v|mpeg|mpg)$/, glyph: '<path d="m10 12 6 4-6 4z"/>' },
  { kind: "code", label: "代码", ext: /^(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|rb|php|swift|kt|sh|bat|ps1|sql|html?|css|scss|vue|lua)$/, glyph: '<path d="m9 12-3 3 3 3m6-6 3 3-3 3"/>' },
  { kind: "config", label: "配置文件", ext: /^(json|jsonc|ya?ml|toml|ini|conf|cfg|xml|env|properties|lock)$/, glyph: '<path d="M10 11H9v3l-2 1 2 1v3h1m4-8h1v3l2 1-2 1v3h-1"/>' },
  { kind: "text", label: "文本", ext: /^(txt|md|markdown|mdx|log|tex)$/, glyph: '<path d="M8 12h8M8 15h8M8 18h5"/>' },
];

export function resourceFileIcon(raw: string): { kind: string; label: string; svg: string } {
  let path = raw.trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch { /* Keep malformed paths usable. */ }
  const name = path.split(/[\\/]/).pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const type = FILE_TYPES.find((type) => type.ext.test(ext));
  return {
    kind: type?.kind ?? "file",
    label: type?.label ?? "文件",
    svg: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${FILE_OUTLINE}${type?.glyph ?? ""}</svg>`,
  };
}

export class ResourceWidget extends WidgetType {
  constructor(
    readonly url: string, readonly label: string, readonly from: number,
    readonly to: number, readonly selected: boolean, readonly readOnly: boolean,
  ) { super(); }
  eq(other: ResourceWidget) {
    return other.url === this.url && other.label === this.label &&
      other.from === this.from && other.to === this.to &&
      other.selected === this.selected && other.readOnly === this.readOnly;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-resource-file";
    wrap.title = `${this.url}（双击编辑，Ctrl/Cmd+点击打开）`;
    const type = resourceFileIcon(this.url);
    const icon = document.createElement("span");
    icon.className = "cm-md-resource-icon";
    icon.dataset.fileType = type.kind;
    icon.title = type.label;
    icon.innerHTML = type.svg;
    const text = document.createElement("span");
    text.className = "cm-md-resource-label";
    text.innerHTML = sanitizeHtml(renderInlineHtml(this.label || this.url));
    wrap.append(icon, text);
    bindResourcePreview(wrap, view, this, this.url, "资源文件", this.selected,
      () => openResourcePrompt(view, this.url, this.label));
    return wrap;
  }
  ignoreEvent() { return true; }
}
