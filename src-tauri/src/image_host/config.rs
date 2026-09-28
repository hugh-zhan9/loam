//! The image host config: what is on disk, what the settings page may see, and
//! when it is complete enough to upload with.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::assets::{loam_home_dir, sha256_hex};
use crate::models::WorkspaceError;
use crate::secret_config_file::SecretConfigFile;

const CONFIG_FILE: SecretConfigFile = SecretConfigFile {
    code_prefix: "image_host_config",
    label: "image host config",
    default_file_name: "image-host.json",
};

pub(crate) const DEFAULT_PICGO_SERVER_URL: &str = "http://127.0.0.1:36677/upload";

/// The config as stored, secrets included. Never sent to the webview.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageHostConfig {
    pub enabled: bool,
    /// Kept as written: an unknown value is harmless while the host is off and
    /// refused by validation once it is on.
    pub provider: String,
    pub picgo: PicgoConfig,
    pub command: CommandConfig,
    pub s3: S3Config,
    pub github: GithubConfig,
}

impl Default for ImageHostConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "picgo".to_string(),
            picgo: PicgoConfig::default(),
            command: CommandConfig::default(),
            s3: S3Config::default(),
            github: GithubConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PicgoConfig {
    pub server_url: String,
}

impl Default for PicgoConfig {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_PICGO_SERVER_URL.to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandConfig {
    pub command: String,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_access_key: Option<String>,
    pub path_style: bool,
    pub path_prefix: String,
    pub public_base_url: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubConfig {
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub path_prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub custom_base_url: String,
}

impl Default for GithubConfig {
    fn default() -> Self {
        Self {
            owner: String::new(),
            repo: String::new(),
            branch: "main".to_string(),
            path_prefix: String::new(),
            token: None,
            custom_base_url: String::new(),
        }
    }
}

/// What the settings page is shown: every field except the secrets, which it
/// learns only the existence of.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicImageHostConfig {
    pub enabled: bool,
    pub provider: String,
    pub picgo: PicgoConfig,
    pub command: CommandConfig,
    pub s3: PublicS3Config,
    pub github: PublicGithubConfig,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicS3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub path_style: bool,
    pub path_prefix: String,
    pub public_base_url: String,
    pub has_secret_access_key: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicGithubConfig {
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub path_prefix: String,
    pub custom_base_url: String,
    pub has_token: bool,
}

/// What the settings page sends back. A secret is either replaced by what was
/// typed (blank clears it) or, with its `preserve` flag, left as it is on disk.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageHostConfigUpdate {
    pub enabled: bool,
    pub provider: String,
    pub picgo: PicgoConfig,
    pub command: CommandConfig,
    pub s3: S3ConfigUpdate,
    pub github: GithubConfigUpdate,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct S3ConfigUpdate {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub preserve_secret_access_key: bool,
    pub path_style: bool,
    pub path_prefix: String,
    pub public_base_url: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubConfigUpdate {
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub path_prefix: String,
    pub token: String,
    pub preserve_token: bool,
    pub custom_base_url: String,
}

// Written out rather than derived so a secret can never reach a log through a
// `{:?}`: the value is replaced by whether there is one.

fn redacted(secret: &Option<String>) -> &'static str {
    if secret.is_some() {
        "<redacted>"
    } else {
        "<none>"
    }
}

fn redacted_input(secret: &str) -> &'static str {
    if secret.is_empty() {
        "<empty>"
    } else {
        "<redacted>"
    }
}

impl fmt::Debug for S3Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &redacted(&self.secret_access_key))
            .field("path_style", &self.path_style)
            .field("path_prefix", &self.path_prefix)
            .field("public_base_url", &self.public_base_url)
            .finish()
    }
}

impl fmt::Debug for GithubConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GithubConfig")
            .field("owner", &self.owner)
            .field("repo", &self.repo)
            .field("branch", &self.branch)
            .field("path_prefix", &self.path_prefix)
            .field("token", &redacted(&self.token))
            .field("custom_base_url", &self.custom_base_url)
            .finish()
    }
}

impl fmt::Debug for S3ConfigUpdate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("S3ConfigUpdate")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &redacted_input(&self.secret_access_key))
            .field("preserve_secret_access_key", &self.preserve_secret_access_key)
            .field("path_style", &self.path_style)
            .field("path_prefix", &self.path_prefix)
            .field("public_base_url", &self.public_base_url)
            .finish()
    }
}

impl fmt::Debug for GithubConfigUpdate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GithubConfigUpdate")
            .field("owner", &self.owner)
            .field("repo", &self.repo)
            .field("branch", &self.branch)
            .field("path_prefix", &self.path_prefix)
            .field("token", &redacted_input(&self.token))
            .field("preserve_token", &self.preserve_token)
            .field("custom_base_url", &self.custom_base_url)
            .finish()
    }
}

pub(crate) fn default_config_path() -> Result<PathBuf, WorkspaceError> {
    Ok(loam_home_dir()?.join("image-host.json"))
}

/// The config on disk, or the defaults when there is no file yet.
///
/// A file that exists and cannot be parsed is an error, not the defaults: the
/// defaults say "off", and a host the user turned on must not quietly become a
/// local save.
pub(crate) fn load_config_from_path(path: &Path) -> Result<ImageHostConfig, WorkspaceError> {
    // Every paste reads this, image host or not. When there is no file at all
    // — not here, not behind a symlink — the host was never configured, and a
    // `~/.loam` that is a symlink (a synced dotfiles folder) must not stop a
    // local save. A file that does exist gets the full check below.
    if matches!(fs::metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound) {
        return Ok(ImageHostConfig::default());
    }
    let exists = CONFIG_FILE.prepare_optional_load(path).map_err(|error| {
        if error.error_code() == "path_type_conflict" {
            // What the user sees in the failure bar on every paste: say which
            // file and why, not just that a directory was not a directory.
            WorkspaceError::new(
                "path_type_conflict",
                format!(
                    "the image host config at {} is not read: it holds credentials, so it is read only when it is a plain file reached through plain directories, with no symlink on the way",
                    path.display()
                ),
            )
        } else {
            error
        }
    })?;
    if !exists {
        return Ok(ImageHostConfig::default());
    }
    let bytes = fs::read(path).map_err(|error| {
        WorkspaceError::from_io(
            "image_host_config_load_failed",
            "failed to read image host config",
            &error,
        )
    })?;
    let parse_failed = |detail: String| {
        WorkspaceError::new(
            "image_host_config_load_failed",
            format!("failed to parse image host config: {detail}"),
        )
    };
    // serde also reads a struct from a JSON array, field by field, and with
    // every field defaulted `[]` would read as a config that is switched off.
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| parse_failed(error.to_string()))?;
    if !value.is_object() {
        return Err(parse_failed("expected a JSON object".to_string()));
    }
    serde_json::from_value(value).map_err(|error| parse_failed(error.to_string()))
}

fn save_config_to_path(path: &Path, config: &ImageHostConfig) -> Result<(), WorkspaceError> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| {
        WorkspaceError::new(
            "image_host_config_save_failed",
            format!("failed to serialize image host config: {error}"),
        )
    })?;
    CONFIG_FILE.save(path, &bytes)
}

pub(crate) fn update_config_at_path(
    path: &Path,
    update: ImageHostConfigUpdate,
) -> Result<PublicImageHostConfig, WorkspaceError> {
    // Read the file only when a secret is being kept: a settings page that
    // could not load a damaged file sends no preserve flags, and saving is then
    // how the damage is repaired.
    let existing = if update.s3.preserve_secret_access_key || update.github.preserve_token {
        Some(load_config_from_path(path)?)
    } else {
        None
    };
    let kept = |pick: fn(&ImageHostConfig) -> Option<String>| existing.as_ref().and_then(pick);

    let next = ImageHostConfig {
        enabled: update.enabled,
        provider: update.provider.trim().to_string(),
        picgo: PicgoConfig {
            server_url: update.picgo.server_url.trim().to_string(),
        },
        command: CommandConfig {
            command: update.command.command.trim().to_string(),
        },
        s3: S3Config {
            endpoint: update.s3.endpoint.trim().to_string(),
            region: update.s3.region.trim().to_string(),
            bucket: update.s3.bucket.trim().to_string(),
            access_key_id: update.s3.access_key_id.trim().to_string(),
            secret_access_key: if update.s3.preserve_secret_access_key {
                kept(|config| config.s3.secret_access_key.clone())
            } else {
                non_empty(&update.s3.secret_access_key)
            },
            path_style: update.s3.path_style,
            path_prefix: update.s3.path_prefix.trim().to_string(),
            public_base_url: update.s3.public_base_url.trim().to_string(),
        },
        github: GithubConfig {
            owner: update.github.owner.trim().to_string(),
            repo: update.github.repo.trim().to_string(),
            branch: update.github.branch.trim().to_string(),
            path_prefix: update.github.path_prefix.trim().to_string(),
            token: if update.github.preserve_token {
                kept(|config| config.github.token.clone())
            } else {
                non_empty(&update.github.token)
            },
            custom_base_url: update.github.custom_base_url.trim().to_string(),
        },
    };

    if next.enabled {
        validate(&next)?;
    }
    save_config_to_path(path, &next).map_err(|error| {
        if error.error_code() == "path_type_conflict" {
            WorkspaceError::new(
                "path_type_conflict",
                format!(
                    "the image host config at {} cannot be written: it holds credentials, so it is written only as a plain file in plain directories, with no symlink on the way",
                    path.display()
                ),
            )
        } else {
            error
        }
    })?;
    Ok(to_public(next))
}

pub(crate) fn to_public(config: ImageHostConfig) -> PublicImageHostConfig {
    PublicImageHostConfig {
        enabled: config.enabled,
        provider: config.provider,
        picgo: config.picgo,
        command: config.command,
        s3: PublicS3Config {
            endpoint: config.s3.endpoint,
            region: config.s3.region,
            bucket: config.s3.bucket,
            access_key_id: config.s3.access_key_id,
            path_style: config.s3.path_style,
            path_prefix: config.s3.path_prefix,
            public_base_url: config.s3.public_base_url,
            has_secret_access_key: config.s3.secret_access_key.is_some(),
        },
        github: PublicGithubConfig {
            owner: config.github.owner,
            repo: config.github.repo,
            branch: config.github.branch,
            path_prefix: config.github.path_prefix,
            custom_base_url: config.github.custom_base_url,
            has_token: config.github.token.is_some(),
        },
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Whether the active provider has everything an upload needs.
///
/// The one copy of these rules: saving an enabled config and every upload both
/// come through here, so a hand-edited file is caught at the paste that would
/// have used it.
pub(crate) fn validate(config: &ImageHostConfig) -> Result<(), WorkspaceError> {
    match config.provider.as_str() {
        "picgo" => require_http_url(&config.picgo.server_url, "picgo.serverUrl").map(|_| ()),
        "command" => require(&config.command.command, "command.command"),
        "s3" => {
            let s3 = &config.s3;
            let endpoint = require_http_url(&s3.endpoint, "s3.endpoint")?;
            if !matches!(endpoint.path(), "" | "/")
                || endpoint.query().is_some()
                || endpoint.fragment().is_some()
            {
                return Err(invalid(
                    "invalid URL in s3.endpoint: it must not have a path, query or fragment",
                ));
            }
            require(&s3.region, "s3.region")?;
            require(&s3.bucket, "s3.bucket")?;
            if !s3
                .bucket
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
            {
                return Err(invalid(
                    "invalid s3.bucket: use lowercase letters, digits, '.' and '-'",
                ));
            }
            require(&s3.access_key_id, "s3.accessKeyId")?;
            require(
                s3.secret_access_key.as_deref().unwrap_or(""),
                "s3.secretAccessKey",
            )?;
            require_http_url(&s3.public_base_url, "s3.publicBaseUrl")?;
            normalize_path_prefix(&s3.path_prefix, "s3.pathPrefix").map(|_| ())
        }
        "github" => {
            let github = &config.github;
            require_repo_name(&github.owner, "github.owner")?;
            require_repo_name(&github.repo, "github.repo")?;
            require(&github.branch, "github.branch")?;
            // Git allows far more in a branch name than survives in the link
            // that is inserted: `#` and `?` end the path, `%` starts an
            // escape, and `(`, `)`, `<`, `>` break the Markdown image around it.
            let branch = github.branch.trim();
            if branch.contains("..")
                || branch.starts_with('/')
                || branch.ends_with('/')
                || !branch
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
            {
                return Err(invalid(
                    "invalid github.branch: use letters, digits, '.', '_', '-' and '/'",
                ));
            }
            require(github.token.as_deref().unwrap_or(""), "github.token")?;
            if !github.custom_base_url.trim().is_empty() {
                require_http_url(&github.custom_base_url, "github.customBaseUrl")?;
            }
            normalize_path_prefix(&github.path_prefix, "github.pathPrefix").map(|_| ())
        }
        other => Err(invalid(format!("unknown image host provider: {other:?}"))),
    }
}

/// Where an uploaded image lives on the host: `prefix/sha256.ext`.
///
/// Named by content, as the local assets directory is, so pasting the same
/// image twice names the same object.
pub(crate) fn object_key(path_prefix: &str, bytes: &[u8], extension: &str) -> String {
    let file_name = format!("{}.{}", sha256_hex(bytes), extension);
    // Validation has already accepted the prefix before any upload runs.
    match normalize_path_prefix(path_prefix, "pathPrefix") {
        Ok(prefix) if !prefix.is_empty() => format!("{prefix}/{file_name}"),
        _ => file_name,
    }
}

fn normalize_path_prefix(value: &str, field: &str) -> Result<String, WorkspaceError> {
    let prefix = value.trim().trim_matches('/');
    if prefix.is_empty() {
        return Ok(String::new());
    }
    for segment in prefix.split('/') {
        let valid = !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !valid {
            return Err(invalid(format!(
                "invalid path in {field}: segments may use letters, digits, '.', '_' and '-'"
            )));
        }
    }
    Ok(prefix.to_string())
}

fn require(value: &str, field: &str) -> Result<(), WorkspaceError> {
    if value.trim().is_empty() {
        Err(invalid(format!("missing required field: {field}")))
    } else {
        Ok(())
    }
}

fn require_http_url(value: &str, field: &str) -> Result<Url, WorkspaceError> {
    require(value, field)?;
    // Base addresses end up inside `![alt](url)`; the URL parser would accept
    // characters that break it there.
    if value.trim().chars().any(super::breaks_markdown_link) {
        return Err(invalid(format!(
            "invalid URL in {field}: it must not contain spaces, parentheses or angle brackets"
        )));
    }
    match Url::parse(value.trim()) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => Ok(url),
        _ => Err(invalid(format!(
            "invalid URL in {field}: expected an http:// or https:// address"
        ))),
    }
}

fn require_repo_name(value: &str, field: &str) -> Result<(), WorkspaceError> {
    require(value, field)?;
    let value = value.trim();
    // `.` and `..` are made of allowed characters and would still walk the API
    // path up a level.
    if !matches!(value, "." | "..")
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        Err(invalid(format!("invalid {field}")))
    }
}

fn invalid(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::new("image_host_config_invalid", message)
}
