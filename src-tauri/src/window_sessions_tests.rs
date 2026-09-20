use std::path::PathBuf;

use tauri::Url;

use crate::window_sessions::{
    is_supported_document_path, normalize_opened_url_path, BindOutcome, DirtyWorkspacePaths,
    StartupOpenRoutingState, WindowRole, WindowSession, WindowSessionRegistry,
    WorkspaceWindowClaim,
};

#[test]
fn macos_window_appearance_prefers_overlay_titlebar() {
    #[cfg(target_os = "macos")]
    {
        assert_eq!(
            crate::window_appearance::workspace_title_bar_style(),
            tauri::TitleBarStyle::Overlay
        );
        assert_eq!(
            crate::window_appearance::document_title_bar_style(),
            tauri::TitleBarStyle::Overlay
        );
        assert_eq!(
            crate::window_appearance::document_error_title_bar_style(),
            tauri::TitleBarStyle::Overlay
        );
        assert!(crate::window_appearance::workspace_hidden_title());
        assert!(crate::window_appearance::document_hidden_title());
        assert!(crate::window_appearance::document_error_hidden_title());
    }
}

#[test]
fn non_macos_window_appearance_keeps_visible_titlebar_defaults() {
    #[cfg(not(target_os = "macos"))]
    {
        assert_eq!(
            crate::window_appearance::workspace_title_bar_style(),
            tauri::TitleBarStyle::Visible
        );
        assert_eq!(
            crate::window_appearance::document_title_bar_style(),
            tauri::TitleBarStyle::Visible
        );
        assert_eq!(
            crate::window_appearance::document_error_title_bar_style(),
            tauri::TitleBarStyle::Visible
        );
        assert!(!crate::window_appearance::workspace_hidden_title());
        assert!(!crate::window_appearance::document_hidden_title());
        assert!(!crate::window_appearance::document_error_hidden_title());
    }
}

/// One window per root, not one window overall.
///
/// This replaced `registry_keeps_one_workspace_window`, which pinned the single
/// workspace window the app had before it could open several.
#[test]
fn registry_opens_one_workspace_window_per_root() {
    let mut registry = WindowSessionRegistry::default();

    let first = registry
        .claim_workspace_window(Some(PathBuf::from("/tmp/notes")), "workspace-0".to_string());
    let second = registry
        .claim_workspace_window(Some(PathBuf::from("/tmp/blog")), "workspace-1".to_string());

    assert_eq!(first, WorkspaceWindowClaim::Created("workspace-0".into()));
    assert_eq!(second, WorkspaceWindowClaim::Created("workspace-1".into()));
    assert_eq!(
        registry.role_for_label("workspace-0"),
        Some(WindowRole::Workspace)
    );
    assert_eq!(
        registry.role_for_label("workspace-1"),
        Some(WindowRole::Workspace)
    );
}

#[test]
fn registry_returns_the_existing_window_for_an_open_root() {
    let mut registry = WindowSessionRegistry::default();
    let root = PathBuf::from("/tmp/notes");

    registry.claim_workspace_window(Some(root.clone()), "workspace-0".to_string());
    let again = registry.claim_workspace_window(Some(root), "workspace-1".to_string());

    assert_eq!(again, WorkspaceWindowClaim::Existing("workspace-0".into()));
    assert_eq!(registry.open_workspace_roots().len(), 1);
}

#[test]
fn registry_claims_a_window_without_a_root_every_time() {
    let mut registry = WindowSessionRegistry::default();

    let first = registry.claim_workspace_window(None, "workspace-0".to_string());
    let second = registry.claim_workspace_window(None, "workspace-1".to_string());

    assert_eq!(first, WorkspaceWindowClaim::Created("workspace-0".into()));
    assert_eq!(second, WorkspaceWindowClaim::Created("workspace-1".into()));
    assert!(registry.open_workspace_roots().is_empty());
}

#[test]
fn binding_a_root_another_window_holds_names_that_window() {
    let mut registry = WindowSessionRegistry::default();
    let root = PathBuf::from("/tmp/notes");
    registry.claim_workspace_window(Some(root.clone()), "workspace-0".to_string());
    registry.claim_workspace_window(None, "workspace-1".to_string());

    let outcome = registry.bind_workspace_root("workspace-1", root);

    assert_eq!(outcome, BindOutcome::AlreadyOwnedBy("workspace-0".into()));
}

#[test]
fn rebinding_the_same_window_switches_its_root() {
    let mut registry = WindowSessionRegistry::default();
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/notes")), "workspace-0".to_string());

    let outcome = registry.bind_workspace_root("workspace-0", PathBuf::from("/tmp/blog"));

    assert_eq!(outcome, BindOutcome::Bound);
    assert_eq!(
        registry.open_workspace_roots(),
        vec![PathBuf::from("/tmp/blog")]
    );
}

#[test]
fn open_workspace_roots_follows_window_creation_order() {
    let mut registry = WindowSessionRegistry::default();

    // Label 10 sorts before label 2 as a string; the restore order must not.
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/a")), "workspace-2".to_string());
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/b")), "workspace-10".to_string());

    assert_eq!(
        registry.open_workspace_roots(),
        vec![PathBuf::from("/tmp/a"), PathBuf::from("/tmp/b")]
    );
}

#[test]
fn removing_a_workspace_window_drops_its_root() {
    let mut registry = WindowSessionRegistry::default();
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/notes")), "workspace-0".to_string());
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/blog")), "workspace-1".to_string());

    registry.remove_label("workspace-0");

    assert_eq!(
        registry.open_workspace_roots(),
        vec![PathBuf::from("/tmp/blog")]
    );
    assert_eq!(registry.role_for_label("workspace-0"), None);
}

#[test]
fn a_workspace_session_carries_the_root_it_was_opened_for() {
    let mut registry = WindowSessionRegistry::default();
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/notes")), "workspace-0".to_string());
    registry.claim_workspace_window(None, "workspace-1".to_string());

    assert_eq!(
        registry.session_for_label("workspace-0"),
        Some(WindowSession::Workspace {
            root_path: Some("/tmp/notes".to_string()),
        })
    );
    assert_eq!(
        registry.session_for_label("workspace-1"),
        Some(WindowSession::Workspace { root_path: None })
    );
}

/// An open-folder request from a document window lands where the user was.
#[test]
fn the_last_focused_workspace_window_takes_an_open_folder_request() {
    let mut registry = WindowSessionRegistry::default();
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/notes")), "workspace-0".to_string());
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/blog")), "workspace-1".to_string());

    registry.note_workspace_focus("workspace-1");
    assert_eq!(registry.last_focused_workspace_label(), Some("workspace-1"));

    // Closing it falls back to a window that still exists rather than to none.
    registry.remove_label("workspace-1");
    assert_eq!(registry.last_focused_workspace_label(), Some("workspace-0"));
}

#[test]
fn skipped_startup_roots_go_to_the_first_window_that_asks() {
    let mut registry = WindowSessionRegistry::default();
    registry.set_startup_skipped_roots(vec!["/Volumes/ext/blog".to_string()]);

    assert_eq!(
        registry.take_startup_skipped_roots(),
        vec!["/Volumes/ext/blog".to_string()]
    );
    assert!(registry.take_startup_skipped_roots().is_empty());
}

#[test]
fn registry_deduplicates_document_windows_by_real_path() {
    let mut registry = WindowSessionRegistry::default();
    let real_path = PathBuf::from("/tmp/note.md");

    let first = registry.claim_document_window(
        real_path.clone(),
        real_path.clone(),
        "document-0".to_string(),
    );
    let second =
        registry.claim_document_window(real_path.clone(), real_path, "document-1".to_string());

    assert_eq!(first, "document-0");
    assert_eq!(second, "document-0");
    assert_eq!(
        registry.role_for_label("document-0"),
        Some(WindowRole::Document)
    );
    assert_eq!(registry.role_for_label("document-1"), None);
}

#[test]
fn registry_returns_document_session_for_window_label() {
    let mut registry = WindowSessionRegistry::default();
    let display_path = PathBuf::from("/tmp/link.md");
    let real_path = PathBuf::from("/tmp/note.md");

    let label = registry.claim_document_window(display_path, real_path, "document-0".to_string());
    let session = registry.session_for_label(&label);

    assert_eq!(
        session,
        Some(WindowSession::Document {
            file_name: "note.md".to_string(),
            display_path: "/tmp/link.md".to_string(),
            real_path: "/tmp/note.md".to_string(),
        })
    );
}

#[test]
fn registry_returns_document_error_session_for_window_label() {
    let mut registry = WindowSessionRegistry::default();

    let label = registry.claim_document_error_window(
        "document-error-0".to_string(),
        "无法解析这个 Markdown 文档路径。".to_string(),
        Some(PathBuf::from("/tmp/missing.md")),
    );
    let session = registry.session_for_label(&label);

    assert_eq!(
        session,
        Some(WindowSession::DocumentError {
            message: "无法解析这个 Markdown 文档路径。".to_string(),
            path: Some("/tmp/missing.md".to_string()),
        })
    );
    assert_eq!(
        registry.role_for_label("document-error-0"),
        Some(WindowRole::Document)
    );
}

#[test]
fn registry_removes_document_when_window_is_destroyed() {
    let mut registry = WindowSessionRegistry::default();
    let real_path = PathBuf::from("/tmp/note.md");

    let first = registry.claim_document_window(
        real_path.clone(),
        real_path.clone(),
        "document-0".to_string(),
    );
    registry.remove_label(&first);
    let second =
        registry.claim_document_window(real_path.clone(), real_path, "document-1".to_string());

    assert_eq!(second, "document-1");
    assert_eq!(registry.role_for_label("document-0"), None);
    assert_eq!(
        registry.role_for_label("document-1"),
        Some(WindowRole::Document)
    );
}

#[test]
fn opened_url_path_accepts_file_urls_and_rejects_non_files() {
    let file_url = Url::from_file_path("/tmp/note.md").unwrap();
    let http_url = Url::parse("https://example.com/note.md").unwrap();

    assert_eq!(
        normalize_opened_url_path(&file_url).unwrap(),
        PathBuf::from("/tmp/note.md")
    );
    assert!(normalize_opened_url_path(&http_url).is_none());
    assert!(is_supported_document_path(
        PathBuf::from("/tmp/note.md").as_path()
    ));
    assert!(is_supported_document_path(
        PathBuf::from("/tmp/note.markdown").as_path()
    ));
    assert!(!is_supported_document_path(
        PathBuf::from("/tmp/note.mdx").as_path()
    ));
}

#[test]
fn startup_routing_does_not_create_workspace_when_ready_precedes_supported_opened() {
    let mut state = StartupOpenRoutingState::default();

    state.observe_ready();
    state.observe_default_launch(true);
    state.observe_supported_document_opened_during_startup();

    assert!(!state.should_create_workspace_on_initial_main_events_cleared(false));
}

#[test]
fn startup_routing_does_not_commit_workspace_before_initial_main_events_cleared() {
    let mut state = StartupOpenRoutingState::default();

    state.observe_ready();
    state.observe_default_launch(true);
    // No timeout or elapsed-time check commits startup routing before the first
    // main-event drain, so a later startup Opened event can still suppress it.
    state.observe_supported_document_opened_during_startup();

    assert!(!state.should_create_workspace_on_initial_main_events_cleared(false));
}

#[test]
fn startup_routing_does_not_create_workspace_for_non_default_launch() {
    let mut state = StartupOpenRoutingState::default();

    state.observe_ready();
    state.observe_default_launch(false);

    assert!(!state.should_create_workspace_on_initial_main_events_cleared(false));
}

#[test]
fn startup_routing_creates_workspace_for_default_launch_without_documents() {
    let mut state = StartupOpenRoutingState::default();

    state.observe_ready();
    state.observe_default_launch(true);

    assert!(state.should_create_workspace_on_initial_main_events_cleared(false));
}

#[test]
fn startup_routing_creates_workspace_when_launch_reason_is_unknown() {
    let mut state = StartupOpenRoutingState::default();

    state.observe_ready();

    assert!(state.should_create_workspace_on_initial_main_events_cleared(false));
}

#[test]
fn dirty_workspace_paths_canonicalizes_existing_paths() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("note.md");
    std::fs::write(&file, "# Note\n").unwrap();

    let mut dirty = DirtyWorkspacePaths::default();
    dirty.update("workspace-0", vec![file.to_string_lossy().into_owned()]);

    assert!(dirty.contains(&file.canonicalize().unwrap()));
}

#[test]
fn dirty_workspace_paths_keeps_raw_path_when_canonicalization_fails() {
    let file = PathBuf::from("/tmp/mdx-missing-dirty-note.md");

    let mut dirty = DirtyWorkspacePaths::default();
    dirty.update("workspace-0", vec![file.to_string_lossy().into_owned()]);

    assert!(dirty.contains(&file));
}

#[test]
fn dirty_workspace_paths_clear_removes_stored_paths() {
    let file = PathBuf::from("/tmp/mdx-dirty-note.md");

    let mut dirty = DirtyWorkspacePaths::default();
    dirty.update("workspace-0", vec![file.to_string_lossy().into_owned()]);
    dirty.clear_window("workspace-0");

    assert!(!dirty.contains(&file));
}

/// One window reporting its dirty files must not clear another window's.
///
/// A shared set let the second report erase the first, and a document window
/// reading this was then told an unsaved file was clean.
#[test]
fn one_window_reporting_dirty_paths_leaves_another_windows_alone() {
    let first = PathBuf::from("/tmp/mdx-dirty-a.md");
    let second = PathBuf::from("/tmp/mdx-dirty-b.md");

    let mut dirty = DirtyWorkspacePaths::default();
    dirty.update("workspace-0", vec![first.to_string_lossy().into_owned()]);
    dirty.update("workspace-1", vec![second.to_string_lossy().into_owned()]);

    assert!(dirty.contains(&first));
    assert!(dirty.contains(&second));

    // workspace-1 saves everything it had open.
    dirty.update("workspace-1", Vec::new());

    assert!(dirty.contains(&first));
    assert!(!dirty.contains(&second));
}

#[test]
fn closing_one_window_keeps_another_windows_dirty_paths() {
    let first = PathBuf::from("/tmp/mdx-dirty-a.md");
    let second = PathBuf::from("/tmp/mdx-dirty-b.md");

    let mut dirty = DirtyWorkspacePaths::default();
    dirty.update("workspace-0", vec![first.to_string_lossy().into_owned()]);
    dirty.update("workspace-1", vec![second.to_string_lossy().into_owned()]);

    dirty.clear_window("workspace-1");

    assert!(dirty.contains(&first));
    assert!(!dirty.contains(&second));
}

/// Closing the last workspace window must not empty the restore list.
///
/// That close is how this app quits, and an empty list restores nothing next
/// launch. An earlier version asked a shutdown flag set from `ExitRequested`
/// instead, which never worked: the runtime emits `Destroyed` for the window
/// before `ExitRequested` for the app, so the flag was always still false.
#[test]
fn closing_the_last_workspace_window_leaves_the_restore_list_alone() {
    // One of several closed: the user narrowed the set they want back.
    assert!(crate::should_update_restore_list_on_destroy(true, true));
    // The last one closed: this is a quit.
    assert!(!crate::should_update_restore_list_on_destroy(true, false));
    // A document window never contributed to the list either way.
    assert!(!crate::should_update_restore_list_on_destroy(false, true));
    assert!(!crate::should_update_restore_list_on_destroy(false, false));
}

/// The registry reports whether any workspace window is left.
///
/// That answer is what decides the rule above, so the two have to agree about
/// "the last one".
#[test]
fn the_registry_knows_when_the_last_workspace_window_is_gone() {
    let mut registry = WindowSessionRegistry::default();
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/notes")), "workspace-0".to_string());
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/blog")), "workspace-1".to_string());

    registry.remove_label("workspace-0");
    assert!(registry.has_workspace_windows());

    registry.remove_label("workspace-1");
    assert!(!registry.has_workspace_windows());
}

/// A window that closed while its own report was in flight must stay gone.
///
/// Re-adding it would bind a root to no window: that root would sit in the
/// restore list forever and answer "already open" to every later attempt to
/// open that folder, which no window could then satisfy.
#[test]
fn binding_from_a_destroyed_window_does_not_resurrect_it() {
    let mut registry = WindowSessionRegistry::default();
    registry.claim_workspace_window(Some(PathBuf::from("/tmp/notes")), "workspace-0".to_string());
    registry.remove_label("workspace-0");

    let outcome = registry.bind_workspace_root("workspace-0", PathBuf::from("/tmp/notes"));

    assert_eq!(outcome, BindOutcome::UnknownWindow);
    assert!(registry.open_workspace_roots().is_empty());
    assert!(!registry.has_workspace_windows());
}
