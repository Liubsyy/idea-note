// Turning a run's stdout into something other than a wall of text.
//
// A block declares what it prints (`out=table`, `out=mermaid`, …) and this
// module renders it. The point of doing it here — rather than teaching scripts
// to emit HTML — is that the note stays plain markdown: the script prints CSV
// or mermaid source, which is exactly what it would print in a terminal, and
// the renderer is the app's business.
//
// Everything is built into a caller-owned host element so the same code serves
// the inline result widget and the output panel.

import MarkdownIt from "markdown-it";

import { renderMermaidSvg } from "../codemirror/diagram";
import { sanitizeHtml } from "../codemirror/inlineHtml";
import { toDisplaySrc } from "../imagePath";
import { parseCsv } from "../inputs/sources";
import type { OutKind } from "./fenceAttrs";

/** Drop CSI escapes: a colourised table would otherwise render its codes as
 *  cell text. Both the two-byte `ESC [` and the single-byte C1 form, as in
 *  ansi.ts. */
const ANSI = /\x1b\[[0-9;:?]*[A-Za-z]|\x9b[0-9;:?]*[A-Za-z]/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

function errorNode(message: string): HTMLElement {
  const box = el("div", "cm-run-render-error");
  box.textContent = message;
  return box;
}

function textNode(text: string): HTMLElement {
  const pre = el("pre", "cm-run-render-text");
  pre.textContent = text.replace(/\s+$/, "");
  return pre;
}

/* -------------------------------- table --------------------------------- */

/** Rows from either a JSON array (of objects or arrays) or CSV text. */
function tableRows(text: string): { columns: string[]; rows: string[][] } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      data = null;
    }
    if (Array.isArray(data) && data.length > 0) {
      if (Array.isArray(data[0])) {
        const rows = (data as unknown[][]).map((r) => r.map((c) => String(c ?? "")));
        return { columns: rows[0], rows: rows.slice(1) };
      }
      if (typeof data[0] === "object" && data[0] !== null) {
        const objects = data as Record<string, unknown>[];
        const columns = Array.from(
          new Set(objects.flatMap((o) => Object.keys(o))),
        );
        return {
          columns,
          rows: objects.map((o) => columns.map((c) => String(o[c] ?? ""))),
        };
      }
    }
    return null;
  }
  const rows = parseCsv(trimmed);
  if (rows.length === 0) return null;
  return { columns: rows[0], rows: rows.slice(1) };
}

/** Sortable table. Sorting is numeric when a whole column parses as numbers —
 *  the common case for a block that prints a computed report. */
function tableNode(text: string): HTMLElement {
  const parsed = tableRows(text);
  if (!parsed) return errorNode("输出不是可识别的表格（需要 CSV 或 JSON 数组）");

  const wrap = el("div", "cm-run-render-table");
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  const tbody = el("tbody");
  let sortCol = -1;
  let ascending = true;

  const fill = () => {
    tbody.replaceChildren();
    const rows = [...parsed.rows];
    if (sortCol >= 0) {
      const numeric = rows.every((r) => {
        const v = (r[sortCol] ?? "").trim();
        return v === "" || Number.isFinite(Number(v));
      });
      rows.sort((a, b) => {
        const x = a[sortCol] ?? "";
        const y = b[sortCol] ?? "";
        const cmp = numeric ? Number(x) - Number(y) : x.localeCompare(y);
        return ascending ? cmp : -cmp;
      });
    }
    for (const row of rows) {
      const tr = el("tr");
      for (let i = 0; i < parsed.columns.length; i++) {
        const td = el("td");
        td.textContent = row[i] ?? "";
        tr.append(td);
      }
      tbody.append(tr);
    }
  };

  parsed.columns.forEach((name, i) => {
    const th = el("th");
    th.textContent = name;
    th.title = "点击排序";
    th.addEventListener("click", () => {
      ascending = sortCol === i ? !ascending : true;
      sortCol = i;
      for (const other of headRow.children) other.removeAttribute("data-sort");
      th.setAttribute("data-sort", ascending ? "asc" : "desc");
      fill();
    });
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead, tbody);
  fill();
  wrap.append(table);
  return wrap;
}

/* --------------------------- json / image / html ------------------------ */

function jsonNode(text: string): HTMLElement {
  try {
    const pretty = JSON.stringify(JSON.parse(text.trim()), null, 2);
    const pre = el("pre", "cm-run-render-text");
    pre.textContent = pretty;
    return pre;
  } catch (e) {
    return errorNode(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `::image ./chart.png` lines (a bare path on its own line also works). */
function imageNode(text: string, onSettle?: () => void): HTMLElement {
  const wrap = el("div", "cm-run-render-image");
  const paths = text
    .split("\n")
    .map((l) => l.trim().replace(/^::image[ \t]+/i, "").trim())
    .filter(Boolean);
  if (paths.length === 0) return errorNode("没有可显示的图片路径");
  for (const path of paths) {
    const img = document.createElement("img");
    img.src = toDisplaySrc(path);
    img.alt = path;
    if (onSettle) {
      img.addEventListener("load", onSettle);
      img.addEventListener("error", onSettle);
    }
    wrap.append(img);
  }
  return wrap;
}

/**
 * HTML output, sanitized.
 *
 * This is the script's own output on the user's own machine, not remote
 * content — but it still goes through DOMPurify, because a block that prints
 * data it fetched (an API response, a scraped page) would otherwise hand that
 * data script execution inside the note. Static markup only, by design: a real
 * interactive component needs a sandboxed iframe and a message channel, which
 * is a much bigger promise than this feature makes.
 */
function htmlNode(text: string, onSettle?: () => void): HTMLElement {
  const wrap = el("div", "cm-run-render-html");
  wrap.innerHTML = sanitizeHtml(text);
  wrap.querySelectorAll("img").forEach((img) => {
    const raw = img.getAttribute("src");
    if (raw) img.src = toDisplaySrc(raw);
    if (onSettle) {
      img.addEventListener("load", onSettle);
      img.addEventListener("error", onSettle);
    }
  });
  return wrap;
}

/* -------------------------- mermaid / markdown -------------------------- */

function mermaidNode(text: string, onSettle?: () => void): HTMLElement {
  const wrap = el("div", "cm-run-render-mermaid");
  void renderMermaidSvg(text.trim()).then((result) => {
    if (!wrap.isConnected) return;
    if ("svg" in result) wrap.innerHTML = result.svg;
    else {
      wrap.classList.add("cm-md-mermaid-error");
      wrap.textContent = result.error;
    }
    onSettle?.();
  });
  return wrap;
}

// markdown-it is already in the bundle for the print/PDF renderer, so a shared
// instance here costs nothing. Its own configuration stays separate: this one
// renders a script's output, not a note.
const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

function markdownNode(text: string): HTMLElement {
  const wrap = el("div", "cm-run-render-markdown");
  wrap.innerHTML = sanitizeHtml(md.render(text));
  wrap.querySelectorAll("img").forEach((img) => {
    const raw = img.getAttribute("src");
    if (raw) img.src = toDisplaySrc(raw);
  });
  return wrap;
}

/**
 * Render `text` as `kind` into `host`, replacing whatever was there.
 *
 * `onSettle` fires when an async renderer (mermaid, markdown, an image) has
 * changed the height, so a widget can ask CodeMirror to measure again.
 */
export function renderOutput(
  host: HTMLElement,
  kind: OutKind,
  text: string,
  onSettle?: () => void,
): void {
  if (kind === "text") {
    host.replaceChildren(textNode(text));
    return;
  }
  const body = stripAnsi(text);
  switch (kind) {
    case "table":
      host.replaceChildren(tableNode(body));
      break;
    case "json":
      host.replaceChildren(jsonNode(body));
      break;
    case "mermaid":
      host.replaceChildren(mermaidNode(body, onSettle));
      break;
    case "html":
      host.replaceChildren(htmlNode(body, onSettle));
      break;
    case "image":
      host.replaceChildren(imageNode(body, onSettle));
      break;
    case "markdown":
      host.replaceChildren(markdownNode(body));
      break;
  }
}
