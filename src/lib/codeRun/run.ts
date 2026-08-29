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
  fenceLang,
  isShellRunner,
  matchRunner,
  resolveRunner,
  type CodeRunner,
} from "./runners";
import type { DeclaredOut } from "./resultProtocol";

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
  /** Extra environment for this run, layered over the runner's own — this is
   *  how an ```input block's values reach the script. */
  env?: Record<string, string>;
  /** The same values as data, snapshotted into the record. */
  inputs?: Record<string, unknown> | null;
  /** One-line rendering of those values for the card header. */
  inputSummary?: string;
  /** Explicit `out=` type, `"auto"` when the script names the type at run
   *  time, or null for a bare fence. */
  declaredOut?: DeclaredOut | null;
  /** Whether to pop the run-output panel open. A block whose result renders in
   *  the note has somewhere to show already; opening a panel on top of it (on
   *  every slider move, for a `watch` block) would be noise. */
  reveal?: boolean;
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

/**
 * Whether the user has allowed blocks to run on their own — after a control
 * moved, or when a note is opened.
 *
 * In memory, for this session only, and never written to disk: reopening the
 * app asks again, and a note with automatic triggers that arrives through a git
 * sync is inert until its reader says otherwise.
 */
let autoGranted = false;

/**
 * Run a block that a trigger asked for rather than a click on 运行.
 *
 * A trigger fires repeatedly — every drag of a slider, every time a dashboard
 * note is opened — so the 二次确认 setting is honoured differently here: it asks
 * the first time this session and then stays out of the way. Clicking 运行 keeps
 * asking every time, exactly as before.
 */
/**
 * Auto-runs held back while the permission dialog is up.
 *
 * A note can open with several `run=open` blocks at once. Each would raise its
 * own dialog, and since the store holds one confirmation at a time, the last
 * would replace the rest — the reader answers once and only one block runs.
 * Queueing them behind the single question is what makes "允许" mean "run this
 * note's blocks", which is what it appears to say.
 */
const pendingAuto: { runner: CodeRunner; args: StartRunArgs }[] = [];
let askingAuto = false;

/** Forget the queue if the dialog goes away unanswered: those runs belong to
 *  that moment, not to whenever the reader next allows something. */
function watchDismissal(): void {
  const stop = useAppStore.subscribe((state, previous) => {
    if (previous.confirm === null || state.confirm !== null) return;
    stop();
    askingAuto = false;
    if (!autoGranted) pendingAuto.length = 0;
  });
}

export async function startAutoRun(args: StartRunArgs): Promise<void> {
  const app = useAppStore.getState();
  const runner = resolveRunner(args.info, app.codeRunConfig);
  if (!runner) return;
  if (autoGranted || !app.codeRunConfig.confirmEveryRun) {
    await launch(runner, args);
    return;
  }
  pendingAuto.push({ runner, args });
  if (askingAuto) return; // one question covers the whole batch
  askingAuto = true;
  watchDismissal();
  useAppStore.setState({
    confirm: {
      title: "自动运行",
      message: "允许代码块按笔记里写的触发条件自动运行？本次会话内不再询问。",
      hint: {
        before: "可在",
        actionLabel: "设置",
        after: "中关闭运行前二次确认",
        onAction: () => app.openSettings("coderun"),
      },
      placement: "editor-center",
      confirmLabel: "允许",
      tone: "primary",
      onConfirm: () => {
        autoGranted = true;
        askingAuto = false;
        const queued = pendingAuto.splice(0, pendingAuto.length);
        for (const item of queued) void launch(item.runner, item.args);
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

  if (args.reveal !== false) revealRunPanel();
  useRunStore.getState().start({
    key,
    runId,
    filePath,
    lang: fenceLang(args.info) || runner.lang,
    info: args.info,
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
    inputs: args.inputs ?? null,
    inputSummary: args.inputSummary ?? "",
    declaredOut: args.declaredOut ?? null,
    componentResult: null,
    protocolError: null,
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
      env: { ...runner.env, ...(args.env ?? {}) },
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
