import { tr } from "../i18n/core.ts";
import { applyEdits, format, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parseAllDocuments } from "yaml";

export type StructuredKind = "json" | "yaml";
export interface StructuredResult { text: string | null; error: string | null }

/** Format a separate text copy; callers explicitly decide whether to apply it. */
export function formatStructured(source: string, kind: StructuredKind): StructuredResult {
  try {
    if (kind === "json") {
      const errors: ParseError[] = [];
      const tree = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false });
      if (errors.length || !tree) {
        const error = errors[0];
        const before = source.slice(0, error?.offset ?? 0).split("\n");
        return { text: null, error: tr("JSON 第 {{0}} 行，第 {{1}} 列：{{2}}", { 0: before.length, 1: before[before.length - 1].length + 1, 2: error ? printParseErrorCode(error.error) : tr("缺少内容") }) };
      }
      // Whitespace edits preserve number lexemes, duplicate keys and string escapes.
      return { text: applyEdits(source, format(source, undefined, {
        tabSize: 2, insertSpaces: true, eol: source.includes("\r\n") ? "\r\n" : "\n",
      })), error: null };
    }
    const docs = parseAllDocuments(source, { keepSourceTokens: true, uniqueKeys: true, intAsBigInt: true });
    const errors = docs.flatMap(doc => doc.errors);
    if (errors.length) return { text: null, error: `YAML：${errors[0].message}` };
    // Empty and comment-only YAML has no document nodes; keep its text intact.
    if (!docs.length) return { text: source, error: null };
    for (const doc of docs) {
      // These parsed nodes are unchanged. Retain exact numeric spelling rather
      // than serializing rounded JS floats (also preserves -0 and hex values).
      doc.schema.tags = doc.schema.tags.map(tag => tag.stringify ? {
        ...tag,
        stringify: (node, ...args) =>
          (typeof node.value === "number" || typeof node.value === "bigint") && node.source != null
            ? node.source : tag.stringify!(node, ...args),
      } : tag);
    }
    // A following document may emit directives; terminate the preceding document
    // explicitly so those directives cannot be parsed as mapping content.
    const text = docs.map((doc, index) => {
      if (index < docs.length - 1 && doc.directives) doc.directives.docEnd = true;
      return doc.toString({ indent: 2, lineWidth: 0 });
    }).join("");
    return { text: source.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text, error: null };
  } catch (error) {
    return { text: null, error: tr("无法格式化：{{0}}", { 0: String(error) }) };
  }
}
