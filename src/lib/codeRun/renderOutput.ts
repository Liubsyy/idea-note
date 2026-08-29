// Turning a validated component result into rich, safe DOM.
//
// stdout framing and JSON validation live in resultProtocol.ts. Keeping those
// concerns out of this module means every renderer receives the exact data
// shape it expects, whether it is used in the editor or the output panel.
//
// Everything is built into a caller-owned host element so the same code serves
// the inline result widget and the output panel.

import MarkdownIt from "markdown-it";

import { renderMermaidSvg } from "../codemirror/diagram";
import { sanitizeHtml } from "../codemirror/inlineHtml";
import { toDisplaySrc } from "../imagePath";
import type {
  ComponentResult,
  JsonValue,
  TableResultData,
} from "./resultProtocol";

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

const cellText = (value: JsonValue): string => {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

/** Sortable table. Sorting is numeric when a whole column parses as numbers —
 *  the common case for a block that prints a computed report. */
function tableNode(data: TableResultData): HTMLElement {
  const wrap = el("div", "cm-run-render-table");
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  const tbody = el("tbody");
  let sortCol = -1;
  let ascending = true;

  const fill = () => {
    tbody.replaceChildren();
    const rows = data.rows.map((row) => row.map(cellText));
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
      for (let i = 0; i < data.columns.length; i++) {
        const td = el("td");
        td.textContent = row[i] ?? "";
        tr.append(td);
      }
      tbody.append(tr);
    }
  };

  data.columns.forEach((name, i) => {
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

function jsonNode(data: JsonValue): HTMLElement {
  const pre = el("pre", "cm-run-render-text");
  pre.textContent = JSON.stringify(data, null, 2);
  return pre;
}

function imageNode(data: string | string[], onSettle?: () => void): HTMLElement {
  const wrap = el("div", "cm-run-render-image");
  const paths = Array.isArray(data) ? data : [data];
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
 * Render a validated result into `host`, replacing whatever was there.
 *
 * `onSettle` fires when an async renderer (mermaid, markdown, an image) has
 * changed the height, so a widget can ask CodeMirror to measure again.
 */
export function renderOutput(
  host: HTMLElement,
  result: ComponentResult,
  onSettle?: () => void,
): void {
  switch (result.type) {
    case "text":
      host.replaceChildren(textNode(result.data));
      break;
    case "table":
      host.replaceChildren(tableNode(result.data));
      break;
    case "json":
      host.replaceChildren(jsonNode(result.data));
      break;
    case "mermaid":
      host.replaceChildren(mermaidNode(result.data, onSettle));
      break;
    case "html":
      host.replaceChildren(htmlNode(result.data, onSettle));
      break;
    case "image":
      host.replaceChildren(imageNode(result.data, onSettle));
      break;
    case "markdown":
      host.replaceChildren(markdownNode(result.data));
      break;
  }
}

export function renderOutputError(host: HTMLElement, message: string): void {
  host.replaceChildren(errorNode(message));
}
