//! Prompt-cache telemetry commands (docs/goals/prompt-cache/PLAN.md §4.7/§5.2).
//!
//! The renderer restores the context-meter cache indicator with this snapshot when
//! a conversation is reopened. `cache_samples` is the canonical per-request log;
//! `cache_state` keeps the epoch/prefix/last-break facts.

use tauri::State;

use crate::domain::{CacheSample, CacheStats, CacheStatsView};
use crate::providers::cache::CacheCapabilities;
use crate::state::AppState;

fn db_error(error: anyhow::Error, what: &str) -> String {
    format!("falha ao {what}: {error:#}")
}

/// Human TTL label (`5m`, `1h`, `30m`, `12h`, `24h`) -> seconds for the UI.
fn ttl_seconds(label: &str) -> Option<u32> {
    let value = label.trim().to_ascii_lowercase();
    let (number, unit) = value.split_at(value.len().saturating_sub(1));
    let amount: u32 = number.parse().ok()?;
    match unit {
        "m" => Some(amount.saturating_mul(60)),
        "h" => Some(amount.saturating_mul(3_600)),
        "d" => Some(amount.saturating_mul(86_400)),
        _ => None,
    }
}

fn default_ttl_seconds(caps: &CacheCapabilities) -> Option<u32> {
    caps.ttl_options
        .iter()
        .find_map(|label| ttl_seconds(label))
}

fn cost_price(cost: &serde_json::Value, name: &str) -> Option<f64> {
    let camel = match name {
        "cache_read" => "cacheRead",
        "cache_write" => "cacheWrite",
        other => other,
    };
    cost.get(name)
        .or_else(|| cost.get(camel))
        .and_then(serde_json::Value::as_f64)
}

/// Best-effort USD saved by the aggregated cache reads (prices per million tokens).
fn savings_usd(aggregate_read: u32, aggregate_write: u32, cost: &serde_json::Value) -> Option<f64> {
    let input = cost_price(cost, "input")?;
    let read = cost_price(cost, "cache_read")?;
    let read_saved = (f64::from(aggregate_read) / 1_000_000.0) * (input - read).max(0.0);
    let write_extra = match cost_price(cost, "cache_write") {
        Some(write) => (f64::from(aggregate_write) / 1_000_000.0) * (write - input).max(0.0),
        None => 0.0,
    };
    Some((read_saved - write_extra).max(0.0))
}

fn sample_stats(sample: &CacheSample) -> CacheStats {
    CacheStats {
        hit_percent: sample.hit_percent,
        session_hit_percent: None,
        steady_hit_percent: None,
        ceiling_percent: sample.ceiling_percent,
        input_total: sample.input_total,
        cache_read: sample.cache_read,
        cache_write: sample.cache_write,
        uncached: sample.uncached,
        eligible: sample.eligible,
        excluded_reason: sample.excluded_reason.clone(),
        state: sample.state,
        epoch: sample.epoch,
        samples: 1,
        min_cacheable_tokens: None,
        ttl_seconds: None,
        break_reason: sample.break_reason,
        break_detail: sample.break_detail.clone(),
        provider_policy: None,
        at: sample.at,
        savings_usd: None,
    }
}

fn enrich(
    stats: &mut CacheStats,
    caps: Option<&CacheCapabilities>,
    cost: Option<&serde_json::Value>,
) {
    if let Some(caps) = caps {
        stats.min_cacheable_tokens = caps.min_tokens;
        stats.ttl_seconds = default_ttl_seconds(caps);
    }
    if let Some(cost) = cost {
        stats.savings_usd = savings_usd(stats.cache_read, stats.cache_write, cost);
    }
    if stats.state == crate::domain::CacheState::ProviderPolicy {
        stats
            .provider_policy
            .get_or_insert_with(|| "provider".to_string());
    }
}

/// Cache aggregate + recent samples of a conversation (restores the chip).
#[tauri::command]
pub async fn get_cache_stats(
    state: State<'_, AppState>,
    conversation_id: String,
    limit: Option<u32>,
) -> Result<CacheStatsView, String> {
    let conversation_id = conversation_id.trim().to_string();
    if conversation_id.is_empty() {
        return Err(crate::i18n::t("cache.errors.invalidConversation").into());
    }
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let db = &state.db;

    let mut recent = db
        .list_cache_samples(&conversation_id, limit)
        .map_err(|error| db_error(error, "listar as amostras de cache"))?;
    // `list_cache_samples` returns newest first; the UI renders oldest -> newest.
    recent.reverse();

    let aggregate = db
        .cache_session_aggregate(&conversation_id)
        .map_err(|error| db_error(error, "agregar as amostras de cache"))?;
    let record = db
        .get_cache_state(&conversation_id)
        .map_err(|error| db_error(error, "ler o estado de cache"))?;

    // Capabilities + prices for TTL/min/savings come from the bundled catalog.
    let conversation = db
        .get_conversation(&conversation_id)
        .ok()
        .flatten()
        .ok_or_else(|| crate::i18n::t("cache.errors.conversationNotFound"))?;
    let provider = state.provider(&conversation.provider_id);
    let model = state.model(&conversation.provider_id, &conversation.model_id);
    let caps = provider.as_ref().zip(model.as_ref()).and_then(|(provider, model)| {
        let protocol = model
            .protocols
            .iter()
            .find_map(|value| crate::providers::WireProtocol::parse(value))?;
        Some(crate::providers::cache::capabilities_for(
            protocol, provider, model,
        ))
    });
    let cost = model.as_ref().and_then(|model| model.cost.as_ref());

    let mut current = recent.last().map(sample_stats);
    if let Some(current) = current.as_mut() {
        enrich(current, caps.as_ref(), cost);
    }

    let session = if aggregate.samples == 0 {
        None
    } else {
        let last = recent.last();
        let mut session = CacheStats {
            hit_percent: last.and_then(|sample| sample.hit_percent),
            session_hit_percent: aggregate.hit_percent(),
            steady_hit_percent: aggregate.eligible_hit_percent(),
            ceiling_percent: last.and_then(|sample| sample.ceiling_percent),
            input_total: aggregate.input_total,
            cache_read: aggregate.cache_read,
            cache_write: aggregate.cache_write,
            uncached: aggregate.uncached,
            eligible: aggregate.eligible_samples > 0,
            excluded_reason: last.and_then(|sample| sample.excluded_reason.clone()),
            state: last
                .map(|sample| sample.state)
                .unwrap_or(crate::domain::CacheState::Cold),
            epoch: record.as_ref().map(|record| record.epoch).unwrap_or(0),
            samples: aggregate.samples,
            min_cacheable_tokens: None,
            ttl_seconds: None,
            break_reason: last
                .and_then(|sample| sample.break_reason)
                .or_else(|| record.as_ref().and_then(|record| record.last_break_reason)),
            break_detail: last
                .and_then(|sample| sample.break_detail.clone())
                .or_else(|| record.as_ref().and_then(|record| record.last_break_detail.clone())),
            provider_policy: None,
            at: last
                .map(|sample| sample.at)
                .unwrap_or_else(crate::domain::now_ms),
            savings_usd: None,
        };
        enrich(&mut session, caps.as_ref(), cost);
        Some(session)
    };

    Ok(CacheStatsView {
        conversation_id,
        current,
        session,
        epoch: record.as_ref().map(|record| record.epoch).unwrap_or(0),
        recent,
    })
}

#[cfg(test)]
mod tests {
    use super::{cost_price, savings_usd, ttl_seconds};

    #[test]
    fn ttl_labels_map_to_seconds() {
        assert_eq!(ttl_seconds("5m"), Some(300));
        assert_eq!(ttl_seconds("1h"), Some(3_600));
        assert_eq!(ttl_seconds("30m"), Some(1_800));
        assert_eq!(ttl_seconds("12h"), Some(43_200));
        assert_eq!(ttl_seconds("24h"), Some(86_400));
        assert_eq!(ttl_seconds("in_memory"), None);
        assert_eq!(ttl_seconds(""), None);
    }

    #[test]
    fn cost_prices_accept_snake_and_camel_case() {
        let cost = serde_json::json!({
            "input": 0.15,
            "cache_read": 0.003,
            "cacheWrite": 0.1875,
        });
        assert_eq!(cost_price(&cost, "input"), Some(0.15));
        assert_eq!(cost_price(&cost, "cache_read"), Some(0.003));
        assert_eq!(cost_price(&cost, "cache_write"), Some(0.1875));
        assert_eq!(cost_price(&cost, "output"), None);
    }

    #[test]
    fn savings_discounts_reads_and_charges_write_premium() {
        let cost = serde_json::json!({
            "input": 0.15,
            "cache_read": 0.003,
            "cache_write": 0.1875,
        });
        // 1M reads: 0.147 saved; 1M writes: 0.0375 extra -> 0.1095 net.
        let saved = savings_usd(1_000_000, 1_000_000, &cost).expect("savings");
        assert!((saved - 0.1095).abs() < 1e-9, "savings={saved}");
        // Without cache read price there is no honest estimate.
        assert_eq!(savings_usd(1_000_000, 0, &serde_json::json!({"input": 1.0})), None);
    }
}