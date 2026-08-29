// Results of running fenced code blocks, shown in the dedicated 运行输出 panel.
// Records live in memory only: output routinely contains paths, tokens
// and API responses, and this workspace may be a synced git repo — writing it
// to disk (or into the note) is opt-in, never automatic.
//
// A record is keyed by 文件路径 + 代码哈希 rather than a document position:
// positions shift as the note is edited, while the hash also expresses "the
// code changed, so the old result no longer describes it".

import { create } from "zustand";

import type { OutKind } from "../lib/codeRun/fenceAttrs";
import {
  parseComponentOutput,
  type ComponentResult,
} from "../lib/codeRun/resultProtocol";

export type RunStatus = "running" | "done" | "killed" | "timeout" | "error";

export interface RunSegment {
  stream: "stdout" | "stderr";
  text: string;
}

export interface RunRecord {
  /** Identity of the block, not its place: `${filePath} ${hash(code)}`. */
  key: string;
  runId: number;
  filePath: string;
  lang: string;
  /** The fence's whole info string, attributes included — 重跑 has to run the
   *  block the way it was written, not just its language. */
  info: string;
  /** First non-empty source line, shown in the card header for attribution. */
  firstLine: string;
  /** Rendered command, for the card footer and the first-run confirmation. */
  command: string;
  /** The source that was run — used by 重跑 and to locate the block again. */
  code: string;
  status: RunStatus;
  exitCode: number | null;
  segs: RunSegment[];
  bytes: number;
  truncated: boolean;
  ms: number;
  startedAt: number;
  /** Spawn failure (interpreter not found, …) instead of program output. */
  error: string | null;
  collapsed: boolean;
  /** Snapshot of the ```input values this run was given, or null when the
   *  block has no `in=` binding. A result is only meaningful together with the
   *  parameters that produced it. */
  inputs: Record<string, unknown> | null;
  /** `principal=500000 · rate=3.85`, shown in the card header. */
  inputSummary: string;
  /** The fence's declared `out=`, or null when the result is self-describing. */
  declaredOut: OutKind | null;
  /** Parsed only after a successful run; renderers never consume raw stdout. */
  componentResult: ComponentResult | null;
  protocolError: string | null;
}

/** Cap on retained records across all files; oldest drop out first. */
const MAX_RECORDS = 50;

/** FNV-1a: a stable, synchronous block identity. Not a security hash — a
 *  collision would at worst attach one block's output to another's card. */
export function hashCode(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export const runKey = (filePath: string, code: string) =>
  `${filePath} ${hashCode(code)}`;

interface RunState {
  records: RunRecord[];
  /** Newest first. Re-running the same block replaces its previous record. */
  start: (record: RunRecord) => void;
  append: (runId: number, stream: "stdout" | "stderr", text: string) => void;
  finish: (
    runId: number,
    result: {
      status: RunStatus;
      exitCode: number | null;
      truncated: boolean;
      ms: number;
    },
  ) => void;
  fail: (runId: number, message: string) => void;
  setCollapsed: (runId: number, collapsed: boolean) => void;
  remove: (runId: number) => void;
  /** Drop every record for a file (its tab was closed). */
  clearFile: (filePath: string) => void;
}

const patch = (
  records: RunRecord[],
  runId: number,
  update: (record: RunRecord) => RunRecord,
): RunRecord[] => records.map((r) => (r.runId === runId ? update(r) : r));

export const useRunStore = create<RunState>((set) => ({
  records: [],

  start: (record) =>
    set((s) => ({
      // The new run is the one worth reading, so fold this file's older cards.
      records: [
        record,
        ...s.records
          .filter((r) => r.key !== record.key)
          .map((r) =>
            r.filePath === record.filePath && !r.collapsed
              ? { ...r, collapsed: true }
              : r,
          ),
      ].slice(0, MAX_RECORDS),
    })),

  append: (runId, stream, text) =>
    set((s) => ({
      records: patch(s.records, runId, (r) => {
        // Merge into the tail when it's the same stream, so a chatty program
        // doesn't grow one segment per chunk.
        const last = r.segs[r.segs.length - 1];
        const segs =
          last && last.stream === stream
            ? [...r.segs.slice(0, -1), { stream, text: last.text + text }]
            : [...r.segs, { stream, text }];
        return { ...r, segs, bytes: r.bytes + text.length };
      }),
    })),

  finish: (runId, result) =>
    set((s) => ({
      records: patch(s.records, runId, (r) => {
        const succeeded = result.status === "done" && result.exitCode === 0;
        const stdout = r.segs
          .filter((segment) => segment.stream === "stdout")
          .map((segment) => segment.text)
          .join("");
        const parsed = succeeded
          ? parseComponentOutput(stdout, r.declaredOut)
          : { result: null, error: null };
        const truncatedProtocol =
          result.truncated &&
          (r.declaredOut !== null ||
            parsed.result !== null ||
            parsed.error !== null);
        return {
          ...r,
          status: result.status,
          exitCode: result.exitCode,
          truncated: result.truncated,
          ms: result.ms,
          componentResult: truncatedProtocol ? null : parsed.result,
          protocolError: truncatedProtocol
            ? "输出已截断，无法读取完整组件结果"
            : parsed.error,
        };
      }),
    })),

  fail: (runId, message) =>
    set((s) => ({
      records: patch(s.records, runId, (r) => ({
        ...r,
        status: "error",
        error: message,
        ms: Date.now() - r.startedAt,
      })),
    })),

  setCollapsed: (runId, collapsed) =>
    set((s) => ({
      records: patch(s.records, runId, (r) => ({ ...r, collapsed })),
    })),

  remove: (runId) =>
    set((s) => ({ records: s.records.filter((r) => r.runId !== runId) })),

  clearFile: (filePath) =>
    set((s) => ({ records: s.records.filter((r) => r.filePath !== filePath) })),
}));
