import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Check,
  ChevronDown,
  FilePlus2,
  FileText,
  GalleryVerticalEnd,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import {
  useChatStore,
  type ChatItem,
  type ChatSession,
  type ToolMode,
  type ThinkingLevel,
  type ToolStatus,
} from "../../store/useChatStore";
import type { DiffView } from "../../lib/ai/tools";
import { basename } from "../../lib/fs";
import { Markdown } from "./Markdown";
import { modelIdsOf, modelSelectionKey, modelSelectionLabel } from "../../lib/ai/modelSelection";

/**
 * Right-hand AI chat panel. Hosts multiple sessions (tabs + "+"), each with its
 * own model and tool-confirmation mode, and drives the read/edit-file tool loop
 * through useChatStore. Fills its parent (width is controlled by App.tsx).
 */
export function RightPanel() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const ensureSession = useChatStore((s) => s.ensureSession);
  const hydrated = useChatStore((s) => s.hydrated);

  // Always keep at least one open (non-archived) session around — but only once
  // sessions have loaded from the backend, so we don't spawn an empty session
  // ahead of the persisted ones.
  const openCount = sessions.filter((s) => !s.archived).length;
  useEffect(() => {
    if (hydrated) ensureSession();
  }, [hydrated, ensureSession, openCount]);

  const active = sessions.find((s) => s.id === activeSessionId) ?? null;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{
        borderLeft: "1px solid var(--border)",
        background: "var(--bg)",
        fontSize: "var(--ai-assistant-font-size)",
      }}
    >
      <SessionTabs />
      {active ? <SessionView key={active.id} session={active} /> : <div className="flex-1" />}
    </div>
  );
}

/* ------------------------------ session tabs ----------------------------- */

function SessionTabs() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sendingSessionIds = useChatStore((s) => s.sendingSessionIds);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const closeSession = useChatStore((s) => s.closeSession);
  const renameSession = useChatStore((s) => s.renameSession);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const commitRename = () => {
    if (editingId) renameSession(editingId, editText);
    setEditingId(null);
  };

  const openSessions = sessions.filter((s) => !s.archived);

  return (
    <div
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-1 px-2"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--sidebar-bg)" }}
    >
      <Bot size={15} style={{ color: "var(--accent)" }} className="ml-0.5 shrink-0" />
      <div
        data-tauri-drag-region
        className="scroll-auto-hide flex flex-1 items-center gap-1 overflow-x-auto py-1"
      >
        {openSessions.map((s) => {
          const isActive = s.id === activeSessionId;
          const isSending = sendingSessionIds.includes(s.id);
          return (
            <div
              key={s.id}
              onClick={() => setActiveSession(s.id)}
              onDoubleClick={() => {
                setEditingId(s.id);
                setEditText(s.title);
              }}
              className="group flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[0.923em] transition-colors"
              style={{
                background: isActive ? "var(--bg)" : "transparent",
                border: `1px solid ${isActive ? "var(--border)" : "transparent"}`,
                boxShadow: isActive ? "0 1px 2px var(--shadow)" : "none",
                color: isActive ? "var(--text)" : "var(--text-muted)",
                maxWidth: 150,
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = "var(--hover)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = "transparent";
              }}
            >
              {editingId === s.id ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-24 bg-transparent text-[1em] outline-none"
                  style={{ color: "var(--text)" }}
                />
              ) : (
                <span className="truncate">{s.title}</span>
              )}
              {isSending && (
                <Loader2
                  size={11}
                  className="shrink-0 animate-spin"
                  style={{ color: "var(--accent)" }}
                />
              )}
              <button
                title="关闭会话（保留在历史中）"
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--hover)] group-hover:opacity-100"
                style={{ color: "var(--text-muted)" }}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "New session" + session-history dropdown. Rendered by the TitleBar in the
 * strip above the panel (only while the panel is open), not inside the panel
 * itself, so the tab row keeps its full width for tabs.
 */
export function ChatHeaderActions() {
  const newSession = useChatStore((s) => s.newSession);

  return (
    <>
      <button
        title="新建会话"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={newSession}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
        style={{ color: "var(--text-muted)" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <Plus size={16} />
      </button>
      <HistoryMenu />
    </>
  );
}

/* ----------------------------- session history ---------------------------- */

/**
 * Dropdown next to "+" listing every session (open tabs and archived ones).
 * Clicking a row reopens it as the active tab; the trash button deletes it
 * permanently.
 */
function HistoryMenu() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const openSession = useChatStore((s) => s.openSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 256;
    setMenuPos({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width)),
      top: r.bottom + 8,
    });
  };

  // Close on outside click / Escape. The menu is portaled to <body>, so both
  // the trigger and menu need to count as "inside".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onLeave = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onLeave);
    window.addEventListener("scroll", onLeave, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("scroll", onLeave, true);
    };
  }, [open]);

  // Newest non-empty sessions first. Empty draft sessions can stay open as
  // tabs, but they are not history yet.
  const list = sessions.filter((s) => s.items.length > 0 || s.history.length > 0).slice().reverse();
  const menu = open ? (
    <div
      ref={menuRef}
      className="fixed z-[80] w-64 overflow-hidden rounded-xl"
      style={{
        left: menuPos.left,
        top: menuPos.top,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        boxShadow: "0 8px 24px var(--shadow)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="px-3 py-2 text-[0.846em] font-medium"
        style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}
      >
        会话历史
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {list.length === 0 ? (
          <div className="px-3 py-3 text-[0.923em]" style={{ color: "var(--text-muted)" }}>
            暂无会话
          </div>
        ) : (
          list.map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                onClick={() => {
                  openSession(s.id);
                  setOpen(false);
                }}
                className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[var(--hover)]"
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background: isActive
                      ? "var(--accent)"
                      : s.archived
                        ? "transparent"
                        : "var(--text-muted)",
                    border: s.archived && !isActive ? "1px solid var(--border)" : "none",
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[0.923em]"
                    style={{ color: isActive ? "var(--text)" : "var(--text-soft)" }}
                  >
                    {s.title}
                  </div>
                  <div className="text-[0.769em]" style={{ color: "var(--text-muted)" }}>
                    {s.items.length} 条消息{s.archived ? "" : " · 打开中"}
                  </div>
                </div>
                <button
                  title="删除会话（不可恢复）"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(s.id);
                  }}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--active)] group-hover:opacity-100"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#e5484d")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative shrink-0" onMouseDown={(e) => e.stopPropagation()}>
      <button
        title="会话历史"
        onClick={() => {
          updateMenuPosition();
          setOpen((v) => !v);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
        style={{
          color: open ? "var(--text)" : "var(--text-muted)",
          background: open ? "var(--hover)" : "transparent",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          if (!open) {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-muted)";
          }
        }}
      >
        <GalleryVerticalEnd size={15} />
      </button>

      {menu && createPortal(menu, document.body)}
    </div>
  );
}

/* ------------------------------ session view ----------------------------- */

const SUGGESTIONS = ["总结当前文件的要点", "帮我润色这篇文档", "检查并修正错别字与语法"];

function SessionView({ session }: { session: ChatSession }) {
  const sending = useChatStore((s) => s.sendingSessionIds.includes(session.id));
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopSending = useChatStore((s) => s.stopSending);

  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // `session.items` gets a new identity on every streamed delta, so this also
  // keeps the view pinned to the bottom while a reply is streaming in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.items, sending]);

  // Auto-grow the textarea up to a max height.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [input]);

  const submit = () => {
    const text = input;
    if (!text.trim() || sending) return;
    setInput("");
    void sendMessage(session.id, text);
  };

  const empty = session.items.length === 0;
  // While a reply is streaming into the last assistant bubble, the growing
  // text itself is the progress indicator — hide the typing dots.
  const lastItem = session.items[session.items.length - 1];
  const showTyping = sending && lastItem?.kind !== "assistant";

  return (
    <>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {empty ? (
          <EmptyState onPick={(t) => setInput(t)} />
        ) : (
          session.items.map((item) => <Item key={item.id} item={item} />)
        )}
        {showTyping && <TypingIndicator />}
      </div>

      <div className="shrink-0 px-2.5 pb-2.5 pt-1.5">
        <div
          className="rounded-[22px] px-2.5 py-2 transition-colors"
          style={{
            background: "var(--bg-elev)",
            border: `1px solid ${focused ? "var(--accent)" : "var(--border)"}`,
          }}
        >
          <OpenFileChip session={session} />
          <div className="flex items-end gap-1.5">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder="给 AI 发消息…"
              className="max-h-[170px] min-h-[46px] flex-1 resize-none bg-transparent text-[1em] leading-relaxed outline-none placeholder:text-[var(--text-muted)]"
              style={{ color: "var(--text)" }}
            />
            <button
              title={sending ? "停止" : "发送 (Enter)"}
              onClick={sending ? () => stopSending(session.id) : submit}
              disabled={!sending && !input.trim()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl transition-all disabled:opacity-30"
              style={{ background: sending ? "#e5484d" : "var(--accent)", color: "#fff" }}
            >
              {sending ? <Square size={11} fill="#fff" /> : <Send size={14} />}
            </button>
          </div>
          <ComposerControls session={session} />
        </div>
        <div className="px-1 pt-1 text-[0.769em]" style={{ color: "var(--text-muted)" }}>
          Enter 发送 · Shift+Enter 换行
        </div>
      </div>
    </>
  );
}

/**
 * Context chip above the composer: shows which open file the AI will be told
 * about. ✕ detaches it for this session (tools stay available); a ghost
 * "attach" button brings it back. Hidden entirely when no file is open.
 */
function OpenFileChip({ session }: { session: ChatSession }) {
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const setSessionUseOpenFile = useChatStore((s) => s.setSessionUseOpenFile);

  if (!activeFilePath) return null;

  if (!session.useOpenFile) {
    return (
      <div className="mb-1.5 flex">
        <button
          title="把当前打开的文件重新提供给 AI"
          onClick={() => setSessionUseOpenFile(session.id, true)}
          className="flex h-6 items-center gap-1 rounded-full px-2 text-[0.846em] transition-colors"
          style={{ border: "1px dashed var(--border)", color: "var(--text-muted)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--hover)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          <Paperclip size={11} />
          附加当前文件
        </button>
      </div>
    );
  }

  return (
    <div className="mb-1.5 flex">
      <div
        title={`AI 可以看到当前文件：${activeFilePath}`}
        className="flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full pl-2 pr-1 text-[0.846em]"
        style={{ border: "1px solid var(--border)", color: "var(--text-soft)" }}
      >
        <FileText size={11} className="shrink-0" style={{ color: "var(--text-muted)" }} />
        <span className="truncate">{basename(activeFilePath)}</span>
        <button
          title="本会话不再提供当前文件"
          onClick={() => setSessionUseOpenFile(session.id, false)}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--hover)]"
          style={{ color: "var(--text-muted)" }}
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <div
        className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
        style={{ background: "var(--active)", color: "var(--accent)" }}
      >
        <Sparkles size={24} />
      </div>
      <div className="text-[1.077em] font-semibold" style={{ color: "var(--text)" }}>
        AI 笔记助手
      </div>
      <div className="mt-1 max-w-[220px] text-[0.923em] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        我可以读取并修改你正在编辑的文件。试试：
      </div>
      <div className="mt-3 flex w-full flex-col gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-lg px-3 py-2 text-left text-[0.923em] transition-colors"
            style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", color: "var(--text-soft)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-elev)")}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="ai-msg-in flex items-center gap-2.5">
      <AssistantAvatar />
      <div
        className="flex items-center gap-1 rounded-2xl rounded-bl-sm px-3 py-2.5"
        style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
      >
        <span className="ai-dot" />
        <span className="ai-dot" />
        <span className="ai-dot" />
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-lg"
      style={{ background: "var(--active)", color: "var(--accent)" }}
    >
      <Bot size={16} />
    </div>
  );
}

/* ----------------------------- composer controls ----------------------------- */

function ComposerControls({ session }: { session: ChatSession }) {
  const aiModels = useAppStore((s) => s.aiModels);
  const openSettings = useAppStore((s) => s.openSettings);
  const setSessionModel = useChatStore((s) => s.setSessionModel);
  const setSessionMode = useChatStore((s) => s.setSessionMode);
  const setSessionThinkingLevel = useChatStore((s) => s.setSessionThinkingLevel);
  const modelOptions = aiModels.flatMap((m) =>
    modelIdsOf(m).map((modelId) => ({
      key: modelSelectionKey(m.id, modelId),
      label: modelSelectionLabel(m, modelId),
    })),
  );
  const legacyConfig = aiModels.find((m) => m.id === session.modelId);
  const legacyModelId = legacyConfig ? modelIdsOf(legacyConfig)[0] : "";
  const selectedValue =
    modelOptions.some((m) => m.key === session.modelId)
      ? (session.modelId ?? "")
      : legacyConfig && legacyModelId
        ? modelSelectionKey(legacyConfig.id, legacyModelId)
        : "";

  if (modelOptions.length === 0) {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
        <PermissionSelect
          value={session.mode}
          onChange={(mode) => setSessionMode(session.id, mode)}
        />
        <button
          onClick={() => void openSettings()}
          className="flex h-7 items-center gap-1 rounded-full px-2 text-[0.923em] transition-colors"
          style={{ color: "var(--accent)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Settings2 size={13} />
          去设置添加
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
      <PermissionSelect
        value={session.mode}
        onChange={(mode) => setSessionMode(session.id, mode)}
      />
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <CompactSelect
          value={selectedValue}
          onChange={(v) => setSessionModel(session.id, v || null)}
          className="max-w-[132px]"
          title="选择模型"
          label={shortModelLabel(selectedValue, modelOptions)}
        >
          {!session.modelId && <option value="">选择模型</option>}
          {modelOptions.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </CompactSelect>
        <CompactSelect
          value={session.thinkingLevel}
          onChange={(v) => setSessionThinkingLevel(session.id, v as ThinkingLevel)}
          className="w-[64px]"
          title="思考级别"
          label={thinkingLabel(session.thinkingLevel)}
        >
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
          <option value="xhigh">超高</option>
          <option value="max">最高</option>
        </CompactSelect>
      </div>
    </div>
  );
}

function PermissionSelect({
  value,
  onChange,
}: {
  value: ToolMode;
  onChange: (v: ToolMode) => void;
}) {
  return (
    <CompactSelect
      value={value}
      onChange={(v) => onChange(v as ToolMode)}
      className="w-[112px]"
      title="操作确认"
      label={modeLabel(value)}
      tone="accent"
      icon={<ShieldCheck size={14} />}
    >
      <option value="ask">编辑前确认</option>
      <option value="auto">自动编辑</option>
      <option value="ask_all">每次询问</option>
    </CompactSelect>
  );
}

function modeLabel(mode: ToolMode): string {
  if (mode === "auto") return "自动编辑";
  if (mode === "ask_all") return "每次询问";
  return "编辑前确认";
}

function thinkingLabel(level: ThinkingLevel): string {
  if (level === "max") return "最高";
  if (level === "xhigh") return "超高";
  if (level === "high") return "高";
  return level === "low" ? "低" : "中";
}

function shortModelLabel(
  value: string,
  options: { key: string; label: string }[],
): string {
  const full = options.find((m) => m.key === value)?.label ?? "模型";
  const modelId = full.includes(" · ") ? full.split(" · ").pop()! : full;
  return modelId
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "")
    .replace(/^deepseek-/, "")
    .replace(/^gemini-/, "");
}

function CompactSelect({
  value,
  onChange,
  children,
  className,
  title,
  label,
  tone = "normal",
  icon,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
  label?: string;
  tone?: "normal" | "accent";
  icon?: React.ReactNode;
}) {
  return (
    <label
      title={title}
      className={`relative flex h-7 min-w-0 items-center overflow-hidden rounded-full text-[0.923em] transition-colors ${className ?? ""}`}
      style={{
        background: tone === "accent" ? "color-mix(in srgb, var(--accent) 9%, transparent)" : "transparent",
        border: tone === "accent" ? "1px solid color-mix(in srgb, var(--accent) 22%, transparent)" : "1px solid var(--border)",
        color: tone === "accent" ? "var(--accent)" : "var(--text-soft)",
      }}
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        aria-label={title}
      >
        {children}
      </select>
      <span className="flex min-w-0 flex-1 items-center gap-1 px-2 pr-6">
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="truncate">{label ?? value}</span>
      </span>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 shrink-0 opacity-75" />
    </label>
  );
}

/* --------------------------------- items --------------------------------- */

function Item({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="ai-msg-in flex justify-end">
        <div
          className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm px-3 py-2 text-[1em] leading-relaxed"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="ai-msg-in flex gap-2.5">
        <AssistantAvatar />
        <div className="min-w-0 flex-1 pt-0.5">
          <Markdown text={item.text} />
        </div>
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div
        className="ai-msg-in flex items-start gap-2 rounded-lg px-3 py-2 text-[0.923em] leading-relaxed"
        style={{ background: "color-mix(in srgb, #f85149 12%, transparent)", color: "#f85149" }}
      >
        <X size={14} className="mt-0.5 shrink-0" />
        <span className="break-words">{item.text}</span>
      </div>
    );
  }
  return <ToolCard item={item} />;
}

/* ------------------------------- tool card ------------------------------- */

const STATUS_META: Record<ToolStatus, { label: string; color: string }> = {
  running: { label: "处理中", color: "var(--accent)" },
  done: { label: "完成", color: "#2ea043" },
  pending: { label: "待确认", color: "#d97706" },
  applied: { label: "已应用", color: "#2ea043" },
  rejected: { label: "已拒绝", color: "var(--text-muted)" },
  undone: { label: "已撤销", color: "var(--text-muted)" },
  error: { label: "失败", color: "#f85149" },
};

function StatusPill({ status, label }: { status: ToolStatus; label?: string }) {
  const meta = STATUS_META[status];
  return (
    <span className="flex shrink-0 items-center gap-1 text-[0.846em] font-medium" style={{ color: meta.color }}>
      {status === "running" ? (
        <Loader2 size={11} className="animate-spin" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      )}
      {label ?? meta.label}
    </span>
  );
}

const TOOL_META: Record<
  Extract<ChatItem, { kind: "tool" }>["tool"],
  { verb: string; Icon: typeof FileText }
> = {
  read: { verb: "读取", Icon: FileText },
  edit: { verb: "修改", Icon: Pencil },
  create: { verb: "新建", Icon: FilePlus2 },
  delete: { verb: "删除", Icon: Trash2 },
  search: { verb: "搜索", Icon: Search },
};

function ToolCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const resolvePendingEdit = useChatStore((s) => s.resolvePendingEdit);
  const undoEdit = useChatStore((s) => s.undoEdit);

  const { verb, Icon } = TOOL_META[item.tool];
  // For deletes "applied" means the file is gone, not an editor change.
  const statusLabel =
    item.tool === "delete" && item.status === "applied" ? "已删除" : undefined;

  return (
    <div
      className="ai-msg-in overflow-hidden rounded-xl text-[0.923em]"
      style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Icon size={14} style={{ color: "var(--text-muted)" }} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>
          <span style={{ color: "var(--text-muted)" }}>{verb} </span>
          <span className="font-medium">{item.summary}</span>
        </span>
        {item.diff && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[0.917em]">
            <span style={{ color: "#2ea043" }}>+{item.diff.added}</span>
            <span style={{ color: "#f85149" }}>−{item.diff.removed}</span>
          </span>
        )}
        <StatusPill status={item.status} label={statusLabel} />
      </div>

      {item.diff && <DiffBlock diff={item.diff} />}

      {item.error && (
        <div className="px-2.5 py-1.5" style={{ color: "#f85149", borderTop: "1px solid var(--border)" }}>
          {item.error}
        </div>
      )}

      {item.tool === "delete" && item.status === "pending" && (
        <div
          className="flex items-center justify-between gap-2 px-2.5 py-2"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>确认删除？此操作不可撤销。</span>
          <div className="flex gap-1.5">
            <CardButton onClick={() => resolvePendingEdit(item.id, false)}>取消</CardButton>
            <CardButton danger onClick={() => resolvePendingEdit(item.id, true)}>
              <Trash2 size={12} /> 确认删除
            </CardButton>
          </div>
        </div>
      )}

      {item.tool !== "delete" && item.tool !== "edit" && item.status === "pending" && (
        <div
          className="flex items-center justify-between gap-2 px-2.5 py-2"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>允许执行这次{verb}？</span>
          <div className="flex gap-1.5">
            <CardButton onClick={() => resolvePendingEdit(item.id, false)}>取消</CardButton>
            <CardButton primary onClick={() => resolvePendingEdit(item.id, true)}>
              <Check size={12} /> 允许
            </CardButton>
          </div>
        </div>
      )}

      {item.tool === "edit" && (item.status === "pending" || item.status === "applied") && (
        <div
          className="flex items-center justify-between gap-2 px-2.5 py-2"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          {item.status === "pending" ? (
            <>
              <span style={{ color: "var(--text-muted)" }}>应用这次修改？</span>
              <div className="flex gap-1.5">
                <CardButton onClick={() => resolvePendingEdit(item.id, false)}>拒绝</CardButton>
                <CardButton primary onClick={() => resolvePendingEdit(item.id, true)}>
                  <Check size={12} /> 应用
                </CardButton>
              </div>
            </>
          ) : (
            <>
              <span style={{ color: "var(--text-muted)" }}>已写入编辑器，尚未保存</span>
              <CardButton onClick={() => undoEdit(item.id)}>
                <Undo2 size={12} /> 撤销
              </CardButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const MAX_DIFF_ROWS = 200;

function DiffBlock({ diff }: { diff: DiffView }) {
  const rows = diff.rows.slice(0, MAX_DIFF_ROWS);
  const hidden = diff.rows.length - rows.length;
  if (rows.length === 0) return null;
  return (
    <div
      className="max-h-64 overflow-auto py-1 font-mono text-[0.846em] leading-snug"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      {rows.map((r, i) => (
        <div
          key={i}
          className="whitespace-pre px-2.5"
          style={{
            background:
              r.type === "add"
                ? "color-mix(in srgb, #2ea043 14%, transparent)"
                : "color-mix(in srgb, #f85149 14%, transparent)",
            color: "var(--text)",
          }}
        >
          <span style={{ color: r.type === "add" ? "#2ea043" : "#f85149" }}>{r.type === "add" ? "+" : "−"}</span>
          {" "}
          {r.text || " "}
        </div>
      ))}
      {hidden > 0 && (
        <div className="px-2.5 py-0.5" style={{ color: "var(--text-muted)" }}>
          … 其余 {hidden} 行省略
        </div>
      )}
    </div>
  );
}

function CardButton({
  children,
  onClick,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  const filled = primary || danger;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[0.923em] font-medium transition-colors"
      style={{
        background: danger ? "#e5484d" : primary ? "var(--accent)" : "transparent",
        color: filled ? "#fff" : "var(--text-soft)",
        border: filled ? "none" : "1px solid var(--border)",
      }}
      onMouseEnter={(e) => {
        if (!filled) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!filled) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
