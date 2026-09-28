//! A GitHub repository as an image host, through the Contents API.
//!
//! Files are named by content, so "already exists" means "already uploaded":
//! the second paste of an image is a success that points at the first.

use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::Url;
use serde_json::json;

use super::config::{object_key, GithubConfig};
use super::{http_client, preview, response_text, send, upload_failed};
use crate::models::WorkspaceError;

pub(super) const GITHUB_API_BASE: &str = "https://api.github.com";

pub(super) fn upload(
    config: &GithubConfig,
    bytes: &[u8],
    extension: &str,
    timeout: Duration,
    api_base: &str,
) -> Result<String, WorkspaceError> {
    let owner = config.owner.trim();
    let repo = config.repo.trim();
    let branch = config.branch.trim();
    let token = config.token.as_deref().unwrap_or("").trim();
    let key = object_key(&config.path_prefix, bytes, extension);
    let file_name = key.rsplit('/').next().unwrap_or(&key);
    let contents_url = format!(
        "{}/repos/{owner}/{repo}/contents/{key}",
        api_base.trim_end_matches('/')
    );

    // One budget for the upload, however many requests it takes.
    let started = Instant::now();
    let client = http_client(timeout)?;
    let authorized = |request: reqwest::blocking::RequestBuilder| {
        request
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "Loam")
    };

    let response = send(
        authorized(client.put(&contents_url)).json(&json!({
            "message": format!("Upload {file_name} from Loam"),
            "content": base64::engine::general_purpose::STANDARD.encode(bytes),
            "branch": branch,
        })),
        "GitHub",
        timeout,
    )?;

    let status = response.status().as_u16();
    if !matches!(status, 200 | 201) {
        let body = response_text(response);
        // GitHub answers 422 when the path is taken. The name is the content's
        // hash, so a file already there is this image: confirm, and use it.
        let remaining = timeout.saturating_sub(started.elapsed());
        let exists = status == 422
            && !remaining.is_zero()
            && existing_file_url(&contents_url, branch).is_some_and(|url| {
                send(authorized(client.get(url)).timeout(remaining), "GitHub", timeout)
                    .is_ok_and(|existing| existing.status().as_u16() == 200)
            });
        if !exists {
            return Err(upload_failed(format!(
                "GitHub HTTP {status}: {}",
                github_message(&body)
            )));
        }
    }

    let custom_base_url = config.custom_base_url.trim();
    Ok(if custom_base_url.is_empty() {
        format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{key}")
    } else {
        format!("{}/{key}", custom_base_url.trim_end_matches('/'))
    })
}

/// The same contents path, asked about on the configured branch.
fn existing_file_url(contents_url: &str, branch: &str) -> Option<Url> {
    let mut url = Url::parse(contents_url).ok()?;
    url.query_pairs_mut().append_pair("ref", branch);
    Some(url)
}

fn github_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("message")?.as_str().map(str::to_string))
        .filter(|message| !message.trim().is_empty())
        .map(|message| preview(&message))
        .unwrap_or_else(|| preview(body))
}
