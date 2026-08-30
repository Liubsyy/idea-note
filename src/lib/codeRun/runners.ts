// Runner table for executable fenced code blocks. The config file is owned by
// Rust (app config dir, `code-runners.json` — see `code_runners_load/save`);
// this module is the only place the frontend touches it.
//
// A runner has to fit the execution model in src-tauri/src/code_run.rs: one
// interpreter, invoked once with a single file path, without a TTY and without
// stdin. Compiled languages (two steps) and interactive programs don't fit —
// those go through the integrated terminal instead.

import { invoke } from "@tauri-apps/api/core";
import { isWindows } from "../platform";

export interface CodeRunner {
  /** Canonical language id, matched against a fence's info string. */
  lang: string;
  /** Extra info strings selecting this runner (`py` → python). */
  aliases: string[];
  /** Whether code blocks using this runner can be executed. */
  enabled: boolean;
  /** Interpreter — a bare name resolved through PATH, or an absolute path. */
  command: string;
  /** Arguments placed before the snippet path. */
  args: string[];
  /** Snippet file extension, including the dot. */
  ext: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface CodeRunConfig {
  /** Master switch; off means no code block anywhere shows a run button. */
  enabled: boolean;
  /** Ask for confirmation before every code-block run. */
  confirmEveryRun: boolean;
  /** Base font size of the run-output panel, in pixels. */
  fontSize: number;
  maxOutputKb: number;
  runners: CodeRunner[];
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_KB = 200;
export const CODE_RUN_FONT_SIZE_MIN = 11;
export const CODE_RUN_FONT_SIZE_MAX = 18;
export const DEFAULT_CODE_RUN_FONT_SIZE = 13;

/**
 * Info strings that never get a run button, whatever the config says:
 * `mermaid` is already claimed by the diagram widget, `input` declares a
 * block's parameters (it is data, not code), and `output` is the block we write
 * results into — giving it a button would let results run results.
 */
const HARD_EXCLUDED = new Set(["mermaid", "input", "output"]);

/** Built-in runners. Platform-specific runners start disabled where unavailable. */
export function builtinRunners(): CodeRunner[] {
  return [
    {
      lang: "python",
      aliases: ["py", "python3"],
      enabled: true,
      command: isWindows ? "python" : "python3",
      // -u keeps stdout unbuffered: without it a piped run delivers nothing
      // until the process exits, which defeats the streaming output.
      args: ["-u"],
      ext: ".py",
      env: { PYTHONIOENCODING: "utf-8" },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      lang: "node",
      aliases: ["js", "javascript", "mjs"],
      enabled: true,
      command: "node",
      args: [],
      ext: ".mjs",
      env: {},
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      lang: "ruby",
      aliases: ["rb"],
      enabled: true,
      command: "ruby",
      // Ruby block-buffers stdout when it isn't a tty and offers no `-u`
      // equivalent, so a long-running script's output arrives when it exits.
      // A snippet that needs live output sets `$stdout.sync = true` itself.
      args: [],
      ext: ".rb",
      env: {},
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      lang: "perl",
      aliases: ["pl"],
      enabled: true,
      command: "perl",
      args: [],
      ext: ".pl",
      // Perl has no unbuffered flag either, but dropping the buffered PerlIO
      // layer does the same job as Python's -u.
      env: { PERLIO: ":unix" },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      lang: "bash",
      aliases: ["sh", "shell", "zsh"],
      enabled: true,
      command: "bash",
      args: [],
      ext: ".sh",
      env: {},
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      lang: "powershell",
      aliases: ["ps1", "pwsh"],
      enabled: true,
      command: "powershell",
      // -File must stay last: code_run_start appends the snippet path after
      // these arguments.
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
      ext: ".ps1",
      env: {},
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      // Keep `bat` canonical so the most familiar Markdown fence and the
      // temporary file extension agree. `cmd` is the equivalent Windows
      // batch-script extension/language marker, not a separate interpreter.
      lang: "bat",
      aliases: ["cmd", "batch"],
      enabled: isWindows,
      command: "cmd.exe",
      // /D disables per-user AutoRun commands, keeping note execution
      // deterministic. code_run_start appends the .bat path after /C.
      args: ["/D", "/C"],
      ext: ".bat",
      env: {},
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

export const defaultCodeRunConfig = (): CodeRunConfig => ({
  enabled: true,
  confirmEveryRun: true,
  fontSize: DEFAULT_CODE_RUN_FONT_SIZE,
  maxOutputKb: DEFAULT_MAX_OUTPUT_KB,
  runners: builtinRunners(),
});

const asStringArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null;

const asEnv = (v: unknown): Record<string, string> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
};

/** Merge a stored runner over its built-in defaults; unknown shapes are ignored
 *  field by field, so a hand-edited config file can't break the table. */
function mergeRunner(base: CodeRunner, stored: unknown): CodeRunner {
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Record<string, unknown>;
  return {
    ...base,
    enabled: typeof s.enabled === "boolean" ? s.enabled : base.enabled,
    command: typeof s.command === "string" && s.command.trim() ? s.command : base.command,
    args: asStringArray(s.args) ?? base.args,
    ext: typeof s.ext === "string" && s.ext.startsWith(".") ? s.ext : base.ext,
    env: asEnv(s.env) ?? base.env,
    timeoutMs:
      typeof s.timeoutMs === "number" && s.timeoutMs >= 0 ? s.timeoutMs : base.timeoutMs,
    // Aliases stay owned by the app so an upgrade can extend them.
    aliases: base.aliases,
  };
}

/** A runner the user added by hand (no built-in to merge over). */
function customRunner(stored: unknown): CodeRunner | null {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Record<string, unknown>;
  if (typeof s.lang !== "string" || !s.lang.trim()) return null;
  if (typeof s.command !== "string" || !s.command.trim()) return null;
  const lang = s.lang.trim().toLowerCase();
  if (HARD_EXCLUDED.has(lang)) return null;
  return {
    lang,
    aliases: asStringArray(s.aliases)?.map((a) => a.toLowerCase()) ?? [],
    enabled: typeof s.enabled === "boolean" ? s.enabled : false,
    command: s.command,
    args: asStringArray(s.args) ?? [],
    ext: typeof s.ext === "string" && s.ext.startsWith(".") ? s.ext : ".txt",
    env: asEnv(s.env) ?? {},
    timeoutMs:
      typeof s.timeoutMs === "number" && s.timeoutMs >= 0 ? s.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

function normalize(parsed: unknown): CodeRunConfig {
  const fallback = defaultCodeRunConfig();
  if (!parsed || typeof parsed !== "object") return fallback;
  const p = parsed as Record<string, unknown>;
  const stored = Array.isArray(p.runners) ? p.runners : [];
  const byLang = new Map<string, unknown>();
  for (const entry of stored) {
    const lang = (entry as Record<string, unknown> | null)?.lang;
    if (typeof lang === "string") byLang.set(lang.trim().toLowerCase(), entry);
  }
  // Built-ins first (so a new app version's additions show up), then whatever
  // the user added on top.
  const runners = fallback.runners.map((base) => mergeRunner(base, byLang.get(base.lang)));
  const builtinLangs = new Set(runners.map((r) => r.lang));
  for (const entry of stored) {
    const lang = (entry as Record<string, unknown> | null)?.lang;
    if (typeof lang !== "string" || builtinLangs.has(lang.trim().toLowerCase())) continue;
    const custom = customRunner(entry);
    if (custom) runners.push(custom);
  }
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : fallback.enabled,
    confirmEveryRun:
      typeof p.confirmEveryRun === "boolean"
        ? p.confirmEveryRun
        : fallback.confirmEveryRun,
    fontSize:
      typeof p.fontSize === "number"
        ? Math.min(CODE_RUN_FONT_SIZE_MAX, Math.max(CODE_RUN_FONT_SIZE_MIN, p.fontSize))
        : fallback.fontSize,
    maxOutputKb:
      typeof p.maxOutputKb === "number" && p.maxOutputKb > 0
        ? Math.min(10_000, p.maxOutputKb)
        : fallback.maxOutputKb,
    runners,
  };
}

/** Load the runner config, falling back to the built-in table on any problem. */
export async function loadCodeRunConfig(): Promise<CodeRunConfig> {
  try {
    const raw = await invoke<string>("code_runners_load");
    return normalize(JSON.parse(raw));
  } catch {
    return defaultCodeRunConfig();
  }
}

export async function saveCodeRunConfig(config: CodeRunConfig): Promise<void> {
  await invoke("code_runners_save", { json: JSON.stringify(config, null, 2) });
}

/** The fence's language id, or "" when it has no info string. Attributes are
 *  cut off first, so ```python {out=table} still matches the python runner —
 *  with or without a space before the brace. */
export const fenceLang = (info: string) => {
  const brace = info.indexOf("{");
  const head = brace < 0 ? info : info.slice(0, brace);
  return head.trim().toLowerCase().split(/\s+/)[0] ?? "";
};

/** The runner whose language matches, *ignoring* whether it is enabled. Used by
 *  "在终端运行", which only builds a command line for the user's own shell. */
export function matchRunner(info: string, config: CodeRunConfig): CodeRunner | null {
  const lang = fenceLang(info);
  if (!lang || HARD_EXCLUDED.has(lang)) return null;
  return (
    config.runners.find((r) => r.lang === lang || r.aliases.includes(lang)) ?? null
  );
}

/** The runner for a fence's info string, or null when the block isn't runnable.
 *  Used by the editor to decide whether to draw a run button at all. */
export function resolveRunner(info: string, config: CodeRunConfig): CodeRunner | null {
  if (!config.enabled) return null;
  const runner = matchRunner(info, config);
  return runner?.enabled ? runner : null;
}

/** Shell-family blocks are pasted into the terminal as-is; everything else has
 *  to go through a snippet file, since a shell can't read Python source. */
export const isShellRunner = (runner: CodeRunner) =>
  runner.lang === "bash" || runner.lang === "powershell";

/* -------------------------- user-added runners -------------------------- */

const BUILTIN_LANGS = new Set(builtinRunners().map((r) => r.lang));

/** Whether a language ships with the app. Only the rest can be renamed or removed. */
export const isBuiltinLang = (lang: string) => BUILTIN_LANGS.has(lang);

/** Split a language / alias field into deduplicated lowercase ids. */
const splitIds = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[\s,，]+/)
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

/** Split an argument field. Arguments keep their case. */
export const splitArgs = (value: string) => value.split(/\s+/).filter(Boolean);

/** The settings form's raw fields, before validation. */
export interface RunnerDraft {
  lang: string;
  /** Space- or comma-separated. */
  aliases: string;
  command: string;
  /** Space-separated; the snippet path is appended after these. */
  args: string;
  ext: string;
  enabled: boolean;
  timeoutMs: number;
}

/**
 * Turn the settings form into a runner, or explain why it can't be one.
 *
 * These rules live next to the table they protect: a language id colliding with
 * another runner's id or alias would make `matchRunner` return whichever entry
 * happened to come first, which is not something the user could debug from the
 * settings window.
 *
 * `editing` is the runner being replaced — its own ids don't collide with
 * itself, and its `env` carries over since the form doesn't expose it.
 */
export function parseRunnerDraft(
  draft: RunnerDraft,
  config: CodeRunConfig,
  editing: CodeRunner | null,
): { runner: CodeRunner } | { error: string } {
  const lang = draft.lang.trim().toLowerCase();
  if (!lang) return { error: "请填写语言标识" };
  if (/[\s`]/.test(lang)) return { error: "语言标识不能包含空格或反引号" };
  if (HARD_EXCLUDED.has(lang)) return { error: `${lang} 是保留标识，不能作为运行器` };
  if (isBuiltinLang(lang)) return { error: `${lang} 是内置运行器，请在上面直接修改` };

  const aliases = splitIds(draft.aliases).filter((a) => a !== lang);
  for (const alias of aliases) {
    if (HARD_EXCLUDED.has(alias)) return { error: `${alias} 是保留标识，不能作为别名` };
  }

  // Every id this runner would answer to, checked against every other runner's.
  const taken = new Map<string, string>();
  for (const r of config.runners) {
    if (editing && r.lang === editing.lang) continue;
    for (const id of [r.lang, ...r.aliases]) taken.set(id, r.lang);
  }
  for (const id of [lang, ...aliases]) {
    const owner = taken.get(id);
    if (owner) return { error: `${id} 已被运行器「${owner}」占用` };
  }

  const command = draft.command.trim();
  if (!command) return { error: "请填写命令" };

  const raw = draft.ext.trim();
  const ext = !raw || raw.startsWith(".") ? raw : `.${raw}`;
  if (!ext || ext === ".") return { error: "请填写代码文件扩展名，例如 .rb" };
  if (/[\s/\\]/.test(ext)) return { error: "扩展名不能包含空格或路径分隔符" };

  return {
    runner: {
      lang,
      aliases,
      enabled: draft.enabled,
      command,
      args: splitArgs(draft.args),
      ext,
      env: editing?.env ?? {},
      timeoutMs: draft.timeoutMs,
    },
  };
}
