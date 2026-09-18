//! Putting material into the library.
//!
//! Three doors lead in — a file, a directory, and a string — and they all end
//! up as the same thing: an evidence drawer that keeps the original text and
//! knows where it came from. Nothing here decides what any of it means; that
//! only happens when someone distills a conclusion out of it.
//!
//! The string door is hand-assembled because upstream never exposed one. Its
//! ingest API reads from disk, and the "write this text" path lives in the
//! upstream MCP server, which this application deliberately does not depend on.
//! The order below mirrors that server's: identity, lock, existence check,
//! embed, insert.

use std::path::{Path, PathBuf};
use std::time::Duration;

use mempal_runtime::core::db::Database;
use mempal_runtime::core::types::{BootstrapEvidenceArgs, Drawer, SourceType};
use mempal_runtime::core::utils::build_bootstrap_evidence_drawer_id;
use mempal_runtime::core::{anchor, utils::current_timestamp};
use mempal_runtime::embed::Embedder;
use mempal_runtime::ingest::lock::acquire_source_lock;
use mempal_runtime::ingest::normalize::CURRENT_NORMALIZE_VERSION;
use mempal_runtime::ingest::{ingest_file_with_options, IngestOptions};
use mempal_runtime::path_filter::{project_walk, ProjectPathFilterOptions};

use crate::memory::config::memory_home_dir;
use crate::memory::engine::{block_on, embed_one};
use crate::memory::lark_export::LarkDocument;
use crate::memory::models::evidence::{IngestOutcome, WrittenEvidence};
use crate::models::WorkspaceError;

/// How long to wait for another writer to leave the critical section.
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Material that did not come from a file: a captured session, or the record of
/// someone reviewing a conclusion.
pub struct TextEvidence<'a> {
    pub workspace_root: &'a Path,
    pub wing: &'a str,
    pub room: &'a str,
    pub content: String,
    pub source_type: SourceType,
    /// A stable identifier for where this came from. It is part of the drawer's
    /// identity, so two captures of the same session collapse into one entry.
    pub source_file: Option<String>,
    pub importance: i32,
}

/// Writes one piece of material that is not on disk.
///
/// Idempotent by construction: the drawer id is derived from the wing, room,
/// content and source, so writing the same thing twice is a no-op rather than a
/// duplicate.
pub fn write_text<E: Embedder + ?Sized>(
    database: &Database,
    embedder: &E,
    evidence: TextEvidence<'_>,
) -> Result<WrittenEvidence, WorkspaceError> {
    if evidence.content.trim().is_empty() {
        return Err(WorkspaceError::new(
            "invalid_evidence",
            "material with no text cannot be stored",
        ));
    }

    let drawer_id = build_bootstrap_evidence_drawer_id(
        evidence.wing,
        Some(evidence.room),
        &evidence.content,
        &evidence.source_type,
        evidence.source_file.as_deref(),
    );

    let lock_home = memory_home_dir()?;
    let guard = acquire_source_lock(&lock_home, &drawer_id, LOCK_TIMEOUT).map_err(|error| {
        WorkspaceError::new(
            "memory_busy",
            format!("another writer is holding the memory library: {error}"),
        )
    })?;
    let lock_wait_ms = guard.wait_duration().as_millis() as u64;

    let exists = database.drawer_exists(&drawer_id).map_err(|error| {
        WorkspaceError::new(
            "memory_unavailable",
            format!("failed to check for existing material: {error}"),
        )
    })?;
    if exists {
        return Ok(WrittenEvidence {
            drawer_id,
            created: false,
            lock_wait_ms,
        });
    }

    // Embedding happens inside the critical section on purpose: leaving it
    // outside would let two writers both decide the drawer is new.
    let vector = embed_one(embedder, &evidence.content)?;
    let drawer = evidence_drawer(&drawer_id, &evidence)?;

    let inserted = database.insert_drawer(&drawer).map_err(|error| {
        WorkspaceError::new(
            "memory_unavailable",
            format!("failed to store material: {error}"),
        )
    })?;
    if inserted {
        database
            .insert_vector(&drawer_id, &vector)
            .map_err(|error| {
                WorkspaceError::new(
                    "memory_unavailable",
                    format!("failed to index material: {error}"),
                )
            })?;
    }

    drop(guard);

    Ok(WrittenEvidence {
        drawer_id,
        created: inserted,
        lock_wait_ms,
    })
}

/// Reads one file into the library.
///
/// Lark export envelopes are decoded here; upstream still owns transcript
/// detection, noise stripping, chunking and indexing. The anchor it writes
/// is the legacy repo anchor — see the module note in the detailed design; the
/// context assembler still reaches those drawers through its legacy fallback.
pub fn ingest_file<E: Embedder + ?Sized>(
    database: &Database,
    embedder: &E,
    workspace_root: &Path,
    wing: &str,
    path: &Path,
    // `room_override` keeps the legacy import in `legacy/…` instead of mixing
    // imported material into the rooms live files use.
    room_override: Option<&str>,
) -> Result<IngestOutcome, WorkspaceError> {
    let room = room_override
        .map(ToString::to_string)
        .unwrap_or_else(|| room_for(workspace_root, path));
    let source = path
        .strip_prefix(workspace_root)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .or_else(|| path.file_name().map(std::path::PathBuf::from))
        .unwrap_or_else(|| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/");
    let prepared = prepare_lark_file(path)?;
    let input = prepared.as_ref().map_or(path, |file| file.path());
    let stats = block_on(ingest_file_with_options(
        database,
        embedder,
        input,
        wing,
        IngestOptions {
            room: Some(&room),
            source_root: Some(workspace_root),
            source_file_override: Some(&source),
            ..default_ingest_options()
        },
    ))
    .map_err(|error| {
        WorkspaceError::new(
            "memory_unavailable",
            format!("failed to read {} into memory: {error}", path.display()),
        )
    })?;

    Ok(IngestOutcome {
        files: stats.files,
        chunks: stats.chunks,
        skipped: stats.skipped,
        room,
    })
}

/// Reads a directory tree into the library, honouring the project's ignore rules.
pub fn ingest_directory<E: Embedder + ?Sized>(
    database: &Database,
    embedder: &E,
    workspace_root: &Path,
    wing: &str,
    directory: &Path,
) -> Result<IngestOutcome, WorkspaceError> {
    let room = room_for(workspace_root, directory);
    let mut outcome = IngestOutcome {
        files: 0,
        chunks: 0,
        skipped: 0,
        room,
    };
    let walk = project_walk(directory, &ProjectPathFilterOptions::default())
        .map_err(|e| WorkspaceError::new("memory_unavailable", e.to_string()))?;
    for entry in walk {
        let entry = entry.map_err(|e| WorkspaceError::new("memory_unavailable", e.to_string()))?;
        let path = entry.path();
        if path == directory || !path.is_file() {
            continue;
        }
        if skip_ingest_file(path) {
            outcome.skipped += 1;
            continue;
        }
        let file = ingest_file(
            database,
            embedder,
            workspace_root,
            wing,
            path,
            Some(&outcome.room),
        )?;
        outcome.files += file.files;
        outcome.chunks += file.chunks;
        outcome.skipped += file.skipped;
    }
    Ok(outcome)
}

fn prepare_lark_file(path: &Path) -> Result<Option<tempfile::NamedTempFile>, WorkspaceError> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .map_err(|e| WorkspaceError::from_io("memory_unavailable", "failed to read export", &e))?;
    let source = String::from_utf8_lossy(&bytes);
    let Some(document) = LarkDocument::parse(&source)
        .map_err(|e| WorkspaceError::new("invalid_evidence", format!("{}: {e}", path.display())))?
    else {
        return Ok(None);
    };
    let file = tempfile::NamedTempFile::new().map_err(|e| {
        WorkspaceError::from_io("memory_unavailable", "failed to prepare export text", &e)
    })?;
    std::fs::write(file.path(), document.readable()).map_err(|e| {
        WorkspaceError::from_io("memory_unavailable", "failed to prepare export text", &e)
    })?;
    Ok(Some(file))
}

// mempal-runtime 0.9 does not expose its file filter or an input-transform hook.
// Keep its exclusions while routing every eligible file through our normalizer.
fn skip_ingest_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
    matches!(name, ".DS_Store" | ".gitignore" | ".mempalignore")
        || name.starts_with("._")
        || path
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "a" | "bmp"
                        | "class"
                        | "dll"
                        | "dylib"
                        | "exe"
                        | "gif"
                        | "ico"
                        | "jar"
                        | "jpeg"
                        | "jpg"
                        | "o"
                        | "pdf"
                        | "png"
                        | "so"
                        | "wasm"
                        | "webp"
                        | "zip"
                )
            })
}

/// Hides one entry from every read path, keeping it for an audit.
pub fn soft_delete(database: &Database, drawer_id: &str) -> Result<bool, WorkspaceError> {
    database.soft_delete_drawer(drawer_id).map_err(|error| {
        WorkspaceError::new(
            "memory_unavailable",
            format!("failed to remove material: {error}"),
        )
    })
}

/// Erases previously removed entries for good.
///
/// The counterpart to soft delete, and the only answer to "this should never
/// have been captured" now that nothing waits outside the library for approval.
pub fn purge(database: &Database, before: Option<&str>) -> Result<u64, WorkspaceError> {
    database.purge_deleted(before).map_err(|error| {
        WorkspaceError::new(
            "memory_unavailable",
            format!("failed to erase removed material: {error}"),
        )
    })
}

/// Which room a path belongs to.
///
/// The first directory under the workspace root, because that is how these
/// workspaces are already organised — `raw/`, `wiki/`, `notes/`. Files sitting
/// at the root share one room rather than each becoming their own.
pub fn room_for(workspace_root: &Path, path: &Path) -> String {
    let relative = path
        .strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_path_buf();
    let mut segments = relative.components();

    match segments.next() {
        Some(first) if relative.components().count() > 1 => {
            sanitize_room(&first.as_os_str().to_string_lossy())
        }
        Some(first) if path.is_dir() => sanitize_room(&first.as_os_str().to_string_lossy()),
        _ => "root".to_string(),
    }
}

/// The room captured agent sessions live in.
pub const SESSION_ROOM: &str = "session";

/// The room the record of a human review lives in.
pub const REVIEW_ROOM: &str = "review";

fn sanitize_room(segment: &str) -> String {
    let cleaned: String = segment
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();

    if cleaned.is_empty() {
        "root".to_string()
    } else {
        cleaned
    }
}

fn default_ingest_options<'a>() -> IngestOptions<'a> {
    IngestOptions {
        room: None,
        source_root: None,
        dry_run: false,
        source_file_override: None,
        replace_existing_source: false,
        replace_across_rooms: false,
        no_strip_noise: false,
        diary_rollup: false,
        diary_rollup_day: None,
        project_filter: Default::default(),
    }
}

/// Builds the drawer, then points it at this workspace.
///
/// The upstream constructor stamps the legacy repo anchor on everything it
/// makes. Material we assemble ourselves gets the real worktree anchor instead,
/// so the library can answer "where does this project live" — without at least
/// one such drawer, a project reports no path at all.
fn evidence_drawer(drawer_id: &str, evidence: &TextEvidence<'_>) -> Result<Drawer, WorkspaceError> {
    let derived =
        anchor::derive_anchor_from_cwd(Some(evidence.workspace_root)).map_err(|error| {
            WorkspaceError::new(
                "memory_unavailable",
                format!(
                    "failed to work out which project {} belongs to: {error}",
                    evidence.workspace_root.display()
                ),
            )
        })?;

    let drawer = Drawer::new_bootstrap_evidence(BootstrapEvidenceArgs {
        id: drawer_id.to_string(),
        content: evidence.content.clone(),
        wing: evidence.wing.to_string(),
        room: Some(evidence.room.to_string()),
        source_file: evidence.source_file.clone(),
        source_type: evidence.source_type.clone(),
        added_at: current_timestamp(),
        chunk_index: Some(0),
        importance: evidence.importance,
    });

    Ok(Drawer {
        anchor_kind: derived.anchor_kind,
        anchor_id: derived.anchor_id,
        parent_anchor_id: derived.parent_anchor_id,
        normalize_version: CURRENT_NORMALIZE_VERSION,
        ..drawer
    })
}

/// A source path for material that never was a file.
pub fn synthetic_source(kind: &str, identifier: &str) -> String {
    format!("memory://{kind}/{identifier}")
}

pub fn workspace_relative(workspace_root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::config::testing::with_scoped_home;
    use crate::memory::engine::{library_path, wing_for};

    /// A stand-in for the real model.
    ///
    /// Deterministic and offline: these tests are about identity, locking and
    /// anchors, none of which care what the vector contains, and downloading a
    /// few hundred megabytes to find that out would be absurd.
    struct FixedEmbedder;

    #[async_trait::async_trait]
    impl Embedder for FixedEmbedder {
        async fn embed(&self, texts: &[&str]) -> mempal_runtime::embed::Result<Vec<Vec<f32>>> {
            Ok(texts
                .iter()
                .map(|text| {
                    let seed = text.len() as f32;
                    vec![seed, seed / 2.0, 1.0, 0.5]
                })
                .collect())
        }

        fn dimensions(&self) -> usize {
            4
        }

        fn name(&self) -> &str {
            "fixed-test-embedder"
        }
    }

    fn open_library_for_test() -> Database {
        let path = library_path().expect("library path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        Database::open(&path).expect("open library")
    }

    fn text_evidence<'a>(root: &'a Path, wing: &'a str, content: &str) -> TextEvidence<'a> {
        TextEvidence {
            workspace_root: root,
            wing,
            room: SESSION_ROOM,
            content: content.to_string(),
            source_type: SourceType::Conversation,
            source_file: Some(synthetic_source("session", "abc123")),
            importance: 1,
        }
    }

    #[test]
    fn the_same_material_written_twice_is_stored_once() {
        with_scoped_home(|home| {
            let workspace = tempfile::tempdir().expect("workspace");
            let wing = wing_for(workspace.path()).expect("wing");
            let database = open_library_for_test();

            let first = write_text(
                &database,
                &FixedEmbedder,
                text_evidence(workspace.path(), &wing, "a decision worth keeping"),
            )
            .expect("first write");
            let second = write_text(
                &database,
                &FixedEmbedder,
                text_evidence(workspace.path(), &wing, "a decision worth keeping"),
            )
            .expect("second write");

            assert!(first.created);
            assert!(!second.created, "the second write must not duplicate");
            assert_eq!(first.drawer_id, second.drawer_id);
            assert_eq!(database.drawer_count().expect("count"), 1);
            // The library belongs under the application home, not beside the
            // workspace: one library serves every project.
            assert!(
                library_path().expect("path").starts_with(home.path()),
                "library escaped the application home"
            );
        });
    }

    #[test]
    fn concurrent_writers_of_the_same_material_still_store_it_once() {
        with_scoped_home(|_home| {
            let workspace = tempfile::tempdir().expect("workspace");
            let wing = wing_for(workspace.path()).expect("wing");
            // Create the file once up front so both threads open an existing
            // library rather than racing to migrate a new one.
            drop(open_library_for_test());

            let root = workspace.path().to_path_buf();
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let root = root.clone();
                    let wing = wing.clone();
                    std::thread::spawn(move || {
                        // Each writer holds its own connection, the way two
                        // windows or a sidecar would.
                        let database = open_library_for_test();
                        write_text(
                            &database,
                            &FixedEmbedder,
                            text_evidence(&root, &wing, "one truth, two writers"),
                        )
                    })
                })
                .collect();

            let results: Vec<_> = handles
                .into_iter()
                .map(|handle| handle.join().expect("thread"))
                .collect();

            for result in &results {
                assert!(result.is_ok(), "writer failed: {result:?}");
            }
            let created = results
                .iter()
                .filter(|result| {
                    result
                        .as_ref()
                        .map(|written| written.created)
                        .unwrap_or(false)
                })
                .count();
            assert_eq!(created, 1, "exactly one writer should have created it");

            let database = open_library_for_test();
            assert_eq!(database.drawer_count().expect("count"), 1);
        });
    }

    #[test]
    fn material_we_assemble_carries_the_worktree_anchor() {
        with_scoped_home(|_home| {
            let workspace = tempfile::tempdir().expect("workspace");
            let wing = wing_for(workspace.path()).expect("wing");
            let database = open_library_for_test();

            let written = write_text(
                &database,
                &FixedEmbedder,
                text_evidence(workspace.path(), &wing, "anchored to this project"),
            )
            .expect("write");

            let drawer = database
                .get_drawer(&written.drawer_id)
                .expect("lookup")
                .expect("stored");
            assert!(
                drawer.anchor_id.starts_with("worktree://"),
                "anchor was {}",
                drawer.anchor_id
            );

            // The project listing can only report a path when some drawer
            // carries a worktree anchor, which is the whole reason for the
            // override.
            let projects = mempal_runtime::projects::list_projects(&database).expect("projects");
            let project = projects
                .iter()
                .find(|project| project.wing == wing)
                .expect("this project is listed");
            assert!(project.path.is_some(), "project path was not recoverable");
        });
    }

    #[test]
    fn empty_material_is_refused() {
        with_scoped_home(|_home| {
            let workspace = tempfile::tempdir().expect("workspace");
            let wing = wing_for(workspace.path()).expect("wing");
            let database = open_library_for_test();

            let error = write_text(
                &database,
                &FixedEmbedder,
                text_evidence(workspace.path(), &wing, "   \n  "),
            )
            .expect_err("must refuse");

            assert_eq!(error.error_code(), "invalid_evidence");
            assert_eq!(database.drawer_count().expect("count"), 0);
        });
    }

    #[test]
    fn removing_material_hides_it_and_purging_erases_it() {
        with_scoped_home(|_home| {
            let workspace = tempfile::tempdir().expect("workspace");
            let wing = wing_for(workspace.path()).expect("wing");
            let database = open_library_for_test();
            let written = write_text(
                &database,
                &FixedEmbedder,
                text_evidence(workspace.path(), &wing, "captured by mistake"),
            )
            .expect("write");

            assert!(soft_delete(&database, &written.drawer_id).expect("soft delete"));
            assert_eq!(
                database.all_active_drawers().expect("active").len(),
                0,
                "a removed entry is not active any more"
            );

            let purged = purge(&database, None).expect("purge");

            assert_eq!(purged, 1);
            assert!(database
                .get_drawer(&written.drawer_id)
                .expect("lookup")
                .is_none());
        });
    }

    #[test]
    fn a_file_keeps_the_path_it_came_from() {
        with_scoped_home(|_home| {
            let workspace = tempfile::tempdir().expect("workspace");
            let wing = wing_for(workspace.path()).expect("wing");
            let notes = workspace.path().join("notes");
            std::fs::create_dir_all(&notes).expect("mkdir");
            let file = notes.join("decision.md");
            std::fs::write(&file, "# Decision\n\nWe chose the embedded subset.\n").expect("write");
            let database = open_library_for_test();

            let outcome = ingest_file(
                &database,
                &FixedEmbedder,
                workspace.path(),
                &wing,
                &file,
                None,
            )
            .expect("ingest");

            assert_eq!(outcome.files, 1);
            assert!(outcome.chunks >= 1);
            assert_eq!(outcome.room, "notes");
            let (_, content) = database
                .all_active_drawers()
                .expect("drawers")
                .into_iter()
                .next()
                .expect("one drawer");
            assert!(content.contains("embedded subset"), "{content}");
        });
    }

    #[test]
    fn lark_exports_are_decoded_before_embedding_and_keep_their_source() {
        with_scoped_home(|_home| {
            let root = tempfile::tempdir().unwrap();
            let database = open_library_for_test();
            let file = root.path().join("export.json");
            let raw = r#"{"ok":true,"data":{"doc_id":"doc-id","markdown":"标题\n\u003clark-table\u003e<lark-tr><lark-td>字段</lark-td><lark-td>值</lark-td></lark-tr></lark-table>"}}"#;
            std::fs::write(&file, raw).unwrap();
            let first =
                ingest_file(&database, &FixedEmbedder, root.path(), "test", &file, None).unwrap();
            let second =
                ingest_file(&database, &FixedEmbedder, root.path(), "test", &file, None).unwrap();
            assert_eq!(first.chunks, 1);
            assert_eq!(second.chunks, 0);
            let rows = database.all_active_drawers().unwrap();
            assert_eq!(rows.len(), 1);
            let item = database.get_drawer(&rows[0].0).unwrap().unwrap();
            assert_eq!(item.source_file.as_deref(), Some("export.json"));
            assert!(item.content.contains("| 字段 | 值 |"), "{}", item.content);
            assert!(!item.content.contains("lark-"));
            assert_eq!(std::fs::read_to_string(file).unwrap(), raw);
        });
    }

    #[test]
    fn directory_ingest_uses_the_same_normalizer_and_preserves_upstream_filters() {
        with_scoped_home(|_home| {
            let root = tempfile::tempdir().unwrap();
            let database = open_library_for_test();
            for (name, content) in [
                (
                    "export.json",
                    r#"{"ok":true,"data":{"doc_id":"d","markdown":"正文\n第二行"}}"#,
                ),
                ("code.json", r#"{"path":"C:\\new"}"#),
                (".gitignore", "ignored.json\n"),
                (".mempalignore", "private.json\n"),
                ("ignored.json", "ignored"),
                ("private.json", "private"),
                ("photo.png", "binary"),
                ("._junk", "metadata"),
            ] {
                std::fs::write(root.path().join(name), content).unwrap();
            }
            let outcome =
                ingest_directory(&database, &FixedEmbedder, root.path(), "test", root.path())
                    .unwrap();
            assert_eq!(outcome.files, 2);
            let rows = database.all_active_drawers().unwrap();
            assert_eq!(rows.len(), 2);
            assert!(rows.iter().any(|(_, text)| text == "正文\n第二行"));
            assert!(rows.iter().any(|(_, text)| text == r#"{"path":"C:\\new"}"#));
            let other = tempfile::tempdir().unwrap();
            let upstream = Database::open(&other.path().join("db")).unwrap();
            let original = block_on(mempal_runtime::ingest::ingest_dir_with_options(
                &upstream,
                &FixedEmbedder,
                root.path(),
                "test",
                default_ingest_options(),
            ))
            .unwrap();
            assert_eq!(
                (outcome.files, outcome.skipped),
                (original.files, original.skipped)
            );
        });
    }

    #[test]
    fn failed_lark_export_writes_nothing() {
        with_scoped_home(|_home| {
            let root = tempfile::tempdir().unwrap();
            let database = open_library_for_test();
            let file = root.path().join("failed.json");
            std::fs::write(
                &file,
                r#"{"ok":false,"data":{"doc_id":"d","markdown":"error"}}"#,
            )
            .unwrap();
            assert_eq!(
                ingest_file(&database, &FixedEmbedder, root.path(), "test", &file, None)
                    .unwrap_err()
                    .error_code(),
                "invalid_evidence"
            );
            assert!(database.all_active_drawers().unwrap().is_empty());
        });
    }

    #[test]
    fn rooms_follow_the_first_directory_under_the_workspace() {
        let root = Path::new("/tmp/workspace");

        assert_eq!(room_for(root, &root.join("raw/notes/a.md")), "raw");
        assert_eq!(room_for(root, &root.join("README.md")), "root");
        assert_eq!(room_for(root, &root.join("Wiki Pages/a.md")), "wiki-pages");
    }
}
