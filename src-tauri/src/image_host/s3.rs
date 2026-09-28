//! S3-compatible object storage: AWS S3, Cloudflare R2, MinIO, and the S3
//! endpoints of Aliyun OSS, Tencent COS and the like.
//!
//! One signed PUT per image. Whether the object is publicly readable is the
//! bucket's policy, not a header sent here — R2 has no ACLs to set.

use std::time::Duration;

use hmac::{Hmac, Mac};
use reqwest::Url;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use super::config::{object_key, S3Config};
use super::{http_client, preview, response_text, send, upload_failed};
use crate::assets::{mime_type_for_extension, sha256_hex};
use crate::models::WorkspaceError;

type HmacSha256 = Hmac<Sha256>;

pub(super) fn upload(
    config: &S3Config,
    bytes: &[u8],
    extension: &str,
    timeout: Duration,
    now: OffsetDateTime,
) -> Result<String, WorkspaceError> {
    let key = object_key(&config.path_prefix, bytes, extension);
    let target = request_target(config, &key)?;
    let payload_hash = sha256_hex(bytes);
    let amz_date = amz_date(now);
    let content_type = mime_type_for_extension(extension);

    let headers = [
        ("content-type", content_type.to_string()),
        ("host", target.host.clone()),
        ("x-amz-content-sha256", payload_hash.clone()),
        ("x-amz-date", amz_date.clone()),
    ];
    let authorization = authorization_header(&SigningRequest {
        method: "PUT",
        canonical_uri: &target.path,
        canonical_query: "",
        headers: &headers,
        payload_hash: &payload_hash,
        amz_date: &amz_date,
        region: config.region.trim(),
        service: "s3",
        access_key_id: config.access_key_id.trim(),
        secret_access_key: config.secret_access_key.as_deref().unwrap_or("").trim(),
    });

    let label = format!("S3 at {}", target.host);
    let client = http_client(timeout)?;
    let response = send(
        client
            .put(&target.url)
            .header("Content-Type", content_type)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("Authorization", authorization)
            .body(bytes.to_vec()),
        &label,
        timeout,
    )?;

    let status = response.status();
    if !status.is_success() {
        return Err(upload_failed(format!(
            "S3 HTTP {}: {}",
            status.as_u16(),
            preview(&response_text(response))
        )));
    }

    Ok(format!(
        "{}/{}",
        config.public_base_url.trim().trim_end_matches('/'),
        key
    ))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct RequestTarget {
    pub url: String,
    /// Exactly what the request's Host header will carry: the port only when
    /// it is not the scheme's default, as the HTTP client sends it.
    pub host: String,
    /// The encoded path, which is also the canonical URI that gets signed.
    pub path: String,
}

pub(super) fn request_target(config: &S3Config, key: &str) -> Result<RequestTarget, WorkspaceError> {
    let endpoint = Url::parse(config.endpoint.trim())
        .map_err(|_| upload_failed("invalid URL in s3.endpoint"))?;
    let endpoint_host = endpoint
        .host_str()
        .ok_or_else(|| upload_failed("invalid URL in s3.endpoint"))?;
    let endpoint_host = match endpoint.port() {
        Some(port) => format!("{endpoint_host}:{port}"),
        None => endpoint_host.to_string(),
    };
    let bucket = config.bucket.trim();
    let encoded_key = encode_path(key);

    let (host, path) = if config.path_style {
        (endpoint_host, format!("/{}/{encoded_key}", encode_segment(bucket)))
    } else {
        (format!("{bucket}.{endpoint_host}"), format!("/{encoded_key}"))
    };
    Ok(RequestTarget {
        url: format!("{}://{host}{path}", endpoint.scheme()),
        host,
        path,
    })
}

pub(super) struct SigningRequest<'a> {
    pub method: &'a str,
    pub canonical_uri: &'a str,
    pub canonical_query: &'a str,
    /// Lower-case names; every header listed here is signed.
    pub headers: &'a [(&'a str, String)],
    pub payload_hash: &'a str,
    pub amz_date: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
}

/// AWS Signature Version 4, as an `Authorization` header value.
pub(super) fn authorization_header(request: &SigningRequest<'_>) -> String {
    let mut headers: Vec<(&str, String)> = request
        .headers
        .iter()
        .map(|(name, value)| (*name, value.trim().to_string()))
        .collect();
    headers.sort_by(|left, right| left.0.cmp(right.0));

    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");

    let canonical_request = format!(
        "{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}",
        request.method, request.canonical_uri, request.canonical_query, request.payload_hash
    );
    let date = &request.amz_date[..8];
    let scope = format!("{date}/{}/{}/aws4_request", request.region, request.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        request.amz_date,
        hex(&Sha256::digest(canonical_request.as_bytes()))
    );

    let secret = format!("AWS4{}", request.secret_access_key);
    let key = hmac(secret.as_bytes(), date.as_bytes());
    let key = hmac(&key, request.region.as_bytes());
    let key = hmac(&key, request.service.as_bytes());
    let key = hmac(&key, b"aws4_request");
    let signature = hex(&hmac(&key, string_to_sign.as_bytes()));

    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        request.access_key_id
    )
}

pub(super) fn amz_date(now: OffsetDateTime) -> String {
    let now = now.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

fn encode_path(path: &str) -> String {
    path.split('/').map(encode_segment).collect::<Vec<_>>().join("/")
}

/// RFC 3986 encoding of one path segment, as SigV4 canonicalises it for S3.
fn encode_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
