// AI chat sessions for the right-hand panel. Each session has its own model,
// tool-confirmation mode, display timeline (`items`) and API history (`history`).
// Orchestration of the tool-calling loop — including approval flows — lives in
// `sendMessage` here, keeping `src/lib/ai/client.ts` provider-agnostic and
// unaware of the editor/UI.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./useAppStore";
import { basename } from "../lib/fs";
import type { ChatMsg, ThinkingLevel, ToolCall } from "../lib/ai/types";
import { runChat } from "../lib/ai/client";
import { firstModelSelection, resolveModelSelection } from "../lib/ai/modelSelection";
import {
  TOOL_DEFS,
  isEditTool,
  readOpenFile,
  readWorkspaceFile,
  prepareEdit,
  applyContent,
  createNote,
  prepareDelete,
  runSearch,
  type DiffView,
} from "../lib/ai/tools";

export type ToolMode = "ask" | "ask_all" | "auto";
export type { ThinkingLevel };

export type ToolStatus =
  | "running"
  | "done"
  | "pending"
  | "applied"
  | "rejected"
  | "undone"
  | "error";

/** One entry in a session's visible timeline. */
export type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | {
      id: string;
      kind: "tool";
      tool: "read" | "edit" | "create" | "delete" | "search";
      status: ToolStatus;
      summary: string;
      diff?: DiffView;
      error?: string;
    }
  | { id: string; kind: "error"; text: string };

export interface ChatSession {
  id: string;
  title: string;
  /** References an AiModel selection key; legacy persisted values may be AiModel.id. */
  modelId: string | null;
  mode: ToolMode;
  thinkingLevel: ThinkingLevel;
  /** Whether the system prompt tells the model about the currently open file. */
  useOpenFile: boolean;
  /** Closed tabs stay in history (archived) until deleted from there. */
  archived: boolean;
  /** Visible timeline (bubbles + tool cards). */
  items: ChatItem[];
  /** Normalized conversation sent to the model (multi-turn). */
  history: ChatMsg[];
}

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  sendingSessionIds: string[];
  /** True once sessions have been loaded from the Rust backend (async). */
  hydrated: boolean;

  ensureSession: () => void;
  newSession: () => void;
  /** Archive a tab: it disappears from the tab bar but stays in history. */
  closeSession: (id: string) => void;
  /** Reopen a session from history as the active tab. */
  openSession: (id: string) => void;
  /** Permanently remove a session (history's delete button). */
  deleteSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  setSessionModel: (id: string, modelId: string | null) => void;
  setSessionMode: (id: string, mode: ToolMode) => void;
  setSessionThinkingLevel: (id: string, level: ThinkingLevel) => void;
  setSessionUseOpenFile: (id: string, use: boolean) => void;
  renameSession: (id: string, title: string) => void;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  /** Force-stop one session's in-flight assistant turn. */
  stopSending: (sessionId: string) => void;
  /** Resolve a pending tool approval from a card button. */
  resolvePendingEdit: (itemId: string, approved: boolean) => void;
  /** Revert an applied edit back to its pre-edit content (auto-mode card). */
  undoEdit: (itemId: string) => void;
}

// Sessions now live as Rust-owned files in the app config dir:
// ai-sessions-index.json plus one ai-sessions/<session-id>.json per session.
// This key is only read once for a one-time migration of any pre-existing blob.
const LEGACY_STORAGE_KEY = "idea-note:ai-sessions";

// Transient, not persisted: resolvers for in-flight approvals and pre-edit
// snapshots backing the "undo" button. Lost on reload (by design).
const pendingApprovals = new Map<string, { sessionId: string; resolve: (approved: boolean) => void }>();
const undoSnapshots = new Map<string, string>();
// Aborts are per session so multiple sessions can stream in parallel.
const currentAborts = new Map<string, AbortController>();

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function buildSystemPrompt(filePath: string | null, workspacePath: string | null): string {
  const lines = ["你是 Idea Note（一款 Markdown 笔记应用）的 AI 笔记助手，请用中文回答。"];
  if (filePath) {
    lines.push(
      `用户当前打开的文件是：${filePath}`,
      "你可以用工具读取和编辑这个打开的文件：用户说“当前文件”“这篇”“打开的文件”时调用 read_open_file；做局部修改时优先用 edit_open_file（精确字符串替换）；需要大段重写时用 write_open_file。",
      "你的修改只会写入编辑器缓冲区，是否保存由用户决定，因此可以放心修改。",
    );
  } else {
    lines.push(
      "用户没有附加当前打开的文件。不要主动调用工具读取或修改打开的文件；仅当用户在消息中明确要求读取或修改文件时，才使用 read_open_file / edit_open_file / write_open_file。",
    );
  }
  if (workspacePath) {
    lines.push(
      `用户当前的笔记工作区是：${workspacePath}`,
      "你还可以管理工作区中的笔记：用户明确提到某个文件名或路径并要求读取时，调用 read_file 读取该指定文件，不要用 read_open_file 代替；用户要新建笔记时调用 create_note；要查找笔记时调用 search_notes（按关键词匹配文件名和内容）；要删除文件或文件夹时调用 delete_file（应用会向用户弹出确认卡片，批准后才真正删除）。",
      "读取或删除前如果不确定具体路径，先用 search_notes 找到目标文件；这些工具中的路径均使用相对工作区根目录的路径。",
    );
  } else {
    lines.push(
      "用户当前没有打开笔记工作区，无法新建、搜索或删除笔记；如果用户需要这些功能，请提醒他先打开一个笔记文件夹。",
    );
  }
  return lines.join("\n");
}

function sanitize(s: any): ChatSession {
  const items: ChatItem[] = Array.isArray(s?.items)
    ? s.items.map((it: any) =>
        it?.kind === "tool" && (it.status === "running" || it.status === "pending")
          ? { ...it, status: "error", error: it.error ?? "已中断" }
          : it,
      )
    : [];
  return {
    id: typeof s?.id === "string" ? s.id : uid(),
    title: typeof s?.title === "string" ? s.title : "新会话",
    modelId: typeof s?.modelId === "string" ? s.modelId : null,
    mode: s?.mode === "auto" || s?.mode === "ask_all" ? s.mode : "ask",
    thinkingLevel: isThinkingLevel(s?.thinkingLevel) ? s.thinkingLevel : "medium",
    useOpenFile: s?.useOpenFile !== false,
    archived: s?.archived === true,
    items,
    history: Array.isArray(s?.history) ? s.history : [],
  };
}

type Persisted = { sessions: ChatSession[]; activeSessionId: string | null };

function hasSessionContent(session: ChatSession): boolean {
  return session.items.length > 0 || session.history.length > 0;
}

function persistedSessions(sessions: ChatSession[]): ChatSession[] {
  return sessions.filter(hasSessionContent);
}

function persistedActiveSessionId(
  sessions: ChatSession[],
  activeSessionId: string | null,
): string | null {
  const persisted = persistedSessions(sessions);
  if (activeSessionId && persisted.some((s) => s.id === activeSessionId)) return activeSessionId;
  return persisted.find((s) => !s.archived)?.id ?? persisted[0]?.id ?? null;
}

function parsePersisted(raw: string | null): Persisted {
  try {
    if (!raw) return { sessions: [], activeSessionId: null };
    const parsed = JSON.parse(raw);
    const sessions: ChatSession[] = Array.isArray(parsed?.sessions)
      ? parsed.sessions.map(sanitize)
      : [];
    const active =
      typeof parsed?.activeSessionId === "string" &&
      sessions.some((s) => s.id === parsed.activeSessionId && !s.archived)
        ? parsed.activeSessionId
        : sessions.find((s) => !s.archived)?.id ?? null;
    return { sessions, activeSessionId: active };
  } catch {
    return { sessions: [], activeSessionId: null };
  }
}

// Load from the backend file; on first run import any legacy localStorage blob
// and clear it once the backend has accepted the copy.
async function loadPersisted(): Promise<Persisted> {
  let raw: string | null = null;
  try {
    const loaded = await invoke<string>("chat_sessions_load");
    if (loaded && loaded !== "null") raw = loaded;
  } catch {
    /* backend unavailable — fall through to legacy / empty */
  }
  if (!raw) {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      raw = legacy;
      try {
        await invoke("chat_sessions_save", { json: legacy });
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        /* keep the legacy blob until a save succeeds */
      }
    }
  }
  return parsePersisted(raw);
}

// Fire-and-forget writes. Session content is saved independently so parallel
// streams from different sessions do not overwrite each other's files.
function persistIndex(
  sessions: ChatSession[],
  activeSessionId: string | null,
  forceEmpty = false,
) {
  const persisted = persistedSessions(sessions);
  if (persisted.length === 0 && !forceEmpty) return;
  void invoke("chat_sessions_index_save", {
    json: JSON.stringify({
      sessionIds: persisted.map((s) => s.id),
      activeSessionId: persistedActiveSessionId(sessions, activeSessionId),
    }),
  }).catch(() => {});
}

function persistSession(session: ChatSession) {
  if (!hasSessionContent(session)) {
    deletePersistedSession(session.id);
    return;
  }
  void invoke("chat_session_save", {
    id: session.id,
    json: JSON.stringify(session),
  }).catch(() => {});
}

function deletePersistedSession(id: string) {
  void invoke("chat_session_delete", { id }).catch(() => {});
}

export const useChatStore = create<ChatState>((set, get) => {
  const updateSession = (id: string, fn: (s: ChatSession) => ChatSession) => {
    let updated: ChatSession | null = null;
    const sessions = get().sessions.map((s) => {
      if (s.id !== id) return s;
      updated = fn(s);
      return updated;
    });
    set({ sessions });
    if (updated) {
      persistSession(updated);
      persistIndex(sessions, get().activeSessionId);
    }
  };
  const appendItem = (id: string, item: ChatItem) =>
    updateSession(id, (s) => ({ ...s, items: [...s.items, item] }));
  // Streaming hot path: append a text delta to one item without persisting —
  // disk writes on every SSE chunk would be wasteful. The final state is
  // persisted by onTextDone / sendMessage's finally block.
  const appendItemText = (sessionId: string, itemId: string, delta: string) =>
    set({
      sessions: get().sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              items: s.items.map((it) =>
                it.id === itemId && it.kind === "assistant" ? { ...it, text: it.text + delta } : it,
              ),
            }
          : s,
      ),
    });
  const patchItem = (itemId: string, patch: Partial<Extract<ChatItem, { kind: "tool" }>>) => {
    let updated: ChatSession | null = null;
    const sessions = get().sessions.map((s) => ({
      ...s,
      items: s.items.map((it) => {
        if (it.id !== itemId) return it;
        const next = { ...it, ...patch } as ChatItem;
        updated = { ...s, items: s.items.map((inner) => (inner.id === itemId ? next : inner)) };
        return next;
      }),
    }));
    set({ sessions });
    if (updated) persistSession(updated);
  };

  /** Execute one tool call against the editor, honoring the session's mode. */
  const runToolCall = async (sessionId: string, call: ToolCall): Promise<string> => {
    const mode = get().sessions.find((s) => s.id === sessionId)?.mode ?? "ask";
    const shouldConfirmEveryTool = mode === "ask_all";

    const waitForApproval = async (itemId: string) => {
      const approved = await new Promise<boolean>((resolve) =>
        pendingApprovals.set(itemId, { sessionId, resolve }),
      );
      pendingApprovals.delete(itemId);
      return approved;
    };

    if (call.name === "read_open_file") {
      const itemId = uid();
      appendItem(sessionId, {
        id: itemId,
        kind: "tool",
        tool: "read",
        status: shouldConfirmEveryTool ? "pending" : "running",
        summary: "读取文件",
      });
      if (shouldConfirmEveryTool && !(await waitForApproval(itemId))) {
        patchItem(itemId, { status: "rejected" });
        return "用户拒绝了读取当前文件。";
      }
      if (shouldConfirmEveryTool) patchItem(itemId, { status: "running" });
      const r = readOpenFile();
      patchItem(itemId, {
        status: r.ok ? "done" : "error",
        summary: r.ok ? basename(r.path!) : "读取文件",
        error: r.ok ? undefined : r.error,
      });
      return r.ok ? JSON.stringify({ path: r.path, content: r.content }) : `错误：${r.error}`;
    }

    if (call.name === "read_file") {
      const itemId = uid();
      const path = typeof call.args.path === "string" ? call.args.path.trim() : "";
      appendItem(sessionId, {
        id: itemId,
        kind: "tool",
        tool: "read",
        status: shouldConfirmEveryTool ? "pending" : "running",
        summary: path || "读取文件",
      });
      if (shouldConfirmEveryTool && !(await waitForApproval(itemId))) {
        patchItem(itemId, { status: "rejected" });
        return `用户拒绝了读取文件：${path || "未指定路径"}`;
      }
      if (shouldConfirmEveryTool) patchItem(itemId, { status: "running" });
      const r = await readWorkspaceFile(call.args);
      patchItem(itemId, {
        status: r.ok ? "done" : "error",
        summary: r.ok ? basename(r.path!) : path || "读取文件",
        error: r.ok ? undefined : r.error,
      });
      return r.ok ? JSON.stringify({ path: r.path, content: r.content }) : `错误：${r.error}`;
    }

    if (call.name === "create_note") {
      const itemId = uid();
      appendItem(sessionId, {
        id: itemId,
        kind: "tool",
        tool: "create",
        status: shouldConfirmEveryTool ? "pending" : "running",
        summary: "新建笔记",
      });
      if (shouldConfirmEveryTool && !(await waitForApproval(itemId))) {
        patchItem(itemId, { status: "rejected" });
        return "用户拒绝了新建笔记。";
      }
      if (shouldConfirmEveryTool) patchItem(itemId, { status: "running" });
      const r = await createNote(call.args);
      patchItem(itemId, {
        status: r.ok ? "done" : "error",
        summary: r.ok ? r.name : "新建笔记",
        error: r.ok ? undefined : r.error,
      });
      return r.ok ? `已创建并打开笔记：${r.path}` : `错误：${r.error}`;
    }

    if (call.name === "search_notes") {
      const itemId = uid();
      const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
      appendItem(sessionId, {
        id: itemId,
        kind: "tool",
        tool: "search",
        status: shouldConfirmEveryTool ? "pending" : "running",
        summary: `“${query}”`,
      });
      if (shouldConfirmEveryTool && !(await waitForApproval(itemId))) {
        patchItem(itemId, { status: "rejected" });
        return `用户拒绝了搜索：${query}`;
      }
      if (shouldConfirmEveryTool) patchItem(itemId, { status: "running" });
      const r = await runSearch(call.args);
      patchItem(itemId, {
        status: r.ok ? "done" : "error",
        summary: r.ok ? `“${query}”（${r.hits.length} 条结果）` : `“${query}”`,
        error: r.ok ? undefined : r.error,
      });
      return r.ok ? JSON.stringify({ query, hits: r.hits }) : `错误：${r.error}`;
    }

    if (call.name === "delete_file") {
      const itemId = uid();
      const prep = prepareDelete(call.args);
      if (!prep.ok) {
        appendItem(sessionId, {
          id: itemId,
          kind: "tool",
          tool: "delete",
          status: "error",
          summary: "删除文件",
          error: prep.error,
        });
        return `错误：${prep.error}`;
      }

      // Destructive: always ask, even in auto mode.
      appendItem(sessionId, {
        id: itemId,
        kind: "tool",
        tool: "delete",
        status: "pending",
        summary: prep.isDir ? `${prep.name}（文件夹）` : prep.name,
      });
      const approved = await waitForApproval(itemId);
      if (!approved) {
        patchItem(itemId, { status: "rejected" });
        return "用户拒绝了删除。";
      }
      try {
        await useAppStore.getState().removeNow(prep.path);
        patchItem(itemId, { status: "applied" });
        return `用户已确认，已删除：${prep.path}`;
      } catch (e: any) {
        const error = typeof e === "string" ? e : e?.message ?? "删除失败";
        patchItem(itemId, { status: "error", error });
        return `错误：${error}`;
      }
    }

    if (isEditTool(call.name)) {
      const itemId = uid();
      const prep = prepareEdit(call.name, call.args);
      if (!prep.ok) {
        appendItem(sessionId, {
          id: itemId,
          kind: "tool",
          tool: "edit",
          status: "error",
          summary: "编辑文件",
          error: prep.error,
        });
        return `错误：${prep.error}`;
      }

      if (mode === "auto") {
        appendItem(sessionId, {
          id: itemId,
          kind: "tool",
          tool: "edit",
          status: "applied",
          summary: prep.summary,
          diff: prep.diff,
        });
        applyContent(prep.after);
        undoSnapshots.set(itemId, prep.before);
        return "已应用修改。";
      }

      // ask / ask_all modes: show the diff and wait for the user's decision.
      appendItem(sessionId, {
        id: itemId,
        kind: "tool",
        tool: "edit",
        status: "pending",
        summary: prep.summary,
        diff: prep.diff,
      });
      const approved = await waitForApproval(itemId);
      if (approved) {
        applyContent(prep.after);
        undoSnapshots.set(itemId, prep.before);
        patchItem(itemId, { status: "applied" });
        return "用户已批准并应用了修改。";
      }
      patchItem(itemId, { status: "rejected" });
      return "用户拒绝了此修改。";
    }

    appendItem(sessionId, { id: uid(), kind: "error", text: `未知工具：${call.name}` });
    return `错误：未知工具 ${call.name}`;
  };

  return {
    sessions: [],
    activeSessionId: null,
    sendingSessionIds: [],
    hydrated: false,

    ensureSession: () => {
      if (!get().sessions.some((s) => !s.archived)) get().newSession();
    },

    newSession: () => {
      const models = useAppStore.getState().aiModels;
      const sessionsBefore = get().sessions;
      const activeId = get().activeSessionId;
      const openSessions = sessionsBefore.filter((s) => !s.archived);
      const previous =
        sessionsBefore.find((s) => s.id === activeId) ??
        openSessions[openSessions.length - 1] ??
        sessionsBefore[sessionsBefore.length - 1];
      const session: ChatSession = {
        id: uid(),
        title: "新会话",
        modelId: previous?.modelId ?? firstModelSelection(models),
        mode: previous?.mode ?? "ask",
        thinkingLevel: previous?.thinkingLevel ?? "medium",
        useOpenFile: true,
        archived: false,
        items: [],
        history: [],
      };
      const sessions = [...sessionsBefore, session];
      set({ sessions, activeSessionId: session.id });
    },

    closeSession: (id) => {
      const target = get().sessions.find((s) => s.id === id);
      if (target && !hasSessionContent(target)) {
        const sessions = get().sessions.filter((s) => s.id !== id);
        let active = get().activeSessionId;
        if (active === id) {
          const open = sessions.filter((s) => !s.archived);
          active = open[open.length - 1]?.id ?? null;
        }
        set({ sessions, activeSessionId: active });
        deletePersistedSession(id);
        persistIndex(sessions, active, true);
        return;
      }

      const sessions = get().sessions.map((s) => (s.id === id ? { ...s, archived: true } : s));
      let active = get().activeSessionId;
      if (active === id) {
        const open = sessions.filter((s) => !s.archived);
        active = open[open.length - 1]?.id ?? null;
      }
      set({ sessions, activeSessionId: active });
      const closed = sessions.find((s) => s.id === id);
      if (closed) persistSession(closed);
      persistIndex(sessions, active);
    },

    openSession: (id) => {
      const sessions = get().sessions.map((s) => (s.id === id ? { ...s, archived: false } : s));
      set({ sessions, activeSessionId: id });
      const opened = sessions.find((s) => s.id === id);
      if (opened) persistSession(opened);
      persistIndex(sessions, id);
    },

    deleteSession: (id) => {
      currentAborts.get(id)?.abort();
      for (const [itemId, pending] of pendingApprovals) {
        if (pending.sessionId === id) {
          pending.resolve(false);
          pendingApprovals.delete(itemId);
        }
      }
      const sessions = get().sessions.filter((s) => s.id !== id);
      let active = get().activeSessionId;
      if (active === id) {
        const open = sessions.filter((s) => !s.archived);
        active = open[open.length - 1]?.id ?? null;
      }
      set({
        sessions,
        activeSessionId: active,
        sendingSessionIds: get().sendingSessionIds.filter((sessionId) => sessionId !== id),
      });
      deletePersistedSession(id);
      persistIndex(sessions, active, true);
    },

    setActiveSession: (id) => {
      set({ activeSessionId: id });
      persistIndex(get().sessions, id);
    },

    setSessionModel: (id, modelId) => updateSession(id, (s) => ({ ...s, modelId })),
    setSessionMode: (id, mode) => updateSession(id, (s) => ({ ...s, mode })),
    setSessionThinkingLevel: (id, thinkingLevel) =>
      updateSession(id, (s) => ({ ...s, thinkingLevel })),
    setSessionUseOpenFile: (id, useOpenFile) =>
      updateSession(id, (s) => ({ ...s, useOpenFile })),
    renameSession: (id, title) =>
      updateSession(id, (s) => ({ ...s, title: title.trim() || s.title })),

    stopSending: (sessionId) => {
      currentAborts.get(sessionId)?.abort();
      // Release approvals for this session only so other conversations keep
      // waiting/running independently.
      for (const [itemId, pending] of pendingApprovals) {
        if (pending.sessionId === sessionId) {
          pending.resolve(false);
          pendingApprovals.delete(itemId);
        }
      }
    },

    resolvePendingEdit: (itemId, approved) => {
      const pending = pendingApprovals.get(itemId);
      if (pending) {
        pendingApprovals.delete(itemId);
        pending.resolve(approved);
      }
    },

    undoEdit: (itemId) => {
      const before = undoSnapshots.get(itemId);
      if (before == null) return;
      if (applyContent(before)) {
        undoSnapshots.delete(itemId);
        patchItem(itemId, { status: "undone" });
      }
    },

    sendMessage: async (sessionId, text) => {
      const trimmed = text.trim();
      if (!trimmed || get().sendingSessionIds.includes(sessionId)) return;
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!session) return;

      const hadUserMsg = session.items.some((i) => i.kind === "user");
      updateSession(sessionId, (s) => ({
        ...s,
        title: hadUserMsg ? s.title : trimmed.slice(0, 20),
        items: [...s.items, { id: uid(), kind: "user", text: trimmed }],
        history: [...s.history, { role: "user", content: trimmed }],
      }));

      const model = resolveModelSelection(useAppStore.getState().aiModels, session.modelId);
      if (!model) {
        appendItem(sessionId, {
          id: uid(),
          kind: "error",
          text: "请先在上方为该会话选择一个模型（可在设置中添加）。",
        });
        return;
      }

      set({ sendingSessionIds: [...get().sendingSessionIds, sessionId] });
      const abort = new AbortController();
      currentAborts.set(sessionId, abort);
      const system = buildSystemPrompt(
        session.useOpenFile ? useAppStore.getState().activeFilePath : null,
        useAppStore.getState().workspacePath,
      );
      const history = get().sessions.find((s) => s.id === sessionId)!.history.slice();

      // The assistant bubble currently being streamed into; a new one is
      // created per round (text after a tool call gets its own bubble).
      let streamItemId: string | null = null;

      try {
        await runChat(
          model,
          history,
          TOOL_DEFS,
          system,
          { thinkingLevel: session.thinkingLevel, signal: abort.signal },
          {
            onTextDelta: (delta) => {
              if (!streamItemId) {
                streamItemId = uid();
                appendItem(sessionId, { id: streamItemId, kind: "assistant", text: "" });
              }
              appendItemText(sessionId, streamItemId, delta);
            },
            onTextDone: () => {
              streamItemId = null;
              const latest = get().sessions.find((s) => s.id === sessionId);
              if (latest) persistSession(latest);
            },
            onToolCall: (call) => {
              streamItemId = null;
              return runToolCall(sessionId, call);
            },
          },
        );
      } catch (e: any) {
        appendItem(sessionId, {
          id: uid(),
          kind: "error",
          text: abort.signal.aborted ? "已手动停止。" : `请求失败：${e?.message ?? String(e)}`,
        });
      } finally {
        // Persist whatever history the loop accumulated (success or failure).
        updateSession(sessionId, (s) => ({ ...s, history }));
        if (currentAborts.get(sessionId) === abort) currentAborts.delete(sessionId);
        set({ sendingSessionIds: get().sendingSessionIds.filter((id) => id !== sessionId) });
      }
    },
  };
});

function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max";
}

// Hydrate sessions from the backend once at startup. Until this resolves the
// store holds an empty list; RightPanel waits on `hydrated` before creating a
// session, so a fresh session isn't spawned ahead of the persisted ones. Guard
// against clobbering anything created in the meantime.
void loadPersisted().then((data) => {
  useChatStore.setState((s) =>
    s.sessions.length === 0 ? { ...data, hydrated: true } : { hydrated: true },
  );
});
