//! Uploading pasted images to the image host the user configured.
//!
//! Everything that talks to a host happens here, in the backend: the
//! credentials never have to reach the webview, a PicGo server need not send
//! CORS headers, and a user's upload command can only be started from here.
//! Whether a paste is uploaded at all is decided by the caller from
//! `image_host_config_get`; this module never falls back to a local save.

mod command;
mod config;
mod github;
mod picgo;
mod s3;

#[cfg(test)]
mod tests;

use std::error::Error as StdError;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::assets::{image_extension, sha256_hex};
use crate::models::WorkspaceError;

pub use config::{ImageHostConfigUpdate, PublicImageHostConfig};
use config::{default_config_path, load_config_from_path, to_public, update_config_at_path};

/// How long one upload may take, whichever provider does it.
const IMAGE_HOST_UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const IMAGE_HOST_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How much of a host's reply an error quotes: enough to carry its reason.
const RESPONSE_PREVIEW_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadedImage {
    pub url: String,
}

#[tauri::command]
pub fn image_host_config_get() -> Result<PublicImageHostConfig, WorkspaceError> {
    public_config_at(default_config_path())
}

/// Every paste asks this first, so it must not fail where a local save used to
/// work: without a home directory there is no `~/.loam`, hence no config, and
/// the host is simply off.
fn public_config_at(
    path: Result<PathBuf, WorkspaceError>,
) -> Result<PublicImageHostConfig, WorkspaceError> {
    match path {
        Ok(path) => load_config_from_path(&path).map(to_public),
        Err(error) if error.error_code() == "asset_path_failed" => {
            Ok(to_public(config::ImageHostConfig::default()))
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn image_host_config_update(
    config: ImageHostConfigUpdate,
) -> Result<PublicImageHostConfig, WorkspaceError> {
    update_config_at_path(&default_config_path()?, config)
}

/// Uploads one image and returns where it can be read from.
///
/// `async` and off the main thread: a synchronous command runs on the main
/// thread, and an upload can take as long as the network does.
#[tauri::command]
pub async fn upload_image_to_host(
    name: String,
    bytes: Vec<u8>,
) -> Result<UploadedImage, WorkspaceError> {
    tauri::async_runtime::spawn_blocking(move || {
        upload_image_at_config_path(
            &default_config_path()?,
            &name,
            &bytes,
            IMAGE_HOST_UPLOAD_TIMEOUT,
        )
    })
    .await
    .map_err(|error| {
        WorkspaceError::new(
            "background_task_failed",
            format!("failed to join image upload task: {error}"),
        )
    })?
}

pub(crate) fn upload_image_at_config_path(
    config_path: &Path,
    name: &str,
    bytes: &[u8],
    timeout: Duration,
) -> Result<UploadedImage, WorkspaceError> {
    let config = load_config_from_path(config_path)?;
    // The caller read the config a moment ago and found the host on; another
    // window may have turned it off since.
    if !config.enabled {
        return Err(WorkspaceError::new(
            "image_host_disabled",
            "the image host is turned off",
        ));
    }
    config::validate(&config)?;
    let extension = image_extension(name)?;

    let url = match config.provider.as_str() {
        "picgo" => picgo::upload(&config.picgo, bytes, &extension, timeout)?,
        "command" => command::upload(
            &config.command,
            bytes,
            &extension,
            timeout,
            &command::login_shell(),
        )?,
        "s3" => s3::upload(
            &config.s3,
            bytes,
            &extension,
            timeout,
            time::OffsetDateTime::now_utc(),
        )?,
        "github" => github::upload(
            &config.github,
            bytes,
            &extension,
            timeout,
            github::GITHUB_API_BASE,
        )?,
        other => unreachable!("validation accepted provider {other:?}"),
    };

    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(upload_failed(format!(
            "the image host returned something that is not a URL: {}",
            preview(&url)
        )));
    }
    // The URL goes into `![alt](url)` as it is; any of these would end the
    // link early or break it, and the image would be written but not shown.
    if url.chars().any(breaks_markdown_link) {
        return Err(upload_failed(format!(
            "the image host returned a URL with spaces, parentheses or angle brackets, which cannot be written into a Markdown image: {}",
            preview(&url)
        )));
    }
    Ok(UploadedImage { url })
}

/// Characters that end or break the destination of a Markdown image.
pub(super) fn breaks_markdown_link(c: char) -> bool {
    c.is_whitespace() || matches!(c, '(' | ')' | '<' | '>')
}

/// The image, on disk for as long as a provider that reads files needs it.
///
/// Named by content like every other copy of the image; the directory, and the
/// file in it, are removed when this is dropped.
pub(super) struct TempImage {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl TempImage {
    pub(super) fn write(bytes: &[u8], extension: &str) -> Result<Self, WorkspaceError> {
        let dir = tempfile::Builder::new()
            .prefix("loam-image-host-")
            .tempdir()
            .map_err(|error| {
                WorkspaceError::from_io(
                    "image_host_upload_failed",
                    "failed to create a temporary directory for the image",
                    &error,
                )
            })?;
        let path = dir.path().join(format!("{}.{}", sha256_hex(bytes), extension));
        fs::write(&path, bytes).map_err(|error| {
            WorkspaceError::from_io(
                "image_host_upload_failed",
                "failed to write the temporary image",
                &error,
            )
        })?;
        Ok(Self { _dir: dir, path })
    }

    pub(super) fn path_str(&self) -> Result<&str, WorkspaceError> {
        self.path
            .to_str()
            .ok_or_else(|| upload_failed("the temporary image path is not valid UTF-8"))
    }
}

pub(super) fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, WorkspaceError> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(IMAGE_HOST_CONNECT_TIMEOUT.min(timeout))
        .build()
        .map_err(|error| {
            upload_failed(format!("failed to create the HTTP client: {error}"))
        })
}

/// Sends a request, naming the host in whatever goes wrong.
///
/// The message carries the error and the address, never the request: its
/// headers are where the credentials are.
pub(super) fn send(
    request: reqwest::blocking::RequestBuilder,
    host_label: &str,
    timeout: Duration,
) -> Result<reqwest::blocking::Response, WorkspaceError> {
    request.send().map_err(|error| {
        // The address can carry a credential — a PicList `?key=` — and the
        // label already says which host this was.
        let error = error.without_url();
        if error.is_timeout() {
            WorkspaceError::new(
                "image_host_timeout",
                format!(
                    "{host_label} did not answer within {} seconds",
                    timeout.as_secs_f32()
                ),
            )
        } else {
            upload_failed(format!("could not reach {host_label}: {}", describe_error(&error)))
        }
    })
}

/// Reads a reply body; a body that cannot be read is reported as empty, since
/// the status alone already says the upload failed.
pub(super) fn response_text(response: reqwest::blocking::Response) -> String {
    response.text().unwrap_or_default()
}

fn describe_error(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

/// The start of a reply, short enough to sit in an error bar.
pub(super) fn preview(text: &str) -> String {
    let text = text.trim();
    let mut preview: String = text.chars().take(RESPONSE_PREVIEW_CHARS).collect();
    if text.chars().count() > RESPONSE_PREVIEW_CHARS {
        preview.push('…');
    }
    preview
}

pub(super) fn upload_failed(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::new("image_host_upload_failed", message)
}
