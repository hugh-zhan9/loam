use std::io::{self, BufRead, Write};

use loam_lib::memory::api;
use loam_lib::memory::wiki_promote::{promote as promote_to_wiki, PromoteRequest};
use loam_lib::memory_models::MemoryDoctorReport;
use loam_lib::memory_agent_setup::{memory_agent_doctor, memory_agent_status};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The tools an agent may call.
///
/// Material goes in, conclusions come out of it, and reading is `recall` unless
/// something narrower is wanted. The tools this replaced — inbox review,
/// working context, thread saving — are gone with the concepts behind them; an
/// agent asking for them gets an unknown-tool error rather than a stub.
const TOOLS: &[&str] = &[
    "memory_status",
    "memory_recall",
    "memory_search",
    "memory_context",
    "memory_brief",
    "memory_add",
    "memory_show",
    "memory_distill",
    "memory_gate",
    "memory_adopt",
    "memory_promote",
    "memory_hook_status",
    "memory_diagnostics",
];

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct DrawerArguments {
    drawer_id: String,
}

#[derive(Debug, Deserialize)]
struct AgentStatusArguments {
    agent: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DiagnosticsArguments {
    #[serde(default)]
    include_logs: bool,
}

#[derive(Debug, Serialize)]
struct DiagnosticsResult {
    doctor: MemoryDoctorReport,
    logs_included: bool,
    logs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_warning: Option<String>,
}

fn parse_request(line: &str) -> Result<JsonRpcRequest, serde_json::Error> {
    serde_json::from_str(line)
}

fn main() {
    let workspace = match parse_workspace_arg(std::env::args().skip(1)) {
        Ok(workspace) => workspace,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    if let Err(error) = run_stdio(&workspace, io::stdin().lock(), io::stdout().lock()) {
        eprintln!("loam-mcp stdio error: {error}");
        std::process::exit(1);
    }
}

fn parse_workspace_arg<I>(args: I) -> Result<String, String>
where
    I: IntoIterator<Item = String>,
{
    let mut workspace = None;
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workspace" => {
                if workspace.is_some() {
                    return Err("loam-mcp received duplicate --workspace argument".to_string());
                }

                let value = args
                    .next()
                    .ok_or_else(|| "loam-mcp requires --workspace <path>".to_string())?;
                if value.trim().is_empty() || value.starts_with("--") {
                    return Err("loam-mcp requires --workspace <path>".to_string());
                }

                workspace = Some(value);
            }
            _ => {
                return Err(format!("loam-mcp unknown argument: {arg}"));
            }
        }
    }

    workspace.ok_or_else(|| "loam-mcp requires --workspace <path>".to_string())
}

fn run_stdio<R, W>(workspace: &str, reader: R, mut writer: W) -> io::Result<()>
where
    R: BufRead,
    W: Write,
{
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let response = handle_line(workspace, &line);
        serde_json::to_writer(&mut writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    Ok(())
}

fn handle_line(workspace: &str, line: &str) -> JsonRpcResponse {
    match parse_request(line) {
        Ok(request) => handle_request(workspace, request),
        Err(error) => JsonRpcResponse {
            jsonrpc: "2.0",
            id: Value::Null,
            result: None,
            error: Some(JsonRpcError {
                code: -32700,
                message: format!("Parse error: {error}"),
                data: None,
            }),
        },
    }
}

fn handle_request(workspace: &str, request: JsonRpcRequest) -> JsonRpcResponse {
    let id = request.id.clone();
    if request.jsonrpc != "2.0" {
        return error_response(
            id,
            -32600,
            "Invalid Request: jsonrpc must be \"2.0\"".to_string(),
            None,
        );
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(initialize_result()),
        "notifications/initialized" => Ok(Value::Null),
        "tools/list" => Ok(list_tools_result()),
        "tools/call" => dispatch_tool_call(workspace, request.params).map(tool_call_result),
        method => Err(protocol_error(
            -32601,
            format!("Method not found: {method}"),
            None,
        )),
    };

    match result {
        Ok(result) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        },
        Err(error) => error_response(id, error.code, error.message, error.data),
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {
                "listChanged": false
            }
        },
        "serverInfo": {
            "name": "loam-memory",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

fn list_tools_result() -> Value {
    let tools: Vec<Value> = TOOLS.iter().map(|name| tool_descriptor(name)).collect();
    json!({ "tools": tools })
}

fn tool_call_result(structured_content: Value) -> Value {
    let text = structured_content.to_string();
    json!({
        "content": [{
            "type": "text",
            "text": text
        }],
        "structuredContent": structured_content,
        "isError": false
    })
}

#[cfg(test)]
pub fn tools_manifest_for_test() -> String {
    list_tools_result().to_string()
}

fn tool_descriptor(name: &str) -> Value {
    let (description, properties, required) = match name {
        "memory_status" => (
            "Report whether memory is available for this workspace: whether it is enabled, which project it belongs to, and whether the embedding model is present.",
            json!({}),
            json!([]),
        ),
        "memory_recall" => (
            "Get the context for a task: assembled conclusions, a citation-first brief, and matching material. Call this at the start of a task when earlier context may matter. Every item carries the id and source file it came from; cite them.",
            json!({
                "query": { "type": "string" },
                "top_k": { "type": "integer" },
                "max_items": { "type": "integer" }
            }),
            json!(["query"]),
        ),
        "memory_search" => (
            "Search stored material and conclusions. Hybrid keyword and semantic search; results carry ids and source files.",
            json!({
                "query": { "type": "string" },
                "top_k": { "type": "integer" },
                "wing": { "type": "string" },
                "room": { "type": "string" }
            }),
            json!(["query"]),
        ),
        "memory_context" => (
            "Assemble only the conclusions that apply to a task, ordered from the most general to the most specific.",
            json!({
                "query": { "type": "string" },
                "max_items": { "type": "integer" }
            }),
            json!(["query"]),
        ),
        "memory_brief" => (
            "A deterministic brief for a task: key facts with citations, the evidence behind them, what is uncertain, and what to do next. No model is called to write it.",
            json!({ "query": { "type": "string" } }),
            json!(["query"]),
        ),
        "memory_add" => (
            "Store material: the text of a decision, a finding, or a piece of a conversation worth keeping. Material is raw record, not a claim — it is stored as given, and nothing is inferred from it. Do not store secrets; stored material can only be deleted afterwards, never unremembered.",
            json!({
                "body": { "type": "string" },
                "source": { "type": "string" }
            }),
            json!(["body"]),
        ),
        "memory_show" => (
            "Read one stored item in full by its id.",
            json!({ "drawer_id": { "type": "string" } }),
            json!(["drawer_id"]),
        ),
        "memory_distill" => (
            "Draw a conclusion from material already stored. Give the claim as one sentence and reference the material it rests on; those ids must exist. The result is a candidate: it does not reach anyone's context until a person adopts it.",
            json!({
                "statement": { "type": "string" },
                "body": { "type": "string" },
                "tier": { "type": "string", "enum": ["concrete", "pattern"] },
                "supporting_refs": { "type": "array", "items": { "type": "string" } }
            }),
            json!(["statement", "body", "supporting_refs"]),
        ),
        "memory_gate" => (
            "Report whether a candidate conclusion can be adopted yet, and what it is missing. Read-only.",
            json!({ "drawer_id": { "type": "string" } }),
            json!(["drawer_id"]),
        ),
        "memory_adopt" => (
            "Adopt a candidate conclusion so later sessions see it. This records who adopted it and when, as evidence in its own right. Ask the user before adopting on their behalf.",
            json!({
                "drawer_id": { "type": "string" },
                "note": { "type": "string" }
            }),
            json!(["drawer_id"]),
        ),
        "memory_promote" => (
            "Copy a conclusion or piece of material into wiki raw material, optionally ingesting it.",
            json!({
                "target": { "type": "string" },
                "ingest": { "type": "boolean" },
                "title": { "type": "string" }
            }),
            json!(["target", "ingest"]),
        ),
        "memory_hook_status" => (
            "Inspect the installed agent hook and MCP integration for this workspace.",
            json!({ "agent": { "type": "string" } }),
            json!([]),
        ),
        "memory_diagnostics" => (
            "Diagnose memory for this workspace: the library, the model, and the project bindings.",
            json!({ "include_logs": { "type": "boolean" } }),
            json!([]),
        ),
        _ => unreachable!("tool descriptor requested for unregistered tool"),
    };

    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required
        }
    })
}

fn dispatch_tool_call(workspace: &str, params: Value) -> Result<Value, ProtocolError> {
    let params: ToolCallParams = serde_json::from_value(params).map_err(|error| {
        protocol_error(-32602, format!("Invalid tools/call params: {error}"), None)
    })?;
    let arguments = if params.arguments.is_null() {
        Value::Object(Default::default())
    } else {
        params.arguments
    };

    let root = std::path::Path::new(workspace);

    match params.name.as_str() {
        "memory_status" => memory_result(api::status(root)),
        "memory_recall" => {
            let query = parse_arguments(arguments)?;
            memory_result(api::recall(root, query))
        }
        "memory_search" => {
            let request = parse_arguments(arguments)?;
            memory_result(api::search(request))
        }
        "memory_context" => {
            let query = parse_arguments(arguments)?;
            memory_result(api::context(root, query))
        }
        "memory_brief" => {
            let query = parse_arguments(arguments)?;
            memory_result(api::brief(root, query))
        }
        "memory_add" => {
            let request = parse_arguments(arguments)?;
            memory_result(api::add_material(root, request))
        }
        "memory_show" => {
            let arguments: DrawerArguments = parse_arguments(arguments)?;
            memory_result(api::show(&arguments.drawer_id))
        }
        "memory_distill" => {
            let request = parse_arguments(arguments)?;
            memory_result(api::distill_conclusion(root, request))
        }
        "memory_gate" => {
            let arguments: DrawerArguments = parse_arguments(arguments)?;
            memory_result(api::conclusion_gate(&arguments.drawer_id))
        }
        "memory_adopt" => {
            let request = parse_arguments(arguments)?;
            memory_result(api::adopt_conclusion(root, request))
        }
        "memory_promote" => {
            let request: PromoteRequest = parse_arguments(arguments)?;
            memory_result(promote_to_wiki(root, request))
        }
        "memory_hook_status" => {
            let arguments: AgentStatusArguments = parse_arguments(arguments)?;
            io_result(memory_agent_status(workspace.to_string(), arguments.agent))
        }
        "memory_diagnostics" => {
            let arguments: DiagnosticsArguments = parse_arguments(arguments)?;
            io_result(
                memory_agent_doctor(workspace.to_string(), None)
                    .map(|doctor| diagnostics_result(doctor, arguments.include_logs)),
            )
        }
        name => Err(protocol_error(
            -32602,
            format!("Unknown tool: {name}"),
            Some(json!({ "known_tools": TOOLS })),
        )),
    }
}

fn diagnostics_result(doctor: MemoryDoctorReport, include_logs: bool) -> DiagnosticsResult {
    DiagnosticsResult {
        doctor,
        logs_included: false,
        logs: Vec::new(),
        log_warning: include_logs.then(|| "logs_unavailable".to_string()),
    }
}

fn parse_arguments<T>(arguments: Value) -> Result<T, ProtocolError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(arguments)
        .map_err(|error| protocol_error(-32602, format!("Invalid tool arguments: {error}"), None))
}

fn memory_result<T, E>(result: Result<T, E>) -> Result<Value, ProtocolError>
where
    T: Serialize,
    E: Serialize + std::fmt::Display,
{
    match result {
        Ok(result) => serde_json::to_value(result).map_err(|error| {
            protocol_error(
                -32603,
                format!("Failed to serialize memory result: {error}"),
                None,
            )
        }),
        Err(error) => Err(workspace_error(error)),
    }
}

fn io_result<T>(result: io::Result<T>) -> Result<Value, ProtocolError>
where
    T: Serialize,
{
    match result {
        Ok(result) => serde_json::to_value(result).map_err(|error| {
            protocol_error(
                -32603,
                format!("Failed to serialize memory result: {error}"),
                None,
            )
        }),
        Err(error) => {
            let code = match error.kind() {
                io::ErrorKind::InvalidInput => -32602,
                _ => -32000,
            };
            Err(protocol_error(
                code,
                error.to_string(),
                Some(json!({ "kind": error.kind().to_string() })),
            ))
        }
    }
}

#[derive(Debug)]
struct ProtocolError {
    code: i64,
    message: String,
    data: Option<Value>,
}

fn protocol_error(code: i64, message: String, data: Option<Value>) -> ProtocolError {
    ProtocolError {
        code,
        message,
        data,
    }
}

fn workspace_error<E>(error: E) -> ProtocolError
where
    E: Serialize + std::fmt::Display,
{
    let data = serde_json::to_value(&error).ok();
    ProtocolError {
        code: -32000,
        message: error.to_string(),
        data,
    }
}

fn error_response(id: Value, code: i64, message: String, data: Option<Value>) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message,
            data,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    struct HomeEnvGuard {
        _lock: MutexGuard<'static, ()>,
        home: Option<std::ffi::OsString>,
        userprofile: Option<std::ffi::OsString>,
    }

    impl HomeEnvGuard {
        fn use_home(path: impl AsRef<std::path::Path>) -> Self {
            let lock = loam_lib::llm_wiki_llm::llm_config_env_lock()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let home = std::env::var_os("HOME");
            let userprofile = std::env::var_os("USERPROFILE");
            let canonical_home = std::fs::canonicalize(path.as_ref()).unwrap();
            std::env::set_var("HOME", canonical_home);
            std::env::remove_var("USERPROFILE");
            Self {
                _lock: lock,
                home,
                userprofile,
            }
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            if let Some(value) = self.home.take() {
                std::env::set_var("HOME", value);
            } else {
                std::env::remove_var("HOME");
            }
            if let Some(value) = self.userprofile.take() {
                std::env::set_var("USERPROFILE", value);
            } else {
                std::env::remove_var("USERPROFILE");
            }
        }
    }

    #[test]
    fn parses_mcp_tool_call_request() {
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_status","arguments":{}}}"#,
        )
        .unwrap();
        assert_eq!(request.method, "tools/call");
        assert_eq!(request.params["name"], "memory_status");
    }

    #[test]
    fn tools_list_response_contains_expected_memory_tools() {
        let response = handle_request(
            "/tmp",
            parse_request(r#"{"jsonrpc":"2.0","id":"tools","method":"tools/list"}"#).unwrap(),
        );

        assert!(response.error.is_none());
        let tools = response.result.unwrap()["tools"]
            .as_array()
            .unwrap()
            .clone();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, TOOLS);
    }

    #[test]
    fn the_tools_of_the_abandoned_model_are_not_advertised() {
        let response = handle_request(
            "/tmp",
            parse_request(r#"{"jsonrpc":"2.0","id":"tools","method":"tools/list"}"#).unwrap(),
        );

        let tools = response.result.unwrap()["tools"].as_array().unwrap().clone();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();

        for gone in [
            "memory_working_get",
            "memory_inbox_add",
            "memory_inbox_list",
            "memory_inbox_accept",
            "memory_thread_save",
            "memory_thread_show",
        ] {
            assert!(
                !names.contains(&gone),
                "{gone} belongs to a model this product no longer has"
            );
        }
    }

    #[test]
    fn distilling_a_conclusion_is_described_as_needing_material() {
        let response = handle_request(
            "/tmp",
            parse_request(r#"{"jsonrpc":"2.0","id":"tools","method":"tools/list"}"#).unwrap(),
        );

        let tools = response.result.unwrap()["tools"].as_array().unwrap().clone();
        let descriptor = tools
            .iter()
            .find(|tool| tool["name"].as_str() == Some("memory_distill"))
            .expect("missing memory_distill descriptor");

        assert_eq!(
            descriptor["inputSchema"]["required"],
            json!(["statement", "body", "supporting_refs"])
        );
    }

    #[test]
    fn tool_descriptions_guide_agent_time_memory_behavior() {
        let response = handle_request(
            "/tmp",
            parse_request(r#"{"jsonrpc":"2.0","id":"tools","method":"tools/list"}"#).unwrap(),
        );

        assert!(response.error.is_none());
        let result = response.result.unwrap();
        let tools = result["tools"].as_array().unwrap();

        let description_for = |tool_name: &str| -> String {
            tools
                .iter()
                .find(|tool| tool["name"] == tool_name)
                .unwrap_or_else(|| panic!("missing tool descriptor for {tool_name}"))["description"]
                .as_str()
                .unwrap()
                .to_lowercase()
        };

        let recall = description_for("memory_recall");
        assert!(recall.contains("start of a task"));
        assert!(recall.contains("cite"));

        let add = description_for("memory_add");
        assert!(add.contains("raw record"), "material is not a claim: {add}");
        assert!(add.contains("do not store secrets"));
        assert!(
            add.contains("only be deleted afterwards"),
            "the agent has to know capture is irreversible: {add}"
        );

        let distill = description_for("memory_distill");
        assert!(distill.contains("material already stored"));
        assert!(distill.contains("candidate"));
        assert!(
            distill.contains("until a person adopts it"),
            "an agent must not think distilling is publishing: {distill}"
        );

        let adopt = description_for("memory_adopt");
        assert!(adopt.contains("records who adopted it"));
        assert!(adopt.contains("ask the user"));
    }

    #[test]
    fn initialize_response_advertises_tools_capability() {
        let response = handle_request(
            "/tmp",
            parse_request(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#,
            )
            .unwrap(),
        );

        assert!(response.error.is_none());
        let result = response.result.unwrap();
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert_eq!(result["serverInfo"]["name"], "loam-memory");
        assert_eq!(result["capabilities"]["tools"]["listChanged"], false);
    }

    #[test]
    fn initialized_notification_without_id_is_accepted() {
        let response = handle_request(
            "/tmp",
            parse_request(r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#)
                .unwrap(),
        );

        assert!(response.error.is_none());
        assert_eq!(response.id, Value::Null);
    }

    #[test]
    fn dispatches_memory_status_tool_call() {
        let root = tempfile::tempdir().unwrap();
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_status","arguments":{}}}"#,
        )
        .unwrap();

        let response = handle_request(root.path().to_str().unwrap(), request);

        assert!(response.error.is_none(), "{:?}", response.error);
        let envelope = response.result.unwrap();
        let result = &envelope["structuredContent"];
        // Memory is off until a workspace asks for it, and the model has to be
        // downloaded before anything can be written.
        assert_eq!(result["enabled"], false);
        assert!(result["model"].as_str().is_some());
    }

    #[test]
    fn tool_call_result_uses_the_mcp_content_envelope() {
        let root = tempfile::tempdir().unwrap();
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_status","arguments":{}}}"#,
        )
        .unwrap();

        let response = handle_request(root.path().to_str().unwrap(), request);

        assert!(response.error.is_none(), "{:?}", response.error);
        let result = response.result.unwrap();
        assert_eq!(result["isError"], false);
        let structured = &result["structuredContent"];
        assert_eq!(structured["enabled"], false);

        let content = result["content"].as_array().expect("missing MCP content");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        let text: Value = serde_json::from_str(content[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(&text, structured);
    }

    #[test]
    fn an_abandoned_tool_call_is_an_unknown_tool() {
        let root = tempfile::tempdir().unwrap();
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_working_get","arguments":{}}}"#,
        )
        .unwrap();

        let response = handle_request(root.path().to_str().unwrap(), request);

        let error = response.error.expect("calling a deleted tool must fail");
        assert_eq!(error.code, -32602);
        assert!(error.message.contains("Unknown tool"));
    }

    #[test]
    fn dispatches_memory_hook_status_tool_call() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let _home = HomeEnvGuard::use_home(home.path());
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_hook_status","arguments":{"agent":"codex"}}}"#,
        )
        .unwrap();

        let response = handle_request(root.path().to_str().unwrap(), request);

        assert!(response.error.is_none());
        let result = response.result.unwrap();
        let statuses = result["structuredContent"].as_array().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0]["agent_source"], "codex");
    }

    #[test]
    fn dispatches_memory_diagnostics_tool_call_with_log_boundary() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let _home = HomeEnvGuard::use_home(home.path());
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_diagnostics","arguments":{"include_logs":true}}}"#,
        )
        .unwrap();

        let response = handle_request(root.path().to_str().unwrap(), request);

        assert!(response.error.is_none());
        let envelope = response.result.unwrap();
        let result = &envelope["structuredContent"];
        assert_eq!(result["logs_included"], false);
        assert_eq!(result["logs"], json!([]));
        assert_eq!(result["log_warning"], "logs_unavailable");
        assert_eq!(result["doctor"]["statuses"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn invalid_memory_agent_selector_returns_invalid_params() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let _home = HomeEnvGuard::use_home(home.path());
        let request = parse_request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_hook_status","arguments":{"agent":"vscode"}}}"#,
        )
        .unwrap();

        let response = handle_request(root.path().to_str().unwrap(), request);

        let error = response.error.unwrap();
        assert_eq!(error.code, -32602);
        assert!(error.message.contains("invalid memory agent"));
        assert_eq!(error.data.unwrap()["kind"], "invalid input parameter");
    }

    #[test]
    fn parse_workspace_arg_accepts_workspace_path() {
        let workspace = parse_workspace_arg(["--workspace", "/tmp/mdx"].map(String::from)).unwrap();

        assert_eq!(workspace, "/tmp/mdx");
    }

    #[test]
    fn parse_workspace_arg_rejects_unknown_argument() {
        let error = parse_workspace_arg(["--bogus", "--workspace", "/tmp/mdx"].map(String::from))
            .unwrap_err();

        assert_eq!(error, "loam-mcp unknown argument: --bogus");
    }

    #[test]
    fn parse_workspace_arg_rejects_missing_workspace_value() {
        let error = parse_workspace_arg(["--workspace"].map(String::from)).unwrap_err();

        assert_eq!(error, "loam-mcp requires --workspace <path>");
    }

    #[test]
    fn parse_workspace_arg_rejects_empty_workspace_value() {
        let error = parse_workspace_arg(["--workspace", "  "].map(String::from)).unwrap_err();

        assert_eq!(error, "loam-mcp requires --workspace <path>");
    }

    #[test]
    fn parse_workspace_arg_rejects_duplicate_workspace_argument() {
        let error = parse_workspace_arg(
            ["--workspace", "/tmp/one", "--workspace", "/tmp/two"].map(String::from),
        )
        .unwrap_err();

        assert_eq!(error, "loam-mcp received duplicate --workspace argument");
    }
}
