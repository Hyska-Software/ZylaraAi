//! Global application state shared by every Tauri command.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::catalog::{CatalogFile, ModelInfo};
use crate::db::Db;
use crate::domain::ProviderAuthStatus;
use crate::oauth::OAuthState;
use crate::policy::approval::ApprovalRegistry;

/// Account-specific model list fetched from the provider (`/v1/models`).
#[derive(Debug, Clone)]
pub struct DynamicModels {
    pub fetched_at: i64,
    pub models: Vec<ModelInfo>,
}

/// Um turno em andamento: token de cancelamento + conversa dona.
///
/// Guardar a conversa permite que o preflight do objetivo
/// (`goal_can_continue`) recuse uma segunda rodada na mesma sessão sem
/// depender do renderer.
struct TurnEntry {
    cancel: CancellationToken,
    conversation_id: String,
    started_at: i64,
}

/// One-shot "the next close must quit" intent. The updater setup asks the
/// running app to close with WM_CLOSE while replacing files.
#[derive(Default)]
pub struct CloseIntent {
    exit_on_close: AtomicBool,
}

impl CloseIntent {
    pub fn allow_exit(&self) {
        self.exit_on_close.store(true, Ordering::SeqCst);
    }

    pub fn take_exit(&self) -> bool {
        self.exit_on_close.swap(false, Ordering::SeqCst)
    }
}

/// Registro de turnos ativos (testável sem Tauri). `AppState` delega para ele.
#[derive(Default)]
pub struct TurnRegistry {
    turns: Mutex<HashMap<String, TurnEntry>>,
    shutting_down: AtomicBool,
}

impl TurnRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, turn_id: &str, conversation_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.turns.lock().insert(
            turn_id.to_string(),
            TurnEntry {
                cancel: token.clone(),
                conversation_id: conversation_id.to_string(),
                started_at: crate::domain::now_ms(),
            },
        );
        token
    }

    /// Registers a turn only when the conversation has no other active turn.
    /// This is the backend single-flight boundary for agent threads: the
    /// renderer prevents double sends, but background runners and reloads do
    /// not share that state.
    pub fn register_if_idle(
        &self,
        turn_id: &str,
        conversation_id: &str,
    ) -> Option<CancellationToken> {
        let mut turns = self.turns.lock();
        if self.shutting_down.load(Ordering::SeqCst) {
            return None;
        }
        if turns
            .values()
            .any(|entry| entry.conversation_id == conversation_id)
        {
            return None;
        }
        let token = CancellationToken::new();
        turns.insert(
            turn_id.to_string(),
            TurnEntry {
                cancel: token.clone(),
                conversation_id: conversation_id.to_string(),
                started_at: crate::domain::now_ms(),
            },
        );
        Some(token)
    }

    pub fn finish(&self, turn_id: &str) {
        self.turns.lock().remove(turn_id);
    }

    pub fn cancel(&self, turn_id: &str) -> bool {
        match self.turns.lock().get(turn_id) {
            Some(entry) => {
                entry.cancel.cancel();
                true
            }
            None => false,
        }
    }

    pub fn cancel_all(&self) -> usize {
        let turns = self.turns.lock();
        for entry in turns.values() {
            entry.cancel.cancel();
        }
        turns.len()
    }

    /// Sticky shutdown: new turns are rejected and every active turn is
    /// cancelled. Unlike `cancel_all`, the flag survives so a scheduler cannot
    /// start another turn while the process is finalizing its exit.
    pub fn begin_shutdown(&self) -> usize {
        let turns = self.turns.lock();
        self.shutting_down.store(true, Ordering::SeqCst);
        for entry in turns.values() {
            entry.cancel.cancel();
        }
        turns.len()
    }

    /// Há algum turno ativo para esta conversa? Usado pelo preflight de objetivos
    pub fn has_active_for(&self, conversation_id: &str) -> bool {
        self.turns
            .lock()
            .values()
            .any(|entry| entry.conversation_id == conversation_id)
    }

    /// Cancels every turn of one conversation (background-thread Stop).
    pub fn cancel_conversation(&self, conversation_id: &str) -> usize {
        let mut cancelled = 0;
        for entry in self.turns.lock().values() {
            if entry.conversation_id == conversation_id {
                entry.cancel.cancel();
                cancelled += 1;
            }
        }
        cancelled
    }

    /// `(turn_id, conversation_id)` of every active turn, sorted by turn id.
    pub fn active_turns(&self) -> Vec<(String, String)> {
        let mut turns: Vec<(String, String)> = self
            .turns
            .lock()
            .iter()
            .map(|(turn_id, entry)| (turn_id.clone(), entry.conversation_id.clone()))
            .collect();
        turns.sort();
        turns
    }

    /// `(turn_id, conversation_id, started_at)` of every active turn.
    pub fn active_turn_details(&self) -> Vec<(String, String, i64)> {
        let mut turns: Vec<(String, String, i64)> = self
            .turns
            .lock()
            .iter()
            .map(|(turn_id, entry)| {
                (
                    turn_id.clone(),
                    entry.conversation_id.clone(),
                    entry.started_at,
                )
            })
            .collect();
        turns.sort();
        turns
    }

    /// Ids de conversas com turno ativo (para reconciliação/diagnóstico).
    pub fn active_conversations(&self) -> Vec<String> {
        let mut conversations: Vec<String> = self
            .turns
            .lock()
            .values()
            .map(|entry| entry.conversation_id.clone())
            .collect();
        conversations.sort();
        conversations.dedup();
        conversations
    }
}

/// Finishes a registered turn even when the command returns early through
/// `?`. Holds a borrow of the registry, so it is cheap and cannot outlive the
/// state that created it.
pub struct TurnGuard<'a> {
    registry: &'a TurnRegistry,
    turn_id: String,
}

impl Drop for TurnGuard<'_> {
    fn drop(&mut self) {
        self.registry.finish(&self.turn_id);
    }
}

pub struct AppState {
    pub started_at: i64,
    pub db: Arc<Db>,
    pub catalog: CatalogFile,
    pub http: reqwest::Client,
    pub search_http: reqwest::Client,
    pub data_dir: PathBuf,
    pub oauth: Arc<OAuthState>,
    /// Aprovações interativas pendentes do harness de código (por turno).
    pub approvals: Arc<ApprovalRegistry>,
    /// Arquivos observados nesta execução (read-before-write/CAS do harness).
    pub observed: Arc<crate::harness::code::observed::ObservedFiles>,
    /// Jobs de processo em background do harness de código (F4).
    pub jobs: Arc<crate::jobs::JobRegistry>,
    /// Servidores MCP configurados (<app-data>/mcp.json).
    pub mcp: Arc<crate::mcp::McpManager>,
    /// Terminais PTY abertos no layout Code.
    pub terminals: Arc<crate::terminal::TerminalRegistry>,
    /// Native filesystem watchers per workspace (live Files/Changes panel).
    pub watches: Arc<crate::workspace::watch::WorkspaceWatchRegistry>,
    /// Perguntas estruturadas pendentes (`ask_user`).
    pub questions: Arc<crate::harness::code::questions::QuestionRegistry>,
    /// Global/per-agent turn slots (cost/CPU protection for background agents).
    pub governor: Arc<crate::concurrency::ConcurrencyGovernor>,
    /// Third-party plugins: install/lifecycle, contributions, broker and tools.
    pub plugins: Arc<crate::plugins::PluginManager>,
    /// Third-party ACP agents and their live sessions.
    pub acp: Arc<crate::acp::AcpManager>,
    dynamic_models: RwLock<HashMap<String, DynamicModels>>,
    turns: TurnRegistry,
    close_intent: CloseIntent,
}

impl AppState {
    pub fn init(app: &AppHandle) -> anyhow::Result<Self> {
        // Prime the backend locale before the schedulers run.
        let settings = crate::config::load_settings(app);
        let data_dir = crate::config::data_dir(app)?;
        crate::computer::browser::init_global(&data_dir);
        let db_path = data_dir.join("zylara.db");
        let db = Arc::new(Db::open(&db_path)?);
        let catalog = CatalogFile::load()?;
        let http = crate::http::client();
        let plugins = crate::plugins::PluginManager::load(
            &data_dir,
            db.clone(),
            http.clone(),
            Some(app.clone()),
            &settings,
            crate::plugins::forced_safe_mode_from_args(),
        )?;
        crate::acp::init_app_handle(app);
        let state = Self {
            started_at: crate::domain::now_ms(),
            db,
            catalog,
            http,
            search_http: crate::http::search_client(),
            data_dir: data_dir.clone(),
            oauth: Arc::new(OAuthState::new()),
            approvals: Arc::new(ApprovalRegistry::new()),
            observed: Arc::new(crate::harness::code::observed::ObservedFiles::new()),
            mcp: Arc::new(crate::mcp::McpManager::load(data_dir.as_path())),
            terminals: Arc::new(crate::terminal::TerminalRegistry::new()),
            watches: Arc::new(crate::workspace::watch::WorkspaceWatchRegistry::new()),
            questions: Arc::new(crate::harness::code::questions::QuestionRegistry::new()),
            governor: crate::concurrency::ConcurrencyGovernor::new(),
            jobs: Arc::new(crate::jobs::JobRegistry::new()),
            plugins,
            acp: crate::acp::init_manager(),
            dynamic_models: RwLock::new(HashMap::new()),
            turns: TurnRegistry::new(),
            close_intent: CloseIntent::default(),
        };
        state.restore_models_cache();
        Ok(state)
    }

    /// Restores the account model lists cached by the last `refresh_provider_models`
    /// so an account-only model stays selectable after a restart (offline too).
    fn restore_models_cache(&self) {
        let path = self.data_dir.join("models-cache.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return;
        };
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Entry {
            fetched_at: i64,
            models: Vec<ModelInfo>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct File {
            #[serde(default)]
            providers: HashMap<String, Entry>,
        }
        let Ok(file) = serde_json::from_str::<File>(&raw) else {
            // A corrupt cache is not user data: ignore it and refetch later.
            return;
        };
        let mut guard = self.dynamic_models.write();
        for (provider_id, entry) in file.providers {
            // Account model lists are kept for bundled, user-defined and plugin
            // providers alike; a provider removed since the cache was written is
            // dropped instead of resurfacing as a ghost.
            let known = self.catalog.provider(&provider_id).is_some()
                || crate::providers::custom::is_custom_id(&provider_id)
                || self.plugins.provider(&provider_id).is_some();
            if known {
                guard.insert(
                    provider_id,
                    DynamicModels {
                        fetched_at: entry.fetched_at,
                        models: entry.models,
                    },
                );
            }
        }
    }

    /* -------------------------------------------------------------- */
    /* Dynamic models (account-specific)                              */
    /* -------------------------------------------------------------- */

    /// Replaces the account model list for a provider.
    pub fn set_dynamic_models(&self, provider_id: &str, models: Vec<ModelInfo>, fetched_at: i64) {
        self.dynamic_models.write().insert(
            provider_id.to_string(),
            DynamicModels {
                fetched_at,
                models,
            },
        );
    }

    pub fn dynamic_models_for(&self, provider_id: &str) -> Option<DynamicModels> {
        self.dynamic_models.read().get(provider_id).cloned()
    }

    pub fn clear_dynamic_models(&self) {
        self.dynamic_models.write().clear();
    }

    /// Bundled catalog plus user-defined and declarative plugin providers.
    pub fn catalog_with_plugins(&self) -> CatalogFile {
        let mut catalog = self.catalog.clone();
        for provider in self
            .plugins
            .providers()
            .into_iter()
            .chain(self.custom_providers())
            .chain(self.acp_providers())
        {
            if !catalog.providers.iter().any(|known| known.id == provider.id) {
                catalog.providers.push(provider);
            }
        }
        catalog
    }

    /// User-defined providers (`Settings → Providers → Add provider`).
    pub fn custom_providers(&self) -> Vec<crate::catalog::ProviderInfo> {
        crate::providers::custom::list(&self.db)
    }

    fn catalog_reasoning_for_acp_model(
        model_id: &str,
    ) -> (bool, Vec<crate::catalog::ReasoningOption>) {
        let Ok(catalog) = crate::catalog::CatalogFile::load() else {
            return (false, Vec::new());
        };
        let bare = model_id.rsplit('/').next().unwrap_or(model_id);
        for provider in catalog.providers {
            if let Some(model) = provider
                .models
                .iter()
                .find(|model| model.id == model_id || model.id == bare)
            {
                return (model.reasoning, model.reasoning_options.clone());
            }
        }
        (false, Vec::new())
    }
    /// ACP agents are catalog providers with a subprocess transport.
    pub fn acp_providers(&self) -> Vec<crate::catalog::ProviderInfo> {
        let Ok(rows) = self.db.acp_agents() else {
            return Vec::new();
        };
        rows.into_iter()
            .filter(|row| row.enabled)
            .map(|row| {
                let discovered = crate::acp::reasoning_options_for_row(&row);
                let models = self
                    .db
                    .acp_models(&row.id)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|model| {
                        let (reasoning, reasoning_options) = if discovered.is_empty() {
                            Self::catalog_reasoning_for_acp_model(&model.model_id)
                        } else {
                            (true, discovered.clone())
                        };
                        crate::catalog::ModelInfo {
                            id: model.model_id,
                            name: model.name,
                            family: row.id.clone(),
                            protocols: vec!["acp".to_string()],
                            reasoning,
                            reasoning_options,
                            attachment: false,
                            modalities: crate::catalog::Modalities {
                                input: vec!["text".to_string()],
                                output: vec!["text".to_string()],
                            },
                            context_window: 128_000,
                            max_output: 16_000,
                            cost: None,
                            release_date: None,
                            knowledge: None,
                            open_weights: false,
                            description: model.description,
                            tags: Vec::new(),
                            status: "stable".to_string(),
                            estimated: true,
                            cache: None,
                        }
                    })
                    .collect();
                crate::acp::to_provider(&row, models)
            })
            .collect()
    }

    pub fn acp_provider(&self, provider_id: &str) -> Option<crate::catalog::ProviderInfo> {
        Self::acp_provider_from_db(&self.db, provider_id)
    }


pub(crate) fn acp_provider_from_db(
    db: &crate::db::Db,
    provider_id: &str,
) -> Option<crate::catalog::ProviderInfo> {
    if !crate::acp::is_acp_id(provider_id) {
        return None;
    }
    let row = db.acp_agent(provider_id).ok()??;
    if !row.enabled {
        return None;
    }
    let models = db.acp_models(provider_id).unwrap_or_default();
    let discovered = crate::acp::reasoning_options_for_row(&row);
    let mut provider = crate::acp::to_provider(&row, Vec::new());
    provider.models = models
        .into_iter()
        .map(|model| {
            let (reasoning, reasoning_options) = if discovered.is_empty() {
                AppState::catalog_reasoning_for_acp_model(&model.model_id)
            } else {
                (true, discovered.clone())
            };
            crate::catalog::ModelInfo {
                id: model.model_id,
                name: model.name,
                family: provider_id.to_string(),
                protocols: vec!["acp".to_string()],
                reasoning,
                reasoning_options,
                attachment: false,
                modalities: crate::catalog::Modalities {
                    input: vec!["text".to_string()],
                    output: vec!["text".to_string()],
                },
                context_window: 128_000,
                max_output: 16_000,
                cost: None,
                release_date: None,
                knowledge: None,
                open_weights: false,
                description: model.description,
                tags: Vec::new(),
                status: "stable".to_string(),
                estimated: true,
                cache: None,
            }
        })
        .collect();
    Some(provider)
}

pub(crate) fn acp_model_from_db(
    db: &crate::db::Db,
    provider_id: &str,
    model_id: &str,
) -> Option<crate::catalog::ModelInfo> {
    Self::acp_provider_from_db(db, provider_id)?
        .models
        .into_iter()
        .find(|model| model.id == model_id)
}

    /// One user-defined provider by id. Gated on the namespace so bundled and
    /// plugin lookups never touch the database.
    pub fn custom_provider(&self, provider_id: &str) -> Option<crate::catalog::ProviderInfo> {
        if !crate::providers::custom::is_custom_id(provider_id) {
            return None;
        }
        crate::providers::custom::get(&self.db, provider_id)
    }

    /// Provider lookup across bundled, custom, ACP and plugin providers.
    pub fn provider(&self, provider_id: &str) -> Option<crate::catalog::ProviderInfo> {
        self.catalog
            .provider(provider_id)
            .cloned()
            .or_else(|| self.custom_provider(provider_id))
            .or_else(|| self.acp_provider(provider_id))
            .or_else(|| self.plugins.provider(provider_id))
    }

    /// Merged list: account list first (order preserved), catalog metadata where
    /// available, conservative entries for models only the account knows.
    pub fn models(&self, provider_id: &str) -> Vec<ModelInfo> {
        let Some(provider) = self.provider(provider_id) else {
            return Vec::new();
        };
        let Some(dynamic) = self.dynamic_models_for(provider_id) else {
            return provider.models.clone();
        };
        let mut merged: Vec<ModelInfo> = dynamic
            .models
            .iter()
            .map(|remote| {
                provider
                    .models
                    .iter()
                    .find(|model| model.id == remote.id)
                    .cloned()
                    .unwrap_or_else(|| remote.clone())
            })
            .collect();
        for model in &provider.models {
            if !merged.iter().any(|known| known.id == model.id) {
                merged.push(model.clone());
            }
        }
        merged
    }

    /// Model lookup used by the harness: dynamic (account) list first, then the
    /// bundled catalog, user providers and plugin contributions.
    pub fn model(&self, provider_id: &str, model_id: &str) -> Option<ModelInfo> {
        self.catalog
            .model(provider_id, model_id)
            .cloned()
            .or_else(|| {
                self.dynamic_models_for(provider_id)?
                    .models
                    .into_iter()
                    .find(|model| model.id == model_id)
            })
            .or_else(|| {
                self.custom_provider(provider_id)?
                    .models
                    .into_iter()
                    .find(|model| model.id == model_id)
            })
            .or_else(|| Self::acp_model_from_db(&self.db, provider_id, model_id))
            .or_else(|| {
                self.plugins
                    .provider(provider_id)?
                    .models
                    .into_iter()
                    .find(|model| model.id == model_id)
            })
    }

    /* -------------------------------------------------------------- */
    /* Auth                                                            */
    /* -------------------------------------------------------------- */

    pub async fn ensure_bearer(
        &self,
        app: &AppHandle,
        provider_id: &str,
    ) -> anyhow::Result<String> {
        crate::oauth::ensure_bearer(app, &self.oauth, &self.catalog, &self.http, provider_id)
            .await
    }

    pub async fn force_refresh(
        &self,
        app: &AppHandle,
        provider_id: &str,
    ) -> anyhow::Result<String> {
        crate::oauth::force_refresh(app, &self.oauth, &self.catalog, &self.http, provider_id).await
    }

    pub fn cancel_oauth(&self) {
        crate::oauth::cancel_all(&self.oauth);
    }

    pub fn auth_statuses(&self, app: &AppHandle) -> Vec<ProviderAuthStatus> {
        crate::oauth::statuses(app, &self.catalog)
    }

    pub fn auth_status(&self, app: &AppHandle, provider_id: &str) -> ProviderAuthStatus {
        crate::oauth::status(app, provider_id)
    }

    /* -------------------------------------------------------------- */
    /* Turns                                                           */
    /* -------------------------------------------------------------- */

    pub fn register_turn(&self, turn_id: &str, conversation_id: &str) -> CancellationToken {
        self.turns.register(turn_id, conversation_id)
    }

    pub fn register_turn_if_idle(
        &self,
        turn_id: &str,
        conversation_id: &str,
    ) -> Option<CancellationToken> {
        self.turns.register_if_idle(turn_id, conversation_id)
    }

    pub fn turn_guard(&self, turn_id: &str) -> TurnGuard<'_> {
        TurnGuard {
            registry: &self.turns,
            turn_id: turn_id.to_string(),
        }
    }

    pub fn finish_turn(&self, turn_id: &str) {
        self.turns.finish(turn_id);
    }

    /// Cancel a running turn; returns true when a turn was found.
    pub fn cancel_turn(&self, turn_id: &str) -> bool {
        self.turns.cancel(turn_id)
    }

    pub fn cancel_all(&self) -> usize {
        self.turns.cancel_all()
    }

    pub fn begin_shutdown(&self) -> usize {
        self.turns.begin_shutdown()
    }

    /// Marks the next window close as a real quit (used by the updater setup,
    /// which asks the running app to close before replacing files).
    pub fn allow_exit_on_close(&self) {
        self.close_intent.allow_exit();
    }

    /// Consumes the one-shot quit flag.
    pub fn take_exit_on_close(&self) -> bool {
        self.close_intent.take_exit()
    }

    pub fn cancel_conversation(&self, conversation_id: &str) -> usize {
        self.turns.cancel_conversation(conversation_id)
    }

    pub fn active_turns(&self) -> Vec<(String, String)> {
        self.turns.active_turns()
    }

    pub fn active_turn_details(&self) -> Vec<(String, String, i64)> {
        self.turns.active_turn_details()
    }

    /// Há um turno ativo nesta conversa? Usado pelo preflight de objetivos
    /// (`goal_can_continue`) e pela degradação de rodada interrompida.
    pub fn has_active_turn_for(&self, conversation_id: &str) -> bool {
        self.turns.has_active_for(conversation_id)
    }
}

/// Waits until `idle()` is true or `timeout` elapses. Returns the final state.
/// Used on shutdown to give cancelled turns time to persist their partial
/// state before the process exits.
pub(crate) async fn wait_until_idle(
    idle: impl Fn() -> bool,
    timeout: std::time::Duration,
) -> bool {
    if idle() {
        return true;
    }
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        if idle() {
            return true;
        }
    }
    idle()
}

/// Ensure transient directories exist.
pub fn ensure_dirs(app: &AppHandle) -> anyhow::Result<()> {
    // `skills-bundled` não entra aqui: o módulo de skills o materializa (e
    // regrava) a cada inicialização; `skills` é a pasta do usuário.
    for sub in [
        "attachments",
        "artifacts",
        "themes",
        "logs",
        "code-runs",
        "skills",
        // Harness de código: checkpoints (journal) e spill de saídas longas.
        "checkpoints",
        "spill",
    ] {
        let dir = crate::config::data_dir(app)?.join(sub);
        std::fs::create_dir_all(dir)?;
    }
    let _ = app.package_info();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{CloseIntent, TurnRegistry};

    #[test]
    fn acp_model_lookup_reads_agent_discovered_models() {
        use crate::acp::{AcpAgentRow, AcpModelRow};
        use crate::db::Db;

        let db = Db::open_in_memory().expect("in-memory db");
        let row = AcpAgentRow {
            id: "acp__opencode".into(),
            registry_id: Some("opencode".into()),
            name: "OpenCode".into(),
            version: "2.4.1".into(),
            description: String::new(),
            homepage: None,
            repository: None,
            license: None,
            icon_path: None,
            source: "detected".into(),
            thinking_config_json: "{}".into(),
            kind: "detected".into(),
            command: "opencode.cmd".into(),
            args_json: r#"["acp"]"#.into(),
            env_json: "{}".into(),
            env_secret_names_json: "[]".into(),
            install_dir: None,
            sha256: None,
            trusted: true,
            enabled: true,
            supports_fs: true,
            supports_terminal: true,
            supports_elicitation: true,
            auth_state: "ready".into(),
            auth_hint: None,
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        db.acp_agent_save(&row).expect("save agent");
        db.acp_models_replace(
            &row.id,
            &[AcpModelRow {
                model_id: "opencode-go/hy4-flash-free".into(),
                name: "Hy4".into(),
                description: None,
                is_default: true,
                options_json: "{}".into(),
            }],
        )
        .expect("save models");

        let model = super::AppState::acp_model_from_db(
            &db,
            "acp__opencode",
            "opencode-go/hy4-flash-free",
        )
        .expect("ACP model must resolve for model changes and turns");
        assert_eq!(model.name, "Hy4");
        assert_eq!(model.protocols, vec!["acp".to_string()]);
        assert!(
            !model.reasoning_options.is_empty(),
            "bundled catalog must supply reasoning options before ACP discovery"
        );

        let mut thinking = row.clone();
        thinking.thinking_config_json = r#"{"id":"effort","type":"select","values":["none","high","default"],"currentValue":"default"}"#.into();
        db.acp_agent_save(&thinking).expect("save thinking config");
        let model = super::AppState::acp_model_from_db(
            &db,
            "acp__opencode",
            "opencode-go/hy4-flash-free",
        )
        .expect("model still resolves");
        assert!(model.reasoning);
        assert_eq!(
            model.reasoning_options,
            vec![crate::catalog::ReasoningOption::Effort {
                values: vec!["none".into(), "high".into(), "default".into()]
            }]
        );
    }

    #[test]
    fn close_intent_is_consumed_once() {
        let intent = CloseIntent::default();
        assert!(!intent.take_exit());
        intent.allow_exit();
        assert!(intent.take_exit());
        assert!(!intent.take_exit());
    }

    #[test]
    fn turn_registry_tracks_active_turns_per_conversation() {
        let registry = TurnRegistry::new();
        assert!(!registry.has_active_for("conv-1"));

        let token = registry.register("turn-1", "conv-1");
        assert!(registry.has_active_for("conv-1"));
        assert!(!registry.has_active_for("conv-2"));
        assert_eq!(registry.active_conversations(), vec!["conv-1".to_string()]);
        assert!(!token.is_cancelled());

        registry.finish("turn-1");
        assert!(!registry.has_active_for("conv-1"));
        assert!(registry.active_conversations().is_empty());
    }

    #[test]
    fn turn_registry_accepts_only_one_turn_per_conversation() {
        let registry = TurnRegistry::new();
        let first = registry.register_if_idle("turn-1", "conv-1").expect("first");
        assert!(!first.is_cancelled());
        assert!(registry.register_if_idle("turn-2", "conv-1").is_none());
        let other = registry.register_if_idle("turn-3", "conv-2").expect("other");
        assert!(!other.is_cancelled());
        registry.finish("turn-1");
        assert!(registry.register_if_idle("turn-4", "conv-1").is_some());
    }

    #[test]
    fn turn_registry_cancels_only_the_requested_turn() {
        let registry = TurnRegistry::new();
        let first = registry.register("turn-1", "conv-1");
        let second = registry.register("turn-2", "conv-1");

        assert!(registry.cancel("turn-1"));
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!registry.cancel("turn-unknown"));

        registry.cancel_all();
        assert!(second.is_cancelled());
    }

    #[test]
    fn begin_shutdown_cancels_turns_and_rejects_new_ones() {
        let registry = TurnRegistry::new();
        let token = registry.register("turn-1", "conv-1");
        assert_eq!(registry.begin_shutdown(), 1);
        assert!(token.is_cancelled());
        assert!(registry.register_if_idle("turn-2", "conv-2").is_none());
        registry.finish("turn-1");
        assert!(registry.active_turns().is_empty());
    }

    #[tokio::test]
    async fn wait_until_idle_stops_when_predicate_flips_or_times_out() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let flag = Arc::new(AtomicBool::new(false));
        let writer = flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            writer.store(true, Ordering::SeqCst);
        });
        assert!(
            super::wait_until_idle(
                || flag.load(Ordering::SeqCst),
                std::time::Duration::from_millis(500)
            )
            .await
        );
        assert!(
            !super::wait_until_idle(|| false, std::time::Duration::from_millis(50)).await
        );
    }
}
