//! Deterministic transcripts for context compaction.
//!
//! The cache-safe summary request can afford to send the whole neutral history
//! again; when that does not fit the model window the caller needs a smaller,
//! reproducible rendering of the same covered range. The levels below are applied
//! oldest-exchange-first so detail is lost from the oldest history before the
//! newest work, and the newest exchange is never omitted.

use crate::domain::{ChatMessage, MessageRole};
use crate::providers::{HistoryMessage, HistoryRole};

/// Per-message character cap shared with the historical transcript builder.
pub const TRANSCRIPT_MESSAGE_CAP: usize = 2_000;
/// Tool result head/tail kept by [`TranscriptLevel::Clipped`].
const CLIPPED_HEAD_CHARS: usize = 1_000;
const CLIPPED_TAIL_CHARS: usize = 500;
/// Tool argument cap kept by [`TranscriptLevel::Clipped`].
const CLIPPED_ARGS_CHARS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TranscriptLevel {
    Full,
    Clipped,
    NoToolOutputs,
    UserOnly,
}

impl TranscriptLevel {
    const ALL: [Self; 4] = [
        Self::Full,
        Self::Clipped,
        Self::NoToolOutputs,
        Self::UserOnly,
    ];
}

fn cap_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

fn clip_head_tail(text: &str) -> String {
    let chars = text.chars().count();
    if chars <= CLIPPED_HEAD_CHARS + CLIPPED_TAIL_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(CLIPPED_HEAD_CHARS).collect();
    let tail: String = text
        .chars()
        .skip(chars.saturating_sub(CLIPPED_TAIL_CHARS))
        .collect();
    let omitted = chars.saturating_sub(CLIPPED_HEAD_CHARS + CLIPPED_TAIL_CHARS);
    format!("{head}\n[… {omitted} characters omitted …]\n{tail}")
}

fn push_line(out: &mut String, label: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(label);
    out.push_str(": ");
    out.push_str(text);
}

fn render_history_message(message: &HistoryMessage, level: TranscriptLevel) -> String {
    let mut out = String::new();
    match message.role {
        HistoryRole::System => {
            if level != TranscriptLevel::UserOnly {
                push_line(
                    &mut out,
                    "[System]",
                    &cap_chars(&message.text, TRANSCRIPT_MESSAGE_CAP),
                );
            }
        }
        HistoryRole::User => {
            push_line(
                &mut out,
                "[User]",
                &cap_chars(&message.text, TRANSCRIPT_MESSAGE_CAP),
            );
        }
        HistoryRole::Assistant => {
            if level == TranscriptLevel::UserOnly {
                return out;
            }
            if level == TranscriptLevel::Full {
                if let Some(reasoning) = message.reasoning.as_deref() {
                    push_line(
                        &mut out,
                        "[Assistant thinking]",
                        &cap_chars(reasoning, TRANSCRIPT_MESSAGE_CAP),
                    );
                }
            }
            push_line(
                &mut out,
                "[Assistant]",
                &cap_chars(&message.text, TRANSCRIPT_MESSAGE_CAP),
            );
            for call in &message.tool_calls {
                let args = match level {
                    TranscriptLevel::Full => cap_chars(&call.arguments, TRANSCRIPT_MESSAGE_CAP),
                    TranscriptLevel::Clipped => cap_chars(&call.arguments, CLIPPED_ARGS_CHARS),
                    TranscriptLevel::NoToolOutputs | TranscriptLevel::UserOnly => String::new(),
                };
                let rendered = if args.is_empty() {
                    call.name.clone()
                } else {
                    format!("{}({args})", call.name)
                };
                push_line(&mut out, "[Assistant tool call]", &rendered);
            }
        }
        HistoryRole::Tool => {
            if level == TranscriptLevel::UserOnly {
                return out;
            }
            let text = match level {
                TranscriptLevel::Full => cap_chars(&message.text, TRANSCRIPT_MESSAGE_CAP),
                TranscriptLevel::Clipped => clip_head_tail(&message.text),
                TranscriptLevel::NoToolOutputs | TranscriptLevel::UserOnly => {
                    "[tool result omitted]".to_string()
                }
            };
            push_line(&mut out, "[Tool result]", &text);
        }
    }
    out
}

/// Render `history[..cut]` at one detail level.
pub fn render_history_transcript(
    history: &[HistoryMessage],
    cut: usize,
    level: TranscriptLevel,
) -> String {
    history
        .iter()
        .take(cut.min(history.len()))
        .map(|message| render_history_message(message, level))
        .filter(|rendered| !rendered.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_raw_message(message: &ChatMessage, level: TranscriptLevel) -> String {
    let mut out = String::new();
    match message.role {
        MessageRole::System => {
            if level != TranscriptLevel::UserOnly {
                push_line(
                    &mut out,
                    "[System]",
                    &cap_chars(&message.content, TRANSCRIPT_MESSAGE_CAP),
                );
            }
        }
        MessageRole::User => {
            push_line(
                &mut out,
                "[User]",
                &cap_chars(&message.content, TRANSCRIPT_MESSAGE_CAP),
            );
        }
        MessageRole::Assistant => {
            if level == TranscriptLevel::UserOnly {
                return out;
            }
            if level == TranscriptLevel::Full {
                if let Some(reasoning) = message.reasoning.as_deref() {
                    push_line(
                        &mut out,
                        "[Assistant thinking]",
                        &cap_chars(reasoning, TRANSCRIPT_MESSAGE_CAP),
                    );
                }
            }
            push_line(
                &mut out,
                "[Assistant]",
                &cap_chars(&message.content, TRANSCRIPT_MESSAGE_CAP),
            );
            for call in &message.tool_calls {
                let args = match level {
                    TranscriptLevel::Full => cap_chars(&call.arguments, TRANSCRIPT_MESSAGE_CAP),
                    TranscriptLevel::Clipped => cap_chars(&call.arguments, CLIPPED_ARGS_CHARS),
                    TranscriptLevel::NoToolOutputs | TranscriptLevel::UserOnly => String::new(),
                };
                let rendered = if args.is_empty() {
                    call.name.clone()
                } else {
                    format!("{}({args})", call.name)
                };
                push_line(&mut out, "[Assistant tool call]", &rendered);
                if let Some(result) = call.result.as_deref() {
                    let text = match level {
                        TranscriptLevel::Full => cap_chars(result, TRANSCRIPT_MESSAGE_CAP),
                        TranscriptLevel::Clipped => clip_head_tail(result),
                        TranscriptLevel::NoToolOutputs | TranscriptLevel::UserOnly => {
                            "[tool result omitted]".to_string()
                        }
                    };
                    push_line(&mut out, "[Tool result]", &text);
                }
            }
        }
    }
    out
}

fn estimate_text_tokens(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        (text.chars().count() / 4).max(1)
    }
}

/// Fit a set of exchange renders by raising detail levels oldest-first, then
/// omitting whole old exchanges. The newest exchange is never omitted.
fn fit_exchanges(renders: Vec<[String; 4]>, max_tokens: usize) -> Option<String> {
    if renders.is_empty() || max_tokens == 0 {
        return None;
    }
    let count = renders.len();
    let mut levels = vec![0usize; count];
    let mut total: usize = renders
        .iter()
        .map(|exchange| estimate_text_tokens(&exchange[0]))
        .sum();
    if total <= max_tokens {
        return Some(
            renders
                .iter()
                .map(|exchange| exchange[0].as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
    }

    for level in 1..TranscriptLevel::ALL.len() {
        for index in 0..count {
            if total <= max_tokens {
                break;
            }
            if index == count - 1 && renders[index][level].is_empty() {
                continue;
            }
            total = total
                .saturating_sub(estimate_text_tokens(&renders[index][levels[index]]))
                .saturating_add(estimate_text_tokens(&renders[index][level]));
            levels[index] = level;
        }
    }

    let mut omitted = 0usize;
    for index in 0..count.saturating_sub(1) {
        if total <= max_tokens {
            break;
        }
        if levels[index] != usize::MAX {
            total =
                total.saturating_sub(estimate_text_tokens(&renders[index][levels[index]]));
            levels[index] = usize::MAX;
            omitted += 1;
        }
    }
    if total > max_tokens {
        return None;
    }

    let body = renders
        .iter()
        .enumerate()
        .filter(|(index, _)| levels[*index] != usize::MAX)
        .map(|(index, exchange)| exchange[levels[index]].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if body.trim().is_empty() {
        return None;
    }
    if omitted == 0 {
        Some(body)
    } else {
        Some(format!(
            "[{omitted} older {} omitted]\n\n{body}",
            if omitted == 1 { "exchange" } else { "exchanges" }
        ))
    }
}

/// Fit the covered neutral history into `max_tokens`, returning `None` when even
/// the newest exchange alone does not fit.
pub fn fit_transcript(
    history: &[HistoryMessage],
    cut: usize,
    max_tokens: u32,
) -> Option<String> {
    let covered = &history[..cut.min(history.len())];
    let mut exchanges: Vec<Vec<&HistoryMessage>> = Vec::new();
    for message in covered {
        if message.role == HistoryRole::User || exchanges.is_empty() {
            exchanges.push(Vec::new());
        }
        if let Some(last) = exchanges.last_mut() {
            last.push(message);
        }
    }
    let renders = exchanges
        .into_iter()
        .map(|messages| {
            let mut out: [String; 4] = Default::default();
            for (index, level) in TranscriptLevel::ALL.into_iter().enumerate() {
                out[index] = messages
                    .iter()
                    .map(|message| render_history_message(message, level))
                    .filter(|rendered| !rendered.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            out
        })
        .collect();
    fit_exchanges(renders, max_tokens as usize)
}

/// Fit the raw persisted messages `[..covered]` into `max_tokens`.
pub fn fit_raw_transcript(
    messages: &[ChatMessage],
    covered: usize,
    max_tokens: u32,
) -> Option<String> {
    let covered = &messages[..covered.min(messages.len())];
    let mut exchanges: Vec<Vec<&ChatMessage>> = Vec::new();
    for message in covered {
        if message.role == MessageRole::User || exchanges.is_empty() {
            exchanges.push(Vec::new());
        }
        if let Some(last) = exchanges.last_mut() {
            last.push(message);
        }
    }
    let renders = exchanges
        .into_iter()
        .map(|messages| {
            let mut out: [String; 4] = Default::default();
            for (index, level) in TranscriptLevel::ALL.into_iter().enumerate() {
                out[index] = messages
                    .iter()
                    .map(|message| render_raw_message(message, level))
                    .filter(|rendered| !rendered.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            out
        })
        .collect();
    fit_exchanges(renders, max_tokens as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{MessageStatus, ToolCallRecord, ToolCallStatus};

    fn user(text: &str) -> HistoryMessage {
        HistoryMessage::user(text)
    }

    fn assistant(text: &str) -> HistoryMessage {
        HistoryMessage::assistant(text)
    }

    #[test]
    fn levels_lose_detail_oldest_first_and_keep_the_newest_exchange() {
        let mut history = Vec::new();
        for index in 0..6 {
            history.push(user(&format!("request {index} {}", "u".repeat(600))));
            history.push(assistant(&format!("answer {index} {}", "a".repeat(600))));
        }
        let full = render_history_transcript(&history, history.len(), TranscriptLevel::Full);
        let fitted = fit_transcript(&history, history.len(), 1_200).expect("fits");
        assert!(fitted.chars().count() / 4 <= 1_200);
        assert!(fitted.len() < full.len());
        assert!(fitted.contains("request 5"), "newest exchange retained");
    }

    #[test]
    fn clipped_keeps_head_and_tail_of_tool_results() {
        let mut message = HistoryMessage::tool_result("call-1", "shell", "");
        message.text = format!("{}{}{}", "h".repeat(2_000), "m".repeat(2_000), "t".repeat(2_000));
        let clipped = render_history_message(&message, TranscriptLevel::Clipped);
        assert!(clipped.starts_with("[Tool result]: hhhh"));
        assert!(clipped.contains("characters omitted"));
        assert!(clipped.ends_with("tttt"));
        let omitted = render_history_message(&message, TranscriptLevel::NoToolOutputs);
        assert!(omitted.contains("[tool result omitted]"));
    }

    #[test]
    fn raw_transcript_renders_tool_results_and_fits() {
        let call = ToolCallRecord {
            id: "call-1".into(),
            name: "shell".into(),
            arguments: "{\"cmd\":\"ls\"}".into(),
            result: Some("file-a\nfile-b".into()),
            status: ToolCallStatus::Done,
            summary: None,
            started_at: None,
            finished_at: None,
            presentation: None,
            images: Vec::new(),
        };
        let mut assistant_message = ChatMessage {
            id: "m2".into(),
            conversation_id: "c".into(),
            role: MessageRole::Assistant,
            content: "done".into(),
            reasoning: None,
            status: MessageStatus::Complete,
            tool_calls: vec![call],
            citations: Vec::new(),
            attachments: Vec::new(),
            model_id: None,
            provider_id: None,
            usage: None,
            created_at: 0,
            provider_state: None,
            trace: Vec::new(),
            origin: crate::domain::TurnKind::User,
            error: None,
            resume_state: None,
        };
        let mut user_message = assistant_message.clone();
        user_message.id = "m1".into();
        user_message.role = MessageRole::User;
        user_message.content = "list files".into();
        user_message.reasoning = None;
        user_message.tool_calls.clear();
        let messages = vec![user_message, assistant_message];
        let full = fit_raw_transcript(&messages, messages.len(), 100_000).expect("full fits");
        assert!(full.contains("[Tool result]: file-a"));
        assert!(full.contains("[Assistant tool call]: shell("));
        let fitted = fit_raw_transcript(&messages, messages.len(), 1_000).expect("fits");
        assert!(fitted.contains("list files"));
    }
}
