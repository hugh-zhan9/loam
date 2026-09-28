use std::error::Error as StdError;
use std::fs;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::llm_wiki_models::LlmProviderConfig;
use crate::models::WorkspaceError;
use crate::secret_config_file::SecretConfigFile;

const LLM_RESPONSE_BODY_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const LLM_ERROR_BODY_PREVIEW_LIMIT_BYTES: usize = 16 * 1024;
const LLM_REQUEST_TIMEOUT_SECS: u64 = 90;
const LLM_CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(50);

const LLM_CONFIG_FILE: SecretConfigFile = SecretConfigFile {
    code_prefix: "llm_config",
    label: "llm config",
    default_file_name: "llm-config.json",
};

#[cfg(test)]
pub(crate) fn llm_request_timeout_secs_for_test() -> u64 {
    LLM_REQUEST_TIMEOUT_SECS
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct LlmChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Default)]
pub struct LlmCallControl {
    cancel_checker: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl LlmCallControl {
    pub fn new_cancel_checker(checker: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            cancel_checker: Some(Arc::new(checker)),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancel_checker
            .as_ref()
            .map(|checker| checker())
            .unwrap_or(false)
    }

    fn is_enabled(&self) -> bool {
        self.cancel_checker.is_some()
    }
}

#[allow(dead_code)]
pub fn load_llm_config_from_path(
    path: impl AsRef<Path>,
) -> Result<LlmProviderConfig, WorkspaceError> {
    let path = path.as_ref();
    LLM_CONFIG_FILE.ensure_load_target(path)?;
    read_llm_config_from_path(path)
}

pub fn load_optional_llm_config_from_path(
    path: impl AsRef<Path>,
) -> Result<Option<LlmProviderConfig>, WorkspaceError> {
    let path = path.as_ref();
    if !LLM_CONFIG_FILE.prepare_optional_load(path)? {
        return Ok(None);
    }
    read_llm_config_from_path(path).map(Some)
}

fn read_llm_config_from_path(path: &Path) -> Result<LlmProviderConfig, WorkspaceError> {
    let bytes = fs::read(path).map_err(|error| {
        WorkspaceError::from_io(
            "llm_config_load_failed",
            "failed to read llm config",
            &error,
        )
    })?;

    serde_json::from_slice(&bytes).map_err(|error| {
        WorkspaceError::new(
            "llm_config_parse_failed",
            format!("failed to parse llm config: {error}"),
        )
    })
}

pub fn save_llm_config_to_path(
    path: impl AsRef<Path>,
    config: &LlmProviderConfig,
) -> Result<(), WorkspaceError> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| {
        WorkspaceError::new(
            "llm_config_save_failed",
            format!("failed to serialize llm config: {error}"),
        )
    })?;
    LLM_CONFIG_FILE.save(path.as_ref(), &bytes)
}

#[allow(dead_code)]
pub fn build_openai_chat_request(model: &str, messages: Vec<LlmChatMessage>) -> serde_json::Value {
    json!({
        "model": model,
        "messages": messages,
        "temperature": 0.2,
    })
}

#[allow(dead_code)]
pub fn build_openai_chat_stream_request(
    model: &str,
    messages: Vec<LlmChatMessage>,
) -> serde_json::Value {
    json!({
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "stream": true,
    })
}

#[allow(dead_code)]
pub fn build_openai_responses_request(
    model: &str,
    messages: Vec<LlmChatMessage>,
) -> serde_json::Value {
    json!({
        "model": model,
        "input": messages,
        "temperature": 0.2,
    })
}

#[allow(dead_code)]
pub fn call_chat_completion(
    config: &LlmProviderConfig,
    messages: Vec<LlmChatMessage>,
) -> Result<String, WorkspaceError> {
    call_chat_completion_core(config, messages)
}

pub fn call_chat_completion_with_control(
    config: &LlmProviderConfig,
    messages: Vec<LlmChatMessage>,
    control: LlmCallControl,
) -> Result<String, WorkspaceError> {
    if !control.is_enabled() {
        return call_chat_completion_core(config, messages);
    }

    let config = config.clone();
    run_llm_job_with_control(control, move || {
        call_chat_completion_core(&config, messages)
    })
}

fn call_chat_completion_core(
    config: &LlmProviderConfig,
    messages: Vec<LlmChatMessage>,
) -> Result<String, WorkspaceError> {
    let api_mode = LlmApiMode::from_config(&config.api_mode)?;
    let client = build_llm_http_client()?;

    match api_mode {
        LlmApiMode::Chat => call_chat_completion_streaming_with_fallback(&client, config, messages),
        LlmApiMode::ChatNoStream | LlmApiMode::Responses => {
            call_non_streaming_completion(&client, config, api_mode, messages)
        }
    }
}

fn run_llm_job_with_control<T>(
    control: LlmCallControl,
    job: impl FnOnce() -> Result<T, WorkspaceError> + Send + 'static,
) -> Result<T, WorkspaceError>
where
    T: Send + 'static,
{
    if control.is_cancelled() {
        return Err(llm_cancelled_error());
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(job());
    });

    loop {
        if control.is_cancelled() {
            return Err(llm_cancelled_error());
        }

        match receiver.recv_timeout(LLM_CONTROL_POLL_INTERVAL) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(WorkspaceError::new(
                    "llm_failed",
                    "llm request worker exited before returning a result",
                ));
            }
        }
    }
}

fn llm_cancelled_error() -> WorkspaceError {
    WorkspaceError::new("cancelled", "llm wiki operation was cancelled")
}

fn call_non_streaming_completion(
    client: &reqwest::blocking::Client,
    config: &LlmProviderConfig,
    api_mode: LlmApiMode,
    messages: Vec<LlmChatMessage>,
) -> Result<String, WorkspaceError> {
    let url = api_mode.url(&config.base_url)?;
    let body = api_mode.build_request(&config.model, messages);
    let response = send_llm_request(client, config, url, &body, api_mode.label())?;
    let response = ensure_successful_llm_response(response, api_mode.label())?;
    let bytes =
        read_limited_response_body(response, LLM_RESPONSE_BODY_LIMIT_BYTES, "llm response")?;
    api_mode.extract_content(&bytes)
}

fn call_chat_completion_streaming_with_fallback(
    client: &reqwest::blocking::Client,
    config: &LlmProviderConfig,
    messages: Vec<LlmChatMessage>,
) -> Result<String, WorkspaceError> {
    let url = chat_completions_url(&config.base_url)?;
    let body = build_openai_chat_stream_request(&config.model, messages.clone());
    let stream_result = send_llm_request(client, config, url, &body, "chat completion stream")
        .and_then(|response| ensure_successful_llm_response(response, "chat completion stream"));

    match stream_result {
        Ok(response) => match read_chat_completion_stream(response) {
            Ok(content) => Ok(content),
            Err(error) if should_retry_chat_non_stream_fallback(&error.error) => {
                call_non_streaming_after_stream_failure(client, config, messages, error.error)
            }
            Err(error) => Err(error.error),
        },
        Err(error) if should_retry_chat_non_stream_fallback(&error) => {
            call_non_streaming_after_stream_failure(client, config, messages, error)
        }
        Err(error) => Err(error),
    }
}

fn should_retry_chat_non_stream_fallback(error: &WorkspaceError) -> bool {
    error.error_code() != "cancelled"
}

fn call_non_streaming_after_stream_failure(
    client: &reqwest::blocking::Client,
    config: &LlmProviderConfig,
    messages: Vec<LlmChatMessage>,
    stream_error: WorkspaceError,
) -> Result<String, WorkspaceError> {
    match call_non_streaming_completion(client, config, LlmApiMode::Chat, messages) {
        Ok(content) => Ok(content),
        Err(fallback_error) => Err(WorkspaceError::new(
            "llm_failed",
            format!(
                "{}; non-stream fallback failed: {}",
                stream_error, fallback_error
            ),
        )),
    }
}

fn build_llm_http_client() -> Result<reqwest::blocking::Client, WorkspaceError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(LLM_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| {
            WorkspaceError::new(
                "llm_failed",
                format!("failed to create llm http client: {error}"),
            )
        })
}

fn send_llm_request(
    client: &reqwest::blocking::Client,
    config: &LlmProviderConfig,
    url: String,
    body: &serde_json::Value,
    label: &str,
) -> Result<reqwest::blocking::Response, WorkspaceError> {
    let mut request = client.post(url).json(body);
    if let Some(api_key) = config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        request = request.bearer_auth(api_key);
    }

    request.send().map_err(|error| {
        let error_code = if error.is_timeout() {
            "llm_timeout"
        } else {
            "llm_failed"
        };
        WorkspaceError::new(
            error_code,
            format!(
                "llm {label} request failed after up to {}s: {}",
                LLM_REQUEST_TIMEOUT_SECS,
                format_http_error(&error)
            ),
        )
    })
}

fn ensure_successful_llm_response(
    response: reqwest::blocking::Response,
    label: &str,
) -> Result<reqwest::blocking::Response, WorkspaceError> {
    let status = response.status();

    if status.is_success() {
        return Ok(response);
    }

    let bytes = read_limited_response_body(
        response,
        LLM_ERROR_BODY_PREVIEW_LIMIT_BYTES,
        "llm error response",
    )?;
    let message = parse_openai_error_message(&bytes)
        .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string());
    let message = if message.is_empty() {
        format!("llm {label} returned status {status}")
    } else {
        format!("llm {label} returned status {status}: {message}")
    };
    Err(WorkspaceError::new("llm_failed", message))
}

pub fn default_llm_config_path() -> Result<PathBuf, WorkspaceError> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| {
            WorkspaceError::new("llm_config_path_failed", "home directory is not set")
        })?;
    Ok(PathBuf::from(home).join(".loam").join("llm-config.json"))
}

pub fn llm_config_env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

#[cfg(test)]
pub(crate) fn test_llm_config_env_lock() -> &'static std::sync::Mutex<()> {
    llm_config_env_lock()
}

fn chat_completions_url(base_url: &str) -> Result<String, WorkspaceError> {
    let base_url = base_url.trim();
    if base_url.is_empty() {
        return Err(WorkspaceError::new(
            "llm_failed",
            "llm base url must not be empty",
        ));
    }
    Ok(format!(
        "{}/chat/completions",
        base_url.trim_end_matches('/')
    ))
}

fn responses_url(base_url: &str) -> Result<String, WorkspaceError> {
    let base_url = base_url.trim();
    if base_url.is_empty() {
        return Err(WorkspaceError::new(
            "llm_failed",
            "llm base url must not be empty",
        ));
    }
    Ok(format!("{}/responses", base_url.trim_end_matches('/')))
}

fn parse_openai_error_message(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    value
        .get("error")
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(|message| message.as_str())
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
}

#[allow(dead_code)]
pub fn extract_chat_completion_content(bytes: &[u8]) -> Result<String, WorkspaceError> {
    let response: OpenAiChatCompletionResponse = serde_json::from_slice(bytes).map_err(|_| {
        llm_response_parse_error("chat completion", bytes)
            .expect_err("parse error helper always returns an error")
    })?;
    response
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| {
            WorkspaceError::new(
                "llm_failed",
                "llm chat completion response did not include message content",
            )
        })
}

#[allow(dead_code)]
pub fn extract_chat_completion_stream_content(bytes: &[u8]) -> Result<String, WorkspaceError> {
    read_chat_completion_stream(io::Cursor::new(bytes)).map_err(|error| error.error)
}

fn read_chat_completion_stream(reader: impl Read) -> Result<String, ChatStreamReadError> {
    let mut lines = BufReader::new(reader).lines();
    let mut content = String::new();
    let mut preview = Vec::new();
    let mut saw_terminal = false;
    let mut saw_data = false;

    while let Some(line) = lines.next() {
        let line = line.map_err(|error| {
            ChatStreamReadError::new(
                format!("failed to read llm chat completion stream: {error}"),
                &preview,
                !content.is_empty(),
            )
        })?;
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() || trimmed.starts_with(':') {
            continue;
        }
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        saw_data = true;
        append_preview_bytes(&mut preview, data.as_bytes());
        append_preview_bytes(&mut preview, b"\n");

        if data.trim() == "[DONE]" {
            saw_terminal = true;
            break;
        }

        if let Some(message) = parse_openai_error_message(data.as_bytes()) {
            return Err(ChatStreamReadError::new(
                format!("llm chat completion stream returned error: {message}"),
                &preview,
                !content.is_empty(),
            ));
        }

        let event: OpenAiChatCompletionStreamEvent = serde_json::from_str(data).map_err(|_| {
            ChatStreamReadError::new(
                format!(
                    "failed to parse llm chat completion stream event; stream preview: {}",
                    response_preview(&preview)
                ),
                &preview,
                !content.is_empty(),
            )
        })?;

        for choice in event.choices {
            if let Some(finish_reason) = choice.finish_reason {
                if !finish_reason.is_null() {
                    saw_terminal = true;
                }
            }
            if let Some(part) = choice
                .delta
                .and_then(|delta| delta.content)
                .filter(|content| !content.is_empty())
            {
                content.push_str(&part);
                if content.len() > LLM_RESPONSE_BODY_LIMIT_BYTES {
                    return Err(ChatStreamReadError::new(
                        format!(
                            "llm chat completion stream content exceeded {} byte limit",
                            LLM_RESPONSE_BODY_LIMIT_BYTES
                        ),
                        &preview,
                        true,
                    ));
                }
            }
        }
    }

    if !content.trim().is_empty() && saw_terminal {
        return Ok(content);
    }
    if !content.trim().is_empty() {
        return Err(ChatStreamReadError::with_code(
            "llm_partial_stream",
            format!(
                "llm chat completion stream ended before [DONE]; received partial stream content before failure; stream preview: {}",
                response_preview(&preview)
            ),
        ));
    }

    let noun = if saw_data {
        "delta content"
    } else {
        "SSE data events"
    };
    let terminal_note = if saw_terminal {
        ""
    } else {
        "; stream ended before [DONE]"
    };
    Err(ChatStreamReadError::new(
        format!(
            "llm chat completion stream did not include {noun}{terminal_note}; stream preview: {}",
            response_preview(&preview)
        ),
        &preview,
        false,
    ))
}

#[allow(dead_code)]
pub fn extract_responses_content(bytes: &[u8]) -> Result<String, WorkspaceError> {
    let response: OpenAiResponsesResponse = serde_json::from_slice(bytes).map_err(|_| {
        llm_response_parse_error("responses", bytes)
            .expect_err("parse error helper always returns an error")
    })?;
    let mut parts = Vec::new();
    for output in response.output {
        for content in output.content {
            if content.content_type == "output_text" {
                if let Some(text) = content.text.filter(|text| !text.trim().is_empty()) {
                    parts.push(text);
                }
            }
        }
    }
    if parts.is_empty() {
        return Err(WorkspaceError::new(
            "llm_failed",
            format!(
                "llm responses response did not include output_text content; response preview: {}",
                response_preview(bytes)
            ),
        ));
    }
    Ok(parts.join("\n"))
}

#[allow(dead_code)]
pub fn llm_response_parse_error(noun: &str, bytes: &[u8]) -> Result<(), WorkspaceError> {
    Err(WorkspaceError::new(
        "llm_failed",
        format!(
            "failed to parse llm {noun} response; response preview: {}",
            response_preview(bytes)
        ),
    ))
}

fn response_preview(bytes: &[u8]) -> String {
    const PREVIEW_LIMIT: usize = 800;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(PREVIEW_LIMIT)]);
    let mut preview = text.replace(
        |character: char| character.is_control() && character != '\n',
        " ",
    );
    if bytes.len() > PREVIEW_LIMIT {
        preview.push_str("...");
    }
    preview.trim().to_string()
}

fn append_preview_bytes(preview: &mut Vec<u8>, fragment: &[u8]) {
    const PREVIEW_LIMIT: usize = 800;
    if preview.len() >= PREVIEW_LIMIT {
        return;
    }
    let remaining = PREVIEW_LIMIT - preview.len();
    preview.extend_from_slice(&fragment[..fragment.len().min(remaining)]);
}

fn format_http_error(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(next) = source {
        let text = next.to_string();
        if !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        source = next.source();
    }
    parts.join("; caused by: ")
}

fn read_limited_response_body(
    mut reader: impl Read,
    limit: usize,
    noun: &str,
) -> Result<Vec<u8>, WorkspaceError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            WorkspaceError::new("llm_failed", format!("failed to read {noun}: {error}"))
        })?;
    if bytes.len() > limit {
        return Err(WorkspaceError::new(
            "llm_failed",
            format!("{noun} exceeded {limit} byte limit"),
        ));
    }
    Ok(bytes)
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletionResponse {
    choices: Vec<OpenAiChatChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatChoiceMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletionStreamEvent {
    #[serde(default)]
    choices: Vec<OpenAiChatStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatStreamChoice {
    #[serde(default)]
    delta: Option<OpenAiChatStreamDelta>,
    #[serde(default)]
    finish_reason: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatStreamDelta {
    content: Option<String>,
}

#[derive(Debug)]
struct ChatStreamReadError {
    error: WorkspaceError,
}

impl ChatStreamReadError {
    fn new(message: String, preview: &[u8], received_content: bool) -> Self {
        let message = if received_content {
            format!(
                "{message}; received partial stream content before failure; stream preview: {}",
                response_preview(preview)
            )
        } else {
            message
        };
        Self::with_code("llm_failed", message)
    }

    fn with_code(code: impl Into<String>, message: String) -> Self {
        Self {
            error: WorkspaceError::new(code, message),
        }
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiResponsesResponse {
    output: Vec<OpenAiResponsesOutput>,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponsesOutput {
    #[serde(default)]
    content: Vec<OpenAiResponsesContent>,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponsesContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LlmApiMode {
    Chat,
    ChatNoStream,
    Responses,
}

impl LlmApiMode {
    fn from_config(value: &str) -> Result<Self, WorkspaceError> {
        match value.trim() {
            "" | "chat" => Ok(Self::Chat),
            "chatNoStream" | "chat-no-stream" | "chat_non_stream" => Ok(Self::ChatNoStream),
            "responses" => Ok(Self::Responses),
            other => Err(WorkspaceError::new(
                "llm_failed",
                format!("unsupported llm api mode: {other}"),
            )),
        }
    }

    fn url(self, base_url: &str) -> Result<String, WorkspaceError> {
        match self {
            Self::Chat | Self::ChatNoStream => chat_completions_url(base_url),
            Self::Responses => responses_url(base_url),
        }
    }

    fn build_request(self, model: &str, messages: Vec<LlmChatMessage>) -> serde_json::Value {
        match self {
            Self::Chat | Self::ChatNoStream => build_openai_chat_request(model, messages),
            Self::Responses => build_openai_responses_request(model, messages),
        }
    }

    fn extract_content(self, bytes: &[u8]) -> Result<String, WorkspaceError> {
        match self {
            Self::Chat | Self::ChatNoStream => extract_chat_completion_content(bytes),
            Self::Responses => extract_responses_content(bytes),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Chat | Self::ChatNoStream => "chat completion",
            Self::Responses => "responses",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn llm_response_reader_accepts_body_at_limit() {
        let body = vec![b'a'; 4];

        let read = read_limited_response_body(Cursor::new(body.clone()), 4, "llm response")
            .expect("body at limit should be accepted");

        assert_eq!(read, body);
    }

    #[test]
    fn llm_response_reader_rejects_body_over_limit() {
        let error =
            read_limited_response_body(Cursor::new(vec![b'a'; 5]), 4, "llm response").unwrap_err();

        assert_eq!(error.error_code(), "llm_failed");
        assert!(error.to_string().contains("exceeded"));
    }

    #[test]
    fn controlled_llm_job_returns_cancelled_without_waiting_for_worker() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_flag = cancelled.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            cancel_flag.store(true, Ordering::SeqCst);
        });

        let started = Instant::now();
        let error = run_llm_job_with_control(
            LlmCallControl::new_cancel_checker({
                let cancelled = cancelled.clone();
                move || cancelled.load(Ordering::SeqCst)
            }),
            || {
                thread::sleep(Duration::from_secs(2));
                Ok("late response".to_string())
            },
        )
        .unwrap_err();

        assert_eq!(error.error_code(), "cancelled");
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn llm_api_mode_accepts_non_stream_chat_aliases() {
        assert_eq!(
            LlmApiMode::from_config("chatNoStream").unwrap(),
            LlmApiMode::ChatNoStream
        );
        assert_eq!(
            LlmApiMode::from_config("chat-no-stream").unwrap(),
            LlmApiMode::ChatNoStream
        );
        assert_eq!(
            LlmApiMode::from_config("chat_non_stream").unwrap(),
            LlmApiMode::ChatNoStream
        );
    }

    #[test]
    fn chat_stream_cancelled_does_not_retry_non_stream_fallback() {
        assert!(!should_retry_chat_non_stream_fallback(
            &WorkspaceError::new("cancelled", "operation cancelled")
        ));
        assert!(should_retry_chat_non_stream_fallback(&WorkspaceError::new(
            "llm_failed",
            "stream not supported"
        )));
    }

    #[test]
    fn chat_stream_timeout_and_partial_stream_can_retry_non_stream_fallback() {
        assert!(should_retry_chat_non_stream_fallback(&WorkspaceError::new(
            "llm_timeout",
            "stream timed out"
        )));
        assert!(should_retry_chat_non_stream_fallback(&WorkspaceError::new(
            "llm_partial_stream",
            "stream ended before [DONE]"
        )));
        assert!(!should_retry_chat_non_stream_fallback(
            &WorkspaceError::new("cancelled", "operation cancelled")
        ));
    }

    #[test]
    fn chat_stream_rejects_content_without_terminal_event() {
        let bytes = br#"data: {"choices":[{"delta":{"content":"---FILE: index.md---\n# Index\n"}}]}
"#;

        let error = extract_chat_completion_stream_content(bytes).unwrap_err();

        assert_eq!(error.error_code(), "llm_partial_stream");
        assert!(error.to_string().contains("ended before [DONE]"));
    }
}
