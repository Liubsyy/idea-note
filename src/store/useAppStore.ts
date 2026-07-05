import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  WebviewWindow,
  getAllWebviewWindows,
} from "@tauri-apps/api/webviewWindow";
import {
  type ActiveFormats,
  emptyFormats,
} from "../lib/codemirror/activeFormats";
import { isWindows } from "../lib/platform";
import {
  FileNode,
  listDir,
  readFile,
  fileStat,
  writeFile,
  pickWorkspace,
  pickSavePath,
  createFile,
  createRawFile,
  createFolder,
  deletePath,
  renamePath,
  movePath,
  dirname,
  basename,
  isImageFile,
  findNode,
} from "../lib/fs";
import {
  globalSearchStream,
  stopGlobalSearch as stopGlobalSearchBackend,
  type GlobalSearchHit,
  type SearchOptions,
} from "../lib/search";
import { loadModels, saveModels } from "../lib/ai/config";
import type { AiModel } from "../lib/ai/types";
import { generateCommitMessage } from "../lib/ai/commitMessage";
import { firstModelSelection, resolveModelSelection } from "../lib/ai/modelSelection";
import {
  discardWorkingChanges,
  getRepoRoot,
  getGitInfo,
  listWorkingChanges,
  restoreWorkspaceToCommit,
  syncWorkspace,
  type CommitFile,
  type CommitMessageProvider,
  type FileCommit,
  type GitCredential,
  type GitCredentialProvider,
  type GitInfo,
} from "../lib/git";

import {
  BUILTIN_THEMES,
  applyThemeColors,
  canonicalThemeId,
  makeCustomTheme,
  newThemeId,
  normalizeCustomTheme,
  resolveTheme,
  type ThemeDef,
} from "../themes";

export type { AiModel, AiProvider } from "../lib/ai/types";
export type { ThemeDef } from "../themes";

/** A theme's base mode — drives the `.dark` class and the editor syntax
 *  baseline. The *selected* theme is identified by `themeId`; this is just the
 *  light/dark flavour derived from it. */
type Theme = "light" | "dark";

/** Which list the sidebar shows: file tree, markdown notes, outline, or
 *  workspace-wide search. */
export type SidebarMode = "files" | "notes" | "outline" | "search";

/** Layout of the sidebar's notes mode: time-sorted cards or the folder tree. */
export type NotesViewMode = "cards" | "tree";

/**
 * Markdown editor view mode:
 * - "live": Typora hybrid preview, editable
 * - "source": raw markdown source, editable
 * - "readonly": Typora preview rendered but locked (no editing)
 */
export type MdViewMode = "live" | "source" | "readonly";

/**
 * Where a pasted image / attachment file is written, and how its markdown link
 * is formed:
 * - "relative": a sub-folder beside the current note (link relative to it)
 * - "project": a sub-folder under the workspace root (link relative to the note)
 * - "absolute": a fixed absolute folder (link is the absolute path)
 */
export type AttachmentLocation = "relative" | "project" | "absolute";

interface AppSettings {
  /** Id of the selected theme (built-in or custom). Source of truth for which
   *  palette is active; `appearanceMode` is the base mode derived from it. */
  themeId: string;
  /** User-created themes, persisted alongside the rest of the settings. */
  customThemes: ThemeDef[];
  appearanceMode: Theme;
  editorFontSize: number;
  editorLineHeight: number;
  editorLineNumbers: boolean;
  /** Editor body font. The persisted value is an `EDITOR_FONT_OPTIONS` key
   *  (`""` = system default); the actual CSS stack is resolved by editorFontStack. */
  editorFontFamily: string;
  /** Multiplier scaling every heading level together (1 = default). */
  editorHeadingScale: number;
  /** How many files may be open in the editor tab strip at once. */
  editorMaxTabs: number;
  aiAssistantFontSize: number;
  compactSidebar: boolean;
  /** Tighten the editor's vertical rhythm (line spacing + heading padding). */
  compactEditor: boolean;
  /** Whole-UI zoom factor for every app window (1 = 100%). */
  uiZoom: number;
  /** Per-mode sidebar list font sizes (px). */
  sidebarFilesFontSize: number;
  sidebarNotesFontSize: number;
  sidebarOutlineFontSize: number;
  /** Editor keyboard-shortcut overrides: command id -> key (CodeMirror notation).
   *  Absent ids fall back to their built-in default. See lib/codemirror/keybindings. */
  editorKeybindings: Record<string, string>;
}

/** The system default editor font stack — the chosen font (if any) is prepended
 *  before it so a font that isn't installed degrades gracefully. */
export const EDITOR_FONT_DEFAULT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

/** Editor body font choices shown in Settings › 编辑器. `value` is what's
 *  persisted (`""` = system default); `stack` is the CSS font-family applied,
 *  always ending in a system fallback so an absent font still renders. */
export const EDITOR_FONT_OPTIONS: { value: string; label: string; stack: string }[] = [
  { value: "", label: "系统默认", stack: EDITOR_FONT_DEFAULT_STACK },
  { value: "PingFang SC", label: "苹方 / PingFang", stack: `"PingFang SC", ${EDITOR_FONT_DEFAULT_STACK}` },
  { value: "Microsoft YaHei", label: "微软雅黑 / YaHei", stack: `"Microsoft YaHei", ${EDITOR_FONT_DEFAULT_STACK}` },
  { value: "Source Han Sans", label: "思源黑体", stack: `"Source Han Sans SC", "Noto Sans CJK SC", ${EDITOR_FONT_DEFAULT_STACK}` },
  { value: "Source Han Serif", label: "思源宋体", stack: `"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif` },
  { value: "Songti", label: "宋体", stack: `"Songti SC", STSong, SimSun, serif` },
  { value: "Kaiti", label: "楷体", stack: `"Kaiti SC", STKaiti, KaiTi, serif` },
  { value: "Heiti", label: "黑体", stack: `"Heiti SC", STHeiti, SimHei, sans-serif` },
  { value: "Georgia", label: "Georgia（衬线）", stack: `Georgia, "Times New Roman", "Songti SC", SimSun, serif` },
  { value: "monospace", label: "等宽 / Monospace", stack: `ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, "Songti SC", monospace` },
];

/** Resolve a persisted font key to its CSS font-family stack, falling back to
 *  the system default for unknown keys (e.g. an option removed in a later build). */
export function editorFontStack(value: string): string {
  return (EDITOR_FONT_OPTIONS.find((o) => o.value === value) ?? EDITOR_FONT_OPTIONS[0]).stack;
}

export const HEADING_SCALE_MIN = 0.7;
export const HEADING_SCALE_MAX = 1.6;
export const HEADING_SCALE_DEFAULT = 1;

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.5;
const EDITOR_MAX_TABS_MIN = 1;
const EDITOR_MAX_TABS_MAX = 20;
const EDITOR_MAX_TABS_DEFAULT = 5;
const SIDEBAR_FONT_MIN = 11;
const SIDEBAR_FONT_MAX = 20;
const SIDEBAR_FONT_DEFAULT = 14;
const AI_ASSISTANT_FONT_MIN = 11;
const AI_ASSISTANT_FONT_MAX = 18;
const AI_ASSISTANT_FONT_DEFAULT = 13;
const IMAGE_DIR_DEFAULT = "assets/images";
const ATTACHMENT_DIR_DEFAULT = "assets/files";

function sanitizeLocation(v: unknown, fb: AttachmentLocation): AttachmentLocation {
  return v === "relative" || v === "project" || v === "absolute" ? v : fb;
}
const RIGHT_PANEL_MIN_WIDTH = 220;
const RIGHT_PANEL_MAX_RATIO = 0.9;

/**
 * An in-app text prompt. Tauri's WKWebView does not implement
 * `window.prompt` (only alert/confirm), so naming dialogs go through this.
 */
export interface PromptRequest {
  title: string;
  defaultValue: string;
  onSubmit: (value: string) => void | Promise<void>;
}

export interface GitCredentialPromptRequest {
  dir: string;
  remoteUrl: string;
  defaultUsername: string;
  message: string;
  onSubmit: (credential: GitCredential) => void;
  onCancel: () => void;
}

/** An in-app confirmation dialog (WKWebView's window.confirm is unreliable). */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** Label of the primary action button, e.g. "删除". */
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  /** Primary button color: destructive red unless set to "primary" (accent). */
  tone?: "danger" | "primary";
  /** Optional second action button (neutral styling), e.g. "新窗口". */
  altLabel?: string;
  onAlt?: () => void | Promise<void>;
}

/** Remote-sync lifecycle for the title-bar button / settings page. */
export type SyncState = "idle" | "syncing" | "success" | "conflict" | "error";

/** A transient toast notification (e.g. sync finished). */
export interface ToastRequest {
  /** Monotonic id so repeated identical messages still restart the timer. */
  id: number;
  message: string;
  tone: "success" | "error";
}

/** Per-workspace auto-sync preferences (manual sync always works). The HTTP
 *  proxy and the commit-message settings are global (shared by all
 *  workspaces) — see readGlobalProxy / readCommitMessageConfig. */
export interface SyncConfig {
  autoSync: boolean;
  intervalMin: number;
}

/** Global sync commit-message settings (shared by all workspaces). */
export interface CommitMessageConfig {
  /** "default" = timestamp (sync: …), "ai" = generated from the staged diff
   *  by the model below (falls back to timestamp on any failure). */
  mode: "default" | "ai";
  /** AI model selection key (see modelSelection.ts); null = first configured. */
  model: string | null;
  /** Natural-language commit spec fed to the AI prompt verbatim ("" = none). */
  convention: string;
}

interface AppState {
  workspacePath: string | null;
  tree: FileNode[];
  sidebarMode: SidebarMode;
  /** Sub-mode of the sidebar's notes mode (persisted). */
  notesViewMode: NotesViewMode;
  /** Global-search (sidebar search mode) state. Lives in the store so the
   *  query and results survive sidebar-mode switches. */
  searchQuery: string;
  /** Case-sensitive / whole-word / regex input-box toggles (persisted). */
  searchOptions: SearchOptions;
  searchHits: GlobalSearchHit[];
  /** Total hits seen from the backend, including ones not kept for rendering. */
  searchTotalHits: number;
  /** True once the result list reaches its UI rendering limit. */
  searchDisplayLimited: boolean;
  searchTruncated: boolean;
  searchLoading: boolean;
  /** Invalid-regex message from the last search, or null. */
  searchRegexError: string | null;
  /** Bumped by openGlobalSearch so the panel re-focuses its input. */
  searchFocusKey: number;
  /**
   * Folder expand/collapse state, keyed by absolute path. Lives in the store
   * (not per-row local state) so it survives sidebar-mode switches, which
   * unmount and remount the tree. Absent key = default (top level open).
   */
  expanded: Record<string, boolean>;
  /** Recently opened workspaces, most recent first. */
  recentWorkspaces: string[];
  activeFilePath: string | null;
  /** Open editor tabs, in display order (insertion order). The active tab is
   *  `activeFilePath`. Only the active tab can be dirty — switching tabs saves
   *  first — so background tabs always match disk and re-read on activation. */
  openTabs: string[];
  /** Live content of every open "untitled" draft buffer, keyed by its sentinel
   *  path. Unlike real files (re-read from disk on tab activation), drafts have
   *  no disk backing, so their text is stashed here while in the background. */
  draftContents: Record<string, string>;
  /** Monotonic counter making each new draft's sentinel path unique. */
  draftSeq: number;
  /** Highlighted item in the tree (a file OR a folder). The anchor for
   *  multi-select; opening a file/folder resets to a single selection. */
  selectedPath: string | null;
  /** Multi-selection set for the tree (⌘/Ctrl-click, ⇧-click). Empty when only
   *  `selectedPath` is selected; otherwise the full highlighted set. */
  selectedPaths: string[];
  /** When set, the right pane shows this folder's contents listing. */
  folderViewPath: string | null;
  /** Markdown content of the active file, last persisted version. */
  content: string;
  /** Bumped whenever a new file is loaded, so the editor can reset. */
  docKey: number;
  isDirty: boolean;
  /** Cheap on-disk stat (mtime + byte size) of the active file as of the last
   *  load/save. Compared on window refocus to detect external edits without
   *  reading the file; null while loading or for draft/non-text files. */
  diskStat: { mtime: number; size: number } | null;
  saving: boolean;
  theme: Theme;
  appearanceMode: Theme;
  /** Selected theme id (built-in or custom). */
  themeId: string;
  /** User-created themes. */
  customThemes: ThemeDef[];
  editorFontSize: number;
  editorLineHeight: number;
  editorLineNumbers: boolean;
  editorFontFamily: string;
  editorHeadingScale: number;
  editorMaxTabs: number;
  aiAssistantFontSize: number;
  compactSidebar: boolean;
  compactEditor: boolean;
  uiZoom: number;
  sidebarFilesFontSize: number;
  sidebarNotesFontSize: number;
  sidebarOutlineFontSize: number;
  /** Editor keyboard-shortcut overrides (command id -> key). */
  editorKeybindings: Record<string, string>;
  /** Pasted image / attachment save locations (see AttachmentLocation). */
  imageLocation: AttachmentLocation;
  imageDir: string;
  attachmentLocation: AttachmentLocation;
  attachmentDir: string;
  sidebarOpen: boolean;
  /** Markdown editor view mode (Typora preview / raw source / read-only preview). */
  mdViewMode: MdViewMode;
  /** Bottom panel hosting the integrated terminal(s). */
  bottomPanelOpen: boolean;
  /** Bottom panel height in px (drag the top border to resize). */
  bottomPanelHeight: number;
  /** Right-hand utility panel (hosts the AI chat). */
  rightPanelOpen: boolean;
  /** Configured AI models, synced across windows via "ai-models:changed". */
  aiModels: AiModel[];
  /** Right utility panel width in px. */
  rightPanelWidth: number;
  /** Formatting active at the editor's current selection (toolbar highlight). */
  activeFormats: ActiveFormats;
  /** Pending in-app naming prompt, or null when none is open. */
  prompt: PromptRequest | null;
  /** Pending HTTPS git credential prompt, or null when none is open. */
  gitCredentialPrompt: GitCredentialPromptRequest | null;
  /** Pending in-app confirmation, or null when none is open. */
  confirm: ConfirmRequest | null;
  /** History modal: target path + kind, snapshotted at open time. "file" is
   *  the single-file view; "dir" covers a folder or the whole project. */
  history: { path: string; kind: "file" | "dir" } | null;
  /** Git status of the current workspace (null until probed / no workspace). */
  gitInfo: GitInfo | null;
  syncState: SyncState;
  lastSyncMessage: string | null;
  lastSyncAt: number | null;
  syncConfig: SyncConfig;
  /** Transient sync-result bubble by the title-bar sync button (auto-dismissed). */
  toast: ToastRequest | null;

  openWorkspace: () => Promise<void>;
  /** Open a specific workspace folder (used by the recent-projects menu). */
  openWorkspaceAt: (path: string) => Promise<void>;
  /** Close the current workspace, returning to the empty "no workspace" state. */
  closeWorkspace: () => Promise<void>;
  /** Close the workspace in every open window (broadcasts to all mains). */
  closeAllWorkspaces: () => Promise<void>;
  /** Reopen the last workspace from localStorage on app start. */
  restoreWorkspace: () => Promise<void>;
  setSidebarMode: (mode: SidebarMode) => void;
  setNotesViewMode: (mode: NotesViewMode) => void;
  setSearchQuery: (query: string) => void;
  /** Toggle one search option and re-run the current query immediately. */
  toggleSearchOption: (key: keyof SearchOptions) => void;
  /** Run the workspace-wide search now (the panel debounces calls to this). */
  runGlobalSearch: (query: string) => Promise<void>;
  /** Stop the current workspace-wide search and keep the results collected so far. */
  stopGlobalSearch: () => void;
  /** Switch the sidebar to search mode and focus the query input (⌘⇧F). */
  openGlobalSearch: () => void;
  /** Set a folder's expand/collapse state (persisted in `expanded`). */
  setExpanded: (path: string, open: boolean) => void;
  refreshTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  /** Select a folder: open its README.md if present, else show its listing. */
  openFolder: (node: FileNode) => Promise<void>;
  /** Close the active tab (saving it first if dirty), activating a neighbor. */
  closeFile: () => Promise<void>;
  /** Close one editor tab by path; activates a neighbor if the active one closes. */
  closeTab: (path: string) => Promise<void>;
  /** Close every tab except `path`, which becomes the active tab. */
  closeOtherTabs: (path: string) => Promise<void>;
  /** Close all open tabs, returning the editor to its empty state. */
  closeAllTabs: () => Promise<void>;
  /** Move an open tab from one index to another (drag-to-reorder). */
  reorderTabs: (from: number, to: number) => void;
  setContent: (markdown: string) => void;
  setActiveFormats: (formats: ActiveFormats) => void;
  save: () => Promise<void>;
  /** Re-read the active file from disk when the window regains focus: reload
   *  silently if the buffer is clean, prompt (keep / reload) if it has unsaved
   *  edits. No-op when nothing changed on disk. */
  checkExternalChange: () => Promise<void>;
  /** Open a new empty "untitled" editor tab with no file on disk yet. */
  newDraft: () => Promise<void>;
  /** Flush the active tab before switching away: write a dirty real file, or
   *  stash a draft's live text (no disk write, no prompt). Internal helper. */
  flushActiveTab: () => Promise<void>;
  newFile: (dir: string | null, name: string) => Promise<void>;
  newRawFile: (dir: string | null, name: string) => Promise<void>;
  newFolder: (dir: string | null, name: string) => Promise<void>;
  rename: (path: string, newName: string) => Promise<void>;
  /** Move `path` into `destDir` immediately (no dialog). */
  moveNode: (path: string, destDir: string) => Promise<void>;
  /** Move several paths into `destDir` immediately (no dialog). */
  moveNodes: (paths: string[], destDir: string) => Promise<void>;
  /** Drag-and-drop move with a confirmation dialog; no-ops if already there. */
  requestMove: (path: string, destDir: string) => void;
  /** Drag-and-drop move of several paths, with a count in the confirmation. */
  requestMoveMany: (paths: string[], destDir: string) => void;
  /** Replace the tree multi-selection (and the anchor). */
  setSelection: (paths: string[], anchor?: string | null) => void;
  /** ⌘/Ctrl-click: add/remove `path` from the selection. */
  toggleSelection: (path: string) => void;
  /** ⇧-click: select every visible row between the anchor and `path`. */
  selectRange: (path: string, visibleOrder: string[]) => void;
  /** Drop the multi-selection back to nothing. */
  clearSelection: () => void;
  /** Delete immediately (no dialog) — callers handle their own confirmation. */
  removeNow: (path: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  // In-app prompt: open with a request, the modal calls onSubmit / closePrompt.
  openPrompt: (req: PromptRequest) => void;
  requestGitCredential: GitCredentialProvider;
  requestNewFile: (dir?: string) => void;
  requestNewRawFile: (dir?: string) => void;
  requestNewFolder: (dir?: string) => void;
  requestRename: (path: string) => void;
  closePrompt: () => void;
  closeGitCredentialPrompt: () => void;
  openConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;
  /** Open the history modal: current file + global tabs when a file is open,
   *  otherwise the global project history. */
  openHistory: () => void;
  /** Open the history modal for a specific path (sidebar context menu). */
  openHistoryAt: (path: string, kind: "file" | "dir") => void;
  closeHistory: () => void;
  /** Overwrite the open file with an old version's content (after committing). */
  rollbackToVersion: (commit: FileCommit, oldContent: string) => Promise<void>;
  /** Restore the whole project to a commit snapshot without rewriting history. */
  rollbackWorkspaceToVersion: (commit: FileCommit) => Promise<void>;
  /** Discard selected uncommitted git changes from a history view. */
  discardHistoryChanges: (files: CommitFile[]) => Promise<void>;
  /** Open (or focus) the standalone settings window, optionally on a given tab
   *  (e.g. "sync" to jump straight to 远程同步). */
  openSettings: (tab?: string) => Promise<void>;
  /**
   * Open another full editor window; the current one stays as is. With no
   * argument the new window starts as an empty project, otherwise it opens
   * the given workspace folder.
   */
  openNewWindow: (workspacePath?: string) => Promise<void>;
  /** Pick a folder, then ask current-vs-new window and open it there. */
  requestOpenWorkspace: () => Promise<void>;
  /** Ask current-vs-new window, then open `path` there. */
  requestOpenWorkspaceAt: (path: string) => void;
  /** Select a theme by id (built-in or custom). */
  setTheme: (themeId: string) => void;
  /** Create a custom theme cloned from `sourceId`, select it, and return its id. */
  addCustomTheme: (sourceId: string) => string;
  /** Patch a custom theme (name / base mode / individual colours). */
  updateCustomTheme: (id: string, patch: Partial<Pick<ThemeDef, "name" | "dark">> & { colors?: Record<string, string> }) => void;
  /** Delete a custom theme; if it was active, fall back to light. */
  deleteCustomTheme: (id: string) => void;
  setEditorFontSize: (size: number) => void;
  setEditorLineHeight: (height: number) => void;
  setEditorFontFamily: (value: string) => void;
  setEditorHeadingScale: (scale: number) => void;
  setEditorLineNumbers: (show: boolean) => void;
  setEditorMaxTabs: (max: number) => void;
  /** Rebind an editor command, or clear its override (key=null) to restore the default. */
  setEditorKeybinding: (commandId: string, key: string | null) => void;
  /** Clear all editor-shortcut overrides, restoring every default. */
  resetEditorKeybindings: () => void;
  setAiAssistantFontSize: (size: number) => void;
  setCompactSidebar: (compact: boolean) => void;
  setCompactEditor: (compact: boolean) => void;
  setUiZoom: (zoom: number) => void;
  /** Set the list font size (px) for one sidebar mode. */
  setSidebarFontSize: (mode: SidebarMode, size: number) => void;
  /** Update the active workspace's pasted-image / attachment save locations. */
  setAttachmentSettings: (patch: Partial<AttachmentConfig>) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setMdViewMode: (mode: MdViewMode) => void;
  toggleBottomPanel: () => void;
  setBottomPanelHeight: (height: number) => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  addAiModel: (model: AiModel) => Promise<void>;
  updateAiModel: (id: string, patch: Partial<Omit<AiModel, "id">>) => Promise<void>;
  removeAiModel: (id: string) => Promise<void>;
  /** Re-probe the workspace's git status (after attaching a remote, etc.). */
  refreshGitInfo: () => Promise<void>;
  /** Run a full git sync of the current workspace (main windows only). */
  syncNow: () => Promise<void>;
  setSyncConfig: (patch: Partial<SyncConfig>) => void;
  showToast: (message: string, tone?: ToastRequest["tone"]) => void;
  dismissToast: () => void;
}

const THEME_KEY = "idea-note:theme";
const SETTINGS_KEY = "idea-note:settings";
const WORKSPACE_KEY = "idea-note:workspace";
const SIDEBAR_MODE_KEY = "idea-note:sidebar-mode";
const NOTES_VIEW_KEY = "idea-note:notes-view-mode";
const SEARCH_OPTIONS_KEY = "idea-note:search-options";
const RECENT_WORKSPACES_KEY = "idea-note:recent-workspaces";
const RECENT_MAX = 30;

function readSidebarMode(): SidebarMode {
  const raw = localStorage.getItem(SIDEBAR_MODE_KEY);
  return raw === "notes" || raw === "outline" || raw === "search" ? raw : "files";
}

function readSearchOptions(): SearchOptions {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEARCH_OPTIONS_KEY) ?? "{}");
    return {
      caseSensitive: !!parsed.caseSensitive,
      wholeWord: !!parsed.wholeWord,
      regex: !!parsed.regex,
    };
  } catch {
    return { caseSensitive: false, wholeWord: false, regex: false };
  }
}

function readNotesViewMode(): NotesViewMode {
  return localStorage.getItem(NOTES_VIEW_KEY) === "tree" ? "tree" : "cards";
}

function readRecents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_WORKSPACES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Move `path` to the front of the recent list (deduped, capped). */
function pushRecent(path: string): string[] {
  const recents = [path, ...readRecents().filter((p) => p !== path)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(recents));
  return recents;
}

function dropRecent(path: string): string[] {
  const recents = readRecents().filter((p) => p !== path);
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(recents));
  return recents;
}

/**
 * Append `path` to the open-tab list, evicting the oldest tab(s) when the list
 * would exceed `max`. The just-opened `path` and the previously-active tab are
 * protected from eviction so opening a file never closes the one you came from.
 * All background tabs are clean (only the active tab can be dirty), so dropping
 * a tab never loses unsaved edits.
 */
/** Sentinel path prefix for in-memory "untitled" draft buffers that have no
 *  file on disk yet. A draft lives only in `draftContents` until its first
 *  save, at which point the user is prompted for a name and the sentinel tab
 *  is swapped for the real file path. */
const DRAFT_PREFIX = "untitled://";
export const isDraftPath = (p: string | null | undefined): p is string =>
  !!p && p.startsWith(DRAFT_PREFIX);

function addTab(
  tabs: string[],
  path: string,
  max: number,
  activePath: string | null,
): string[] {
  if (tabs.includes(path)) return tabs;
  const next = [...tabs, path];
  while (next.length > max) {
    let idx = next.findIndex((p) => p !== path && p !== activePath);
    // Only protected tabs remain over the limit: drop the oldest non-new one.
    if (idx === -1) idx = next.findIndex((p) => p !== path);
    if (idx === -1) break;
    next.splice(idx, 1);
  }
  return next;
}

/** Drop the oldest tabs until at most `max` remain, never evicting the active. */
function trimTabs(tabs: string[], max: number, activePath: string | null): string[] {
  const next = [...tabs];
  while (next.length > max) {
    const idx = next.findIndex((p) => p !== activePath);
    if (idx === -1) break;
    next.splice(idx, 1);
  }
  return next;
}
/** Cross-window broadcast: the settings window changes a value, the main
 *  window applies it live (and vice-versa). */
const SETTINGS_EVENT = "settings:changed";
/** Broadcast when the AI model list changes; both windows reload from disk. */
const AI_MODELS_EVENT = "ai-models:changed";
const SETTINGS_WINDOW = "settings";

/* Remote-sync events. Sync always *runs* in a main window (it owns the tree
 * and editor); the settings window only configures and requests. Payloads
 * carry the target main-window label so multi-window setups stay correct. */
/** settings → main: run a sync now ({ target }). */
export const SYNC_REQUEST_EVENT = "sync:request";
/** main → settings: live sync status ({ syncState, lastSyncMessage, lastSyncAt }). */
export const SYNC_STATE_EVENT = "sync:state";
/** settings → main: auto-sync config changed ({ workspace }). */
export const SYNC_CONFIG_EVENT = "sync:config-changed";
/** settings → main: the global sync proxy changed ({ proxy }). */
export const GIT_PROXY_EVENT = "sync:proxy-changed";
/** settings → main: a remote was attached, re-probe git ({ workspace }). */
export const GIT_ATTACHED_EVENT = "git:attached";
/** settings → main: open a freshly cloned workspace ({ target, path }). */
export const WORKSPACE_OPEN_EVENT = "workspace:open";
/** main → settings (on focus of an existing window): refresh context. */
export const SETTINGS_CONTEXT_EVENT = "settings:context";

// Sync config is now Rust-owned (app config dir, sync-config.json) — it holds a
// proxy / git settings that don't belong in the WebView's localStorage. One map
// for all workspaces is cached in memory so the read/write API stays
// synchronous; the cache is hydrated from the backend on startup (and re-read
// across windows on SYNC_CONFIG_EVENT). Legacy per-workspace localStorage keys
// are imported once. Callers during startup should await ensureSyncConfigsLoaded().
const LEGACY_SYNC_CONFIG_PREFIX = "idea-note:sync:";
const SYNC_INTERVAL_MIN = 1;
const SYNC_INTERVAL_MAX = 60;
const DEFAULT_SYNC_CONFIG: SyncConfig = { autoSync: false, intervalMin: 10 };
const DEFAULT_COMMIT_MESSAGE_CONFIG: CommitMessageConfig = {
  mode: "default",
  model: null,
  convention: "",
};
/** Reserved sync-config.json key holding globals ({ commitMessage: … }) —
 *  workspace keys are absolute paths, so this can never collide. */
const GLOBAL_CONFIG_KEY = "__global__";

/** Where pasted images / attachments are saved, persisted per workspace. */
export interface AttachmentConfig {
  imageLocation: AttachmentLocation;
  imageDir: string;
  attachmentLocation: AttachmentLocation;
  attachmentDir: string;
}
const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
  imageLocation: "relative",
  imageDir: IMAGE_DIR_DEFAULT,
  attachmentLocation: "relative",
  attachmentDir: ATTACHMENT_DIR_DEFAULT,
};

// Everything persisted per workspace, keyed by workspace path in
// sync-config.json: the git sync settings and the image/attachment save dirs.
// (Older builds stored a flat SyncConfig here; normalizeWorkspaceConfig wraps
// those on load — see below.)
interface WorkspaceConfig {
  sync: SyncConfig;
  attachments: AttachmentConfig;
}

let syncConfigCache: Record<string, WorkspaceConfig> = {};
let syncConfigLoaded: Promise<void> | null = null;
/** Global commit-message settings; null = not yet loaded and never saved
 *  in-memory (readers fall back to the default until hydration). */
let commitMessageCache: CommitMessageConfig | null = null;

// The sync proxy is global (one value for all workspaces), stored Rust-side in
// git-proxy.txt. Cached in memory so reads stay synchronous; hydrated on startup
// and re-read across windows on GIT_PROXY_EVENT.
let globalProxyCache = "";
let globalProxyLoaded: Promise<void> | null = null;

export function readGlobalProxy(): string {
  return globalProxyCache;
}

export function saveGlobalProxy(proxy: string) {
  globalProxyCache = proxy;
  void invoke("git_proxy_save", { proxy }).catch(() => {});
}

/** Hydrate the global proxy from the backend once (idempotent). On first run it
 *  also imports a proxy from any legacy per-workspace sync config. */
export function ensureGlobalProxyLoaded(): Promise<void> {
  if (!globalProxyLoaded) {
    globalProxyLoaded = (async () => {
      let disk = "";
      try {
        disk = await invoke<string>("git_proxy_load");
      } catch {
        /* keep empty */
      }
      if (disk.trim()) {
        globalProxyCache = disk;
        return;
      }
      // One-time migration: adopt the first non-empty proxy that older builds
      // stored per-workspace inside sync-config.json. Read the raw blob since
      // normalizeSyncConfig no longer keeps the proxy field.
      try {
        const raw = JSON.parse(await invoke<string>("sync_config_load"));
        if (raw && typeof raw === "object") {
          for (const cfg of Object.values(raw as Record<string, unknown>)) {
            const legacy = (cfg as { proxy?: unknown })?.proxy;
            if (typeof legacy === "string" && legacy.trim()) {
              globalProxyCache = legacy;
              saveGlobalProxy(legacy);
              break;
            }
          }
        }
      } catch {
        /* no legacy proxy */
      }
    })();
  }
  return globalProxyLoaded;
}

async function reloadGlobalProxy(): Promise<void> {
  await ensureGlobalProxyLoaded();
  try {
    globalProxyCache = await invoke<string>("git_proxy_load");
  } catch {
    /* keep current cache */
  }
}

function normalizeSyncConfig(parsed: unknown): SyncConfig {
  if (!parsed || typeof parsed !== "object") return DEFAULT_SYNC_CONFIG;
  const p = parsed as Partial<SyncConfig>;
  return {
    autoSync: typeof p.autoSync === "boolean" ? p.autoSync : false,
    intervalMin:
      typeof p.intervalMin === "number"
        ? Math.min(SYNC_INTERVAL_MAX, Math.max(SYNC_INTERVAL_MIN, p.intervalMin))
        : DEFAULT_SYNC_CONFIG.intervalMin,
  };
}

function normalizeCommitMessageConfig(parsed: unknown): CommitMessageConfig {
  if (!parsed || typeof parsed !== "object") return DEFAULT_COMMIT_MESSAGE_CONFIG;
  const p = parsed as Partial<CommitMessageConfig>;
  return {
    mode: p.mode === "ai" ? "ai" : "default",
    model: typeof p.model === "string" && p.model ? p.model : null,
    convention: typeof p.convention === "string" ? p.convention : "",
  };
}

function normalizeAttachmentConfig(parsed: unknown): AttachmentConfig {
  if (!parsed || typeof parsed !== "object") return DEFAULT_ATTACHMENT_CONFIG;
  const p = parsed as Partial<AttachmentConfig>;
  return {
    imageLocation: sanitizeLocation(p.imageLocation, DEFAULT_ATTACHMENT_CONFIG.imageLocation),
    imageDir: typeof p.imageDir === "string" ? p.imageDir : DEFAULT_ATTACHMENT_CONFIG.imageDir,
    attachmentLocation: sanitizeLocation(
      p.attachmentLocation,
      DEFAULT_ATTACHMENT_CONFIG.attachmentLocation,
    ),
    attachmentDir:
      typeof p.attachmentDir === "string"
        ? p.attachmentDir
        : DEFAULT_ATTACHMENT_CONFIG.attachmentDir,
  };
}

/** A per-workspace entry. Legacy builds stored a flat SyncConfig
 *  ({ autoSync, intervalMin }) with no nesting; detect and wrap those. */
function normalizeWorkspaceConfig(parsed: unknown): WorkspaceConfig {
  if (!parsed || typeof parsed !== "object") {
    return { sync: DEFAULT_SYNC_CONFIG, attachments: DEFAULT_ATTACHMENT_CONFIG };
  }
  const p = parsed as { sync?: unknown; attachments?: unknown };
  const nested = "sync" in p || "attachments" in p;
  return {
    sync: normalizeSyncConfig(nested ? p.sync : parsed),
    attachments: normalizeAttachmentConfig(p.attachments),
  };
}

function parseSyncConfigMap(raw: string): Record<string, WorkspaceConfig> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, WorkspaceConfig> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k === GLOBAL_CONFIG_KEY) continue; // globals, not a workspace entry
      out[k] = normalizeWorkspaceConfig(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** The global entry's commit-message settings, or null when the file has no
 *  global entry yet (distinct from "present with default values"). */
function parseGlobalCommitMessage(raw: string): CommitMessageConfig | null {
  try {
    const entry = (JSON.parse(raw) as Record<string, unknown>)?.[GLOBAL_CONFIG_KEY];
    if (!entry || typeof entry !== "object") return null;
    return normalizeCommitMessageConfig((entry as { commitMessage?: unknown }).commitMessage);
  } catch {
    return null;
  }
}

/** One-time adoption of the short-lived per-workspace commit-message fields
 *  (an early build stored commitMessage/commitModel/commitConvention inside
 *  each workspace's sync config): adopt the first entry that actually enabled
 *  AI or wrote a convention. */
function migrateLegacyCommitMessage(raw: string): CommitMessageConfig | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    for (const [k, v] of Object.entries(parsed)) {
      if (k === GLOBAL_CONFIG_KEY || !v || typeof v !== "object") continue;
      const sync = ((v as { sync?: unknown }).sync ?? v) as {
        commitMessage?: unknown;
        commitModel?: unknown;
        commitConvention?: unknown;
      };
      if (
        sync.commitMessage === "ai" ||
        (typeof sync.commitConvention === "string" && sync.commitConvention.trim())
      ) {
        return normalizeCommitMessageConfig({
          mode: sync.commitMessage,
          model: sync.commitModel,
          convention: sync.commitConvention,
        });
      }
    }
  } catch {
    /* nothing to migrate */
  }
  return null;
}

export function readCommitMessageConfig(): CommitMessageConfig {
  return commitMessageCache ?? DEFAULT_COMMIT_MESSAGE_CONFIG;
}

export function saveCommitMessageConfig(config: CommitMessageConfig) {
  commitMessageCache = config;
  void flushSyncConfigs();
}

export function readSyncConfig(workspace: string | null): SyncConfig {
  if (!workspace) return DEFAULT_SYNC_CONFIG;
  return syncConfigCache[workspace]?.sync ?? DEFAULT_SYNC_CONFIG;
}

export function saveSyncConfig(workspace: string, config: SyncConfig) {
  // Update the cache synchronously (readers see it immediately), then flush the
  // whole map. flushSyncConfigs merges disk first, so a write that races the
  // initial load can't clobber other workspaces' configs. Preserve the sibling
  // attachment config so saving one half never drops the other.
  const prev = syncConfigCache[workspace];
  syncConfigCache[workspace] = {
    sync: config,
    attachments: prev?.attachments ?? DEFAULT_ATTACHMENT_CONFIG,
  };
  void flushSyncConfigs();
}

export function readAttachmentConfig(workspace: string | null): AttachmentConfig {
  if (!workspace) return DEFAULT_ATTACHMENT_CONFIG;
  return syncConfigCache[workspace]?.attachments ?? DEFAULT_ATTACHMENT_CONFIG;
}

export function saveAttachmentConfig(workspace: string, config: AttachmentConfig) {
  const prev = syncConfigCache[workspace];
  syncConfigCache[workspace] = {
    sync: prev?.sync ?? DEFAULT_SYNC_CONFIG,
    attachments: config,
  };
  void flushSyncConfigs();
}

async function flushSyncConfigs() {
  await ensureSyncConfigsLoaded();
  try {
    const blob: Record<string, unknown> = { ...syncConfigCache };
    if (commitMessageCache) blob[GLOBAL_CONFIG_KEY] = { commitMessage: commitMessageCache };
    await invoke("sync_config_save", { json: JSON.stringify(blob) });
  } catch {
    /* non-fatal */
  }
}

/** Hydrate the cache from the backend once (idempotent). In-memory edits win
 *  over disk, so a save made before this resolves isn't lost. */
export function ensureSyncConfigsLoaded(): Promise<void> {
  if (!syncConfigLoaded) {
    syncConfigLoaded = (async () => {
      let raw = "{}";
      try {
        raw = await invoke<string>("sync_config_load");
      } catch {
        /* keep empty */
      }
      syncConfigCache = { ...parseSyncConfigMap(raw), ...syncConfigCache };
      // In-memory (pre-load) saves win over disk, mirroring the map merge.
      if (commitMessageCache === null) {
        commitMessageCache = parseGlobalCommitMessage(raw);
        if (commitMessageCache === null) {
          commitMessageCache = migrateLegacyCommitMessage(raw);
          if (commitMessageCache) void flushSyncConfigs();
        }
      }
      migrateLegacySyncConfigs();
    })();
  }
  return syncConfigLoaded;
}

/** Re-read the backend map into the cache (cross-window refresh). The emitting
 *  window has already flushed to disk, so disk is authoritative here. */
async function reloadSyncConfigs(): Promise<void> {
  await ensureSyncConfigsLoaded();
  try {
    const raw = await invoke<string>("sync_config_load");
    syncConfigCache = parseSyncConfigMap(raw);
    commitMessageCache = parseGlobalCommitMessage(raw) ?? commitMessageCache;
  } catch {
    /* keep current cache */
  }
}

// One-time import of legacy per-workspace localStorage entries
// (idea-note:sync:<path>) into the cache, then flush and clear them.
function migrateLegacySyncConfigs() {
  let migrated = false;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LEGACY_SYNC_CONFIG_PREFIX)) continue;
    const workspace = key.slice(LEGACY_SYNC_CONFIG_PREFIX.length);
    if (!(workspace in syncConfigCache)) {
      try {
        syncConfigCache[workspace] = normalizeWorkspaceConfig(
          JSON.parse(localStorage.getItem(key) ?? "{}"),
        );
        migrated = true;
      } catch {
        /* skip malformed */
      }
    }
    localStorage.removeItem(key);
  }
  if (migrated) {
    void invoke("sync_config_save", { json: JSON.stringify(syncConfigCache) }).catch(() => {});
  }
}

const preferredTheme: Theme = window.matchMedia("(prefers-color-scheme: dark)")
  .matches
  ? "dark"
  : "light";

/** Keep only string->string entries; tolerate any malformed persisted shape. */
function sanitizeKeybindings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [id, key] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && key.trim()) out[id] = key;
  }
  return out;
}

function readSettings(): AppSettings {
  const legacyTheme = localStorage.getItem(THEME_KEY) as Theme | null;
  const fallbackMode: Theme =
    legacyTheme === "light" || legacyTheme === "dark"
      ? legacyTheme
      : preferredTheme;
  const fallback: AppSettings = {
    themeId: fallbackMode,
    customThemes: [],
    appearanceMode: fallbackMode,
    editorFontSize: 15,
    editorLineHeight: 1.75,
    editorLineNumbers: true,
    editorFontFamily: "",
    editorHeadingScale: HEADING_SCALE_DEFAULT,
    editorMaxTabs: EDITOR_MAX_TABS_DEFAULT,
    aiAssistantFontSize: AI_ASSISTANT_FONT_DEFAULT,
    compactSidebar: false,
    compactEditor: false,
    uiZoom: 1,
    sidebarFilesFontSize: SIDEBAR_FONT_DEFAULT,
    sidebarNotesFontSize: SIDEBAR_FONT_DEFAULT,
    sidebarOutlineFontSize: SIDEBAR_FONT_DEFAULT,
    editorKeybindings: {},
  };

  const sidebarFont = (v: unknown, fb: number) =>
    typeof v === "number"
      ? Math.min(SIDEBAR_FONT_MAX, Math.max(SIDEBAR_FONT_MIN, v))
      : fb;

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;

    // Custom themes: keep only well-formed entries (missing colours are filled
    // from the matching base mode by normalizeCustomTheme).
    const customThemes = Array.isArray(parsed.customThemes)
      ? parsed.customThemes
          .map((t) => normalizeCustomTheme(t))
          .filter((t): t is ThemeDef => t !== null)
      : [];

    // themeId is the new selector; migrate from the legacy appearanceMode when
    // older settings predate it. The base mode (appearanceMode) is then derived
    // from whichever theme actually resolves, so e.g. "nord" reads as dark.
    const legacyMode: Theme =
      parsed.appearanceMode === "light" || parsed.appearanceMode === "dark"
        ? parsed.appearanceMode
        : fallback.appearanceMode;
    const themeId = canonicalThemeId(
      typeof parsed.themeId === "string" && parsed.themeId.trim()
        ? parsed.themeId.trim()
        : legacyMode,
    );
    const appearanceMode: Theme = resolveTheme(themeId, customThemes).dark
      ? "dark"
      : "light";

    return {
      themeId,
      customThemes,
      appearanceMode,
      editorFontSize:
        typeof parsed.editorFontSize === "number"
          ? Math.min(22, Math.max(12, parsed.editorFontSize))
          : fallback.editorFontSize,
      editorLineHeight:
        typeof parsed.editorLineHeight === "number"
          ? Math.min(2.2, Math.max(1.3, parsed.editorLineHeight))
          : fallback.editorLineHeight,
      editorLineNumbers:
        typeof parsed.editorLineNumbers === "boolean"
          ? parsed.editorLineNumbers
          : fallback.editorLineNumbers,
      editorFontFamily:
        typeof parsed.editorFontFamily === "string"
          ? parsed.editorFontFamily
          : fallback.editorFontFamily,
      editorHeadingScale:
        typeof parsed.editorHeadingScale === "number"
          ? Math.min(HEADING_SCALE_MAX, Math.max(HEADING_SCALE_MIN, parsed.editorHeadingScale))
          : fallback.editorHeadingScale,
      editorMaxTabs:
        typeof parsed.editorMaxTabs === "number"
          ? Math.min(
              EDITOR_MAX_TABS_MAX,
              Math.max(EDITOR_MAX_TABS_MIN, Math.round(parsed.editorMaxTabs)),
            )
          : fallback.editorMaxTabs,
      aiAssistantFontSize:
        typeof parsed.aiAssistantFontSize === "number"
          ? Math.min(
              AI_ASSISTANT_FONT_MAX,
              Math.max(AI_ASSISTANT_FONT_MIN, parsed.aiAssistantFontSize),
            )
          : fallback.aiAssistantFontSize,
      compactSidebar:
        typeof parsed.compactSidebar === "boolean"
          ? parsed.compactSidebar
          : fallback.compactSidebar,
      compactEditor:
        typeof parsed.compactEditor === "boolean"
          ? parsed.compactEditor
          : fallback.compactEditor,
      uiZoom:
        typeof parsed.uiZoom === "number"
          ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parsed.uiZoom))
          : fallback.uiZoom,
      sidebarFilesFontSize: sidebarFont(parsed.sidebarFilesFontSize, fallback.sidebarFilesFontSize),
      sidebarNotesFontSize: sidebarFont(parsed.sidebarNotesFontSize, fallback.sidebarNotesFontSize),
      sidebarOutlineFontSize: sidebarFont(parsed.sidebarOutlineFontSize, fallback.sidebarOutlineFontSize),
      editorKeybindings: sanitizeKeybindings(parsed.editorKeybindings),
    };
  } catch {
    return fallback;
  }
}

const initialSettings = readSettings();

/** Resolve the selected theme and write its palette + base-mode class onto the
 *  document. Returns the resolved base mode so callers can mirror it into state. */
function applyTheme(themeId: string, customThemes: ThemeDef[]): Theme {
  const def = resolveTheme(themeId, customThemes);
  applyThemeColors(def);
  return def.dark ? "dark" : "light";
}

function applyEditorSettings(
  settings: Pick<
    AppSettings,
    | "editorFontSize"
    | "editorLineHeight"
    | "compactEditor"
    | "editorFontFamily"
    | "editorHeadingScale"
  >,
) {
  document.documentElement.style.setProperty(
    "--editor-font-size",
    `${settings.editorFontSize}px`,
  );
  document.documentElement.style.setProperty(
    "--editor-line-height",
    String(settings.editorLineHeight),
  );
  document.documentElement.style.setProperty(
    "--editor-font-family",
    editorFontStack(settings.editorFontFamily),
  );
  document.documentElement.style.setProperty(
    "--editor-heading-scale",
    String(settings.editorHeadingScale),
  );
  document.documentElement.classList.toggle("editor-compact", settings.compactEditor);
}

function applyAiAssistantSettings(settings: Pick<AppSettings, "aiAssistantFontSize">) {
  document.documentElement.style.setProperty(
    "--ai-assistant-font-size",
    `${settings.aiAssistantFontSize}px`,
  );
}

function applySidebarSettings(
  settings: Pick<
    AppSettings,
    "sidebarFilesFontSize" | "sidebarNotesFontSize" | "sidebarOutlineFontSize"
  >,
) {
  const root = document.documentElement.style;
  root.setProperty("--sidebar-files-font-size", `${settings.sidebarFilesFontSize}px`);
  root.setProperty("--sidebar-notes-font-size", `${settings.sidebarNotesFontSize}px`);
  root.setProperty("--sidebar-outline-font-size", `${settings.sidebarOutlineFontSize}px`);
}

let isSettingsWindow = false;
try {
  isSettingsWindow = getCurrentWindow().label === SETTINGS_WINDOW;
} catch {
  // Not in a Tauri context (e.g. plain browser) — treat it as a main window.
}

function applyZoom(zoom: number) {
  // WKWebView's native page zoom re-rasterises text at the new scale (crisp),
  // unlike the CSS `zoom` property which WebKit composites by stretching a
  // bitmap of the page (blurry). Each window zooms its own webview.
  void getCurrentWebviewWindow().setZoom(zoom).catch(() => {});
}

function saveSettings(settings: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(THEME_KEY, settings.appearanceMode);
}

/** Persist + apply to the DOM + broadcast to the other window. */
function commitSettings(settings: AppSettings) {
  saveSettings(settings);
  applyTheme(settings.themeId, settings.customThemes);
  applyEditorSettings(settings);
  applyAiAssistantSettings(settings);
  applySidebarSettings(settings);
  applyZoom(settings.uiZoom);
  emit(SETTINGS_EVENT, settings).catch(() => {});
}

/** Pull the persisted-settings subset out of the live store state. */
function snapshotSettings(get: () => AppState): AppSettings {
  const s = get();
  return {
    themeId: s.themeId,
    customThemes: s.customThemes,
    appearanceMode: s.appearanceMode,
    editorFontSize: s.editorFontSize,
    editorLineHeight: s.editorLineHeight,
    editorLineNumbers: s.editorLineNumbers,
    editorFontFamily: s.editorFontFamily,
    editorHeadingScale: s.editorHeadingScale,
    editorMaxTabs: s.editorMaxTabs,
    aiAssistantFontSize: s.aiAssistantFontSize,
    compactSidebar: s.compactSidebar,
    compactEditor: s.compactEditor,
    uiZoom: s.uiZoom,
    sidebarFilesFontSize: s.sidebarFilesFontSize,
    sidebarNotesFontSize: s.sidebarNotesFontSize,
    sidebarOutlineFontSize: s.sidebarOutlineFontSize,
    editorKeybindings: s.editorKeybindings,
  };
}

const initialTheme = applyTheme(initialSettings.themeId, initialSettings.customThemes);
applyEditorSettings(initialSettings);
applyAiAssistantSettings(initialSettings);
applySidebarSettings(initialSettings);
applyZoom(initialSettings.uiZoom);

/** Monotonic ticket for runGlobalSearch so stale responses are dropped. */
let searchSeq = 0;
/** Rendering more than this in the sidebar makes common queries like "a" lock
 *  the WebView before the Stop button can be clicked. The backend still keeps
 *  searching; we just stop retaining extra rows for the list. */
const SEARCH_RENDER_HIT_LIMIT = 2_000;

/**
 * Prompt before closing a tab with unsaved changes. `proceed(true)` saves the
 * edits first, `proceed(false)` discards them; cancelling the dialog leaves the
 * tab open. The close itself is performed by re-invoking the close action once
 * the dirty state has been resolved (so it sees a clean tab and skips re-asking).
 */
function confirmUnsavedClose(
  get: () => AppState,
  proceed: (save: boolean) => void | Promise<void>,
) {
  get().openConfirm({
    title: "未保存的更改",
    message: "此标签页有未保存的更改，关闭后将丢失。是否先保存？",
    confirmLabel: "保存",
    tone: "primary",
    onConfirm: () => proceed(true),
    altLabel: "不保存",
    onAlt: () => proceed(false),
  });
}

/** Snapshot a file's on-disk stat as the change-detection baseline for the
 *  active file. Fire-and-forget after a load/save; ignores its result if the
 *  user switched files while the stat was in flight. */
async function captureDiskStat(path: string): Promise<void> {
  const st = await fileStat(path);
  if (useAppStore.getState().activeFilePath === path)
    useAppStore.setState({ diskStat: st });
}

export const useAppStore = create<AppState>((set, get) => ({
  workspacePath: null,
  tree: [],
  sidebarMode: readSidebarMode(),
  notesViewMode: readNotesViewMode(),
  searchQuery: "",
  searchOptions: readSearchOptions(),
  searchHits: [],
  searchTotalHits: 0,
  searchDisplayLimited: false,
  searchTruncated: false,
  searchLoading: false,
  searchRegexError: null,
  searchFocusKey: 0,
  expanded: {},
  recentWorkspaces: readRecents(),
  activeFilePath: null,
  openTabs: [],
  draftContents: {},
  draftSeq: 0,
  selectedPath: null,
  selectedPaths: [],
  folderViewPath: null,
  content: "",
  docKey: 0,
  isDirty: false,
  diskStat: null,
  saving: false,
  theme: initialTheme,
  appearanceMode: initialSettings.appearanceMode,
  themeId: initialSettings.themeId,
  customThemes: initialSettings.customThemes,
  editorFontSize: initialSettings.editorFontSize,
  editorLineHeight: initialSettings.editorLineHeight,
  editorLineNumbers: initialSettings.editorLineNumbers,
  editorFontFamily: initialSettings.editorFontFamily,
  editorHeadingScale: initialSettings.editorHeadingScale,
  editorMaxTabs: initialSettings.editorMaxTabs,
  aiAssistantFontSize: initialSettings.aiAssistantFontSize,
  compactSidebar: initialSettings.compactSidebar,
  compactEditor: initialSettings.compactEditor,
  uiZoom: initialSettings.uiZoom,
  sidebarFilesFontSize: initialSettings.sidebarFilesFontSize,
  sidebarNotesFontSize: initialSettings.sidebarNotesFontSize,
  sidebarOutlineFontSize: initialSettings.sidebarOutlineFontSize,
  editorKeybindings: initialSettings.editorKeybindings,
  // Image/attachment dirs are per-workspace (persisted in sync-config.json);
  // these mirror the active workspace and are hydrated on open/restore below.
  ...DEFAULT_ATTACHMENT_CONFIG,
  sidebarOpen: true,
  mdViewMode: "live",
  bottomPanelOpen: false,
  bottomPanelHeight: 260,
  rightPanelOpen: false,
  rightPanelWidth: 300,
  aiModels: [],
  activeFormats: emptyFormats,
  prompt: null,
  gitCredentialPrompt: null,
  confirm: null,
  history: null,
  gitInfo: null,
  syncState: "idle",
  lastSyncMessage: null,
  lastSyncAt: null,
  syncConfig: DEFAULT_SYNC_CONFIG,
  toast: null,

  openWorkspace: async () => {
    const path = await pickWorkspace();
    if (!path) return;
    await get().openWorkspaceAt(path);
  },

  openWorkspaceAt: async (path) => {
    await get().flushActiveTab();
    let tree: FileNode[];
    try {
      tree = await listDir(path);
    } catch {
      window.alert(`无法打开「${path}」（文件夹可能已被移动或删除）。`);
      set({ recentWorkspaces: dropRecent(path) });
      return;
    }
    localStorage.setItem(WORKSPACE_KEY, path);
    await ensureSyncConfigsLoaded();
    set((s) => ({
      workspacePath: path,
      tree,
      expanded: {},
      recentWorkspaces: pushRecent(path),
      activeFilePath: null,
      openTabs: [],
      draftContents: {},
      selectedPath: null,
      folderViewPath: null,
      content: "",
      isDirty: false,
      docKey: s.docKey + 1,
      activeFormats: emptyFormats,
      searchQuery: "",
      searchHits: [],
      searchTotalHits: 0,
      searchDisplayLimited: false,
      searchTruncated: false,
      searchLoading: false,
      searchRegexError: null,
      gitInfo: null,
      syncState: "idle",
      lastSyncMessage: null,
      lastSyncAt: null,
      syncConfig: readSyncConfig(path),
      ...readAttachmentConfig(path),
    }));
    void get().refreshGitInfo();
  },

  closeWorkspace: async () => {
    if (!get().workspacePath) return;

    // Closing drops every open tab; confirm before discarding unsaved changes
    // (only the active tab can be dirty), then re-run once it's resolved.
    if (get().isDirty) {
      confirmUnsavedClose(get, async (saveFirst) => {
        if (saveFirst) {
          await get().save();
          if (get().isDirty) return; // save cancelled
        } else {
          set({ isDirty: false });
        }
        await get().closeWorkspace();
      });
      return;
    }

    localStorage.removeItem(WORKSPACE_KEY);
    set((s) => ({
      workspacePath: null,
      tree: [],
      expanded: {},
      activeFilePath: null,
      openTabs: [],
      draftContents: {},
      selectedPath: null,
      folderViewPath: null,
      content: "",
      isDirty: false,
      docKey: s.docKey + 1,
      activeFormats: emptyFormats,
      searchQuery: "",
      searchHits: [],
      searchTotalHits: 0,
      searchDisplayLimited: false,
      searchTruncated: false,
      searchLoading: false,
      searchRegexError: null,
      gitInfo: null,
      syncState: "idle",
      lastSyncMessage: null,
      lastSyncAt: null,
    }));
  },

  closeAllWorkspaces: async () => {
    // Leave only the current window: close every other open window (other mains
    // and the settings window), then drop this window's own workspace. Closing
    // the current workspace last keeps its unsaved-changes prompt intact.
    const current = getCurrentWindow().label;
    const windows = await getAllWebviewWindows();
    await Promise.all(
      windows
        .filter((w) => w.label !== current)
        .map((w) => w.close().catch(() => {})),
    );
    await get().closeWorkspace();
  },

  requestOpenWorkspace: async () => {
    // Pick the folder first; the current-vs-new-window question only makes
    // sense once we know something was actually chosen.
    const path = await pickWorkspace();
    if (path) get().requestOpenWorkspaceAt(path);
  },

  requestOpenWorkspaceAt: (path) => {
    set({
      confirm: {
        title: "打开项目",
        message: `在哪个窗口打开「${basename(path)}」？`,
        confirmLabel: "当前窗口",
        tone: "primary",
        onConfirm: () => get().openWorkspaceAt(path),
        altLabel: "新窗口",
        onAlt: () => get().openNewWindow(path),
      },
    });
  },

  restoreWorkspace: async () => {
    if (get().workspacePath) return;
    const saved = localStorage.getItem(WORKSPACE_KEY);
    if (!saved) return;
    try {
      const tree = await listDir(saved);
      await ensureSyncConfigsLoaded();
      set({
        workspacePath: saved,
        tree,
        recentWorkspaces: pushRecent(saved),
        syncConfig: readSyncConfig(saved),
        ...readAttachmentConfig(saved),
      });
      void get().refreshGitInfo();
    } catch {
      // Folder was moved or deleted since last run — forget it.
      localStorage.removeItem(WORKSPACE_KEY);
    }
  },

  setSidebarMode: (sidebarMode) => {
    localStorage.setItem(SIDEBAR_MODE_KEY, sidebarMode);
    set({ sidebarMode });
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  toggleSearchOption: (key) => {
    const searchOptions = { ...get().searchOptions, [key]: !get().searchOptions[key] };
    localStorage.setItem(SEARCH_OPTIONS_KEY, JSON.stringify(searchOptions));
    set({ searchOptions });
    void get().runGlobalSearch(get().searchQuery);
  },

  runGlobalSearch: async (query) => {
    const { workspacePath, searchOptions } = get();
    const seq = ++searchSeq;
    // Regex patterns keep their spacing; trimming only gates emptiness.
    if (!workspacePath || !query.trim()) {
      void stopGlobalSearchBackend().catch(() => {});
      set({
        searchHits: [],
        searchTotalHits: 0,
        searchDisplayLimited: false,
        searchTruncated: false,
        searchLoading: false,
        searchRegexError: null,
      });
      return;
    }
    // Clear prior results up front so hits stream in from empty; the backend
    // pushes them file-by-file via the channel below.
    set({
      searchHits: [],
      searchTotalHits: 0,
      searchDisplayLimited: false,
      searchTruncated: false,
      searchLoading: true,
      searchRegexError: null,
    });
    // Coalesce streamed hits into ~frame-sized batches: the backend can emit a
    // burst of files faster than React should re-render, so we buffer and flush
    // on a short timer instead of calling set() once per file.
    let pending: GlobalSearchHit[] = [];
    let pendingTotal = 0;
    let pendingDisplayLimited = false;
    let keptHits = 0;
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      if (seq !== searchSeq || (pending.length === 0 && pendingTotal === 0)) return;
      const batch = pending;
      const total = pendingTotal;
      const displayLimited = pendingDisplayLimited;
      pending = [];
      pendingTotal = 0;
      pendingDisplayLimited = false;
      set((s) => ({
        searchHits: batch.length ? s.searchHits.concat(batch) : s.searchHits,
        searchTotalHits: s.searchTotalHits + total,
        searchDisplayLimited: s.searchDisplayLimited || displayLimited,
      }));
    };
    try {
      await globalSearchStream(workspacePath, query, searchOptions, (event) => {
        // Drop events from a search that's since been superseded (the channel
        // outlives the invoke, so stale hits can still arrive).
        if (seq !== searchSeq) return;
        if (event.kind === "hits") {
          pendingTotal += event.hits.length;
          const remaining = SEARCH_RENDER_HIT_LIMIT - keptHits;
          if (remaining > 0) {
            const kept = event.hits.slice(0, remaining);
            pending.push(...kept);
            keptHits += kept.length;
          }
          if (keptHits >= SEARCH_RENDER_HIT_LIMIT && pendingTotal > pending.length) {
            pendingDisplayLimited = true;
          }
          if (flushTimer === null) flushTimer = window.setTimeout(flush, 40);
        } else if (event.kind === "regexError") {
          set({ searchRegexError: event.message });
        } else {
          // Done: drain whatever's buffered together with the terminal flags in
          // a single set so the final frame doesn't render twice.
          if (flushTimer !== null) {
            window.clearTimeout(flushTimer);
            flushTimer = null;
          }
          const batch = pending;
          const total = pendingTotal;
          const displayLimited = pendingDisplayLimited;
          pending = [];
          pendingTotal = 0;
          pendingDisplayLimited = false;
          set((s) => ({
            searchHits: batch.length ? s.searchHits.concat(batch) : s.searchHits,
            searchTotalHits: s.searchTotalHits + total,
            searchDisplayLimited: s.searchDisplayLimited || displayLimited,
            searchTruncated: event.truncated,
            searchLoading: false,
          }));
        }
      });
    } catch {
      if (seq !== searchSeq) return;
      set({
        searchHits: [],
        searchTotalHits: 0,
        searchDisplayLimited: false,
        searchTruncated: false,
        searchLoading: false,
        searchRegexError: null,
      });
    }
  },

  stopGlobalSearch: () => {
    searchSeq += 1;
    void stopGlobalSearchBackend().catch(() => {});
    set({ searchLoading: false, searchTruncated: true });
  },

  openGlobalSearch: () => {
    get().setSidebarMode("search");
    set((s) => ({ sidebarOpen: true, searchFocusKey: s.searchFocusKey + 1 }));
  },

  setNotesViewMode: (notesViewMode) => {
    localStorage.setItem(NOTES_VIEW_KEY, notesViewMode);
    set({ notesViewMode });
  },

  setExpanded: (path, open) =>
    set((s) => ({ expanded: { ...s.expanded, [path]: open } })),

  refreshTree: async () => {
    const { workspacePath } = get();
    if (!workspacePath) return;
    set({ tree: await listDir(workspacePath) });
  },

  openFile: async (path) => {
    await get().flushActiveTab();
    // Opening collapses any multi-selection back to this single item.
    set({ selectedPaths: [] });
    // Drafts have no disk file: restore their stashed text instead of reading.
    if (isDraftPath(path)) {
      set((s) => ({
        activeFilePath: path,
        openTabs: addTab(s.openTabs, path, get().editorMaxTabs, s.activeFilePath),
        selectedPath: null,
        folderViewPath: null,
        content: s.draftContents[path] ?? "",
        isDirty: false,
        diskStat: null,
        docKey: s.docKey + 1,
        activeFormats: emptyFormats,
      }));
      return;
    }
    // Images are shown in an <img>, not read as text.
    if (isImageFile(path)) {
      set((s) => ({
        activeFilePath: path,
        openTabs: addTab(s.openTabs, path, get().editorMaxTabs, s.activeFilePath),
        selectedPath: path,
        folderViewPath: null,
        content: "",
        isDirty: false,
        diskStat: null,
        docKey: s.docKey + 1,
        activeFormats: emptyFormats,
      }));
      return;
    }
    let content: string;
    try {
      content = await readFile(path);
    } catch {
      // Other non-text files (PDFs, binaries, …) can't be read as UTF-8.
      window.alert(`无法以文本方式打开「${basename(path)}」（可能是二进制文件）。`);
      return;
    }
    set((s) => ({
      activeFilePath: path,
      openTabs: addTab(s.openTabs, path, get().editorMaxTabs, s.activeFilePath),
      selectedPath: path,
      folderViewPath: null,
      content,
      isDirty: false,
      // Cleared now, then filled by the stat probe — so a focus check in the
      // brief gap sees no baseline and stays quiet rather than false-firing.
      diskStat: null,
      docKey: s.docKey + 1,
      activeFormats: emptyFormats,
    }));
    void captureDiskStat(path);
  },

  openFolder: async (node) => {
    set({ selectedPaths: [] });
    // Open the folder's README.md if it has one, keeping the folder selected.
    const readme = node.children?.find(
      (c) => !c.is_dir && c.name.toLowerCase() === "readme.md",
    );
    if (readme) {
      await get().openFile(readme.path);
      set({ selectedPath: node.path, folderViewPath: null });
      return;
    }
    // Otherwise show the folder's contents in the right pane.
    await get().flushActiveTab();
    set((s) => ({
      selectedPath: node.path,
      folderViewPath: node.path,
      activeFilePath: null,
      content: "",
      isDirty: false,
      docKey: s.docKey + 1,
      activeFormats: emptyFormats,
    }));
  },

  closeFile: async () => {
    const { activeFilePath } = get();
    if (activeFilePath) {
      await get().closeTab(activeFilePath);
      return;
    }
    // No active file (e.g. a folder listing is showing): just clear the pane.
    await get().flushActiveTab();
    set((s) => ({
      activeFilePath: null,
      selectedPath: null,
      folderViewPath: null,
      content: "",
      isDirty: false,
      docKey: s.docKey + 1,
      activeFormats: emptyFormats,
    }));
  },

  closeTab: async (path) => {
    const { openTabs, activeFilePath, isDirty } = get();
    if (!openTabs.includes(path)) return;

    // The closed tab carries unsaved changes (only the active tab can be dirty):
    // confirm before discarding them. Saving a draft may rename its tab, so the
    // re-invocation closes whatever the active tab has become.
    if (isDirty && path === activeFilePath) {
      confirmUnsavedClose(get, async (saveFirst) => {
        if (saveFirst) {
          await get().save();
          if (get().isDirty) return; // save cancelled (e.g. draft "save as")
          await get().closeTab(get().activeFilePath!);
        } else {
          set({ isDirty: false });
          await get().closeTab(path);
        }
      });
      return;
    }

    const idx = openTabs.indexOf(path);
    const remaining = openTabs.filter((p) => p !== path);

    // Closing a draft discards its in-memory buffer (no disk file to keep).
    if (isDraftPath(path)) {
      set((s) => {
        const { [path]: _drop, ...rest } = s.draftContents;
        return { draftContents: rest };
      });
    }

    // Closing a background tab: it's clean by construction, so just drop it.
    if (path !== activeFilePath) {
      set({ openTabs: remaining });
      return;
    }

    // Closing the active tab (already clean here — any unsaved changes were
    // resolved by the confirm guard above): move to a neighbor.
    if (remaining.length === 0) {
      set((s) => ({
        openTabs: [],
        activeFilePath: null,
        selectedPath: null,
        folderViewPath: null,
        content: "",
        isDirty: false,
        docKey: s.docKey + 1,
        activeFormats: emptyFormats,
      }));
      return;
    }
    const neighbor = remaining[Math.min(idx, remaining.length - 1)];
    // Clear the active pointer before activating the neighbor so the upcoming
    // flush (in openFile) doesn't re-stash the just-closed draft.
    set({ openTabs: remaining, activeFilePath: null, content: "", isDirty: false });
    await get().openFile(neighbor);
  },

  closeOtherTabs: async (path) => {
    const { openTabs, activeFilePath, isDirty } = get();
    if (!openTabs.includes(path)) return;
    const closed = openTabs.filter((p) => p !== path);
    if (closed.length === 0) return;

    // The active tab is dirty and about to be closed (it isn't the kept tab):
    // confirm before discarding its unsaved changes.
    if (isDirty && activeFilePath !== path) {
      confirmUnsavedClose(get, async (saveFirst) => {
        if (saveFirst) {
          await get().save();
          if (get().isDirty) return;
        } else {
          set({ isDirty: false });
        }
        await get().closeOtherTabs(path);
      });
      return;
    }

    // Drop the in-memory buffers of any closed drafts.
    set((s) => {
      const drafts = { ...s.draftContents };
      for (const p of closed) if (isDraftPath(p)) delete drafts[p];
      return { draftContents: drafts };
    });

    if (path === activeFilePath) {
      set({ openTabs: [path] });
      return;
    }
    // Kept tab wasn't active: clear the pointer (so openFile doesn't re-stash a
    // just-closed draft) before activating it.
    set({ openTabs: [path], activeFilePath: null, content: "", isDirty: false });
    await get().openFile(path);
  },

  closeAllTabs: async () => {
    const { openTabs, isDirty } = get();
    if (openTabs.length === 0) return;

    // The active tab carries unsaved changes: confirm before discarding them.
    if (isDirty) {
      confirmUnsavedClose(get, async (saveFirst) => {
        if (saveFirst) {
          await get().save();
          if (get().isDirty) return;
        } else {
          set({ isDirty: false });
        }
        await get().closeAllTabs();
      });
      return;
    }

    set((s) => ({
      openTabs: [],
      activeFilePath: null,
      selectedPath: null,
      folderViewPath: null,
      content: "",
      isDirty: false,
      docKey: s.docKey + 1,
      activeFormats: emptyFormats,
      draftContents: {},
    }));
  },

  reorderTabs: (from, to) => {
    set((s) => {
      const tabs = s.openTabs;
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= tabs.length ||
        to >= tabs.length
      ) {
        return {};
      }
      const next = tabs.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { openTabs: next };
    });
  },

  setContent: (markdown) => {
    if (markdown === get().content) return;
    set({ content: markdown, isDirty: true });
  },

  setActiveFormats: (formats) => set({ activeFormats: formats }),

  checkExternalChange: async () => {
    const { activeFilePath, isDirty, diskStat, confirm } = get();
    // Don't stack on top of an open dialog (e.g. a prior conflict prompt).
    if (confirm) return;
    if (
      !activeFilePath ||
      isDraftPath(activeFilePath) ||
      isImageFile(activeFilePath) ||
      // No snapshot yet (still loading, or a previous stat failed).
      !diskStat
    )
      return;

    // Cheap stat only — no content read. Same mtime + size ⇒ treat as unchanged.
    const now = await fileStat(activeFilePath);
    if (!now) return; // removed/unreadable — leave as-is; saving will surface it
    if (now.mtime === diskStat.mtime && now.size === diskStat.size) return;

    const path = activeFilePath;
    if (!isDirty) {
      // Clean buffer: adopt the external version silently. This is the only
      // place we read the file, and only because a change was detected.
      try {
        const disk = await readFile(path);
        if (get().activeFilePath !== path) return; // switched files mid-read
        set((s) => ({ content: disk, docKey: s.docKey + 1, diskStat: now }));
      } catch {
        // Vanished between stat and read — leave the buffer alone.
      }
      return;
    }

    // Unsaved edits + external change → ask. Never discard the buffer without
    // consent; only read the file if the user actually chooses to reload.
    set({
      confirm: {
        title: "文件已被外部修改",
        message: `「${basename(path)}」在应用外被修改，而你有未保存的改动。重新加载会丢失这些改动。`,
        tone: "primary",
        confirmLabel: "保留我的修改",
        // Keep the buffer; adopt the new on-disk stat so the same external
        // change won't prompt again. A later save overwrites the disk version.
        onConfirm: () => set({ diskStat: now }),
        altLabel: "重新加载",
        onAlt: async () => {
          const disk = await readFile(path);
          if (get().activeFilePath !== path) return;
          set((s) => ({
            content: disk,
            isDirty: false,
            docKey: s.docKey + 1,
            diskStat: now,
          }));
        },
      },
    });
  },

  save: async () => {
    const { activeFilePath, content, isDirty } = get();
    // First save of an untitled draft: let the user pick a directory + filename
    // via the native "save as" dialog, then swap the sentinel tab for the path.
    if (isDraftPath(activeFilePath)) {
      const draftPath = activeFilePath;
      const ws = get().workspacePath;
      const chosen = await pickSavePath(ws ? `${ws}/未命名.md` : "未命名.md");
      if (!chosen) return; // cancelled
      set({ saving: true });
      try {
        await writeFile(chosen, get().content);
        set((s) => {
          const { [draftPath]: _drop, ...rest } = s.draftContents;
          return {
            draftContents: rest,
            openTabs: s.openTabs.map((p) => (p === draftPath ? chosen : p)),
            activeFilePath: s.activeFilePath === draftPath ? chosen : s.activeFilePath,
            selectedPath: chosen,
            isDirty: false,
          };
        });
        void captureDiskStat(chosen);
        await get().refreshTree();
      } finally {
        set({ saving: false });
      }
      return;
    }
    if (!activeFilePath || !isDirty) return;
    set({ saving: true });
    try {
      await writeFile(activeFilePath, content);
      set({ isDirty: false });
      void captureDiskStat(activeFilePath);
      // Keep the notes-mode excerpt/mtime of this file fresh in the sidebar.
      void get().refreshTree();
    } finally {
      set({ saving: false });
    }
  },

  newDraft: async () => {
    await get().flushActiveTab();
    const seq = get().draftSeq + 1;
    const path = `${DRAFT_PREFIX}${seq}`;
    set((s) => {
      const openTabs = addTab(s.openTabs, path, get().editorMaxTabs, s.activeFilePath);
      // Drop stashed text for any draft addTab evicted from the tab strip.
      const draftContents: Record<string, string> = { [path]: "" };
      for (const p of openTabs) {
        if (isDraftPath(p) && p in s.draftContents) draftContents[p] = s.draftContents[p];
      }
      return {
        draftSeq: seq,
        draftContents,
        activeFilePath: path,
        openTabs,
        selectedPath: null,
        folderViewPath: null,
        content: "",
        isDirty: false,
        docKey: s.docKey + 1,
        activeFormats: emptyFormats,
      };
    });
  },

  flushActiveTab: async () => {
    const { activeFilePath, content, isDirty } = get();
    if (isDraftPath(activeFilePath)) {
      // Stash the live text so it survives while the draft is backgrounded.
      set((s) => ({
        draftContents: { ...s.draftContents, [activeFilePath]: content },
        isDirty: false,
      }));
      return;
    }
    if (activeFilePath && isDirty) await get().save();
  },

  newFile: async (dir, name) => {
    const trimmed = name.trim();
    const target = dir ?? get().workspacePath;
    if (!target || !trimmed) return;
    const { refreshTree, openFile } = get();
    const created = await createFile(target, trimmed);
    await refreshTree();
    await openFile(created);
  },

  newRawFile: async (dir, name) => {
    const trimmed = name.trim();
    const target = dir ?? get().workspacePath;
    if (!target || !trimmed) return;
    const { refreshTree, openFile } = get();
    const created = await createRawFile(target, trimmed);
    await refreshTree();
    await openFile(created);
  },

  newFolder: async (dir, name) => {
    const trimmed = name.trim();
    const target = dir ?? get().workspacePath;
    if (!target || !trimmed) return;
    await createFolder(target, trimmed);
    await get().refreshTree();
  },

  rename: async (path, newName) => {
    const trimmed = newName.trim();
    const current = basename(path);
    if (!trimmed || trimmed === current) return;
    const newPath = await renamePath(path, trimmed);
    const { activeFilePath, selectedPath, folderViewPath, refreshTree } = get();
    await refreshTree();
    // Remap any open tab whose path is (or is nested under) the renamed node.
    const remap = (p: string) =>
      p === path ? newPath : p.startsWith(path + "/") ? newPath + p.slice(path.length) : p;
    set((s) => ({ openTabs: s.openTabs.map(remap) }));
    if (activeFilePath && (activeFilePath === path || activeFilePath.startsWith(path + "/")))
      set({ activeFilePath: remap(activeFilePath) });
    if (selectedPath === path) set({ selectedPath: newPath });
    if (folderViewPath === path) set({ folderViewPath: newPath });
  },

  moveNode: async (path, destDir) => {
    await get().moveNodes([path], destDir);
  },

  moveNodes: async (paths, destDir) => {
    // Moving a folder carries its descendants, so drop any path whose ancestor
    // is also moving; skip no-ops (already in destDir, or destDir is inside a
    // moved folder's own subtree).
    const roots = paths.filter((p) => !paths.some((o) => o !== p && p.startsWith(o + "/")));
    const toMove = roots.filter(
      (p) => p !== destDir && dirname(p) !== destDir && !destDir.startsWith(p + "/"),
    );
    if (toMove.length === 0) return;

    const moved: Array<[string, string]> = [];
    const failed: string[] = [];
    for (const p of toMove) {
      try {
        moved.push([p, await movePath(p, destDir)]);
      } catch {
        failed.push(basename(p));
      }
    }
    await get().refreshTree();

    // Each moved node keeps its name, so only its parent prefix changes.
    const remap = (p: string): string => {
      for (const [oldP, newP] of moved) {
        if (p === oldP) return newP;
        if (p.startsWith(oldP + "/")) return newP + p.slice(oldP.length);
      }
      return p;
    };
    const { activeFilePath, selectedPath, folderViewPath } = get();
    set((s) => ({ openTabs: s.openTabs.map(remap), selectedPaths: [] }));
    if (activeFilePath) set({ activeFilePath: remap(activeFilePath) });
    if (selectedPath) set({ selectedPath: remap(selectedPath) });
    if (folderViewPath) set({ folderViewPath: remap(folderViewPath) });

    if (failed.length) get().showToast(`有 ${failed.length} 项未能移动`, "error");
  },

  requestMove: (path, destDir) => get().requestMoveMany([path], destDir),

  requestMoveMany: (paths, destDir) => {
    const roots = paths.filter((p) => !paths.some((o) => o !== p && p.startsWith(o + "/")));
    const movable = roots.filter(
      (p) => p !== destDir && dirname(p) !== destDir && !destDir.startsWith(p + "/"),
    );
    if (movable.length === 0) return;
    const message =
      movable.length === 1
        ? `将「${basename(movable[0])}」移动到「${basename(destDir)}」？`
        : `将 ${movable.length} 个项目移动到「${basename(destDir)}」？`;
    set({
      confirm: {
        title: "移动",
        message,
        confirmLabel: "移动",
        tone: "primary",
        onConfirm: () => get().moveNodes(movable, destDir),
      },
    });
  },

  setSelection: (paths, anchor) =>
    set(anchor !== undefined ? { selectedPaths: paths, selectedPath: anchor } : { selectedPaths: paths }),

  toggleSelection: (path) => {
    const { selectedPaths, selectedPath } = get();
    const base = selectedPaths.length ? selectedPaths : selectedPath ? [selectedPath] : [];
    const next = base.includes(path) ? base.filter((p) => p !== path) : [...base, path];
    set({ selectedPaths: next, selectedPath: path });
  },

  selectRange: (path, visibleOrder) => {
    const anchor = get().selectedPath ?? path;
    const a = visibleOrder.indexOf(anchor);
    const b = visibleOrder.indexOf(path);
    if (a === -1 || b === -1) {
      set({ selectedPaths: [path], selectedPath: path });
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    set({ selectedPaths: visibleOrder.slice(lo, hi + 1) });
  },

  clearSelection: () => set({ selectedPaths: [] }),

  removeNow: async (path) => {
    await deletePath(path);
    const { activeFilePath, selectedPath, folderViewPath, openTabs, refreshTree } = get();
    await refreshTree();
    const under = (p: string | null) => p === path || (!!p && p.startsWith(path + "/"));

    // Drop every open tab that lived under the deleted path.
    const remaining = openTabs.filter((p) => !under(p));
    if (remaining.length !== openTabs.length) set({ openTabs: remaining });

    if (under(selectedPath)) set({ selectedPath: null });
    if (under(folderViewPath)) set({ folderViewPath: null });

    if (under(activeFilePath)) {
      // Activate a neighbor tab if any survive; otherwise clear the pane.
      if (remaining.length > 0) {
        const idx = openTabs.indexOf(activeFilePath!);
        const neighbor = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
        set({ activeFilePath: null, content: "", isDirty: false });
        await get().openFile(neighbor);
      } else {
        set((s) => ({
          activeFilePath: null,
          content: "",
          isDirty: false,
          docKey: s.docKey + 1,
          activeFormats: emptyFormats,
        }));
      }
    }
  },

  remove: async (path) => {
    set({
      confirm: {
        title: "删除",
        message: `确定删除「${basename(path)}」？此操作不可撤销。`,
        confirmLabel: "删除",
        onConfirm: () => get().removeNow(path),
      },
    });
  },

  openPrompt: (req) => set({ prompt: req }),

  requestGitCredential: (req) =>
    new Promise((resolve) => {
      set({
        gitCredentialPrompt: {
          ...req,
          onSubmit: (credential) => {
            set({ gitCredentialPrompt: null });
            resolve(credential);
          },
          onCancel: () => {
            set({ gitCredentialPrompt: null });
            resolve(null);
          },
        },
      });
    }),

  requestNewFile: (dir) => {
    const target = dir ?? get().workspacePath;
    if (!target) return;
    set({
      prompt: {
        title: "新建笔记",
        defaultValue: "未命名",
        onSubmit: (name) => get().newFile(target, name),
      },
    });
  },

  requestNewRawFile: (dir) => {
    const target = dir ?? get().workspacePath;
    if (!target) return;
    set({
      prompt: {
        title: "新建文件",
        defaultValue: "未命名.txt",
        onSubmit: (name) => {
          if (!/\.[^./\\]+$/.test(name.trim())) {
            throw "请填写文件后缀名（例如 .txt、.json）";
          }
          return get().newRawFile(target, name);
        },
      },
    });
  },

  requestNewFolder: (dir) => {
    const target = dir ?? get().workspacePath;
    if (!target) return;
    set({
      prompt: {
        title: "新建文件夹",
        defaultValue: "新建文件夹",
        onSubmit: (name) => get().newFolder(target, name),
      },
    });
  },

  requestRename: (path) => {
    set({
      prompt: {
        title: "重命名",
        defaultValue: basename(path),
        onSubmit: (name) => get().rename(path, name),
      },
    });
  },

  closePrompt: () => set({ prompt: null }),

  closeGitCredentialPrompt: () => {
    const prompt = get().gitCredentialPrompt;
    if (prompt) prompt.onCancel();
  },

  openConfirm: (req) => set({ confirm: req }),

  closeConfirm: () => set({ confirm: null }),

  openHistory: () => {
    const { activeFilePath, workspacePath } = get();
    if (activeFilePath) {
      set({ history: { path: activeFilePath, kind: "file" } });
    } else if (workspacePath) {
      set({ history: { path: workspacePath, kind: "dir" } });
    }
  },

  openHistoryAt: (path, kind) => set({ history: { path, kind } }),

  closeHistory: () => set({ history: null }),

  openNewWindow: async (workspacePath) => {
    // Every non-"settings" window renders the full app (main.tsx branches on
    // the label), so a fresh "main-N" label is all a new editor window needs.
    // Reuse the lowest free N so the window-state plugin restores the position
    // a closed window of that slot was last left at. The workspace to open
    // travels in the URL; without one the window starts as an empty project
    // (App.tsx only restores the last workspace in the original "main").
    const taken = new Set((await getAllWebviewWindows()).map((w) => w.label));
    let n = 2;
    while (taken.has(`main-${n}`)) n++;
    new WebviewWindow(`main-${n}`, {
      url: workspacePath
        ? `index.html?ws=${encodeURIComponent(workspacePath)}`
        : "index.html",
      title: "Idea Note",
      width: 960,
      height: 640,
      minWidth: 640,
      minHeight: 420,
      // Same chrome as the config's main window: macOS hides the title under
      // the traffic-light overlay, Windows drops decorations entirely and the
      // TitleBar component draws its own window controls.
      ...(isWindows
        ? { decorations: false }
        : { titleBarStyle: "overlay" as const, hiddenTitle: true }),
    });
  },

  openSettings: async (tab) => {
    // The settings window has no workspace of its own, so the opener's
    // workspace + label travel along (URL on creation, event when reusing)
    // for the remote-sync tab to act on the right main window. An optional
    // `tab` selects which settings section to show on open.
    const context = {
      ws: get().workspacePath,
      src: getCurrentWindow().label,
      tab,
    };
    const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW);
    if (existing) {
      await existing.setFocus();
      emit(SETTINGS_CONTEXT_EVENT, context).catch(() => {});
      return;
    }
    const params = new URLSearchParams();
    if (context.ws) params.set("ws", context.ws);
    params.set("src", context.src);
    if (tab) params.set("tab", tab);
    // A real OS window: it can be dragged anywhere (including off the main
    // window) and is non-modal, so the main window stays fully editable.
    new WebviewWindow(SETTINGS_WINDOW, {
      url: `index.html?${params.toString()}`,
      title: "设置",
      width: 720,
      height: 460,
      resizable: false,
      decorations: false,
      center: true,
    });
  },

  setTheme: (themeId) => {
    const customThemes = get().customThemes;
    const mode: Theme = resolveTheme(themeId, customThemes).dark ? "dark" : "light";
    commitSettings({ ...snapshotSettings(get), themeId, appearanceMode: mode });
    set({ themeId, theme: mode, appearanceMode: mode });
  },

  addCustomTheme: (sourceId) => {
    const { customThemes } = get();
    const source = resolveTheme(sourceId, customThemes);
    const id = newThemeId();
    // Name new themes "<source> 副本", de-duplicated with a numeric suffix.
    const baseName = `${source.name} 副本`;
    const taken = new Set([
      ...BUILTIN_THEMES.map((t) => t.name),
      ...customThemes.map((t) => t.name),
    ]);
    let name = baseName;
    for (let i = 2; taken.has(name); i++) name = `${baseName} ${i}`;
    const theme = makeCustomTheme(source, id, name);
    const nextCustom = [...customThemes, theme];
    const mode: Theme = theme.dark ? "dark" : "light";
    commitSettings({
      ...snapshotSettings(get),
      customThemes: nextCustom,
      themeId: id,
      appearanceMode: mode,
    });
    set({ customThemes: nextCustom, themeId: id, theme: mode, appearanceMode: mode });
    return id;
  },

  updateCustomTheme: (id, patch) => {
    const { customThemes, themeId } = get();
    const nextCustom = customThemes.map((t) =>
      t.id === id
        ? {
            ...t,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.dark !== undefined ? { dark: patch.dark } : {}),
            colors: patch.colors ? { ...t.colors, ...patch.colors } : t.colors,
          }
        : t,
    );
    const active = nextCustom.find((t) => t.id === themeId);
    const mode: Theme = active?.dark ? "dark" : themeId === id ? "light" : get().theme;
    commitSettings({ ...snapshotSettings(get), customThemes: nextCustom, appearanceMode: mode });
    set({ customThemes: nextCustom, theme: mode, appearanceMode: mode });
  },

  deleteCustomTheme: (id) => {
    const { customThemes, themeId } = get();
    const nextCustom = customThemes.filter((t) => t.id !== id);
    // If the deleted theme was active, fall back to light.
    const nextId = themeId === id ? "light" : themeId;
    const mode: Theme = resolveTheme(nextId, nextCustom).dark ? "dark" : "light";
    commitSettings({
      ...snapshotSettings(get),
      customThemes: nextCustom,
      themeId: nextId,
      appearanceMode: mode,
    });
    set({ customThemes: nextCustom, themeId: nextId, theme: mode, appearanceMode: mode });
  },

  setEditorFontSize: (size) => {
    const editorFontSize = Math.min(22, Math.max(12, size));
    commitSettings({ ...snapshotSettings(get), editorFontSize });
    set({ editorFontSize });
  },

  setEditorLineHeight: (height) => {
    const editorLineHeight = Math.min(2.2, Math.max(1.3, height));
    commitSettings({ ...snapshotSettings(get), editorLineHeight });
    set({ editorLineHeight });
  },

  setEditorFontFamily: (value) => {
    const editorFontFamily = EDITOR_FONT_OPTIONS.some((o) => o.value === value)
      ? value
      : "";
    commitSettings({ ...snapshotSettings(get), editorFontFamily });
    set({ editorFontFamily });
  },

  setEditorHeadingScale: (scale) => {
    const editorHeadingScale = Math.min(
      HEADING_SCALE_MAX,
      Math.max(HEADING_SCALE_MIN, scale),
    );
    commitSettings({ ...snapshotSettings(get), editorHeadingScale });
    set({ editorHeadingScale });
  },

  setEditorLineNumbers: (editorLineNumbers) => {
    commitSettings({ ...snapshotSettings(get), editorLineNumbers });
    set({ editorLineNumbers });
  },

  setEditorKeybinding: (commandId, key) => {
    const next = { ...get().editorKeybindings };
    if (key && key.trim()) next[commandId] = key;
    else delete next[commandId];
    commitSettings({ ...snapshotSettings(get), editorKeybindings: next });
    set({ editorKeybindings: next });
  },

  resetEditorKeybindings: () => {
    commitSettings({ ...snapshotSettings(get), editorKeybindings: {} });
    set({ editorKeybindings: {} });
  },

  setEditorMaxTabs: (max) => {
    const editorMaxTabs = Math.min(
      EDITOR_MAX_TABS_MAX,
      Math.max(EDITOR_MAX_TABS_MIN, Math.round(max)),
    );
    commitSettings({ ...snapshotSettings(get), editorMaxTabs });
    // Lowering the cap may leave too many tabs open — trim the oldest now.
    set((s) => ({ editorMaxTabs, openTabs: trimTabs(s.openTabs, editorMaxTabs, s.activeFilePath) }));
  },

  setAiAssistantFontSize: (size) => {
    const aiAssistantFontSize = Math.min(
      AI_ASSISTANT_FONT_MAX,
      Math.max(AI_ASSISTANT_FONT_MIN, size),
    );
    commitSettings({ ...snapshotSettings(get), aiAssistantFontSize });
    set({ aiAssistantFontSize });
  },

  setCompactSidebar: (compactSidebar) => {
    commitSettings({ ...snapshotSettings(get), compactSidebar });
    set({ compactSidebar });
  },

  setCompactEditor: (compactEditor) => {
    commitSettings({ ...snapshotSettings(get), compactEditor });
    set({ compactEditor });
  },

  setUiZoom: (zoom) => {
    const uiZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
    commitSettings({ ...snapshotSettings(get), uiZoom });
    set({ uiZoom });
  },

  setSidebarFontSize: (mode, size) => {
    const clamped = Math.min(SIDEBAR_FONT_MAX, Math.max(SIDEBAR_FONT_MIN, size));
    const key =
      mode === "files"
        ? "sidebarFilesFontSize"
        : mode === "notes"
          ? "sidebarNotesFontSize"
          : "sidebarOutlineFontSize";
    commitSettings({ ...snapshotSettings(get), [key]: clamped });
    set({ [key]: clamped });
  },

  setAttachmentSettings: (patch) => {
    const { workspacePath } = get();
    set(patch);
    if (workspacePath) {
      const s = get();
      saveAttachmentConfig(workspacePath, {
        imageLocation: s.imageLocation,
        imageDir: s.imageDir,
        attachmentLocation: s.attachmentLocation,
        attachmentDir: s.attachmentDir,
      });
      emit(SYNC_CONFIG_EVENT, { workspace: workspacePath }).catch(() => {});
    }
  },

  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    get().setTheme(next);
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setMdViewMode: (mode) => set({ mdViewMode: mode }),

  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),

  setBottomPanelHeight: (height) =>
    set({ bottomPanelHeight: Math.min(window.innerHeight - 120, Math.max(120, height)) }),

  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

  setRightPanelWidth: (width) => {
    const maxWidth = Math.max(
      RIGHT_PANEL_MIN_WIDTH,
      window.innerWidth * RIGHT_PANEL_MAX_RATIO,
    );
    set({ rightPanelWidth: Math.min(maxWidth, Math.max(RIGHT_PANEL_MIN_WIDTH, width)) });
  },

  // AI model config lives in a Rust-owned file (not localStorage). After every
  // change we persist the whole list and broadcast so the other window (e.g.
  // the settings window adding a model, the main window's chat) reloads it.
  addAiModel: async (model) => {
    const aiModels = [...get().aiModels, model];
    set({ aiModels });
    await saveModels(aiModels);
    emit(AI_MODELS_EVENT).catch(() => {});
  },

  updateAiModel: async (id, patch) => {
    const aiModels = get().aiModels.map((m) => (m.id === id ? { ...m, ...patch } : m));
    set({ aiModels });
    await saveModels(aiModels);
    emit(AI_MODELS_EVENT).catch(() => {});
  },

  removeAiModel: async (id) => {
    const aiModels = get().aiModels.filter((m) => m.id !== id);
    set({ aiModels });
    await saveModels(aiModels);
    emit(AI_MODELS_EVENT).catch(() => {});
  },

  refreshGitInfo: async () => {
    const { workspacePath } = get();
    if (!workspacePath) {
      set({ gitInfo: null });
      return;
    }
    const gitInfo = await getGitInfo(workspacePath);
    // Workspace may have changed while we probed.
    if (get().workspacePath === workspacePath) set({ gitInfo });
  },

  syncNow: async () => {
    const { workspacePath, syncState } = get();
    if (!workspacePath || syncState === "syncing") return;

    const broadcast = () => {
      const { syncState, lastSyncMessage, lastSyncAt } = get();
      emit(SYNC_STATE_EVENT, { syncState, lastSyncMessage, lastSyncAt }).catch(() => {});
    };

    set({ syncState: "syncing", lastSyncMessage: null });
    broadcast();
    try {
      await get().flushActiveTab();

      // AI commit messages (设置 → 远程同步 → 提交文案, global). Resolved here
      // per sync so config/model edits in the settings window take effect
      // immediately; generation failure falls back to the timestamp.
      let commitMessage: CommitMessageProvider | undefined;
      const commitCfg = readCommitMessageConfig();
      if (commitCfg.mode === "ai") {
        const models = get().aiModels;
        const model =
          resolveModelSelection(models, commitCfg.model) ??
          resolveModelSelection(models, firstModelSelection(models));
        if (model) commitMessage = (dir) => generateCommitMessage(model, dir, commitCfg.convention);
      }

      const result = await syncWorkspace(
        workspacePath,
        readGlobalProxy(),
        get().requestGitCredential,
        commitMessage,
      );

      // The merge may have rewritten files on disk: refresh the tree, and
      // reload the open file unless the user kept typing during the sync.
      // An "already up to date" sync touched nothing — skip both.
      if (result.changed) {
        await get().refreshTree().catch(() => {});
        const { activeFilePath } = get();
        if (
          activeFilePath &&
          !isDraftPath(activeFilePath) &&
          !get().isDirty &&
          !isImageFile(activeFilePath)
        ) {
          try {
            const fresh = await readFile(activeFilePath);
            if (fresh !== get().content) {
              set((s) => ({ content: fresh, docKey: s.docKey + 1 }));
            }
            // Sync rewrote the file on disk; refresh the stat baseline so the
            // next focus check doesn't re-trigger on this same change.
            void captureDiskStat(activeFilePath);
          } catch {
            // File removed by the merge — clear the editor and drop its tab.
            set((s) => ({
              activeFilePath: null,
              selectedPath: null,
              content: "",
              openTabs: s.openTabs.filter((p) => p !== activeFilePath),
            }));
          }
        }
      }

      set({
        syncState: result.ok ? (result.conflictFiles.length > 0 ? "conflict" : "success") : "error",
        lastSyncMessage: result.message,
        // The shown "last synced" time only advances when something actually
        // moved; the auto-sync timer (App.tsx setInterval) is unaffected.
        lastSyncAt: result.changed ? Date.now() : get().lastSyncAt,
      });
      void get().refreshGitInfo();

      // The conflict case opens its own modal below; everything else gets a toast.
      if (result.conflictFiles.length === 0) {
        get().showToast(result.message, result.ok ? "success" : "error");
      }

      if (result.conflictFiles.length > 0) {
        const first = result.conflictFiles[0];
        set({
          confirm: {
            title: "同步冲突",
            message:
              `${result.conflictFiles.length} 个文件存在冲突，双方修改均已保留（以 <<<<<<< 标记区分）。` +
              `请整理后再次同步：\n${result.conflictFiles.slice(0, 5).join("\n")}` +
              (result.conflictFiles.length > 5 ? "\n…" : ""),
            confirmLabel: "查看冲突",
            tone: "primary",
            onConfirm: () => get().openFile(`${workspacePath}/${first}`),
          },
        });
      }
    } catch (err) {
      const message = `同步失败：${err instanceof Error ? err.message : String(err)}`;
      set({ syncState: "error", lastSyncMessage: message, lastSyncAt: Date.now() });
      get().showToast(message, "error");
    } finally {
      broadcast();
    }
  },

  rollbackToVersion: async (commit, oldContent) => {
    const { workspacePath, history, isDirty } = get();
    if (!workspacePath || !history) return;
    if (isDirty) {
      get().showToast("当前文件有未保存更改，请先同步后再回退", "error");
      return;
    }
    if ((await listWorkingChanges(workspacePath)).length > 0) {
      get().showToast("当前有未提交更改，请先同步后再回退", "error");
      return;
    }
    await writeFile(history.path, oldContent);
    if (get().activeFilePath === history.path) {
      set((s) => ({ content: oldContent, docKey: s.docKey + 1, isDirty: false }));
      void captureDiskStat(history.path);
    }
    set({ history: null });
    get().showToast(`已回退到 ${commit.shortHash}，可在同步时提交`);
    void get().refreshGitInfo();
  },

  rollbackWorkspaceToVersion: async (commit) => {
    const { workspacePath, activeFilePath, isDirty } = get();
    if (!workspacePath) return;
    if (isDirty) {
      get().showToast("当前文件有未保存更改，请先同步后再回退", "error");
      return;
    }
    if ((await listWorkingChanges(workspacePath)).length > 0) {
      get().showToast("当前有未提交更改，请先同步后再回退", "error");
      return;
    }
    // Restore the target tree without moving HEAD. The rollback remains an
    // ordinary working-tree change for manual or scheduled sync to commit.
    await restoreWorkspaceToCommit(workspacePath, commit.hash);
    const tree = await listDir(workspacePath);
    // The snapshot may have added/removed files: drop any open tab whose file
    // no longer exists in the restored tree.
    const survives = (p: string) => {
      const n = findNode(tree, p);
      return !!n && !n.is_dir;
    };
    set((s) => ({ tree, openTabs: s.openTabs.filter(survives) }));

    if (activeFilePath) {
      if (survives(activeFilePath)) {
        await get().openFile(activeFilePath);
      } else {
        // Active file gone: fall back to a surviving tab, or clear the pane.
        const next = get().openTabs;
        if (next.length > 0) {
          await get().openFile(next[next.length - 1]);
        } else {
          set((s) => ({
            activeFilePath: null,
            selectedPath: null,
            folderViewPath: null,
            content: "",
            isDirty: false,
            docKey: s.docKey + 1,
            activeFormats: emptyFormats,
          }));
        }
      }
    }

    set({ history: null });
    get().showToast(`已将项目回退到 ${commit.shortHash}，可在同步时提交`);
    void get().refreshGitInfo();
  },

  discardHistoryChanges: async (files) => {
    const { workspacePath, activeFilePath, isDirty, save } = get();
    if (!workspacePath || files.length === 0) return;

    const repoRoot = await getRepoRoot(workspacePath);
    const activeRepoPath =
      activeFilePath && activeFilePath.startsWith(repoRoot)
        ? activeFilePath.slice(repoRoot.length).replace(/^[\\/]/, "").replace(/\\/g, "/")
        : null;
    const touchesActive =
      !!activeRepoPath &&
      files.some((f) => f.path === activeRepoPath || f.oldPath === activeRepoPath);

    // If the open file is the file being discarded, flush the editor first so
    // the git operation discards exactly what the user sees.
    if (touchesActive && isDirty) await save();

    await discardWorkingChanges(workspacePath, files);
    await get().refreshTree().catch(() => {});

    if (activeFilePath && touchesActive) {
      try {
        const fresh = await readFile(activeFilePath);
        set((s) => ({ content: fresh, docKey: s.docKey + 1, isDirty: false }));
        void captureDiskStat(activeFilePath);
      } catch {
        set((s) => ({
          activeFilePath: null,
          selectedPath: null,
          folderViewPath: null,
          content: "",
          isDirty: false,
          docKey: s.docKey + 1,
          activeFormats: emptyFormats,
        }));
      }
    }

    get().showToast(files.length === 1 ? "已撤销未提交更改" : `已撤销 ${files.length} 个未提交文件`);
    void get().refreshGitInfo();
  },

  showToast: (message, tone = "success") => {
    set((s) => ({ toast: { id: (s.toast?.id ?? 0) + 1, message, tone } }));
  },

  dismissToast: () => set({ toast: null }),

  setSyncConfig: (patch) => {
    const { workspacePath, syncConfig } = get();
    const next = { ...syncConfig, ...patch };
    set({ syncConfig: next });
    if (workspacePath) {
      saveSyncConfig(workspacePath, next);
      emit(SYNC_CONFIG_EVENT, { workspace: workspacePath }).catch(() => {});
    }
  },
}));

// Apply settings changed in the *other* window (the broadcaster also receives
// its own event — harmless, since we only set state + DOM here, never re-emit).
listen<AppSettings>(SETTINGS_EVENT, ({ payload }) => {
  const customThemes = payload.customThemes ?? [];
  const themeId = canonicalThemeId(payload.themeId ?? payload.appearanceMode);
  const mode: Theme = applyTheme(themeId, customThemes);
  applyEditorSettings(payload);
  applyAiAssistantSettings(payload);
  applySidebarSettings(payload);
  applyZoom(payload.uiZoom);
  useAppStore.setState((s) => ({
    theme: mode,
    themeId,
    customThemes,
    openTabs: trimTabs(s.openTabs, payload.editorMaxTabs, s.activeFilePath),
    appearanceMode: mode,
    editorFontSize: payload.editorFontSize,
    editorLineHeight: payload.editorLineHeight,
    editorLineNumbers: payload.editorLineNumbers,
    editorFontFamily: payload.editorFontFamily,
    editorHeadingScale: payload.editorHeadingScale,
    editorMaxTabs: payload.editorMaxTabs,
    aiAssistantFontSize: payload.aiAssistantFontSize,
    compactSidebar: payload.compactSidebar,
    compactEditor: payload.compactEditor,
    uiZoom: payload.uiZoom,
    sidebarFilesFontSize: payload.sidebarFilesFontSize,
    sidebarNotesFontSize: payload.sidebarNotesFontSize,
    sidebarOutlineFontSize: payload.sidebarOutlineFontSize,
    editorKeybindings: payload.editorKeybindings ?? {},
  }));
}).catch(() => {});

// Warm the sync-config cache (and run the one-time localStorage migration) as
// soon as the store loads, in both the main and settings windows.
void ensureSyncConfigsLoaded();
// Warm the global proxy cache (and migrate any legacy per-workspace proxy).
void ensureGlobalProxyLoaded();

// Keep the global proxy cache fresh when another window edits it (all windows
// read it: main to sync, settings to seed the proxy field).
listen(GIT_PROXY_EVENT, () => {
  void reloadGlobalProxy();
}).catch(() => {});

// Load the AI model list on startup, and reload whenever the other window
// changes it (the broadcaster also receives its own event — harmless re-read).
void loadModels().then((aiModels) => useAppStore.setState({ aiModels }));
listen(AI_MODELS_EVENT, () => {
  void loadModels().then((aiModels) => useAppStore.setState({ aiModels }));
}).catch(() => {});

// Remote-sync requests from the settings window. Each event names its target
// main window, so only that window acts (the settings window never syncs).
if (!isSettingsWindow) {
  const myLabel = (() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return "main";
    }
  })();

  listen<{ target: string }>(SYNC_REQUEST_EVENT, ({ payload }) => {
    if (payload.target === myLabel) void useAppStore.getState().syncNow();
  }).catch(() => {});

  listen<{ target: string; path: string }>(WORKSPACE_OPEN_EVENT, ({ payload }) => {
    if (payload.target === myLabel)
      void useAppStore.getState().openWorkspaceAt(payload.path);
  }).catch(() => {});

  listen<{ workspace: string }>(GIT_ATTACHED_EVENT, ({ payload }) => {
    if (useAppStore.getState().workspacePath === payload.workspace)
      void useAppStore.getState().refreshGitInfo();
  }).catch(() => {});

  listen<{ workspace: string }>(SYNC_CONFIG_EVENT, ({ payload }) => {
    // The other window wrote the workspace-config file (sync and/or attachment
    // dirs); re-read it before mirroring the active workspace into state.
    void reloadSyncConfigs().then(() => {
      if (useAppStore.getState().workspacePath === payload.workspace)
        useAppStore.setState({
          syncConfig: readSyncConfig(payload.workspace),
          ...readAttachmentConfig(payload.workspace),
        });
    });
  }).catch(() => {});
}

export { dirname };
