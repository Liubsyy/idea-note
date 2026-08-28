// Driving one code-block run: confirm, spawn, stream, finish.
//
// The backend (src-tauri/src/code_run.rs) streams `code:data:{id}` events as
// fast as the child writes. Pushing every one of them straight into the store
// would re-render the output panel hundreds of times a second, so chunks are
// buffered here and flushed on a fixed interval.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useAppStore } from "../../store/useAppStore";
import {
  runKey,
  useRunStore,
  type RunSegment,
  type RunStatus,
} from "../../store/useRunStore";
import { dirname } from "../fs";
import {
  isShellRunner,
  matchRunner,
  resolveRunner,
  type CodeRunner,
} from "./runners";

/** How often buffered output is handed to the store. */
const FLUSH_MS = 50;

interface DataPayload {
  stream: "stdout" | "stderr";
  text: string;
}

interface ExitPayload {
  code: number | null;
  timedOut: boolean;
  killed: boolean;
  truncated: boolean;
  ms: number;
}

interface LiveRun {
  pending: RunSegment[];
  timer: ReturnType<typeof setInterval> | null;
  unlisten: UnlistenFn[];
}

const live = new Map<number, LiveRun>();
let nextRunId = 1;

/** The command shown in the run record footer. */
const commandLabel = (runner: CodeRunner) =>
  [runner.command, ...runner.args, `snippet${runner.ext}`].join(" ");

const firstLineOf = (code: string) =>
  code.split("\n").find((l) => l.trim())?.trim().slice(0, 120) ?? "";

function flush(runId: number): void {
  const state = live.get(runId);
  if (!state || state.pending.length === 0) return;
  const pending = state.pending;
  state.pending = [];
  const append = useRunStore.getState().append;
  for (const seg of pending) append(runId, seg.stream, seg.text);
}

function cleanup(runId: number): void {
  const state = live.get(runId);
  if (!state) return;
  if (state.timer !== null) clearInterval(state.timer);
  for (const un of state.unlisten) un();
  live.delete(runId);
}

/** Bring the run output into view; a click that seems to do nothing is worse
 *  than one that opens a panel the user didn't ask for. */
function revealRunPanel(): void {
  const app = useAppStore.getState();
  if (!app.runPanelOpen) app.toggleRunPanel();
}

export interface StartRunArgs {
  /** Absolute path of the note, or null for an unsaved draft. */
  filePath: string | null;
  /** The fence's info string (`python`, `js`, …). */
  info: string;
  code: string;
}

/** Run a code block, asking every time unless the user disables confirmation. */
export async function startRun(args: StartRunArgs): Promise<void> {
  const app = useAppStore.getState();
  const runner = resolveRunner(args.info, app.codeRunConfig);
  if (!runner) return;

  if (!app.codeRunConfig.confirmEveryRun) {
    await launch(runner, args);
    return;
  }
  useAppStore.setState({
    confirm: {
      title: "运行代码块",
      message: "是否确定运行此代码块？",
      hint: {
        before: "可在",
        actionLabel: "设置",
        after: "中关闭当前二次确认",
        onAction: () => app.openSettings("coderun"),
      },
      placement: "editor-center",
      confirmLabel: "确定",
      tone: "primary",
      onConfirm: () => {
        void launch(runner, args);
      },
    },
  });
}

async function launch(runner: CodeRunner, args: StartRunArgs): Promise<void> {
  const app = useAppStore.getState();
  const filePath = args.filePath ?? "";
  const runId = nextRunId++;
  const cwd = filePath ? dirname(filePath) : app.workspacePath;
  const key = runKey(filePath, args.code);

  // Re-running a block replaces its record, so kill the process that record
  // belonged to — otherwise it keeps running with nowhere to report.
  const previous = useRunStore
    .getState()
    .records.find((r) => r.key === key && r.status === "running");
  if (previous) stopRun(previous.runId);

  revealRunPanel();
  useRunStore.getState().start({
    key,
    runId,
    filePath,
    lang: args.info.trim().split(/\s+/)[0] ?? runner.lang,
    firstLine: firstLineOf(args.code),
    command: commandLabel(runner),
    code: args.code,
    status: "running",
    exitCode: null,
    segs: [],
    bytes: 0,
    truncated: false,
    ms: 0,
    startedAt: Date.now(),
    error: null,
    collapsed: false,
  });

  const state: LiveRun = { pending: [], timer: null, unlisten: [] };
  live.set(runId, state);

  // Listeners must be in place before the command starts, or a program that
  // prints and exits immediately can beat them to it.
  state.unlisten.push(
    await listen<DataPayload>(`code:data:${runId}`, ({ payload }) => {
      const last = state.pending[state.pending.length - 1];
      if (last && last.stream === payload.stream) last.text += payload.text;
      else state.pending.push({ stream: payload.stream, text: payload.text });
    }),
  );
  state.unlisten.push(
    await listen<ExitPayload>(`code:exit:${runId}`, ({ payload }) => {
      flush(runId);
      const status: RunStatus = payload.timedOut
        ? "timeout"
        : payload.killed
          ? "killed"
          : "done";
      useRunStore.getState().finish(runId, {
        status,
        exitCode: payload.code,
        truncated: payload.truncated,
        ms: payload.ms,
      });
      cleanup(runId);
    }),
  );
  state.timer = setInterval(() => flush(runId), FLUSH_MS);

  try {
    await invoke("code_run_start", {
      id: runId,
      command: runner.command,
      args: runner.args,
      ext: runner.ext,
      code: args.code,
      cwd,
      env: runner.env,
      timeoutMs: runner.timeoutMs,
      maxBytes: app.codeRunConfig.maxOutputKb * 1024,
    });
  } catch (e) {
    useRunStore.getState().fail(runId, String(e));
    cleanup(runId);
  }
}

export function stopRun(runId: number): void {
  void invoke("code_run_stop", { id: runId }).catch(() => {});
}

/** Wrap a path for the shell only when it needs it. */
const quote = (value: string) => (/[\s"']/.test(value) ? `"${value}"` : value);

/**
 * Send a code block to the integrated terminal instead of running it here.
 *
 * This is the escape hatch for everything the run pipeline deliberately can't
 * do: stdin, a real TTY, long-lived servers, sudo. Shell blocks are pasted
 * as-is; other languages get written to a snippet file and invoked by path,
 * because a shell can't be fed Python source.
 */
export async function runInTerminal(info: string, code: string): Promise<void> {
  const app = useAppStore.getState();
  const runner = matchRunner(info, app.codeRunConfig);
  if (!runner || isShellRunner(runner)) {
    app.sendToTerminal(code.endsWith("\n") ? code : `${code}\n`);
    return;
  }
  try {
    const path = await invoke<string>("code_run_snippet_path", {
      ext: runner.ext,
      code,
    });
    const parts = [runner.command, ...runner.args, path].map(quote);
    app.sendToTerminal(`${parts.join(" ")}\n`);
  } catch (e) {
    app.showToast(`无法写入临时文件：${e}`, "error");
  }
}
