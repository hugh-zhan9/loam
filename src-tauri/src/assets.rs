use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::Builder as TempFileBuilder;

use crate::models::WorkspaceError;
use crate::path_guard::canonicalize_workspace_root;

pub(crate) const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tiff",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveImageAssetResult {
    pub markdown_path: String,
    pub stored_path: String,
    pub used_fallback: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoadImageAssetResult {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub path: String,
}

#[tauri::command]
pub fn save_image_asset(
    root_path: Option<String>,
    current_file_path: Option<String>,
    name: String,
    bytes: Vec<u8>,
) -> Result<SaveImageAssetResult, WorkspaceError> {
    save_image_asset_impl(root_path, current_file_path, name, bytes, None)
}

#[tauri::command]
pub fn save_document_image_asset(
    document_path: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<SaveImageAssetResult, WorkspaceError> {
    save_document_image_asset_impl(document_path, name, bytes, None)
}

fn save_image_asset_impl(
    root_path: Option<String>,
    current_file_path: Option<String>,
    name: String,
    bytes: Vec<u8>,
    global_assets_dir: Option<&Path>,
) -> Result<SaveImageAssetResult, WorkspaceError> {
    let extension = image_extension(&name)?;
    let filename = format!("{}.{}", sha256_hex(&bytes), extension);

    if let Some(root_path) = root_path {
        if let Ok(result) =
            save_workspace_asset(&root_path, current_file_path.as_deref(), &filename, &bytes)
        {
            return Ok(result);
        }
    }

    save_global_asset(&filename, &bytes, global_assets_dir)
}

fn save_document_image_asset_impl(
    document_path: String,
    name: String,
    bytes: Vec<u8>,
    global_assets_dir: Option<&Path>,
) -> Result<SaveImageAssetResult, WorkspaceError> {
    let extension = image_extension(&name)?;
    let filename = format!("{}.{}", sha256_hex(&bytes), extension);

    if let Ok(result) = save_document_sibling_asset(&document_path, &filename, &bytes) {
        return Ok(result);
    }

    save_global_asset(&filename, &bytes, global_assets_dir)
}

#[cfg(test)]
pub fn save_image_asset_with_global_assets_dir(
    root_path: Option<String>,
    current_file_path: Option<String>,
    name: String,
    bytes: Vec<u8>,
    global_assets_dir: &Path,
) -> Result<SaveImageAssetResult, WorkspaceError> {
    save_image_asset_impl(
        root_path,
        current_file_path,
        name,
        bytes,
        Some(global_assets_dir),
    )
}

#[cfg(test)]
pub fn save_document_image_asset_with_global_assets_dir(
    document_path: String,
    name: String,
    bytes: Vec<u8>,
    global_assets_dir: &Path,
) -> Result<SaveImageAssetResult, WorkspaceError> {
    save_document_image_asset_impl(document_path, name, bytes, Some(global_assets_dir))
}

#[tauri::command]
pub fn load_image_asset(
    root_path: Option<String>,
    current_file_path: Option<String>,
    src: String,
) -> Result<LoadImageAssetResult, WorkspaceError> {
    load_image_asset_impl(root_path, current_file_path, src, None)
}

fn load_image_asset_impl(
    root_path: Option<String>,
    current_file_path: Option<String>,
    src: String,
    global_assets_dir: Option<&Path>,
) -> Result<LoadImageAssetResult, WorkspaceError> {
    let image_extension = image_extension(&src)?;
    let src_path = Path::new(&src);
    let root = root_path
        .as_deref()
        .map(canonicalize_workspace_root)
        .transpose()?;
    let document_asset_parent = if root.is_none() && !src_path.is_absolute() {
        Some(canonical_document_asset_parent(
            current_file_path.as_deref(),
        )?)
    } else {
        None
    };
    let candidate = resolve_image_candidate(root.as_deref(), current_file_path.as_deref(), &src)?;
    let image_path = fs::canonicalize(&candidate).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            "not_found"
        } else {
            "read_failed"
        };
        WorkspaceError::from_io(code, "failed to resolve image asset", &error)
    })?;

    if !path_is_allowed_image_location(
        &image_path,
        root.as_deref(),
        document_asset_parent.as_deref(),
        global_assets_dir,
    )? {
        return Err(WorkspaceError::new(
            "outside_workspace",
            "image asset is outside the workspace and global assets directory",
        ));
    }

    let bytes = fs::read(&image_path).map_err(|error| {
        WorkspaceError::from_io("read_failed", "failed to read image asset", &error)
    })?;

    Ok(LoadImageAssetResult {
        bytes,
        mime_type: mime_type_for_extension(&image_extension).to_string(),
        path: path_to_string(&image_path),
    })
}

#[cfg(test)]
pub fn load_image_asset_with_global_assets_dir(
    root_path: Option<String>,
    current_file_path: Option<String>,
    src: String,
    global_assets_dir: &Path,
) -> Result<LoadImageAssetResult, WorkspaceError> {
    load_image_asset_impl(root_path, current_file_path, src, Some(global_assets_dir))
}

fn save_workspace_asset(
    root_path: &str,
    current_file_path: Option<&str>,
    filename: &str,
    bytes: &[u8],
) -> Result<SaveImageAssetResult, WorkspaceError> {
    let root = canonicalize_workspace_root(root_path)?;
    // Settle the link before creating anything: a document this workspace
    // cannot write a link for should not leave an assets directory behind.
    let document_dir = current_file_path
        .map(|current_file_path| canonical_workspace_document_dir(&root, current_file_path))
        .transpose()?;
    let markdown_path = workspace_asset_markdown_path(&root, document_dir.as_deref(), filename)?;
    let assets_dir = ensure_workspace_assets_dir(&root)?;
    let stored_path = write_deduped_asset(&assets_dir, filename, bytes)?;

    Ok(SaveImageAssetResult {
        markdown_path,
        stored_path: path_to_string(&stored_path),
        used_fallback: false,
    })
}

/// The link written into the document for an asset stored at the workspace root.
///
/// A workspace keeps one `.assets` directory, at the root, but loading resolves
/// a relative link against the directory of the file that names it. A document
/// in a subdirectory therefore has to climb back out to the root, or the link
/// it was handed points at a directory that does not exist.
fn workspace_asset_markdown_path(
    root: &Path,
    document_dir: Option<&Path>,
    filename: &str,
) -> Result<String, WorkspaceError> {
    let depth = match document_dir {
        Some(document_dir) => document_dir
            .strip_prefix(root)
            .map_err(|_| {
                WorkspaceError::new(
                    "outside_workspace",
                    "current file path is outside the workspace root",
                )
            })?
            .components()
            .count(),
        None => 0,
    };

    let mut markdown_path = String::new();
    for _ in 0..depth {
        markdown_path.push_str("../");
    }
    markdown_path.push_str(".assets/");
    markdown_path.push_str(filename);

    Ok(markdown_path)
}

fn save_document_sibling_asset(
    document_path: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<SaveImageAssetResult, WorkspaceError> {
    let document_path = Path::new(document_path);
    let parent = document_path
        .parent()
        .ok_or_else(|| WorkspaceError::new("asset_path_failed", "document path has no parent"))?;
    let parent = fs::canonicalize(parent).map_err(|error| {
        WorkspaceError::from_io(
            "asset_write_failed",
            "failed to resolve document asset parent directory",
            &error,
        )
    })?;
    let assets_dir = ensure_assets_dir_under_parent(&parent, ".assets")?;
    let stored_path = write_deduped_asset(&assets_dir, filename, bytes)?;

    Ok(SaveImageAssetResult {
        markdown_path: format!(".assets/{filename}"),
        stored_path: path_to_string(&stored_path),
        used_fallback: false,
    })
}

fn save_global_asset(
    filename: &str,
    bytes: &[u8],
    global_assets_dir: Option<&Path>,
) -> Result<SaveImageAssetResult, WorkspaceError> {
    let assets_dir = ensure_global_assets_dir(global_assets_dir, true)?;
    let stored_path = write_deduped_asset(&assets_dir, filename, bytes)?;
    let stored_path = path_to_string(&stored_path);

    Ok(SaveImageAssetResult {
        markdown_path: stored_path.clone(),
        stored_path,
        used_fallback: true,
    })
}

fn ensure_workspace_assets_dir(root: &Path) -> Result<PathBuf, WorkspaceError> {
    ensure_assets_dir_under_parent(root, ".assets")
}

fn ensure_assets_dir_under_parent(parent: &Path, dirname: &str) -> Result<PathBuf, WorkspaceError> {
    let assets_dir = parent.join(dirname);

    match fs::symlink_metadata(&assets_dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(WorkspaceError::new(
                    "outside_workspace",
                    "workspace assets directory cannot be a symlink",
                ));
            }
            if !metadata.is_dir() {
                return Err(WorkspaceError::new(
                    "not_directory",
                    "workspace assets path is not a directory",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&assets_dir).map_err(|error| {
                WorkspaceError::from_io(
                    "asset_write_failed",
                    "failed to create assets directory",
                    &error,
                )
            })?;
        }
        Err(error) => {
            return Err(WorkspaceError::from_io(
                "asset_write_failed",
                "failed to inspect assets directory",
                &error,
            ));
        }
    }

    let assets_dir = fs::canonicalize(&assets_dir).map_err(|error| {
        WorkspaceError::from_io(
            "asset_write_failed",
            "failed to resolve assets directory",
            &error,
        )
    })?;
    if !assets_dir.starts_with(parent) {
        return Err(WorkspaceError::new(
            "outside_workspace",
            "assets directory escapes the expected parent directory",
        ));
    }

    Ok(assets_dir)
}

fn ensure_global_assets_dir(
    global_assets_dir: Option<&Path>,
    create: bool,
) -> Result<PathBuf, WorkspaceError> {
    let assets_dir = match global_assets_dir {
        Some(path) => path.to_path_buf(),
        None => loam_home_dir()?.join("assets"),
    };
    let loam_home = assets_dir.parent().ok_or_else(|| {
        WorkspaceError::new("asset_path_failed", "global assets directory has no parent")
    })?;

    fs::create_dir_all(loam_home).map_err(|error| {
        WorkspaceError::from_io(
            "asset_write_failed",
            "failed to create global assets parent directory",
            &error,
        )
    })?;
    let loam_home = fs::canonicalize(loam_home).map_err(|error| {
        WorkspaceError::from_io(
            "asset_path_failed",
            "failed to resolve global assets parent directory",
            &error,
        )
    })?;

    match fs::symlink_metadata(&assets_dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(WorkspaceError::new(
                    "outside_workspace",
                    "global assets directory cannot be a symlink",
                ));
            }
            if !metadata.is_dir() {
                return Err(WorkspaceError::new(
                    "not_directory",
                    "global assets path is not a directory",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            fs::create_dir(&assets_dir).map_err(|error| {
                WorkspaceError::from_io(
                    "asset_write_failed",
                    "failed to create global assets directory",
                    &error,
                )
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(WorkspaceError::from_io(
                "not_found",
                "global assets directory does not exist",
                &error,
            ));
        }
        Err(error) => {
            return Err(WorkspaceError::from_io(
                "asset_path_failed",
                "failed to inspect global assets directory",
                &error,
            ));
        }
    }

    let assets_dir = fs::canonicalize(&assets_dir).map_err(|error| {
        WorkspaceError::from_io(
            "asset_path_failed",
            "failed to resolve global assets directory",
            &error,
        )
    })?;
    if !assets_dir.starts_with(&loam_home) {
        return Err(WorkspaceError::new(
            "outside_workspace",
            "global assets directory escapes the .mdx directory",
        ));
    }

    Ok(assets_dir)
}

pub(crate) fn write_deduped_asset(
    assets_dir: &Path,
    filename: &str,
    bytes: &[u8],
) -> Result<PathBuf, WorkspaceError> {
    fs::create_dir_all(assets_dir).map_err(|error| {
        WorkspaceError::from_io(
            "asset_write_failed",
            "failed to create assets directory",
            &error,
        )
    })?;

    let path = assets_dir.join(filename);
    if path.exists() {
        return Ok(path);
    }

    let mut temp_file = TempFileBuilder::new()
        .prefix(&format!(".{filename}.tmp-"))
        .tempfile_in(assets_dir)
        .map_err(|error| {
            WorkspaceError::from_io(
                "asset_write_failed",
                "failed to create temporary image asset",
                &error,
            )
        })?;
    temp_file.write_all(bytes).map_err(|error| {
        WorkspaceError::from_io(
            "asset_write_failed",
            "failed to write temporary image asset",
            &error,
        )
    })?;
    temp_file.flush().map_err(|error| {
        WorkspaceError::from_io(
            "asset_write_failed",
            "failed to flush temporary image asset",
            &error,
        )
    })?;
    temp_file.as_file().sync_all().map_err(|error| {
        WorkspaceError::from_io(
            "asset_write_failed",
            "failed to sync temporary image asset",
            &error,
        )
    })?;

    match temp_file.persist_noclobber(&path) {
        Ok(_) => Ok(path),
        Err(error) if path.exists() => Ok(path),
        Err(error) => Err(WorkspaceError::new(
            "asset_write_failed",
            format!("failed to store image asset: {}", error.error),
        )),
    }
}

pub(crate) fn image_extension(name: &str) -> Result<String, WorkspaceError> {
    let extension = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| WorkspaceError::new("invalid_name", "image asset needs a file extension"))?;

    if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        Ok(extension)
    } else {
        Err(WorkspaceError::new(
            "invalid_name",
            "unsupported image asset extension",
        ))
    }
}

fn resolve_image_candidate(
    root: Option<&Path>,
    current_file_path: Option<&str>,
    src: &str,
) -> Result<PathBuf, WorkspaceError> {
    let src_path = Path::new(src);
    if src_path.is_absolute() {
        return Ok(src_path.to_path_buf());
    }

    let current_file_path = current_file_path.ok_or_else(|| {
        WorkspaceError::new(
            "outside_workspace",
            "current file path is required for relative image assets",
        )
    })?;

    let current_dir = if let Some(root) = root {
        canonical_workspace_document_dir(root, current_file_path)?
    } else {
        canonical_document_asset_parent(Some(current_file_path))?
    };

    let candidate = current_dir.join(src_path);
    let allowed_parent = root.unwrap_or(current_dir.as_path());
    if !normalize_path_lexically(&candidate).starts_with(allowed_parent) {
        return Err(WorkspaceError::new(
            "outside_workspace",
            "image asset path escapes the allowed image directory",
        ));
    }

    Ok(candidate)
}

/// The directory a relative asset link in a workspace document resolves against.
///
/// Saving and loading an asset both need this, and they need the same answer:
/// the whole point of the link is that the two agree on where it points.
fn canonical_workspace_document_dir(
    root: &Path,
    current_file_path: &str,
) -> Result<PathBuf, WorkspaceError> {
    let current_path = Path::new(current_file_path);
    let current_path = if current_path.is_absolute() {
        current_path.to_path_buf()
    } else {
        root.join(current_path)
    };
    let current_dir = current_path.parent().ok_or_else(|| {
        WorkspaceError::new("outside_workspace", "current file path has no parent")
    })?;
    let current_dir = fs::canonicalize(current_dir).map_err(|error| {
        WorkspaceError::from_io(
            "outside_workspace",
            "failed to resolve current file directory",
            &error,
        )
    })?;

    if !current_dir.starts_with(root) {
        return Err(WorkspaceError::new(
            "outside_workspace",
            "current file path is outside the workspace root",
        ));
    }

    Ok(current_dir)
}

fn canonical_document_asset_parent(
    current_file_path: Option<&str>,
) -> Result<PathBuf, WorkspaceError> {
    let current_file_path = current_file_path.ok_or_else(|| {
        WorkspaceError::new(
            "outside_workspace",
            "current file path is required for relative image assets",
        )
    })?;
    let current_path = Path::new(current_file_path);
    if !current_path.is_absolute() {
        return Err(WorkspaceError::new(
            "outside_workspace",
            "document image assets require an absolute current file path",
        ));
    }
    let current_dir = current_path.parent().ok_or_else(|| {
        WorkspaceError::new("outside_workspace", "current file path has no parent")
    })?;
    let current_dir = fs::canonicalize(current_dir).map_err(|error| {
        WorkspaceError::from_io(
            "outside_workspace",
            "failed to resolve current file directory",
            &error,
        )
    })?;
    Ok(current_dir)
}

fn path_is_allowed_image_location(
    image_path: &Path,
    root: Option<&Path>,
    document_asset_parent: Option<&Path>,
    global_assets_dir: Option<&Path>,
) -> Result<bool, WorkspaceError> {
    if root.is_some_and(|root| image_path.starts_with(root)) {
        return Ok(true);
    }

    if document_asset_parent.is_some_and(|parent| image_path.starts_with(parent.join(".assets"))) {
        return Ok(true);
    }

    let global_assets_dir = match ensure_global_assets_dir(global_assets_dir, false) {
        Ok(path) => path,
        Err(error) if error.error_code() == "not_found" => return Ok(false),
        Err(error) => return Err(error),
    };

    Ok(image_path.starts_with(global_assets_dir))
}

pub(crate) fn mime_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Where everything this application owns outside a workspace lives.
///
/// Shared rather than copied: assets, drafts, themes and memory all have to
/// agree on it, and a second definition is how two of them end up disagreeing.
pub(crate) fn loam_home_dir() -> Result<PathBuf, WorkspaceError> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| WorkspaceError::new("asset_path_failed", "home directory is not set"))?;
    Ok(PathBuf::from(home).join(".loam"))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
