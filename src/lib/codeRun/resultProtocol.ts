import { isOutKind, type OutKind } from "./fenceAttrs.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TableResultData {
  columns: string[];
  rows: JsonValue[][];
}

export type ComponentResult =
  | { type: "text" | "markdown" | "html" | "mermaid"; data: string }
  | { type: "json"; data: JsonValue }
  | { type: "table"; data: TableResultData }
  | { type: "image"; data: string | string[] };

export interface ParsedComponentOutput {
  result: ComponentResult | null;
  error: string | null;
}

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const jsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  const object = objectValue(value);
  return object !== null && Object.values(object).every(jsonValue);
};

function validateData(type: OutKind, data: unknown): ComponentResult | string {
  if (
    type === "text" ||
    type === "markdown" ||
    type === "html" ||
    type === "mermaid"
  ) {
    return typeof data === "string"
      ? { type, data }
      : `${type} 的 data 必须是 JSON 字符串`;
  }

  if (type === "json") {
    return jsonValue(data)
      ? { type, data }
      : "json 的 data 必须是合法 JSON 值";
  }

  if (type === "image") {
    const valid =
      (typeof data === "string" && data.length > 0) ||
      (Array.isArray(data) &&
        data.length > 0 &&
        data.every((path) => typeof path === "string" && path.length > 0));
    return valid
      ? { type, data: data as string | string[] }
      : "image 的 data 必须是非空路径字符串或路径字符串数组";
  }

  const table = objectValue(data);
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows))
    return "table 的 data 必须包含 columns 和 rows 数组";
  if (!table.columns.every((column) => typeof column === "string"))
    return "table.columns 必须全部是字符串";
  const columns = table.columns as string[];
  if (
    !table.rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === columns.length &&
        row.every(jsonValue),
    )
  )
    return "table.rows 的每一行必须是与 columns 等长的 JSON 数组";
  return { type, data: { columns, rows: table.rows as JsonValue[][] } };
}

const jsonError = (error: unknown): string =>
  `结果不是合法的单行 JSON：${error instanceof Error ? error.message : String(error)}`;

/**
 * Parse the structured component result from stdout after a successful run.
 *
 * With an explicit `out=`, the last non-empty stdout line is the bare JSON
 * data. Without it, ordinary JSON log lines are ignored and the last
 * `{"idea_note_result": ...}` envelope wins.
 */
export function parseComponentOutput(
  stdout: string,
  declaredOut: OutKind | null,
): ParsedComponentOutput {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (declaredOut) {
    const raw = lines[lines.length - 1];
    if (!raw)
      return { result: null, error: `out=${declaredOut} 没有返回 JSON data` };
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      return { result: null, error: jsonError(error) };
    }
    const checked = validateData(declaredOut, data);
    return typeof checked === "string"
      ? { result: null, error: checked }
      : { result: checked, error: null };
  }

  let envelope: Record<string, unknown> | null = null;
  let malformedMarker = false;
  let invalidEnvelope = false;
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (/^\{\s*"idea_note_result"\s*:/.test(line)) malformedMarker = true;
      continue;
    }
    const root = objectValue(value);
    if (!root || !own(root, "idea_note_result")) continue;
    const candidate = objectValue(root.idea_note_result);
    if (!candidate) {
      invalidEnvelope = true;
      continue;
    }
    envelope = candidate;
    malformedMarker = false;
  }

  if (!envelope) {
    if (malformedMarker)
      return { result: null, error: "idea_note_result 不是合法的单行 JSON" };
    if (invalidEnvelope)
      return { result: null, error: "idea_note_result 必须是包含 type 和 data 的对象" };
    return { result: null, error: null };
  }

  const type = envelope.type;
  if (typeof type !== "string" || !isOutKind(type))
    return { result: null, error: `不支持的组件类型：${String(type)}` };
  if (!own(envelope, "data"))
    return { result: null, error: "idea_note_result 缺少 data" };
  const checked = validateData(type, envelope.data);
  return typeof checked === "string"
    ? { result: null, error: checked }
    : { result: checked, error: null };
}
