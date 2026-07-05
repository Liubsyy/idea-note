import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownUp,
  Bot,
  Check,
  Copy,
  DownloadCloud,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  Keyboard,
  ListTree,
  Minus,
  Moon,
  Palette,
  PenLine,
  Pencil,
  Plus,
  RotateCcw,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useAppStore,
  readSyncConfig,
  saveSyncConfig,
  readAttachmentConfig,
  saveAttachmentConfig,
  ensureSyncConfigsLoaded,
  readGlobalProxy,
  saveGlobalProxy,
  ensureGlobalProxyLoaded,
  readCommitMessageConfig,
  saveCommitMessageConfig,
  SYNC_REQUEST_EVENT,
  SYNC_STATE_EVENT,
  SYNC_CONFIG_EVENT,
  GIT_PROXY_EVENT,
  GIT_ATTACHED_EVENT,
  WORKSPACE_OPEN_EVENT,
  SETTINGS_CONTEXT_EVENT,
  EDITOR_FONT_OPTIONS,
  editorFontStack,
  HEADING_SCALE_MIN,
  HEADING_SCALE_MAX,
  type AiModel,
  type AiProvider,
  type AttachmentConfig,
  type AttachmentLocation,
  type CommitMessageConfig,
  type SyncConfig,
  type SyncState,
} from "../store/useAppStore";
import { fetchUpstreamModels } from "../lib/ai/modelCatalog";
import {
  firstModelSelection,
  modelIdsOf,
  modelSelectionKey,
  modelSelectionLabel,
} from "../lib/ai/modelSelection";
import {
  attachRemote,
  cloneRemote,
  getGitInfo,
  gitRun,
  initLocalRepo,
  repoNameFromUrl,
  type GitInfo,
} from "../lib/git";
import { basename, readFile, writeFile } from "../lib/fs";
import { copyText } from "../lib/clipboard";
import {
  BUILTIN_THEMES,
  THEME_TOKEN_GROUPS,
  normalizeCustomTheme,
  newThemeId,
  type ThemeDef,
} from "../themes";
import {
  EDITOR_COMMANDS,
  effectiveKey,
  formatKey,
  keyFromEvent,
} from "../lib/codemirror/keybindings";

type TabId =
  | "appearance"
  | "editor"
  | "shortcuts"
  | "sidebar"
  | "attachments"
  | "models"
  | "sync";

interface Tab {
  id: TabId;
  label: string;
  caption: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  { id: "appearance", label: "外观", caption: "主题、缩放与布局", icon: <Sun size={16} /> },
  { id: "sidebar", label: "左侧列表", caption: "各模式字体大小", icon: <ListTree size={16} /> },
  { id: "editor", label: "编辑器", caption: "字体、字号与行高", icon: <PenLine size={16} /> },
  { id: "shortcuts", label: "快捷键", caption: "编辑器快捷键自定义", icon: <Keyboard size={16} /> },
  { id: "attachments", label: "图片/附件", caption: "粘贴文件的保存目录", icon: <ImageIcon size={16} /> },
  { id: "models", label: "AI笔记助手", caption: "模型、字号与 API Key", icon: <Bot size={16} /> },
  { id: "sync", label: "远程同步", caption: "Git 仓库同步", icon: <ArrowDownUp size={16} /> },
];

/** Initial tab from the `tab` URL param (set by openSettings), else 外观. */
function readInitialTab(): TabId {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tabs.some((t) => t.id === tab) ? (tab as TabId) : "appearance";
}

/**
 * The settings UI. Rendered as the sole content of a standalone, frameless
 * Tauri window (label "settings") — see `openSettings` in the store. Being a
 * real OS window means it can be dragged anywhere on screen (including off the
 * main window) and is non-modal, so the main editor stays fully usable.
 * The top bars carry `data-tauri-drag-region` for native window drag.
 */
export function SettingsWindow() {
  const themeId = useAppStore((s) => s.themeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const setTheme = useAppStore((s) => s.setTheme);
  const addCustomTheme = useAppStore((s) => s.addCustomTheme);
  const updateCustomTheme = useAppStore((s) => s.updateCustomTheme);
  const deleteCustomTheme = useAppStore((s) => s.deleteCustomTheme);
  const showToast = useAppStore((s) => s.showToast);
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const setEditorFontSize = useAppStore((s) => s.setEditorFontSize);
  const editorLineHeight = useAppStore((s) => s.editorLineHeight);
  const setEditorLineHeight = useAppStore((s) => s.setEditorLineHeight);
  const editorFontFamily = useAppStore((s) => s.editorFontFamily);
  const setEditorFontFamily = useAppStore((s) => s.setEditorFontFamily);
  const editorHeadingScale = useAppStore((s) => s.editorHeadingScale);
  const setEditorHeadingScale = useAppStore((s) => s.setEditorHeadingScale);
  const editorLineNumbers = useAppStore((s) => s.editorLineNumbers);
  const setEditorLineNumbers = useAppStore((s) => s.setEditorLineNumbers);
  const editorMaxTabs = useAppStore((s) => s.editorMaxTabs);
  const setEditorMaxTabs = useAppStore((s) => s.setEditorMaxTabs);
  const editorKeybindings = useAppStore((s) => s.editorKeybindings);
  const setEditorKeybinding = useAppStore((s) => s.setEditorKeybinding);
  const resetEditorKeybindings = useAppStore((s) => s.resetEditorKeybindings);
  const aiAssistantFontSize = useAppStore((s) => s.aiAssistantFontSize);
  const setAiAssistantFontSize = useAppStore((s) => s.setAiAssistantFontSize);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const setCompactSidebar = useAppStore((s) => s.setCompactSidebar);
  const compactEditor = useAppStore((s) => s.compactEditor);
  const setCompactEditor = useAppStore((s) => s.setCompactEditor);
  const uiZoom = useAppStore((s) => s.uiZoom);
  const setUiZoom = useAppStore((s) => s.setUiZoom);
  const sidebarFilesFontSize = useAppStore((s) => s.sidebarFilesFontSize);
  const sidebarNotesFontSize = useAppStore((s) => s.sidebarNotesFontSize);
  const sidebarOutlineFontSize = useAppStore((s) => s.sidebarOutlineFontSize);
  const setSidebarFontSize = useAppStore((s) => s.setSidebarFontSize);

  const [activeTab, setActiveTab] = useState<TabId>(readInitialTab);
  const active = tabs.find((t) => t.id === activeTab)!;

  // When an already-open settings window is reopened on a specific tab (e.g. the
  // empty-state 远程同步 button), switch to it.
  useEffect(() => {
    const un = listen<{ tab?: string }>(SETTINGS_CONTEXT_EVENT, ({ payload }) => {
      if (payload.tab && tabs.some((t) => t.id === payload.tab))
        setActiveTab(payload.tab as TabId);
    });
    return () => void un.then((fn) => fn());
  }, []);

  return (
    <div
      className="flex h-screen w-screen overflow-hidden text-[13px]"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      {/* ---- Left navigation ---- */}
      <aside
        className="flex w-[188px] shrink-0 flex-col"
        style={{ background: "var(--sidebar-bg)" }}
      >
        <div
          data-tauri-drag-region
          className="flex h-[52px] shrink-0 select-none items-end px-4 pb-2"
        >
          <span className="text-[13px] font-semibold tracking-wide" style={{ color: "var(--text)" }}>
            设置
          </span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2.5 py-1">
          {tabs.map((tab) => (
            <NavItem
              key={tab.id}
              tab={tab}
              active={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            />
          ))}
        </nav>

        <div className="select-none px-4 pb-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Idea Note
        </div>
      </aside>

      {/* ---- Content ---- */}
      <section
        className="flex min-w-0 flex-1 flex-col"
        style={{ borderLeft: "1px solid var(--border)" }}
      >
        <header
          data-tauri-drag-region
          className="flex h-[52px] shrink-0 select-none items-center gap-3 pl-6 pr-3"
        >
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-semibold leading-tight" style={{ color: "var(--text)" }}>
              {active.label}
            </h2>
            <p className="truncate text-[11px] leading-tight" style={{ color: "var(--text-muted)" }}>
              {active.caption}
            </p>
          </div>
          <IconButton title="关闭" onClick={() => getCurrentWindow().close()}>
            <X size={16} />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-1">
          {activeTab === "appearance" && (
            <div className="space-y-4">
              <ThemeSection
                themeId={themeId}
                customThemes={customThemes}
                setTheme={setTheme}
                addCustomTheme={addCustomTheme}
                updateCustomTheme={updateCustomTheme}
                deleteCustomTheme={deleteCustomTheme}
                showToast={showToast}
              />

              <Card>
                <Row title="界面缩放" desc="放大或缩小整个应用界面">
                  <Stepper
                    value={uiZoom}
                    min={0.8}
                    max={1.5}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={setUiZoom}
                  />
                </Row>
              </Card>
            </div>
          )}

          {activeTab === "editor" && (
            <div className="space-y-4">
              <Card>
                <Row title="字号" desc="编辑区正文与标题的基准大小">
                  <Stepper
                    value={editorFontSize}
                    min={12}
                    max={22}
                    step={1}
                    format={(v) => `${v}px`}
                    onChange={setEditorFontSize}
                  />
                </Row>
                <Row title="标题大小" desc="统一缩放各级标题（相对正文，100% 为默认）">
                  <Stepper
                    value={editorHeadingScale}
                    min={HEADING_SCALE_MIN}
                    max={HEADING_SCALE_MAX}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={setEditorHeadingScale}
                  />
                </Row>
                <Row title="行高" desc="行与行之间的垂直间距">
                  <Stepper
                    value={editorLineHeight}
                    min={1.3}
                    max={2.2}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    onChange={setEditorLineHeight}
                  />
                </Row>
                <Row title="字体" desc="编辑区正文字体（代码块仍用等宽字体）">
                  <div className="w-[148px]">
                    <Select
                      value={editorFontFamily}
                      options={EDITOR_FONT_OPTIONS.map((o) => ({
                        value: o.value,
                        label: o.label,
                      }))}
                      onChange={setEditorFontFamily}
                    />
                  </div>
                </Row>
                <Row title="显示行号" desc="仅在非 Markdown 文本文件中显示">
                  <Toggle checked={editorLineNumbers} onChange={setEditorLineNumbers} />
                </Row>
                <Row title="同时打开文件数" desc="编辑器标签栏最多保留的文件数，超出后自动关闭最早的">
                  <Stepper
                    value={editorMaxTabs}
                    min={1}
                    max={20}
                    step={1}
                    format={(v) => `${v} 个`}
                    onChange={setEditorMaxTabs}
                  />
                </Row>
                <Row title="紧凑排版" desc="收紧行距与标题间距，一屏显示更多内容">
                  <Toggle checked={compactEditor} onChange={setCompactEditor} />
                </Row>
              </Card>

              <Preview label="预览">
                <div
                  style={{
                    fontSize: editorFontSize,
                    lineHeight: compactEditor ? editorLineHeight * 0.78 : editorLineHeight,
                    fontFamily: editorFontStack(editorFontFamily),
                    color: "var(--text)",
                  }}
                >
                  <div
                    className="m-0 min-w-0"
                    style={{
                      // Mirrors .cm-md-h2 (1.8× base) scaled by the heading setting.
                      fontSize: editorFontSize * 1.8 * editorHeadingScale,
                      fontWeight: 700,
                      lineHeight: 1.3,
                      marginBottom: "0.35em",
                    }}
                  >
                    标题示例 Heading
                  </div>
                  <div
                    className="grid gap-x-3"
                    style={{ gridTemplateColumns: editorLineNumbers ? "2.5em 1fr" : "1fr" }}
                  >
                    {editorLineNumbers && (
                      <div
                        className="select-none text-right tabular-nums"
                        style={{ color: "var(--text-muted)" }}
                      >
                        1<br />2
                      </div>
                    )}
                    <p className="m-0 min-w-0">
                      灵感稍纵即逝，随手记下。
                      <br />
                      The quick brown fox jumps over the lazy dog.
                    </p>
                  </div>
                </div>
              </Preview>
            </div>
          )}

          {activeTab === "shortcuts" && (
            <ShortcutsTab
              overrides={editorKeybindings}
              onSet={setEditorKeybinding}
              onResetAll={resetEditorKeybindings}
            />
          )}

          {activeTab === "sidebar" && (
            <div className="space-y-4">
              <Card>
                <Row title="紧凑侧栏" desc="减小列表的行间距，一屏显示更多">
                  <Toggle checked={compactSidebar} onChange={setCompactSidebar} />
                </Row>
                <Row title="文件模式" desc="完整文件树列表的字体大小">
                  <Stepper
                    value={sidebarFilesFontSize}
                    min={11}
                    max={20}
                    step={1}
                    format={(v) => `${v}px`}
                    onChange={(v) => setSidebarFontSize("files", v)}
                  />
                </Row>
                <Row title="笔记模式" desc="Markdown 笔记列表的字体大小">
                  <Stepper
                    value={sidebarNotesFontSize}
                    min={11}
                    max={20}
                    step={1}
                    format={(v) => `${v}px`}
                    onChange={(v) => setSidebarFontSize("notes", v)}
                  />
                </Row>
                <Row title="预览大纲" desc="标题大纲列表的字体大小">
                  <Stepper
                    value={sidebarOutlineFontSize}
                    min={11}
                    max={20}
                    step={1}
                    format={(v) => `${v}px`}
                    onChange={(v) => setSidebarFontSize("outline", v)}
                  />
                </Row>
              </Card>

              <Preview label="预览">
                <div className={compactSidebar ? "space-y-1" : "space-y-3"}>
                  {(
                    [
                      ["文件模式", sidebarFilesFontSize, "笔记目录/会议记录.md"],
                      ["笔记模式", sidebarNotesFontSize, "产品想法"],
                      ["预览大纲", sidebarOutlineFontSize, "一、功能设计"],
                    ] as const
                  ).map(([label, size, sample]) => (
                    <div key={label} className="flex items-baseline gap-3">
                      <span
                        className="w-16 shrink-0 text-[11px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {label}
                      </span>
                      <span style={{ fontSize: size, color: "var(--tree-text)" }}>
                        {sample}
                      </span>
                    </div>
                  ))}
                </div>
              </Preview>
            </div>
          )}

          {activeTab === "attachments" && <AttachmentsTab />}

          {activeTab === "models" && (
            <ModelsTab
              aiAssistantFontSize={aiAssistantFontSize}
              setAiAssistantFontSize={setAiAssistantFontSize}
            />
          )}
          {activeTab === "sync" && <SyncTab />}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------- sync tab ------------------------------- */

/** Opener-window context: which workspace to sync and which main window runs
 *  it. Arrives via the URL at window creation, via an event when refocused. */
function readSyncContext(): { ws: string | null; src: string } {
  const params = new URLSearchParams(window.location.search);
  return { ws: params.get("ws"), src: params.get("src") ?? "main" };
}

const SYNC_STATE_LABEL: Record<SyncState, string> = {
  idle: "尚未同步",
  syncing: "同步中…",
  success: "同步成功",
  conflict: "有冲突待处理",
  error: "同步失败",
};

/**
 * The "快捷键" tab: every customisable editor command with its current binding.
 * Click a key chip and press the desired combo to rebind; Esc cancels,
 * Delete/Backspace restores that command's default.
 */
function ShortcutsTab({
  overrides,
  onSet,
  onResetAll,
}: {
  overrides: Record<string, string>;
  onSet: (commandId: string, key: string | null) => void;
  onResetAll: () => void;
}) {
  // Effective key -> command ids, so a combo bound to two commands is flagged.
  const keyUsers = new Map<string, string[]>();
  for (const cmd of EDITOR_COMMANDS) {
    const k = effectiveKey(cmd, overrides);
    keyUsers.set(k, [...(keyUsers.get(k) ?? []), cmd.id]);
  }
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
          点击按键框后直接按下想要的组合键即可重新绑定。
          <br />
          Esc 取消，Delete / Backspace 恢复该项默认。
        </p>
        <div className="shrink-0">
          <TextButton onClick={onResetAll} disabled={!hasOverrides}>
            全部恢复默认
          </TextButton>
        </div>
      </div>

      {/* Two shortcuts per row. */}
      <div className="grid grid-cols-2 gap-2">
        {EDITOR_COMMANDS.map((cmd) => {
          const key = effectiveKey(cmd, overrides);
          const overridden = !!overrides[cmd.id];
          const conflict = (keyUsers.get(key)?.length ?? 0) > 1;
          return (
            <div
              key={cmd.id}
              className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5"
              style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
            >
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium" style={{ color: "var(--text)" }}>
                  {cmd.label}
                </div>
                <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }} title={cmd.desc}>
                  {cmd.desc}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {overridden && (
                  <IconButton title="恢复默认" onClick={() => onSet(cmd.id, null)}>
                    <RotateCcw size={14} />
                  </IconButton>
                )}
                <KeyRecorder
                  value={key}
                  conflict={conflict}
                  onChange={(k) => onSet(cmd.id, k)}
                  onReset={() => onSet(cmd.id, null)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A key chip that records a combo. Click to arm, then the next keydown becomes
 * the binding. Modifier-only presses are ignored until a real key arrives.
 */
function KeyRecorder({
  value,
  conflict,
  onChange,
  onReset,
}: {
  value: string;
  conflict?: boolean;
  onChange: (key: string) => void;
  onReset: () => void;
}) {
  const [recording, setRecording] = useState(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(false);
    if (e.key === "Backspace" || e.key === "Delete") {
      onReset();
      return setRecording(false);
    }
    const k = keyFromEvent(e.nativeEvent);
    if (k) {
      onChange(k);
      setRecording(false);
    }
  };

  const border = recording
    ? "var(--accent)"
    : conflict
      ? "var(--danger, #ef4444)"
      : "var(--border)";
  const color = recording
    ? "var(--accent)"
    : conflict
      ? "var(--danger, #ef4444)"
      : "var(--text)";

  return (
    <button
      onClick={() => setRecording((r) => !r)}
      onKeyDown={onKeyDown}
      onBlur={() => setRecording(false)}
      title={conflict ? "该组合键与其它命令冲突" : "点击后按下快捷键"}
      className="flex h-8 min-w-[96px] items-center justify-center rounded-lg px-3 text-[13px] font-medium tabular-nums transition-colors"
      style={{
        border: `1px solid ${border}`,
        background: recording ? "var(--active)" : "var(--bg)",
        color,
      }}
    >
      {recording ? "按下快捷键…" : formatKey(value)}
    </button>
  );
}

/**
 * The "远程同步" tab. Currently lists a single provider — Git — and drives
 * everything through git CLI commands. Configuration (attach / clone / remote
 * URL) runs right here in the settings window; the actual sync is delegated to
 * the opener main window via events, since that window owns the tree + editor.
 */
function SyncTab() {
  const [ctx, setCtx] = useState(readSyncContext);
  const { ws, src } = ctx;

  // Re-sync context when an already-open settings window is refocused from a
  // (possibly different) main window.
  useEffect(() => {
    const un = listen<{ ws: string | null; src: string }>(
      SETTINGS_CONTEXT_EVENT,
      ({ payload }) => setCtx({ ws: payload.ws, src: payload.src ?? "main" }),
    );
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const [info, setInfo] = useState<GitInfo | null>(null);
  const refreshInfo = useCallback(async () => {
    if (!ws) {
      setInfo(null);
      return;
    }
    // Ensure the sync-config and proxy caches are warm before the sub-sections
    // (which read them synchronously in their state initializers) mount.
    await Promise.all([ensureSyncConfigsLoaded(), ensureGlobalProxyLoaded()]);
    setInfo(await getGitInfo(ws));
  }, [ws]);
  useEffect(() => {
    void refreshInfo();
  }, [refreshInfo]);

  // Live sync status pushed by the main window.
  const [sync, setSync] = useState<{
    syncState: SyncState;
    lastSyncMessage: string | null;
    lastSyncAt: number | null;
  }>({ syncState: "idle", lastSyncMessage: null, lastSyncAt: null });
  useEffect(() => {
    const un = listen<typeof sync>(SYNC_STATE_EVENT, ({ payload }) => setSync(payload));
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const connected = !!(info?.isRepo && info.remoteUrl);
  // Repo without origin: local-only sync mode (commits as snapshots, no push).
  const localOnly = !!(info?.isRepo && !info.remoteUrl);

  return (
    <div className="space-y-4">
      <Card>
        <Row title="Git" desc="基于 git 命令同步：可仅本地提交快照，或同步到任意远程仓库（GitHub、Gitee、自建…）">
          <span
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--active)", color: "var(--accent)" }}
          >
            <GitBranch size={11} />
            默认
          </span>
        </Row>
      </Card>

      {info && !info.installed && (
        <Notice tone="danger">
          未检测到 git，请先安装命令行 git（macOS 可执行 xcode-select --install）。
        </Notice>
      )}

      {!ws ? (
        <CloneSection src={src} />
      ) : connected || localOnly ? (
        <>
          <ConnectedSection
            ws={ws}
            src={src}
            info={info!}
            sync={sync}
            local={localOnly}
            onChanged={refreshInfo}
          />
          {/* Local-only mode can be upgraded to remote sync at any time. */}
          {localOnly && <AttachSection ws={ws} isRepo onAttached={refreshInfo} />}
        </>
      ) : info && info.installed ? (
        <AttachSection ws={ws} isRepo={false} onAttached={refreshInfo} />
      ) : null}
    </div>
  );
}

/** Empty project: clone a remote repo into a chosen local folder and open it. */
function CloneSection({ src }: { src: string }) {
  const requestGitCredential = useAppStore((s) => s.requestGitCredential);
  const [url, setUrl] = useState("");
  const [proxy, setProxy] = useState(() => readGlobalProxy());
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const pickDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: "选择存放位置" });
    if (typeof selected === "string") setParentDir(selected);
  };

  const clone = async () => {
    if (!url.trim() || !parentDir || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = await cloneRemote(url.trim(), parentDir, proxy, requestGitCredential);
      // Persist the proxy globally so all later syncs reuse it.
      saveGlobalProxy(proxy);
      emit(GIT_PROXY_EVENT, { proxy }).catch(() => {});
      setDone(true);
      // Hand the new workspace to the opener main window.
      emit(WORKSPACE_OPEN_EVENT, { target: src, path }).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return <Notice>克隆完成，已在主窗口打开。</Notice>;
  }

  return (
    <div
      className="space-y-3 rounded-xl p-4"
      style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
    >
      <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
        当前是空项目。克隆一个远程 git 仓库作为笔记库：
      </div>
      <Field label="远程仓库地址">
        <Input
          value={url}
          placeholder="git@github.com:user/notes.git 或 https://…"
          onChange={setUrl}
        />
      </Field>
      <Field label="同步代理（全局，所有笔记库共用，仅 HTTPS）">
        <Input
          value={proxy}
          placeholder="http://127.0.0.1:7890（留空不使用）"
          onChange={setProxy}
        />
      </Field>
      <Field label="存放位置">
        <button
          onClick={() => void pickDir()}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px]"
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            color: parentDir ? "var(--text)" : "var(--text-muted)",
          }}
        >
          <FolderOpen size={14} className="shrink-0" />
          <span className="truncate">{parentDir ?? "选择本地文件夹…"}</span>
        </button>
      </Field>
      {parentDir && url.trim() && (
        <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          将克隆到 {parentDir}/{repoNameFromUrl(url.trim())}
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end pt-1">
        <TextButton primary disabled={!url.trim() || !parentDir || busy} onClick={() => void clone()}>
          {busy ? "克隆中…" : "克隆并打开"}
        </TextButton>
      </div>
    </div>
  );
}

/** Workspace with no synced remote yet: init + attach, or go local-only. */
function AttachSection({
  ws,
  isRepo,
  onAttached,
}: {
  ws: string;
  /** Already a local repo (local-only mode) — offer attaching a remote only. */
  isRepo: boolean;
  onAttached: () => Promise<void>;
}) {
  const requestGitCredential = useAppStore((s) => s.requestGitCredential);
  const [url, setUrl] = useState("");
  const [proxy, setProxy] = useState(() => readGlobalProxy());
  const [busy, setBusy] = useState<"attach" | "local" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attach = async () => {
    if (!url.trim() || busy) return;
    setBusy("attach");
    setError(null);
    try {
      await attachRemote(ws, url.trim(), proxy, requestGitCredential);
      // Persist the proxy globally so subsequent syncs reuse it without re-entry.
      saveGlobalProxy(proxy);
      emit(GIT_PROXY_EVENT, { proxy }).catch(() => {});
      emit(GIT_ATTACHED_EVENT, { workspace: ws }).catch(() => {});
      await onAttached();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const initLocal = async () => {
    if (busy) return;
    setBusy("local");
    setError(null);
    try {
      await initLocalRepo(ws);
      // Same event as attaching: the main window re-probes git info, which
      // makes the title-bar sync button appear.
      emit(GIT_ATTACHED_EVENT, { workspace: ws }).catch(() => {});
      await onAttached();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="space-y-3 rounded-xl p-4"
      style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
    >
      <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>
        {isRepo
          ? "关联远程仓库后即可在多台设备间同步（远程已有内容会自动合并进来）："
          : `「${basename(ws)}」尚未开启同步。关联远程仓库可在多台设备间同步（远程已有内容会自动合并进来）；也可以仅本地使用，把修改提交为本地版本快照：`}
      </div>
      <Field label="远程仓库地址">
        <Input
          value={url}
          placeholder="git@github.com:user/notes.git 或 https://…"
          onChange={setUrl}
        />
      </Field>
      <Field label="同步代理（全局，所有笔记库共用，仅 HTTPS）">
        <Input
          value={proxy}
          placeholder="http://127.0.0.1:7890（留空不使用）"
          onChange={setProxy}
        />
      </Field>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex items-center justify-end gap-2 pt-1">
        {!isRepo && (
          <TextButton disabled={!!busy} onClick={() => void initLocal()}>
            {busy === "local" ? "初始化中…" : "仅本地使用"}
          </TextButton>
        )}
        <TextButton primary disabled={!url.trim() || !!busy} onClick={() => void attach()}>
          {busy === "attach" ? "关联中…" : "关联并初始化"}
        </TextButton>
      </div>
    </div>
  );
}

/** Synced workspace: remote info (unless local-only), manual sync, auto-sync schedule. */
function ConnectedSection({
  ws,
  src,
  info,
  sync,
  local,
  onChanged,
}: {
  ws: string;
  src: string;
  info: GitInfo;
  sync: { syncState: SyncState; lastSyncMessage: string | null; lastSyncAt: number | null };
  /** Local-only mode (no remote): hide the remote URL / proxy rows. */
  local: boolean;
  onChanged: () => Promise<void>;
}) {
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [config, setConfig] = useState<SyncConfig>(() => readSyncConfig(ws));
  useEffect(() => setConfig(readSyncConfig(ws)), [ws]);
  // The proxy is global (shared by all workspaces), not part of SyncConfig.
  const [proxy, setProxy] = useState(() => readGlobalProxy());
  // Reflect proxy edits made from another window/section.
  useEffect(() => {
    const un = listen<{ proxy: string }>(GIT_PROXY_EVENT, ({ payload }) =>
      setProxy(payload.proxy),
    );
    return () => void un.then((f) => f());
  }, []);

  const updateConfig = (patch: Partial<SyncConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveSyncConfig(ws, next);
    emit(SYNC_CONFIG_EVENT, { workspace: ws }).catch(() => {});
  };

  const updateProxy = (next: string) => {
    setProxy(next);
    saveGlobalProxy(next);
    emit(GIT_PROXY_EVENT, { proxy: next }).catch(() => {});
  };

  const saveUrl = async () => {
    const url = editingUrl?.trim();
    if (!url) return;
    const out = await gitRun(ws, ["remote", "set-url", "origin", url]);
    if (out.code !== 0) {
      setUrlError(out.stderr.trim().split("\n")[0] || "修改失败");
      return;
    }
    setUrlError(null);
    setEditingUrl(null);
    emit(GIT_ATTACHED_EVENT, { workspace: ws }).catch(() => {});
    await onChanged();
  };

  const syncing = sync.syncState === "syncing";
  const statusColor =
    sync.syncState === "error"
      ? "var(--danger, #ef4444)"
      : sync.syncState === "conflict"
        ? "#d97706"
        : "var(--text-muted)";

  return (
    <>
      <Card>
        {local ? (
          <Row title="同步方式" desc="修改提交到本地 git 仓库作为版本快照，不会推送到任何远程">
            <span className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-soft)" }}>
              <FolderOpen size={13} />
              仅本地
            </span>
          </Row>
        ) : (
          <Row title="远程地址" desc={editingUrl === null ? (info.remoteUrl ?? "") : undefined}>
            {editingUrl === null ? (
              <IconButton title="修改远程地址" onClick={() => setEditingUrl(info.remoteUrl ?? "")}>
                <Pencil size={15} />
              </IconButton>
            ) : (
              <div className="flex w-[300px] items-center gap-1">
                <Input value={editingUrl} onChange={setEditingUrl} />
                <IconButton title="保存" onClick={() => void saveUrl()}>
                  <Check size={15} />
                </IconButton>
                <IconButton title="取消" onClick={() => { setEditingUrl(null); setUrlError(null); }}>
                  <X size={15} />
                </IconButton>
              </div>
            )}
          </Row>
        )}
        {urlError && (
          <div className="px-4 py-2 text-[11px]" style={{ color: "var(--danger, #ef4444)" }}>
            {urlError}
          </div>
        )}
        <Row title="当前分支">
          <span className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-soft)" }}>
            <GitBranch size={13} />
            {info.branch ?? "—"}
          </span>
        </Row>
        <Row
          title="立即同步"
          desc={
            (sync.lastSyncMessage ?? SYNC_STATE_LABEL[sync.syncState]) +
            (sync.lastSyncAt
              ? ` · ${new Date(sync.lastSyncAt).toLocaleTimeString("zh-CN", { hour12: false })}`
              : "")
          }
        >
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
            <TextButton
              primary
              disabled={syncing}
              onClick={() => emit(SYNC_REQUEST_EVENT, { target: src }).catch(() => {})}
            >
              {syncing ? "同步中…" : "同步"}
            </TextButton>
          </div>
        </Row>
      </Card>

      <Card>
        <Row title="自动同步" desc="按固定间隔在后台自动执行同步">
          <Toggle checked={config.autoSync} onChange={(autoSync) => updateConfig({ autoSync })} />
        </Row>
        <Row
          title="同步间隔"
          desc={config.autoSync ? "两次自动同步之间的时间" : "开启自动同步后按此频率执行"}
        >
          <Stepper
            value={config.intervalMin}
            min={1}
            max={60}
            step={1}
            format={(v) => `${v}分钟`}
            onChange={(intervalMin) => updateConfig({ intervalMin })}
          />
        </Row>
        {!local && (
          <Row title="同步代理" desc="全局设置，所有笔记库共用；仅同步时经此 HTTP 代理，不写入 git 全局配置">
            <div className="w-[260px]">
              <Input
                value={proxy}
                placeholder="http://127.0.0.1:7890（留空不使用）"
                onChange={updateProxy}
              />
            </div>
          </Row>
        )}
      </Card>

      <CommitMessageCard ws={ws} />

      <div className="px-1 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {local
          ? "同步流程：将本地修改提交到本地 git 仓库，作为版本快照；关联远程后即可在多台设备间同步。"
          : "同步流程：先提交本地修改，再拉取远程并合并，最后推送。两端改动同一处时，双方内容都会保留在文件中（以 <<<<<<< 标记区分），整理后再次同步即可。"}
      </div>
    </>
  );
}

/** Sync commit message: default timestamp, or AI-generated from the diff with
 *  an optional natural-language commit spec fed into the prompt. The whole
 *  config is global (all workspaces share it), like the sync proxy; `ws` is
 *  only the SYNC_CONFIG_EVENT payload so main windows re-read the cache. */
function CommitMessageCard({ ws }: { ws: string }) {
  const aiModels = useAppStore((s) => s.aiModels);
  const [config, setConfig] = useState<CommitMessageConfig>(readCommitMessageConfig);

  const update = (patch: Partial<CommitMessageConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveCommitMessageConfig(next);
    emit(SYNC_CONFIG_EVENT, { workspace: ws }).catch(() => {});
  };

  const modelOptions = aiModels.flatMap((m) =>
    modelIdsOf(m).map((id) => ({
      value: modelSelectionKey(m.id, id),
      label: modelSelectionLabel(m, id),
    })),
  );
  // A stale selection (model deleted) falls back to the first configured one —
  // same as the sync itself does.
  const modelValue =
    config.model && modelOptions.some((o) => o.value === config.model)
      ? config.model
      : (firstModelSelection(aiModels) ?? "");

  return (
    <Card>
      <Row
        title="提交文案"
        desc={
          (config.mode === "ai"
            ? "由 AI 阅读本次改动生成提交说明，生成失败时退回默认文案"
            : "使用默认时间戳文案，如 sync: 2026/7/5 14:30:00") + "；全局设置，所有笔记库共用"
        }
      >
        <div className="w-[150px]">
          <Select
            value={config.mode}
            options={[
              { value: "default", label: "默认（时间）" },
              { value: "ai", label: "AI 生成" },
            ]}
            onChange={(v) => update({ mode: v as CommitMessageConfig["mode"] })}
          />
        </div>
      </Row>
      {config.mode === "ai" && (
        <>
          <Row
            title="生成模型"
            desc={
              modelOptions.length > 0
                ? "用于生成提交文案的模型"
                : "尚未配置 AI 模型，请先在「AI笔记助手」中添加，否则使用默认文案"
            }
          >
            {modelOptions.length > 0 && (
              <div className="w-[220px]">
                <Select
                  value={modelValue}
                  options={modelOptions}
                  onChange={(model) => update({ model })}
                />
              </div>
            )}
          </Row>
          <div className="px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
              提交规范
            </div>
            <div className="mb-2 mt-0.5 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
              用自然语言描述提交文案的要求，会作为提示词交给 AI；留空则由 AI 自行概括改动
            </div>
            <textarea
              value={config.convention}
              placeholder={"例如：以「笔记:」开头，用一句话概括本次改动，不超过 30 字"}
              onChange={(e) => update({ convention: e.target.value })}
              className="min-h-[64px] w-full resize-y rounded-lg px-2.5 py-2 text-[13px] leading-5 outline-none"
              style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
            />
          </div>
        </>
      )}
    </Card>
  );
}

/** Inline notice banner (info by default, red for danger). */
function Notice({ tone, children }: { tone?: "danger"; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl px-4 py-3 text-[12px] leading-relaxed"
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        color: tone === "danger" ? "var(--danger, #ef4444)" : "var(--text-soft)",
      }}
    >
      {children}
    </div>
  );
}

/* --------------------------- attachments tab --------------------------- */

/**
 * The "图片/附件" tab: where files pasted into a markdown note are written.
 * The config is per workspace (persisted in sync-config.json, keyed by the
 * opener window's workspace), so it needs an open workspace to edit. Images and
 * attachments are configured independently; each can save beside the note,
 * under the workspace root, or in a fixed absolute folder.
 */
function AttachmentsTab() {
  const [ws, setWs] = useState<string | null>(() => readSyncContext().ws);
  // Track the opener workspace when an open settings window is refocused.
  useEffect(() => {
    const un = listen<{ ws: string | null }>(SETTINGS_CONTEXT_EVENT, ({ payload }) =>
      setWs(payload.ws),
    );
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const [config, setConfig] = useState<AttachmentConfig>(() => readAttachmentConfig(ws));
  // readAttachmentConfig / saveAttachmentConfig read the in-memory cache; warm it
  // before rendering the editable cards so a save can't clobber the sibling sync
  // config off a cold cache (same guard as SyncTab).
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureSyncConfigsLoaded().then(() => {
      if (!alive) return;
      setConfig(readAttachmentConfig(ws));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [ws]);

  if (!ws) {
    return (
      <Notice>图片 / 附件目录按工程分别保存。请先在主窗口打开一个工程，再回到这里配置。</Notice>
    );
  }
  if (!loaded) return null;

  const update = (patch: Partial<AttachmentConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveAttachmentConfig(ws, next);
    emit(SYNC_CONFIG_EVENT, { workspace: ws }).catch(() => {});
  };

  return (
    <div className="space-y-4">
      <LocationCard
        title="图片"
        desc="在笔记中粘贴截图或图片文件时的保存位置"
        location={config.imageLocation}
        dir={config.imageDir}
        onLocation={(imageLocation) => update({ imageLocation })}
        onDir={(imageDir) => update({ imageDir })}
      />
      <LocationCard
        title="附件"
        desc="粘贴非图片文件（PDF、压缩包等）时的保存位置"
        location={config.attachmentLocation}
        dir={config.attachmentDir}
        onLocation={(attachmentLocation) => update({ attachmentLocation })}
        onDir={(attachmentDir) => update({ attachmentDir })}
      />

      <div className="px-1 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        以上配置仅作用于当前工程，随工程单独保存。在 Markdown 中粘贴剪贴板里的图片或文件时，真实文件会保存到上面的目录，笔记中插入对应的引用（图片为 <code>![](…)</code>，附件为 <code>[文件名](…)</code>）。
        <br />
        笔记目录 / 工程目录模式插入相对链接，便于随仓库同步；绝对目录模式插入绝对路径。粘贴到工程目录或笔记目录时需先保存笔记。
      </div>
    </div>
  );
}

/** One file-kind's save-location config: a location selector + path field. */
function LocationCard({
  title,
  desc,
  location,
  dir,
  onLocation,
  onDir,
}: {
  title: string;
  desc: string;
  location: AttachmentLocation;
  dir: string;
  onLocation: (location: AttachmentLocation) => void;
  onDir: (dir: string) => void;
}) {
  const isAbs = location === "absolute";

  const pickAbsolute = async () => {
    const selected = await open({ directory: true, multiple: false, title: "选择目录" });
    if (typeof selected === "string") onDir(selected);
  };

  return (
    <Card>
      <Row title={title} desc={desc}>
        <div className="w-[148px]">
          <Select
            value={location}
            options={[
              { value: "relative", label: "笔记目录" },
              { value: "project", label: "工程目录" },
              { value: "absolute", label: "绝对目录" },
            ]}
            onChange={(v) => onLocation(v as AttachmentLocation)}
          />
        </div>
      </Row>
      <Row
        title={isAbs ? "绝对路径" : "子目录"}
        desc={
          isAbs
            ? "文件保存到该绝对目录"
            : location === "project"
              ? "相对工程根目录，如 assets/images"
              : "相对笔记所在目录，如 assets/images"
        }
      >
        <div className="flex w-[260px] items-center gap-1">
          <Input
            value={dir}
            placeholder={isAbs ? "/Users/you/notes-assets" : "assets/images"}
            onChange={onDir}
          />
          {isAbs && (
            <IconButton title="选择目录" onClick={() => void pickAbsolute()}>
              <FolderOpen size={15} />
            </IconButton>
          )}
        </div>
      </Row>
    </Card>
  );
}

/* ------------------------------ models tab ------------------------------ */

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic",
};
const DEFAULT_BASE_URL: Record<AiProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

type Draft = { label: string; provider: AiProvider; baseUrl: string; model: string; apiKey: string };

const emptyDraft: Draft = {
  label: "",
  provider: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
};

function ModelsTab({
  aiAssistantFontSize,
  setAiAssistantFontSize,
}: {
  aiAssistantFontSize: number;
  setAiAssistantFontSize: (size: number) => void;
}) {
  const aiModels = useAppStore((s) => s.aiModels);
  const addAiModel = useAppStore((s) => s.addAiModel);
  const updateAiModel = useAppStore((s) => s.updateAiModel);
  const removeAiModel = useAppStore((s) => s.removeAiModel);

  // null = form closed; "new" = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const openNew = () => {
    setDraft(emptyDraft);
    setFetchError(null);
    setEditing("new");
  };
  const openEdit = (m: AiModel) => {
    setDraft({
      label: m.label,
      provider: m.provider,
      baseUrl: m.baseUrl,
      model: modelIdsOf(m).join("\n"),
      apiKey: m.apiKey,
    });
    setFetchError(null);
    setEditing(m.id);
  };
  const close = () => {
    setFetchError(null);
    setEditing(null);
  };

  const modelIds = parseModelIds(draft.model);
  const canSave = draft.label.trim() && draft.baseUrl.trim() && modelIds.length > 0;

  const save = async () => {
    if (!canSave) return;
    const baseFields = {
      label: draft.label.trim(),
      provider: draft.provider,
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: modelIds[0],
      models: modelIds,
    };
    if (editing === "new") await addAiModel({ id: uid(), ...baseFields });
    else if (editing) await updateAiModel(editing, baseFields);
    close();
  };

  const fetchModels = async () => {
    if (!draft.baseUrl.trim()) {
      setFetchError("请先填写 Base URL");
      return;
    }
    setFetchingModels(true);
    setFetchError(null);
    try {
      const models = await fetchUpstreamModels({
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
      });
      if (models.length === 0) {
        setFetchError("上游没有返回模型 ID");
        return;
      }
      setDraft((d) => ({ ...d, model: models.join("\n") }));
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <Row title="AI 笔记助手字号" desc="调整右侧 AI 面板中的文字大小">
          <Stepper
            value={aiAssistantFontSize}
            min={11}
            max={18}
            step={1}
            format={(v) => `${v}px`}
            onChange={setAiAssistantFontSize}
          />
        </Row>
      </Card>

      {aiModels.length === 0 && editing === null && (
        <div
          className="rounded-xl px-4 py-8 text-center text-[12px]"
          style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
        >
          还没有配置模型。添加一个后即可在右侧栏的 AI 聊天里使用。
        </div>
      )}

      {aiModels.length > 0 && (
        <Card>
          {aiModels.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3" style={{ borderColor: "var(--border)" }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium" style={{ color: "var(--text)" }}>
                    {m.label}
                  </span>
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                    style={{ background: "var(--active)", color: "var(--accent)" }}
                  >
                    {PROVIDER_LABEL[m.provider]}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {modelIdsOf(m).join(", ")} · {maskKey(m.apiKey)}
                </div>
              </div>
              {confirmDelete === m.id ? (
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>删除？</span>
                  <IconButton title="确认删除" onClick={() => { void removeAiModel(m.id); setConfirmDelete(null); }}>
                    <Check size={15} />
                  </IconButton>
                  <IconButton title="取消" onClick={() => setConfirmDelete(null)}>
                    <X size={15} />
                  </IconButton>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton title="编辑" onClick={() => openEdit(m)}>
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton title="删除" onClick={() => setConfirmDelete(m.id)}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {editing !== null ? (
        <div
          className="space-y-3 rounded-xl p-4"
          style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
        >
          <Field label="名称">
            <Input value={draft.label} placeholder="例如 DeepSeek" onChange={(v) => setDraft({ ...draft, label: v })} />
          </Field>
          <Field label="类型">
            <Select
              value={draft.provider}
              options={[
                { value: "openai", label: PROVIDER_LABEL.openai },
                { value: "anthropic", label: PROVIDER_LABEL.anthropic },
              ]}
              onChange={(v) => {
                const provider = v as AiProvider;
                setDraft({ ...draft, provider });
              }}
            />
          </Field>
          <Field label="Base URL">
            <Input value={draft.baseUrl} placeholder={DEFAULT_BASE_URL[draft.provider]} onChange={(v) => setDraft({ ...draft, baseUrl: v })} />
          </Field>
          <Field label="API Key">
            <Input value={draft.apiKey} password placeholder="sk-..." onChange={(v) => setDraft({ ...draft, apiKey: v })} />
          </Field>
          <Field
            label="模型 ID"
            action={
              <IconButton title="从上游获取" onClick={() => void fetchModels()} disabled={fetchingModels}>
                <DownloadCloud size={14} className={fetchingModels ? "animate-pulse" : ""} />
              </IconButton>
            }
          >
            <ModelIdsInput
              value={draft.model}
              placeholder={draft.provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o"}
              onChange={(v) => setDraft({ ...draft, model: v })}
            />
            {fetchError && (
              <div className="mt-1 text-[11px]" style={{ color: "var(--danger, #ef4444)" }}>
                {fetchError}
              </div>
            )}
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <TextButton onClick={close}>取消</TextButton>
            <TextButton primary disabled={!canSave} onClick={() => void save()}>
              保存
            </TextButton>
          </div>
        </div>
      ) : (
        <button
          onClick={openNew}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13px] font-medium transition-colors"
          style={{ border: "1px dashed var(--border)", color: "var(--text-soft)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Plus size={15} />
          添加模型
        </button>
      )}
    </div>
  );
}

function maskKey(key: string): string {
  if (!key) return "未设置 Key";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function parseModelIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,，]+/)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  );
}

function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[12px] font-medium" style={{ color: "var(--text-soft)" }}>
          {label}
        </span>
        {action}
      </div>
      {children}
    </label>
  );
}

function ModelIdsInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      placeholder={`${placeholder}\n每行一个，或用逗号分隔`}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-[76px] w-full resize-y rounded-lg px-2.5 py-2 text-[13px] leading-5 outline-none"
      style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
      onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
      onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
    />
  );
}

function Input({
  value,
  onChange,
  placeholder,
  password,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <input
      type={password ? "password" : "text"}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-lg px-2.5 text-[13px] outline-none"
      style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
      onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
      onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
    />
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-lg px-2 text-[13px] outline-none"
      style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function TextButton({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-40"
      style={{
        background: primary ? "var(--accent)" : "transparent",
        color: primary ? "#fff" : "var(--text-soft)",
        border: primary ? "none" : "1px solid var(--border)",
      }}
    >
      {children}
    </button>
  );
}

/* ----------------------------- primitives ----------------------------- */

function NavItem({
  tab,
  active,
  onClick,
}: {
  tab: Tab;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors"
      style={{
        background: active ? "var(--active)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-soft)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <span className="shrink-0">{tab.icon}</span>
      <span className="text-[13px] font-medium">{tab.label}</span>
    </button>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40"
      style={{ color: "var(--text-muted)" }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

/** A grouped list container. Direct children (rows) get hairline dividers. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-xl [&>*+*]:border-t"
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-3"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>
          {title}
        </div>
        {desc && (
          <div className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
            {desc}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Preview({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div
        className="rounded-xl p-4"
        style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
      >
        {children}
      </div>
    </div>
  );
}

function Stepper({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  // Snap to the step grid to avoid float drift (e.g. 1.7500000000001).
  const snap = (n: number) => Math.round(n / step) * step;

  return (
    <div
      className="flex h-8 items-center overflow-hidden rounded-lg"
      style={{ border: "1px solid var(--border)", background: "var(--bg)" }}
    >
      <StepButton disabled={value <= min} onClick={() => onChange(snap(value - step))}>
        <Minus size={14} />
      </StepButton>
      <span
        className="w-[52px] select-none text-center text-[13px] font-medium tabular-nums"
        style={{ color: "var(--text)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)" }}
      >
        {format(value)}
      </span>
      <StepButton disabled={value >= max} onClick={() => onChange(snap(value + step))}>
        <Plus size={14} />
      </StepButton>
    </div>
  );
}

function StepButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex h-full w-8 items-center justify-center transition-colors disabled:opacity-30"
      style={{ color: "var(--text-soft)" }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-[24px] w-[42px] shrink-0 items-center rounded-full transition-colors"
      style={{ background: checked ? "var(--accent)" : "var(--border)" }}
    >
      <span
        className="absolute h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: checked ? "translateX(20px)" : "translateX(2px)" }}
      />
    </button>
  );
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** The 外观 › 主题 block: a grid of theme tiles (built-in + custom), a tile for
 *  creating a new custom theme, import-from-file, and — when a custom theme is
 *  active — an inline colour editor. */
function ThemeSection({
  themeId,
  customThemes,
  setTheme,
  addCustomTheme,
  updateCustomTheme,
  deleteCustomTheme,
  showToast,
}: {
  themeId: string;
  customThemes: ThemeDef[];
  setTheme: (id: string) => void;
  addCustomTheme: (sourceId: string) => string;
  updateCustomTheme: (
    id: string,
    patch: Partial<Pick<ThemeDef, "name" | "dark">> & { colors?: Record<string, string> },
  ) => void;
  deleteCustomTheme: (id: string) => void;
  showToast: (message: string, tone?: "success" | "error") => void;
}) {
  const all = [...BUILTIN_THEMES, ...customThemes];
  const active = all.find((t) => t.id === themeId) ?? all[0];
  const editing = active.custom ? active : null;

  // Import one or more theme JSON files. Reuses the clone+patch actions so the store
  // surface stays small: clone the active theme, then overwrite it wholesale.
  const importTheme = async () => {
    let selected: string[] = [];
    try {
      const picked = await open({
        multiple: true,
        title: "选择主题 JSON",
        filters: [
          { name: "主题 JSON", extensions: ["json"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string") selected = [picked];
      else if (Array.isArray(picked)) selected = picked.filter((p): p is string => typeof p === "string");
      if (selected.length === 0) return;
    } catch {
      showToast("无法选择主题文件", "error");
      return;
    }

    const imported: string[] = [];
    let failed = 0;
    for (const path of selected) {
      try {
        const data = JSON.parse(await readFile(path));
        const def = normalizeCustomTheme(data, newThemeId());
        if (!def) {
          failed += 1;
          continue;
        }
        const id = addCustomTheme(active.id);
        updateCustomTheme(id, { name: def.name, dark: def.dark, colors: def.colors });
        imported.push(def.name);
      } catch {
        failed += 1;
      }
    }

    if (imported.length === 0) {
      showToast("没有找到可导入的主题", "error");
    } else if (failed > 0) {
      showToast(`已导入 ${imported.length} 个主题，${failed} 个失败`, "error");
    } else if (imported.length === 1) {
      showToast(`已导入主题「${imported[0]}」`);
    } else {
      showToast(`已导入 ${imported.length} 个主题`);
    }
  };

  const exportTheme = (t: ThemeDef) => {
    const json = JSON.stringify(
      { id: t.id, name: t.name, dark: t.dark, colors: t.colors },
      null,
      2,
    );
    void copyText(json);
    showToast("主题 JSON 已复制到剪贴板");
  };

  const downloadTemplate = async () => {
    let target: string | null = null;
    try {
      target = await save({
        title: "下载主题模板",
        defaultPath: "idea-note-theme-template.json",
        filters: [
          { name: "主题 JSON", extensions: ["json"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!target) return;
    } catch {
      showToast("无法选择保存位置", "error");
      return;
    }

    const json = JSON.stringify(
      {
        id: "my-theme",
        name: "我的主题",
        dark: active.dark,
        colors: active.colors,
      },
      null,
      2,
    );

    try {
      await writeFile(target, `${json}\n`);
      showToast("主题模板已下载");
    } catch {
      showToast("无法保存主题模板", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-0.5">
        <span
          className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide"
          style={{ color: "var(--text-muted)" }}
        >
          <Palette size={13} /> 主题
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={downloadTemplate}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors"
            style={{ color: "var(--text-soft)", border: "1px solid var(--border)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            title="下载可编辑的主题 JSON 模板"
          >
            <DownloadCloud size={13} /> 模板
          </button>
          <button
            onClick={importTheme}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors"
            style={{ color: "var(--text-soft)", border: "1px solid var(--border)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            title="选择 JSON 文件导入主题"
          >
            <Upload size={13} /> 导入
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {all.map((t) => (
          <ThemeTile
            key={t.id}
            theme={t}
            selected={t.id === themeId}
            onClick={() => setTheme(t.id)}
          />
        ))}
        <NewThemeTile onClick={() => addCustomTheme(active.id)} />
      </div>

      {editing && (
        <ThemeEditor
          theme={editing}
          onChange={(patch) => updateCustomTheme(editing.id, patch)}
          onDelete={() => deleteCustomTheme(editing.id)}
          onExport={() => exportTheme(editing)}
        />
      )}
    </div>
  );
}

/** A clickable theme preview tile rendering a miniature app window from the
 *  theme's own palette. */
function ThemeTile({
  theme,
  selected,
  onClick,
}: {
  theme: ThemeDef;
  selected: boolean;
  onClick: () => void;
}) {
  const k = theme.colors;
  const c = {
    bg: k["--bg"],
    side: k["--sidebar-bg"],
    bar: k["--bg-elev"],
    // --card-border reads better than the very faint --border at this size.
    line: k["--card-border"] || k["--border"],
    text: k["--text-muted"],
    accent: k["--accent"],
    activeRow: k["--active"],
  };

  return (
    <button
      onClick={onClick}
      className="flex flex-col gap-2.5 rounded-2xl p-2.5 text-left transition-all duration-150 hover:-translate-y-0.5"
      style={{
        background: "var(--bg-elev)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        boxShadow: selected
          ? "0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent), 0 4px 14px var(--shadow)"
          : "none",
      }}
      onMouseEnter={(e) => {
        if (!selected)
          e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.borderColor = "var(--border)";
      }}
    >
      {/* miniature app window: top bar, then sidebar + content */}
      <div
        className="flex aspect-[16/10] flex-col overflow-hidden rounded-lg"
        style={{ border: `1px solid ${c.line}`, background: c.bg }}
      >
        {/* title bar with mac traffic lights */}
        <div className="flex items-center gap-1 px-2" style={{ height: "18%", background: c.bar }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#ff5f57" }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#febc2e" }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#28c840" }} />
        </div>
        {/* body */}
        <div className="flex flex-1 overflow-hidden">
          {/* sidebar with an "active file" row */}
          <div className="flex w-[30%] flex-col gap-1 p-1.5" style={{ background: c.side }}>
            <span className="flex h-3.5 items-center rounded px-1" style={{ background: c.activeRow }}>
              <span className="h-1 w-3/4 rounded-full" style={{ background: c.accent }} />
            </span>
            <span className="flex h-3.5 items-center px-1">
              <span className="h-1 w-2/3 rounded-full" style={{ background: c.line }} />
            </span>
            <span className="flex h-3.5 items-center px-1">
              <span className="h-1 w-4/5 rounded-full" style={{ background: c.line }} />
            </span>
          </div>
          {/* editor: heading, body lines, accent "button" */}
          <div className="flex flex-1 flex-col gap-1.5 p-2.5">
            <span className="h-2 w-1/2 rounded" style={{ background: c.text }} />
            <span className="mt-0.5 h-1 w-full rounded-full" style={{ background: c.line }} />
            <span className="h-1 w-5/6 rounded-full" style={{ background: c.line }} />
            <span className="h-1 w-2/3 rounded-full" style={{ background: c.line }} />
            <span className="mt-auto h-2.5 w-9 self-end rounded-full" style={{ background: c.accent }} />
          </div>
        </div>
      </div>

      {/* label + radio */}
      <div className="flex items-center justify-between px-1 pb-0.5">
        <span
          className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium"
          style={{ color: selected ? "var(--text)" : "var(--text-soft)" }}
        >
          {theme.dark ? (
            <Moon size={14} className="shrink-0" style={{ color: "#8b9cf9" }} />
          ) : (
            <Sun size={14} className="shrink-0" style={{ color: "#f59e0b" }} />
          )}
          <span className="truncate">{theme.name}</span>
        </span>
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors"
          style={{
            background: selected ? "var(--accent)" : "transparent",
            border: selected ? "none" : "1.5px solid var(--border)",
            color: "#fff",
          }}
        >
          {selected && <Check size={11} strokeWidth={3} />}
        </span>
      </div>
    </button>
  );
}

/** Dashed tile that clones the active theme into a new editable custom theme. */
function NewThemeTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-1.5 rounded-2xl p-2.5 transition-all duration-150 hover:-translate-y-0.5"
      style={{ border: "1.5px dashed var(--border)", color: "var(--text-muted)", minHeight: 120 }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 50%, var(--border))";
        e.currentTarget.style.color = "var(--text-soft)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <Plus size={20} />
      <span className="text-[12px] font-medium">新建主题</span>
    </button>
  );
}

/** Inline editor for a custom theme: name, base mode, every colour token, plus
 *  export / delete. Edits are applied live to the running app. */
function ThemeEditor({
  theme,
  onChange,
  onDelete,
  onExport,
}: {
  theme: ThemeDef;
  onChange: (
    patch: Partial<Pick<ThemeDef, "name" | "dark">> & { colors?: Record<string, string> },
  ) => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  return (
    <div
      className="space-y-4 rounded-xl p-4"
      style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input value={theme.name} onChange={(v) => onChange({ name: v })} placeholder="主题名称" />
        </div>
        <button
          onClick={() => onChange({ dark: !theme.dark })}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors"
          style={{ border: "1px solid var(--border)", color: "var(--text-soft)" }}
          title="切换深/浅基底（影响差异高亮等跟随模式的细节）"
        >
          {theme.dark ? <Moon size={14} /> : <Sun size={14} />}
          {theme.dark ? "深色基底" : "浅色基底"}
        </button>
        <IconButton title="复制主题 JSON" onClick={onExport}>
          <Copy size={15} />
        </IconButton>
        <IconButton title="删除此主题" onClick={onDelete}>
          <Trash2 size={15} />
        </IconButton>
      </div>

      {THEME_TOKEN_GROUPS.map((g) => (
        <div key={g.group}>
          <div
            className="mb-2 text-[11px] font-medium uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            {g.group}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {g.tokens.map((tk) => (
              <ColorField
                key={tk.key}
                label={tk.label}
                value={theme.colors[tk.key] ?? ""}
                onChange={(v) => onChange({ colors: { [tk.key]: v } })}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A single token row: swatch + native colour picker + free-text value (so
 *  rgba() tokens like --shadow stay editable). */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const hex = HEX6.test(value) ? value : "#000000";
  return (
    <div className="flex items-center gap-2">
      <label
        className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-md"
        style={{ background: value || "transparent", border: "1px solid var(--border)" }}
        title="选择颜色"
      >
        <input
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          className="absolute -inset-1 cursor-pointer opacity-0"
        />
      </label>
      <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text-soft)" }}>
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-6 w-[96px] rounded-md px-1.5 text-[11px] tabular-nums outline-none"
        style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
        onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
        onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
      />
    </div>
  );
}
