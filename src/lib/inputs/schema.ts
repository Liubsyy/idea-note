// The ```input block's little language.
//
//     principal: number = 500000 {slider: 0..2000000, step: 10000, label: 贷款总额}
//     years:     select = [20, 25, 30] {default: 30}
//     data:      file   = "./sales.csv" {as: csv}
//
// One field per line, parsed independently: a line that doesn't make sense is
// reported and skipped, and the rest of the block still renders its controls.
// That matters more here than anywhere else in the app — this block is edited
// by hand, in the middle of a note, with the widget watching every keystroke.
//
// Only anchored, plain regexes (no lookbehind, no named groups) — the macOS 12
// WKWebView rejects the rest at parse time.

export type InputValue = string | number | boolean;

export type FieldType =
  | "number"
  | "text"
  | "bool"
  | "select"
  | "file"
  | "date"
  | "time"
  | "datetime";

/** How a `file` field's contents reach the script. */
export type FileFormat = "csv" | "json" | "text";

export interface InputField {
  name: string;
  type: FieldType;
  /** Shown next to the control; defaults to the field name. */
  label: string;
  /** The default written in the note — the value used until the user edits. */
  value: InputValue;
  /** `select` choices. */
  options: InputValue[];
  /** Bounds: numbers on a `number` field, an ISO literal on a date/time one. */
  min: number | string | null;
  max: number | string | null;
  step: number | null;
  /** Render a number field as a slider (implied by `slider: a..b`). */
  slider: boolean;
  /** Suffix shown after the control (元, %, …). */
  unit: string;
  /** `file` only: how to parse the file before handing it to the script. */
  as: FileFormat;
}

export interface InputParseError {
  /** 1-based line inside the block body. */
  line: number;
  text: string;
  message: string;
}

export interface InputSchema {
  fields: InputField[];
  errors: InputParseError[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPES: FieldType[] = [
  "number",
  "text",
  "bool",
  "select",
  "file",
  "date",
  "time",
  "datetime",
];
const FORMATS: FileFormat[] = ["csv", "json", "text"];

/** Strip one layer of matching quotes. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0])
    return s.slice(1, -1);
  return s;
}

const isNumeric = (s: string) => s !== "" && Number.isFinite(Number(s));

/** A literal on the right of `=`: number, quoted string, bool, or bare text. */
function parseLiteral(raw: string): InputValue {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (isNumeric(s)) return Number(s);
  return unquote(s);
}

/** `[a, b, c]` → its items, or null when `raw` isn't a list. */
function parseList(raw: string): InputValue[] | null {
  const s = raw.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return null;
  const body = s.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",").map((item) => parseLiteral(item));
}

/** Split the trailing `{…}` off a field line. */
function splitOptions(line: string): { head: string; opts: string } {
  const open = line.indexOf("{");
  if (open < 0) return { head: line, opts: "" };
  const close = line.lastIndexOf("}");
  if (close < open) return { head: line, opts: "" };
  return { head: line.slice(0, open), opts: line.slice(open + 1, close) };
}

interface Options {
  entries: Map<string, string>;
}

/** `{slider: 0..100, label: 金额}` → a key/value map. Keys are lowercased;
 *  `key: value` and `key = value` are both accepted. */
function parseOptions(body: string): Options {
  const entries = new Map<string, string>();
  for (const raw of body.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = entry.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*([\s\S]*)$/);
    if (!m) continue;
    entries.set(m[1].toLowerCase(), m[2].trim());
  }
  return { entries };
}

const numberOpt = (opts: Options, key: string): number | null => {
  const raw = opts.entries.get(key);
  return raw !== undefined && isNumeric(raw) ? Number(raw) : null;
};

/* ------------------------------ date & time ------------------------------ */

/** The three picker types, and the literal each one reads and writes. */
export type MomentType = "date" | "time" | "datetime";

const MOMENTS: MomentType[] = ["date", "time", "datetime"];

export const isMoment = (type: FieldType): type is MomentType =>
  (MOMENTS as FieldType[]).includes(type);

/** How each picker's literal should look, for the error message. */
const MOMENT_HINT: Record<MomentType, string> = {
  date: "日期，应形如 2026-01-31",
  time: "时间，应形如 09:30",
  datetime: "日期时间，应形如 2026-01-31T09:30",
};

const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIME_RE = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/;
const DATETIME_RE =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}(?::[0-9]{2})?)$/;

/** `2026-02-30` matches the shape but isn't a day, and Date.parse happily rolls
 *  it over into March — so round-trip the parts and check they survived. */
function isRealDate(s: string): boolean {
  const m = s.match(DATE_RE);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  );
}

function isRealTime(s: string): boolean {
  const m = s.match(TIME_RE);
  if (!m) return false;
  return Number(m[1]) < 24 && Number(m[2]) < 60 && Number(m[3] ?? "0") < 60;
}

/**
 * A date/time literal in the form the native picker wants, or null when it
 * isn't a real moment. Empty is a real answer — a cleared picker reads "" —
 * and `datetime` accepts a space where the note is easier to read that way.
 */
export function normalizeMoment(type: MomentType, raw: InputValue): string | null {
  const s = unquote(String(raw)).trim();
  if (!s) return "";
  if (type === "date") return isRealDate(s) ? s : null;
  if (type === "time") return isRealTime(s) ? s : null;
  const m = s.match(DATETIME_RE);
  if (!m || !isRealDate(m[1]) || !isRealTime(m[2])) return null;
  return `${m[1]}T${m[2]}`;
}

/** `{min: …}` / `{max: …}` for a date/time field: an ISO literal, or null. */
const momentOpt = (
  opts: Options,
  key: string,
  type: MomentType,
): string | null => {
  const raw = opts.entries.get(key);
  if (raw === undefined) return null;
  const out = normalizeMoment(type, raw);
  return out ? out : null;
};

/** `0..2000000` → [0, 2000000]. */
function parseRange(raw: string): [number, number] | null {
  const m = raw.match(/^(-?[0-9.]+)\s*\.\.\s*(-?[0-9.]+)$/);
  if (!m || !isNumeric(m[1]) || !isNumeric(m[2])) return null;
  return [Number(m[1]), Number(m[2])];
}

function inferType(value: InputValue, list: InputValue[] | null): FieldType {
  if (list) return "select";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  return "text";
}

/** Bring a raw value into a field's type; used for defaults and user edits. */
export function coerce(field: InputField, raw: InputValue): InputValue {
  switch (field.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return typeof field.value === "number" ? field.value : 0;
      let out = n;
      if (typeof field.min === "number") out = Math.max(field.min, out);
      if (typeof field.max === "number") out = Math.min(field.max, out);
      return out;
    }
    case "bool":
      return typeof raw === "boolean" ? raw : String(raw).trim() === "true";
    case "select": {
      const hit = field.options.find((o) => String(o) === String(raw));
      return hit !== undefined ? hit : (field.options[0] ?? "");
    }
    case "date":
    case "time":
    case "datetime": {
      // Half-typed dates reach us as "" from the picker, which is fine; only a
      // value that can never be a moment falls back to the note's default.
      const out = normalizeMoment(field.type, raw);
      if (out !== null) return out;
      return typeof field.value === "string" ? field.value : "";
    }
    default:
      return typeof raw === "string" ? raw : String(raw);
  }
}

function parseField(line: string, lineNo: number): InputField | InputParseError {
  const { head, opts: optsBody } = splitOptions(line);
  const opts = parseOptions(optsBody);
  const m = head.match(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z]+)\s*)?(?:=\s*([\s\S]*?)\s*)?$/,
  );
  const fail = (message: string): InputParseError => ({
    line: lineNo,
    text: line.trim(),
    message,
  });
  if (!m) return fail("写法应为「名字: 类型 = 默认值 {选项}」");

  const name = m[1];
  if (!NAME_RE.test(name)) return fail("字段名只能是字母、数字和下划线");

  const declared = m[2]?.toLowerCase() ?? null;
  if (declared && !TYPES.includes(declared as FieldType))
    return fail(`未知类型「${declared}」，可用：${TYPES.join(" / ")}`);

  const rhs = m[3] ?? "";
  const list = parseList(rhs);
  const literal = list ? (list[0] ?? "") : rhs ? parseLiteral(rhs) : "";
  const type = (declared as FieldType | null) ?? inferType(literal, list);

  if (type === "select" && (!list || list.length === 0))
    return fail("select 需要一个选项列表，例如 = [20, 25, 30]");
  if (type === "number" && rhs && !isNumeric(unquote(rhs)))
    return fail(`「${rhs}」不是数字`);
  if (isMoment(type) && rhs && normalizeMoment(type, rhs) === null)
    return fail(`「${rhs}」不是合法的${MOMENT_HINT[type]}`);

  const range = opts.entries.has("slider")
    ? parseRange(opts.entries.get("slider") ?? "")
    : null;
  const asRaw = (opts.entries.get("as") ?? "").toLowerCase();

  const field: InputField = {
    name,
    type,
    label: opts.entries.get("label") || name,
    value: type === "number" ? Number(unquote(rhs) || 0) : literal,
    options: list ?? [],
    min: isMoment(type)
      ? momentOpt(opts, "min", type)
      : range
        ? range[0]
        : numberOpt(opts, "min"),
    max: isMoment(type)
      ? momentOpt(opts, "max", type)
      : range
        ? range[1]
        : numberOpt(opts, "max"),
    step: numberOpt(opts, "step"),
    slider: range !== null || opts.entries.get("slider") === "true",
    unit: opts.entries.get("unit") ?? "",
    as: FORMATS.includes(asRaw as FileFormat) ? (asRaw as FileFormat) : "text",
  };

  // `{default: …}` wins over the literal — it's how a select says which of its
  // options starts out chosen.
  const fallback = opts.entries.get("default");
  if (fallback !== undefined) field.value = coerce(field, parseLiteral(fallback));
  else field.value = coerce(field, field.value);

  return field;
}

const isError = (v: InputField | InputParseError): v is InputParseError =>
  "message" in v;

/** Parse a whole ```input body. Blank lines and `#` comments are skipped. */
export function parseInputBlock(source: string): InputSchema {
  const fields: InputField[] = [];
  const errors: InputParseError[] = [];
  const seen = new Set<string>();
  source.split("\n").forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith("#") || text.startsWith("//")) return;
    const parsed = parseField(line, i + 1);
    if (isError(parsed)) {
      errors.push(parsed);
      return;
    }
    if (seen.has(parsed.name)) {
      errors.push({ line: i + 1, text, message: `字段「${parsed.name}」重复` });
      return;
    }
    seen.add(parsed.name);
    fields.push(parsed);
  });
  return { fields, errors };
}

export const defaultValues = (schema: InputSchema): Record<string, InputValue> =>
  Object.fromEntries(schema.fields.map((f) => [f.name, f.value]));

/** Serialize a value back into the DSL's literal form, for 固化为默认值. */
export function literalOf(field: InputField, value: InputValue): string {
  if (field.type === "number" || field.type === "bool") return String(value);
  if (field.type === "select") return String(value);
  return `"${String(value).replace(/"/g, '\\"')}"`;
}
