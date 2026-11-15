//! UI generativa v2 — contrato, normalização, validação estrutural e lint.
//!
//! O agente emite blocos cercados com a linguagem `ui` contendo JSON declarativo
//! (`{ "components": [...] }` ou um array cru). Este módulo é o lado Rust do
//! contrato compartilhado `data/genui-contract.json`; o renderer TypeScript tem
//! uma implementação espelhada e `data/genui-fixtures.json` garante a paridade.
//!
//! Pipeline (espelho de `src/lib/genui/normalize.ts` + `schema.ts`):
//! 1. limite de tamanho da origem (`limits.sourceChars`);
//! 2. strip de cerca opcional + parse do JSON;
//! 3. raiz (`components` ou array cru), aviso de versão e validação da raiz;
//! 4. normalização + validação estrutural recursiva contra o contrato;
//! 5. só sem erros: lint das regras de design (`contract.rules`) sobre a árvore.
//!
//! Diagnóstico = `{ code, severity, path, message, hint? }`. Erros impedem a
//! renderização (`normalized = null`); avisos não. O cap
//! `limits.diagnosticsPerCode` é aplicado por código, inclusive em erros.
//!
//! Nada de HTML/JS/CSS é avaliado: o JSON é apenas lido, normalizado e checado.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};

use crate::providers::ToolDefinition;

use super::ToolOutcome;

pub mod contract;
pub mod extension;

#[cfg(test)]
mod fixtures;
mod lint;
mod normalize;

pub use contract::contract;

/// Códigos de diagnóstico (o prefixo `ui.` é o namespace compartilhado com o TS).
pub mod codes {
    // Erros: o bloco não é renderizável.
    pub const SOURCE_TOO_LARGE: &str = "ui.source-too-large";
    pub const INVALID_JSON: &str = "ui.invalid-json";
    pub const INVALID_ROOT: &str = "ui.invalid-root";
    pub const EMPTY: &str = "ui.empty";
    pub const INVALID_COMPONENT: &str = "ui.invalid-component";
    pub const MISSING_TYPE: &str = "ui.missing-type";
    pub const UNKNOWN_TYPE: &str = "ui.unknown-type";
    pub const INVALID_PROPS: &str = "ui.invalid-props";
    pub const INVALID_CHILDREN: &str = "ui.invalid-children";
    pub const CHILDREN_NOT_ALLOWED: &str = "ui.children-not-allowed";
    pub const MISSING_PROP: &str = "ui.missing-prop";
    pub const PROP_TYPE: &str = "ui.prop-type";
    pub const INVALID_URL: &str = "ui.invalid-url";
    pub const ARRAY_SIZE: &str = "ui.array-size";
    pub const TOO_MANY_NODES: &str = "ui.too-many-nodes";
    pub const TOO_DEEP: &str = "ui.too-deep";
    pub const TABS_EMPTY: &str = "ui.tabs-empty";
    pub const TABS_LABEL: &str = "ui.tabs-label";
    pub const ACTION_INVALID: &str = "ui.action-invalid";

    // Avisos: o bloco renderiza, mas pode ser melhorado.
    pub const VERSION_MISMATCH: &str = "ui.version-mismatch";
    pub const UNKNOWN_PROP: &str = "ui.unknown-prop";
    pub const COERCED: &str = "ui.coerced";
    pub const ENUM_DEFAULT: &str = "ui.enum-default";
    pub const TEXT_TRUNCATED: &str = "ui.text-truncated";
    pub const ARRAY_TRUNCATED: &str = "ui.array-truncated";
    pub const CLAMPED: &str = "ui.clamped";
    pub const ICON_UNKNOWN: &str = "ui.icon-unknown";
    pub const LEGACY_SHAPE: &str = "ui.legacy-shape";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// Um diagnóstico do validador/linter, serializado no contrato compartilhado.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    /// Caminho no documento, ex.: `components[0].children[1].props.items[2]`.
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// Resultado do pipeline para um bloco `ui`.
#[derive(Debug, Clone, Default)]
pub struct Analysis {
    pub diagnostics: Vec<Diagnostic>,
    /// `{ "components": [...] }` normalizado, apenas quando não há erros.
    pub normalized: Option<Value>,
    /// Total de componentes (nós) visitados no bloco.
    pub component_count: usize,
}

impl Analysis {
    pub fn is_ok(&self) -> bool {
        !self.diagnostics.iter().any(|diagnostic| diagnostic.severity == Severity::Error)
    }

    pub fn errors(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Error)
    }

    pub fn warnings(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Warning)
    }

    pub fn error_count(&self) -> usize {
        self.errors().count()
    }

    pub fn warning_count(&self) -> usize {
        self.warnings().count()
    }
}

/// Coletor de diagnósticos com o cap `limits.diagnosticsPerCode` por código.
pub(crate) struct DiagnosticSink {
    per_code: usize,
    counts: BTreeMap<String, usize>,
    pub diagnostics: Vec<Diagnostic>,
}

impl DiagnosticSink {
    pub(crate) fn new(per_code: usize) -> Self {
        Self {
            per_code,
            counts: BTreeMap::new(),
            diagnostics: Vec::new(),
        }
    }

    fn push(
        &mut self,
        code: &str,
        severity: Severity,
        path: impl Into<String>,
        message: impl Into<String>,
        hint: Option<String>,
    ) {
        let count = self.counts.entry(code.to_string()).or_insert(0);
        if *count >= self.per_code {
            return;
        }
        *count += 1;
        self.diagnostics.push(Diagnostic {
            code: code.to_string(),
            severity,
            path: path.into(),
            message: message.into(),
            hint,
        });
    }

    pub(crate) fn error(
        &mut self,
        code: &str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.push(code, Severity::Error, path, message, None);
    }

    pub(crate) fn warning(
        &mut self,
        code: &str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.push(code, Severity::Warning, path, message, None);
    }

    pub(crate) fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == Severity::Error)
    }
}

/// Analisa um bloco `ui` completo (texto entre as cercas). Nunca falha/entra em
/// pânico: qualquer problema vira diagnóstico.
pub fn analyze(source: &str) -> Analysis {
    analyze_with(source, &BTreeMap::new())
}

pub fn analyze_with(
    source: &str,
    extra: &BTreeMap<String, super::genui::contract::ComponentSpec>,
) -> Analysis {
    let contract = contract();
    let mut sink = DiagnosticSink::new(contract.limits.diagnostics_per_code);

    if source.chars().count() > contract.limits.source_chars {
        sink.error(
            codes::SOURCE_TOO_LARGE,
            "",
            format!(
                "O bloco de UI generativa excede {} caracteres.",
                contract.limits.source_chars
            ),
        );
        return Analysis {
            diagnostics: sink.diagnostics,
            normalized: None,
            component_count: 0,
        };
    }

    let text = strip_code_fence(source);
    if text.is_empty() {
        sink.error(codes::INVALID_JSON, "", "O bloco `ui` está vazio.");
        return Analysis {
            diagnostics: sink.diagnostics,
            normalized: None,
            component_count: 0,
        };
    }

    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            sink.error(codes::INVALID_JSON, "", format!("JSON inválido: {error}"));
            return Analysis {
                diagnostics: sink.diagnostics,
                normalized: None,
                component_count: 0,
            };
        }
    };

    // Raiz: `{ components: [...] }` ou um array cru de componentes.
    let components: Vec<Value> = match value {
        Value::Array(components) => components,
        Value::Object(mut object) => {
            if let Some(version) = object.remove("version") {
                let matches = version
                    .as_f64()
                    .map(|value| value == f64::from(contract.format.version))
                    .unwrap_or(false);
                if !matches {
                    sink.warning(
                        codes::VERSION_MISMATCH,
                        "version",
                        format!(
                            "Versão {} desconhecida; o bloco foi lido como versão {}.",
                            compact_json(&version),
                            contract.format.version
                        ),
                    );
                }
            }
            match object.remove("components") {
                Some(Value::Array(components)) => components,
                Some(_) => {
                    sink.error(
                        codes::INVALID_ROOT,
                        "",
                        "Estrutura inválida: `components` deve ser uma lista de componentes.",
                    );
                    return Analysis {
                        diagnostics: sink.diagnostics,
                        normalized: None,
                        component_count: 0,
                    };
                }
                None => {
                    sink.error(
                        codes::INVALID_ROOT,
                        "",
                        "Estrutura inválida: esperado um objeto { \"version\"?: 2, \
                         \"components\": [...] }.",
                    );
                    return Analysis {
                        diagnostics: sink.diagnostics,
                        normalized: None,
                        component_count: 0,
                    };
                }
            }
        }
        _ => {
            sink.error(
                codes::INVALID_ROOT,
                "",
                "Estrutura inválida: esperado um objeto { \"version\"?: 2, \
                 \"components\": [...] } ou um array de componentes.",
            );
            return Analysis {
                diagnostics: sink.diagnostics,
                normalized: None,
                component_count: 0,
            };
        }
    };

    if components.is_empty() {
        sink.error(codes::EMPTY, "components", "Nenhum componente para renderizar.");
        return Analysis {
            diagnostics: sink.diagnostics,
            normalized: None,
            component_count: 0,
        };
    }

    let (normalized_components, component_count) =
        normalize::normalize_components(contract, &components, extra, &mut sink);

    if sink.has_errors() {
        return Analysis {
            diagnostics: sink.diagnostics,
            normalized: None,
            component_count,
        };
    }

    let spec = json!({ "components": normalized_components });
    // O lint só roda quando não há erros estruturais (igual ao lado TS).
    sink.diagnostics.extend(lint::lint(contract, &spec));

    Analysis {
        diagnostics: sink.diagnostics,
        normalized: Some(spec),
        component_count,
    }
}

/// Remove a cerca Markdown ao redor do JSON, como o `stripCodeFence` do TS.
fn strip_code_fence(source: &str) -> String {
    let trimmed = source.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let language_chars = rest
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || *character == '_' || *character == '-'
            })
            .count();
        let body = rest[language_chars..].trim();
        if let Some(inner) = body.strip_suffix("```") {
            return inner.trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Resumo pt-BR para o card da ferramenta, ex.:
/// `"UI válida: 12 componentes, 0 avisos"` / `"UI inválida: 1 erro, 2 avisos"`.
pub fn summary(analysis: &Analysis) -> String {
    let errors = analysis.error_count();
    let warnings = analysis.warning_count();
    let warning_label = count_label("tools.genui.warnings", warnings);
    if errors > 0 {
        crate::i18n::t_args(
            "tools.genui.summary.invalid",
            &[
                ("errors", &count_label("tools.genui.errors", errors)),
                ("warnings", &warning_label),
            ],
        )
    } else {
        crate::i18n::t_args(
            "tools.genui.summary.valid",
            &[
                (
                    "components",
                    &count_label("tools.genui.components", analysis.component_count),
                ),
                ("warnings", &warning_label),
            ],
        )
    }
}

/// Localized "N components" noun phrase (counted for plural agreement).
fn count_label(key: &str, count: usize) -> String {
    crate::i18n::t_count(key, count, &[("count", &count.to_string())])
}

#[allow(dead_code)]
fn plural<'a>(count: usize, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1 {
        singular
    } else {
        plural
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "?".to_string())
}

/* ------------------------------------------------------------------ */
/* Ferramenta validate_ui                                              */
/* ------------------------------------------------------------------ */

/// Definição da ferramenta exposta ao modelo (sempre disponível, independente
/// das opções do turno).
pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "validate_ui".to_string(),
        description: "Validates and normalizes the JSON of a `ui` block (generative UI) before \
                      writing it into the answer. Receives the full block JSON and returns \
                      `{ ok, summary, errors, warnings, normalized }`: errors block rendering; \
                      warnings are design suggestions. Always available; does not count toward \
                      the 6-call data-tool budget — ideally at most 2 times per response."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "block": {
                    "type": "string",
                    "description": "Full JSON of the `ui` block (the same text that would go \
                                    between ```ui and ```), with `{\"components\": [...]}` or a \
                                    bare array of components."
                }
            },
            "required": ["block"],
            "additionalProperties": false
        }),
    }
}

/// Executa `validate_ui`. O retorno é JSON textual e `is_error` fica `false`
/// mesmo quando a UI tem erros (o card mostra o resultado, não uma falha).
pub fn run(args: &Value) -> ToolOutcome {
    let source = match args.get("block") {
        Some(Value::String(block)) => block.clone(),
        // Robustez: aceitar o objeto/array já parseado em vez do texto.
        Some(Value::Null) | None => {
            return ToolOutcome::error(crate::i18n::t("tools.genui.blockRequired"))
        }
        Some(other) => compact_json(other),
    };

    let extra_components = extension::active_components();
    let extra = extension::component_map(&extra_components);
    let analysis = analyze_with(&source, &extra);
    let summary = summary(&analysis);
    let response = ToolResponse {
        ok: analysis.is_ok(),
        summary: &summary,
        errors: analysis.errors().collect(),
        warnings: analysis.warnings().collect(),
        normalized: analysis.normalized.as_ref(),
    };
    let content = serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string());

    ToolOutcome {
        content,
        summary: Some(summary),
        ..Default::default()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolResponse<'a> {
    ok: bool,
    summary: &'a str,
    errors: Vec<&'a Diagnostic>,
    warnings: Vec<&'a Diagnostic>,
    normalized: Option<&'a Value>,
}

/* ------------------------------------------------------------------ */
/* Varredura de blocos ```ui em Markdown (usada pelo harness)          */
/* ------------------------------------------------------------------ */

/// Extrai e analisa todos os blocos cercados com a linguagem `ui` de um texto
/// Markdown. Blocos não fechados viram um diagnóstico `ui.invalid-json`.
pub fn scan_markdown_blocks(text: &str) -> Vec<Analysis> {
    let mut analyses = Vec::new();
    let mut in_block = false;
    let mut buffer = String::new();

    for line in text.lines() {
        let trimmed = line.trim_start();
        if in_block {
            if trimmed.starts_with("```") {
                analyses.push(analyze(&buffer));
                buffer.clear();
                in_block = false;
            } else {
                buffer.push_str(line);
                buffer.push('\n');
            }
            continue;
        }
        if is_ui_fence_open(trimmed) {
            in_block = true;
            buffer.clear();
        }
    }

    if in_block {
        analyses.push(Analysis {
            diagnostics: vec![Diagnostic {
                code: codes::INVALID_JSON.to_string(),
                severity: Severity::Error,
                path: String::new(),
                message: "Bloco ```ui não foi fechado.".to_string(),
                hint: None,
            }],
            normalized: None,
            component_count: 0,
        });
    }

    analyses
}

fn is_ui_fence_open(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("```") else {
        return false;
    };
    let Some(language) = rest.strip_prefix("ui") else {
        return false;
    };
    language.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_codes(analysis: &Analysis) -> Vec<&str> {
        analysis
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Error)
            .map(|diagnostic| diagnostic.code.as_str())
            .collect()
    }

    fn warning_codes(analysis: &Analysis) -> Vec<&str> {
        analysis
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Warning)
            .map(|diagnostic| diagnostic.code.as_str())
            .collect()
    }

    #[test]
    fn accepts_the_canonical_example_without_warnings() {
        let analysis = analyze(contract::EXAMPLE_JSON);
        assert!(analysis.is_ok(), "erros: {:?}", error_codes(&analysis));
        assert!(
            analysis.warnings().next().is_none(),
            "o exemplo canônico precisa ser lint-clean; avisos: {:?}",
            warning_codes(&analysis)
        );
        assert!(analysis.normalized.is_some());
        assert_eq!(summary(&analysis), "UI válida: 8 componentes, 0 avisos");
    }

    #[test]
    fn accepts_the_minimal_example_without_warnings() {
        let analysis = analyze(contract::MINIMAL_EXAMPLE_JSON);
        assert!(analysis.is_ok(), "erros: {:?}", error_codes(&analysis));
        assert!(
            analysis.warnings().next().is_none(),
            "exemplo mínimo com avisos: {:?}",
            warning_codes(&analysis)
        );
    }

    #[test]
    fn rejects_invalid_json_and_oversized_sources() {
        let analysis = analyze("{\"components\":[");
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_JSON]);
        assert!(analysis.normalized.is_none());

        let analysis = analyze("");
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_JSON]);

        let huge = "x".repeat(contract().limits.source_chars + 1);
        let analysis = analyze(&huge);
        assert_eq!(error_codes(&analysis), vec![codes::SOURCE_TOO_LARGE]);
    }

    #[test]
    fn strips_an_optional_markdown_fence() {
        let fenced = "```ui {\"components\":[{\"type\":\"badge\",\"props\":{\"label\":\"ok\"}}]} ```";
        let analysis = analyze(fenced);
        assert!(analysis.is_ok(), "erros: {:?}", error_codes(&analysis));
        assert_eq!(
            analysis.normalized,
            Some(json!({"components":[{"type":"badge","props":{"label":"ok"}}]}))
        );
    }

    #[test]
    fn validates_the_root_shape() {
        let analysis = analyze("{\"foo\":[]}");
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_ROOT]);

        let analysis = analyze("{\"components\":\"nope\"}");
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_ROOT]);

        let analysis = analyze("42");
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_ROOT]);

        let analysis = analyze("{\"components\":[]}");
        assert_eq!(error_codes(&analysis), vec![codes::EMPTY]);

        let analysis = analyze("[]");
        assert_eq!(error_codes(&analysis), vec![codes::EMPTY]);
    }

    #[test]
    fn accepts_a_bare_component_array_and_normalizes_the_root() {
        let analysis = analyze(r#"[{"type":"badge","props":{"label":"novo"}}]"#);
        assert!(analysis.is_ok());
        assert_eq!(
            analysis.normalized,
            Some(json!({"components":[{"type":"badge","props":{"label":"novo"}}]}))
        );
    }

    #[test]
    fn warns_about_version_mismatch_but_keeps_rendering() {
        let analysis =
            analyze(r#"{"version":1,"components":[{"type":"badge","props":{"label":"x"}}]}"#);
        assert!(analysis.is_ok());
        assert_eq!(warning_codes(&analysis), vec![codes::VERSION_MISMATCH]);

        let analysis =
            analyze(r#"{"version":2,"components":[{"type":"badge","props":{"label":"x"}}]}"#);
        assert!(analysis.is_ok());
        assert!(analysis.diagnostics.is_empty());

        // 2.0 é igual a 2 em JS; a comparação numérica evita falso aviso.
        let analysis =
            analyze(r#"{"version":2.0,"components":[{"type":"badge","props":{"label":"x"}}]}"#);
        assert!(analysis.diagnostics.is_empty());
    }

    #[test]
    fn version_warning_coexists_with_root_errors() {
        let analysis = analyze(r#"{"version":1,"foo":1}"#);
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_ROOT]);
        assert_eq!(warning_codes(&analysis), vec![codes::VERSION_MISMATCH]);
    }

    #[test]
    fn rejects_structural_component_errors() {
        let analysis = analyze(r#"{"components":[{"props":{}}]}"#);
        assert_eq!(error_codes(&analysis), vec![codes::MISSING_TYPE]);

        let analysis = analyze(r#"{"components":[{"type":"iframe"}]}"#);
        assert_eq!(error_codes(&analysis), vec![codes::UNKNOWN_TYPE]);

        let analysis = analyze(r#"{"components":["nope"]}"#);
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_COMPONENT]);

        let analysis = analyze(r#"{"components":[{"type":"card","props":"nope"}]}"#);
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_PROPS]);

        let analysis = analyze(
            r#"{"components":[{"type":"badge","props":{"label":"x"},"children":[{"type":"badge","props":{"label":"y"}}]}]}"#,
        );
        assert_eq!(error_codes(&analysis), vec![codes::CHILDREN_NOT_ALLOWED]);

        let analysis = analyze(r#"{"components":[{"type":"card","children":{}}]}"#);
        assert_eq!(error_codes(&analysis), vec![codes::INVALID_CHILDREN]);
    }

    #[test]
    fn caps_diagnostics_per_code() {
        let components: Vec<Value> = (0..10)
            .map(|index| json!({"type": "iframe", "props": {}, "index": index}))
            .collect();
        let source = json!({ "components": components }).to_string();
        let analysis = analyze(&source);
        assert_eq!(
            analysis.error_count(),
            contract().limits.diagnostics_per_code,
            "o cap por código deve limitar os diagnósticos"
        );
    }

    #[test]
    fn exotic_component_types_are_unknown_without_panicking() {
        // Nomes herdados de Object.prototype não podem virar componente válido
        // (nem derrubar o validador) em nenhuma linguagem.
        for type_name in ["constructor", "toString", "__proto__", "hasOwnProperty"] {
            let source = format!(r#"{{"components":[{{"type":"{type_name}"}}]}}"#);
            let analysis = analyze(&source);
            assert_eq!(
                error_codes(&analysis),
                vec![codes::UNKNOWN_TYPE],
                "`{type_name}` deve ser tratado como tipo desconhecido"
            );
            assert!(analysis.normalized.is_none());
        }
    }

    #[test]
    fn scans_markdown_ui_blocks() {
        let text = "Veja:\n```ui\n{\"components\":[{\"type\":\"badge\",\"props\":{\"label\":\"x\"}}]}\n```\nfim";
        let blocks = scan_markdown_blocks(text);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].is_ok());

        let broken = "texto\n```ui\n{\"components\":[}\n```";
        let blocks = scan_markdown_blocks(broken);
        assert_eq!(blocks.len(), 1);
        assert!(!blocks[0].is_ok());

        let unclosed = "texto\n```ui\n{\"components\":[]}";
        let blocks = scan_markdown_blocks(unclosed);
        assert_eq!(blocks.len(), 1);
        assert_eq!(error_codes(&blocks[0]), vec![codes::INVALID_JSON]);

        assert!(scan_markdown_blocks("```rust\nlet x = 1;\n```").is_empty());
        assert!(scan_markdown_blocks("```uix\n{}\n```").is_empty());
    }

    #[test]
    fn tool_definition_is_always_named_validate_ui() {
        let definition = definition();
        assert_eq!(definition.name, "validate_ui");
        assert!(definition.parameters["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|value| value == "block")));
        assert!(definition
            .description
            .contains("does not count toward the 6-call data-tool budget"));
    }

    #[test]
    fn tool_returns_json_even_for_invalid_ui() {
        let outcome = run(&json!({"block": "{\"components\":[]}"}));
        assert!(!outcome.is_error);
        let response: Value = serde_json::from_str(&outcome.content).expect("resposta JSON");
        assert_eq!(response["ok"], json!(false));
        assert_eq!(response["normalized"], Value::Null);
        assert_eq!(response["errors"][0]["code"], json!(codes::EMPTY));
        assert_eq!(response["summary"], json!("UI inválida: 1 erro, 0 avisos"));
        assert!(outcome.summary.is_some());
    }

    #[test]
    fn tool_returns_normalized_spec_for_valid_ui() {
        let outcome = run(&json!({
            "block": "{\"components\":[{\"type\":\"badge\",\"props\":{\"label\":\"novo\"}}]}"
        }));
        assert!(!outcome.is_error);
        let response: Value = serde_json::from_str(&outcome.content).expect("resposta JSON");
        assert_eq!(response["ok"], json!(true));
        assert_eq!(
            response["normalized"],
            json!({"components":[{"type":"badge","props":{"label":"novo"}}]})
        );
        assert_eq!(response["summary"], json!("UI válida: 1 componente, 0 avisos"));
    }

    #[test]
    fn tool_accepts_an_already_parsed_object() {
        let outcome = run(&json!({"block": {"components": [{"type": "divider"}]}}));
        assert!(!outcome.is_error);
        let response: Value = serde_json::from_str(&outcome.content).expect("resposta JSON");
        assert_eq!(response["ok"], json!(true));
    }

    #[test]
    fn tool_rejects_a_missing_block_argument() {
        let outcome = run(&json!({}));
        assert!(outcome.is_error);
    }

    #[test]
    fn summary_pluralizes_in_portuguese() {
        let analysis = analyze(r#"{"components":[{"type":"badge"}]}"#);
        assert_eq!(summary(&analysis), "UI inválida: 1 erro, 0 avisos");
        let analysis = analyze(r#"{"components":[{"type":"divider"},{"type":"divider"}]}"#);
        assert!(analysis.is_ok());
        assert_eq!(summary(&analysis), "UI válida: 2 componentes, 0 avisos");
    }
}
