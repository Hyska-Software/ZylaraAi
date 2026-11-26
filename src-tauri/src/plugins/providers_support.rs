//! Declarative OpenAI-compatible providers contributed by plugins.
//!
//! Provider ids are namespaced (`plugin__<slug>__<id>`) so they can never
//! collide with the bundled catalog. Only the generic `openai-chat` protocol is
//! accepted in v1; proprietary protocols require a trusted sidecar.

use crate::catalog::{
    CacheInfo, Modalities, ModelInfo, ProviderAuth, ProviderInfo, ReasoningOption, RequestProfiles,
};

use super::permissions;
use super::PluginManager;

pub fn provider_id(plugin_id: &str, provider_id: &str) -> String {
    let plugin_id: String = plugin_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let provider_id: String = provider_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("plugin__{plugin_id}__{provider_id}")
}

impl PluginManager {
    pub fn providers(&self) -> Vec<ProviderInfo> {
        let state = self.state.read();
        let mut providers = Vec::new();
        for plugin in &state.active {
            if !permissions::granted_any(&plugin.grants, "providers") {
                continue;
            }
            for provider in &plugin.manifest.contributes.providers {
                providers.push(to_provider(plugin, provider));
            }
        }
        providers.sort_by(|left, right| left.id.cmp(&right.id));
        providers
    }

    pub fn provider(&self, id: &str) -> Option<ProviderInfo> {
        self.providers().into_iter().find(|provider| provider.id == id)
    }
}

fn to_provider(plugin: &super::LoadedPlugin, contribution: &super::ProviderContribution) -> ProviderInfo {
    let mut endpoints = contribution.endpoints.clone();
    endpoints
        .entry("openai-chat".to_string())
        .or_insert_with(|| "/chat/completions".to_string());
    endpoints
        .entry("models".to_string())
        .or_insert_with(|| "/models".to_string());
    for path in endpoints.values_mut() {
        if !path.starts_with('/') {
            path.insert(0, '/');
        }
    }
    let models = contribution
        .models
        .iter()
        .map(|model| ModelInfo {
            id: model.id.clone(),
            name: model.name.clone(),
            family: contribution.id.clone(),
            protocols: if model.protocols.is_empty() {
                vec!["openai-chat".to_string()]
            } else {
                model
                    .protocols
                    .iter()
                    .filter(|protocol| protocol.as_str() == "openai-chat")
                    .cloned()
                    .collect()
            },
            reasoning: model.reasoning,
            reasoning_options: if model.reasoning {
                vec![ReasoningOption::Toggle]
            } else {
                Vec::new()
            },
            attachment: model.attachment,
            modalities: Modalities {
                input: if model.attachment {
                    vec!["text".to_string(), "image".to_string()]
                } else {
                    vec!["text".to_string()]
                },
                output: vec!["text".to_string()],
            },
            context_window: model.context_window.unwrap_or(128_000).min(u32::MAX as u64) as u32,
            max_output: model.max_output.unwrap_or(16_384).min(u32::MAX as u64) as u32,
            cost: None,
            release_date: None,
            knowledge: None,
            open_weights: false,
            description: Some(format!("Contributed by the {} plugin", plugin.manifest.name)),
            tags: vec!["plugin".to_string()],
            status: "stable".to_string(),
            estimated: true,
            cache: Some(CacheInfo {
                mode: "auto".to_string(),
                min_tokens: Some(1_024),
                block_tokens: None,
                ttl_options: Vec::new(),
                supports_key: false,
                supports_retention: false,
                supports_explicit_breakpoints: false,
                reports_read: true,
                reports_write: true,
                source: Some("plugin".to_string()),
            }),
        })
        .collect::<Vec<_>>();
    ProviderInfo {
        id: provider_id(&plugin.stored.id, &contribution.id),
        name: contribution.name.clone(),
        short_name: contribution
            .short_name
            .clone()
            .unwrap_or_else(|| contribution.name.clone()),
        description: format!(
            "{} (plugin {})",
            contribution.description, plugin.manifest.name
        ),
        base_url: contribution.base_url.trim_end_matches('/').to_string(),
        console_url: contribution.console_url.clone(),
        endpoints: endpoints.into_iter().collect(),
        headers: contribution.headers.clone().into_iter().collect(),
        auth_env: String::new(),
        auth_header: contribution
            .auth_header
            .clone()
            .unwrap_or_else(|| "authorization".to_string()),
        auth_prefix: contribution
            .auth_prefix
            .clone()
            .unwrap_or_else(|| "Bearer ".to_string()),
        default_model_id: contribution
            .models
            .first()
            .map(|model| model.id.clone())
            .unwrap_or_default(),
        auth: ProviderAuth::ApiKey,
        request_profiles: RequestProfiles::default(),
        oauth: None,
        models,
        notes: vec![format!(
            "Declarative provider contributed by the `{}` plugin.",
            plugin.stored.id
        )],
        cache: None,
        icon: contribution.icon.clone(),
        category: None,
        origin: Some("plugin".to_string()),
        origin_label: Some(plugin.manifest.name.clone()),
        transport: crate::catalog::ProviderTransport::Http,
        acp: None,
        icon_svg: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_namespaced_and_stable() {
        assert_eq!(
            provider_id("com.acme.github", "gateway"),
            "plugin__com_acme_github__gateway"
        );
    }
}
