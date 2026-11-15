//! Artifact creation tool (text content).
//!
//! Sanitization, MIME/kind inference and the disk + SQLite persistence live in
//! [`super::artifacts::write_artifact`], shared with `run_code`.

use serde_json::{json, Value};

use crate::i18n;
use crate::providers::ToolDefinition;

use super::artifacts;
use super::{json_str, ToolOutcome, ToolRuntime};

const MAX_ARTIFACT_BYTES: usize = 10 * 1024 * 1024;

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "create_file".to_string(),
        description: "Create a downloadable file (artifact) for the user: markdown documents, \
                      HTML/SVG previews, CSV/JSON data, source code, etc. The file appears in the \
                      artifact panel with preview and a \"Save as…\" action. Use this instead of \
                      pasting very long content in the chat. Returns the artifact id and a short \
                      confirmation; never repeat the whole file in your answer."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "File name including extension, e.g. \"relatorio.md\", \"index.html\", \"dados.csv\", \"app.tsx\"."
                },
                "content": {
                    "type": "string",
                    "description": "Full UTF-8 file content."
                },
                "mime": {
                    "type": "string",
                    "description": "Optional MIME type. When omitted it is inferred from the extension."
                }
            },
            "required": ["name", "content"],
            "additionalProperties": false
        }),
    }
}

pub async fn run(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    let raw_name = match json_str(args, "name") {
        Some(name) if !name.trim().is_empty() => name,
        _ => return ToolOutcome::error(i18n::t("tools.create_file.nameRequired")),
    };
    let content = match args.get("content") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => {
            return ToolOutcome::error(i18n::t("tools.create_file.contentRequired"))
        }
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    };
    if content.len() > MAX_ARTIFACT_BYTES {
        return ToolOutcome::error(i18n::t_args(
            "tools.create_file.tooLarge",
            &[("size", &content.len().to_string())],
        ));
    }

    let mime_hint = json_str(args, "mime");
    match artifacts::write_artifact(
        &rt.db,
        &rt.data_dir,
        Some(&rt.conversation_id),
        Some(&rt.message_id),
        &raw_name,
        content.as_bytes(),
        mime_hint.as_deref(),
    ) {
        Ok(artifact) => ToolOutcome {
            content: i18n::t_args(
                "tools.create_file.created",
                &[
                    ("name", &artifact.name),
                    ("size", &artifact.size.to_string()),
                    ("mime", &artifact.mime_type),
                    ("id", &artifact.id),
                ],
            ),
            summary: Some(format!("{} · {} bytes", artifact.name, artifact.size)),
            artifacts: vec![artifact],
            ..Default::default()
        },
        Err(error) => ToolOutcome::error(i18n::t_args(
            "tools.create_file.createFailed",
            &[("error", &format!("{error:#}"))],
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::db::Db;
    use crate::domain::Settings;

    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "zylara-create-file-test-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("criar diretório temporário");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn runtime(temp: &TempDir) -> ToolRuntime {
        ToolRuntime {
            db: std::sync::Arc::new(Db::open_in_memory().expect("banco em memória")),
            http: reqwest::Client::new(),
            conversation_id: "conv-1".to_string(),
            message_id: "msg-1".to_string(),
            options: Default::default(),
            settings: Settings::default(),
            cancel: tokio_util::sync::CancellationToken::new(),
            agent_hooks: None,
            data_dir: temp.path.clone(),
            skills_roots: Vec::new(),
            approval: None,
            emit: None,
        }
    }

    #[test]
    fn definition_documents_the_arguments() {
        let definition = definition();
        assert_eq!(definition.name, "create_file");
        let properties = &definition.parameters["properties"];
        for key in ["name", "content", "mime"] {
            assert!(properties.get(key).is_some(), "propriedade `{key}` ausente");
        }
        assert_eq!(definition.parameters["required"], json!(["name", "content"]));
    }

    #[tokio::test]
    async fn rejects_missing_arguments() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let outcome = run(&rt, &json!({})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("`name`"));

        let outcome = run(&rt, &json!({"name": "a.md"})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("`content`"));
    }

    #[tokio::test]
    async fn creates_a_text_artifact_through_the_shared_writer() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let outcome = run(
            &rt,
            &json!({"name": "relatorio.md", "content": "# Relatório\n"}),
        )
        .await;
        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert_eq!(outcome.artifacts.len(), 1);
        let artifact = &outcome.artifacts[0];
        assert_eq!(artifact.name, "relatorio.md");
        assert!(outcome.content.contains(&artifact.id));
        assert!(outcome.summary.is_some());
        assert!(temp
            .path
            .join("artifacts")
            .join(&artifact.id)
            .join("relatorio.md")
            .is_file());
    }
}
