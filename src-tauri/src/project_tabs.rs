// Project tabs: several project windows presented as one.
//
// Every project still lives in its own "main"/"main-N" window, so each keeps a
// private WebView (store, editor, terminals, unlocked secrets) exactly as with
// separate windows. Windows that share a group are stacked on one frame and
// only the group's active window is shown; switching copies the visible
// window's frame onto the target, shows it, then hides the previous one.
// Hidden windows keep running (auto-sync, terminals, code runs).
//
// Rust owns the group membership so every window sees the same ordered list;
// changes are broadcast as CHANGED_EVENT. Every group is persisted so a
// restart can reopen each one as a window with all of its projects.

use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, State, WebviewWindow,
    Window, WindowEvent,
};

pub const CHANGED_EVENT: &str = "project-tabs:changed";
/// The window a rail drag would merge into if released now (label or null),
/// so that window can light up as the drop target.
pub const DROP_TARGET_EVENT: &str = "project-tabs:drop-target";
const SESSION_FILE: &str = "project-tabs.json";
/// Offset for a window split out of its group, so it lands visibly apart.
const DETACH_OFFSET: i32 = 40;
/// Where the cursor sits inside a window dragged out of the rail (logical px
/// from its top-left): on the title bar, a little in from the edge.
const DRAG_GRIP: (f64, f64) = (80.0, 16.0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    label: String,
    group: String,
    workspace: Option<String>,
    /// The window is waiting for user input (a prompt or confirm dialog).
    attention: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    members: Vec<Member>,
    /// Group id → label of the window currently shown for that group.
    active: HashMap<String, String>,
}

/// One group as saved for the next launch: its projects in rail order and
/// the one that was in front.
#[derive(Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    workspaces: Vec<String>,
    active: Option<String>,
}

/// On-disk format. Earlier builds saved a single group as a bare `Session`;
/// that still loads as a one-group file.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    #[serde(default)]
    groups: Vec<Session>,
    #[serde(default, skip_serializing)]
    workspaces: Vec<String>,
    #[serde(default, skip_serializing)]
    active: Option<String>,
}

#[derive(Clone, Copy)]
struct Frame {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Default)]
struct Inner {
    /// Rail order: registration order across all groups.
    members: Vec<Member>,
    active: HashMap<String, String>,
    /// Last known frame of each group's shown window, for when that window is
    /// gone (closed) and a neighbour has to take its place.
    frames: HashMap<String, Frame>,
    last_group: Option<String>,
    next_group: u32,
    /// Set once the app starts quitting: windows tearing down one by one must
    /// not shrink the saved session.
    exiting: bool,
    saved: Option<String>,
    /// Current drop target of a rail drag, to emit only on change.
    drop_target: Option<String>,
}

impl Inner {
    fn group_of(&self, label: &str) -> Option<String> {
        self.members.iter().find(|m| m.label == label).map(|m| m.group.clone())
    }

    fn new_group(&mut self) -> String {
        self.next_group += 1;
        format!("g{}", self.next_group)
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot { members: self.members.clone(), active: self.active.clone() }
    }

    /// Every group with at least one open project, in rail order (a group
    /// ranks by its first member, so the original window's group leads).
    fn sessions(&self) -> Vec<Session> {
        let mut groups: Vec<&str> = Vec::new();
        for m in &self.members {
            if !groups.contains(&m.group.as_str()) {
                groups.push(&m.group);
            }
        }
        groups
            .into_iter()
            .filter_map(|group| {
                let workspaces: Vec<String> = self
                    .members
                    .iter()
                    .filter(|m| m.group == group)
                    .filter_map(|m| m.workspace.clone())
                    .collect();
                if workspaces.is_empty() {
                    return None;
                }
                let active = self
                    .active
                    .get(group)
                    .and_then(|label| self.members.iter().find(|m| &m.label == label))
                    .and_then(|m| m.workspace.clone());
                Some(Session { workspaces, active })
            })
            .collect()
    }
}

#[derive(Default)]
pub struct ProjectTabs(Mutex<Inner>);

impl ProjectTabs {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_exiting(&self) {
        self.lock().exiting = true;
    }
}

/// The group member closest to rail position `index`: the first one at or
/// after it, else the nearest one before it.
fn neighbour(members: &[Member], index: usize, group: &str) -> Option<String> {
    let in_group = |m: &&Member| m.group == group;
    let index = index.min(members.len());
    members[index..]
        .iter()
        .find(in_group)
        .or_else(|| members[..index].iter().rev().find(in_group))
        .map(|m| m.label.clone())
}

pub fn is_project_window(label: &str) -> bool {
    label == "main" || label.starts_with("main-")
}

fn read_frame<R: Runtime>(window: &WebviewWindow<R>) -> Option<Frame> {
    Some(Frame {
        position: window.outer_position().ok()?,
        size: window.inner_size().ok()?,
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    })
}

fn apply_frame<R: Runtime>(window: &WebviewWindow<R>, frame: &Frame) {
    if frame.maximized {
        let _ = window.maximize();
        return;
    }
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    let _ = window.set_size(frame.size);
    let _ = window.set_position(frame.position);
}

fn reveal_window<R: Runtime>(window: &WebviewWindow<R>, frame: Option<&Frame>) {
    if let Some(frame) = frame {
        apply_frame(window, frame);
    }
    let _ = window.show();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    if frame.is_some_and(|f| f.fullscreen) {
        let _ = window.set_fullscreen(true);
    }
    let _ = window.set_focus();
}

/// Broadcast the new membership and persist the session (unless quitting).
fn publish<R: Runtime>(app: &AppHandle<R>, inner: &mut Inner) {
    let _ = app.emit(CHANGED_EVENT, inner.snapshot());
    if inner.exiting {
        return;
    }
    // Closing the very last project keeps what was saved before it, so the
    // next launch reopens that project like it always did.
    let groups = inner.sessions();
    if groups.is_empty() {
        return;
    }
    let file = SessionFile { groups, ..Default::default() };
    let Ok(json) = serde_json::to_string(&file) else { return };
    if inner.saved.as_deref() == Some(json.as_str()) {
        return;
    }
    let Ok(dir) = app.path().app_config_dir() else { return };
    if fs::create_dir_all(&dir).is_ok() && fs::write(dir.join(SESSION_FILE), &json).is_ok() {
        inner.saved = Some(json);
    }
}

/// Show `label` in place of its group's current window.
pub fn activate<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let state = app.state::<ProjectTabs>();
    let target = app
        .get_webview_window(label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    let (group, current, stored) = {
        let inner = state.lock();
        let Some(group) = inner.group_of(label) else {
            // Not a tab (yet): just bring it forward.
            drop(inner);
            reveal_window(&target, None);
            return Ok(());
        };
        let current = inner.active.get(&group).cloned();
        let stored = inner.frames.get(&group).copied();
        (group, current, stored)
    };

    let current = current
        .filter(|c| c != label)
        .and_then(|c| app.get_webview_window(&c));
    let shown = current.as_ref().filter(|w| w.is_visible().unwrap_or(false));
    let frame = shown.and_then(read_frame).or(stored);
    if let Some(cur) = shown {
        // A fullscreen window owns its own Space; leave it before hiding so
        // the target can take over fullscreen instead of an empty Space.
        if frame.is_some_and(|f| f.fullscreen) {
            let _ = cur.set_fullscreen(false);
        }
    }
    reveal_window(&target, frame.as_ref());
    if let Some(cur) = &current {
        let _ = cur.hide();
    }

    let mut inner = state.lock();
    inner.active.insert(group.clone(), label.to_string());
    if let Some(frame) = frame.or_else(|| read_frame(&target)) {
        inner.frames.insert(group.clone(), frame);
    }
    inner.last_group = Some(group);
    publish(app, &mut inner);
    Ok(())
}

/// Bring a window forward through its group (used for OS "Open With").
pub fn reveal<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let _ = activate(app, label);
}

/// macOS Dock click with nothing visible: show the last used group again.
pub fn reopen<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<ProjectTabs>();
    let label = {
        let inner = state.lock();
        inner
            .last_group
            .as_ref()
            .and_then(|g| inner.active.get(g))
            .cloned()
            .or_else(|| inner.members.first().map(|m| m.label.clone()))
    };
    if let Some(label) = label {
        reveal(app, &label);
    }
}

/// Track the shown window's frame, and hand over when a tab window closes.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let label = window.label();
    if !is_project_window(label) {
        return;
    }
    let app = window.app_handle();
    let state = app.state::<ProjectTabs>();
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let mut inner = state.lock();
            let Some(group) = inner.group_of(label) else { return };
            if inner.active.get(&group).map(String::as_str) != Some(label) {
                return;
            }
            if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
                return;
            }
            let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
                return;
            };
            inner.frames.insert(
                group,
                Frame {
                    position,
                    size,
                    maximized: window.is_maximized().unwrap_or(false),
                    fullscreen: window.is_fullscreen().unwrap_or(false),
                },
            );
        }
        WindowEvent::Destroyed => {
            let mut inner = state.lock();
            let Some(index) = inner.members.iter().position(|m| m.label == label) else {
                return;
            };
            let group = inner.members.remove(index).group;
            if inner.active.get(&group).map(String::as_str) != Some(label) {
                publish(app, &mut inner);
                return;
            }
            // The shown tab closed: its right-hand neighbour (else the left one)
            // takes its place on the same frame.
            let Some(next) = neighbour(&inner.members, index, &group) else {
                inner.active.remove(&group);
                inner.frames.remove(&group);
                if inner.last_group.as_ref() == Some(&group) {
                    inner.last_group = None;
                }
                let _ = app.emit(CHANGED_EVENT, inner.snapshot());
                return;
            };
            let frame = inner.frames.get(&group).copied();
            inner.active.insert(group, next.clone());
            publish(app, &mut inner);
            drop(inner);
            if let Some(w) = app.get_webview_window(&next) {
                reveal_window(&w, frame.as_ref());
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub fn project_tabs_register<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, ProjectTabs>,
    group: Option<String>,
    workspace: Option<String>,
) -> Snapshot {
    let label = window.label().to_string();
    let mut inner = state.lock();
    if let Some(m) = inner.members.iter_mut().find(|m| m.label == label) {
        // A reload of a window that is already a tab keeps its place.
        m.workspace = workspace;
    } else {
        // Join the requested group only while it still exists; otherwise start
        // a fresh one (ids are never reused, labels are).
        let group = group
            .filter(|g| inner.members.iter().any(|m| &m.group == g))
            .unwrap_or_else(|| inner.new_group());
        inner.members.push(Member { label: label.clone(), group, workspace, attention: false });
    }
    let group = inner.group_of(&label).unwrap_or_default();
    let mut show = false;
    if !inner.active.contains_key(&group) {
        inner.active.insert(group.clone(), label.clone());
        inner.last_group.get_or_insert(group.clone());
        show = !window.is_visible().unwrap_or(true);
    }
    if inner.active.get(&group) == Some(&label) {
        if let Some(frame) = read_frame(&window) {
            inner.frames.entry(group).or_insert(frame);
        }
    }
    publish(&app, &mut inner);
    let snapshot = inner.snapshot();
    drop(inner);
    if show {
        reveal_window(&window, None);
    }
    snapshot
}

#[tauri::command]
pub fn project_tabs_update<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, ProjectTabs>,
    workspace: Option<String>,
    attention: bool,
) {
    let mut inner = state.lock();
    let Some(m) = inner.members.iter_mut().find(|m| m.label == window.label()) else {
        return;
    };
    if m.workspace == workspace && m.attention == attention {
        return;
    }
    m.workspace = workspace;
    m.attention = attention;
    publish(&app, &mut inner);
}

#[tauri::command]
pub fn project_tabs_activate<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    activate(&app, &label)
}

/// Split a tab out into a standalone window (a group of its own). With `x`/`y`
/// (logical screen coordinates of the cursor that dragged it out of the rail)
/// the window lands under the cursor; otherwise just offset from the group.
#[tauri::command]
pub fn project_tabs_detach<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    detach(&app, &label, x.zip(y))
}

fn detach<R: Runtime>(app: &AppHandle<R>, label: &str, at: Option<(f64, f64)>) -> Result<(), String> {
    let state = app.state::<ProjectTabs>();
    let label = label.to_string();
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    let (was_active, next, frame) = {
        let mut inner = state.lock();
        let Some(index) = inner.members.iter().position(|m| m.label == label) else {
            return Ok(());
        };
        let old_group = inner.members[index].group.clone();
        if inner.members.iter().filter(|m| m.group == old_group).count() < 2 {
            return Ok(());
        }
        let new_group = inner.new_group();
        inner.members[index].group = new_group.clone();
        let was_active = inner.active.get(&old_group) == Some(&label);
        let next = neighbour(&inner.members, index + 1, &old_group);
        let frame = inner.frames.get(&old_group).copied();
        if was_active {
            if let Some(n) = &next {
                inner.active.insert(old_group.clone(), n.clone());
            }
        }
        inner.active.insert(new_group.clone(), label.clone());
        inner.last_group = Some(new_group);
        (was_active, next, frame)
    };

    // The group keeps its place; the split-off window steps aside.
    if was_active {
        if let Some(w) = next.and_then(|n| app.get_webview_window(&n)) {
            reveal_window(&w, frame.as_ref());
        }
    }
    let position = |f: &Frame| match at {
        Some((x, y)) => {
            let scale = window.scale_factor().unwrap_or(1.0);
            PhysicalPosition::new(
                ((x - DRAG_GRIP.0) * scale).round() as i32,
                ((y - DRAG_GRIP.1) * scale).round() as i32,
            )
        }
        _ => PhysicalPosition::new(f.position.x + DETACH_OFFSET, f.position.y + DETACH_OFFSET),
    };
    let offset = frame.map(|f| Frame {
        position: position(&f),
        maximized: false,
        fullscreen: false,
        ..f
    });
    reveal_window(&window, offset.as_ref());

    let mut inner = state.lock();
    if let Some(f) = read_frame(&window) {
        let group = inner.group_of(&label).unwrap_or_default();
        inner.frames.insert(group, f);
    }
    publish(app, &mut inner);
    Ok(())
}

/// Move `label` into `target` group, last in its rail, and show it there in
/// place of that group's current window. The group it leaves keeps its frame
/// (a neighbour steps in) or ends when it was the only member.
fn merge<R: Runtime>(app: &AppHandle<R>, label: &str, target: &str) -> Result<(), String> {
    let state = app.state::<ProjectTabs>();
    let (next, frame) = {
        let mut inner = state.lock();
        let Some(index) = inner.members.iter().position(|m| m.label == label) else {
            return Ok(());
        };
        let old_group = inner.members[index].group.clone();
        if old_group == target || !inner.active.contains_key(target) {
            return Ok(());
        }
        let mut member = inner.members.remove(index);
        let was_active = inner.active.get(&old_group).map(String::as_str) == Some(label);
        let next = neighbour(&inner.members, index, &old_group);
        let frame = inner.frames.get(&old_group).copied();
        if was_active {
            match &next {
                Some(n) => {
                    inner.active.insert(old_group.clone(), n.clone());
                }
                None => {
                    inner.active.remove(&old_group);
                    inner.frames.remove(&old_group);
                }
            }
        }
        member.group = target.to_string();
        inner.members.push(member);
        (next.filter(|_| was_active), frame)
    };
    if let Some(w) = next.and_then(|n| app.get_webview_window(&n)) {
        reveal_window(&w, frame.as_ref());
    }
    activate(app, label)
}

/// Whether logical screen point (x, y) falls on `window`.
fn window_contains<R: Runtime>(window: &WebviewWindow<R>, x: f64, y: f64) -> bool {
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return false;
    }
    let (Ok(pos), Ok(size), Ok(scale)) =
        (window.outer_position(), window.outer_size(), window.scale_factor())
    else {
        return false;
    };
    let (left, top) = (pos.x as f64 / scale, pos.y as f64 / scale);
    let (width, height) = (size.width as f64 / scale, size.height as f64 / scale);
    x >= left && x < left + width && y >= top && y < top + height
}

/// The group (and its shown window) a rail drag of `label` released at logical
/// screen point (x, y) would join: another group's window under the point.
/// None means a new window: the desktop, or still over the drag's own window.
fn drop_target<R: Runtime>(app: &AppHandle<R>, label: &str, x: f64, y: f64) -> Option<(String, String)> {
    let state = app.state::<ProjectTabs>();
    let (own, others) = {
        let inner = state.lock();
        let own_group = inner.group_of(label).unwrap_or_default();
        let own = inner.active.get(&own_group).cloned();
        let others: Vec<(String, String)> = inner
            .active
            .iter()
            .filter(|(g, _)| **g != own_group)
            .map(|(g, l)| (g.clone(), l.clone()))
            .collect();
        (own, others)
    };
    // The window the drag started in sits on top where the cursor is over it.
    let over_own = own
        .and_then(|l| app.get_webview_window(&l))
        .is_some_and(|w| window_contains(&w, x, y));
    if over_own {
        return None;
    }
    others
        .into_iter()
        .find(|(_, l)| app.get_webview_window(l).is_some_and(|w| window_contains(&w, x, y)))
}

fn set_drop_target<R: Runtime>(app: &AppHandle<R>, target: Option<String>) {
    let state = app.state::<ProjectTabs>();
    let mut inner = state.lock();
    if inner.drop_target != target {
        inner.drop_target = target.clone();
        let _ = app.emit(DROP_TARGET_EVENT, target);
    }
}

/// A rail drag in progress outside the rail: report (and highlight) the
/// window it would merge into. No point means the drag ended.
#[tauri::command]
pub fn project_tabs_hover<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Option<String> {
    let target = x.zip(y).and_then(|(x, y)| drop_target(&app, &label, x, y)).map(|(_, l)| l);
    set_drop_target(&app, target.clone());
    target
}

/// A rail drag released outside the rail at logical screen point (x, y):
/// over another group's window it joins that group, anywhere else (the
/// desktop, or still over its own window) it becomes a window of its own.
#[tauri::command]
pub fn project_tabs_drop<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    set_drop_target(&app, None);
    match drop_target(&app, &label, x, y) {
        Some((group, _)) => merge(&app, &label, &group),
        None => detach(&app, &label, Some((x, y))),
    }
}

/// Gather every project window into `label`'s group, appended in rail order,
/// leaving that group's shown window in front and the rest as hidden tabs.
pub fn merge_all<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let state = app.state::<ProjectTabs>();
    let (moved, shown) = {
        let mut inner = state.lock();
        let Some(target) = inner.group_of(label) else { return Ok(()) };
        let (keep, mut moved): (Vec<Member>, Vec<Member>) =
            std::mem::take(&mut inner.members).into_iter().partition(|m| m.group == target);
        if moved.is_empty() {
            inner.members = keep;
            return Ok(());
        }
        for m in &mut moved {
            m.group = target.clone();
        }
        let labels: Vec<String> = moved.iter().map(|m| m.label.clone()).collect();
        inner.members = keep.into_iter().chain(moved).collect();
        inner.active.retain(|g, _| *g == target);
        inner.frames.retain(|g, _| *g == target);
        inner.last_group = Some(target.clone());
        publish(app, &mut inner);
        (labels, inner.active.get(&target).cloned())
    };
    for l in moved {
        if let Some(w) = app.get_webview_window(&l) {
            if w.is_fullscreen().unwrap_or(false) {
                let _ = w.set_fullscreen(false);
            }
            let _ = w.hide();
        }
    }
    if let Some(w) = shown.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn project_tabs_merge_all<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> Result<(), String> {
    merge_all(&app, window.label())
}

/// Move a tab within the rail: before `before`, or to the end when `None`.
#[tauri::command]
pub fn project_tabs_move<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ProjectTabs>,
    label: String,
    before: Option<String>,
) {
    let mut inner = state.lock();
    if before.as_deref() == Some(label.as_str()) {
        return;
    }
    let Some(from) = inner.members.iter().position(|m| m.label == label) else { return };
    let member = inner.members.remove(from);
    let to = before
        .and_then(|b| inner.members.iter().position(|m| m.label == b))
        .unwrap_or(inner.members.len());
    inner.members.insert(to, member);
    publish(&app, &mut inner);
}

/// Comparison key for a workspace path: symlinks resolved and a trailing
/// separator dropped, and case-folded where the file system usually ignores
/// case (macOS, Windows), so two spellings of one folder match.
fn workspace_key(path: &str) -> String {
    let resolved = fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    let trimmed = resolved.trim_end_matches(['/', '\\']);
    let key = if trimmed.is_empty() { resolved.as_str() } else { trimmed };
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        key.to_lowercase()
    } else {
        key.to_string()
    }
}

/// The window (tab) that already has `workspace` open, if any.
#[tauri::command]
pub fn project_tabs_find(state: State<'_, ProjectTabs>, workspace: String) -> Option<String> {
    let key = workspace_key(&workspace);
    let inner = state.lock();
    inner
        .members
        .iter()
        .find(|m| m.workspace.as_deref().is_some_and(|w| workspace_key(w) == key))
        .map(|m| m.label.clone())
}

#[tauri::command]
pub fn project_tabs_snapshot(state: State<'_, ProjectTabs>) -> Snapshot {
    state.lock().snapshot()
}

fn parse_session_file(text: &str) -> Vec<Session> {
    let Ok(file) = serde_json::from_str::<SessionFile>(text) else { return Vec::new() };
    if !file.groups.is_empty() {
        return file.groups;
    }
    if file.workspaces.is_empty() {
        return Vec::new();
    }
    vec![Session { workspaces: file.workspaces, active: file.active }]
}

/// The project groups open at the previous run, first group first.
#[tauri::command]
pub fn project_tabs_session<R: Runtime>(app: AppHandle<R>) -> Vec<Session> {
    let Ok(dir) = app.path().app_config_dir() else { return Vec::new() };
    fs::read_to_string(dir.join(SESSION_FILE))
        .map(|text| parse_session_file(&text))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(label: &str, group: &str) -> Member {
        Member { label: label.into(), group: group.into(), workspace: None, attention: false }
    }

    #[test]
    fn neighbour_prefers_the_next_tab_then_the_previous_one() {
        let members = vec![member("main", "g1"), member("main-2", "g2"), member("main-3", "g1")];
        assert_eq!(neighbour(&members, 1, "g1").as_deref(), Some("main-3"));
        assert_eq!(neighbour(&members, 3, "g1").as_deref(), Some("main-3"));
        assert_eq!(neighbour(&members, 0, "g2").as_deref(), Some("main-2"));
        assert_eq!(neighbour(&members, 0, "g3"), None);
    }

    #[test]
    fn sessions_list_every_group_in_rail_order() {
        let mut inner = Inner::default();
        inner.members = vec![
            member("main", "g1"),
            member("main-2", "g2"),
            member("main-3", "g1"),
            member("main-4", "g3"),
        ];
        inner.members[0].workspace = Some("/a".into());
        inner.members[1].workspace = Some("/b".into());
        inner.members[2].workspace = Some("/c".into());
        inner.active.insert("g1".into(), "main-3".into());
        inner.active.insert("g2".into(), "main-2".into());
        // g3 holds only a blank window: nothing to restore.
        assert_eq!(
            inner.sessions(),
            vec![
                Session { workspaces: vec!["/a".into(), "/c".into()], active: Some("/c".into()) },
                Session { workspaces: vec!["/b".into()], active: Some("/b".into()) },
            ]
        );
    }

    #[test]
    fn workspace_key_ignores_trailing_separators_and_symlinks() {
        let dir = std::env::temp_dir().join(format!("idea-note-tabs-{}", std::process::id()));
        let real = dir.join("Notes");
        fs::create_dir_all(&real).unwrap();
        let real_str = real.to_string_lossy().into_owned();
        assert_eq!(workspace_key(&real_str), workspace_key(&format!("{real_str}/")));
        #[cfg(unix)]
        {
            let link = dir.join("link");
            let _ = fs::remove_file(&link);
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(workspace_key(&real_str), workspace_key(&link.to_string_lossy()));
        }
        #[cfg(target_os = "macos")]
        assert_eq!(workspace_key(&real_str), workspace_key(&dir.join("notes").to_string_lossy()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_file_reads_both_formats() {
        let old = r#"{"workspaces":["/a","/b"],"active":"/b"}"#;
        assert_eq!(
            parse_session_file(old),
            vec![Session { workspaces: vec!["/a".into(), "/b".into()], active: Some("/b".into()) }]
        );
        let new = r#"{"groups":[{"workspaces":["/a"],"active":null},{"workspaces":["/b"],"active":"/b"}]}"#;
        assert_eq!(parse_session_file(new).len(), 2);
        assert!(parse_session_file("{}").is_empty());
        assert!(parse_session_file("not json").is_empty());
    }
}
