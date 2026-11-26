//! Maps the neutral reasoning request to protocol specific parameters.
//!
//! The catalog tells us, per model, which controls the gateway exposes
//! (`toggle`, `effort` with a list of values, `budget_tokens`). The mapping
//! follows `docs/MODELS.md`:
//!
//! | protocol | off | effort | budget |
//! | --- | --- | --- | --- |
//! | openai-chat | `thinking:{type:"disabled"}` | `reasoning_effort` | — |
//! | openai-responses | `reasoning.effort="none"` (only when listed) | `reasoning:{effort,summary:"detailed"}` | — |
//! | anthropic | `thinking:{type:"disabled"}` | claude: `adaptive` + `output_config.effort` | `thinking:{type:"enabled",budget_tokens}` |
//! | google | `thinkingBudget:0` | `thinkingLevel` (uppercase) | `thinkingBudget` |
//!
//! `Auto` never sends anything: the provider default decides. Everything here is
//! defensive about incomplete catalog metadata (missing family, empty option
//! lists, unknown effort values) and simply omits the parameter when there is no
//! safe mapping.

use serde_json::{json, Value};

use crate::catalog::ModelInfo;

use super::{ReasoningRequest, WireProtocol};

/// Maps an effort to a token budget using the model's declared range. The
/// position of the effort in `Effort.values` is interpolated between
/// `BudgetTokens.min/max`; the fixed table is only a fallback for models whose
/// catalog metadata has no budget range.
pub(crate) fn budget_for_effort(effort: &str, model: &ModelInfo) -> u32 {
    let normalized = effort.trim().to_ascii_lowercase();
    let values = effort_values(model);
    let range = model.reasoning_options.iter().find_map(|option| match option {
        crate::catalog::ReasoningOption::BudgetTokens { min, max } => {
            Some((*min, *max))
        }
        _ => None,
    });
    if let (Some(values), Some((min, max))) = (values, range) {
        if let Some(position) = values.iter().position(|value| value.eq_ignore_ascii_case(&normalized)) {
            let min = min.unwrap_or(1_024).max(1_024);
            let max = max.unwrap_or(65_536).max(min);
            let ratio = if values.len() <= 1 {
                1.0
            } else {
                position as f64 / (values.len() - 1) as f64
            };
            let raw = min as f64 + ratio * (max.saturating_sub(min) as f64);
            let rounded = ((raw / 256.0).round() * 256.0) as u32;
            return rounded.clamp(min, max);
        }
    }
    match normalized.as_str() {
        "minimal" => 512,
        "low" => 1_024,
        "medium" => 2_048,
        "high" => 4_096,
        "xhigh" => 8_192,
        "max" => 16_384,
        _ => 2_048,
    }
}

fn has_toggle(model: &ModelInfo) -> bool {
    model
        .reasoning_options
        .iter()
        .any(|option| matches!(option, crate::catalog::ReasoningOption::Toggle))
}

fn has_effort(model: &ModelInfo) -> bool {
    model
        .reasoning_options
        .iter()
        .any(|option| option.efforts().is_some())
}

fn effort_values(model: &ModelInfo) -> Option<&Vec<String>> {
    model
        .reasoning_options
        .iter()
        .find_map(|option| option.efforts())
}

fn has_budget(model: &ModelInfo) -> bool {
    model
        .reasoning_options
        .iter()
        .any(|option| matches!(option, crate::catalog::ReasoningOption::BudgetTokens { .. }))
}

fn has_any_control(model: &ModelInfo) -> bool {
    !model.reasoning_options.is_empty()
}

fn offers_effort(model: &ModelInfo, value: &str) -> bool {
    effort_values(model)
        .map(|values| values.iter().any(|candidate| candidate == value))
        .unwrap_or(false)
}

fn is_claude(model: &ModelInfo) -> bool {
    model.family.eq_ignore_ascii_case("claude")
        || model.id.to_ascii_lowercase().starts_with("claude")
}

fn set(body: &mut Value, key: &str, value: Value) {
    if let Some(object) = body.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

fn set_google_thinking(body: &mut Value, thinking_config: Value) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let generation = object
        .entry("generationConfig")
        .or_insert_with(|| json!({}));
    if !generation.is_object() {
        *generation = json!({});
    }
    if let Some(generation) = generation.as_object_mut() {
        generation.insert("thinkingConfig".to_string(), thinking_config);
    }
}

/// Apply the neutral reasoning request to an already built wire body.
///
/// The body is mutated in place; when the model does not expose any reasoning
/// control (or the request is [`ReasoningRequest::Auto`]) nothing is added.
pub fn apply(
    protocol: WireProtocol,
    model: &ModelInfo,
    request: &ReasoningRequest,
    body: &mut Value,
) {
    if request.is_auto() {
        return;
    }
    match protocol {
        WireProtocol::OpenaiChat => apply_openai_chat(model, request, body),
        WireProtocol::OpenaiResponses => apply_openai_responses(model, request, body),
        WireProtocol::Anthropic => apply_anthropic(model, request, body),
        WireProtocol::Google => apply_google(model, request, body),
        WireProtocol::Acp => {}
    }
}

fn apply_openai_chat(model: &ModelInfo, request: &ReasoningRequest, body: &mut Value) {
    match request {
        ReasoningRequest::Auto => {}
        ReasoningRequest::Off => {
            // Thinking-only models (GLM 5.x) reject `disabled` with a 400: they
            // do not expose a toggle, so we simply omit the parameter.
            if has_toggle(model) {
                set(body, "thinking", json!({"type": "disabled"}));
            }
        }
        ReasoningRequest::Effort(effort) => {
            if has_effort(model) {
                set(body, "reasoning_effort", json!(effort));
            } else if has_toggle(model) {
                // The catalog only advertises an on/off toggle: accept the
                // effort request by switching thinking on.
                set(body, "thinking", json!({"type": "enabled"}));
            }
        }
        ReasoningRequest::Budget(_) => {
            // The chat protocol has no budget surface (see docs/MODELS.md).
        }
    }
}

fn apply_openai_responses(model: &ModelInfo, request: &ReasoningRequest, body: &mut Value) {
    match request {
        ReasoningRequest::Auto => {}
        ReasoningRequest::Off => {
            if offers_effort(model, "none") {
                set(body, "reasoning", json!({"effort": "none"}));
            }
        }
        ReasoningRequest::Effort(effort) => {
            if !has_any_control(model) {
                return;
            }
            let mut reasoning = json!({ "effort": effort });
            // GPT/Grok/Muse only expose reasoning text with an explicit summary;
            // with `auto` the GPT models usually answer with an empty summary.
            if !effort.eq_ignore_ascii_case("none") {
                reasoning["summary"] = json!("detailed");
            }
            set(body, "reasoning", reasoning);
        }
        ReasoningRequest::Budget(_) => {
            // No budget surface on the Responses protocol.
        }
    }
}

fn apply_anthropic(model: &ModelInfo, request: &ReasoningRequest, body: &mut Value) {
    match request {
        ReasoningRequest::Auto => {}
        ReasoningRequest::Off => {
            if has_any_control(model) {
                set(body, "thinking", json!({"type": "disabled"}));
            }
        }
        ReasoningRequest::Effort(effort) => {
            if is_claude(model) {
                // Claude 5.x rejects `thinking.type = enabled`.
                set(body, "thinking", json!({"type": "adaptive"}));
                set(body, "output_config", json!({"effort": effort}));
            } else if has_budget(model) {
                set(
                    body,
                    "thinking",
                    json!({"type": "enabled", "budget_tokens": budget_for_effort(effort, model)}),
                );
            } else if has_any_control(model) {
                set(body, "thinking", json!({"type": "enabled"}));
            }
        }
        ReasoningRequest::Budget(budget) => {
            if has_budget(model) {
                // Anthropic enforces a 1024 token minimum budget.
                let budget = (*budget).max(1_024);
                set(
                    body,
                    "thinking",
                    json!({"type": "enabled", "budget_tokens": budget}),
                );
            } else if is_claude(model) {
                // Claude 5.x has no budget control: keep adaptive thinking.
                set(body, "thinking", json!({"type": "adaptive"}));
            } else if has_any_control(model) {
                set(body, "thinking", json!({"type": "enabled"}));
            }
        }
    }
}

fn has_zero_min_budget(model: &ModelInfo) -> bool {
    model.reasoning_options.iter().any(|option| {
        matches!(
            option,
            crate::catalog::ReasoningOption::BudgetTokens { min: Some(0), .. }
        )
    })
}

fn apply_google(model: &ModelInfo, request: &ReasoningRequest, body: &mut Value) {
    match request {
        ReasoningRequest::Auto => {}
        ReasoningRequest::Off => {
            // Gemini 4 / 3.8 Flash expose only thinking levels and cannot be
            // disabled; sending thinkingBudget: 0 would return 400.
            if has_toggle(model) || has_zero_min_budget(model) {
                set_google_thinking(body, json!({"thinkingBudget": 0}));
            }
        }
        ReasoningRequest::Effort(effort) => {
            if has_effort(model) {
                set_google_thinking(body, json!({"thinkingLevel": effort.trim().to_uppercase()}));
            } else if has_budget(model) {
                set_google_thinking(body, json!({"thinkingBudget": budget_for_effort(effort, model)}));
            } else if has_toggle(model) {
                // Dynamic thinking for toggle-only Gemini 2.5 models.
                set_google_thinking(body, json!({"thinkingBudget": -1}));
            }
        }
        ReasoningRequest::Budget(budget) => {
            // Effort-only models have no budget surface: keep the model default
            // instead of sending an unsupported field.
            if has_budget(model) {
                set_google_thinking(body, json!({"thinkingBudget": budget}));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogFile;
    use crate::catalog::ReasoningOption;

    fn model(provider_id: &str, model_id: &str) -> ModelInfo {
        CatalogFile::load()
            .expect("catalog")
            .model(provider_id, model_id)
            .expect("model in catalog")
            .clone()
    }


    #[test]
    fn budget_for_effort_uses_the_model_declared_range() {
        let mut model = model("anthropic", "claude-haiku-4-5");
        model.reasoning_options = vec![
            crate::catalog::ReasoningOption::Effort {
                values: vec!["low".into(), "medium".into(), "high".into()],
            },
            crate::catalog::ReasoningOption::BudgetTokens {
                min: Some(4_096),
                max: Some(32_768),
            },
        ];
        assert_eq!(budget_for_effort("low", &model), 4_096);
        assert_eq!(budget_for_effort("medium", &model), 18_432);
        assert_eq!(budget_for_effort("high", &model), 32_768);
        // Models without a declared range keep the defensive fallback.
        model.reasoning_options.clear();
        assert_eq!(budget_for_effort("high", &model), 4_096);
    }
    #[test]
    fn auto_never_sends_parameters() {
        let model = model("opencode-go", "claude-haiku-5-5");
        for protocol in [
            WireProtocol::OpenaiChat,
            WireProtocol::OpenaiResponses,
            WireProtocol::Anthropic,
            WireProtocol::Google,
        ] {
            let mut body = json!({"model": model.id.clone()});
            apply(protocol, &model, &ReasoningRequest::Auto, &mut body);
            assert_eq!(body, json!({"model": model.id.clone()}), "{protocol:?}");
        }
    }

    #[test]
    fn openai_chat_maps_effort_off_and_thinking_only_models() {
        let glm = model("opencode-go", "glm-5.3");
        let mut body = json!({});
        apply(
            WireProtocol::OpenaiChat,
            &glm,
            &ReasoningRequest::Effort("low".into()),
            &mut body,
        );
        assert_eq!(body, json!({"reasoning_effort": "low"}));

        // GLM 5.x is thinking-only: off must be omitted, not `disabled`.
        let mut body = json!({});
        apply(
            WireProtocol::OpenaiChat,
            &glm,
            &ReasoningRequest::Off,
            &mut body,
        );
        assert_eq!(body, json!({}));

        // Models with a toggle receive `thinking.disabled` / `enabled`.
        let glm_toggle = model("opencode-go", "glm-5.1");
        let mut body = json!({});
        apply(
            WireProtocol::OpenaiChat,
            &glm_toggle,
            &ReasoningRequest::Off,
            &mut body,
        );
        assert_eq!(body, json!({"thinking": {"type": "disabled"}}));

        let mut body = json!({});
        apply(
            WireProtocol::OpenaiChat,
            &glm_toggle,
            &ReasoningRequest::Effort("high".into()),
            &mut body,
        );
        assert_eq!(body, json!({"thinking": {"type": "enabled"}}));
    }

    #[test]
    fn openai_responses_uses_detailed_summary_and_conditional_none() {
        let gpt = model("opencode-go", "gpt-6-luna");
        let mut body = json!({});
        apply(
            WireProtocol::OpenaiResponses,
            &gpt,
            &ReasoningRequest::Effort("high".into()),
            &mut body,
        );
        assert_eq!(
            body,
            json!({"reasoning": {"effort": "high", "summary": "detailed"}})
        );

        let mut body = json!({});
        apply(
            WireProtocol::OpenaiResponses,
            &gpt,
            &ReasoningRequest::Off,
            &mut body,
        );
        assert_eq!(body, json!({"reasoning": {"effort": "none"}}));

        // Grok does not list `none`: off is omitted.
        let grok = model("opencode-go", "grok-4.7");
        let mut body = json!({});
        apply(
            WireProtocol::OpenaiResponses,
            &grok,
            &ReasoningRequest::Off,
            &mut body,
        );
        assert_eq!(body, json!({}));
    }

    #[test]
    fn anthropic_claude_uses_adaptive_and_non_claude_uses_budget() {
        let claude = model("opencode-go", "claude-haiku-5-5");
        let mut body = json!({});
        apply(
            WireProtocol::Anthropic,
            &claude,
            &ReasoningRequest::Effort("high".into()),
            &mut body,
        );
        assert_eq!(
            body,
            json!({"thinking": {"type": "adaptive"}, "output_config": {"effort": "high"}})
        );

        let mut body = json!({});
        apply(
            WireProtocol::Anthropic,
            &claude,
            &ReasoningRequest::Off,
            &mut body,
        );
        assert_eq!(body, json!({"thinking": {"type": "disabled"}}));

        // Claude 4.5 exposes budget_tokens: the budget request maps to `enabled`.
        let claude_budget = model("opencode-zen", "claude-haiku-4-5");
        let mut body = json!({});
        apply(
            WireProtocol::Anthropic,
            &claude_budget,
            &ReasoningRequest::Budget(2_000),
            &mut body,
        );
        assert_eq!(
            body,
            json!({"thinking": {"type": "enabled", "budget_tokens": 2_000}})
        );

        // Non-Claude families switch thinking on.
        let kimi = model("opencode-go", "kimi-k3");
        let mut body = json!({});
        apply(
            WireProtocol::Anthropic,
            &kimi,
            &ReasoningRequest::Effort("high".into()),
            &mut body,
        );
        assert_eq!(body, json!({"thinking": {"type": "enabled"}}));
    }

    #[test]
    fn google_uses_thinking_level_and_budget() {
        let gemini = model("opencode-go", "gemini-4-argon-contributor");
        let mut body = json!({"generationConfig": {"maxOutputTokens": 100}});
        apply(
            WireProtocol::Google,
            &gemini,
            &ReasoningRequest::Effort("low".into()),
            &mut body,
        );
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "LOW"
        );

        // Effort-only models cannot be disabled and have no budget surface.
        let before = json!({"generationConfig": {"maxOutputTokens": 100}});
        let mut disabled = before.clone();
        apply(
            WireProtocol::Google,
            &gemini,
            &ReasoningRequest::Off,
            &mut disabled,
        );
        assert_eq!(disabled, before, "Gemini 4 não aceita thinkingBudget: 0");

        let mut budget_on_effort_model = before.clone();
        apply(
            WireProtocol::Google,
            &gemini,
            &ReasoningRequest::Budget(2_048),
            &mut budget_on_effort_model,
        );
        assert_eq!(
            budget_on_effort_model, before,
            "Gemini 4 não aceita thinkingBudget"
        );

        // Budget-capable models (2.5 family) keep the numeric controls.
        let mut budget_model = gemini.clone();
        budget_model.reasoning_options = vec![ReasoningOption::BudgetTokens {
            min: Some(0),
            max: Some(24_576),
        }];
        let mut body = json!({"generationConfig": {"maxOutputTokens": 100}});
        apply(
            WireProtocol::Google,
            &budget_model,
            &ReasoningRequest::Off,
            &mut body,
        );
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            0
        );

        let mut body = json!({"generationConfig": {"maxOutputTokens": 100}});
        apply(
            WireProtocol::Google,
            &budget_model,
            &ReasoningRequest::Budget(2_048),
            &mut body,
        );
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            2_048
        );

        // Toggle-only models use dynamic thinking for an effort request.
        let mut toggle_model = gemini.clone();
        toggle_model.reasoning_options = vec![ReasoningOption::Toggle];
        let mut body = json!({"generationConfig": {"maxOutputTokens": 100}});
        apply(
            WireProtocol::Google,
            &toggle_model,
            &ReasoningRequest::Effort("high".into()),
            &mut body,
        );
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            -1
        );
    }

    #[test]
    fn incomplete_metadata_is_ignored() {
        let mut model = model("opencode-go", "glm-5.3-flash");
        model.family.clear();
        model.reasoning_options.clear();
        for protocol in [
            WireProtocol::OpenaiChat,
            WireProtocol::OpenaiResponses,
            WireProtocol::Anthropic,
            WireProtocol::Google,
        ] {
            let mut body = json!({});
            apply(protocol, &model, &ReasoningRequest::Off, &mut body);
            assert_eq!(body, json!({}), "{protocol:?}");
            let mut body = json!({});
            apply(
                protocol,
                &model,
                &ReasoningRequest::Effort("high".into()),
                &mut body,
            );
            assert_eq!(body, json!({}), "{protocol:?}");
        }
    }
}
