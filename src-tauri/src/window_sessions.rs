use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use tauri::Url;

/// Every window label this app builds by counter, so one place says what the
/// capability file has to cover.
pub const WORKSPACE_WINDOW_LABEL_PREFIX: &str = "workspace-";
pub const DOCUMENT_WINDOW_LABEL_PREFIX: &str = "document-";
pub const DOCUMENT_ERROR_WINDOW_LABEL_PREFIX: &str = "document-error-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowRole {
    Workspace,
    Document,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowSession {
    Workspace {
        /// The root this window was opened for, before its frontend has asked.
        ///
        /// None when nothing assigned one: a cold launch with nothing to
        /// restore leaves the window to run the folder picker itself.
        root_path: Option<String>,
    },
    Document {
        file_name: String,
        display_path: String,
        real_path: String,
    },
    DocumentError {
        message: String,
        path: Option<String>,
    },
}

#[derive(Debug, Default)]
pub struct WindowSessionRegistry {
    /// Kept in creation order: both the restore order and `openWorkspaceRoots`
    /// are read off this, and a BTreeMap keyed by label would sort
    /// `workspace-10` before `workspace-2`.
    workspace_windows: Vec<WorkspaceWindowSession>,
    last_focused_workspace: Option<String>,
    /// Roots that could not be restored at launch, waiting for the first
    /// workspace window to ask for its session so it can report them.
    startup_skipped_roots: Vec<String>,
    document_windows: BTreeMap<PathBuf, DocumentWindowSession>,
    document_error_windows: BTreeMap<String, DocumentErrorWindowSession>,
}

#[derive(Debug, Clone)]
struct WorkspaceWindowSession {
    label: String,
    /// Canonical root, or None until the window reports what it opened.
    root: Option<PathBuf>,
}

/// What `claim_workspace_window` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceWindowClaim {
    /// That root is already open in this window; focus it instead of building
    /// a second one.
    Existing(String),
    Created(String),
}

/// What `bind_workspace_root` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindOutcome {
    Bound,
    /// Another window took the root between the caller's check and this call.
    AlreadyOwnedBy(String),
    /// The window is gone — its close raced its own frontend's report.
    UnknownWindow,
}

#[derive(Debug, Clone)]
struct DocumentWindowSession {
    label: String,
    display_path: PathBuf,
    real_path: PathBuf,
}

#[derive(Debug, Clone)]
struct DocumentErrorWindowSession {
    message: String,
    path: Option<PathBuf>,
}

/// Which files each workspace window is holding unsaved.
///
/// Bucketed per window because a document window asks this registry whether the
/// workspace has unsaved edits to the file it is showing. One shared set would
/// let the second workspace window's report erase the first one's, and the
/// document window would then be told a dirty file is clean.
#[derive(Debug, Default)]
pub struct DirtyWorkspacePaths {
    by_window: BTreeMap<String, BTreeSet<PathBuf>>,
}

impl DirtyWorkspacePaths {
    /// Replace what `label` is holding. Other windows keep their own.
    pub fn update(&mut self, label: &str, paths: Vec<String>) {
        let normalized: BTreeSet<PathBuf> = paths
            .into_iter()
            .filter_map(|path| {
                if path.is_empty() {
                    return None;
                }

                let raw_path = PathBuf::from(path);
                Some(raw_path.canonicalize().unwrap_or(raw_path))
            })
            .collect();

        if normalized.is_empty() {
            self.by_window.remove(label);
            return;
        }

        self.by_window.insert(label.to_string(), normalized);
    }

    pub fn contains(&self, path: &Path) -> bool {
        let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        self.by_window
            .values()
            .any(|paths| paths.contains(&normalized))
    }

    pub fn clear_window(&mut self, label: &str) {
        self.by_window.remove(label);
    }
}

impl WindowSessionRegistry {
    /// Reserve a window for `root`, or report the one already showing it.
    ///
    /// `root` must already be canonical; this does not touch the filesystem.
    pub fn claim_workspace_window(
        &mut self,
        root: Option<PathBuf>,
        requested_label: String,
    ) -> WorkspaceWindowClaim {
        if let Some(root) = root.as_deref() {
            if let Some(label) = self.workspace_label_for_root(root) {
                return WorkspaceWindowClaim::Existing(label.to_string());
            }
        }

        self.workspace_windows.push(WorkspaceWindowSession {
            label: requested_label.clone(),
            root,
        });
        WorkspaceWindowClaim::Created(requested_label)
    }

    /// Record that `label` now shows `root`. Switching workspaces rebinds.
    pub fn bind_workspace_root(&mut self, label: &str, root: PathBuf) -> BindOutcome {
        if let Some(owner) = self.workspace_label_for_root(&root) {
            if owner != label {
                return BindOutcome::AlreadyOwnedBy(owner.to_string());
            }
        }

        // Every workspace window claims before it is built, so an unknown
        // label means this one has already been destroyed and its report is in
        // flight. Re-adding it would leave a root bound to no window: it would
        // stay in the restore list forever and answer "already open" to every
        // later attempt to open that folder.
        let Some(session) = self
            .workspace_windows
            .iter_mut()
            .find(|session| session.label == label)
        else {
            return BindOutcome::UnknownWindow;
        };

        session.root = Some(root);
        BindOutcome::Bound
    }

    pub fn workspace_label_for_root(&self, root: &Path) -> Option<&str> {
        self.workspace_windows
            .iter()
            .find(|session| session.root.as_deref() == Some(root))
            .map(|session| session.label.as_str())
    }

    /// The bound roots, in window creation order.
    pub fn open_workspace_roots(&self) -> Vec<PathBuf> {
        self.workspace_windows
            .iter()
            .filter_map(|session| session.root.clone())
            .collect()
    }

    pub fn set_startup_skipped_roots(&mut self, roots: Vec<String>) {
        self.startup_skipped_roots = roots;
    }

    /// Hand the skipped roots to the first caller; later windows get none.
    pub fn take_startup_skipped_roots(&mut self) -> Vec<String> {
        std::mem::take(&mut self.startup_skipped_roots)
    }

    pub fn note_workspace_focus(&mut self, label: &str) {
        if self
            .workspace_windows
            .iter()
            .any(|session| session.label == label)
        {
            self.last_focused_workspace = Some(label.to_string());
        }
    }

    /// The window an open-folder request from elsewhere should land in.
    pub fn last_focused_workspace_label(&self) -> Option<&str> {
        self.last_focused_workspace
            .as_deref()
            .filter(|label| {
                self.workspace_windows
                    .iter()
                    .any(|session| session.label == *label)
            })
            .or_else(|| {
                self.workspace_windows
                    .first()
                    .map(|session| session.label.as_str())
            })
    }

    pub fn claim_document_window(
        &mut self,
        display_path: PathBuf,
        real_path: PathBuf,
        label: String,
    ) -> String {
        self.document_windows
            .entry(real_path.clone())
            .or_insert(DocumentWindowSession {
                label,
                display_path,
                real_path,
            })
            .label
            .clone()
    }

    pub fn claim_document_error_window(
        &mut self,
        label: String,
        message: String,
        path: Option<PathBuf>,
    ) -> String {
        self.document_error_windows
            .insert(label.clone(), DocumentErrorWindowSession { message, path });
        label
    }

    pub fn role_for_label(&self, label: &str) -> Option<WindowRole> {
        if self
            .workspace_windows
            .iter()
            .any(|session| session.label == label)
        {
            return Some(WindowRole::Workspace);
        }

        if self
            .document_windows
            .values()
            .any(|session| session.label == label)
            || self.document_error_windows.contains_key(label)
        {
            return Some(WindowRole::Document);
        }

        None
    }

    pub fn session_for_label(&self, label: &str) -> Option<WindowSession> {
        if let Some(session) = self
            .workspace_windows
            .iter()
            .find(|session| session.label == label)
        {
            return Some(WindowSession::Workspace {
                root_path: session.root.as_deref().map(path_to_string),
            });
        }

        if let Some(session) = self
            .document_windows
            .values()
            .find(|session| session.label == label)
        {
            return Some(WindowSession::Document {
                file_name: session
                    .real_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Markdown")
                    .to_string(),
                display_path: path_to_string(&session.display_path),
                real_path: path_to_string(&session.real_path),
            });
        }

        self.document_error_windows
            .get(label)
            .map(|session| WindowSession::DocumentError {
                message: session.message.clone(),
                path: session.path.as_deref().map(path_to_string),
            })
    }

    pub fn remove_label(&mut self, label: &str) {
        self.workspace_windows
            .retain(|session| session.label != label);
        if self.last_focused_workspace.as_deref() == Some(label) {
            self.last_focused_workspace = None;
        }
        self.document_windows
            .retain(|_, session| session.label != label);
        self.document_error_windows.remove(label);
    }

    pub fn has_workspace_windows(&self) -> bool {
        !self.workspace_windows.is_empty()
    }

    pub fn has_document_windows(&self) -> bool {
        !self.document_windows.is_empty() || !self.document_error_windows.is_empty()
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Debug, Default)]
pub struct StartupOpenRoutingState {
    ready_observed: bool,
    initial_main_events_cleared: bool,
    default_launch: Option<bool>,
    supported_startup_document_opened: bool,
}

impl StartupOpenRoutingState {
    pub fn observe_ready(&mut self) {
        self.ready_observed = true;
    }

    pub fn observe_default_launch(&mut self, default_launch: bool) {
        self.default_launch = Some(default_launch);
    }

    pub fn observe_supported_document_opened_during_startup(&mut self) {
        if !self.initial_main_events_cleared {
            self.supported_startup_document_opened = true;
        }
    }

    pub fn should_create_workspace_on_initial_main_events_cleared(
        &mut self,
        has_document_windows: bool,
    ) -> bool {
        if !self.ready_observed || self.initial_main_events_cleared {
            return false;
        }

        self.initial_main_events_cleared = true;
        self.default_launch.unwrap_or(true)
            && !has_document_windows
            && !self.supported_startup_document_opened
    }
}

pub fn normalize_opened_url_path(url: &Url) -> Option<PathBuf> {
    if url.scheme() != "file" {
        return None;
    }

    url.to_file_path().ok()
}

pub fn is_supported_document_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown")
    )
}
