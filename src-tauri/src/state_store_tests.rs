use tempfile::tempdir;

use crate::state_store::{
    forget_workspace_roots_at_path, load_state_from_path, save_app_preferences_to_path,
    save_state_to_path, save_window_size_to_path, save_workspace_state_to_path,
    set_open_workspace_roots_to_path, AppPreferences, AppState, PersistedPanelState,
    PersistedWindowSize, PersistedWorkspaceState, PersistedWorkspaceTab,
};

fn workspace(root_path: &str) -> PersistedWorkspaceState {
    PersistedWorkspaceState {
        root_path: root_path.to_string(),
        ..PersistedWorkspaceState::default()
    }
}

#[test]
fn loads_empty_state_when_state_file_is_missing() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");

    let state = load_state_from_path(&path).unwrap();
    assert_eq!(state.state_version, 1);
    assert!(state.recent_workspace_root.is_none());
    assert!(state.workspaces.is_empty());
    assert_eq!(state.window_size.width, 1480.0);
    assert_eq!(state.window_size.height, 860.0);
}

#[test]
fn backs_up_corrupt_state_file_before_resetting() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(&path, "{not json").unwrap();

    let state = load_state_from_path(&path).unwrap();
    assert_eq!(state.state_version, 1);
    let reset_state = load_state_from_path(&path).unwrap();
    assert_eq!(reset_state.state_version, 1);
    assert!(dir.path().read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("state.json.corrupt.")
    }));
}

#[test]
fn app_preferences_include_file_watch_and_search_defaults() {
    let preferences = AppPreferences::default();

    assert!(preferences.file_watch_enabled);
    assert_eq!(preferences.search_max_file_bytes, 2_097_152);
    assert_eq!(preferences.search_max_results, 200);
    assert_eq!(preferences.search_max_matches_per_file, 20);
}

#[test]
fn old_state_without_new_preferences_uses_defaults() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(
        &path,
        r#"{
          "stateVersion": 1,
          "recentWorkspaceRoot": "/tmp/ws",
          "preferences": {
            "fileTreeExcludeDirs": ["vendor"]
          },
          "workspaces": [],
          "windowSize": { "width": 1280, "height": 820 }
        }"#,
    )
    .unwrap();

    let state = load_state_from_path(&path).unwrap();

    assert_eq!(state.preferences.file_tree_exclude_dirs, vec!["vendor"]);
    assert!(state.preferences.file_watch_enabled);
    assert_eq!(state.preferences.search_max_file_bytes, 2_097_152);
    assert_eq!(state.preferences.search_max_results, 200);
    assert_eq!(state.preferences.search_max_matches_per_file, 20);
}

#[test]
fn saves_and_reloads_workspace_state() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    let state = AppState {
        state_version: 1,
        recent_workspace_root: Some("/tmp/ws".to_string()),
        preferences: AppPreferences {
            file_tree_exclude_dirs: vec!["vendor".to_string(), "docs/archive".to_string()],
            file_watch_enabled: false,
            search_max_file_bytes: 1_048_576,
            search_max_results: 100,
            search_max_matches_per_file: 10,
        },
        workspaces: vec![PersistedWorkspaceState {
            root_path: "/tmp/ws".to_string(),
            tabs: vec![
                PersistedWorkspaceTab {
                    tab_id: "tab-1".to_string(),
                    path: "/tmp/ws/one.md".to_string(),
                    title: "one.md".to_string(),
                    dirty: false,
                    needs_rename_on_first_save: false,
                },
                PersistedWorkspaceTab {
                    tab_id: "tab-2".to_string(),
                    path: "/tmp/ws/two.md".to_string(),
                    title: "two.md".to_string(),
                    dirty: true,
                    needs_rename_on_first_save: true,
                },
            ],
            active_tab_id: Some("tab-2".to_string()),
            panels: PersistedPanelState {
                navigator_collapsed: Some(true),
                list_width: Some(320),
                rail_width: Some(240),
                right_collapsed: Some(false),
                right_width: Some(360),
                left_collapsed: None,
                left_width: None,
            },
            tree_focus_path: Some("/tmp/ws/raw".to_string()),
            window_size: None,
        }],
        window_size: PersistedWindowSize {
            width: 1480.0,
            height: 860.0,
        },
        open_workspace_roots: vec!["/tmp/ws".to_string()],
    };

    save_state_to_path(&path, &state).unwrap();

    let raw_json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw_json["stateVersion"], 1);
    assert_eq!(raw_json["recentWorkspaceRoot"], "/tmp/ws");
    assert_eq!(raw_json["preferences"]["fileTreeExcludeDirs"][0], "vendor");
    assert_eq!(raw_json["preferences"]["fileWatchEnabled"], false);
    assert_eq!(raw_json["preferences"]["searchMaxFileBytes"], 1_048_576);
    assert_eq!(raw_json["preferences"]["searchMaxResults"], 100);
    assert_eq!(raw_json["preferences"]["searchMaxMatchesPerFile"], 10);
    assert_eq!(raw_json["workspaces"][0]["activeTabId"], "tab-2");
    assert_eq!(
        raw_json["workspaces"][0]["panels"]["navigatorCollapsed"],
        true
    );
    // The names the file uses are the names the frontend sends. They stopped
    // agreeing once, and the whole save failed rather than one field.
    assert_eq!(raw_json["workspaces"][0]["panels"]["listWidth"], 320);
    assert_eq!(raw_json["workspaces"][0]["panels"]["railWidth"], 240);
    assert_eq!(
        raw_json["workspaces"][0]["treeFocusPath"],
        "/tmp/ws/raw"
    );
    // Nothing writes the old names back once they are gone.
    assert!(raw_json["workspaces"][0]["panels"]["leftWidth"].is_null());
    assert_eq!(raw_json["windowSize"]["width"], 1480.0);

    let reloaded = load_state_from_path(&path).unwrap();
    assert_eq!(reloaded.recent_workspace_root.as_deref(), Some("/tmp/ws"));
    assert_eq!(
        reloaded.preferences.file_tree_exclude_dirs,
        vec!["vendor".to_string(), "docs/archive".to_string()]
    );
    assert!(!reloaded.preferences.file_watch_enabled);
    assert_eq!(reloaded.preferences.search_max_file_bytes, 1_048_576);
    assert_eq!(reloaded.preferences.search_max_results, 100);
    assert_eq!(reloaded.preferences.search_max_matches_per_file, 10);
    assert_eq!(reloaded.workspaces.len(), 1);

    let workspace = &reloaded.workspaces[0];
    assert_eq!(workspace.root_path, "/tmp/ws");
    assert_eq!(workspace.active_tab_id.as_deref(), Some("tab-2"));
    assert_eq!(workspace.tabs.len(), 2);
    assert_eq!(workspace.tabs[0].tab_id, "tab-1");
    assert_eq!(workspace.tabs[0].path, "/tmp/ws/one.md");
    assert_eq!(workspace.tabs[1].title, "two.md");
    assert!(workspace.tabs[1].dirty);
    assert!(workspace.tabs[1].needs_rename_on_first_save);
    assert_eq!(workspace.panels.navigator_collapsed, Some(true));
    assert_eq!(workspace.panels.list_width, Some(320));
    assert_eq!(workspace.panels.rail_width, Some(240));
    // The folder the tree was left showing survives the round trip. It did not
    // before: this struct had no field for it, so it was dropped on save.
    assert_eq!(
        workspace.tree_focus_path.as_deref(),
        Some("/tmp/ws/raw")
    );
    assert_eq!(workspace.panels.right_collapsed, Some(false));
    assert_eq!(workspace.panels.right_width, Some(360));
    assert_eq!(reloaded.window_size.width, 1480.0);
    assert_eq!(reloaded.window_size.height, 860.0);
}

#[test]
fn save_normalizes_invalid_app_state_values() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    let state = AppState {
        state_version: 0,
        recent_workspace_root: Some("/tmp/ws".to_string()),
        preferences: AppPreferences {
            file_tree_exclude_dirs: vec![
                " vendor ".to_string(),
                "vendor".to_string(),
                "../outside".to_string(),
            ],
            file_watch_enabled: true,
            search_max_file_bytes: 1,
            search_max_results: 10_000,
            search_max_matches_per_file: 0,
        },
        workspaces: vec![
            PersistedWorkspaceState {
                root_path: "".to_string(),
                tabs: Vec::new(),
                active_tab_id: None,
                panels: PersistedPanelState::default(),
                tree_focus_path: None,
                window_size: None,
            },
            PersistedWorkspaceState {
                root_path: "/tmp/ws".to_string(),
                tabs: vec![
                    PersistedWorkspaceTab {
                        tab_id: " tab-1 ".to_string(),
                        path: "/tmp/ws/one.md".to_string(),
                        title: " ".to_string(),
                        dirty: false,
                        needs_rename_on_first_save: false,
                    },
                    PersistedWorkspaceTab {
                        tab_id: "tab-2".to_string(),
                        path: "/other/two.md".to_string(),
                        title: "two.md".to_string(),
                        dirty: false,
                        needs_rename_on_first_save: false,
                    },
                ],
                active_tab_id: Some("tab-1".to_string()),
                panels: PersistedPanelState {
                    navigator_collapsed: Some(false),
                    list_width: Some(10),
                    rail_width: Some(9_000),
                    right_collapsed: Some(false),
                    right_width: Some(900),
                    left_collapsed: None,
                    left_width: None,
                },
                // Whitespace is not a folder.
                tree_focus_path: Some("   ".to_string()),
                window_size: Some(PersistedWindowSize {
                    width: 10.0,
                    height: -5.0,
                }),
            },
        ],
        window_size: PersistedWindowSize {
            width: f64::NAN,
            height: 100.2,
        },
        open_workspace_roots: Vec::new(),
    };

    save_state_to_path(&path, &state).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(saved.state_version, 1);
    assert_eq!(saved.preferences.file_tree_exclude_dirs, vec!["vendor"]);
    assert_eq!(saved.preferences.search_max_file_bytes, 1_024);
    assert_eq!(saved.preferences.search_max_results, 5_000);
    // A per-root size is clamped exactly like the top-level one: the fixture
    // asks for 10 x -5 and gets the minimum window.
    let workspace_size = saved.workspaces[0].window_size.as_ref().unwrap();
    assert_eq!(workspace_size.width, 1100.0);
    assert_eq!(workspace_size.height, 640.0);
    assert_eq!(saved.preferences.search_max_matches_per_file, 1);
    assert_eq!(saved.workspaces.len(), 1);
    assert_eq!(saved.workspaces[0].tabs.len(), 1);
    assert_eq!(saved.workspaces[0].tabs[0].tab_id, "tab-1");
    assert_eq!(saved.workspaces[0].tabs[0].title, "Untitled");
    // Widths are carried, not corrected: what a column may be is decided by the
    // window that draws it, and a second opinion here would be a second set of
    // numbers to keep in step.
    assert_eq!(saved.workspaces[0].panels.list_width, Some(10));
    assert_eq!(saved.workspaces[0].panels.rail_width, Some(9_000));
    assert_eq!(saved.workspaces[0].tree_focus_path, None);
    assert_eq!(saved.window_size.width, 1480.0);
    assert_eq!(saved.window_size.height, 640.0);
}

#[test]
fn loads_a_state_file_that_still_names_the_left_panel() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    // Written by a version where the navigator was one column called "left".
    // It has to load, and it has to keep those numbers: the frontend is what
    // turns a total into a width per column, and it only gets one chance.
    std::fs::write(
        &path,
        r#"{
            "stateVersion": 1,
            "recentWorkspaceRoot": "/tmp/ws",
            "workspaces": [
                {
                    "rootPath": "/tmp/ws",
                    "tabs": [],
                    "activeTabId": null,
                    "panels": {
                        "leftCollapsed": true,
                        "leftWidth": 518,
                        "rightCollapsed": false,
                        "rightWidth": 604
                    }
                }
            ]
        }"#,
    )
    .unwrap();

    let loaded = load_state_from_path(&path).unwrap();
    let panels = &loaded.workspaces[0].panels;

    assert_eq!(panels.left_collapsed, Some(true));
    assert_eq!(panels.left_width, Some(518));
    // Absent, not defaulted: that is the frontend's cue to work the list's
    // width out from the single width the old state held.
    assert_eq!(panels.rail_width, None);
    assert_eq!(panels.list_width, None);
    assert_eq!(loaded.workspaces[0].tree_focus_path, None);
}

/// Two workspace windows saving in turn must both survive.
///
/// Each window used to submit the whole AppState it had read at startup, so
/// whichever saved last silently dropped what the other had saved since. The
/// segmented writers re-read the file under the lock instead.
#[test]
fn saving_one_workspace_keeps_what_another_window_saved() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");

    // Window B saves first, window A second — the order that used to lose B.
    save_workspace_state_to_path(&path, workspace("/tmp/blog")).unwrap();
    save_workspace_state_to_path(&path, workspace("/tmp/notes")).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    let roots: Vec<&str> = saved
        .workspaces
        .iter()
        .map(|workspace| workspace.root_path.as_str())
        .collect();

    assert_eq!(roots, vec!["/tmp/notes", "/tmp/blog"]);
    assert_eq!(saved.recent_workspace_root.as_deref(), Some("/tmp/notes"));
}

#[test]
fn saving_preferences_leaves_every_workspace_alone() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    save_workspace_state_to_path(&path, workspace("/tmp/notes")).unwrap();

    save_app_preferences_to_path(
        &path,
        AppPreferences {
            file_tree_exclude_dirs: vec!["vendor".to_string()],
            ..AppPreferences::default()
        },
    )
    .unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(saved.preferences.file_tree_exclude_dirs, vec!["vendor"]);
    assert_eq!(saved.workspaces.len(), 1);
    assert_eq!(saved.workspaces[0].root_path, "/tmp/notes");
}

#[test]
fn saving_a_workspace_leaves_the_open_root_list_alone() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    set_open_workspace_roots_to_path(
        &path,
        vec!["/tmp/notes".to_string(), "/tmp/blog".to_string()],
    )
    .unwrap();

    save_workspace_state_to_path(&path, workspace("/tmp/notes")).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(saved.open_workspace_roots, vec!["/tmp/notes", "/tmp/blog"]);
}

#[test]
fn a_window_size_lands_on_its_own_workspace() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    save_workspace_state_to_path(&path, workspace("/tmp/notes")).unwrap();
    save_workspace_state_to_path(&path, workspace("/tmp/blog")).unwrap();

    save_window_size_to_path(
        &path,
        Some("/tmp/notes".to_string()),
        PersistedWindowSize {
            width: 1200.0,
            height: 700.0,
        },
    )
    .unwrap();

    let saved = load_state_from_path(&path).unwrap();
    let notes = saved
        .workspaces
        .iter()
        .find(|workspace| workspace.root_path == "/tmp/notes")
        .unwrap();
    let blog = saved
        .workspaces
        .iter()
        .find(|workspace| workspace.root_path == "/tmp/blog")
        .unwrap();

    assert_eq!(notes.window_size.as_ref().unwrap().width, 1200.0);
    assert!(blog.window_size.is_none());
}

/// A window with no workspace bound yet still has a size worth keeping.
#[test]
fn a_window_size_without_a_root_lands_at_the_top_level() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");

    save_window_size_to_path(
        &path,
        None,
        PersistedWindowSize {
            width: 1300.0,
            height: 800.0,
        },
    )
    .unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(saved.window_size.width, 1300.0);
    assert!(saved.workspaces.is_empty());
}

/// Saving tabs must not wipe the size that workspace already had.
#[test]
fn saving_a_workspace_without_a_size_keeps_the_recorded_one() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    save_window_size_to_path(
        &path,
        Some("/tmp/notes".to_string()),
        PersistedWindowSize {
            width: 1200.0,
            height: 700.0,
        },
    )
    .unwrap();

    save_workspace_state_to_path(&path, workspace("/tmp/notes")).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(
        saved.workspaces[0].window_size.as_ref().unwrap().width,
        1200.0
    );
}

/// A root that could not be restored takes its tab state with it.
///
/// Deliberate and irreversible, by D-006 of the multi-workspace-windows design.
#[test]
fn forgetting_a_root_drops_its_saved_workspace_too() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    save_workspace_state_to_path(&path, workspace("/Volumes/ext/blog")).unwrap();
    save_workspace_state_to_path(&path, workspace("/tmp/notes")).unwrap();
    set_open_workspace_roots_to_path(
        &path,
        vec!["/tmp/notes".to_string(), "/Volumes/ext/blog".to_string()],
    )
    .unwrap();

    forget_workspace_roots_at_path(&path, &["/Volumes/ext/blog".to_string()]).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(saved.open_workspace_roots, vec!["/tmp/notes"]);
    assert_eq!(saved.workspaces.len(), 1);
    assert_eq!(saved.workspaces[0].root_path, "/tmp/notes");
}

#[test]
fn forgetting_the_recent_root_clears_it() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    save_workspace_state_to_path(&path, workspace("/Volumes/ext/blog")).unwrap();

    forget_workspace_roots_at_path(&path, &["/Volumes/ext/blog".to_string()]).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert!(saved.recent_workspace_root.is_none());
}

/// A state file written before this feature still loads, and a segmented write
/// against it neither invents nor discards anything.
#[test]
fn a_state_file_without_the_new_fields_still_loads_and_merges() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "stateVersion": 1,
            "recentWorkspaceRoot": "/tmp/notes",
            "workspaces": [{
                "rootPath": "/tmp/notes",
                "tabs": [],
                "activeTabId": null,
                "panels": {}
            }],
            "windowSize": { "width": 1480.0, "height": 860.0 }
        })
        .to_string(),
    )
    .unwrap();

    let loaded = load_state_from_path(&path).unwrap();
    assert!(loaded.open_workspace_roots.is_empty());
    assert!(loaded.workspaces[0].window_size.is_none());

    save_workspace_state_to_path(&path, workspace("/tmp/blog")).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(saved.workspaces.len(), 2);
    assert_eq!(saved.window_size.width, 1480.0);
    // The field is skipped when empty, so an older build reading this file back
    // sees exactly the shape it wrote.
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(raw["workspaces"][0].get("windowSize").is_none());
}

/// A merge that finds the file corrupt must repair it, not hang.
///
/// The repair used to go through `save_state_to_path`, which takes the same
/// lock the merge is already holding. That deadlocked the thread and every
/// later save in every window behind it.
#[test]
fn merging_into_a_corrupt_state_file_repairs_it_instead_of_deadlocking() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("state.json");
    std::fs::write(&path, b"{ not json at all").unwrap();

    save_workspace_state_to_path(&path, workspace("/tmp/notes")).unwrap();

    let saved = load_state_from_path(&path).unwrap();
    assert_eq!(saved.workspaces.len(), 1);
    assert_eq!(saved.workspaces[0].root_path, "/tmp/notes");
}
