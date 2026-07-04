// Print / export the active markdown note.
//
// Both paths render the note into an isolated #print-root container that
// print.css shows exclusively under `@media print`:
//   - printCurrentNote: opens the system print dialog ("存储为 PDF").
//   - exportCurrentNoteAsPdf: silent native print-to-PDF via the backend
//     `export_pdf` command (no dialog, straight to the chosen file).
// The container lives in the main document (not an iframe) so the
// already-loaded KaTeX fonts/CSS and mermaid just work.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { useAppStore } from "../../store/useAppStore";
import { basename, isMarkdownFile } from "../fs";
import { renderMarkdownToHtml } from "./renderMarkdown";

const PRINT_ROOT_ID = "print-root";

const stripMdExt = (name: string) => name.replace(/\.(md|markdown)$/i, "");

/** Resolve once every <img> in `root` has settled (loaded or errored). */
function waitForImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  return Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
    ),
  ).then(() => undefined);
}

/**
 * Render `markdown` into #print-root and resolve once images loaded and layout
 * settled, i.e. the document is ready to be handed to the print pipeline.
 * The container is intentionally left in place afterwards (hidden on screen,
 * overwritten on the next print/export).
 */
export async function fillPrintRoot(markdown: string): Promise<void> {
  const html = await renderMarkdownToHtml(markdown);
  let host = document.getElementById(PRINT_ROOT_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = PRINT_ROOT_ID;
    document.body.appendChild(host);
  }
  host.innerHTML = `<article class="print-doc">${html}</article>`;
  await waitForImages(host);
  // KaTeX webfonts load lazily on first use; printing before they arrive
  // leaves blank glyphs in the PDF. Two rAFs let layout kick the loads off,
  // then fonts.ready waits for them.
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  try {
    await document.fonts.ready;
  } catch {
    // FontFaceSet unsupported → print with whatever fonts are available.
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

export type PdfOutlineEntry = {
  level: number;
  title: string;
  marker: string;
};

/**
 * Prepare PDF outline (bookmark) data for the document currently in
 * #print-root: prepend an invisible ASCII marker to every heading and return
 * the heading tree info. The backend locates each marker in the exported PDF
 * (immune to CJK glyph-mapping quirks that break title-text search) and turns
 * it into a bookmark destination. Markers are 1px white text — some engines
 * drop fully-transparent text from the PDF, white-on-white survives — and are
 * wiped on the next fillPrintRoot along with the rest of the content.
 */
export function prepareOutlineForExport(): PdfOutlineEntry[] {
  const host = document.getElementById(PRINT_ROOT_ID);
  if (!host) return [];
  const heads = Array.from(
    host.querySelectorAll<HTMLElement>(
      ".print-doc h1, .print-doc h2, .print-doc h3, .print-doc h4, .print-doc h5, .print-doc h6",
    ),
  );
  return heads.flatMap((el, i) => {
    const title = (el.textContent ?? "").trim();
    if (!title) return [];
    const marker = `%%OL${i}%%`;
    const span = document.createElement("span");
    span.className = "pdf-outline-marker";
    span.textContent = marker;
    el.style.position = "relative";
    el.insertBefore(span, el.firstChild);
    return [{ level: Number(el.tagName.charAt(1)), title, marker }];
  });
}

/** The active note's markdown + display title, or null (with a toast). */
function activeNote(verb: string): { content: string; title: string } | null {
  const { activeFilePath, content, showToast } = useAppStore.getState();
  if (!activeFilePath || !isMarkdownFile(activeFilePath)) {
    showToast(`请先打开一篇 Markdown 笔记再${verb}`, "error");
    return null;
  }
  return { content, title: stripMdExt(basename(activeFilePath)) };
}

export async function printCurrentNote(): Promise<void> {
  const { showToast } = useAppStore.getState();
  const note = activeNote("打印");
  if (!note) return;

  try {
    await fillPrintRoot(note.content);
  } catch {
    showToast("生成打印内容失败", "error");
    return;
  }

  // The document title seeds the print dialog's default filename.
  const prevTitle = document.title;
  document.title = note.title;

  // Restore the temporarily-overridden title once printing is done. We do NOT
  // clear #print-root here: it's hidden on screen and overwritten on the next
  // print, and wiping it while the print panel is still open would blank the
  // output.
  let restored = false;
  const restoreTitle = () => {
    if (restored) return;
    restored = true;
    document.title = prevTitle;
    window.removeEventListener("afterprint", restoreTitle);
  };
  window.addEventListener("afterprint", restoreTitle);

  try {
    // macOS: window.print() is a no-op in WKWebView, so the backend opens the
    // native print panel via WebviewWindow::print(). Other platforms eval
    // window.print(). Either way @media print isolates the note.
    await invoke("print_page");
  } catch {
    restoreTitle();
    showToast("打印失败，请重试", "error");
    return;
  }
  // Safety net in case `afterprint` never fires.
  setTimeout(restoreTitle, 60000);
}

export async function exportCurrentNoteAsPdf(): Promise<void> {
  const { showToast } = useAppStore.getState();
  const note = activeNote("导出");
  if (!note) return;

  const path = await save({
    defaultPath: `${note.title}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return;

  try {
    await fillPrintRoot(note.content);
  } catch {
    showToast("生成导出内容失败", "error");
    return;
  }

  try {
    await invoke("export_pdf", { path, outline: prepareOutlineForExport() });
    showToast("已导出 PDF", "success");
  } catch (e) {
    showToast(typeof e === "string" ? e : "导出 PDF 失败", "error");
  }
}
