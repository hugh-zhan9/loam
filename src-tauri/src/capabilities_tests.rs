//! The capability file has to cover every window this app opens.
//!
//! Tauri's ACL is scoped per window label, and a window no pattern matches gets
//! no permissions at all — silently. That is not a visible failure: the window
//! still opens, and every command the app defined itself still works, so the
//! document window read and wrote its file exactly as it should. What it could
//! not do was call a *core* command, and `listen` is one. Its menu subscription
//! was rejected, the rejection went to a `console.warn` nobody reads, and ⌘S in
//! a document window did nothing — while the same key in the workspace window,
//! whose label matched `w*`, saved.
//!
//! So this reads the labels out of the code that builds them and asks the
//! capability file about each one.

use std::path::PathBuf;

use glob::Pattern;
use serde::Deserialize;

use crate::window_sessions::{
    DOCUMENT_ERROR_WINDOW_LABEL_PREFIX, DOCUMENT_WINDOW_LABEL_PREFIX, WORKSPACE_WINDOW_LABEL_PREFIX,
};

#[derive(Deserialize)]
struct Capability {
    windows: Vec<String>,
}

fn default_capability() -> Capability {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("capabilities")
        .join("default.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));

    serde_json::from_str(&text).expect("capabilities/default.json is not valid JSON")
}

fn covers(capability: &Capability, label: &str) -> bool {
    capability.windows.iter().any(|pattern| {
        Pattern::new(pattern)
            .unwrap_or_else(|error| panic!("window pattern {pattern:?} is not a glob: {error}"))
            .matches(label)
    })
}

#[test]
fn default_capability_covers_every_window_the_app_opens() {
    let capability = default_capability();

    for label in [
        format!("{WORKSPACE_WINDOW_LABEL_PREFIX}0"),
        format!("{WORKSPACE_WINDOW_LABEL_PREFIX}17"),
        format!("{DOCUMENT_WINDOW_LABEL_PREFIX}0"),
        format!("{DOCUMENT_WINDOW_LABEL_PREFIX}17"),
        format!("{DOCUMENT_ERROR_WINDOW_LABEL_PREFIX}0"),
    ] {
        assert!(
            covers(&capability, &label),
            "no window pattern in capabilities/default.json matches {label}, so that window \
             would open with no permissions and every core command in it would be denied",
        );
    }
}
