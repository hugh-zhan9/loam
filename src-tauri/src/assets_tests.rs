use tempfile::tempdir;

use crate::assets::{
    load_image_asset, load_image_asset_with_global_assets_dir,
    save_document_image_asset_with_global_assets_dir, save_image_asset,
    save_image_asset_with_global_assets_dir,
};

#[test]
fn saves_workspace_asset_once_for_identical_bytes() {
    let root = tempdir().unwrap();
    let bytes = vec![1, 2, 3, 4];

    let first = save_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        None,
        "paste.png".to_string(),
        bytes.clone(),
    )
    .unwrap();
    let second = save_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        None,
        "paste.png".to_string(),
        bytes,
    )
    .unwrap();

    assert_eq!(first.markdown_path, second.markdown_path);
    assert_eq!(first.stored_path, second.stored_path);

    let asset_count = root.path().join(".assets").read_dir().unwrap().count();
    assert_eq!(asset_count, 1);
}

#[test]
fn saves_workspace_asset_when_stale_predictable_temp_file_exists() {
    let root = tempdir().unwrap();
    let bytes = vec![1, 2, 3, 4];
    let filename = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png";
    let assets_dir = root.path().join(".assets");
    std::fs::create_dir(&assets_dir).unwrap();
    std::fs::write(
        assets_dir.join(format!(".{filename}.tmp.{}", std::process::id())),
        b"stale",
    )
    .unwrap();

    let result = save_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        None,
        "paste.png".to_string(),
        bytes.clone(),
    )
    .unwrap();

    assert_eq!(result.markdown_path, format!(".assets/{filename}"));
    assert_eq!(
        std::fs::read(root.path().join(&result.markdown_path)).unwrap(),
        bytes
    );
}

#[test]
fn workspace_asset_link_climbs_back_to_the_root_from_a_subdirectory() {
    let root = tempdir().unwrap();
    let filename = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png";
    let bytes = vec![1, 2, 3, 4];
    let document_dir = root.path().join("docs").join("loopx").join("plans");
    std::fs::create_dir_all(&document_dir).unwrap();
    let document_path = document_dir.join("Untitled.md");
    std::fs::write(&document_path, "").unwrap();

    let saved = save_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some(document_path.to_string_lossy().into_owned()),
        "paste.png".to_string(),
        bytes.clone(),
    )
    .unwrap();

    assert!(!saved.used_fallback);
    assert_eq!(saved.markdown_path, format!("../../../.assets/{filename}"));
    assert_eq!(
        std::fs::canonicalize(&saved.stored_path).unwrap(),
        std::fs::canonicalize(root.path().join(".assets").join(filename)).unwrap()
    );

    // Read the link back as plain text against the document's own directory.
    // Going through load_image_asset alone would only prove the two sides run
    // the same helper, not that the link points where it says it does.
    assert_eq!(
        std::fs::read(document_dir.join(&saved.markdown_path)).unwrap(),
        bytes
    );

    let loaded = load_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some(document_path.to_string_lossy().into_owned()),
        saved.markdown_path,
    )
    .unwrap();

    assert_eq!(loaded.bytes, bytes);
}

/// One level down is the ordinary layout, and `current_file_path` may arrive
/// relative to the root rather than absolute.
#[test]
fn workspace_asset_link_climbs_one_level_for_a_relative_current_file_path() {
    let root = tempdir().unwrap();
    let filename = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png";
    let bytes = vec![1, 2, 3, 4];
    let document_dir = root.path().join("notes");
    std::fs::create_dir(&document_dir).unwrap();
    std::fs::write(document_dir.join("doc.md"), "").unwrap();

    let saved = save_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some("notes/doc.md".to_string()),
        "paste.png".to_string(),
        bytes.clone(),
    )
    .unwrap();

    assert!(!saved.used_fallback);
    assert_eq!(saved.markdown_path, format!("../.assets/{filename}"));
    assert_eq!(
        std::fs::read(document_dir.join(&saved.markdown_path)).unwrap(),
        bytes
    );

    let loaded = load_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some("notes/doc.md".to_string()),
        saved.markdown_path,
    )
    .unwrap();

    assert_eq!(loaded.bytes, bytes);
}

#[test]
fn workspace_asset_link_stays_bare_for_a_document_at_the_root() {
    let root = tempdir().unwrap();
    let filename = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png";
    let document_path = root.path().join("doc.md");
    std::fs::write(&document_path, "# Doc").unwrap();

    let saved = save_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some(document_path.to_string_lossy().into_owned()),
        "paste.png".to_string(),
        vec![1, 2, 3, 4],
    )
    .unwrap();

    assert!(!saved.used_fallback);
    assert_eq!(saved.markdown_path, format!(".assets/{filename}"));
}

#[test]
fn falls_back_to_global_assets_for_a_document_outside_the_workspace_root() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let document_path = outside.path().join("doc.md");
    std::fs::write(&document_path, "# Doc").unwrap();
    let global_assets_dir = tempdir().unwrap();

    let saved = save_image_asset_with_global_assets_dir(
        Some(root.path().to_string_lossy().into_owned()),
        Some(document_path.to_string_lossy().into_owned()),
        "paste.png".to_string(),
        vec![1, 2, 3, 4],
        global_assets_dir.path(),
    )
    .unwrap();

    assert!(saved.used_fallback);
    assert!(std::path::Path::new(&saved.markdown_path).is_absolute());
    assert!(!root.path().join(".assets").exists());
}

#[test]
fn falls_back_to_global_assets_without_workspace_root() {
    let global_assets_dir = tempdir().unwrap();
    let result = save_image_asset_with_global_assets_dir(
        None,
        None,
        "paste.png".to_string(),
        vec![9, 8, 7],
        global_assets_dir.path(),
    )
    .unwrap();

    assert!(result.used_fallback);
    assert!(!result.markdown_path.starts_with(".assets/"));
    assert!(std::path::Path::new(&result.markdown_path).is_absolute());
    assert!(result.markdown_path.ends_with(".png"));
    assert_eq!(result.markdown_path, result.stored_path);
    assert!(std::path::Path::new(&result.stored_path).exists());
}

#[test]
#[cfg(unix)]
fn falls_back_when_workspace_assets_is_a_symlink() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    symlink(outside.path(), root.path().join(".assets")).unwrap();

    let global_assets_dir = tempdir().unwrap();
    let result = save_image_asset_with_global_assets_dir(
        Some(root.path().to_string_lossy().into_owned()),
        None,
        "paste.png".to_string(),
        vec![1, 2, 3, 4],
        global_assets_dir.path(),
    )
    .unwrap();

    assert!(result.used_fallback);
    let global_assets_dir_path = std::fs::canonicalize(global_assets_dir.path()).unwrap();
    assert!(result
        .markdown_path
        .starts_with(global_assets_dir_path.to_string_lossy().as_ref()));
    assert!(global_assets_dir
        .path()
        .join(result.stored_path.rsplit('/').next().unwrap())
        .exists());
    assert!(outside.path().read_dir().unwrap().next().is_none());
}

#[test]
fn loads_allowed_workspace_asset_image() {
    let root = tempdir().unwrap();
    let asset_dir = root.path().join(".assets");
    std::fs::create_dir(&asset_dir).unwrap();
    let asset_path = asset_dir.join("abc123.png");
    std::fs::write(&asset_path, [1, 2, 3, 4]).unwrap();
    let doc_path = root.path().join("doc.md");
    std::fs::write(&doc_path, "# Doc").unwrap();

    let loaded = load_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some(doc_path.to_string_lossy().into_owned()),
        ".assets/abc123.png".to_string(),
    )
    .unwrap();

    assert_eq!(loaded.mime_type, "image/png");
    assert_eq!(loaded.bytes, vec![1, 2, 3, 4]);
    assert_eq!(
        loaded.path,
        std::fs::canonicalize(asset_path).unwrap().to_string_lossy()
    );
}

#[test]
fn rejects_traversal_outside_workspace_for_image_loading() {
    let root = tempdir().unwrap();
    let subdir = root.path().join("docs");
    std::fs::create_dir(&subdir).unwrap();
    let doc_path = subdir.join("doc.md");
    std::fs::write(&doc_path, "# Doc").unwrap();

    let err = load_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some(doc_path.to_string_lossy().into_owned()),
        "../../../escape.png".to_string(),
    )
    .unwrap_err();

    assert_eq!(err.error_code(), "outside_workspace");
}

#[test]
fn rejects_absolute_outside_image_loading() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let outside_file = outside.path().join("escape.png");
    std::fs::write(&outside_file, [9, 8, 7]).unwrap();
    let doc_path = root.path().join("doc.md");
    std::fs::write(&doc_path, "# Doc").unwrap();

    let err = load_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some(doc_path.to_string_lossy().into_owned()),
        outside_file.to_string_lossy().into_owned(),
    )
    .unwrap_err();

    assert_eq!(err.error_code(), "outside_workspace");
}

#[test]
fn rejects_non_image_extensions() {
    let root = tempdir().unwrap();
    let doc_path = root.path().join("doc.md");
    std::fs::write(&doc_path, "# Doc").unwrap();

    let err = load_image_asset(
        Some(root.path().to_string_lossy().into_owned()),
        Some(doc_path.to_string_lossy().into_owned()),
        ".assets/not-image.txt".to_string(),
    )
    .unwrap_err();

    assert_eq!(err.error_code(), "invalid_name");
}

#[test]
fn loads_image_from_global_assets_directory() {
    let global_assets_dir = tempdir().unwrap();
    let asset_path = global_assets_dir.path().join("abc123.png");
    std::fs::write(&asset_path, [7, 6, 5]).unwrap();

    let loaded = load_image_asset_with_global_assets_dir(
        None,
        None,
        asset_path.to_string_lossy().into_owned(),
        global_assets_dir.path(),
    )
    .unwrap();

    assert_eq!(loaded.mime_type, "image/png");
    assert_eq!(loaded.bytes, vec![7, 6, 5]);
    assert_eq!(
        loaded.path,
        std::fs::canonicalize(asset_path).unwrap().to_string_lossy()
    );
}

#[test]
#[cfg(unix)]
fn rejects_symlinked_global_assets_directory_on_save() {
    use std::os::unix::fs::symlink;

    let home = tempdir().unwrap();
    let loam_home = home.path().join(".loam");
    let outside = tempdir().unwrap();
    std::fs::create_dir(&loam_home).unwrap();
    symlink(outside.path(), loam_home.join("assets")).unwrap();

    let err = save_image_asset_with_global_assets_dir(
        None,
        None,
        "paste.png".to_string(),
        vec![1, 2, 3],
        &loam_home.join("assets"),
    )
    .unwrap_err();

    assert_eq!(err.error_code(), "outside_workspace");
    assert!(outside.path().read_dir().unwrap().next().is_none());
}

#[test]
#[cfg(unix)]
fn rejects_symlinked_global_assets_directory_on_load() {
    use std::os::unix::fs::symlink;

    let home = tempdir().unwrap();
    let loam_home = home.path().join(".loam");
    let outside = tempdir().unwrap();
    std::fs::create_dir(&loam_home).unwrap();
    symlink(outside.path(), loam_home.join("assets")).unwrap();
    let symlinked_image = loam_home.join("assets").join("abc123.png");
    std::fs::write(outside.path().join("abc123.png"), [9, 9, 9]).unwrap();

    let err = load_image_asset_with_global_assets_dir(
        None,
        None,
        symlinked_image.to_string_lossy().into_owned(),
        &loam_home.join("assets"),
    )
    .unwrap_err();

    assert_eq!(err.error_code(), "outside_workspace");
}

#[test]
fn save_document_image_asset_prefers_sibling_assets_directory() {
    let root = tempdir().unwrap();
    let document = root.path().join("Note.md");
    std::fs::write(&document, "# Note\n").unwrap();
    let global_assets_dir = tempdir().unwrap();

    let result = save_document_image_asset_with_global_assets_dir(
        document.to_string_lossy().into_owned(),
        "image.png".to_string(),
        vec![1, 2, 3],
        global_assets_dir.path(),
    )
    .unwrap();

    assert!(!result.used_fallback);
    assert!(result.markdown_path.starts_with(".assets/"));
    assert!(root.path().join(&result.markdown_path).is_file());
    assert!(global_assets_dir
        .path()
        .read_dir()
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn save_document_image_asset_falls_back_when_document_parent_is_missing() {
    let root = tempdir().unwrap();
    let missing_document = root.path().join("missing").join("Note.md");
    let global_assets_dir = tempdir().unwrap();

    let result = save_document_image_asset_with_global_assets_dir(
        missing_document.to_string_lossy().into_owned(),
        "image.png".to_string(),
        vec![1, 2, 3],
        global_assets_dir.path(),
    )
    .unwrap();

    assert!(result.used_fallback);
    assert!(std::path::Path::new(&result.markdown_path).is_absolute());
    assert!(std::path::Path::new(&result.stored_path).is_file());
}

#[test]
#[cfg(unix)]
fn save_document_image_asset_falls_back_when_sibling_assets_is_a_symlink() {
    use std::os::unix::fs::symlink;

    let root = tempdir().unwrap();
    let document = root.path().join("Note.md");
    std::fs::write(&document, "# Note\n").unwrap();
    let outside = tempdir().unwrap();
    symlink(outside.path(), root.path().join(".assets")).unwrap();
    let global_assets_dir = tempdir().unwrap();

    let result = save_document_image_asset_with_global_assets_dir(
        document.to_string_lossy().into_owned(),
        "image.png".to_string(),
        vec![1, 2, 3],
        global_assets_dir.path(),
    )
    .unwrap();

    assert!(result.used_fallback);
    assert!(std::path::Path::new(&result.markdown_path).is_absolute());
    assert!(outside.path().read_dir().unwrap().next().is_none());
}

#[test]
fn loads_document_sibling_asset_without_workspace_root() {
    let root = tempdir().unwrap();
    let document = root.path().join("Note.md");
    std::fs::write(&document, "# Note\n").unwrap();
    let asset_dir = root.path().join(".assets");
    std::fs::create_dir(&asset_dir).unwrap();
    let asset_path = asset_dir.join("abc123.png");
    std::fs::write(&asset_path, [1, 2, 3, 4]).unwrap();

    let loaded = load_image_asset(
        None,
        Some(document.to_string_lossy().into_owned()),
        ".assets/abc123.png".to_string(),
    )
    .unwrap();

    assert_eq!(loaded.mime_type, "image/png");
    assert_eq!(loaded.bytes, vec![1, 2, 3, 4]);
    assert_eq!(
        loaded.path,
        std::fs::canonicalize(asset_path).unwrap().to_string_lossy()
    );
}
