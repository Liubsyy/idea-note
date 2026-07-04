import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A tiny, dependency-free markdown renderer for assistant replies. Renders to
 * React nodes (no dangerouslySetInnerHTML, so no XSS surface) and deliberately
 * uses only simple, anchored regexes — no lookbehind / named groups — so it is
 * safe on the macOS 12 WKWebView (see the project's old-WebKit regex note).
 *
 * Supported: fenced code blocks, headings, unordered/ordered lists,
 * blockquotes, tables, paragraphs, plus inline code, **bold** and
 * [links](url).
 */

type CellAlign = "left" | "center" | "right" | null;

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; head: string[]; align: CellAlign[]; rows: string[][] }
  | { type: "p"; text: string };

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);

const splitRow = (l: string): string[] =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** The `| --- | :---: |` row that turns the line above it into a table head. */
const isSeparatorRow = (l: string) =>
  isTableRow(l) && splitRow(l).every((c) => /^:?-+:?$/.test(c));

const isSpecial = (l: string) =>
  /^```/.test(l) ||
  /^#{1,6}\s+/.test(l) ||
  /^>\s?/.test(l) ||
  /^\s*[-*]\s+/.test(l) ||
  /^\s*\d+\.\s+/.test(l) ||
  isTableRow(l);

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // skip closing fence
      blocks.push({ type: "code", lang, code: buf.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: buf.join("\n") });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      blocks.push({ type: "ol", items });
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const head = splitRow(line);
      const align: CellAlign[] = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isSeparatorRow(lines[i])) {
        rows.push(splitRow(lines[i++]));
      }
      blocks.push({ type: "table", head, align, rows });
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isSpecial(lines[i])) buf.push(lines[i++]);
    // A special-looking line no branch consumed (e.g. a table row whose
    // separator hasn't streamed in yet) must still advance `i`, or this loop
    // never terminates and the whole window freezes mid-stream.
    if (buf.length === 0) buf.push(lines[i++]);
    blocks.push({ type: "p", text: buf.join("\n") });
  }

  return blocks;
}

/** Inline tokenizer: inline code, **bold**, [text](url); rest is plain text. */
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = "";
  let key = 0;
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      flush();
      out.push(<code key={key++} className="ai-code-inline">{m[1]}</code>);
      i += m[0].length;
      continue;
    }
    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      flush();
      out.push(<strong key={key++}>{m[1]}</strong>);
      i += m[0].length;
      continue;
    }
    m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest);
    if (m) {
      flush();
      out.push(
        <span key={key++} className="ai-link" title={m[2]}>
          {m[1]}
        </span>,
      );
      i += m[0].length;
      continue;
    }

    buf += text[i];
    i++;
  }
  flush();
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  return (
    <div className="ai-codeblock">
      <div className="ai-codeblock-head">
        <span>{lang || "code"}</span>
        <button onClick={copy} title="复制代码">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderBlock(b: Block, key: number): React.ReactNode {
  switch (b.type) {
    case "code":
      return <CodeBlock key={key} lang={b.lang} code={b.code} />;
    case "heading": {
      const Tag = (`h${Math.min(b.level, 4)}` as "h1" | "h2" | "h3" | "h4");
      return <Tag key={key}>{renderInline(b.text)}</Tag>;
    }
    case "ul":
      return (
        <ul key={key}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case "quote":
      return <blockquote key={key}>{renderInline(b.text)}</blockquote>;
    case "table": {
      const cellStyle = (j: number) =>
        b.align[j] ? { textAlign: b.align[j] as "left" | "center" | "right" } : undefined;
      return (
        <div key={key} className="ai-table-wrap">
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} style={cellStyle(j)}>
                    {renderInline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri}>
                  {/* Pad/trim ragged body rows to the header's column count. */}
                  {b.head.map((_, j) => (
                    <td key={j} style={cellStyle(j)}>
                      {renderInline(row[j] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return (
        <p key={key} className="whitespace-pre-wrap">
          {renderInline(b.text)}
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  return <div className="ai-prose">{parseBlocks(text).map(renderBlock)}</div>;
}
