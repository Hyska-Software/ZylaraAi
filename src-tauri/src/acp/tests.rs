//! Deterministic end-to-end tests against a fake ACP subprocess, plus an
//! opt-in live Registry smoke test. No test in this module touches the network
//! unless explicitly `--ignored`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::acp::mapping;
use crate::providers::{EventSink, ProviderEvent};

fn script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("acp")
        .join("testdata")
        .join("fake-agent.mjs")
}

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
}

async fn spawn_agent() -> anyhow::Result<(Child, BufReader<tokio::process::ChildStdout>)> {
    let mut child = Command::new("node")
        .arg(script_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    Ok((child, BufReader::new(stdout)))
}

async fn request(
    stdin: &mut tokio::process::ChildStdin,
    reader: &mut BufReader<tokio::process::ChildStdout>,
    id: u64,
    method: &str,
    params: Value,
) -> anyhow::Result<(Value, Vec<Value>)> {
    let envelope = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    stdin.write_all(envelope.to_string().as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;

    let mut notifications = Vec::new();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await?;
        anyhow::ensure!(read > 0, "ACP agent closed stdout before replying");
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(line.trim())?;
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            return Ok((message, notifications));
        }
        notifications.push(message);
    }
}

#[tokio::test]
async fn fake_agent_completes_initialize_session_and_prompt() {
    if !node_available() {
        eprintln!("skipping ACP fake-agent test: node is not on PATH");
        return;
    }
    let (mut child, mut reader) = spawn_agent().await.expect("spawn fake agent");
    let mut stdin = child.stdin.take().expect("stdin piped");

    let (init, _) = request(
        &mut stdin,
        &mut reader,
        0,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } },
            "clientInfo": { "name": "zylara-test", "version": "1.0.0" }
        }),
    )
    .await
    .expect("initialize reply");
    assert_eq!(
        init.get("result").and_then(|r| r.get("protocolVersion")),
        Some(&json!(1))
    );

    let (new_session, _) = request(
        &mut stdin,
        &mut reader,
        1,
        "session/new",
        json!({ "cwd": ".", "mcpServers": [] }),
    )
    .await
    .expect("session/new reply");
    let options = new_session
        .get("result")
        .and_then(|r| r.get("configOptions"))
        .and_then(Value::as_array)
        .expect("configOptions");
    assert!(options.iter().any(|option| option.get("category") == Some(&json!("model"))));

    let (prompt, notifications) = request(
        &mut stdin,
        &mut reader,
        2,
        "session/prompt",
        json!({
            "sessionId": "sess-test",
            "prompt": [{ "type": "text", "text": "ping" }]
        }),
    )
    .await
    .expect("session/prompt reply");
    assert_eq!(prompt.get("result").and_then(|r| r.get("stopReason")), Some(&json!("end_turn")));
    assert_eq!(notifications.len(), 2, "one text chunk and one usage update");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ProviderEvent>();
    let sink: EventSink = tx;
    let mut config_state = BTreeMap::new();
    for notification in &notifications {
        let update = notification
            .get("params")
            .and_then(|params| params.get("update"))
            .expect("session/update payload");
        mapping::apply_update(update, &sink, &mut config_state).expect("map update");
    }
    drop(sink);

    let mut texts = Vec::new();
    let mut usage = false;
    while let Some(event) = rx.recv().await {
        match event {
            ProviderEvent::TextDelta(text) => texts.push(text),
            ProviderEvent::Usage(_) => usage = true,
            _ => {}
        }
    }
    assert_eq!(texts.concat(), "echo:ping");
    assert!(usage, "usage_update must reach the harness as ProviderEvent::Usage");

    let _ = child.kill().await;
}

#[tokio::test]
#[ignore = "hits the live ACP Registry CDN; run explicitly"]
async fn live_registry_is_reachable() {
    let http = crate::http::client();
    let fetched = crate::acp::registry::fetch(&http, None)
        .await
        .expect("official registry must be reachable");
    assert!(!fetched.not_modified);
    assert!(fetched.agents.len() >= 40);
}
