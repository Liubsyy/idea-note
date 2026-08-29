// Turning a block's `in=…` binding into something a script can read.
//
// Three channels, all filled at once, because no single one covers every case:
//   - one environment variable per field  → `os.environ["principal"]`, zero deps
//   - IDEA_NOTE_INPUT                     → the whole thing as JSON, typed
//   - `<name>_path` for file fields       → let the script read big data itself
//
// The backend already forwards a per-run env map (code_run.rs), so nothing on
// the Rust side had to change to make this work.

import type { Text } from "@codemirror/state";

import type { InputBinding } from "../codeRun/fenceAttrs";
import { findInputBlock, findTable, loadFile } from "./sources";
import { inputKey, valuesFor } from "../../store/useInputStore";
import type { InputValue } from "./schema";

export interface CollectedInputs {
  env: Record<string, string>;
  /** The same values as structured data — snapshotted into the run record. */
  inputs: Record<string, unknown>;
  /** `principal=500000 · rate=3.85`, for the run card header. */
  summary: string;
  /** Store key of the ```input block behind these values, for `watch`. */
  sourceKey: string | null;
}

export type CollectResult = { ok: CollectedInputs } | { error: string };

/**
 * Cap on the JSON payload handed over as an environment variable. Windows
 * limits both a single variable and the whole block; past this the payload
 * keeps the paths and drops the bulky file contents, which is exactly what the
 * `<name>_path` channel is for.
 */
const MAX_PAYLOAD = 32 * 1024;

const summarize = (values: Record<string, unknown>): string => {
  const parts = Object.entries(values)
    .filter(([, v]) => typeof v !== "object")
    .map(([k, v]) => `${k}=${String(v)}`);
  const text = parts.join(" · ");
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
};

function payload(inputs: Record<string, unknown>): string {
  const json = JSON.stringify(inputs);
  if (json.length <= MAX_PAYLOAD) return json;
  // Too big: keep the scalars and tell the script where the data actually is.
  const slim: Record<string, unknown> = { _truncated: true };
  for (const [key, value] of Object.entries(inputs)) {
    if (value === null || typeof value !== "object") slim[key] = value;
  }
  return JSON.stringify(slim);
}

const finish = (
  inputs: Record<string, unknown>,
  env: Record<string, string>,
  sourceKey: string | null,
): CollectResult => {
  env.IDEA_NOTE_INPUT = payload(inputs);
  return { ok: { env, inputs, summary: summarize(inputs), sourceKey } };
};

/** Resolve a block's `in=…` against the document and the input store. */
export async function collectInputs(
  doc: Text,
  binding: InputBinding,
  filePath: string,
  workspacePath: string | null,
): Promise<CollectResult> {
  if (binding.kind === "block") {
    const block = findInputBlock(doc, binding.name);
    if (!block) return { error: `找不到 input 块「${binding.name}」` };
    const key = inputKey(filePath, block.id);
    const values = valuesFor(key, block.schema);
    const inputs: Record<string, unknown> = {};
    const env: Record<string, string> = {};

    for (const field of block.schema.fields) {
      const value: InputValue = values[field.name];
      if (field.type === "file") {
        const load = await loadFile(
          filePath || null,
          String(value),
          field.as,
          workspacePath,
        );
        if (!load.ok) return { error: `字段「${field.name}」：${load.error}` };
        inputs[field.name] = load.path;
        inputs[`${field.name}_data`] = load.data;
        env[field.name] = load.path;
        env[`${field.name}_path`] = load.path;
        continue;
      }
      inputs[field.name] = value;
      env[field.name] = String(value);
    }
    return finish(inputs, env, key);
  }

  if (binding.kind === "table") {
    const table = findTable(doc, binding.name);
    if (!table) return { error: `找不到名为「${binding.name}」的表格` };
    const rows = table.rows.map((r) =>
      Object.fromEntries(table.columns.map((c, i) => [c, r[i] ?? ""])),
    );
    return finish(
      { columns: table.columns, rows, table: rows },
      { table_rows: String(rows.length) },
      null,
    );
  }

  const load = await loadFile(
    filePath || null,
    binding.name,
    /\.csv$/i.test(binding.name) ? "csv" : /\.json$/i.test(binding.name) ? "json" : "text",
    workspacePath,
  );
  if (!load.ok) return { error: load.error };
  return finish({ path: load.path, data: load.data }, { file_path: load.path }, null);
}
