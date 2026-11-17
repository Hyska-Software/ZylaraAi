//! Agent tools: web search, page fetching, file creation, code execution and
//! skills.

use std::path::PathBuf;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::db::Db;
use crate::domain::{Artifact, Citation, Settings, ToolCallRecord, TurnOptions};
use crate::i18n;
use crate::providers::ToolDefinition;

pub mod artifact_library;
pub mod artifacts;
pub mod agents;
pub mod code;
pub mod code_exec;
pub mod create_file;
pub mod fetch_url;
pub mod genui;
pub mod memory;
pub mod pipeline;
pub mod plugins;
pub mod plugins_studio;
pub mod registry;
pub mod skills;
pub mod tasks;
pub mod web_search;

/// Runtime hooks available to tools that mutate agent collaboration state.
/// Production wires this to Tauri events and the active-turn registry; tests
/// pass `None`.
pub trait AgentHooks: Send + Sync {
    fn task_updated(&self, task: &crate::agents::AgentTask);
    fn channel_updated(&self, channel_id: &str);
    fn cancel_conversation(&self, conversation_id: &str);
    /// Creates a persona through the production command validation. Tests and
    /// read-only harnesses keep the default failure.
    fn create_agent(
        &self,
        _input: &crate::agents::AgentInput,
    ) -> Result<crate::agents::Agent, String> {
        Err(format!(
            "AGENT_CREATE_UNAVAILABLE: {}",
            i18n::t("tools.mod.createUnavailable")
        ))
    }
    /// Emitted after a tool-created persona so the renderer refreshes the team.
    fn agent_created(&self, _agent: &crate::agents::Agent) {}
}

/// Upper bound for the text fed back to the model from a single tool call.
pub const MAX_TOOL_RESULT_CHARS: usize = 120_000;

#[derive(Clone)]
pub struct ToolRuntime {
    pub db: std::sync::Arc<Db>,
    /// Shared browser-like client (`AppState::search_http`) used by the web
    /// tools: search engines and scraped pages reject the plain API client.
    pub http: reqwest::Client,
    pub conversation_id: String,
    pub message_id: String,
    pub options: TurnOptions,
    /// Effective settings for this turn (code interpreter paths, timeout, …).
    pub settings: Settings,
    /// Turn cancellation token: `run_code` kills the process tree on cancel.
    pub cancel: CancellationToken,
    /// Production hooks for agent task/channel events and real cancellation.
    pub agent_hooks: Option<std::sync::Arc<dyn AgentHooks>>,
    /// Resolved `<app-data>` directory (artifacts, code-runs, skills).
    pub data_dir: PathBuf,
    /// External skills repositories (Codex/Claude/OpenCode/Agent Skills) read
    /// by the `list_skills`/`read_skill` tools; empty in most unit tests.
    pub skills_roots: Vec<skills::ExternalSkillRoot>,
    /// Interactive approvals available to the turn. Chat also uses this for
    /// plugin tools (the Code profile has its own policy gate).
    pub approval: Option<std::sync::Arc<crate::policy::approval::ApprovalRegistry>>,
    /// Turn event sink used by approval cards.
    pub emit: Option<std::sync::Arc<dyn crate::harness::EventEmitter>>,
}

impl ToolRuntime {
    /// Requests consent for a plugin tool. Plugin tools always pass through an
    /// explicit approval in Chat; a missing approval channel fails closed.
    async fn approve_plugin_tool(
        &self,
        plugin_id: &str,
        tool: &crate::plugins::ToolContribution,
        call_id: &str,
    ) -> Result<(), ToolOutcome> {
        let Some(registry) = &self.approval else {
            return Err(ToolOutcome::error(
                "PLUGIN_APPROVAL_UNAVAILABLE: plugin tools require an interactive approval channel",
            ));
        };
        let risk = match tool.risk.as_str() {
            "write" => crate::domain::RiskClass::Write,
            "shell" => crate::domain::RiskClass::Shell,
            "network" => crate::domain::RiskClass::Network,
            _ => crate::domain::RiskClass::Read,
        };
        let request = crate::domain::ApprovalRequest {
            id: format!("apr-{}", uuid::Uuid::new_v4().simple()),
            conversation_id: self.conversation_id.clone(),
            tool_call_id: call_id.to_string(),
            tool: format!("plugin:{plugin_id}:{}", tool.name),
            title: format!("Plugin `{plugin_id}` · {}", tool.name),
            detail: crate::domain::ApprovalDetail::Other {
                text: format!(
                    "Plugin `{plugin_id}` wants to run `{}` (risk: {}).",
                    tool.name, tool.risk
                ),
            },
            risk,
            preview: None,
            options: vec![
                crate::domain::ApprovalOption {
                    id: "allow".into(),
                    label: i18n::t("approvals.allowOnce"),
                    scope: None,
                },
                crate::domain::ApprovalOption {
                    id: "deny".into(),
                    label: i18n::t("approvals.deny"),
                    scope: None,
                },
            ],
            created_at: crate::domain::now_ms(),
        };
        let outcome = crate::policy::approval::request_interactive(
            registry,
            self.emit.clone(),
            request,
            std::time::Duration::from_secs(self.settings.approval_timeout_secs.max(30) as u64),
            &self.cancel,
        )
        .await;
        if outcome.is_approved() {
            Ok(())
        } else {
            Err(ToolOutcome::error(format!(
                "PLUGIN_APPROVAL_{}: the plugin tool was not approved",
                outcome.decision.as_str().to_ascii_uppercase()
            )))
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ToolOutcome {
    /// Text fed back to the model as the tool result.
    pub content: String,
    /// Short human readable summary shown on the tool card.
    pub summary: Option<String>,
    pub citations: Vec<Citation>,
    pub artifacts: Vec<Artifact>,
    /// Raster images returned by the tool (screenshots). The harness persists
    /// them under `<app-data>/tool-images` and only feeds them to vision models.
    pub images: Vec<ToolImage>,
    pub is_error: bool,
    /// Apresentação estruturada do resultado (diff, lista de tarefas, plano,
    /// job, aprovação) usada pelos cards do renderer e persistida em
    /// `ToolCallRecord.presentation`. JSON opaco versionado por `kind` — ver
    /// `docs/goals/code-harness/TOOLS.md` §1.1.
    pub presentation: Option<Value>,
}

impl ToolOutcome {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: format!("ERROR: {}", message.into()),
            is_error: true,
            ..Default::default()
        }
    }
}

/// Image returned by a tool. Kept in memory for the immediate next step; the
/// harness writes it to disk before persisting the tool call record.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolImage {
    pub mime_type: String,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

/// `None` inherits every tool; `Some(list)` is the agent allowlist.
pub fn tool_allowed(options: &TurnOptions, name: &str) -> bool {
    options
        .allowed_tools
        .as_ref()
        .map_or(true, |list| list.iter().any(|allowed| allowed == name))
}

/// Tool definitions exposed to the model for the current turn.
pub fn definitions(options: &TurnOptions) -> Vec<ToolDefinition> {
    let mut tools = Vec::new();
    if options.web_search {
        tools.push(web_search::definition());
    }
    tools.push(fetch_url::definition());
    if options.create_files {
        tools.push(create_file::definition());
    }
    if options.run_code {
        tools.push(code_exec::definition());
    }
    // Sempre disponíveis: skills não contam no orçamento de ferramentas de
    // dados e o agente precisa poder lê-las antes de gerar arquivos.
    tools.push(skills::list_definition());
    tools.push(skills::read_definition());
    // Sempre disponíveis: a biblioteca de artefatos do USUÁRIO (todas as
    // conversas) é somente leitura e resolve o caso de arquivos de turnos e
    // conversas anteriores (o histórico não carrega o conteúdo deles). Elas
    // contam no orçamento de ferramentas de dados, mas nunca são escondidas
    // pelas flags do turno.
    tools.push(artifact_library::list_definition());
    tools.push(artifact_library::read_definition());
    // Sempre disponível: o agente valida o JSON do bloco `ui` antes de emitir.
    tools.push(genui::definition());
    // O agente pode preparar um plugin, mas nunca ativá-lo: a instalação deixa
    // o plugin desativado e o usuário concede as permissões/ativa na UI.
    // Subagentes não instalam plugins no host.
    if options.delegation_depth == 0 {
        tools.push(plugins::definition());
        if options.plugin_creator {
            tools.push(plugins_studio::definition());
        }
    }
    if options.agent_memory {
        tools.push(memory::definition());
    }
    if options.agent_delegation {
        tools.extend(tasks::definitions());
    }
    // Agent capabilities restrict the catalog **after** the global gates: a
    // persona can remove tools, never add ones the app disabled globally.
    tools.retain(|tool| tool_allowed(options, &tool.name));
    // Plugin tools are an overlay: they appear only for top-level turns and
    // when the agent allowlist (if any) permits them. The execution boundary in
    // the harness re-checks the same catalog.
    if options.delegation_depth == 0 {
        if let Some(manager) = crate::plugins::global_manager() {
            for definition in manager.tool_definitions(crate::domain::TurnProfile::Chat) {
                if !tools.iter().any(|tool| tool.name == definition.name)
                    && tool_allowed(options, &definition.name)
                {
                    tools.push(definition);
                }
            }
        }
    }
    apply_plugin_mode_tools(options, &mut tools);
    tools
}

/// Applies the catalog delta of the active plugin modes: `remove` hides tools,
/// `writes: "blocked"` hides mutating ones and `add` re-exposes catalog tools
/// that a turn flag disabled.
fn apply_plugin_mode_tools(options: &TurnOptions, tools: &mut Vec<ToolDefinition>) {
    if !options.plugin_mode_tools_remove.is_empty() {
        tools.retain(|tool| {
            !options
                .plugin_mode_tools_remove
                .iter()
                .any(|name| name == &tool.name)
        });
    }
    if options.plugin_mode_writes_blocked {
        tools.retain(|tool| !crate::tools::registry::spec_is_mutating(&tool.name));
        if let Some(manager) = crate::plugins::global_manager() {
            tools.retain(|tool| {
                manager
                    .tool_risk(&tool.name)
                    .map_or(true, |risk| risk != "write" && risk != "shell")
            });
        }
    }
    if !options.plugin_mode_tools_add.is_empty() {
        for candidate in crate::tools::registry::definitions_for(crate::domain::TurnProfile::Chat) {
            if options
                .plugin_mode_tools_add
                .iter()
                .any(|name| name == &candidate.name)
                && !tools.iter().any(|tool| tool.name == candidate.name)
                && tool_allowed(options, &candidate.name)
                && !(options.plugin_mode_writes_blocked
                    && crate::tools::registry::spec_is_mutating(&candidate.name))
            {
                tools.push(candidate);
            }
        }
    }
}

/// Execute a tool call. Must never panic: failures are returned as `ToolOutcome::error`.
pub async fn execute(rt: &ToolRuntime, call: &ToolCallRecord) -> ToolOutcome {
    if !tool_allowed(&rt.options, &call.name) {
        return ToolOutcome::error(i18n::t_args(
            "tools.mod.notAuthorized",
            &[("tool", &call.name)],
        ));
    }
    let arguments = match parse_arguments(&call.arguments) {
        Ok(arguments) => arguments,
        Err(error) => return ToolOutcome::error(error),
    };

    if let Some(manager) = crate::plugins::global_manager() {
        if let Some((plugin_id, tool)) = manager.tool_owner(&call.name) {
            if let Err(denied) = rt
                .approve_plugin_tool(&plugin_id, &tool, &call.id)
                .await
            {
                let _ = manager.db().plugin_audit(
                    &plugin_id,
                    &format!("approval:{}", tool.name),
                    None,
                    "denied",
                );
                return denied;
            }
            let _ = manager.db().plugin_audit(
                &plugin_id,
                &format!("approval:{}", tool.name),
                None,
                "allowed",
            );
            return manager
                .execute_tool(
                    &plugin_id,
                    &tool,
                    arguments,
                    &rt.conversation_id,
                    &rt.message_id,
                    &rt.cancel,
                )
                .await;
        }
    }

    let outcome = match call.name.as_str() {
        "web_search" if !rt.options.web_search => {
            ToolOutcome::error(i18n::t("tools.mod.webSearchDisabled"))
        }
        "web_search" => web_search::run(rt, &arguments).await,
        "fetch_url" => fetch_url::run(rt, &arguments).await,
        "create_file" if !rt.options.create_files => {
            ToolOutcome::error(i18n::t("tools.mod.createFilesDisabled"))
        }
        "create_file" => create_file::run(rt, &arguments).await,
        "run_code" if !rt.options.run_code => {
            ToolOutcome::error(i18n::t("tools.mod.runCodeDisabled"))
        }
        "run_code" => code_exec::run(rt, &arguments).await,
        // Skills: sempre disponíveis, independentes das flags do turno.
        "list_skills" => skills::run_list(rt),
        "read_skill" => skills::run_read(rt, &arguments),
        // Biblioteca de artefatos do usuário (todas as conversas), somente
        // leitura; não depende das flags do turno.
        "list_artifacts" => artifact_library::run_list(rt, &arguments).await,
        "read_artifact" => artifact_library::run_read(rt, &arguments).await,
        // Validação local do bloco `ui`; não depende de flags do turno.
        "validate_ui" => genui::run(&arguments),
        // Preparar um plugin (desativado) para o usuário ativar depois.
        "install_plugin" => plugins::run_chat(rt, &arguments).await,
        // Plugin Studio is only callable in Plugin Creator mode.
        "plugin_studio" if !rt.options.plugin_creator => ToolOutcome::error(
            "TOOL_UNAVAILABLE: plugin_studio requires Plugin Creator mode",
        ),
        "plugin_studio" => plugins_studio::run_chat(rt, &arguments).await,
        // Durable agent memory (only for agent turns with memory enabled).
        "memory" => memory::run(rt, &arguments),
        name if agents::is_agent_tool(name) => {
            let Some(agent_id) = rt.options.agent_id.as_deref() else {
                return ToolOutcome::error(i18n::t("tools.mod.agentToolsRequireAgent"));
            };
            agents::run_with_hooks(&rt.db, agent_id, name, &arguments, &rt.settings, rt.agent_hooks.as_deref())
        }
        "task_wait" => {
            let Some(agent_id) = rt.options.agent_id.as_deref() else {
                return ToolOutcome::error(i18n::t("tools.mod.taskToolsRequireAgent"));
            };
            tasks::wait_for_task(
                &rt.db,
                agent_id,
                &rt.conversation_id,
                &arguments,
                &rt.cancel,
            )
            .await
        }
        name if tasks::is_delegation_tool(name) => {
            let Some(agent_id) = rt.options.agent_id.as_deref() else {
                return ToolOutcome::error(i18n::t("tools.mod.delegationRequiresAgent"));
            };
            tasks::run_with_hooks(&rt.db, agent_id, &rt.conversation_id, name, &arguments, rt.agent_hooks.as_deref())
        }
        other => ToolOutcome::error(i18n::t_args(
            "tools.mod.unknownTool",
            &[("tool", other)],
        )),
    };
    truncate_outcome(outcome)
}

fn parse_arguments(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Null) => Ok(json!({})),
        Ok(Value::Object(map)) => Ok(Value::Object(map)),
        Ok(_) => Err(i18n::t("tools.mod.argumentsNotObject")),
        Err(error) => Err(i18n::t_args(
            "tools.mod.argumentsInvalid",
            &[("error", &error.to_string())],
        )),
    }
}

fn truncate_outcome(mut outcome: ToolOutcome) -> ToolOutcome {
    if outcome.content.chars().count() > MAX_TOOL_RESULT_CHARS {
        outcome.content = truncate_chars(&outcome.content, MAX_TOOL_RESULT_CHARS);
        outcome
            .content
            .push_str(&format!("\n\n{}", i18n::t("tools.mod.truncated")));
    }
    outcome
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

pub(crate) fn json_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub(crate) fn json_u32(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
}

pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// Collapse runs of whitespace into single spaces and trim the result.
pub(crate) fn clean_inline(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for word in text.split_whitespace() {
        if !output.is_empty() {
            output.push(' ');
        }
        output.push_str(word);
    }
    output
}

/// Normalize extracted article text: single spaces inside lines, at most one
/// blank line between blocks.
pub(crate) fn normalize_blocks(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut blank_lines = 0usize;
    for line in text.lines() {
        let cleaned = clean_inline(line);
        if cleaned.is_empty() {
            blank_lines += 1;
            if blank_lines <= 1 && !output.is_empty() {
                output.push('\n');
            }
        } else {
            blank_lines = 0;
            output.push_str(&cleaned);
            output.push('\n');
        }
    }
    output.trim().to_string()
}

pub(crate) fn host_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(host.trim_start_matches("www.").to_string())
}

/// Stable, unique citation id derived from the source URL.
pub(crate) fn citation_id(url: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("src-{:016x}", hasher.finish())
}

pub(crate) fn selector(query: &str) -> Option<scraper::Selector> {
    scraper::Selector::parse(query).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TurnOptions;

    #[test]
    fn definitions_respect_turn_options() {
        let mut options = TurnOptions::default();
        options.web_search = true;
        options.create_files = true;
        options.run_code = true;
        let names: Vec<String> = definitions(&options).into_iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            vec![
                "web_search",
                "fetch_url",
                "create_file",
                "run_code",
                "list_skills",
                "read_skill",
                "list_artifacts",
                "read_artifact",
                "validate_ui",
                "install_plugin"
            ]
        );

        options.web_search = false;
        options.create_files = false;
        options.run_code = false;
        let names: Vec<String> = definitions(&options).into_iter().map(|tool| tool.name).collect();
        // `list_skills`, `read_skill`, `list_artifacts`, `read_artifact`,
        // `validate_ui` e `install_plugin` são sempre expostas; apenas as duas
        // primeiras e a validação de UI não entram no orçamento de ferramentas
        // de dados.
        assert_eq!(
            names,
            vec![
                "fetch_url",
                "list_skills",
                "read_skill",
                "list_artifacts",
                "read_artifact",
                "validate_ui",
                "install_plugin"
            ]
        );
    }

    #[test]
    fn agent_allowlist_filters_the_catalog_and_blocks_hallucinated_calls() {
        let mut options = TurnOptions::default();
        options.allowed_tools = Some(vec!["web_search".to_string()]);
        let names: Vec<String> = definitions(&options).into_iter().map(|tool| tool.name).collect();
        assert_eq!(names, vec!["web_search"]);

        options.allowed_tools = Some(Vec::new());
        assert!(definitions(&options).is_empty());

        options.allowed_tools = None;
        options.agent_memory = true;
        assert!(definitions(&options)
            .iter()
            .any(|tool| tool.name == "memory"));
    }

    #[test]
    fn plugin_studio_is_only_visible_in_plugin_creator_mode() {
        let normal = TurnOptions::default();
        assert!(!definitions(&normal)
            .iter()
            .any(|tool| tool.name == "plugin_studio"));

        let creator = TurnOptions {
            plugin_creator: true,
            ..Default::default()
        };
        let names: Vec<String> = definitions(&creator)
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert_eq!(
            names.iter().filter(|name| name.as_str() == "plugin_studio").count(),
            1
        );

        let subagent = TurnOptions {
            plugin_creator: true,
            delegation_depth: 1,
            ..Default::default()
        };
        assert!(!definitions(&subagent)
            .iter()
            .any(|tool| tool.name == "plugin_studio"));
    }

    #[test]
    fn subagents_do_not_receive_the_plugin_install_tool() {
        let options = TurnOptions {
            delegation_depth: 1,
            ..Default::default()
        };
        let names: Vec<String> = definitions(&options).into_iter().map(|tool| tool.name).collect();
        assert!(!names.iter().any(|name| name == "install_plugin"));
    }

    #[tokio::test]
    async fn artifact_library_tools_are_dispatched_without_turn_flags() {
        // As duas tools são somente leitura: nenhuma flag do turno as desativa.
        let mut options = TurnOptions::default();
        options.web_search = false;
        options.create_files = false;
        options.run_code = false;
        let names: Vec<String> = definitions(&options).into_iter().map(|tool| tool.name).collect();
        for name in ["list_artifacts", "read_artifact"] {
            assert!(names.contains(&name.to_string()), "tool `{name}` ausente");
        }

        let runtime = ToolRuntime {
            db: std::sync::Arc::new(Db::open_in_memory().expect("banco em memória")),
            http: reqwest::Client::new(),
            conversation_id: "conv-1".to_string(),
            message_id: "msg-1".to_string(),
            options,
            settings: Settings::default(),
            cancel: tokio_util::sync::CancellationToken::new(),
            agent_hooks: None,
            data_dir: std::env::temp_dir().join(format!(
                "zylara-tools-dispatch-{}",
                uuid::Uuid::new_v4()
            )),
            skills_roots: Vec::new(),
            approval: None,
            emit: None,
        };
        let mut list_call = ToolCallRecord::running("call-1", "list_artifacts");
        list_call.arguments = "{}".to_string();
        let list = execute(&runtime, &list_call).await;
        assert!(!list.is_error, "erro inesperado: {}", list.content);
        assert_eq!(list.summary.as_deref(), Some("nenhum artefato"));

        let mut read_call = ToolCallRecord::running("call-2", "read_artifact");
        read_call.arguments = "{}".to_string();
        let read = execute(&runtime, &read_call).await;
        assert!(read.is_error, "sem id/nome deve ser erro orientativo");
        assert!(read.content.contains("`id`"));
    }

    #[test]
    fn parses_tool_arguments() {
        assert!(parse_arguments("").unwrap().is_object());
        assert!(parse_arguments("{\"query\":\"rust\"}").unwrap().is_object());
        assert!(parse_arguments("[1,2]").is_err());
        assert!(parse_arguments("{oops").is_err());
    }

    #[test]
    fn cleans_and_truncates_text() {
        assert_eq!(clean_inline("  olá   mundo \n"), "olá mundo");
        assert_eq!(truncate_chars("abcdef", 3), "abc");
        assert_eq!(host_of("https://www.example.com/a/b"), Some("example.com".to_string()));
    }

    struct AutoApprovalEmitter {
        registry: std::sync::Arc<crate::policy::approval::ApprovalRegistry>,
        approve: bool,
    }

    impl crate::harness::EventEmitter for AutoApprovalEmitter {
        fn emit(&self, event: crate::events::TurnEvent) {
            if let crate::events::TurnEvent::ApprovalRequested { approval } = event {
                let outcome = if self.approve {
                    crate::policy::approval::ApprovalOutcome::approved(None)
                } else {
                    crate::policy::approval::ApprovalOutcome::denied(None)
                };
                self.registry.resolve(&approval.id, outcome);
            }
        }
    }

    async fn approval_runtime(
        approve: bool,
    ) -> (ToolRuntime, std::sync::Arc<crate::policy::approval::ApprovalRegistry>) {
        let registry = std::sync::Arc::new(crate::policy::approval::ApprovalRegistry::new());
        let runtime = ToolRuntime {
            db: std::sync::Arc::new(Db::open_in_memory().expect("db")),
            http: reqwest::Client::new(),
            conversation_id: "conv-1".to_string(),
            message_id: "msg-1".to_string(),
            options: TurnOptions::default(),
            settings: Settings::default(),
            cancel: CancellationToken::new(),
            agent_hooks: None,
            data_dir: std::env::temp_dir(),
            skills_roots: Vec::new(),
            approval: Some(registry.clone()),
            emit: Some(std::sync::Arc::new(AutoApprovalEmitter {
                registry: registry.clone(),
                approve,
            })),
        };
        (runtime, registry)
    }

    fn approval_tool() -> crate::plugins::ToolContribution {
        serde_json::from_value(json!({
            "name": "lookup",
            "description": "Look up a record.",
            "parameters": { "type": "object", "properties": {} },
            "risk": "write",
            "profiles": ["chat", "code"]
        }))
        .expect("tool contribution")
    }

    #[tokio::test]
    async fn plugin_tools_require_an_approved_interactive_request() {
        let (runtime, _) = approval_runtime(true).await;
        assert!(runtime
            .approve_plugin_tool("com.acme.demo", &approval_tool(), "call-1")
            .await
            .is_ok());

        let (runtime, _) = approval_runtime(false).await;
        let denied = runtime
            .approve_plugin_tool("com.acme.demo", &approval_tool(), "call-2")
            .await
            .expect_err("denied");
        assert!(denied.is_error);
        assert!(denied.content.contains("PLUGIN_APPROVAL_DENIED"));

        let mut runtime = runtime;
        runtime.approval = None;
        let unavailable = runtime
            .approve_plugin_tool("com.acme.demo", &approval_tool(), "call-3")
            .await
            .expect_err("no approval channel");
        assert!(unavailable.content.contains("PLUGIN_APPROVAL_UNAVAILABLE"));
    }
}
