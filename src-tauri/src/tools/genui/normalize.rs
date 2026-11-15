//! Normalização + validação estrutural da UI generativa contra o contrato.
//!
//! Espelho exato do núcleo TypeScript (`src/lib/genui/normalize.ts`): o mesmo
//! input precisa produzir a mesma árvore canônica e os mesmos códigos de
//! diagnóstico. O corpus de paridade é `data/genui-fixtures.json`; qualquer
//! divergência aparece no teste `fixtures`.
//!
//! Regras principais:
//! - uma única passada recursiva: valida, aplica coerções seguras, converte
//!   formas legadas e trunca;
//! - props desconhecidas são removidas com aviso; props obrigatórias ausentes ou
//!   texto obrigatório vazio viram erro;
//! - diagnósticos são capados por código em `limits.diagnosticsPerCode`;
//! - `spec` só existe quando não há nenhum erro (o renderer degrada para código);
//! - defaults do contrato NÃO são materializados (exceto enum inválido com
//!   default, que usa o default com aviso).
//!
//! Texto é contado por code points (não bytes/UTF-16) para que o corte em
//! `maxChars` seja idêntico nas duas linguagens.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::codes;
use super::contract::{ArraySpec, ComponentSpec, Contract, ItemSpec, PropSpec};
use super::DiagnosticSink;

/// Normaliza a lista de componentes da raiz. Devolve a lista canônica e o total
/// de nós visitados.
pub(crate) fn normalize_components(
    contract: &Contract,
    components: &[Value],
    extra: &BTreeMap<String, ComponentSpec>,
    sink: &mut DiagnosticSink,
) -> (Vec<Value>, usize) {
    let mut normalizer = Normalizer {
        contract,
        extra,
        sink,
        nodes: 0,
    };
    let mut normalized = Vec::with_capacity(components.len());
    for (index, raw) in components.iter().enumerate() {
        if let Some(node) = normalizer.component(raw, &format!("components[{index}]"), 1) {
            normalized.push(node);
        }
    }
    (normalized, normalizer.nodes)
}

struct Normalizer<'a> {
    contract: &'a Contract,
    extra: &'a BTreeMap<String, ComponentSpec>,
    sink: &'a mut DiagnosticSink,
    nodes: usize,
}

impl Normalizer<'_> {
    /* -------------------------------------------------------------- */
    /* Diagnósticos                                                    */
    /* -------------------------------------------------------------- */

    fn error(&mut self, code: &str, path: impl Into<String>, message: impl Into<String>) {
        self.sink.error(code, path, message);
    }

    fn warning(&mut self, code: &str, path: impl Into<String>, message: impl Into<String>) {
        self.sink.warning(code, path, message);
    }

    /* -------------------------------------------------------------- */
    /* Componentes                                                     */
    /* -------------------------------------------------------------- */

    fn component(&mut self, raw: &Value, path: &str, depth: usize) -> Option<Value> {
        self.nodes += 1;
        if depth > self.contract.limits.depth {
            self.error(
                codes::TOO_DEEP,
                path,
                format!(
                    "Profundidade máxima de {} níveis excedida na UI generativa.",
                    self.contract.limits.depth
                ),
            );
            return None;
        }
        if self.nodes > self.contract.limits.nodes {
            self.error(
                codes::TOO_MANY_NODES,
                path,
                format!("Máximo de {} componentes por bloco.", self.contract.limits.nodes),
            );
            return None;
        }
        let Some(object) = raw.as_object() else {
            self.error(
                codes::INVALID_COMPONENT,
                path,
                "Componente inválido: esperado um objeto.",
            );
            return None;
        };

        let type_value = match object.get("type") {
            Some(Value::String(name)) if !name.trim().is_empty() => name.clone(),
            _ => {
                self.error(
                    codes::MISSING_TYPE,
                    format!("{path}.type"),
                    "Todo componente precisa de `type` (string).",
                );
                return None;
            }
        };
        let spec: ComponentSpec = match self
            .contract
            .component(&type_value)
            .cloned()
            .or_else(|| self.extra.get(&type_value).cloned())
        {
            Some(spec) => spec,
            None => {
                self.error(
                    codes::UNKNOWN_TYPE,
                    format!("{path}.type"),
                    format!("Componente desconhecido: \"{type_value}\"."),
                );
                return None;
            }
        };

        let prepared = self.apply_legacy(&spec, object, path);

        let normalized_props = self.normalize_props(&spec, prepared.get("props"), path);
        let raw_props = prepared
            .get("props")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        self.check_required_props(&spec, &normalized_props, &raw_props, path);

        let mut props = normalized_props;
        if spec.typ == "progress" {
            self.normalize_progress(&mut props, path);
        }
        let children = self.normalize_children(&spec, &prepared, path, depth);

        let mut node = Map::new();
        node.insert("type".to_string(), Value::String(spec.typ.clone()));
        if !props.is_empty() {
            node.insert("props".to_string(), Value::Object(props.clone()));
        }
        if !children.is_empty() {
            node.insert("children".to_string(), Value::Array(children));
        }

        if spec.typ == "actions" {
            self.validate_actions(&props, path);
        }

        Some(Value::Object(node))
    }

    /// Converte formas antigas documentadas no contrato (com aviso
    /// `ui.legacy-shape`, sempre no caminho `.props`).
    fn apply_legacy(
        &mut self,
        spec: &ComponentSpec,
        raw: &Map<String, Value>,
        path: &str,
    ) -> Map<String, Value> {
        let mut prepared = raw.clone();
        if !prepared.get("props").map(Value::is_object).unwrap_or(false) {
            return prepared;
        }
        let mut props = prepared
            .get("props")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let props_path = format!("{path}.props");

        if spec.typ == "chart" {
            if !props.contains_key("type") {
                if let Some(chart_type) = props
                    .get("chartType")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    props.insert("type".to_string(), Value::String(chart_type));
                    props.remove("chartType");
                    self.warning(
                        codes::LEGACY_SHAPE,
                        &props_path,
                        "`chartType` foi normalizado para `type`.",
                    );
                }
            }
            if !props.get("data").map(Value::is_array).unwrap_or(false) {
                let labels = props.get("labels").and_then(Value::as_array).cloned();
                let values = props.get("values").and_then(Value::as_array).cloned();
                if let (Some(labels), Some(values)) = (labels, values) {
                    let data: Vec<Value> = labels
                        .iter()
                        .enumerate()
                        .map(|(index, label)| {
                            let mut item = Map::new();
                            item.insert("label".to_string(), label.clone());
                            item.insert(
                                "value".to_string(),
                                values.get(index).cloned().unwrap_or(Value::Null),
                            );
                            Value::Object(item)
                        })
                        .collect();
                    props.remove("labels");
                    props.remove("values");
                    props.insert("data".to_string(), Value::Array(data));
                    self.warning(
                        codes::LEGACY_SHAPE,
                        &props_path,
                        "`labels` + `values` foram normalizados para `data`.",
                    );
                }
            }
            if let Some(Value::Array(data)) = props.get("data") {
                if data.iter().any(Value::is_array) {
                    let converted: Vec<Value> = data
                        .iter()
                        .map(|entry| match entry {
                            Value::Array(pair) => {
                                let mut item = Map::new();
                                item.insert(
                                    "label".to_string(),
                                    pair.first().cloned().unwrap_or(Value::Null),
                                );
                                item.insert(
                                    "value".to_string(),
                                    pair.get(1).cloned().unwrap_or(Value::Null),
                                );
                                Value::Object(item)
                            }
                            other => other.clone(),
                        })
                        .collect();
                    props.insert("data".to_string(), Value::Array(converted));
                    self.warning(
                        codes::LEGACY_SHAPE,
                        &props_path,
                        "Pares [rótulo, valor] foram normalizados para { label, value }.",
                    );
                }
            }
        }

        if spec.typ == "keyvalue" {
            if !props.get("items").map(Value::is_array).unwrap_or(false) {
                if let Some(Value::Object(pairs)) = props.get("items").cloned() {
                    let items: Vec<Value> = pairs
                        .iter()
                        .map(|(label, value)| {
                            let mut item = Map::new();
                            item.insert("label".to_string(), Value::String(label.clone()));
                            item.insert("value".to_string(), value.clone());
                            Value::Object(item)
                        })
                        .collect();
                    props.insert("items".to_string(), Value::Array(items));
                    self.warning(
                        codes::LEGACY_SHAPE,
                        &props_path,
                        "Objeto de pares foi normalizado para `items`.",
                    );
                }
            }
        }

        if spec.typ == "list" {
            if let Some(Value::String(text)) = props.get("items") {
                let text = text.clone();
                props.insert(
                    "items".to_string(),
                    Value::Array(vec![Value::String(text)]),
                );
                self.warning(
                    codes::LEGACY_SHAPE,
                    &props_path,
                    "`items` como texto foi normalizado para um array.",
                );
            }
        }

        if matches!(spec.typ.as_str(), "list" | "steps" | "timeline") {
            if let Some(Value::Array(items)) = props.get("items") {
                if items
                    .iter()
                    .any(|entry| entry.is_string() || entry.is_number())
                {
                    let key = if spec.typ == "list" { "text" } else { "title" };
                    let converted: Vec<Value> = items
                        .iter()
                        .map(|entry| {
                            if entry.is_string() || entry.is_number() {
                                let mut item = Map::new();
                                item.insert(key.to_string(), entry.clone());
                                Value::Object(item)
                            } else {
                                entry.clone()
                            }
                        })
                        .collect();
                    props.insert("items".to_string(), Value::Array(converted));
                    self.warning(
                        codes::LEGACY_SHAPE,
                        &props_path,
                        "Itens em texto foram normalizados para objetos.",
                    );
                }
            }
        }

        if spec.typ == "tabs" {
            if let Some(Value::Array(labels)) = props.get("tabs").cloned() {
                if let Some(Value::Array(children)) = prepared.get("children").cloned() {
                    let converted: Vec<Value> = children
                        .iter()
                        .enumerate()
                        .map(|(index, child)| {
                            let Some(child_object) = child.as_object() else {
                                return child.clone();
                            };
                            let mut child_props = child_object
                                .get("props")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            if !child_props.contains_key("label") {
                                if let Some(Value::String(label)) = labels.get(index) {
                                    child_props.insert("label".to_string(), Value::String(label.clone()));
                                }
                            }
                            let mut new_child = child_object.clone();
                            new_child.insert("props".to_string(), Value::Object(child_props));
                            Value::Object(new_child)
                        })
                        .collect();
                    prepared.insert("children".to_string(), Value::Array(converted));
                }
                props.remove("tabs");
                self.warning(
                    codes::LEGACY_SHAPE,
                    &props_path,
                    "`tabs` com nomes foi normalizado para `props.label` nos painéis.",
                );
            }
        }

        prepared.insert("props".to_string(), Value::Object(props));
        prepared
    }

    fn normalize_props(
        &mut self,
        spec: &ComponentSpec,
        raw_props: Option<&Value>,
        path: &str,
    ) -> Map<String, Value> {
        let mut props = Map::new();
        let raw = match raw_props {
            None | Some(Value::Null) => return props,
            Some(Value::Object(map)) => map,
            Some(_) => {
                self.error(
                    codes::INVALID_PROPS,
                    format!("{path}.props"),
                    format!("`props` de `{}` deve ser um objeto.", spec.typ),
                );
                return props;
            }
        };

        for (name, prop_spec) in &spec.props {
            let Some(value) = raw.get(name) else {
                continue;
            };
            let prop_path = format!("{path}.props.{name}");
            if let Some(value) = self.prop(value, prop_spec, &prop_path) {
                props.insert(name.clone(), value);
            }
        }

        for key in raw.keys() {
            if !spec.props.contains_key(key) {
                self.warning(
                    codes::UNKNOWN_PROP,
                    format!("{path}.props.{key}"),
                    format!("Prop desconhecida em `{}`: `{key}`.", spec.typ),
                );
            }
        }
        props
    }

    fn check_required_props(
        &mut self,
        spec: &ComponentSpec,
        normalized: &Map<String, Value>,
        raw_props: &Map<String, Value>,
        path: &str,
    ) {
        for (name, prop_spec) in &spec.props {
            if !prop_spec.required {
                continue;
            }
            // Prop ausente de verdade: erro. Prop presente mas com tipo inválido
            // já gera `ui.prop-type`; não duplicar como ausente.
            if !raw_props.contains_key(name) {
                self.error(
                    codes::MISSING_PROP,
                    format!("{path}.props.{name}"),
                    format!("`{}` requer a prop `{name}`.", spec.typ),
                );
                continue;
            }
            let Some(value) = normalized.get(name) else {
                continue;
            };
            if prop_spec.prop_type == "text" {
                if let Some(text) = value.as_str() {
                    if text.trim().is_empty() {
                        self.error(
                            codes::MISSING_PROP,
                            format!("{path}.props.{name}"),
                            format!("`{}.{}` não pode ficar vazio.", spec.typ, name),
                        );
                    }
                }
            }
        }
    }

    /// `progress` aceita qualquer número no contrato, mas o valor exibido é
    /// sempre 0..max; o ajuste é sinalizado para o agente corrigir.
    fn normalize_progress(&mut self, props: &mut Map<String, Value>, path: &str) {
        let Some(value) = props.get("value").and_then(Value::as_f64) else {
            return;
        };
        let default_max = self
            .contract
            .prop_default("progress", "max")
            .and_then(Value::as_f64)
            .unwrap_or(100.0);
        let max = match props.get("max").and_then(Value::as_f64) {
            Some(max) if max > 0.0 => max,
            _ => default_max,
        };
        if value >= 0.0 && value <= max {
            return;
        }
        let clamped = value.clamp(0.0, max);
        props.insert("value".to_string(), number_value(clamped));
        self.warning(
            codes::CLAMPED,
            format!("{path}.props.value"),
            format!("Valor ajustado para o intervalo 0–{}.", format_number(max)),
        );
    }

    fn normalize_children(
        &mut self,
        spec: &ComponentSpec,
        prepared: &Map<String, Value>,
        path: &str,
        depth: usize,
    ) -> Vec<Value> {
        let raw_children = match prepared.get("children") {
            None | Some(Value::Null) => {
                if spec.typ == "tabs" {
                    self.error(
                        codes::TABS_EMPTY,
                        format!("{path}.children"),
                        "`tabs` precisa de pelo menos um painel em `children`.",
                    );
                }
                return Vec::new();
            }
            Some(Value::Array(children)) => children,
            Some(_) => {
                self.error(
                    codes::INVALID_CHILDREN,
                    format!("{path}.children"),
                    format!("`children` de `{}` deve ser uma lista.", spec.typ),
                );
                return Vec::new();
            }
        };

        if !spec.is_container() {
            if !raw_children.is_empty() {
                self.error(
                    codes::CHILDREN_NOT_ALLOWED,
                    format!("{path}.children"),
                    format!(
                        "`{}` não aceita `children`; use um container (card, stack, grid, tabs, \
                         reveal, section, callout).",
                        spec.typ
                    ),
                );
            }
            return Vec::new();
        }

        let mut children = Vec::new();
        for (index, raw_child) in raw_children.iter().enumerate() {
            let child_path = format!("{path}.children[{index}]");
            let child = if spec.typ == "tabs" {
                self.tab_panel(raw_child, &child_path, depth + 1)
            } else {
                self.component(raw_child, &child_path, depth + 1)
            };
            if let Some(child) = child {
                children.push(child);
            }
        }
        if spec.typ == "tabs" && children.is_empty() {
            self.error(
                codes::TABS_EMPTY,
                format!("{path}.children"),
                "`tabs` precisa de pelo menos um painel em `children`.",
            );
        }
        children
    }

    /// Painel de `tabs`: `props.label` é metadado (não é prop do componente) e
    /// sobrevive à normalização. `props.title` só é reinterpretado como `label`
    /// legado quando o componente do painel NÃO declara uma prop `title`: em
    /// `card`/`reveal`/`code`/`chart` ele é uma prop real e é preservado.
    fn tab_panel(&mut self, raw: &Value, path: &str, depth: usize) -> Option<Value> {
        let Some(object) = raw.as_object() else {
            return self.component(raw, path, depth);
        };
        if let Some(props) = object.get("props") {
            if !props.is_object() {
                return self.component(raw, path, depth);
            }
        }

        // A spec do painel é consultada antes de mexer nas props.
        let declares_title = object
            .get("type")
            .and_then(Value::as_str)
            .and_then(|type_name| self.contract.component(type_name))
            .map(|spec| spec.props.contains_key("title"))
            .unwrap_or(false);

        let mut props = object
            .get("props")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let label_raw = props.get("label").cloned().or_else(|| {
            if declares_title {
                None
            } else {
                props.get("title").cloned()
            }
        });
        let title_was_label =
            !declares_title && !props.contains_key("label") && props.contains_key("title");
        props.remove("label");
        if !declares_title {
            props.remove("title");
        }
        let label_path = format!("{path}.props.label");
        let label = self.tab_label(label_raw.as_ref(), &label_path);
        if title_was_label {
            self.warning(
                codes::LEGACY_SHAPE,
                format!("{path}.props"),
                "`title` do painel foi normalizado para `props.label`.",
            );
        }

        let mut prepared = object.clone();
        prepared.insert("props".to_string(), Value::Object(props));
        let node = self.component(&Value::Object(prepared), path, depth)?;

        match label {
            Some(label) => {
                let mut node = node.as_object().cloned().unwrap_or_default();
                let mut props = node
                    .get("props")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                props.insert("label".to_string(), Value::String(label));
                node.insert("props".to_string(), Value::Object(props));
                Some(Value::Object(node))
            }
            None => {
                self.error(
                    codes::TABS_LABEL,
                    label_path,
                    "Cada painel de `tabs` precisa de `props.label` com o nome da aba.",
                );
                Some(node)
            }
        }
    }

    fn tab_label(&mut self, raw: Option<&Value>, path: &str) -> Option<String> {
        let Some(raw) = raw else {
            return None;
        };
        // O cap do metadado é declarado no contrato (`tabs.props.label.maxChars`).
        let max = self
            .contract
            .tab_label_max_chars()
            .unwrap_or(self.contract.limits.string_chars);
        match raw {
            Value::Null => None,
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(self.truncate_text(trimmed, max, path))
                }
            }
            Value::Number(_) | Value::Bool(_) => {
                self.warning(codes::COERCED, path, "Rótulo da aba convertido para texto.");
                let text = js_string(raw);
                Some(self.truncate_text(&text, max, path))
            }
            _ => {
                self.error(codes::PROP_TYPE, path, "O rótulo da aba deve ser texto.");
                None
            }
        }
    }

    fn validate_actions(&mut self, props: &Map<String, Value>, path: &str) {
        let Some(Value::Array(items)) = props.get("items") else {
            return;
        };
        for (index, item) in items.iter().enumerate() {
            let Some(item) = item.as_object() else {
                continue;
            };
            let prompt = item.get("prompt").and_then(Value::as_str).unwrap_or("").trim();
            let copy = item.get("copy").and_then(Value::as_str).unwrap_or("").trim();
            if (prompt.is_empty()) == (copy.is_empty()) {
                self.error(
                    codes::ACTION_INVALID,
                    format!("{path}.props.items[{index}]"),
                    "Cada ação precisa de exatamente um de `prompt` ou `copy` (não ambos, não \
                     nenhum).",
                );
            }
        }
    }

    /* -------------------------------------------------------------- */
    /* Props                                                           */
    /* -------------------------------------------------------------- */

    fn prop(&mut self, value: &Value, spec: &PropSpec, path: &str) -> Option<Value> {
        match spec.prop_type.as_str() {
            "text" => self.normalize_text(value, spec.max_chars, path).map(Value::String),
            "number" => self.normalize_number(value, spec.min, spec.max, path),
            "boolean" => self.normalize_boolean(value, path).map(Value::Bool),
            "enum" => self.normalize_enum(value, spec, path),
            "icon" => self.normalize_icon(value, path).map(Value::String),
            "url" => self.normalize_url(value, path, false).map(Value::String),
            "imageSrc" => self.normalize_url(value, path, true).map(Value::String),
            "array" => match spec.items.as_ref() {
                Some(items) => self.normalize_array(value, items, path),
                None => None,
            },
            // Tipo novo no contrato: preservar sem quebrar o pipeline.
            _ => Some(value.clone()),
        }
    }

    fn normalize_text(
        &mut self,
        value: &Value,
        max_chars: Option<usize>,
        path: &str,
    ) -> Option<String> {
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Number(_) | Value::Bool(_) => {
                self.warning(codes::COERCED, path, "Valor convertido para texto.");
                js_string(value)
            }
            _ => {
                self.error(codes::PROP_TYPE, path, "Esperado texto.");
                return None;
            }
        };
        let max = max_chars.unwrap_or(self.contract.limits.string_chars);
        Some(self.truncate_text(&text, max, path))
    }

    fn normalize_number(
        &mut self,
        value: &Value,
        min: Option<f64>,
        max: Option<f64>,
        path: &str,
    ) -> Option<Value> {
        let mut numeric = match value {
            Value::Number(number) => match number.as_f64() {
                Some(numeric) if numeric.is_finite() => numeric,
                _ => {
                    self.error(codes::PROP_TYPE, path, "Esperado um número.");
                    return None;
                }
            },
            Value::String(text) if !text.trim().is_empty() => match text.trim().parse::<f64>() {
                Ok(numeric) if numeric.is_finite() => {
                    self.warning(codes::COERCED, path, "Texto numérico convertido para número.");
                    numeric
                }
                _ => {
                    self.error(codes::PROP_TYPE, path, "Esperado um número.");
                    return None;
                }
            },
            _ => {
                self.error(codes::PROP_TYPE, path, "Esperado um número.");
                return None;
            }
        };
        if let Some(min) = min {
            if numeric < min {
                numeric = min;
                self.warning(
                    codes::CLAMPED,
                    path,
                    format!("Valor ajustado para o mínimo de {}.", format_number(min)),
                );
            }
        }
        if let Some(max) = max {
            if numeric > max {
                numeric = max;
                self.warning(
                    codes::CLAMPED,
                    path,
                    format!("Valor ajustado para o máximo de {}.", format_number(max)),
                );
            }
        }
        Some(number_value(numeric))
    }

    fn normalize_boolean(&mut self, value: &Value, path: &str) -> Option<bool> {
        match value {
            Value::Bool(value) => return Some(*value),
            Value::String(text) => {
                let normalized = text.trim().to_ascii_lowercase();
                if normalized == "true" {
                    self.warning(codes::COERCED, path, "Texto \"true\" convertido para booleano.");
                    return Some(true);
                }
                if normalized == "false" {
                    self.warning(codes::COERCED, path, "Texto \"false\" convertido para booleano.");
                    return Some(false);
                }
            }
            _ => {}
        }
        self.error(codes::PROP_TYPE, path, "Esperado booleano.");
        None
    }

    fn normalize_enum(&mut self, value: &Value, spec: &PropSpec, path: &str) -> Option<Value> {
        let Some(raw_value) = value.as_str() else {
            self.error(
                codes::PROP_TYPE,
                path,
                "Esperado texto com um dos valores permitidos.",
            );
            return None;
        };
        let raw = raw_value.trim();
        if let Some(exact) = spec.values.iter().find(|entry| entry.as_str() == raw) {
            return Some(Value::String(exact.clone()));
        }
        if let Some(insensitive) = spec
            .values
            .iter()
            .find(|entry| entry.to_lowercase() == raw.to_lowercase())
        {
            self.warning(
                codes::COERCED,
                path,
                format!("Valor normalizado para \"{insensitive}\"."),
            );
            return Some(Value::String(insensitive.clone()));
        }
        if let Some(default) = &spec.default {
            self.warning(
                codes::ENUM_DEFAULT,
                path,
                format!("Valor inválido; usando o padrão \"{}\".", compact(default)),
            );
            return Some(default.clone());
        }
        let values = if spec.values.is_empty() {
            "um valor permitido".to_string()
        } else {
            spec.values
                .iter()
                .map(|entry| format!("`{entry}`"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        self.error(
            codes::PROP_TYPE,
            path,
            format!("Valor inválido: \"{raw}\". Use {values}."),
        );
        None
    }

    fn normalize_icon(&mut self, value: &Value, path: &str) -> Option<String> {
        let Some(name) = value.as_str() else {
            self.error(
                codes::PROP_TYPE,
                path,
                "O ícone deve ser o nome de um ícone do contrato.",
            );
            return None;
        };
        let name = name.trim();
        if self.contract.icons.iter().any(|icon| icon == name) {
            return Some(name.to_string());
        }
        self.warning(
            codes::ICON_UNKNOWN,
            path,
            format!("Ícone desconhecido: \"{name}\"; será omitido."),
        );
        None
    }

    fn normalize_url(&mut self, value: &Value, path: &str, allow_data_image: bool) -> Option<String> {
        let Some(text) = value.as_str() else {
            self.error(codes::PROP_TYPE, path, "A URL deve ser texto.");
            return None;
        };
        let url = text.trim();
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Some(url.to_string());
        }
        if allow_data_image && is_allowed_data_image(&lower) {
            return Some(url.to_string());
        }
        self.error(
            codes::INVALID_URL,
            path,
            "URLs devem começar com http:// ou https://.",
        );
        None
    }

    /* -------------------------------------------------------------- */
    /* Arrays e itens                                                  */
    /* -------------------------------------------------------------- */

    fn normalize_array(
        &mut self,
        value: &Value,
        spec: &ArraySpec,
        path: &str,
    ) -> Option<Value> {
        let Value::Array(raw_items) = value else {
            self.error(codes::PROP_TYPE, path, "Esperado um array.");
            return None;
        };
        let mut list: &[Value] = raw_items;
        if list.len() > self.contract.limits.array_items {
            list = &list[..self.contract.limits.array_items];
            self.warning(
                codes::ARRAY_TRUNCATED,
                path,
                format!("Array truncado em {} itens.", self.contract.limits.array_items),
            );
        }
        if let Some(max_items) = spec.max_items {
            if list.len() > max_items {
                list = &list[..max_items];
                self.warning(
                    codes::ARRAY_TRUNCATED,
                    path,
                    format!("Array truncado em {max_items} itens."),
                );
            }
        }
        let min_items = spec.min_items.unwrap_or(0);
        if list.len() < min_items {
            self.error(
                codes::ARRAY_SIZE,
                path,
                format!(
                    "Este array precisa de pelo menos {min_items} {}.",
                    if min_items == 1 { "item" } else { "itens" }
                ),
            );
        }
        let mut items = Vec::with_capacity(list.len());
        if let Some(item_spec) = spec.item.as_ref() {
            for (index, entry) in list.iter().enumerate() {
                if let Some(normalized) =
                    self.normalize_item(entry, item_spec, &format!("{path}[{index}]"))
                {
                    items.push(normalized);
                }
            }
        }
        Some(Value::Array(items))
    }

    fn normalize_item(&mut self, value: &Value, spec: &ItemSpec, path: &str) -> Option<Value> {
        match spec.prop_type.as_str() {
            "text" => self.normalize_text(value, spec.max_chars, path).map(Value::String),
            "number" => self.normalize_number(value, spec.min, spec.max, path),
            "scalar" => match value {
                Value::String(_) | Value::Number(_) | Value::Bool(_) => Some(value.clone()),
                _ => {
                    self.error(codes::PROP_TYPE, path, "Esperado texto, número ou booleano.");
                    None
                }
            },
            "array" => {
                let Value::Array(raw_items) = value else {
                    self.error(codes::PROP_TYPE, path, "Esperado um array.");
                    return None;
                };
                let mut list: &[Value] = raw_items;
                if let Some(max_items) = spec.max_items {
                    if list.len() > max_items {
                        list = &list[..max_items];
                        self.warning(
                            codes::ARRAY_TRUNCATED,
                            path,
                            format!("Array truncado em {max_items} itens."),
                        );
                    }
                }
                if let Some(min_items) = spec.min_items {
                    if list.len() < min_items {
                        self.error(
                            codes::ARRAY_SIZE,
                            path,
                            format!("Este array precisa de pelo menos {min_items} itens."),
                        );
                    }
                }
                let mut items = Vec::with_capacity(list.len());
                if let Some(inner) = spec.item.as_ref() {
                    for (index, entry) in list.iter().enumerate() {
                        if let Some(normalized) =
                            self.normalize_item(entry, inner, &format!("{path}[{index}]"))
                        {
                            items.push(normalized);
                        }
                    }
                }
                Some(Value::Array(items))
            }
            "object" => {
                let Some(map) = value.as_object() else {
                    self.error(codes::PROP_TYPE, path, "Esperado um objeto.");
                    return None;
                };
                let specs = spec.props.as_ref();
                let mut props = Map::new();
                if let Some(specs) = specs {
                    for (name, prop_spec) in specs {
                        let Some(raw_value) = map.get(name) else {
                            if prop_spec.required {
                                self.error(
                                    codes::MISSING_PROP,
                                    format!("{path}.{name}"),
                                    format!("Este item requer a prop `{name}`."),
                                );
                            }
                            continue;
                        };
                        let Some(normalized) =
                            self.prop(raw_value, prop_spec, &format!("{path}.{name}"))
                        else {
                            continue;
                        };
                        if prop_spec.prop_type == "text" {
                            if let Some(text) = normalized.as_str() {
                                if text.trim().is_empty() {
                                    if prop_spec.required {
                                        self.error(
                                            codes::MISSING_PROP,
                                            format!("{path}.{name}"),
                                            format!("`{name}` não pode ficar vazio."),
                                        );
                                    }
                                    continue;
                                }
                            }
                        }
                        props.insert(name.clone(), normalized);
                    }
                }
                for key in map.keys() {
                    let known = specs.map(|specs| specs.contains_key(key)).unwrap_or(false);
                    if !known {
                        self.warning(
                            codes::UNKNOWN_PROP,
                            format!("{path}.{key}"),
                            format!("Prop desconhecida: `{key}`."),
                        );
                    }
                }
                Some(Value::Object(props))
            }
            _ => None,
        }
    }

    fn truncate_text(&mut self, text: &str, max: usize, path: &str) -> String {
        if text.chars().count() <= max {
            return text.to_string();
        }
        self.warning(
            codes::TEXT_TRUNCATED,
            path,
            format!("Texto truncado em {max} caracteres."),
        );
        text.chars().take(max).collect()
    }
}

/// URL de imagem: `data:image/<png|jpeg|webp|gif>` seguido de `;` ou `,`.
fn is_allowed_data_image(lower: &str) -> bool {
    const SUBTYPES: [&str; 4] = ["png", "jpeg", "webp", "gif"];
    let Some(rest) = lower.strip_prefix("data:image/") else {
        return false;
    };
    SUBTYPES.iter().any(|subtype| {
        rest.strip_prefix(subtype)
            .map(|tail| tail.starts_with(';') || tail.starts_with(','))
            .unwrap_or(false)
    })
}

/// Converte um valor JSON para texto como o `String(value)` do JS: números
/// inteiros não ganham `.0`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number_to_text(number),
        Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

fn number_to_text(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    format_number(number.as_f64().unwrap_or(0.0))
}

/// Número JSON canônico: inteiros continuam inteiros (igual ao `JSON.stringify`
/// do lado TS, que imprime `2` para `2.0`).
fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "?".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::genui::contract::contract;
    use crate::tools::genui::{analyze, codes, Severity};

    fn normalized(source: &str) -> Value {
        let analysis = analyze(source);
        assert!(
            analysis.is_ok(),
            "esperava UI válida; diagnósticos: {:?}",
            analysis
                .diagnostics
                .iter()
                .map(|diagnostic| format!("{}@{}", diagnostic.code, diagnostic.path))
                .collect::<Vec<_>>()
        );
        analysis.normalized.expect("normalizado presente")
    }

    #[test]
    fn omits_empty_props_and_children_and_does_not_materialize_defaults() {
        let spec = normalized(r#"{"components":[{"type":"stack","props":{},"children":[]}]}"#);
        assert_eq!(spec, serde_json::json!({"components":[{"type":"stack"}]}));
    }

    #[test]
    fn null_prop_is_a_type_error_instead_of_absent() {
        let analysis = analyze(r#"{"components":[{"type":"badge","props":{"label":null}}]}"#);
        let codes: Vec<&str> = analysis
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Error)
            .map(|diagnostic| diagnostic.code.as_str())
            .collect();
        assert_eq!(codes, vec![codes::PROP_TYPE]);
    }

    #[test]
    fn required_text_cannot_be_empty() {
        let analysis = analyze(r#"{"components":[{"type":"badge","props":{"label":"  "}}]}"#);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::MISSING_PROP));
    }

    #[test]
    fn array_below_min_items_reports_array_size_but_keeps_normalizing() {
        let analysis = analyze(
            r#"{"components":[{"type":"table","props":{"columns":["A"],"rows":[["1"]]}}]}"#,
        );
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::ARRAY_SIZE));
        assert!(analysis.normalized.is_none());
    }

    #[test]
    fn actions_require_exactly_one_intent() {
        let analysis = analyze(
            r#"{"components":[{"type":"actions","props":{"items":[{"label":"a"},{"label":"b","prompt":"x"},{"label":"c","copy":"y"},{"label":"d","prompt":"x","copy":"y"}]}}]}"#,
        );
        let invalid: Vec<_> = analysis
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == codes::ACTION_INVALID)
            .collect();
        assert_eq!(invalid.len(), 2);
        assert!(invalid[0].path.ends_with("items[0]"));
        assert!(invalid[1].path.ends_with("items[3]"));
    }

    #[test]
    fn actions_above_the_contract_max_are_truncated() {
        let items: Vec<Value> = (0..5)
            .map(|index| serde_json::json!({"label": format!("Ação {index}"), "prompt": "x"}))
            .collect();
        let source = serde_json::json!({
            "components": [{"type": "actions", "props": { "items": items }}]
        })
        .to_string();
        let spec = normalized(&source);
        let normalized_items = spec["components"][0]["props"]["items"]
            .as_array()
            .expect("items");
        let max_items = contract().component("actions").unwrap().props["items"]
            .items
            .as_ref()
            .and_then(|items| items.max_items)
            .expect("maxItems do contrato");
        assert_eq!(max_items, 4);
        assert_eq!(normalized_items.len(), max_items);
        let analysis = analyze(&source);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::ARRAY_TRUNCATED));
    }

    #[test]
    fn tab_panels_preserve_title_when_the_component_declares_it() {
        // `card` e `reveal` declaram `title`: ele é prop real e não vira label.
        let source = r#"{"components":[{"type":"tabs","children":[
            {"type":"card","props":{"label":"Resumo","title":"Detalhes"},"children":[{"type":"badge","props":{"label":"a"}}]},
            {"type":"reveal","props":{"label":"Mais","title":"Metodologia"},"children":[{"type":"badge","props":{"label":"b"}}]}
        ]}]}"#;
        let spec = normalized(source);
        let panels = spec["components"][0]["children"].as_array().expect("painéis");
        assert_eq!(panels[0]["props"]["label"], serde_json::json!("Resumo"));
        assert_eq!(panels[0]["props"]["title"], serde_json::json!("Detalhes"));
        assert_eq!(panels[1]["props"]["label"], serde_json::json!("Mais"));
        assert_eq!(panels[1]["props"]["title"], serde_json::json!("Metodologia"));
    }

    #[test]
    fn tab_panels_without_title_prop_convert_legacy_title_into_label() {
        let source = r#"{"components":[{"type":"tabs","children":[
            {"type":"stack","props":{"title":"Geral"},"children":[{"type":"badge","props":{"label":"a"}}]}
        ]}]}"#;
        let spec = normalized(source);
        let panel = &spec["components"][0]["children"][0];
        assert_eq!(panel["props"]["label"], serde_json::json!("Geral"));
        assert!(panel["props"].get("title").is_none());
        let analysis = analyze(source);
        let legacy = analysis
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == codes::LEGACY_SHAPE)
            .expect("aviso de forma legada");
        assert_eq!(legacy.path, "components[0].children[0].props");
    }

    #[test]
    fn tab_panels_with_title_prop_still_require_label() {
        let analysis = analyze(
            r#"{"components":[{"type":"tabs","children":[
                {"type":"reveal","props":{"title":"Metodologia"},"children":[{"type":"badge","props":{"label":"a"}}]}
            ]}]}"#,
        );
        let diagnostic = analysis
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == codes::TABS_LABEL)
            .expect("label obrigatório como metadado");
        assert_eq!(diagnostic.path, "components[0].children[0].props.label");
        // O `title` do reveal não foi consumido como label.
        assert!(!analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::LEGACY_SHAPE));
    }

    #[test]
    fn tab_label_is_truncated_at_the_contract_limit() {
        let max = contract()
            .tab_label_max_chars()
            .expect("cap declarado no contrato");
        let label = "a".repeat(max + 5);
        let source = serde_json::json!({
            "components": [{
                "type": "tabs",
                "children": [{
                    "type": "stack",
                    "props": { "label": label },
                    "children": [{"type": "badge", "props": {"label": "x"}}]
                }]
            }]
        })
        .to_string();
        let spec = normalized(&source);
        let normalized_label = spec["components"][0]["children"][0]["props"]["label"]
            .as_str()
            .expect("label normalizado");
        assert_eq!(normalized_label.chars().count(), max);
        let analysis = analyze(&source);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::TEXT_TRUNCATED));
    }

    #[test]
    fn tabs_without_label_or_panels_are_errors() {
        let analysis = analyze(r#"{"components":[{"type":"tabs","children":[]}]}"#);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::TABS_EMPTY));

        let analysis = analyze(
            r#"{"components":[{"type":"tabs","children":[{"type":"stack","children":[{"type":"badge","props":{"label":"x"}}]}]}]}"#,
        );
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::TABS_LABEL));
    }

    #[test]
    fn legacy_chart_shapes_are_normalized() {
        let source = r#"{"components":[{"type":"chart","props":{"chartType":"line","title":"Receita","labels":["Jan","Fev"],"values":[1,2]}}]}"#;
        let spec = normalized(source);
        assert_eq!(spec["components"][0]["props"]["type"], serde_json::json!("line"));
        assert_eq!(
            spec["components"][0]["props"]["data"],
            serde_json::json!([{"label":"Jan","value":1},{"label":"Fev","value":2}])
        );
        let analysis = analyze(source);
        assert_eq!(
            analysis
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == codes::LEGACY_SHAPE)
                .count(),
            2
        );
    }

    #[test]
    fn legacy_data_pairs_are_normalized() {
        let spec = normalized(
            r#"{"components":[{"type":"chart","props":{"type":"bar","title":"t","data":[["A",1],["B",2]]}}]}"#,
        );
        assert_eq!(
            spec["components"][0]["props"]["data"],
            serde_json::json!([{"label":"A","value":1},{"label":"B","value":2}])
        );
    }

    #[test]
    fn legacy_list_and_timeline_strings_are_normalized() {
        let spec = normalized(r#"{"components":[{"type":"timeline","props":{"items":["a","b"]}}]}"#);
        assert_eq!(
            spec["components"][0]["props"]["items"],
            serde_json::json!([{"title":"a"},{"title":"b"}])
        );

        let spec = normalized(
            r#"{"components":[{"type":"list","props":{"items":"uma linha só"}}]}"#,
        );
        assert_eq!(
            spec["components"][0]["props"]["items"],
            serde_json::json!([{"text":"uma linha só"}])
        );
    }

    #[test]
    fn legacy_keyvalue_object_is_sorted_by_label() {
        let source = r#"{"components":[{"type":"keyvalue","props":{"items":{"zebra":"Z","alpha":"A"}}}]}"#;
        let spec = normalized(source);
        let items = spec["components"][0]["props"]["items"]
            .as_array()
            .expect("items");
        let labels: Vec<&str> = items
            .iter()
            .filter_map(|item| item.get("label").and_then(Value::as_str))
            .collect();
        assert_eq!(labels, vec!["alpha", "zebra"]);
        let analysis = analyze(source);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::LEGACY_SHAPE));
    }

    #[test]
    fn legacy_tabs_names_are_normalized_to_panel_labels() {
        let source = r#"{"components":[{"type":"tabs","props":{"tabs":["Geral","Detalhes"]},"children":[
            {"type":"stack","children":[{"type":"badge","props":{"label":"a"}}]},
            {"type":"stack","children":[{"type":"badge","props":{"label":"b"}}]}
        ]}]}"#;
        let spec = normalized(source);
        let tabs = &spec["components"][0];
        assert!(tabs.get("props").is_none());
        assert_eq!(tabs["children"][0]["props"]["label"], serde_json::json!("Geral"));
        assert_eq!(tabs["children"][1]["props"]["label"], serde_json::json!("Detalhes"));
    }

    #[test]
    fn coerces_scalars_in_tables_and_values() {
        let spec = normalized(
            r#"{"components":[{"type":"table","props":{"columns":["A","B","C"],"rows":[["texto",42,true]]}}]}"#,
        );
        assert_eq!(
            spec["components"][0]["props"]["rows"][0],
            serde_json::json!(["texto", 42, true])
        );
    }

    #[test]
    fn truncates_text_without_ellipsis() {
        let long = "a".repeat(200);
        let source = serde_json::json!({
            "components": [{ "type": "badge", "props": { "label": long } }]
        })
        .to_string();
        let spec = normalized(&source);
        let label = spec["components"][0]["props"]["label"].as_str().expect("label");
        let max = contract().component("badge").unwrap().props["label"]
            .max_chars
            .unwrap();
        assert_eq!(label.chars().count(), max);
        assert!(!label.ends_with('…'));
    }

    #[test]
    fn clamps_columns_and_progress() {
        let spec = normalized(
            r#"{"components":[
                {"type":"grid","props":{"columns":9},"children":[{"type":"badge","props":{"label":"a"}}]},
                {"type":"progress","props":{"value":-5,"max":50}}
            ]}"#,
        );
        assert_eq!(spec["components"][0]["props"]["columns"], serde_json::json!(4));
        assert_eq!(spec["components"][1]["props"]["value"], serde_json::json!(0));
    }

    #[test]
    fn depth_and_node_limits_follow_the_contract() {
        let mut node = serde_json::json!({"type":"badge","props":{"label":"x"}});
        for _ in 0..contract().limits.depth {
            node = serde_json::json!({"type":"card","props":{"title":"x"},"children":[node]});
        }
        let source = serde_json::json!({"components":[node]}).to_string();
        let analysis = analyze(&source);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::TOO_DEEP));

        let components: Vec<Value> = (0..=contract().limits.nodes)
            .map(|index| serde_json::json!({"type":"badge","props":{"label":format!("b{index}")}}))
            .collect();
        let source = serde_json::json!({ "components": components }).to_string();
        let analysis = analyze(&source);
        assert!(analysis
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == codes::TOO_MANY_NODES));
    }
}
