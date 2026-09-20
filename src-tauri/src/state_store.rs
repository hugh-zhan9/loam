use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::models::WorkspaceError;

const STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    #[serde(default = "default_state_version")]
    pub state_version: u32,
    #[serde(default)]
    pub recent_workspace_root: Option<String>,
    #[serde(default)]
    pub preferences: AppPreferences,
    #[serde(default)]
    pub workspaces: Vec<PersistedWorkspaceState>,
    /// The fallback size: used by a window with no root bound yet, and as the
    /// seed for a root that has never been sized on its own.
    #[serde(default)]
    pub window_size: PersistedWindowSize,
    /// The roots that were open when the app last ran, in window order.
    ///
    /// Derived from the window registry, never submitted by a frontend: only
    /// the registry knows about every window.
    #[serde(default)]
    pub open_workspace_roots: Vec<String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            state_version: STATE_VERSION,
            recent_workspace_root: None,
            preferences: AppPreferences::default(),
            workspaces: Vec::new(),
            window_size: PersistedWindowSize::default(),
            open_workspace_roots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    #[serde(default)]
    pub file_tree_exclude_dirs: Vec<String>,
    #[serde(default = "default_file_watch_enabled")]
    pub file_watch_enabled: bool,
    #[serde(default = "default_search_max_file_bytes")]
    pub search_max_file_bytes: u64,
    #[serde(default = "default_search_max_results")]
    pub search_max_results: usize,
    #[serde(default = "default_search_max_matches_per_file")]
    pub search_max_matches_per_file: usize,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            file_tree_exclude_dirs: Vec::new(),
            file_watch_enabled: default_file_watch_enabled(),
            search_max_file_bytes: default_search_max_file_bytes(),
            search_max_results: default_search_max_results(),
            search_max_matches_per_file: default_search_max_matches_per_file(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceState {
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub tabs: Vec<PersistedWorkspaceTab>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub panels: PersistedPanelState,
    /// The folder the file tree was left showing, or none for the whole tree.
    ///
    /// Absent in anything saved before the tree could be pointed at a folder,
    /// and absent again once it is pointed back at the whole workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_focus_path: Option<String>,
    /// This workspace's own window size.
    ///
    /// Absent until this root's window is resized; the top-level `window_size`
    /// is used until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_size: Option<PersistedWindowSize>,
}

impl Default for PersistedWorkspaceState {
    fn default() -> Self {
        Self {
            root_path: String::new(),
            tabs: Vec::new(),
            active_tab_id: None,
            panels: PersistedPanelState::default(),
            tree_focus_path: None,
            window_size: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspaceTab {
    pub tab_id: String,
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub dirty: bool,
    #[serde(default)]
    pub needs_rename_on_first_save: bool,
}

/// The window's columns, as the frontend saves them.
///
/// Every field defaults, and the two the navigator used to be described by are
/// carried rather than named: this struct is a courier, and a courier that
/// refuses a parcel because one label changed loses the whole delivery. It did —
/// after the frontend renamed its panel fields, `save_app_state` failed to
/// deserialize and nothing was persisted at all, tabs included.
///
/// The widths are not clamped here. `features/workspace/lib/panel-layout.ts`
/// owns what each column may be, and a second opinion in another language is a
/// second set of numbers to keep in step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPanelState {
    /// Absent means "nobody has said" — never "use this number".
    ///
    /// Every width here is optional for the same reason none of them is
    /// clamped: a default filled in on this side is a default the window has to
    /// agree with, and it silently disabled the frontend's own migration —
    /// which reads a missing width as its cue to work one out from what the old
    /// single-column state held.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigator_collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_width: Option<u32>,
    /// What a state saved before the navigator was two columns called them.
    ///
    /// Kept only until the frontend saves again: it reads them, works out the
    /// list's width from the total, and stops sending them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_width: Option<u32>,
}

impl Default for PersistedPanelState {
    fn default() -> Self {
        Self {
            navigator_collapsed: None,
            list_width: None,
            rail_width: None,
            right_collapsed: None,
            right_width: None,
            left_collapsed: None,
            left_width: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWindowSize {
    pub width: f64,
    pub height: f64,
}

impl Default for PersistedWindowSize {
    fn default() -> Self {
        Self {
            width: 1480.0,
            height: 860.0,
        }
    }
}

#[tauri::command]
pub fn load_app_state() -> Result<AppState, WorkspaceError> {
    load_state_from_path(default_state_path()?)
}

/// Serializes every read-modify-write of the state file.
///
/// All windows live in one process, so this is the whole mutual exclusion the
/// segmented writes need. It replaced whole-file overwrites from each window,
/// which silently dropped whatever another window had saved since that window
/// started.
static STATE_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Read the state file, apply `mutate`, write it back, while holding the lock.
///
/// Neither `mutate` nor anything this calls may take `STATE_WRITE_LOCK` again:
/// it is not re-entrant.
fn mutate_state_at_path<F>(path: impl AsRef<Path>, mutate: F) -> Result<(), WorkspaceError>
where
    F: FnOnce(&mut AppState),
{
    let path = path.as_ref();
    let _guard = STATE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut state = load_state_from_path(path)?;
    mutate(&mut state);
    normalize_app_state(&mut state);
    write_state_file(path, &state)
}

/// Merge one workspace's own state, leaving every other segment alone.
#[tauri::command]
pub fn save_workspace_state(workspace: PersistedWorkspaceState) -> Result<(), WorkspaceError> {
    save_workspace_state_to_path(default_state_path()?, workspace)
}

pub fn save_workspace_state_to_path(
    path: impl AsRef<Path>,
    workspace: PersistedWorkspaceState,
) -> Result<(), WorkspaceError> {
    mutate_state_at_path(path, |state| upsert_workspace(state, workspace))
}

/// Record a window size against its root, or at the top level when a window
/// has no root bound yet.
#[tauri::command]
pub fn save_window_size(
    root_path: Option<String>,
    window_size: PersistedWindowSize,
) -> Result<(), WorkspaceError> {
    save_window_size_to_path(default_state_path()?, root_path, window_size)
}

pub fn save_window_size_to_path(
    path: impl AsRef<Path>,
    root_path: Option<String>,
    window_size: PersistedWindowSize,
) -> Result<(), WorkspaceError> {
    mutate_state_at_path(path, |state| match root_path {
        Some(root_path) if !root_path.is_empty() => {
            match state
                .workspaces
                .iter_mut()
                .find(|workspace| workspace.root_path == root_path)
            {
                Some(workspace) => workspace.window_size = Some(window_size),
                None => state.workspaces.insert(
                    0,
                    PersistedWorkspaceState {
                        root_path,
                        window_size: Some(window_size),
                        ..PersistedWorkspaceState::default()
                    },
                ),
            }
        }
        _ => state.window_size = window_size,
    })
}

#[tauri::command]
pub fn save_app_preferences(preferences: AppPreferences) -> Result<(), WorkspaceError> {
    save_app_preferences_to_path(default_state_path()?, preferences)
}

pub fn save_app_preferences_to_path(
    path: impl AsRef<Path>,
    preferences: AppPreferences,
) -> Result<(), WorkspaceError> {
    mutate_state_at_path(path, |state| state.preferences = preferences)
}

/// Replace the open-root list. Called by the window registry, not a frontend.
pub fn set_open_workspace_roots(roots: Vec<String>) -> Result<(), WorkspaceError> {
    set_open_workspace_roots_to_path(default_state_path()?, roots)
}

pub fn set_open_workspace_roots_to_path(
    path: impl AsRef<Path>,
    roots: Vec<String>,
) -> Result<(), WorkspaceError> {
    mutate_state_at_path(path, |state| state.open_workspace_roots = roots)
}

/// Drop roots that could not be restored, and their saved tab state with them.
///
/// Deliberately destructive: a root that is gone takes its tabs and panels with
/// it rather than accumulating in state.json forever. An unmounted external or
/// network volume at launch therefore loses that workspace's tabs for good.
pub fn forget_workspace_roots(roots: &[String]) -> Result<(), WorkspaceError> {
    forget_workspace_roots_at_path(default_state_path()?, roots)
}

pub fn forget_workspace_roots_at_path(
    path: impl AsRef<Path>,
    roots: &[String],
) -> Result<(), WorkspaceError> {
    if roots.is_empty() {
        return Ok(());
    }

    mutate_state_at_path(path, |state| {
        state
            .open_workspace_roots
            .retain(|root| !roots.contains(root));
        state
            .workspaces
            .retain(|workspace| !roots.contains(&workspace.root_path));
        if state
            .recent_workspace_root
            .as_ref()
            .is_some_and(|root| roots.contains(root))
        {
            state.recent_workspace_root = None;
        }
    })
}

fn upsert_workspace(state: &mut AppState, workspace: PersistedWorkspaceState) {
    let root_path = workspace.root_path.clone();
    // A save that carries no size must not erase the one already recorded.
    let window_size = workspace.window_size.or_else(|| {
        state
            .workspaces
            .iter()
            .find(|candidate| candidate.root_path == root_path)
            .and_then(|candidate| candidate.window_size.clone())
    });

    state
        .workspaces
        .retain(|candidate| candidate.root_path != root_path);
    state.workspaces.insert(
        0,
        PersistedWorkspaceState {
            window_size,
            ..workspace
        },
    );
    state.recent_workspace_root = Some(root_path);
}

pub fn load_state_from_path(path: impl AsRef<Path>) -> Result<AppState, WorkspaceError> {
    let path = path.as_ref();

    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<AppState>(&bytes) {
            Ok(mut state) => {
                if state.state_version == 0 {
                    state.state_version = STATE_VERSION;
                }
                Ok(state)
            }
            Err(_) => {
                backup_corrupt_state_file(path)?;
                let mut state = AppState::default();
                normalize_app_state(&mut state);
                // write_state_file, not save_state_to_path: a merge calls this
                // function with STATE_WRITE_LOCK already held, and the lock is
                // not re-entrant — taking it again deadlocks that thread and
                // every later save in every window behind it.
                let _ = write_state_file(path, &state);
                Ok(state)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AppState::default()),
        Err(error) => Err(WorkspaceError::from_io(
            "state_load_failed",
            "failed to read app state",
            &error,
        )),
    }
}

/// Write a whole state file.
///
/// Only the tests still do this. The app writes one segment at a time so that
/// two windows cannot overwrite each other.
#[cfg(test)]
pub fn save_state_to_path(path: impl AsRef<Path>, state: &AppState) -> Result<(), WorkspaceError> {
    let path = path.as_ref();
    let _guard = STATE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = state.clone();
    normalize_app_state(&mut state);
    write_state_file(path, &state)
}

/// The atomic write itself. Callers hold `STATE_WRITE_LOCK` and have already
/// normalized; this must never take the lock, or it deadlocks its callers.
fn write_state_file(path: &Path, state: &AppState) -> Result<(), WorkspaceError> {
    let parent = path.parent().ok_or_else(|| {
        WorkspaceError::new("state_save_failed", "state path has no parent directory")
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        WorkspaceError::from_io(
            "state_save_failed",
            "failed to create state directory",
            &error,
        )
    })?;

    let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
        WorkspaceError::new(
            "state_save_failed",
            format!("failed to serialize app state: {error}"),
        )
    })?;
    let temp_path = parent.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state.json"),
        std::process::id(),
        timestamp_nanos()
    ));

    {
        let mut file = fs::File::create(&temp_path).map_err(|error| {
            WorkspaceError::from_io(
                "state_save_failed",
                "failed to create temporary state file",
                &error,
            )
        })?;
        file.write_all(&bytes).map_err(|error| {
            WorkspaceError::from_io(
                "state_save_failed",
                "failed to write temporary state file",
                &error,
            )
        })?;
        file.sync_all().map_err(|error| {
            WorkspaceError::from_io(
                "state_save_failed",
                "failed to sync temporary state file",
                &error,
            )
        })?;
    }

    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        WorkspaceError::from_io("state_save_failed", "failed to replace state file", &error)
    })
}

fn backup_corrupt_state_file(path: &Path) -> Result<(), WorkspaceError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    let backup_path = parent.join(format!("{file_name}.corrupt.{}", timestamp_nanos()));

    fs::rename(path, &backup_path).map_err(|error| {
        WorkspaceError::from_io(
            "state_load_failed",
            "failed to back up corrupt state file",
            &error,
        )
    })
}

fn default_state_path() -> Result<PathBuf, WorkspaceError> {
    Ok(loam_home_dir()?.join("state.json"))
}

fn loam_home_dir() -> Result<PathBuf, WorkspaceError> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| WorkspaceError::new("state_path_failed", "home directory is not set"))?;
    Ok(PathBuf::from(home).join(".loam"))
}

fn timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn default_state_version() -> u32 {
    STATE_VERSION
}

fn default_file_watch_enabled() -> bool {
    true
}

fn default_search_max_file_bytes() -> u64 {
    2_097_152
}

fn default_search_max_results() -> usize {
    200
}

fn normalize_app_state(state: &mut AppState) {
    if state.state_version == 0 {
        state.state_version = STATE_VERSION;
    }
    state.window_size = normalize_window_size(&state.window_size);
    state.preferences = normalize_preferences(&state.preferences);
    state.workspaces = state
        .workspaces
        .iter()
        .filter_map(normalize_workspace_state)
        .collect();
}

fn normalize_preferences(preferences: &AppPreferences) -> AppPreferences {
    let mut seen_exclude_dirs = std::collections::BTreeSet::new();
    AppPreferences {
        file_tree_exclude_dirs: preferences
            .file_tree_exclude_dirs
            .iter()
            .filter_map(|dir| {
                let normalized = dir.replace('\\', "/");
                let trimmed = normalized.trim_matches('/').trim();
                if trimmed.is_empty() || trimmed.split('/').any(|part| part == "." || part == "..")
                {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
            .filter(|dir| seen_exclude_dirs.insert(dir.clone()))
            .collect(),
        file_watch_enabled: preferences.file_watch_enabled,
        search_max_file_bytes: preferences.search_max_file_bytes.clamp(1_024, 52_428_800),
        search_max_results: preferences.search_max_results.clamp(1, 5_000),
        search_max_matches_per_file: preferences.search_max_matches_per_file.clamp(1, 500),
    }
}

fn normalize_workspace_state(
    workspace: &PersistedWorkspaceState,
) -> Option<PersistedWorkspaceState> {
    let root_path = workspace.root_path.trim().to_string();
    if root_path.is_empty() {
        return None;
    }

    Some(PersistedWorkspaceState {
        root_path: root_path.clone(),
        tabs: workspace
            .tabs
            .iter()
            .filter_map(|tab| normalize_workspace_tab(tab, &root_path))
            .collect(),
        active_tab_id: workspace.active_tab_id.clone(),
        panels: normalize_panel_state(&workspace.panels),
        // Carried, not judged: whether that folder still exists is a question
        // for the window that is about to list it.
        tree_focus_path: workspace
            .tree_focus_path
            .as_ref()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty()),
        window_size: workspace.window_size.as_ref().map(normalize_window_size),
    })
}

fn normalize_workspace_tab(
    tab: &PersistedWorkspaceTab,
    root_path: &str,
) -> Option<PersistedWorkspaceTab> {
    let path = tab.path.trim().to_string();
    if tab.tab_id.trim().is_empty() || path.is_empty() || !path.starts_with(root_path) {
        return None;
    }

    Some(PersistedWorkspaceTab {
        tab_id: tab.tab_id.trim().to_string(),
        path,
        title: if tab.title.trim().is_empty() {
            "Untitled".to_string()
        } else {
            tab.title.trim().to_string()
        },
        dirty: tab.dirty,
        needs_rename_on_first_save: tab.needs_rename_on_first_save,
    })
}

fn normalize_panel_state(panel: &PersistedPanelState) -> PersistedPanelState {
    panel.clone()
}

fn normalize_window_size(window_size: &PersistedWindowSize) -> PersistedWindowSize {
    PersistedWindowSize {
        width: normalize_window_dimension(window_size.width, 1480.0, 1100.0),
        height: normalize_window_dimension(window_size.height, 860.0, 640.0),
    }
}

fn normalize_window_dimension(value: f64, fallback: f64, min: f64) -> f64 {
    if !value.is_finite() {
        return fallback;
    }

    value.round().max(min)
}

fn default_search_max_matches_per_file() -> usize {
    20
}
