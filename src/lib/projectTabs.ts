// Project tabs: several project windows shown as one (see project_tabs.rs).
//
// Each project keeps its own window and WebView; Rust owns the group list and
// does the frame-swap when switching. This module mirrors that list for the
// rail and reports this window's workspace / needs-attention state back.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface ProjectTab {
  label: string;
  group: string;
  workspace: string | null;
  /** Waiting for user input (a prompt or confirm dialog). */
  attention: boolean;
}

export interface ProjectTabsSnapshot {
  members: ProjectTab[];
  /** Group id → label of the window shown for that group. */
  active: Record<string, string>;
}

export interface ProjectTabsSession {
  workspaces: string[];
  active: string | null;
}

const CHANGED_EVENT = "project-tabs:changed";
/** Label of the window a rail drag would merge into right now, or null. */
export const DROP_TARGET_EVENT = "project-tabs:drop-target";
/** Ask one project window ({ target }) to close itself, prompts included. */
export const PROJECT_TAB_CLOSE_EVENT = "project-tabs:close";
/** Tell one project window ({ target }) that it was brought forward instead
 *  of opening its project a second time. */
export const PROJECT_TAB_REUSED_EVENT = "project-tabs:reused";

let snapshot: ProjectTabsSnapshot = { members: [], active: {} };
const subscribers = new Set<() => void>();
let registered = false;
/** Latest values this window wants Rust to hold, and what was last sent. */
let desired = { workspace: null as string | null, attention: false };
let sent = "";

function setSnapshot(next: ProjectTabsSnapshot) {
  snapshot = next;
  subscribers.forEach((fn) => fn());
}

function myLabel(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    return null; // plain browser, no Tauri
  }
}

/** This window's group id, or null when tabs aren't available. */
export function currentProjectGroup(): string | null {
  const label = myLabel();
  return snapshot.members.find((m) => m.label === label)?.group ?? null;
}

/** Join the tab list (a new group unless `group` names a live one). */
export async function registerProjectTab(group: string | null, workspace: string | null) {
  try {
    await listen<ProjectTabsSnapshot>(CHANGED_EVENT, ({ payload }) => setSnapshot(payload));
    desired.workspace ??= workspace;
    setSnapshot(
      await invoke<ProjectTabsSnapshot>("project_tabs_register", {
        group,
        workspace: desired.workspace,
      }),
    );
    registered = true;
    sent = JSON.stringify({ workspace: desired.workspace, attention: false });
    flush();
  } catch {
    // No Tauri backend (e.g. running in a plain browser): no tabs.
  }
}

function flush() {
  if (!registered) return;
  const key = JSON.stringify(desired);
  if (key === sent) return;
  sent = key;
  void invoke("project_tabs_update", desired).catch(() => {});
}

/** Report this window's project and whether it is waiting on the user. */
export function updateProjectTab(workspace: string | null, attention: boolean) {
  desired = { workspace, attention };
  flush();
}

export function activateProjectTab(label: string) {
  return invoke("project_tabs_activate", { label }).catch(() => {});
}

/** Split `label` out into its own window; `at` (logical screen px of the
 *  cursor) places it under a rail drag's release point. */
export function detachProjectTab(label: string, at?: { x: number; y: number }) {
  return invoke("project_tabs_detach", { label, x: at?.x, y: at?.y }).catch(() => {});
}

/** A rail drag released outside the rail at `at` (logical screen px): over
 *  another project window the tab joins that window's tabs, anywhere else it
 *  becomes a window of its own. */
export function dropProjectTab(label: string, at: { x: number; y: number }) {
  return invoke("project_tabs_drop", { label, x: at.x, y: at.y }).catch(() => {});
}

/** Report a rail drag outside the rail at `at` (null once it ends); resolves
 *  to the label of the window a release there would merge into. */
export function hoverProjectTab(label: string, at: { x: number; y: number } | null) {
  return invoke<string | null>("project_tabs_hover", { label, x: at?.x, y: at?.y }).catch(() => null);
}

/** Gather every project window into this window's tabs. */
export function mergeAllProjectWindows() {
  return invoke("project_tabs_merge_all").catch(() => {});
}

/** The workspace open in window `label`, if known. */
export function projectWorkspaceOf(label: string): string | null {
  return snapshot.members.find((m) => m.label === label)?.workspace ?? null;
}

/** The window (tab) that already has `workspace` open, compared by real
 *  path, or null. Includes this window. */
export function findProjectTab(workspace: string): Promise<string | null> {
  return invoke<string | null>("project_tabs_find", { workspace }).catch(() => null);
}

/**
 * Opening `workspace` when some window already has it: bring that tab
 * forward instead (and let it say so). True when it was already open, so the
 * caller must not open it again.
 */
export async function revealOpenProject(workspace: string): Promise<boolean> {
  const label = await findProjectTab(workspace);
  if (!label) return false;
  if (label !== myLabel()) await activateProjectTab(label);
  await emit(PROJECT_TAB_REUSED_EVENT, { target: label }).catch(() => {});
  return true;
}

/** Reorder the rail: put `label` before `before` (null = at the end). */
export function moveProjectTab(label: string, before: string | null) {
  return invoke("project_tabs_move", { label, before }).catch(() => {});
}

/** Show `label` and have it close its own project (unsaved prompt included). */
export async function closeProjectTabWindow(label: string) {
  await activateProjectTab(label);
  await emit(PROJECT_TAB_CLOSE_EVENT, { target: label });
}

/** The project groups open at the previous run, first group first. */
export async function loadProjectTabsSession(): Promise<ProjectTabsSession[]> {
  try {
    return await invoke<ProjectTabsSession[]>("project_tabs_session");
  } catch {
    return [];
  }
}

/** The group id of window `label`, once it has registered. */
export function projectGroupOf(label: string): string | null {
  return snapshot.members.find((m) => m.label === label)?.group ?? null;
}

/** Resolve once `label` has registered (or after `timeoutMs`). */
export function waitForProjectTab(label: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      subscribers.delete(check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (snapshot.members.some((m) => m.label === label)) done();
    };
    const timer = setTimeout(done, timeoutMs);
    subscribers.add(check);
    check();
  });
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** The tabs of this window's group, in rail order, plus the shown one. */
export function useProjectTabs(): {
  tabs: ProjectTab[];
  activeLabel: string | null;
  myLabel: string | null;
  /** How many project windows (groups) are open. */
  windowCount: number;
} {
  const snap = useSyncExternalStore(subscribe, () => snapshot);
  const label = myLabel();
  const group = snap.members.find((m) => m.label === label)?.group;
  const windowCount = new Set(snap.members.map((m) => m.group)).size;
  if (!group) return { tabs: [], activeLabel: null, myLabel: label, windowCount };
  return {
    tabs: snap.members.filter((m) => m.group === group),
    activeLabel: snap.active[group] ?? null,
    myLabel: label,
    windowCount,
  };
}

/** Switch to the next / previous tab in this window's group. */
export function cycleProjectTab(step: 1 | -1) {
  const label = myLabel();
  const group = currentProjectGroup();
  if (!group) return;
  const tabs = snapshot.members.filter((m) => m.group === group);
  if (tabs.length < 2) return;
  const i = tabs.findIndex((m) => m.label === label);
  void activateProjectTab(tabs[(i + step + tabs.length) % tabs.length].label);
}

/** How many tabs this window's group has (1 when tabs aren't available). */
export function projectTabCount(): number {
  const group = currentProjectGroup();
  if (!group) return 1;
  return snapshot.members.filter((m) => m.group === group).length;
}
