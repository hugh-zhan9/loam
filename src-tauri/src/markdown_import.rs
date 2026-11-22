//! Preview and copy a local Markdown export without rewriting notes.
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use crate::{WindowSession, WindowSessionRegistry};

const MAX_FILES: usize = 20_000;
const MAX_NOTES_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    path: String,
    note: Option<String>,
    collision: bool,
}

#[derive(Serialize, Default)]
pub struct Outcome {
    added: Vec<String>,
    skipped: Vec<String>,
    failed: Vec<String>,
}

fn invalid(message: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, message) }

fn parts(relative: &Path) -> io::Result<Vec<CString>> {
    let mut result = Vec::new();
    for part in relative.components() {
        let Component::Normal(part) = part else { return Err(invalid("Invalid relative path")); };
        if part.as_bytes().starts_with(b".") && part != ".assets" { return Err(invalid("Hidden path")); }
        result.push(CString::new(part.as_bytes()).map_err(|_| invalid("Invalid filename"))?);
    }
    if result.is_empty() || result.len() > 64 { return Err(invalid("Invalid path depth")); }
    Ok(result)
}

fn open_at(parent: &File, name: &CString, flags: libc::c_int) -> io::Result<File> {
    // No path component is resolved through a symlink.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, 0o600 as libc::c_int) };
    if fd < 0 { Err(io::Error::last_os_error()) } else { Ok(unsafe { File::from_raw_fd(fd) }) }
}

fn parent_at(root: &File, relative: &Path, create: bool) -> io::Result<(File, CString)> {
    let mut names = parts(relative)?;
    let last = names.pop().expect("parts has at least one entry");
    let mut current = root.try_clone()?;
    for name in names {
        let dir = open_at(&current, &name, libc::O_RDONLY | libc::O_DIRECTORY);
        current = match dir {
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                let status = unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o755 as libc::mode_t) };
                if status < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::AlreadyExists { return Err(error); }
                }
                open_at(&current, &name, libc::O_RDONLY | libc::O_DIRECTORY)?
            }
            other => other?,
        };
    }
    Ok((current, last))
}

fn source_file(source: &File, relative: &Path) -> io::Result<(File, Metadata)> {
    let (dir, name) = parent_at(source, relative, false)?;
    // Nonblocking open avoids hanging if a regular file is replaced with a FIFO.
    let file = open_at(&dir, &name, libc::O_RDONLY | libc::O_NONBLOCK)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() { return Err(invalid("Not a regular source file")); }
    Ok((file, metadata))
}

fn has_collision(destination: &File, relative: &Path) -> bool {
    match parent_at(destination, relative, false) {
        Ok((dir, name)) => {
            // O_NOFOLLOW treats even an existing dangling link as occupied.
            match open_at(&dir, &name, libc::O_RDONLY | libc::O_NONBLOCK) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                _ => true,
            }
        }
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    }
}

fn roots(source: &str, destination: &str) -> io::Result<(PathBuf, File, File)> {
    let source = Path::new(source).canonicalize()?;
    let destination = Path::new(destination).canonicalize()?;
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err(invalid("Choose a source outside the current workspace"));
    }
    let open = |path: &Path| fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(path);
    let input = open(&source)?;
    let output = open(&destination)?;
    let (a, b) = (input.metadata()?, output.metadata()?);
    if a.dev() == b.dev() && a.ino() == b.ino() { return Err(invalid("Source and workspace are identical")); }
    Ok((source, input, output))
}

fn note(path: &Path) -> bool {
    path.extension().and_then(|x| x.to_str()).is_some_and(|x|
        x.eq_ignore_ascii_case("md") || x.eq_ignore_ascii_case("markdown"))
}

fn eligible(path: &Path) -> bool {
    note(path) || path.extension().and_then(|x| x.to_str()).is_some_and(|x|
        ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic", "heif", "bmp", "tif", "tiff", "ico",
        "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "rtf", "csv", "json", "zip",
        "mp3", "m4a", "wav", "ogg", "flac", "mp4", "mov", "webm"].iter().any(|ext| x.eq_ignore_ascii_case(ext)))
}

fn preview(source: &str, destination: &str) -> io::Result<Vec<Entry>> {
    let (source_path, input, output) = roots(source, destination)?;
    let mut entries = Vec::new();
    let mut pending = vec![PathBuf::new()];
    let mut bytes = 0;
    let mut files = 0;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(source_path.join(directory))? {
            files += 1;
            if files > MAX_FILES { return Err(invalid("Source contains too many files")); }
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(&source_path).map_err(|_| invalid("Invalid source path"))?;
            let Some(text_path) = relative.to_str() else { continue; };
            if parts(relative).is_err() { continue; }
            let kind = entry.file_type()?;
            if kind.is_dir() { pending.push(relative.to_owned()); continue; }
            if !kind.is_file() || !eligible(relative) { continue; }
            let text = if note(relative) {
                let (file, _) = source_file(&input, relative)?;
                let mut text = String::new();
                file.take(MAX_NOTES_BYTES - bytes + 1).read_to_string(&mut text)?;
                bytes += text.len() as u64;
                if bytes > MAX_NOTES_BYTES { return Err(invalid("Source Markdown exceeds preview limit")); }
                Some(text)
            } else { None };
            entries.push(Entry { path: text_path.to_string(), note: text, collision: has_collision(&output, relative) });
        }
    }
    entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

fn copy_file(source: &File, destination: &File, relative: &Path) -> io::Result<()> {
    let (mut input, _) = source_file(source, relative)?;
    let (dir, name) = parent_at(destination, relative, true)?;
    let mut random = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let temporary = CString::new(format!(".loam-import-{:032x}", u128::from_le_bytes(random)))
        .expect("ASCII temp filename");
    let mut output = open_at(&dir, &temporary, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
    let result = (|| {
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        // Publish the fully-written file only if the destination does not exist.
        let status = unsafe { libc::linkat(dir.as_raw_fd(), temporary.as_ptr(),
            dir.as_raw_fd(), name.as_ptr(), 0) };
        if status < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    })();
    unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0); }
    result
}

fn apply(source: &str, destination: &str, mut paths: Vec<String>,
    dependencies: HashMap<String, Vec<String>>) -> io::Result<Outcome> {
    if paths.len() > MAX_FILES { return Err(invalid("Import contains too many files")); }
    for path in &paths {
        parts(Path::new(path))?;
        if !eligible(Path::new(path)) { return Err(invalid("Unsupported import file type")); }
    }
    let selected: HashSet<_> = paths.iter().map(String::as_str).collect();
    if dependencies.iter().any(|(path, required)| !selected.contains(path.as_str())
        || !note(Path::new(path))
        || required.iter().any(|asset| !selected.contains(asset.as_str()) || note(Path::new(asset)))) {
        return Err(invalid("Invalid import dependencies"));
    }
    // Publish attachments before notes, and never point a new note at an
    // unrelated pre-existing asset if the attachment just became occupied.
    paths.sort_by_key(|path| note(Path::new(path)));
    let (_, input, output) = roots(source, destination)?;
    let mut outcome = Outcome::default();
    let mut copied_assets = HashSet::new();
    for path in paths {
        let relative = Path::new(&path);
        if dependencies.get(&path).is_some_and(|assets| assets.iter().any(|asset| !copied_assets.contains(asset))) {
            outcome.skipped.push(path);
            continue;
        }
        if has_collision(&output, relative) { outcome.skipped.push(path); continue; }
        match copy_file(&input, &output, relative) {
            Ok(()) => {
                if !note(relative) { copied_assets.insert(path.clone()); }
                outcome.added.push(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists || has_collision(&output, relative) =>
                outcome.skipped.push(path),
            Err(_) => outcome.failed.push(path),
        }
    }
    Ok(outcome)
}

fn bound_root(window: &tauri::Window, registry: &Mutex<WindowSessionRegistry>, root_path: &str) -> Result<String, String> {
    let registry = registry.lock().map_err(|_| "Workspace unavailable".to_string())?;
    match registry.session_for_label(window.label()) {
        Some(WindowSession::Workspace { root_path: Some(bound) }) if bound == root_path => Ok(bound),
        _ => Err("Workspace changed; open a new import preview".to_string()),
    }
}

#[tauri::command]
pub async fn preview_markdown_import(window: tauri::Window, registry: tauri::State<'_, Mutex<WindowSessionRegistry>>, source: String, root_path: String) -> Result<Vec<Entry>, String> {
    let root_path = bound_root(&window, &registry, &root_path)?;
    tauri::async_runtime::spawn_blocking(move || preview(&source, &root_path))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn apply_markdown_import(window: tauri::Window, registry: tauri::State<'_, Mutex<WindowSessionRegistry>>, source: String, root_path: String, paths: Vec<String>, dependencies: HashMap<String, Vec<String>>) -> Result<Outcome, String> {
    let root_path = bound_root(&window, &registry, &root_path)?;
    tauri::async_runtime::spawn_blocking(move || apply(&source, &root_path, paths, dependencies))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn preview_is_read_only_and_apply_preserves_layout_without_overwriting() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let s = source.path().to_str().unwrap();
        let d = dest.path().to_str().unwrap();
        fs::create_dir(source.path().join("assets")).unwrap();
        fs::write(source.path().join("note.md"), "![photo](assets/photo.png)").unwrap();
        fs::write(source.path().join("assets/photo.png"), "bytes").unwrap();
        fs::write(source.path().join("conflict.md"), "new").unwrap();
        fs::write(dest.path().join("conflict.md"), "old").unwrap();
        let plan = preview(s, d).unwrap();
        assert_eq!(plan.iter().filter(|x| x.collision).count(), 1);
        assert_eq!(fs::read_dir(dest.path()).unwrap().count(), 1);
        let result = apply(s, d, plan.into_iter().map(|e| e.path).collect(), HashMap::new()).unwrap();
        assert_eq!(result.skipped, vec!["conflict.md"]);
        assert_eq!(result.added, vec!["assets/photo.png", "note.md"]);
        assert_eq!(fs::read_to_string(dest.path().join("conflict.md")).unwrap(), "old");
        assert_eq!(fs::read_to_string(dest.path().join("note.md")).unwrap(), "![photo](assets/photo.png)");
    }

    #[test]
    fn copied_markdown_opens_its_url_encoded_relative_image() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let s = source.path().to_str().unwrap();
        let d = dest.path().to_str().unwrap();
        let note_path = "nested/note.md";
        let image_path = ".assets/photo one.png";
        let markdown = b"![photo](../.assets/photo%20one.png?rev=2#caption)\n";
        fs::create_dir(source.path().join("nested")).unwrap();
        fs::create_dir(source.path().join(".assets")).unwrap();
        fs::write(source.path().join(note_path), markdown).unwrap();
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[17, 33, 51, 255]).unwrap();
        }
        fs::write(source.path().join(image_path), &png).unwrap();

        let paths = preview(s, d)
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        let dependencies = HashMap::from([(note_path.into(), vec![image_path.into()])]);
        assert_eq!(
            apply(s, d, paths, dependencies).unwrap().added,
            vec![image_path, note_path]
        );
        assert_eq!(fs::read(dest.path().join(note_path)).unwrap(), markdown);
        for src in [
            "../.assets/photo one.png",
            "../.assets/photo%20one.png",
            "../.assets/photo%20one.png?rev=2#caption",
        ] {
            let loaded = crate::assets::load_image_asset(
                Some(d.into()),
                Some(note_path.into()),
                src.into(),
            ).unwrap_or_else(|error| panic!("{src}: {error}"));
            assert_eq!(loaded.mime_type, "image/png");
            assert_eq!(loaded.bytes, png);
            let mut reader = png::Decoder::new(loaded.bytes.as_slice()).read_info().unwrap();
            let mut pixels = vec![0; reader.output_buffer_size()];
            let frame = reader.next_frame(&mut pixels).unwrap();
            assert_eq!(&pixels[..frame.buffer_size()], &[17, 33, 51, 255]);
        }
    }

    #[test]
    fn skips_source_symlinks_and_does_not_follow_destination_symlinks() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "untouched").unwrap();
        symlink(outside.path().join("secret.md"), source.path().join("linked.md")).unwrap();
        fs::create_dir(source.path().join("folder")).unwrap();
        fs::write(source.path().join("folder/secret.md"), "overwrite").unwrap();
        symlink(outside.path(), dest.path().join("folder")).unwrap();
        let s = source.path().to_str().unwrap();
        let d = dest.path().to_str().unwrap();
        let entries = preview(s, d).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].collision);
        assert!(apply(s, d, vec!["../escape.md".into()], HashMap::new()).is_err());
        let result = apply(s, d, vec!["folder/secret.md".into(), "linked.md".into()], HashMap::new()).unwrap();
        assert_eq!(result.skipped, vec!["folder/secret.md"]);
        assert_eq!(result.failed, vec!["linked.md"]);
        assert_eq!(fs::read_to_string(outside.path().join("secret.md")).unwrap(), "untouched");
    }

    #[test]
    fn refuses_to_clobber_a_file_created_after_preview() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let s = source.path().to_str().unwrap();
        let d = dest.path().to_str().unwrap();
        fs::write(source.path().join("same.md"), "from source").unwrap();
        let plan = preview(s, d).unwrap();
        assert!(!plan[0].collision);
        // Also exercise the kernel no-replace guarantee independently of the preflight.
        fs::write(dest.path().join("same.md"), "created after preview").unwrap();
        let (_, source_dir, dest_dir) = roots(s, d).unwrap();
        let error = copy_file(&source_dir, &dest_dir, Path::new("same.md")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        let result = apply(s, d, plan.into_iter().map(|e| e.path).collect(), HashMap::new()).unwrap();
        assert_eq!(result.skipped, vec!["same.md"]);
        assert_eq!(fs::read_to_string(dest.path().join("same.md")).unwrap(), "created after preview");
        assert_eq!(fs::read_dir(dest.path()).unwrap().count(), 1);
    }

    #[test]
    fn permits_loam_assets_and_skips_note_if_a_required_attachment_collides() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let s = source.path().to_str().unwrap();
        let d = dest.path().to_str().unwrap();
        fs::create_dir(source.path().join(".assets")).unwrap();
        fs::create_dir(source.path().join(".git")).unwrap();
        fs::write(source.path().join(".assets/p.png"), "source image").unwrap();
        fs::write(source.path().join(".git/private.md"), "never imported").unwrap();
        fs::write(source.path().join("note.md"), "![image](.assets/p.png)").unwrap();
        let paths: Vec<_> = preview(s, d).unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec![".assets/p.png", "note.md"]);
        fs::create_dir(dest.path().join(".assets")).unwrap();
        fs::write(dest.path().join(".assets/p.png"), "old image").unwrap();
        let dependencies = HashMap::from([("note.md".into(), vec![".assets/p.png".into()])]);
        let result = apply(s, d, paths, dependencies).unwrap();
        assert_eq!(result.skipped, vec![".assets/p.png", "note.md"]);
        assert!(!dest.path().join("note.md").exists());
        assert_eq!(fs::read_to_string(dest.path().join(".assets/p.png")).unwrap(), "old image");
    }
}
