//! Pipeline de execução de tool calls do harness.
//!
//! Responsabilidades (F0):
//! - agrupar chamadas de um passo em lotes que respeitam a classe de
//!   paralelismo declarada no [`ToolSpec`] (`Safe` ∥, `PathLocked` por path,
//!   `Exclusive` como barreira), preservando a ordem dos resultados;
//! - traduzir a decisão da política ([`crate::policy::PolicyDecision`]) para o
//!   despacho do loop ([`Dispatch`]);
//! - detectar repetição idêntica de tool+argumentos e produzir o lembrete que
//!   o loop injeta no próximo passo (anti-loop barato, como no DSH).
//!
//! A execução em si (spawn de tasks, emit de progresso, persistência da
//! apresentação) fica no `harness`, que é dono do turno.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::domain::{RiskClass, ToolCallRecord};
use crate::policy::PolicyDecision;
use crate::tools::registry::{ParallelClass, ToolSpec};

/// Chamadas paralelas por lote (TOOLS.md §4: até 8 em paralelo).
pub const DEFAULT_MAX_PARALLEL: usize = 8;

/// Lembretes de repetição: o modelo recebe o aviso quando o mesmo lote de
/// tool calls aparece pela terceira vez consecutiva (TOOLS.md §4).
pub const REPEAT_THRESHOLD: usize = 3;

/// Tools whose identical consecutive calls are expected while waiting.
pub const REPEAT_EXEMPT_TOOLS: &[&str] = &["ask_user", "job_output", "task_wait"];

pub fn is_repeat_exempt(name: &str) -> bool {
    REPEAT_EXEMPT_TOOLS.contains(&name)
}

/// Uma chamada pronta para escalonar, com a spec resolvida do catálogo.
#[derive(Debug, Clone)]
pub struct ToolCallRequest {
    pub call: ToolCallRecord,
    pub spec: &'static ToolSpec,
}

impl ToolCallRequest {
    pub fn new(call: ToolCallRecord, spec: &'static ToolSpec) -> Self {
        Self { call, spec }
    }
}

/// O que fazer com uma chamada depois da política.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatch {
    /// Executa sem interação.
    Allow,
    /// Pausa o turno e pede decisão ao usuário.
    Ask { risk: RiskClass, reason: String },
    /// Recusa imediatamente; o modelo recebe `Error: <reason>`.
    Deny { code: &'static str, reason: String },
}

impl Dispatch {
    pub fn is_allow(&self) -> bool {
        matches!(self, Self::Allow)
    }

    pub fn is_deny(&self) -> bool {
        matches!(self, Self::Deny { .. })
    }

    /// Converte a decisão pura da política no despacho do loop.
    pub fn from_decision(decision: PolicyDecision) -> Self {
        match decision {
            PolicyDecision::Allow => Self::Allow,
            PolicyDecision::Ask { risk, reason } => Self::Ask { risk, reason },
            PolicyDecision::Deny { code, reason } => Self::Deny { code, reason },
        }
    }
}

impl From<PolicyDecision> for Dispatch {
    fn from(decision: PolicyDecision) -> Self {
        Self::from_decision(decision)
    }
}

/// Agrupa as chamadas em lotes executáveis, na ordem original.
///
/// Regras:
/// - `Safe`: acumula no lote atual até [`DEFAULT_MAX_PARALLEL`];
/// - `Exclusive`: fecha o lote atual e roda sozinha (barreira de ordem);
/// - `PathLocked`: paralela entre paths distintos; o mesmo path (ou a falta de
///   `arguments.path`, quando não é possível provar que os alvos são disjuntos)
///   fecha o lote atual e vira um novo lote.
///
/// Cada índice aparece exatamente uma vez; dentro de um lote os índices são
/// crescentes, então `flatten()` devolve a ordem dos resultados.
pub fn plan(calls: &[ToolCallRequest]) -> Vec<Vec<usize>> {
    plan_with_limit(calls, DEFAULT_MAX_PARALLEL)
}

/// Igual a [`plan`], com limite explícito de chamadas por lote (`1` = serial).
pub fn plan_with_limit(calls: &[ToolCallRequest], max_parallel: usize) -> Vec<Vec<usize>> {
    /// Tipo do lote em construção: só `Safe` e `PathLocked` agrupam.
    enum BatchKind {
        Safe,
        PathLocked(HashSet<String>),
    }

    fn flush(
        batches: &mut Vec<Vec<usize>>,
        current: &mut Vec<usize>,
        kind: &mut Option<BatchKind>,
    ) {
        if !current.is_empty() {
            batches.push(std::mem::take(current));
        }
        *kind = None;
    }

    let limit = max_parallel.max(1);
    let mut batches: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut kind: Option<BatchKind> = None;

    for (index, request) in calls.iter().enumerate() {
        match request.spec.parallel {
            // Barreira: fecha o lote atual e roda sozinha.
            ParallelClass::Exclusive => {
                flush(&mut batches, &mut current, &mut kind);
                batches.push(vec![index]);
            }
            ParallelClass::Safe => {
                let joins = matches!(kind, Some(BatchKind::Safe)) && current.len() < limit;
                if !joins {
                    flush(&mut batches, &mut current, &mut kind);
                    kind = Some(BatchKind::Safe);
                }
                current.push(index);
            }
            ParallelClass::PathLocked => {
                let path = tool_target_path(&request.call);
                let Some(path) = path else {
                    // Sem `arguments.path` não há como provar alvos disjuntos:
                    // a chamada vira barreira e nada junta no lote seguinte.
                    flush(&mut batches, &mut current, &mut kind);
                    batches.push(vec![index]);
                    continue;
                };
                let joins = match &mut kind {
                    Some(BatchKind::PathLocked(paths)) => {
                        current.len() < limit && !paths.contains(&path)
                    }
                    _ => false,
                };
                if joins {
                    if let Some(BatchKind::PathLocked(paths)) = &mut kind {
                        paths.insert(path);
                    }
                } else {
                    flush(&mut batches, &mut current, &mut kind);
                    kind = Some(BatchKind::PathLocked(HashSet::from([path])));
                }
                current.push(index);
            }
        }
    }
    flush(&mut batches, &mut current, &mut kind);
    batches
}

/// Extrai o alvo de uma chamada PathLocked dos argumentos JSON.
///
/// Tool de escrita/edição declara `path`; sem path válido a chamada não pode
/// ser paralelizada com segurança (o caller a trata como barreira).
fn tool_target_path(call: &ToolCallRecord) -> Option<String> {
    let arguments: Value = serde_json::from_str(call.arguments.trim()).ok()?;
    let path = arguments.get("path")?.as_str()?.trim();
    if path.is_empty() {
        return None;
    }
    // Normaliza separador para comparar `src/a.ts` com `src\a.ts`.
    Some(path.replace('\\', "/"))
}

/// Canonical signature of one assistant step's tool batch, ignoring exempt
/// tools. `None` when the batch has no eligible call (waiting/polling only).
pub fn step_signature(calls: &[ToolCallRecord]) -> Option<String> {
    let mut parts: Vec<String> = calls
        .iter()
        .filter(|call| !is_repeat_exempt(&call.name))
        .map(|call| format!("{}:{}", call.name, normalize_arguments(&call.arguments)))
        .collect();
    if parts.is_empty() {
        return None;
    }
    parts.sort();
    Some(parts.join("\n"))
}

/// Model-facing corrective for a repeated step.
pub fn repeat_reminder(call: &ToolCallRecord, count: u32) -> String {
    format!(
        "[loop-guard] `{}` was called with identical arguments {count} steps in a row. \
         The result is already in this conversation; do not repeat it. Use different \
         arguments, choose another tool, or finish with what you have.",
        call.name
    )
}

/// Normaliza os argumentos para comparar JSON semanticamente igual.
///
/// JSON inválido cai no texto bruto aparado (nunca panica: os argumentos vêm
/// do modelo e podem estar malformados).
fn normalize_arguments(raw: &str) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut entries: Vec<(String, Value)> = map
                    .iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                let mut result = Map::new();
                for (key, value) in entries {
                    result.insert(key, value);
                }
                Value::Object(result)
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            _ => value.clone(),
        }
    }
    let trimmed = raw.trim();
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => serde_json::to_string(&sorted(&value)).unwrap_or_else(|_| trimmed.to_string()),
        Err(_) => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::registry::find_spec;
    use crate::domain::TurnProfile;

    fn request(tool: &str, arguments: &str) -> ToolCallRequest {
        let spec = find_spec(TurnProfile::Code, tool).unwrap_or_else(|| panic!("spec {tool}"));
        let mut call = ToolCallRecord::running(format!("call-{tool}"), tool);
        call.arguments = arguments.to_string();
        ToolCallRequest::new(call, spec)
    }

    #[test]
    fn safe_calls_use_the_default_parallel_limit() {
        let calls: Vec<_> = (0..9)
            .map(|index| request("read_file", &format!("{{\"path\":\"src/{index}.rs\"}}")))
            .collect();
        let batches = plan(&calls);
        assert_eq!(
            batches,
            vec![vec![0, 1, 2, 3, 4, 5, 6, 7], vec![8]]
        );
    }

    #[test]
    fn safe_calls_are_batched_up_to_the_limit() {
        let calls: Vec<_> = (0..5)
            .map(|index| request("read_file", &format!("{{\"path\":\"src/{index}.rs\"}}")))
            .collect();
        let batches = plan_with_limit(&calls, 2);
        assert_eq!(batches, vec![vec![0, 1], vec![2, 3], vec![4]]);
    }

    #[test]
    fn exclusive_calls_are_order_barriers() {
        let calls = vec![
            request("read_file", "{\"path\":\"a\"}"),
            request("run_command", "{\"command\":\"npm test\",\"description\":\"rodar testes\"}"),
            request("read_file", "{\"path\":\"b\"}"),
        ];
        assert_eq!(plan(&calls), vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn path_locked_calls_serialize_the_same_path() {
        let calls = vec![
            request("write_file", "{\"path\":\"src/a.ts\",\"content\":\"x\"}"),
            request("edit_file", "{\"path\":\"src/a.ts\",\"old_string\":\"x\",\"new_string\":\"y\"}"),
            request("write_file", "{\"path\":\"src/b.ts\",\"content\":\"z\"}"),
        ];
        assert_eq!(plan(&calls), vec![vec![0], vec![1, 2]]);
    }

    #[test]
    fn path_locked_calls_parallelize_distinct_paths() {
        let calls = vec![
            request("write_file", "{\"path\":\"src/a.ts\",\"content\":\"a\"}"),
            request("write_file", "{\"path\":\"src/b.ts\",\"content\":\"b\"}"),
            // Barra invertida do Windows é normalizada para `/` antes de comparar.
            request("write_file", "{\"path\":\"src\\\\c.ts\",\"content\":\"c\"}"),
        ];
        assert_eq!(plan(&calls), vec![vec![0, 1, 2]]);
    }

    #[test]
    fn path_locked_without_path_is_a_barrier() {
        let calls = vec![
            request("write_file", "{\"path\":\"src/a.ts\",\"content\":\"a\"}"),
            request("edit_file", "{}"),
            request("write_file", "{\"path\":\"src/c.ts\",\"content\":\"c\"}"),
        ];
        assert_eq!(plan(&calls), vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn every_index_appears_once_and_order_is_preserved() {
        let calls = vec![
            request("read_file", "{\"path\":\"a\"}"),
            request("write_file", "{\"path\":\"a\",\"content\":\"1\"}"),
            request("search_text", "{\"query\":\"x\"}"),
            request("run_command", "{\"command\":\"ls\",\"description\":\"listar\"}"),
            request("write_file", "{\"path\":\"b\",\"content\":\"2\"}"),
            request("read_file", "{\"path\":\"c\"}"),
        ];
        let batches = plan(&calls);
        let flat: Vec<usize> = batches.iter().flatten().copied().collect();
        assert_eq!(flat, (0..calls.len()).collect::<Vec<_>>());
        // Nenhum lote vazio e nenhum índice repetido.
        assert!(batches.iter().all(|batch| !batch.is_empty()));
        let mut unique = flat.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), flat.len());
    }

    #[test]
    fn limit_of_one_restores_serial_dispatch() {
        let calls: Vec<_> = (0..3)
            .map(|index| request("read_file", &format!("{{\"path\":\"f{index}\"}}")))
            .collect();
        assert_eq!(plan_with_limit(&calls, 1), vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn identical_steps_produce_the_same_signature_even_with_key_order_changes() {
        let first = request("edit_file", "{\"path\":\"a\",\"old_string\":\"x\",\"new_string\":\"y\"}").call;
        let compact = request("edit_file", "{\"new_string\":\"y\",\"old_string\":\"x\",\"path\":\"a\"}").call;
        let third = request("edit_file", "{ \"path\": \"a\", \"old_string\": \"x\", \"new_string\": \"y\" }").call;
        let signature = step_signature(&[first]).expect("assinatura");
        assert_eq!(signature, step_signature(&[compact]).expect("assinatura"));
        assert_eq!(signature, step_signature(&[third]).expect("assinatura"));
    }

    #[test]
    fn different_arguments_or_tools_change_the_signature() {
        let a = request("read_file", "{\"path\":\"a.ts\"}").call;
        let b = request("read_file", "{\"path\":\"b.ts\"}").call;
        let c = request("search_text", "{\"query\":\"a.ts\"}").call;
        let a_signature = step_signature(&[a]);
        let b_signature = step_signature(&[b]);
        let c_signature = step_signature(&[c]);
        assert_ne!(a_signature, b_signature);
        assert_ne!(b_signature, c_signature);
    }

    #[test]
    fn exempt_tools_do_not_form_a_signature() {
        for tool in REPEAT_EXEMPT_TOOLS {
            let mut call = ToolCallRecord::running(format!("call-{tool}"), *tool);
            call.arguments = "{}".to_string();
            assert!(step_signature(&[call]).is_none(), "{tool}");
        }
        let mixed = [
            request("read_file", "{\"path\":\"a.ts\"}").call,
            ToolCallRecord::running("call-job", "job_output"),
        ];
        assert!(step_signature(&mixed).is_some());
    }

    #[test]
    fn reminder_names_the_tool_and_count() {
        let call = request("read_file", "{\"path\":\"a.ts\"}").call;
        let reminder = repeat_reminder(&call, 3);
        assert!(reminder.starts_with("[loop-guard]"));
        assert!(reminder.contains("read_file"));
        assert!(reminder.contains('3'));
    }

    #[test]
    fn dispatch_maps_the_policy_decision() {
        assert_eq!(Dispatch::from_decision(PolicyDecision::Allow), Dispatch::Allow);
        let ask = Dispatch::from_decision(PolicyDecision::Ask {
            risk: RiskClass::Shell,
            reason: "pede aprovação".into(),
        });
        assert_eq!(
            ask,
            Dispatch::Ask { risk: RiskClass::Shell, reason: "pede aprovação".into() }
        );
        let deny = Dispatch::from_decision(PolicyDecision::Deny {
            code: "POLICY_DENIED",
            reason: "negado".into(),
        });
        assert!(deny.is_deny());
        assert!(!deny.is_allow());
    }

    /// Sanidade: o helper de path lê `arguments.path` e ignora lixo.
    #[test]
    fn target_path_is_extracted_safely() {
        let call = request("write_file", "{\"path\":\"src\\\\a.ts\",\"content\":\"\"}").call;
        assert_eq!(tool_target_path(&call).as_deref(), Some("src/a.ts"));
        let mut broken = request("write_file", "not-json").call;
        assert_eq!(tool_target_path(&broken), None);
        broken.arguments = "{\"path\":\"\"}".into();
        assert_eq!(tool_target_path(&broken), None);
    }
}
