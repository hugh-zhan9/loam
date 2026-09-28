//! PicGo / PicList: the user's own uploader, reached over its local HTTP server.
//!
//! The server takes paths, not bytes, so the image is written to a temporary
//! file for as long as the request takes. Which host it lands on, and under what
//! name, is PicGo's business; the credentials never pass through this app.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use super::config::PicgoConfig;
use super::{http_client, preview, response_text, send, upload_failed, TempImage};
use crate::models::WorkspaceError;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PicgoResponse {
    success: bool,
    result: Vec<String>,
}

/// The address as an error may show it: a PicList key rides in the query.
fn address_without_query(server_url: &str) -> String {
    match reqwest::Url::parse(server_url) {
        Ok(mut url) => {
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "the configured address".to_string(),
    }
}

pub(super) fn upload(
    config: &PicgoConfig,
    bytes: &[u8],
    extension: &str,
    timeout: Duration,
) -> Result<String, WorkspaceError> {
    let image = TempImage::write(bytes, extension)?;
    let server_url = config.server_url.trim();
    let label = format!("the PicGo server at {}", address_without_query(server_url));

    let client = http_client(timeout)?;
    let response = send(
        client
            .post(server_url)
            .json(&json!({ "list": [image.path_str()?] })),
        &label,
        timeout,
    )?;

    let status = response.status();
    let body = response_text(response);
    if !status.is_success() {
        return Err(upload_failed(format!(
            "{label} returned HTTP {}: {}",
            status.as_u16(),
            preview(&body)
        )));
    }

    let reply: PicgoResponse = serde_json::from_str(&body).map_err(|_| {
        upload_failed(format!("{label} returned a reply that is not JSON: {}", preview(&body)))
    })?;
    match reply.result.into_iter().next() {
        Some(url) if reply.success => Ok(url.trim().to_string()),
        _ => Err(upload_failed(format!(
            "{label} reported the upload as failed: {}",
            preview(&body)
        ))),
    }
}
