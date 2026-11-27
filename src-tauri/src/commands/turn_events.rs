//! Read-time visibility policy for persisted turn events.
//!
//! Raw events remain untouched for audit and rewind. Replay replaces only file
//! change payloads that the current Git ignore rules hide, while preserving
//! every sequence number so the renderer never observes a cursor gap.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use crate::domain::ChangesSummary;
use crate::events::TurnEvent;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEventRecord {
    pub turn_id: String,
    pub seq: u64,
    pub event: Value,
}

/// Applies the same Git visibility policy to live and summary events.
pub async fn sanitize_event_batch(
    records: Vec<TurnEventRecord>,
    workspace_root: Option<&Path>,
) -> Vec<TurnEventRecord> {
    let Some(root) = workspace_root.filter(|root| root.is_dir()) else {
        return records;
    };
    let repo = crate::workspace::git::detect(root).await;
    let repo_root = repo.root.as_deref().unwrap_or(root);
    let mut paths = Vec::new();
    for record in &records {
        match serde_json::from_value::<TurnEvent>(record.event.clone()) {
            Ok(TurnEvent::FileChanged { change }) => paths.push(change.path),
            Ok(TurnEvent::WorkspaceChanges { summary }) => {
                paths.extend(summary.files.into_iter().map(|file| file.path));
            }
            _ => {}
        }
    }
    let ignored = crate::workspace::git::ignored_paths(root, repo_root, &paths).await;
    if ignored.is_empty() {
        return records;
    }

    records
        .into_iter()
        .map(|record| {
            let event = match serde_json::from_value::<TurnEvent>(record.event.clone()) {
                Ok(TurnEvent::FileChanged { change }) if ignored.contains(&change.path) => {
                    // Unknown event: the renderer still advances the sequence
                    // cursor but never creates a change row for a hidden path.
                    Some(serde_json::json!({ "type": "ignored_file_changed" }))
                }
                Ok(TurnEvent::WorkspaceChanges { mut summary }) => {
                    filter_summary(&mut summary, &ignored);
                    serde_json::to_value(TurnEvent::WorkspaceChanges { summary }).ok()
                }
                Ok(event) => serde_json::to_value(event).ok(),
                Err(_) => None,
            };
            TurnEventRecord {
                turn_id: record.turn_id,
                seq: record.seq,
                event: event.unwrap_or(record.event),
            }
        })
        .collect()
}

fn filter_summary(summary: &mut ChangesSummary, ignored: &HashSet<String>) {
    summary.files.retain(|file| !ignored.contains(&file.path));
    summary.added = summary.files.iter().map(|file| file.added).sum();
    summary.removed = summary.files.iter().map(|file| file.removed).sum();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{FileChange, FileChangeKind, FileChangeSummary};
    use serde_json::json;

    fn record(seq: u64, event: TurnEvent) -> TurnEventRecord {
        TurnEventRecord {
            turn_id: "turn-1".to_string(),
            seq,
            event: serde_json::to_value(event).expect("serialize event"),
        }
    }

    fn summary(path: &str) -> ChangesSummary {
        ChangesSummary {
            turn_id: Some("turn-1".to_string()),
            files: vec![FileChangeSummary {
                path: path.to_string(),
                kind: FileChangeKind::Created,
                added: 2,
                removed: 1,
                origin: Some("session".to_string()),
                staged: false,
            }],
            added: 2,
            removed: 1,
        }
    }

    #[test]
    fn summary_filter_recomputes_totals_and_keeps_visible_files() {
        let mut value = summary(".env");
        value.files.push(FileChangeSummary {
            path: ".env.example".to_string(),
            kind: FileChangeKind::Modified,
            added: 4,
            removed: 0,
            origin: None,
            staged: false,
        });
        value.added = 6;
        filter_summary(&mut value, &HashSet::from([".env".to_string()]));
        assert_eq!(value.files.len(), 1);
        assert_eq!(value.files[0].path, ".env.example");
        assert_eq!(value.added, 4);
        assert_eq!(value.removed, 0);
    }

    #[tokio::test]
    async fn ignored_event_payload_is_neutralized_without_losing_sequence_numbers() {
        if !crate::workspace::git::test_support::git_available() {
            eprintln!("git ausente no PATH: teste ignorado");
            return;
        }
        let temp = tempfile::tempdir().expect("tempdir");
        assert!(crate::workspace::git::test_support::run_git(
            temp.path(),
            &["init", "-b", "main"],
        ));
        std::fs::write(temp.path().join(".gitignore"), ".env\n").expect("gitignore");
        let records = vec![
            record(
                1,
                TurnEvent::FileChanged {
                    change: FileChange {
                        path: ".env".to_string(),
                        kind: FileChangeKind::Created,
                        added: 2,
                        removed: 0,
                        diff: Some("secret".to_string()),
                    },
                },
            ),
            record(2, TurnEvent::WorkspaceChanges { summary: summary(".env") }),
            record(
                3,
                TurnEvent::Done {
                    result: serde_json::from_value(serde_json::json!({
                        "userMessage": {
                            "id": "user-1",
                            "conversationId": "conv-1",
                            "role": "user",
                            "status": "complete",
                            "createdAt": 0
                        },
                        "assistantMessage": {
                            "id": "assistant-1",
                            "conversationId": "conv-1",
                            "role": "assistant",
                            "status": "complete",
                            "createdAt": 0
                        }
                    }))
                    .expect("turn result"),
                },
            ),
        ];
        let sanitized = sanitize_event_batch(records, Some(temp.path())).await;
        assert_eq!(sanitized.iter().map(|record| record.seq).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(sanitized[0].event["type"], "ignored_file_changed");
        assert!(sanitized[0].event.get("change").is_none());
        assert_eq!(sanitized[1].event["summary"]["files"], json!([]));
        assert_eq!(sanitized[1].event["summary"]["added"], 0);
    }
}
