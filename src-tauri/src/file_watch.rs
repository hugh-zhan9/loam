use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::document::document_fingerprint;
use crate::models::{FileWatchEventPayload, WatchStartResult, WatchStopResult, WorkspaceError};

#[path = "file_watch_delivery.rs"]
mod delivery;

const WATCH_COALESCE_DELAY: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileWatchKind {
    Created,
    Changed,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingWatchEvent {
    pub kind: FileWatchKind,
    pub path: PathBuf,
    pub new_path: Option<PathBuf>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchTarget {
    pub path: PathBuf,
    pub recursive: bool,
}

#[derive(Default)]
pub struct FileWatchState {
    next_id: u64,
    watches: HashMap<String, FileWatchRegistration>,
}

struct FileWatchRegistration {
    _watcher: Option<RecommendedWatcher>,
    stop_sender: Sender<()>,
    window_label: String,
}

#[derive(Clone)]
pub(crate) enum WatchScope {
    Workspace { root_path: PathBuf },
    Document { document_path: PathBuf },
}

#[derive(Clone)]
struct WatchRuntime {
    watch_id: String,
    window_label: String,
    app: AppHandle,
    scope: WatchScope,
}

#[tauri::command]
pub fn watch_start_workspace(
    root_path: String,
    window_label: String,
    app: AppHandle,
    state: State<'_, Mutex<FileWatchState>>,
) -> Result<WatchStartResult, WorkspaceError> {
    let root_path = canonicalize_watch_root(Path::new(&root_path))?;
    start_watch(
        state,
        app,
        window_label,
        WatchScope::Workspace {
            root_path: root_path.clone(),
        },
        vec![WatchTarget {
            path: root_path,
            recursive: true,
        }],
    )
}

#[tauri::command]
pub fn watch_start_document(
    real_path: String,
    window_label: String,
    app: AppHandle,
    state: State<'_, Mutex<FileWatchState>>,
) -> Result<WatchStartResult, WorkspaceError> {
    let document_path = canonicalize_document_watch_path(Path::new(&real_path))?;
    let parent = document_path.parent().ok_or_else(|| {
        WorkspaceError::new("watch_failed", "document path has no parent directory")
    })?;
    start_watch(
        state,
        app,
        window_label,
        WatchScope::Document {
            document_path: document_path.clone(),
        },
        document_watch_targets(parent),
    )
}

#[tauri::command]
pub fn watch_stop(
    watch_id: String,
    state: State<'_, Mutex<FileWatchState>>,
) -> Result<WatchStopResult, WorkspaceError> {
    let mut state = state
        .lock()
        .map_err(|_| WorkspaceError::new("watch_failed", "file watch state lock poisoned"))?;
    stop_watch_by_id(&mut state, &watch_id)?;

    Ok(WatchStopResult { stopped: true })
}

pub(crate) fn stop_watch_by_id(
    state: &mut FileWatchState,
    watch_id: &str,
) -> Result<(), WorkspaceError> {
    let Some(registration) = state.watches.remove(watch_id) else {
        return Err(WorkspaceError::new(
            "watch_not_found",
            "file watch id was not found",
        ));
    };

    stop_registration(registration);
    Ok(())
}

pub(crate) fn stop_watches_for_window_label(state: &mut FileWatchState, label: &str) -> usize {
    let watch_ids: Vec<String> = state
        .watches
        .iter()
        .filter(|(_, registration)| registration.window_label == label)
        .map(|(watch_id, _)| watch_id.clone())
        .collect();
    let stopped = watch_ids.len();

    for watch_id in watch_ids {
        if let Some(registration) = state.watches.remove(&watch_id) {
            stop_registration(registration);
        }
    }

    stopped
}

fn stop_registration(registration: FileWatchRegistration) {
    let _ = registration.stop_sender.send(());
}

#[cfg(test)]
pub(crate) fn insert_test_watch_registration(
    state: &mut FileWatchState,
    watch_id: &str,
    window_label: &str,
) -> mpsc::Receiver<()> {
    let (stop_sender, stop_receiver) = mpsc::channel();
    state.watches.insert(
        watch_id.to_string(),
        FileWatchRegistration {
            _watcher: None,
            stop_sender,
            window_label: window_label.to_string(),
        },
    );
    stop_receiver
}

#[cfg(test)]
pub(crate) fn test_watch_state_contains(state: &FileWatchState, watch_id: &str) -> bool {
    state.watches.contains_key(watch_id)
}

pub fn coalesce_watch_events(events: Vec<PendingWatchEvent>) -> Vec<PendingWatchEvent> {
    let mut coalesced: Vec<PendingWatchEvent> = Vec::new();

    for event in events {
        let existing_index = coalesced
            .iter()
            .position(|pending| pending.path == event.path);

        let Some(index) = existing_index else {
            coalesced.push(event);
            continue;
        };

        let previous = coalesced[index].clone();
        match (previous.kind, event.kind) {
            (FileWatchKind::Changed, FileWatchKind::Changed) => {}
            (FileWatchKind::Created, FileWatchKind::Changed) => {}
            (FileWatchKind::Created, FileWatchKind::Deleted) => {
                coalesced.remove(index);
            }
            (FileWatchKind::Deleted, FileWatchKind::Created) => {
                coalesced[index] = PendingWatchEvent {
                    kind: FileWatchKind::Changed,
                    path: event.path,
                    new_path: None,
                    is_dir: previous.is_dir || event.is_dir,
                };
            }
            (FileWatchKind::Changed, FileWatchKind::Deleted)
            | (FileWatchKind::Renamed, FileWatchKind::Deleted) => {
                coalesced[index] = PendingWatchEvent {
                    kind: FileWatchKind::Deleted,
                    path: event.path,
                    new_path: None,
                    is_dir: previous.is_dir || event.is_dir,
                };
            }
            _ => {
                coalesced[index] = event;
            }
        }
    }

    coalesced
}

pub fn is_markdown_or_assets_relevant(document_path: &Path, candidate_path: &Path) -> bool {
    if candidate_path == document_path {
        return true;
    }

    let Some(parent) = document_path.parent() else {
        return false;
    };
    let assets_dir = parent.join(".assets");

    candidate_path == assets_dir || candidate_path.starts_with(&assets_dir)
}

pub fn document_watch_targets(parent: &Path) -> Vec<WatchTarget> {
    let mut targets = vec![WatchTarget {
        path: parent.to_path_buf(),
        recursive: false,
    }];
    let assets_dir = parent.join(".assets");

    if assets_dir.is_dir() {
        targets.push(WatchTarget {
            path: assets_dir,
            recursive: true,
        });
    }

    targets
}

fn start_watch(
    state: State<'_, Mutex<FileWatchState>>,
    app: AppHandle,
    window_label: String,
    scope: WatchScope,
    watch_targets: Vec<WatchTarget>,
) -> Result<WatchStartResult, WorkspaceError> {
    let watch_id = {
        let mut state = state
            .lock()
            .map_err(|_| WorkspaceError::new("watch_failed", "file watch state lock poisoned"))?;
        state.next_id += 1;
        format!("watch-{}", state.next_id)
    };
    let runtime = WatchRuntime {
        watch_id: watch_id.clone(),
        window_label: window_label.clone(),
        app,
        scope,
    };
    let (event_sender, event_receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = event_sender.send(event);
    })
    .map_err(|error| WorkspaceError::new("watch_failed", error.to_string()))?;
    for target in watch_targets {
        let recursive_mode = if target.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        watcher
            .watch(&target.path, recursive_mode)
            .map_err(|error| WorkspaceError::new("watch_failed", error.to_string()))?;
    }

    let (stop_sender, stop_receiver) = mpsc::channel();
    spawn_delivery_loop(runtime, event_receiver, stop_receiver);

    state
        .lock()
        .map_err(|_| WorkspaceError::new("watch_failed", "file watch state lock poisoned"))?
        .watches
        .insert(
            watch_id.clone(),
            FileWatchRegistration {
                _watcher: Some(watcher),
                stop_sender,
                window_label,
            },
        );

    Ok(WatchStartResult { watch_id })
}

fn spawn_delivery_loop(
    runtime: WatchRuntime,
    event_receiver: mpsc::Receiver<notify::Result<Event>>,
    stop_receiver: mpsc::Receiver<()>,
) {
    thread::spawn(move || {
        let mut pending_events = Vec::new();

        delivery::run(
            event_receiver,
            stop_receiver,
            WATCH_COALESCE_DELAY,
            |action| match action {
                delivery::Delivery::Event(Ok(event)) => {
                    pending_events.extend(pending_events_from_notify_event(&runtime.scope, event));
                }
                delivery::Delivery::Event(Err(error)) => {
                    emit_watch_error(&runtime, error.to_string());
                }
                delivery::Delivery::Flush => {
                    flush_pending_events(&runtime, &mut pending_events);
                }
            },
        );
    });
}

pub(crate) fn pending_events_from_notify_event(
    scope: &WatchScope,
    event: Event,
) -> Vec<PendingWatchEvent> {
    let is_dir_from_kind = event_kind_is_directory(&event.kind);
    let kind = match event.kind {
        EventKind::Create(_) => FileWatchKind::Created,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => FileWatchKind::Deleted,
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => FileWatchKind::Created,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            FileWatchKind::Renamed
        }
        EventKind::Modify(ModifyKind::Name(_)) => FileWatchKind::Changed,
        EventKind::Modify(_) => FileWatchKind::Changed,
        EventKind::Remove(_) => FileWatchKind::Deleted,
        _ => return Vec::new(),
    };
    let is_dir = is_dir_from_kind || event_paths_include_directory(&event.paths);

    if kind == FileWatchKind::Renamed && event.paths.len() >= 2 {
        let pending = PendingWatchEvent {
            kind,
            path: event.paths[0].clone(),
            new_path: Some(event.paths[1].clone()),
            is_dir,
        };
        return relevant_pending_events(scope, vec![pending]);
    }

    relevant_pending_events(
        scope,
        event
            .paths
            .into_iter()
            .map(|path| PendingWatchEvent {
                kind,
                path,
                new_path: None,
                is_dir,
            })
            .collect(),
    )
}

fn relevant_pending_events(
    scope: &WatchScope,
    events: Vec<PendingWatchEvent>,
) -> Vec<PendingWatchEvent> {
    events
        .into_iter()
        .filter(|event| match scope {
            WatchScope::Workspace { .. } => is_workspace_relevant_event(event),
            WatchScope::Document { document_path } => {
                is_markdown_or_assets_relevant(document_path, &event.path)
                    || event
                        .new_path
                        .as_ref()
                        .map(|path| is_markdown_or_assets_relevant(document_path, path))
                        .unwrap_or(false)
            }
        })
        .collect()
}

pub(crate) fn is_workspace_relevant_event(event: &PendingWatchEvent) -> bool {
    event.is_dir
        || is_workspace_relevant_path(&event.path)
        || event
            .new_path
            .as_ref()
            .map(|path| is_workspace_relevant_path(path))
            .unwrap_or(false)
}

fn is_workspace_relevant_path(path: &Path) -> bool {
    is_markdown_path(path)
}

fn event_kind_is_directory(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
    )
}

fn event_paths_include_directory(paths: &[PathBuf]) -> bool {
    paths.iter().any(|path| {
        path.metadata()
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
    })
}

fn flush_pending_events(runtime: &WatchRuntime, pending_events: &mut Vec<PendingWatchEvent>) {
    if pending_events.is_empty() {
        return;
    }

    let events = coalesce_watch_events(std::mem::take(pending_events));
    for event in events {
        emit_pending_event(runtime, event);
    }
}

fn emit_pending_event(runtime: &WatchRuntime, event: PendingWatchEvent) {
    let event_name = match event.kind {
        FileWatchKind::Created => "mdx-file-created",
        FileWatchKind::Changed => "mdx-file-changed",
        FileWatchKind::Deleted => "mdx-file-deleted",
        FileWatchKind::Renamed => "mdx-file-renamed",
    };
    let payload = FileWatchEventPayload {
        watch_id: runtime.watch_id.clone(),
        root_path: match &runtime.scope {
            WatchScope::Workspace { root_path } => Some(path_to_string(root_path)),
            WatchScope::Document { .. } => None,
        },
        path: path_to_string(&event.path),
        new_path: event.new_path.as_ref().map(|path| path_to_string(path)),
        fingerprint: fingerprint_for_event(&event),
        event_time: timestamp_millis().to_string(),
    };
    let app = runtime.app.clone();
    let window_label = runtime.window_label.clone();

    tauri::async_runtime::spawn(async move {
        let _ = app.emit_to(&window_label, event_name, payload);
    });
}

fn emit_watch_error(runtime: &WatchRuntime, message: String) {
    let app = runtime.app.clone();
    let window_label = runtime.window_label.clone();
    let payload = serde_json::json!({
        "watchId": runtime.watch_id,
        "message": message,
        "eventTime": timestamp_millis().to_string(),
    });

    tauri::async_runtime::spawn(async move {
        let _ = app.emit_to(&window_label, "mdx-watch-error", payload);
    });
}

fn fingerprint_for_event(event: &PendingWatchEvent) -> Option<String> {
    let path = event.new_path.as_ref().unwrap_or(&event.path);

    if event.kind == FileWatchKind::Deleted || !is_markdown_path(path) {
        return None;
    }

    let content = std::fs::read_to_string(path).ok()?;
    Some(document_fingerprint(&content))
}

fn canonicalize_watch_root(path: &Path) -> Result<PathBuf, WorkspaceError> {
    let root = path.canonicalize().map_err(|error| {
        WorkspaceError::from_io(
            "path_failed",
            "failed to resolve workspace watch path",
            &error,
        )
    })?;

    if !root.is_dir() {
        return Err(WorkspaceError::new(
            "not_directory",
            "workspace watch path must be a directory",
        ));
    }

    Ok(root)
}

fn canonicalize_document_watch_path(path: &Path) -> Result<PathBuf, WorkspaceError> {
    let real_path = path.canonicalize().map_err(|error| {
        WorkspaceError::from_io(
            "path_failed",
            "failed to resolve document watch path",
            &error,
        )
    })?;

    if !real_path.is_file() {
        return Err(WorkspaceError::new(
            "not_file",
            "document watch path must be a file",
        ));
    }

    if !is_markdown_path(&real_path) {
        return Err(WorkspaceError::new(
            "unsupported_file",
            "document watch path must be Markdown",
        ));
    }

    Ok(real_path)
}

fn is_markdown_path(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };
    extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
