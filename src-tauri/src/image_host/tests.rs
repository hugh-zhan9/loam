use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::json;

use super::command;
use super::config::{
    load_config_from_path, object_key, update_config_at_path, CommandConfig, GithubConfig,
    GithubConfigUpdate, ImageHostConfig, ImageHostConfigUpdate, PicgoConfig, S3Config,
    S3ConfigUpdate, DEFAULT_PICGO_SERVER_URL,
};
use super::{github, picgo, s3, upload_image_at_config_path};
use crate::assets::sha256_hex;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 1, 2, 3, 4];
const SHORT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// A request/response HTTP server just big enough for these tests.

#[derive(Debug, Clone)]
struct Captured {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Captured {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("request body is JSON")
    }
}

/// Answers `count` requests in turn, each by calling `respond` on it.
fn serve<F>(count: usize, mut respond: F) -> (String, thread::JoinHandle<Vec<Captured>>)
where
    F: FnMut(&Captured) -> (u16, String) + Send + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = thread::spawn(move || {
        let mut captured = Vec::new();
        for _ in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let (status, body) = respond(&request);
            let reply = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
            captured.push(request);
        }
        captured
    });
    (base, handle)
}

fn read_request(stream: &mut TcpStream) -> Captured {
    let mut data = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0, "connection closed before the request headers ended");
        data.extend_from_slice(&chunk[..read]);
        if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
    };
    let head = String::from_utf8_lossy(&data[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap().split(' ');
    let method = request_line.next().unwrap().to_string();
    let target = request_line.next().unwrap().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(key, _)| key == "content-length")
        .map(|(_, value)| value.parse().unwrap())
        .unwrap_or(0);
    let mut body = data[header_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0, "connection closed before the request body ended");
        body.extend_from_slice(&chunk[..read]);
    }
    Captured {
        method,
        target,
        headers,
        body,
    }
}

/// A port nothing is listening on.
fn closed_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

fn png_name() -> String {
    format!("{}.png", sha256_hex(PNG))
}

// ---------------------------------------------------------------------------
// Config: storage, secrets, validation.

/// Canonical, as the LLM config tests do: on macOS the temporary directory sits
/// under `/var`, a symlink, and a config path through a symlink is refused.
fn config_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().unwrap().join(".loam").join("image-host.json")
}

fn s3_update(secret: &str, preserve: bool) -> ImageHostConfigUpdate {
    ImageHostConfigUpdate {
        enabled: true,
        provider: "s3".to_string(),
        s3: S3ConfigUpdate {
            endpoint: "https://s3.us-east-1.amazonaws.com".to_string(),
            region: "us-east-1".to_string(),
            bucket: "images".to_string(),
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: secret.to_string(),
            preserve_secret_access_key: preserve,
            public_base_url: "https://cdn.example.com".to_string(),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn missing_config_reads_as_the_defaults_without_creating_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);

    let config = load_config_from_path(&path).unwrap();

    assert_eq!(config, ImageHostConfig::default());
    assert!(!config.enabled);
    assert_eq!(config.provider, "picgo");
    assert_eq!(config.picgo.server_url, DEFAULT_PICGO_SERVER_URL);
    assert_eq!(config.github.branch, "main");
    assert!(!path.exists());
}

#[test]
fn saved_secrets_stay_in_the_file_and_out_of_the_public_config() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);

    let mut update = s3_update("s3-secret-value", false);
    update.github = GithubConfigUpdate {
        owner: "octo".to_string(),
        repo: "pics".to_string(),
        branch: "main".to_string(),
        token: "ghp_token_value".to_string(),
        ..Default::default()
    };
    let public = update_config_at_path(&path, update).unwrap();

    assert!(public.s3.has_secret_access_key);
    assert!(public.github.has_token);
    let public_json = serde_json::to_string(&public).unwrap();
    assert!(!public_json.contains("s3-secret-value"));
    assert!(!public_json.contains("ghp_token_value"));
    assert!(public_json.contains("\"hasSecretAccessKey\":true"));

    let stored = fs::read_to_string(&path).unwrap();
    assert!(stored.contains("s3-secret-value"));
    assert!(stored.contains("ghp_token_value"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn a_preserved_secret_is_kept_and_a_blank_one_is_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);
    update_config_at_path(&path, s3_update("first-secret", false)).unwrap();

    let kept = update_config_at_path(&path, s3_update("", true)).unwrap();
    assert!(kept.s3.has_secret_access_key);
    assert_eq!(
        load_config_from_path(&path).unwrap().s3.secret_access_key.as_deref(),
        Some("first-secret")
    );

    let mut clearing = s3_update("", false);
    clearing.enabled = false;
    let cleared = update_config_at_path(&path, clearing).unwrap();
    assert!(!cleared.s3.has_secret_access_key);
    assert_eq!(load_config_from_path(&path).unwrap().s3.secret_access_key, None);
}

#[test]
fn enabling_an_incomplete_provider_is_refused_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);
    let mut update = s3_update("secret", false);
    update.s3.bucket = "  ".to_string();

    let error = update_config_at_path(&path, update).unwrap_err();

    assert_eq!(error.error_code(), "image_host_config_invalid");
    assert!(error.to_string().contains("s3.bucket"), "{error}");
    assert!(!path.exists());
}

#[test]
fn an_incomplete_provider_can_be_saved_while_the_host_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);
    let mut update = s3_update("", false);
    update.enabled = false;
    update.s3.bucket = String::new();

    let saved = update_config_at_path(&path, update).unwrap();

    assert!(!saved.enabled);
    assert_eq!(saved.provider, "s3");
    assert!(path.exists());
}

#[test]
fn validation_names_the_field_it_rejects() {
    let cases: Vec<(ImageHostConfig, &str)> = vec![
        (
            ImageHostConfig {
                enabled: true,
                picgo: PicgoConfig {
                    server_url: "127.0.0.1:36677".to_string(),
                },
                ..Default::default()
            },
            "picgo.serverUrl",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "command".to_string(),
                ..Default::default()
            },
            "command.command",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "s3".to_string(),
                s3: S3Config {
                    endpoint: "https://s3.example.com/bucket".to_string(),
                    ..Default::default()
                },
                ..Default::default()
            },
            "s3.endpoint",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "s3".to_string(),
                s3: S3Config {
                    endpoint: "https://s3.example.com".to_string(),
                    region: "auto".to_string(),
                    bucket: "images".to_string(),
                    access_key_id: "id".to_string(),
                    secret_access_key: Some("secret".to_string()),
                    public_base_url: "https://cdn.example.com".to_string(),
                    path_prefix: "blog/../x".to_string(),
                    ..Default::default()
                },
                ..Default::default()
            },
            "s3.pathPrefix",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "github".to_string(),
                github: GithubConfig {
                    owner: "octo".to_string(),
                    repo: "pics".to_string(),
                    ..Default::default()
                },
                ..Default::default()
            },
            "github.token",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "github".to_string(),
                github: GithubConfig {
                    owner: "..".to_string(),
                    repo: "pics".to_string(),
                    token: Some("token".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            },
            "github.owner",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "github".to_string(),
                github: GithubConfig {
                    owner: "octo".to_string(),
                    repo: "pics".to_string(),
                    branch: "issue#12".to_string(),
                    token: Some("token".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            },
            "github.branch",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "github".to_string(),
                github: GithubConfig {
                    owner: "octo".to_string(),
                    repo: ".".to_string(),
                    token: Some("token".to_string()),
                    ..Default::default()
                },
                ..Default::default()
            },
            "github.repo",
        ),
        (
            ImageHostConfig {
                enabled: true,
                provider: "gitee".to_string(),
                ..Default::default()
            },
            "gitee",
        ),
    ];

    for (config, field) in cases {
        let error = super::config::validate(&config).unwrap_err();
        assert_eq!(error.error_code(), "image_host_config_invalid");
        assert!(error.to_string().contains(field), "{field}: {error}");
    }
}

#[test]
fn github_branch_names_that_would_break_the_inserted_link_are_refused() {
    for branch in ["50%off", "what?", "feat(x)", "<b>", "../main", "/main", "a b"] {
        let config = ImageHostConfig {
            enabled: true,
            provider: "github".to_string(),
            github: GithubConfig {
                owner: "octo".to_string(),
                repo: "pics".to_string(),
                branch: branch.to_string(),
                token: Some("token".to_string()),
                ..Default::default()
            },
            ..Default::default()
        };
        let error = super::config::validate(&config).unwrap_err();
        assert!(error.to_string().contains("github.branch"), "{branch}: {error}");
    }

    for branch in ["main", "feature/image-host", "release-1.2_x"] {
        let config = ImageHostConfig {
            enabled: true,
            provider: "github".to_string(),
            github: GithubConfig {
                owner: "octo".to_string(),
                repo: "pics".to_string(),
                branch: branch.to_string(),
                token: Some("token".to_string()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(super::config::validate(&config).is_ok(), "{branch}");
    }
}

#[test]
fn a_damaged_config_fails_to_load_and_saving_replaces_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "{ not json").unwrap();

    let error = load_config_from_path(&path).unwrap_err();
    assert_eq!(error.error_code(), "image_host_config_load_failed");

    // What a settings page that could not load the file sends: no preserve flags.
    let mut repair = s3_update("", false);
    repair.enabled = false;
    update_config_at_path(&path, repair).unwrap();
    assert_eq!(load_config_from_path(&path).unwrap().provider, "s3");
}

#[cfg(unix)]
#[test]
fn a_symlinked_config_directory_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, dir.path().join(".loam")).unwrap();

    let error = update_config_at_path(&config_path(&dir), s3_update("secret", false)).unwrap_err();

    assert_eq!(error.error_code(), "path_type_conflict");
    assert!(error.to_string().contains("cannot be written"), "{error}");
    assert!(!real.join("image-host.json").exists());
}

#[cfg(unix)]
#[test]
fn a_symlinked_config_directory_without_a_config_reads_as_off() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().canonicalize().unwrap().join("dotfiles-loam");
    fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, dir.path().join(".loam")).unwrap();

    // What every paste asks first, with the host never configured: a local
    // save must go ahead as it did before there was an image host.
    let config = load_config_from_path(&config_path(&dir)).unwrap();
    assert!(!config.enabled);

    // A file that is there is still only read through a path without symlinks.
    fs::write(real.join("image-host.json"), "{\"enabled\": true}").unwrap();
    let error = load_config_from_path(&config_path(&dir)).unwrap_err();
    assert_eq!(error.error_code(), "path_type_conflict");
    // Shown on every paste, so it has to say which file and why.
    let message = error.to_string();
    assert!(message.contains("image-host.json"), "{message}");
    assert!(message.contains("symlink"), "{message}");
}

#[test]
fn no_home_directory_means_no_config_and_the_host_off() {
    let off = super::public_config_at(Err(crate::models::WorkspaceError::new(
        "asset_path_failed",
        "home directory is not set",
    )))
    .unwrap();
    assert!(!off.enabled);

    let other = super::public_config_at(Err(crate::models::WorkspaceError::new(
        "path_type_conflict",
        "something else",
    )))
    .unwrap_err();
    assert_eq!(other.error_code(), "path_type_conflict");
}

#[test]
fn debug_output_never_shows_a_secret() {
    let config = ImageHostConfig {
        s3: S3Config {
            secret_access_key: Some("s3-secret-value".to_string()),
            ..Default::default()
        },
        github: GithubConfig {
            token: Some("ghp_token_value".to_string()),
            ..Default::default()
        },
        ..Default::default()
    };
    let update = s3_update("typed-secret", false);

    let printed = format!("{config:?} {update:?}");

    assert!(!printed.contains("s3-secret-value"), "{printed}");
    assert!(!printed.contains("ghp_token_value"), "{printed}");
    assert!(!printed.contains("typed-secret"), "{printed}");
    assert!(printed.contains("<redacted>"), "{printed}");
}

#[test]
fn object_keys_are_the_content_hash_under_the_prefix() {
    let name = png_name();
    assert_eq!(object_key("", PNG, "png"), name);
    assert_eq!(object_key("/blog/2026/", PNG, "png"), format!("blog/2026/{name}"));
    assert_eq!(object_key("img", PNG, "png"), format!("img/{name}"));
}

// ---------------------------------------------------------------------------
// Dispatch: what `upload_image_to_host` does before any provider runs.

fn write_config(dir: &tempfile::TempDir, config: &ImageHostConfig) -> PathBuf {
    let path = config_path(dir);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, serde_json::to_vec(config).unwrap()).unwrap();
    path
}

fn picgo_config(server_url: String) -> ImageHostConfig {
    ImageHostConfig {
        enabled: true,
        provider: "picgo".to_string(),
        picgo: PicgoConfig { server_url },
        ..Default::default()
    }
}

#[test]
fn upload_is_refused_while_the_host_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);

    let error = upload_image_at_config_path(&path, "paste.png", PNG, SHORT).unwrap_err();

    assert_eq!(error.error_code(), "image_host_disabled");
}

#[test]
fn upload_reports_a_damaged_config_instead_of_treating_it_as_off() {
    let dir = tempfile::tempdir().unwrap();
    let path = config_path(&dir);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "[]").unwrap();

    let error = upload_image_at_config_path(&path, "paste.png", PNG, SHORT).unwrap_err();

    assert_eq!(error.error_code(), "image_host_config_load_failed");
}

#[test]
fn upload_validates_a_hand_edited_config() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(
        &dir,
        &ImageHostConfig {
            enabled: true,
            provider: "s3".to_string(),
            ..Default::default()
        },
    );

    let error = upload_image_at_config_path(&path, "paste.png", PNG, SHORT).unwrap_err();

    assert_eq!(error.error_code(), "image_host_config_invalid");
}

#[test]
fn upload_refuses_an_unsupported_extension() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(&dir, &picgo_config(format!("http://127.0.0.1:{}/upload", closed_port())));

    let error = upload_image_at_config_path(&path, "notes.txt", PNG, SHORT).unwrap_err();

    assert_eq!(error.error_code(), "invalid_name");
}

#[test]
fn upload_returns_the_url_the_provider_reported() {
    let (base, server) = serve(1, |_| {
        (200, json!({"success": true, "result": ["https://img.example/a.png"]}).to_string())
    });
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(&dir, &picgo_config(format!("{base}/upload")));

    let uploaded = upload_image_at_config_path(&path, "paste.png", PNG, SHORT).unwrap();

    assert_eq!(uploaded.url, "https://img.example/a.png");
    server.join().unwrap();
}

#[test]
fn upload_rejects_a_reply_that_is_not_a_url() {
    let (base, server) = serve(1, |_| {
        (200, json!({"success": true, "result": ["/local/a.png"]}).to_string())
    });
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(&dir, &picgo_config(format!("{base}/upload")));

    let error = upload_image_at_config_path(&path, "paste.png", PNG, SHORT).unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    server.join().unwrap();
}

#[test]
fn upload_refuses_a_url_that_would_break_the_markdown_image() {
    for returned in ["https://img.example/a b.png", "https://img.example/a(1).png"] {
        let reply = json!({"success": true, "result": [returned]}).to_string();
        let (base, server) = serve(1, move |_| (200, reply.clone()));
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(&dir, &picgo_config(format!("{base}/upload")));

        let error = upload_image_at_config_path(&path, "paste.png", PNG, SHORT).unwrap_err();

        assert_eq!(error.error_code(), "image_host_upload_failed", "{returned}");
        assert!(error.to_string().contains("Markdown"), "{error}");
        server.join().unwrap();
    }
}

#[test]
fn configured_addresses_that_would_break_the_markdown_image_are_refused() {
    let config = ImageHostConfig {
        enabled: true,
        provider: "s3".to_string(),
        s3: S3Config {
            endpoint: "https://s3.example.com".to_string(),
            region: "auto".to_string(),
            bucket: "images".to_string(),
            access_key_id: "id".to_string(),
            secret_access_key: Some("secret".to_string()),
            public_base_url: "https://cdn.example.com/a(b)".to_string(),
            ..Default::default()
        },
        ..Default::default()
    };

    let error = super::config::validate(&config).unwrap_err();

    assert!(error.to_string().contains("s3.publicBaseUrl"), "{error}");
}

// ---------------------------------------------------------------------------
// PicGo / PicList.

#[test]
fn picgo_uploads_a_temporary_file_that_is_gone_afterwards() {
    let (base, server) = serve(1, |request| {
        let path = request.json()["list"][0].as_str().unwrap().to_string();
        // Read while the request is open: the file only has to live that long.
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes, PNG);
        (200, json!({"success": true, "result": ["https://img.example/a.png"]}).to_string())
    });

    let url = picgo::upload(
        &PicgoConfig {
            server_url: format!("{base}/upload"),
        },
        PNG,
        "png",
        SHORT,
    )
    .unwrap();

    assert_eq!(url, "https://img.example/a.png");
    let captured = server.join().unwrap();
    assert_eq!(captured[0].method, "POST");
    assert_eq!(captured[0].target, "/upload");
    let sent = PathBuf::from(captured[0].json()["list"][0].as_str().unwrap());
    assert_eq!(sent.file_name().unwrap().to_str().unwrap(), png_name());
    assert!(!sent.exists());
    assert!(!sent.parent().unwrap().exists());
}

#[test]
fn picgo_that_is_not_running_is_reported_with_its_address() {
    let server_url = format!("http://127.0.0.1:{}/upload", closed_port());

    let error = picgo::upload(
        &PicgoConfig {
            server_url: server_url.clone(),
        },
        PNG,
        "png",
        SHORT,
    )
    .unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    assert!(error.to_string().contains(&server_url), "{error}");
}

#[test]
fn a_picgo_key_in_the_address_stays_out_of_errors() {
    let server_url = format!("http://127.0.0.1:{}/upload?key=picgo-secret-key", closed_port());

    let error = picgo::upload(&PicgoConfig { server_url }, PNG, "png", SHORT).unwrap_err();

    let message = error.to_string();
    assert!(!message.contains("picgo-secret-key"), "{message}");
    assert!(message.contains("127.0.0.1"), "{message}");
}

#[test]
fn picgo_reporting_failure_is_an_upload_failure() {
    let (base, server) = serve(1, |_| {
        (200, json!({"success": false, "message": "upload error"}).to_string())
    });

    let error = picgo::upload(
        &PicgoConfig {
            server_url: format!("{base}/upload"),
        },
        PNG,
        "png",
        SHORT,
    )
    .unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    assert!(error.to_string().contains("upload error"), "{error}");
    server.join().unwrap();
}

#[test]
fn picgo_that_never_answers_times_out() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_secs(3));
        drop(stream);
    });

    let started = Instant::now();
    let error = picgo::upload(
        &PicgoConfig {
            server_url: format!("http://127.0.0.1:{port}/upload"),
        },
        PNG,
        "png",
        Duration::from_millis(400),
    )
    .unwrap_err();

    assert_eq!(error.error_code(), "image_host_timeout");
    assert!(started.elapsed() < Duration::from_secs(2));
    server.join().unwrap();
}

// ---------------------------------------------------------------------------
// Custom command.

fn script(dir: &Path, name: &str, body: &str) -> CommandConfig {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    CommandConfig {
        command: format!("'{}'", path.display()),
    }
}

fn run_command(config: &CommandConfig, timeout: Duration) -> Result<String, crate::models::WorkspaceError> {
    command::upload(config, PNG, "png", timeout, Path::new("/bin/sh"))
}

#[test]
fn command_output_yields_its_last_url_and_the_image_is_removed() {
    let dir = tempfile::tempdir().unwrap();
    let seen = dir.path().join("seen");
    let config = script(
        dir.path(),
        "upload.sh",
        &format!(
            "echo \"$1\" > '{seen}'\necho '[PicGo INFO] uploading https://example.com/ignored.png'\necho 'https://img.example/last.png'",
            seen = seen.display()
        ),
    );

    let url = run_command(&config, SHORT).unwrap();

    assert_eq!(url, "https://img.example/last.png");
    let image_path = PathBuf::from(fs::read_to_string(&seen).unwrap().trim());
    assert_eq!(image_path.file_name().unwrap().to_str().unwrap(), png_name());
    assert!(!image_path.exists());
}

#[test]
fn command_receives_the_image_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("copy.png");
    let config = script(
        dir.path(),
        "upload.sh",
        &format!("cp \"$1\" '{}'\necho https://img.example/a.png", copy.display()),
    );

    run_command(&config, SHORT).unwrap();

    assert_eq!(fs::read(&copy).unwrap(), PNG);
}

#[test]
fn a_failing_command_reports_its_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let config = script(dir.path(), "upload.sh", "echo 'access denied' >&2\nexit 1");

    let error = run_command(&config, SHORT).unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    assert!(error.to_string().contains("access denied"), "{error}");
}

#[test]
fn a_command_that_prints_no_url_fails() {
    let dir = tempfile::tempdir().unwrap();
    let config = script(dir.path(), "upload.sh", "echo done");

    let error = run_command(&config, SHORT).unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    assert!(error.to_string().contains("no URL"), "{error}");
}

#[test]
fn a_command_that_runs_too_long_is_stopped_and_its_image_removed() {
    let dir = tempfile::tempdir().unwrap();
    let seen = dir.path().join("seen");
    let config = script(
        dir.path(),
        "upload.sh",
        &format!(
            "echo \"$1\" > '{}'\nsleep 8\necho https://img.example/late.png",
            seen.display()
        ),
    );

    // Long enough for a login shell to start under a loaded test run and
    // record the image path, far shorter than the script's sleep.
    let started = Instant::now();
    let error = run_command(&config, Duration::from_secs(2)).unwrap_err();

    assert_eq!(error.error_code(), "image_host_timeout");
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    let recorded = fs::read_to_string(&seen)
        .expect("the script should have recorded the image path before the deadline");
    assert!(!PathBuf::from(recorded.trim()).exists());
}

#[test]
fn a_command_that_leaves_a_process_holding_its_output_still_returns_promptly() {
    let dir = tempfile::tempdir().unwrap();
    // The background sleep inherits stdout and keeps it open after the script
    // itself has exited and printed its URL.
    let config = script(
        dir.path(),
        "upload.sh",
        "sleep 6 &\necho https://img.example/background.png",
    );

    let started = Instant::now();
    let url = run_command(&config, Duration::from_secs(20)).unwrap();

    assert_eq!(url, "https://img.example/background.png");
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}

#[test]
fn a_command_with_more_output_than_a_pipe_holds_still_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let config = script(
        dir.path(),
        "upload.sh",
        "i=0\nwhile [ $i -lt 4000 ]; do echo 'progress line that pads the pipe past its buffer'; i=$((i+1)); done\necho https://img.example/big.png",
    );

    let url = run_command(&config, Duration::from_secs(20)).unwrap();

    assert_eq!(url, "https://img.example/big.png");
}

#[test]
fn last_url_picks_the_final_address_and_stops_at_delimiters() {
    assert_eq!(
        command::last_url("a https://x.test/1.png\nb \"https://x.test/2.png\"\n"),
        Some("https://x.test/2.png")
    );
    assert_eq!(command::last_url("http://x.test/a.png"), Some("http://x.test/a.png"));
    assert_eq!(command::last_url("nothing here"), None);
    // Uploaders that print Markdown themselves.
    assert_eq!(
        command::last_url("![](https://x.test/a.png)"),
        Some("https://x.test/a.png")
    );
    assert_eq!(command::last_url("https://"), None);
}

// ---------------------------------------------------------------------------
// S3.

fn aws_example(
    method: &'static str,
    uri: &'static str,
    query: &'static str,
    headers: &[(&'static str, String)],
    payload_hash: &str,
) -> String {
    s3::authorization_header(&s3::SigningRequest {
        method,
        canonical_uri: uri,
        canonical_query: query,
        headers,
        payload_hash,
        amz_date: "20130524T000000Z",
        region: "us-east-1",
        service: "s3",
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    })
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// The worked examples in AWS's "Signature Calculations for the Authorization
/// Header" documentation for S3.
#[test]
fn signing_reproduces_the_aws_documented_examples() {
    let put_payload = sha256_hex(b"Welcome to Amazon S3.");
    assert_eq!(
        put_payload,
        "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
    );
    let put = aws_example(
        "PUT",
        "/test%24file.text",
        "",
        &[
            ("date", "Fri, 24 May 2013 00:00:00 GMT".to_string()),
            ("host", "examplebucket.s3.amazonaws.com".to_string()),
            ("x-amz-content-sha256", put_payload.clone()),
            ("x-amz-date", "20130524T000000Z".to_string()),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY".to_string()),
        ],
        &put_payload,
    );
    assert!(
        put.ends_with("Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"),
        "{put}"
    );
    assert!(put.contains(
        "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,"
    ));

    let get = aws_example(
        "GET",
        "/test.txt",
        "",
        &[
            ("host", "examplebucket.s3.amazonaws.com".to_string()),
            ("range", "bytes=0-9".to_string()),
            ("x-amz-content-sha256", EMPTY_SHA256.to_string()),
            ("x-amz-date", "20130524T000000Z".to_string()),
        ],
        EMPTY_SHA256,
    );
    assert!(
        get.ends_with("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"),
        "{get}"
    );

    let list = aws_example(
        "GET",
        "/",
        "max-keys=2&prefix=J",
        &[
            ("host", "examplebucket.s3.amazonaws.com".to_string()),
            ("x-amz-content-sha256", EMPTY_SHA256.to_string()),
            ("x-amz-date", "20130524T000000Z".to_string()),
        ],
        EMPTY_SHA256,
    );
    assert!(
        list.ends_with("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"),
        "{list}"
    );
}

fn s3_config(endpoint: &str, path_style: bool) -> S3Config {
    S3Config {
        endpoint: endpoint.to_string(),
        region: "auto".to_string(),
        bucket: "images".to_string(),
        access_key_id: "AKIDEXAMPLE".to_string(),
        secret_access_key: Some("s3-secret-value".to_string()),
        path_style,
        path_prefix: "blog/2026".to_string(),
        public_base_url: "https://cdn.example.com/".to_string(),
    }
}

#[test]
fn s3_addresses_follow_the_bucket_style() {
    let virtual_hosted =
        s3::request_target(&s3_config("https://s3.us-east-1.amazonaws.com:443", false), "a/b.png")
            .unwrap();
    assert_eq!(virtual_hosted.url, "https://images.s3.us-east-1.amazonaws.com/a/b.png");
    assert_eq!(virtual_hosted.host, "images.s3.us-east-1.amazonaws.com");
    assert_eq!(virtual_hosted.path, "/a/b.png");

    let path_style = s3::request_target(&s3_config("http://minio.local:9000", true), "a/b.png").unwrap();
    assert_eq!(path_style.url, "http://minio.local:9000/images/a/b.png");
    assert_eq!(path_style.host, "minio.local:9000");
    assert_eq!(path_style.path, "/images/a/b.png");
}

#[test]
fn s3_put_is_signed_over_what_is_actually_sent() {
    let (base, server) = serve(1, |_| (200, String::new()));
    let config = s3_config(&base, true);
    let now = time::Date::from_calendar_date(2026, time::Month::September, 28)
        .unwrap()
        .with_hms(8, 30, 5)
        .unwrap()
        .assume_utc();

    let url = s3::upload(&config, PNG, "png", SHORT, now).unwrap();

    assert_eq!(url, format!("https://cdn.example.com/blog/2026/{}", png_name()));
    let request = &server.join().unwrap()[0];
    assert_eq!(request.method, "PUT");
    assert_eq!(request.target, format!("/images/blog/2026/{}", png_name()));
    assert_eq!(request.body, PNG);
    assert_eq!(request.header("content-type"), Some("image/png"));
    assert_eq!(request.header("x-amz-date"), Some("20260928T083005Z"));
    assert_eq!(request.header("x-amz-content-sha256"), Some(sha256_hex(PNG).as_str()));

    // Recompute from what arrived: a Host header that differed from the one
    // signed would make every real upload fail with SignatureDoesNotMatch.
    let received = [
        ("content-type", request.header("content-type").unwrap().to_string()),
        ("host", request.header("host").unwrap().to_string()),
        ("x-amz-content-sha256", request.header("x-amz-content-sha256").unwrap().to_string()),
        ("x-amz-date", request.header("x-amz-date").unwrap().to_string()),
    ];
    let expected = s3::authorization_header(&s3::SigningRequest {
        method: "PUT",
        canonical_uri: &request.target,
        canonical_query: "",
        headers: &received,
        payload_hash: &sha256_hex(PNG),
        amz_date: "20260928T083005Z",
        region: "auto",
        service: "s3",
        access_key_id: "AKIDEXAMPLE",
        secret_access_key: "s3-secret-value",
    });
    assert_eq!(request.header("authorization"), Some(expected.as_str()));
    assert!(expected.contains("Credential=AKIDEXAMPLE/20260928/auto/s3/aws4_request"));
}

#[test]
fn s3_refusal_is_reported_without_the_secret() {
    let (base, server) = serve(1, |_| {
        (
            403,
            "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>".to_string(),
        )
    });

    let error = s3::upload(
        &s3_config(&base, true),
        PNG,
        "png",
        SHORT,
        time::OffsetDateTime::now_utc(),
    )
    .unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    let message = error.to_string();
    assert!(message.contains("S3 HTTP 403"), "{message}");
    assert!(message.contains("AccessDenied"), "{message}");
    assert!(!message.contains("s3-secret-value"), "{message}");
    server.join().unwrap();
}

// ---------------------------------------------------------------------------
// GitHub.

fn github_config(custom_base_url: &str) -> GithubConfig {
    GithubConfig {
        owner: "octo".to_string(),
        repo: "pics".to_string(),
        branch: "main".to_string(),
        path_prefix: "img".to_string(),
        token: Some("ghp_token_value".to_string()),
        custom_base_url: custom_base_url.to_string(),
    }
}

#[test]
fn github_creates_the_file_and_links_its_raw_address() {
    let (base, server) = serve(1, |_| (201, json!({"content": {}}).to_string()));

    let url = github::upload(&github_config(""), PNG, "png", SHORT, &base).unwrap();

    assert_eq!(
        url,
        format!("https://raw.githubusercontent.com/octo/pics/main/img/{}", png_name())
    );
    let request = &server.join().unwrap()[0];
    assert_eq!(request.method, "PUT");
    assert_eq!(request.target, format!("/repos/octo/pics/contents/img/{}", png_name()));
    assert_eq!(request.header("authorization"), Some("Bearer ghp_token_value"));
    assert_eq!(request.header("user-agent"), Some("Loam"));
    assert_eq!(request.header("accept"), Some("application/vnd.github+json"));
    let body = request.json();
    assert_eq!(body["branch"], "main");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(body["content"].as_str().unwrap())
            .unwrap(),
        PNG
    );
}

#[test]
fn github_links_through_a_custom_base_url() {
    let (base, server) = serve(1, |_| (201, "{}".to_string()));

    let url = github::upload(
        &github_config("https://cdn.jsdelivr.net/gh/octo/pics@main/"),
        PNG,
        "png",
        SHORT,
        &base,
    )
    .unwrap();

    assert_eq!(url, format!("https://cdn.jsdelivr.net/gh/octo/pics@main/img/{}", png_name()));
    server.join().unwrap();
}

#[test]
fn github_treats_an_existing_file_as_this_image() {
    let (base, server) = serve(2, |request| {
        if request.method == "PUT" {
            (422, json!({"message": "Invalid request. \"sha\" wasn't supplied."}).to_string())
        } else {
            (200, json!({"sha": "abc"}).to_string())
        }
    });

    let url = github::upload(&github_config(""), PNG, "png", SHORT, &base).unwrap();

    assert!(url.ends_with(&png_name()));
    let requests = server.join().unwrap();
    assert_eq!(requests[1].method, "GET");
    assert_eq!(
        requests[1].target,
        format!("/repos/octo/pics/contents/img/{}?ref=main", png_name())
    );
}

#[test]
fn github_422_without_an_existing_file_fails() {
    let (base, server) = serve(2, |request| {
        if request.method == "PUT" {
            (422, json!({"message": "Validation Failed"}).to_string())
        } else {
            (404, json!({"message": "Not Found"}).to_string())
        }
    });

    let error = github::upload(&github_config(""), PNG, "png", SHORT, &base).unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    assert!(error.to_string().contains("GitHub HTTP 422: Validation Failed"), "{error}");
    server.join().unwrap();
}

#[test]
fn github_bad_credentials_are_reported_without_the_token() {
    let (base, server) = serve(1, |_| (401, json!({"message": "Bad credentials"}).to_string()));

    let error = github::upload(&github_config(""), PNG, "png", SHORT, &base).unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    let message = error.to_string();
    assert!(message.contains("GitHub HTTP 401: Bad credentials"), "{message}");
    assert!(!message.contains("ghp_token_value"), "{message}");
    server.join().unwrap();
}

#[test]
fn github_checking_an_existing_file_stays_within_the_upload_budget() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    thread::spawn(move || {
        // The PUT uses most of the budget, then the GET would take far longer.
        let (mut put, _) = listener.accept().unwrap();
        read_request(&mut put);
        thread::sleep(Duration::from_millis(1600));
        let body = r#"{"message":"exists"}"#;
        let _ = put.write_all(
            format!(
                "HTTP/1.1 422 Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );
        drop(put);
        if let Ok((get, _)) = listener.accept() {
            thread::sleep(Duration::from_secs(5));
            drop(get);
        }
    });

    let started = Instant::now();
    let error = github::upload(
        &github_config(""),
        PNG,
        "png",
        Duration::from_secs(2),
        &base,
    )
    .unwrap_err();

    assert_eq!(error.error_code(), "image_host_upload_failed");
    // About 2s with one shared budget; a GET with a budget of its own would
    // add another 2s on top.
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
}
