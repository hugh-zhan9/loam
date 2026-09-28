//! Reading and writing a config file that holds a credential.
//!
//! The LLM config and the image host config both keep a secret on disk, and
//! both need the same care: no symlink anywhere on the way to the file, a
//! temporary file that is private from the moment it exists, an atomic replace,
//! and permissions narrowed afterwards. One copy, so the two cannot drift.

use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use crate::models::WorkspaceError;

/// Which config this is, as its errors should say it.
///
/// Callers already hand out `<prefix>_load_failed` and `<prefix>_save_failed`,
/// and the words in their messages; moving the mechanics here must not change
/// what anyone sees.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SecretConfigFile {
    /// Prefix of the error codes, e.g. `llm_config`.
    pub code_prefix: &'static str,
    /// What the file is called in messages, e.g. `llm config`.
    pub label: &'static str,
    /// Stands in for the file name in temporary names when the path has none.
    pub default_file_name: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExistingPathKind {
    Missing,
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathOperation {
    Load,
    Save,
}

impl SecretConfigFile {
    /// Whether there is a file to load; an absent one is not an error.
    pub fn prepare_optional_load(&self, path: &Path) -> Result<bool, WorkspaceError> {
        self.ensure_no_existing_symlink_ancestor(path, PathOperation::Load)?;
        match self.existing_path_kind(path, PathOperation::Load)? {
            ExistingPathKind::File => Ok(true),
            ExistingPathKind::Missing => Ok(false),
            ExistingPathKind::Directory | ExistingPathKind::Symlink | ExistingPathKind::Other => {
                Err(self.path_type_conflict("file", "not a file"))
            }
        }
    }

    /// Requires the file to be there and to be a plain file.
    pub fn ensure_load_target(&self, path: &Path) -> Result<(), WorkspaceError> {
        self.ensure_no_existing_symlink_ancestor(path, PathOperation::Load)?;
        match self.existing_path_kind(path, PathOperation::Load)? {
            ExistingPathKind::File => Ok(()),
            ExistingPathKind::Missing => Err(WorkspaceError::from_io(
                self.load_failed(),
                format!("failed to read {}", self.label),
                &io::Error::from(io::ErrorKind::NotFound),
            )),
            ExistingPathKind::Directory | ExistingPathKind::Symlink | ExistingPathKind::Other => {
                Err(self.path_type_conflict("file", "not a file"))
            }
        }
    }

    /// Replaces the file with `bytes`, readable by its owner only.
    pub fn save(&self, path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
        let parent = path.parent().ok_or_else(|| {
            WorkspaceError::new(
                self.save_failed(),
                format!("{} path has no parent directory", self.label),
            )
        })?;

        self.ensure_parent_dir(parent)?;
        self.ensure_file_target(path)?;

        let temp_path = parent.join(format!(
            ".{}.tmp.{}.{}",
            self.file_name(path),
            std::process::id(),
            timestamp_nanos()
        ));

        {
            let mut file = self.create_secret_temp_file(&temp_path)?;
            file.write_all(bytes).map_err(|error| {
                let _ = fs::remove_file(&temp_path);
                WorkspaceError::from_io(
                    self.save_failed(),
                    format!("failed to write temporary {}", self.label),
                    &error,
                )
            })?;
            file.sync_all().map_err(|error| {
                let _ = fs::remove_file(&temp_path);
                WorkspaceError::from_io(
                    self.save_failed(),
                    format!("failed to sync temporary {}", self.label),
                    &error,
                )
            })?;
        }

        self.replace_file(&temp_path, path)?;
        self.restrict_file(path)
    }

    fn load_failed(&self) -> String {
        format!("{}_load_failed", self.code_prefix)
    }

    fn save_failed(&self) -> String {
        format!("{}_save_failed", self.code_prefix)
    }

    fn file_name<'a>(&self, path: &'a Path) -> &'a str {
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(self.default_file_name)
    }

    fn ensure_parent_dir(&self, path: &Path) -> Result<(), WorkspaceError> {
        self.ensure_no_existing_symlink_ancestor(path, PathOperation::Save)?;
        match self.existing_path_kind(path, PathOperation::Save)? {
            ExistingPathKind::Directory => self.restrict_dir(path),
            ExistingPathKind::Missing => {
                fs::create_dir_all(path).map_err(|error| {
                    WorkspaceError::from_io(
                        self.save_failed(),
                        format!("failed to create {} directory", self.label),
                        &error,
                    )
                })?;
                match self.existing_path_kind(path, PathOperation::Save)? {
                    ExistingPathKind::Directory => self.restrict_dir(path),
                    ExistingPathKind::Missing => Err(WorkspaceError::new(
                        self.save_failed(),
                        format!("{} directory was not created", self.label),
                    )),
                    ExistingPathKind::File | ExistingPathKind::Symlink | ExistingPathKind::Other => {
                        Err(self.path_type_conflict("directory", "not a directory"))
                    }
                }
            }
            ExistingPathKind::File | ExistingPathKind::Symlink | ExistingPathKind::Other => {
                Err(self.path_type_conflict("directory", "not a directory"))
            }
        }
    }

    fn ensure_file_target(&self, path: &Path) -> Result<(), WorkspaceError> {
        match self.existing_path_kind(path, PathOperation::Save)? {
            ExistingPathKind::Missing | ExistingPathKind::File => Ok(()),
            ExistingPathKind::Directory | ExistingPathKind::Symlink | ExistingPathKind::Other => {
                Err(self.path_type_conflict("file", "not a file"))
            }
        }
    }

    fn ensure_no_existing_symlink_ancestor(
        &self,
        path: &Path,
        operation: PathOperation,
    ) -> Result<(), WorkspaceError> {
        for ancestor in path.ancestors().skip(1) {
            if ancestor.as_os_str().is_empty() {
                continue;
            }
            match self.existing_path_kind(ancestor, operation)? {
                ExistingPathKind::Missing => {}
                ExistingPathKind::Directory => {}
                ExistingPathKind::File | ExistingPathKind::Symlink | ExistingPathKind::Other => {
                    return Err(self.path_type_conflict("directory", "not a directory"));
                }
            }
        }
        Ok(())
    }

    #[cfg(windows)]
    fn replace_file(&self, temp_path: &Path, path: &Path) -> Result<(), WorkspaceError> {
        if !matches!(
            self.existing_path_kind(path, PathOperation::Save)?,
            ExistingPathKind::File
        ) {
            return self.rename_file(temp_path, path);
        }

        let backup_path = path.with_file_name(format!(
            ".{}.backup.{}.{}",
            self.file_name(path),
            std::process::id(),
            timestamp_nanos()
        ));
        fs::rename(path, &backup_path).map_err(|error| {
            let _ = fs::remove_file(temp_path);
            WorkspaceError::from_io(
                self.save_failed(),
                format!("failed to back up existing {} before replace", self.label),
                &error,
            )
        })?;

        match fs::rename(temp_path, path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup_path);
                Ok(())
            }
            Err(error) => {
                let restore_result = fs::rename(&backup_path, path);
                let _ = fs::remove_file(temp_path);
                if let Err(restore_error) = restore_result {
                    return Err(WorkspaceError::new(
                        self.save_failed(),
                        format!(
                            "failed to replace {}: {error}; failed to restore previous config: {restore_error}",
                            self.label
                        ),
                    ));
                }
                Err(WorkspaceError::from_io(
                    self.save_failed(),
                    format!("failed to replace {}", self.label),
                    &error,
                ))
            }
        }
    }

    #[cfg(not(windows))]
    fn replace_file(&self, temp_path: &Path, path: &Path) -> Result<(), WorkspaceError> {
        self.rename_file(temp_path, path)
    }

    fn rename_file(&self, temp_path: &Path, path: &Path) -> Result<(), WorkspaceError> {
        fs::rename(temp_path, path).map_err(|error| {
            let _ = fs::remove_file(temp_path);
            WorkspaceError::from_io(
                self.save_failed(),
                format!("failed to replace {}", self.label),
                &error,
            )
        })
    }

    #[cfg(unix)]
    fn restrict_dir(&self, path: &Path) -> Result<(), WorkspaceError> {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            WorkspaceError::from_io(
                self.save_failed(),
                format!("failed to restrict {} directory permissions", self.label),
                &error,
            )
        })
    }

    #[cfg(not(unix))]
    fn restrict_dir(&self, _path: &Path) -> Result<(), WorkspaceError> {
        Ok(())
    }

    #[cfg(unix)]
    fn create_secret_temp_file(&self, path: &Path) -> Result<fs::File, WorkspaceError> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| {
                WorkspaceError::from_io(
                    self.save_failed(),
                    format!("failed to create temporary {}", self.label),
                    &error,
                )
            })
    }

    #[cfg(not(unix))]
    fn create_secret_temp_file(&self, path: &Path) -> Result<fs::File, WorkspaceError> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| {
                WorkspaceError::from_io(
                    self.save_failed(),
                    format!("failed to create temporary {}", self.label),
                    &error,
                )
            })
    }

    #[cfg(unix)]
    fn restrict_file(&self, path: &Path) -> Result<(), WorkspaceError> {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            WorkspaceError::from_io(
                self.save_failed(),
                format!("failed to restrict {} file permissions", self.label),
                &error,
            )
        })
    }

    #[cfg(not(unix))]
    fn restrict_file(&self, _path: &Path) -> Result<(), WorkspaceError> {
        Ok(())
    }

    fn existing_path_kind(
        &self,
        path: &Path,
        operation: PathOperation,
    ) -> Result<ExistingPathKind, WorkspaceError> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(ExistingPathKind::Missing);
            }
            Err(error) => {
                let (code, verb) = match operation {
                    PathOperation::Load => (self.load_failed(), "load"),
                    PathOperation::Save => (self.save_failed(), "save"),
                };
                return Err(WorkspaceError::from_io(
                    code,
                    format!("failed to inspect {} before {verb}", self.label),
                    &error,
                ));
            }
        };

        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            Ok(ExistingPathKind::Symlink)
        } else if file_type.is_dir() {
            Ok(ExistingPathKind::Directory)
        } else if file_type.is_file() {
            Ok(ExistingPathKind::File)
        } else {
            Ok(ExistingPathKind::Other)
        }
    }

    fn path_type_conflict(&self, expected: &str, actual: &str) -> WorkspaceError {
        WorkspaceError::new(
            "path_type_conflict",
            format!("expected {} {expected}, found {actual}", self.label),
        )
    }
}

fn timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
