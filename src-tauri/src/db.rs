//! SQLite persistence (conversations, messages, attachments, artifacts, usage
//! and the code-harness tables: workspaces, code events, file journal, session
//! summaries and approval rules).
//!
//! One shared `rusqlite::Connection` guarded by a `parking_lot::Mutex` keeps
//! `Db` `Send + Sync`, which is what the Tauri state requires. All JSON columns
//! (`tool_calls`, `citations`, `attachments`, `usage`, `provider_state`,
//! `trace`) are (de)serialized here; the rest of the app only sees domain types.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::agents::{
    Agent, AgentChannel, AgentChannelInput, AgentChannelMessage, AgentEvent, AgentInboxCount,
    AgentInboxItem, AgentInput, AgentMemory, AgentMemoryInput, AgentRoutine, AgentRoutineInput,
    AgentRoutineQueueItem, AgentRoutineRun, AgentSharedMemory, AgentTask, AgentTaskEvent,
    AgentTaskInput, AgentThreadCursor, AgentThreadPage, AgentUsage, DailyUsageStats,
    ModelUsageStats, UsageStats, UsageStatsTotals,
};
use crate::computer::{ComputerActionRecord, ComputerSession};
use crate::domain::{
    conversation_mode_or_default, now_ms, ApprovalDecision, ApprovalRule, ApprovalScope, Artifact,
    ArtifactKind, AttachmentInfo, CacheBreakReason, CacheSample, CacheState, ChatMessage,
    Conversation, ConversationDetail, FileChangeKind, LibraryArtifact, MessageError, MessageRole,
    MessageStatus, PermissionMode, SegmentDigest, ToolCallRecord, ToolCallStatus, TurnKind,
    UsageInfo, Workspace, CONVERSATION_MODE_AGENT, CONVERSATION_MODE_CHAT, CONVERSATION_MODE_CODE,
};

/* ------------------------------------------------------------------ */
/* Column lists                                                        */
/* ------------------------------------------------------------------ */

const CONVERSATION_COLUMNS: &str = "id, title, created_at, updated_at, pinned, \
     provider_id, model_id, message_count, preview, mode, code_linked, workspace_id, \
     agent_kind, permission_mode, parent_conversation_id, subagent_task_call_id, subagent_type, \
     agent_id, channel_id, task_id, sort_order, is_main";

const AGENT_COLUMNS: &str = "a.id, a.name, a.role, a.description, a.avatar_json, a.department, \
     a.pinned, a.sort_order, a.provider_id, a.model_id, a.fallback_provider_id, \
     a.fallback_model_id, a.reasoning_json, a.instructions, a.prompt_version, a.starters_json, \
     a.capabilities_json, a.memory_enabled, a.memory_revision, a.workspace_id, a.permission_mode, a.docker_image, \
     a.computer_environment, a.archived_at, a.created_at, a.updated_at";

const AGENT_TASK_COLUMNS: &str = "id, channel_id, parent_task_id, owner_agent_id, \
     created_by_agent_id, created_by_user, title, brief, acceptance, status, priority, \
     max_turns, max_tokens, max_cost, deadline_at, conversation_id, origin_conversation_id, \
     workspace_id, retry_count, result, result_artifact_ids, lease_until, handoff_count, version, \
     created_at, updated_at";

const AGENT_ROUTINE_COLUMNS: &str = "id, agent_id, title, prompt, schedule_kind, \
     interval_minutes, hour, minute, enabled, conversation_id, next_run_at, last_run_at, \
     last_status, last_error, trigger_kind, event_kind, event_filter_json, lease_until, \
     created_at, updated_at, days_of_week";

const AGENT_ROUTINE_QUEUE_COLUMNS: &str = "id, routine_id, agent_id, conversation_id, source, \
     event_id, scheduled_for, status, error, created_at, started_at";

const AGENT_INBOX_ITEM_COLUMNS: &str = "i.id, i.recipient_agent_id, i.sender_agent_id, \
     i.sender_user, i.channel_id, c.name, i.message_id, COALESCE(s.name, 'Usuário'), \
     m.content, i.status, i.attempts, i.last_error, i.created_at, i.delivered_at";

const WORKSPACE_COLUMNS: &str = "id, name, path, created_at, updated_at, last_opened_at, \
     pinned, trusted, sort_order";

const MESSAGE_COLUMNS: &str = "id, conversation_id, role, content, reasoning, status, \
     tool_calls, citations, attachments, model_id, provider_id, usage, provider_state, created_at, \
     trace, origin, error, resume_state";

const ATTACHMENT_COLUMNS: &str = "id, name, mime_type, size, kind, text, page_count, \
     width, height, file_path, created_at";

const ARTIFACT_COLUMNS: &str = "id, conversation_id, message_id, name, mime_type, kind, \
     language, size, created_at, favorite, task_id";

/// Mesmas colunas de [`ARTIFACT_COLUMNS`], qualificadas para a query com
/// `LEFT JOIN conversations` de [`Db::list_library_artifacts`]. Um teste garante
/// que as duas listas continuam na mesma ordem (o mapper lê por posição).
const ARTIFACT_JOIN_COLUMNS: &str = "a.id, a.conversation_id, a.message_id, a.name, \
     a.mime_type, a.kind, a.language, a.size, a.created_at, a.favorite, a.task_id";

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const PRAGMAS: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  avatar_json       TEXT NOT NULL DEFAULT '{\"kind\":\"mascot\",\"body\":\"mascot\",\"expression\":\"neutral\",\"color\":\"blue\",\"face\":\"white\",\"shape\":\"mascot\"}',
  department        TEXT NOT NULL DEFAULT 'Geral',
  pinned            INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  fallback_provider_id TEXT,
  fallback_model_id    TEXT,
  reasoning_json    TEXT,
  instructions      TEXT NOT NULL DEFAULT '',
  prompt_version    INTEGER NOT NULL DEFAULT 1,
  starters_json     TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  memory_enabled    INTEGER NOT NULL DEFAULT 0,
  memory_revision   INTEGER NOT NULL DEFAULT 0,
  workspace_id      TEXT,
  permission_mode   TEXT NOT NULL DEFAULT 'edit',
  docker_image      TEXT,
  computer_environment TEXT NOT NULL DEFAULT 'auto',
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_active_order
  ON agents(archived_at, pinned DESC, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_agents_department
  ON agents(archived_at, department, sort_order, name);

-- Durable memories shared by every conversation of one agent (v1.14).
CREATE TABLE IF NOT EXISTS agent_memories (
  id                     TEXT PRIMARY KEY,
  agent_id               TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL DEFAULT 'fact',
  content                TEXT NOT NULL,
  source_conversation_id TEXT,
  pinned                 INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent
  ON agent_memories(agent_id, pinned DESC, updated_at DESC);

-- Memories intentionally shared across every agent (v1.17).
CREATE TABLE IF NOT EXISTS agent_shared_memories (
  id                     TEXT PRIMARY KEY,
  source_agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  source_conversation_id TEXT,
  kind                   TEXT NOT NULL DEFAULT 'fact',
  content                TEXT NOT NULL,
  pinned                 INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_shared_memories
  ON agent_shared_memories(pinned DESC, updated_at DESC);

-- Scheduled routines owned by one agent (v1.14).
CREATE TABLE IF NOT EXISTS agent_routines (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  schedule_kind     TEXT NOT NULL DEFAULT 'interval',
  interval_minutes  INTEGER NOT NULL DEFAULT 60,
  hour              INTEGER NOT NULL DEFAULT 9,
  minute            INTEGER NOT NULL DEFAULT 0,
  days_of_week      INTEGER NOT NULL DEFAULT 127,
  enabled           INTEGER NOT NULL DEFAULT 1,
  conversation_id   TEXT,
  next_run_at       INTEGER NOT NULL,
  last_run_at       INTEGER,
  last_status       TEXT,
  last_error        TEXT,
  trigger_kind      TEXT NOT NULL DEFAULT 'schedule',
  event_kind        TEXT NOT NULL DEFAULT '',
  event_filter_json TEXT NOT NULL DEFAULT '{}',
  lease_until       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_routines_due
  ON agent_routines(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_agent_routines_agent
  ON agent_routines(agent_id, created_at);

-- One row per routine execution (panel log). Aditive/idempotent.
CREATE TABLE IF NOT EXISTS agent_routine_runs (
  id              TEXT PRIMARY KEY,
  routine_id      TEXT NOT NULL REFERENCES agent_routines(id) ON DELETE CASCADE,
  conversation_id TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  error           TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_routine_runs_routine
  ON agent_routine_runs(routine_id, started_at DESC);

-- Shared team channels: several agents read/write one thread (v1.14).
CREATE TABLE IF NOT EXISTS agent_channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'channel',
  dm_key      TEXT,
  leader_agent_id TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_channel_members (
  channel_id  TEXT NOT NULL REFERENCES agent_channels(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, agent_id)
);
CREATE TABLE IF NOT EXISTS agent_channel_messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES agent_channels(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  agent_id    TEXT,
  content     TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_channel_messages
  ON agent_channel_messages(channel_id, created_at, id);

-- Delegated work: one owner, optional channel/parent, budget and lease.
CREATE TABLE IF NOT EXISTS agent_tasks (
  id                    TEXT PRIMARY KEY,
  channel_id            TEXT,
  parent_task_id        TEXT,
  owner_agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_by_agent_id   TEXT,
  created_by_user       INTEGER NOT NULL DEFAULT 0,
  title                 TEXT NOT NULL,
  brief                 TEXT NOT NULL,
  acceptance            TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'queued',
  priority              INTEGER NOT NULL DEFAULT 0,
  max_turns             INTEGER NOT NULL DEFAULT 8,
  max_tokens            INTEGER NOT NULL DEFAULT 100000,
  max_cost              REAL NOT NULL DEFAULT 1.0,
  deadline_at           INTEGER,
  conversation_id       TEXT,
  origin_conversation_id TEXT,
  workspace_id          TEXT,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  result                TEXT,
  result_artifact_ids   TEXT NOT NULL DEFAULT '[]',
  lease_until           INTEGER,
  handoff_count         INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_owner
  ON agent_tasks(owner_agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_channel
  ON agent_tasks(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status
  ON agent_tasks(status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS agent_task_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_task_events
  ON agent_task_events(task_id, created_at);

-- Durable direct-message delivery queue (v1.17).
CREATE TABLE IF NOT EXISTS agent_inbox (
  id                 TEXT PRIMARY KEY,
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender_agent_id    TEXT,
  sender_user        INTEGER NOT NULL DEFAULT 0,
  channel_id         TEXT NOT NULL REFERENCES agent_channels(id) ON DELETE CASCADE,
  message_id         TEXT NOT NULL REFERENCES agent_channel_messages(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  claimed_at         INTEGER,
  delivered_at       INTEGER,
  created_at         INTEGER NOT NULL,
  UNIQUE(message_id, recipient_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_inbox_pending
  ON agent_inbox(recipient_agent_id, status, created_at);

-- Internal events used by event-triggered routines (v1.17).
CREATE TABLE IF NOT EXISTS agent_events (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  payload_json         TEXT NOT NULL DEFAULT '{}',
  source_agent_id      TEXT,
  channel_id           TEXT,
  task_id              TEXT,
  created_at           INTEGER NOT NULL,
  processed_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_events_pending
  ON agent_events(processed_at, created_at);

CREATE TABLE IF NOT EXISTS agent_event_deliveries (
  event_id    TEXT NOT NULL REFERENCES agent_events(id) ON DELETE CASCADE,
  routine_id  TEXT NOT NULL REFERENCES agent_routines(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER,
  PRIMARY KEY (event_id, routine_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_event_deliveries_status
  ON agent_event_deliveries(status, created_at);

-- FIFO of routine executions waiting for the agent's primary conversation.
CREATE TABLE IF NOT EXISTS agent_routine_queue (
  id              TEXT PRIMARY KEY,
  routine_id      TEXT NOT NULL REFERENCES agent_routines(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT 'schedule',
  event_id        TEXT REFERENCES agent_events(id) ON DELETE SET NULL,
  scheduled_for   INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_routine_queue_pending
  ON agent_routine_queue(status, created_at);

-- Computer-use audit (v1.16). Never stores typed text/screenshot bytes.
CREATE TABLE IF NOT EXISTS computer_sessions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT,
  conversation_id TEXT NOT NULL,
  backend         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_computer_sessions_conv
  ON computer_sessions(conversation_id, started_at DESC);

CREATE TABLE IF NOT EXISTS computer_actions (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES computer_sessions(id) ON DELETE CASCADE,
  agent_id          TEXT,
  conversation_id   TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  tool              TEXT NOT NULL,
  action            TEXT NOT NULL,
  target_json       TEXT NOT NULL DEFAULT '{}',
  approval_scope    TEXT,
  decision          TEXT,
  result            TEXT NOT NULL,
  error_code        TEXT,
  error_message     TEXT,
  redacted_text_len INTEGER,
  policy_rule       TEXT,
  initiator         TEXT,
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_computer_actions_turn
  ON computer_actions(turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_computer_actions_agent
  ON computer_actions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_computer_actions_conv
  ON computer_actions(conversation_id, created_at DESC);

-- Live human-control state for a conversation (never persisted history).
CREATE TABLE IF NOT EXISTS computer_control (
  conversation_id TEXT PRIMARY KEY,
  paused          INTEGER NOT NULL DEFAULT 0,
  taken_over      INTEGER NOT NULL DEFAULT 0,
  needs_observation INTEGER NOT NULL DEFAULT 0,
  control_target TEXT NOT NULL DEFAULT '',
  updated_at      INTEGER NOT NULL
);

-- Persisted turn events for renderer reattach after reload (v1.16).
CREATE TABLE IF NOT EXISTS turn_events (
  turn_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  event_json      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (turn_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turn_events_conversation
  ON turn_events(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  provider_id   TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  preview       TEXT,
  -- Layout onde a sessão nasceu ('chat' | 'code'); bancos legados viram 'chat'.
  mode          TEXT NOT NULL DEFAULT 'chat',
  -- Sessão do Chat adicionada ao Code (compartilhada nos dois layouts).
  code_linked   INTEGER NOT NULL DEFAULT 0,
  -- Harness de código: workspace da sessão (NULL = sem workspace), motor do
  -- agente ('zylara'; 'acp:<agente>' fica reservado) e modo de permissão
  -- ('read_only' | 'edit' | 'autonomous'). O Chat ignora os três.
  workspace_id    TEXT,
  agent_kind      TEXT NOT NULL DEFAULT 'zylara',
  permission_mode TEXT NOT NULL DEFAULT 'edit',
  -- Retained subagent transcript: parent session + task call + kind. NULL for
  -- normal sessions; children are hidden from the sidebar and cascade on delete.
  parent_conversation_id TEXT,
  subagent_task_call_id  TEXT,
  subagent_type          TEXT,
  -- Persona dona da conversa (NULL em Chat/Code).
  agent_id               TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  -- Canais: thread privada que pertence a um canal compartilhado.
  channel_id             TEXT,
  -- Delegação: thread de execução de uma tarefa.
  task_id                TEXT,
  -- Conversa principal da persona (uma por agente; fixada no topo).
  is_main                INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  reasoning       TEXT,
  status          TEXT NOT NULL,
  tool_calls      TEXT NOT NULL DEFAULT '[]',
  citations       TEXT NOT NULL DEFAULT '[]',
  attachments     TEXT NOT NULL DEFAULT '[]',
  model_id        TEXT,
  provider_id     TEXT,
  usage           TEXT,
  provider_state  TEXT,
  created_at      INTEGER NOT NULL,
  trace           TEXT NOT NULL DEFAULT '[]',
  -- Origem do turno que gerou a mensagem: 'user' (default) ou 'goal_round'
  -- (rodada automática do objetivo no layout Code). Bancos legados viram
  -- 'user' — é o que o app mostrava até o sistema de objetivos.
  origin          TEXT NOT NULL DEFAULT 'user',
  -- Ponto de retomada do turno (JSON): preenchido quando o turno para sem
  -- terminar (erro do provedor, Stop, app fechado, gate de completion). A
  -- mensagem já guarda conteúdo/trace/tool calls/usage/replay; esta coluna
  -- carrega só o metadado do loop (passo, opções, motivo).
  resume_state    TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  page_count INTEGER,
  width      INTEGER,
  height     INTEGER,
  file_path  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  -- NULL = arquivo enviado pelo usuário direto à Biblioteca (sem conversa).
  conversation_id TEXT,
  message_id      TEXT,
  task_id         TEXT,
  name            TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  language        TEXT,
  size            INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  path            TEXT NOT NULL,
  favorite        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT,
  message_id       TEXT,
  provider_id      TEXT,
  model_id         TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  reasoning_tokens INTEGER,
  cached_tokens    INTEGER,
  total_tokens     INTEGER,
  cost             REAL,
  -- Cache de prompt (docs/goals/prompt-cache/PLAN.md §5.3). Granularidade
  -- continua 1 linha por turno (billing); a verdade por request de wire fica em
  -- `cache_samples`. Bancos antigos ganham estas colunas na migração aditiva.
  cache_read_tokens     INTEGER,
  cache_write_tokens    INTEGER,
  uncached_input_tokens INTEGER,
  cache_hit_percent     REAL,
  cache_epoch           INTEGER,
  prefix_hash           TEXT,
  break_reason          TEXT,
  protocol              TEXT,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

/* ---- harness de código (docs/goals/code-harness/PLAN.md §7) ---- */

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_opened_at INTEGER,
  pinned         INTEGER NOT NULL DEFAULT 0,
  trusted        INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

-- Trilha persistida do agente de código: um evento por passo/ferramenta, com
-- `seq` monotônico por conversa (usado pelo replay/compactação).
CREATE TABLE IF NOT EXISTS code_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  turn_id         TEXT,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_events_conv_seq ON code_events(conversation_id, seq);

-- Journal das escritas de arquivo feitas pelo agente (painel Alterações/replay).
CREATE TABLE IF NOT EXISTS file_journal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  path            TEXT NOT NULL,
  change_kind     TEXT NOT NULL,
  before_hash     TEXT,
  after_hash      TEXT,
  added           INTEGER,
  removed         INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_journal_conv_turn ON file_journal(conversation_id, turn_id);

-- Resumos de compactação: cobrem a faixa de `seq` de code_events.
CREATE TABLE IF NOT EXISTS session_summaries (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  from_seq        INTEGER NOT NULL,
  to_seq          INTEGER NOT NULL,
  content         TEXT NOT NULL,
  tokens          INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_summaries_conv
  ON session_summaries(conversation_id, created_at);

-- Regras de aprovacao (sempre permitir/negar) por escopo sessao/workspace/global.
CREATE TABLE IF NOT EXISTS approval_rules (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  scope_id   TEXT,
  tool       TEXT NOT NULL,
  matcher    TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  decision   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_rules_scope ON approval_rules(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_approval_rules_tool ON approval_rules(tool);

/* ---- cache de prompt (docs/goals/prompt-cache/PLAN.md §4.4/§5.3) ---- */

-- System prompt + tools congelados por sessão (F2.1/F3.1). A chave natural é
-- (conversa, snapshot_key) com snapshot_key = provider|model|profile|workspace|prompt_version.
CREATE TABLE IF NOT EXISTS prompt_snapshots (
  conversation_id TEXT NOT NULL,
  snapshot_key    TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  profile         TEXT NOT NULL,
  workspace_id    TEXT,
  prompt_version  INTEGER NOT NULL,
  system_text     TEXT NOT NULL,
  tools_json      TEXT NOT NULL,
  stable_hash     TEXT NOT NULL,
  tools_hash      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  invalidated_at  INTEGER,
  PRIMARY KEY (conversation_id, snapshot_key)
);

-- Decisão de render congelada por mensagem (F2.7a): imagem vs. texto, anexo
-- truncado, replay bruto vs. fallback neutro. Nunca é recalculada em silêncio.
CREATE TABLE IF NOT EXISTS render_decisions (
  message_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  digest       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
);

-- Contexto/plano/modo na cauda do replay (F2.5a/F2.5b): append-only, posição
-- exata por (after_message_id, after_step) + desempate estável `seq`. O texto é
-- renderizado como user-role marcado; o dedupe é por conversa + sha256 do texto.
CREATE TABLE IF NOT EXISTS surface_items (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  after_message_id TEXT,
  after_step       INTEGER,
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  digest           TEXT NOT NULL,
  text             TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_items_dedupe
  ON surface_items(conversation_id, digest);
CREATE INDEX IF NOT EXISTS idx_surface_items_order
  ON surface_items(conversation_id, after_message_id, after_step, seq);
CREATE INDEX IF NOT EXISTS idx_surface_items_conv
  ON surface_items(conversation_id, created_at);

-- Estado canônico por conversa (F1.1): último prefixo/digest, epoch e agregados.
CREATE TABLE IF NOT EXISTS cache_state (
  conversation_id      TEXT PRIMARY KEY,
  provider_id          TEXT,
  model_id             TEXT,
  protocol             TEXT,
  epoch                INTEGER NOT NULL DEFAULT 0,
  prefix_hash          TEXT,
  prefix_segments      TEXT, -- JSON compacto (cap de 500 segmentos)
  prompt_snapshot_hash TEXT,
  -- Watermark do corte de emergência do histórico do Chat (F2b, PLAN §4.3):
  -- `seq` da primeira mensagem incluída; NULL = histórico sem corte. Só avança
  -- em saltos (≥20% do budget) e em fronteira de turno, nunca 1 mensagem/turno.
  chat_cut_seq         INTEGER,
  cache_read           INTEGER NOT NULL DEFAULT 0,
  cache_write          INTEGER NOT NULL DEFAULT 0,
  uncached             INTEGER NOT NULL DEFAULT 0,
  samples              INTEGER NOT NULL DEFAULT 0,
  last_hit_percent     REAL,
  last_ceiling_percent REAL,
  last_at              INTEGER,
  last_break_reason    TEXT,
  last_break_detail    TEXT,
  updated_at           INTEGER NOT NULL
);

-- Amostra por request de wire (criada na F0b.3; a amostra nasce em memória na
-- F0a.2; §4.7). Fonte canônica do agregado/benchmark; retenção de 500/conversa.
CREATE TABLE IF NOT EXISTS cache_samples (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    TEXT NOT NULL,
  turn_id            TEXT,
  step               INTEGER NOT NULL,
  provider_id        TEXT,
  model_id           TEXT,
  protocol           TEXT,
  epoch              INTEGER NOT NULL,
  prefix_hash        TEXT,
  input_total        INTEGER,
  cache_read         INTEGER,
  cache_write        INTEGER,
  uncached           INTEGER,
  hit_percent        REAL,
  ceiling_percent    REAL,
  prefix_tokens_est  INTEGER,
  delta_tokens_est   INTEGER,
  eligible           INTEGER NOT NULL DEFAULT 1,
  excluded_reason    TEXT,
  state              TEXT NOT NULL,
  break_reason       TEXT,
  break_detail       TEXT,
  raw_usage          TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_samples_conv
  ON cache_samples(conversation_id, created_at);

-- Plugins (docs/PLUGINS.md). Additive: older databases keep every row and the
-- manager only scans enabled rows at boot.
CREATE TABLE IF NOT EXISTS plugins (
  id                 TEXT PRIMARY KEY,
  version            TEXT NOT NULL,
  api_version        INTEGER NOT NULL,
  root               TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 0,
  trusted            INTEGER NOT NULL DEFAULT 0,
  source             TEXT NOT NULL,
  signature_status   TEXT NOT NULL,
  publisher_id       TEXT,
  publisher_name     TEXT,
  key_id             TEXT,
  key_fingerprint    TEXT,
  manifest_json      TEXT NOT NULL,
  package_hash       TEXT NOT NULL DEFAULT '',
  installed_at       INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  auto_update        INTEGER NOT NULL DEFAULT 0,
  previous_version   TEXT,
  previous_root      TEXT,
  disabled_reason    TEXT,
  size_bytes         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS plugin_permissions (
  plugin_id          TEXT NOT NULL,
  permission         TEXT NOT NULL,
  granted            INTEGER NOT NULL DEFAULT 0,
  granted_at         INTEGER NOT NULL,
  PRIMARY KEY(plugin_id, permission)
);
CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id          TEXT NOT NULL,
  key                TEXT NOT NULL,
  value_json         TEXT NOT NULL,
  PRIMARY KEY(plugin_id, key)
);
CREATE TABLE IF NOT EXISTS plugin_state (
  plugin_id          TEXT NOT NULL,
  key                TEXT NOT NULL,
  value_json         TEXT NOT NULL,
  PRIMARY KEY(plugin_id, key)
);
CREATE TABLE IF NOT EXISTS plugin_logs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id          TEXT NOT NULL,
  level              TEXT NOT NULL,
  message            TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_logs_plugin
  ON plugin_logs(plugin_id, id DESC);
CREATE TABLE IF NOT EXISTS plugin_audit (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id          TEXT NOT NULL,
  capability         TEXT NOT NULL,
  params_digest      TEXT,
  decision           TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_audit_plugin
  ON plugin_audit(plugin_id, id DESC);
CREATE TABLE IF NOT EXISTS plugin_tool_calls (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id          TEXT NOT NULL,
  tool               TEXT NOT NULL,
  conversation_id    TEXT,
  turn_id            TEXT,
  status             TEXT NOT NULL,
  duration_ms        INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_store_cache (
  key                TEXT PRIMARY KEY,
  etag               TEXT,
  body               TEXT NOT NULL,
  fetched_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_publishers (
  publisher_id       TEXT NOT NULL,
  key_id             TEXT NOT NULL,
  public_key         TEXT NOT NULL,
  fingerprint        TEXT NOT NULL,
  trusted_at         INTEGER NOT NULL,
  PRIMARY KEY(publisher_id, key_id)
);
CREATE TABLE IF NOT EXISTS plugin_publisher_keys (
  publisher_id       TEXT NOT NULL,
  key_id             TEXT NOT NULL,
  public_key         TEXT NOT NULL,
  fingerprint        TEXT NOT NULL,
  revoked            INTEGER NOT NULL DEFAULT 0,
  rotated_at         INTEGER,
  trusted_at         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(publisher_id, key_id)
);
-- Fingerprint of the enabled-plugin configuration per conversation, used to
-- attribute a prompt-cache break to the specific `plugin_config_changed`.
CREATE TABLE IF NOT EXISTS plugin_cache_state (
  conversation_id    TEXT PRIMARY KEY,
  fingerprint        TEXT NOT NULL,
  updated_at         INTEGER NOT NULL
);
";

/* ------------------------------------------------------------------ */
/* Stored rows                                                         */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct StoredAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    pub kind: String,
    pub text: String,
    pub page_count: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub file_path: Option<String>,
    pub created_at: i64,
}

impl StoredAttachment {
    pub fn info(&self) -> AttachmentInfo {
        AttachmentInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            mime_type: self.mime_type.clone(),
            size: self.size,
            kind: self.kind.clone(),
            text_preview: if self.text.trim().is_empty() {
                None
            } else {
                Some(self.text.chars().take(280).collect())
            },
            page_count: self.page_count,
            width: self.width,
            height: self.height,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredArtifact {
    pub artifact: Artifact,
    pub path: String,
}

/* ---- harness de código: linhas persistidas ---- */

/// Evento da trilha do agente de código (`code_events`). `payload` é o JSON
/// opaco do evento (o renderer/replay decide como interpretar por `kind`).
#[derive(Debug, Clone)]
pub struct StoredCodeEvent {
    pub id: i64,
    pub conversation_id: String,
    pub turn_id: Option<String>,
    /// Monotônico por conversa, começando em 1 (garantido por índice único).
    pub seq: i64,
    pub kind: String,
    pub payload: String,
    pub created_at: i64,
}

/// Entrada do journal de escritas de arquivo (`file_journal`).
#[derive(Debug, Clone)]
pub struct FileJournalEntry {
    pub id: i64,
    pub conversation_id: String,
    pub turn_id: String,
    pub path: String,
    pub change_kind: FileChangeKind,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub created_at: i64,
}

impl FileJournalEntry {
    /// Entrada mínima (sem hashes/contagem); `created_at` = agora.
    pub fn new(
        conversation_id: impl Into<String>,
        turn_id: impl Into<String>,
        path: impl Into<String>,
        change_kind: FileChangeKind,
    ) -> Self {
        Self {
            id: 0,
            conversation_id: conversation_id.into(),
            turn_id: turn_id.into(),
            path: path.into(),
            change_kind,
            before_hash: None,
            after_hash: None,
            added: None,
            removed: None,
            created_at: now_ms(),
        }
    }

    /// Hashes de conteúdo antes/depois da escrita (para "desfazer"/comparar).
    pub fn with_hashes(mut self, before: Option<&str>, after: Option<&str>) -> Self {
        self.before_hash = before.map(str::to_string);
        self.after_hash = after.map(str::to_string);
        self
    }

    /// Linhas adicionadas/removidas do arquivo (contagem do diff).
    pub fn with_line_counts(mut self, added: u32, removed: u32) -> Self {
        self.added = Some(added);
        self.removed = Some(removed);
        self
    }
}

/// Resumo de compactação que cobre a faixa `[from_seq, to_seq]` de
/// `code_events` de uma conversa (`session_summaries`).
#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub id: String,
    pub conversation_id: String,
    pub from_seq: i64,
    pub to_seq: i64,
    pub content: String,
    pub tokens: Option<u32>,
    pub created_at: i64,
}

/// Dados para criar uma regra de aprovação; o `Db` gera `id` e `created_at`.
#[derive(Debug, Clone)]
pub struct NewApprovalRule<'a> {
    pub scope: ApprovalScope,
    pub scope_id: Option<&'a str>,
    pub tool: &'a str,
    pub matcher: &'a str,
    pub pattern: &'a str,
    pub decision: ApprovalDecision,
}

/* ------------------------------------------------------------------ */
/* Cache de prompt: linhas persistidas (PLAN §5.3)                     */
/* ------------------------------------------------------------------ */

/// Retenção de `cache_samples` por conversa (PLAN §5.3): quando a 501ª amostra
/// chega, as mais antigas são descartadas em rotação. O agregado continua
/// disponível em `cache_state`.
pub const CACHE_SAMPLES_RETENTION: u32 = 500;

/// Cap do JSON de `cache_state.prefix_segments` (PLAN §5.3). Os segmentos são
/// gravados do início do prefixo: truncar o fim preserva a comparação do head.
pub const CACHE_STATE_MAX_SEGMENTS: usize = 500;

/// Item da superfície append-only (`surface_items`, PLAN §4.4): contexto
/// dinâmico (runtime/plan/todo/mode/workspace/date) posicionado na cauda exata
/// do replay por `(after_message_id, after_step, seq)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceItemRecord {
    pub id: String,
    pub conversation_id: String,
    /// Mensagem após a qual o item entra (`None` = início do replay).
    pub after_message_id: Option<String>,
    /// Passo do replay multi-step (`None` = fim do grupo da mensagem).
    pub after_step: Option<u32>,
    /// Desempate estável entre itens no mesmo ponto (append-only).
    pub seq: u32,
    pub kind: String,
    /// SHA-256 do `text` (hex), usado no dedupe por conversa.
    pub digest: String,
    pub text: String,
    pub created_at: i64,
}

impl SurfaceItemRecord {
    /// Item novo: `id`/`digest`/`created_at` gerados aqui (`digest` =
    /// [`surface_digest`]). A posição (`after_message_id`/`after_step`/`seq`) é
    /// do chamador (replay do harness).
    pub fn new(
        conversation_id: impl Into<String>,
        after_message_id: Option<&str>,
        after_step: Option<u32>,
        kind: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        let text = text.into();
        let digest = surface_digest(&text);
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.into(),
            after_message_id: after_message_id.map(str::to_string),
            after_step,
            seq: 0,
            kind: kind.into(),
            digest,
            text,
            created_at: now_ms(),
        }
    }

    /// Define o desempate no mesmo ponto (builder; devolve o próprio item).
    pub fn with_seq(mut self, seq: u32) -> Self {
        self.seq = seq;
        self
    }
}

/// SHA-256 (hex) do texto de um `surface_item`; é o `digest` do dedupe
/// `UNIQUE(conversation_id, digest)`.
pub fn surface_digest(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

/// Estado canônico de cache por conversa (`cache_state`, PLAN §5.3). Guarda o
/// último prefixo/digest, o epoch e o agregado consumido pelo `get_cache_stats`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CacheStateRecord {
    pub conversation_id: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub protocol: Option<String>,
    pub epoch: u32,
    pub prefix_hash: Option<String>,
    /// Segmentos do prefixo do último request (JSON compacto, cap 500).
    pub prefix_segments: Option<Vec<SegmentDigest>>,
    pub prompt_snapshot_hash: Option<String>,
    /// Watermark do corte de emergência do histórico do Chat (F2b, PLAN §4.3):
    /// `seq` da primeira mensagem incluída; `None` = histórico sem corte. O
    /// harness só avança em saltos (≥20% do budget) e em fronteira de turno.
    pub chat_cut_seq: Option<u32>,
    pub cache_read: u32,
    pub cache_write: u32,
    pub uncached: u32,
    pub samples: u32,
    pub last_hit_percent: Option<f32>,
    pub last_ceiling_percent: Option<f32>,
    pub last_at: Option<i64>,
    pub last_break_reason: Option<CacheBreakReason>,
    pub last_break_detail: Option<String>,
    pub updated_at: i64,
}

impl CacheStateRecord {
    /// Estado vazio de uma conversa, com `updated_at` = agora.
    pub fn new(conversation_id: impl Into<String>) -> Self {
        Self {
            conversation_id: conversation_id.into(),
            updated_at: now_ms(),
            ..Self::default()
        }
    }
}

/// `prompt_snapshots`: system prompt + tools congelados por sessão (PLAN §4.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptSnapshotRecord {
    pub conversation_id: String,
    /// `provider|model|profile|workspace|prompt_version`.
    pub snapshot_key: String,
    pub provider_id: String,
    pub model_id: String,
    pub profile: String,
    pub workspace_id: Option<String>,
    pub prompt_version: i64,
    pub system_text: String,
    pub tools_json: String,
    pub stable_hash: String,
    pub tools_hash: String,
    pub created_at: i64,
    pub invalidated_at: Option<i64>,
}

/// `render_decisions`: decisão de render congelada por (mensagem, tipo) para o
/// replay nunca recalcular imagem/anexo/replay de uma mensagem já enviada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderDecisionRecord {
    pub message_id: String,
    /// image | document | attachment | replay
    pub kind: String,
    pub digest: String,
    /// JSON opaco da decisão (a referência congelada).
    pub payload: String,
    pub created_at: i64,
}

/// Agregado da sessão a partir de `cache_samples` (fonte canônica do
/// `get_cache_stats`). Somas token-weighted e contagem de amostras elegíveis.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheSessionAggregate {
    pub samples: u32,
    pub eligible_samples: u32,
    pub input_total: u32,
    pub cache_read: u32,
    pub cache_write: u32,
    pub uncached: u32,
    /// Somas restritas às amostras elegíveis (base do hit% de sessão/steady).
    pub eligible_input_total: u32,
    pub eligible_cache_read: u32,
}

impl CacheSessionAggregate {
    /// `Σ cache_read / Σ input_total` de todas as amostras (ciclo de vida).
    pub fn hit_percent(&self) -> Option<f32> {
        percent_of(self.cache_read, self.input_total)
    }

    /// `Σ cache_read / Σ input_total` das amostras elegíveis (meta de sessão).
    pub fn eligible_hit_percent(&self) -> Option<f32> {
        percent_of(self.eligible_cache_read, self.eligible_input_total)
    }
}

/// Metadados opcionais de cache de prompt para a linha de `usage_log` (1 por
/// turno, billing). `record_usage` grava só os campos derivados de `UsageInfo`;
/// [`Db::record_usage_with_cache`] aceita também epoch/prefixo/quebra/protocolo.
#[derive(Debug, Clone, Copy, Default)]
pub struct UsageLogCache<'a> {
    /// Quando `None`, é derivado de `UsageInfo` (read/total*100 se reportado).
    pub cache_hit_percent: Option<f32>,
    pub cache_epoch: Option<u32>,
    pub prefix_hash: Option<&'a str>,
    pub break_reason: Option<CacheBreakReason>,
    pub protocol: Option<&'a str>,
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

fn encode_json<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    serde_json::to_string(value).context("falha ao serializar coluna JSON")
}

/// Decode a JSON column produced by this module. Corrupt/legacy values fall
/// back to the type default instead of breaking an entire conversation read.
fn decode_json<T: DeserializeOwned + Default>(raw: &str) -> T {
    serde_json::from_str(raw).unwrap_or_default()
}

fn decode_opt<T: DeserializeOwned>(raw: Option<String>) -> Option<T> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
}

fn decode_opt_value(raw: Option<String>) -> Option<Value> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
}

/// Adds `column` to `table` when an older database is missing it.
fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<()> {
    let has_column = {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .with_context(|| format!("falha ao inspecionar a tabela {table}"))?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .with_context(|| format!("falha ao listar colunas de {table}"))?;
        names
            .collect::<rusqlite::Result<Vec<String>>>()
            .with_context(|| format!("falha ao ler colunas de {table}"))?
            .iter()
            .any(|name| name == column)
    };
    if !has_column {
        conn.execute(ddl, [])
            .with_context(|| format!("falha ao adicionar a coluna {column} em {table}"))?;
    }
    Ok(())
}

/// Leh `(nome, notnull)` de cada coluna da tabela (ordem do `PRAGMA table_info`).
fn table_columns(conn: &Connection, table: &str) -> Result<Vec<(String, bool)>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .with_context(|| format!("falha ao inspecionar a tabela {table}"))?;
    let rows = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let not_null: i64 = row.get(3)?;
            Ok((name, not_null != 0))
        })
        .with_context(|| format!("falha ao listar colunas de {table}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .with_context(|| format!("falha ao ler colunas de {table}"))
}

/// Shared channels: `attachments` (JSON) added after the first release; old
/// messages get an empty list.
fn migrate_agent_channel_messages_schema(conn: &Connection) -> Result<()> {
    ensure_column(
        conn,
        "agent_channel_messages",
        "attachments",
        "ALTER TABLE agent_channel_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
    )
}

/// Migração aditiva e idempotente da tabela `artifacts`:
///
/// 1. bancos anteriores à Biblioteca ganham `favorite INTEGER NOT NULL DEFAULT 0`;
/// 2. bancos em que `conversation_id` ainda é `NOT NULL` são reconstruídos (a
///    coluna passa a aceitar `NULL`, que identifica um arquivo enviado pelo
///    usuário direto à biblioteca). A reconstrução roda em transação e copia
///    todas as linhas — nenhum artefato é perdido e os antigos ficam
///    `favorite = 0`.
fn migrate_artifacts_schema(conn: &Connection) -> Result<()> {
    ensure_column(
        conn,
        "artifacts",
        "favorite",
        "ALTER TABLE artifacts ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "artifacts",
        "task_id",
        "ALTER TABLE artifacts ADD COLUMN task_id TEXT",
    )?;

    let conversation_id_is_required = table_columns(conn, "artifacts")?
        .iter()
        .any(|(name, not_null)| name == "conversation_id" && *not_null);
    if !conversation_id_is_required {
        return Ok(());
    }

    let tx = conn
        .unchecked_transaction()
        .context("falha ao abrir a transação de migração da tabela artifacts")?;
    // `artifacts_new` só existiria se uma migração anterior tivesse sido
    // interrompida fora da transação; o DROP defensivo mantém a migração
    // idempotente sem arriscar a tabela atual (que só cai depois da cópia).
    tx.execute_batch(
        "DROP TABLE IF EXISTS artifacts_new;
         CREATE TABLE artifacts_new (
           id              TEXT PRIMARY KEY,
           conversation_id TEXT,
           message_id      TEXT,
           name            TEXT NOT NULL,
           mime_type       TEXT NOT NULL,
           kind            TEXT NOT NULL,
           language        TEXT,
           size            INTEGER NOT NULL,
           created_at      INTEGER NOT NULL,
           path            TEXT NOT NULL,
           favorite        INTEGER NOT NULL DEFAULT 0,
           task_id         TEXT
         );
         INSERT INTO artifacts_new (id, conversation_id, message_id, name, mime_type, kind,
                                    language, size, created_at, path, favorite, task_id)
           SELECT id, conversation_id, message_id, name, mime_type, kind, language, size,
                  created_at, path, favorite, task_id
           FROM artifacts;
         DROP TABLE artifacts;
         ALTER TABLE artifacts_new RENAME TO artifacts;",
    )
    .context("falha ao reconstruir a tabela artifacts para aceitar uploads da biblioteca")?;
    tx.commit()
        .context("falha ao confirmar a migração da tabela artifacts")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);",
    )
    .context("falha ao recriar o índice de task_id em artifacts")?;
    Ok(())
}

/// Migração aditiva e idempotente da tabela `messages`:
///
/// 1. bancos anteriores à trilha do agente ganham `trace` (`'[]'` = sem
///    timeline);
/// 2. bancos anteriores ao sistema de objetivos ganham `origin` (`'user'` em
///    todas as linhas existentes — o app não gravava a origem do turno, então
///    tudo é mensagem humana; é exatamente o que era exibido).
///
/// Nenhuma linha é perdida e a migração pode rodar quantas vezes for preciso.
fn migrate_messages_schema(conn: &Connection) -> Result<()> {
    ensure_column(
        conn,
        "messages",
        "trace",
        "ALTER TABLE messages ADD COLUMN trace TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        conn,
        "messages",
        "origin",
        "ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'",
    )?;
    ensure_column(
        conn,
        "messages",
        "error",
        "ALTER TABLE messages ADD COLUMN error TEXT",
    )?;
    // Turnos retomáveis: ponto de retomada do turno interrompido.
    ensure_column(
        conn,
        "messages",
        "resume_state",
        "ALTER TABLE messages ADD COLUMN resume_state TEXT",
    )
}

/// Migração aditiva e idempotente da tabela `conversations`:
///
/// 1. Chat/Code split: databases created before the two layouts get `mode`
///    (`'chat'` on every existing row) and `code_linked` (`0`);
/// 2. code harness: databases created before the harness get `workspace_id`
///    (`NULL` = no workspace), `agent_kind` (`'zylara'`) and `permission_mode`
///    (`'edit'`). Chat ignores the three; `workspace_id` is filled when the
///    user opens a Code session with a workspace;
/// 3. subagents: `parent_conversation_id`, `subagent_task_call_id` and
///    `subagent_type` (`NULL` on normal sessions) for retained transcripts.
///
/// No row is lost and the migration is idempotent.
fn migrate_conversations_schema(conn: &Connection) -> Result<()> {
    ensure_column(
        conn,
        "conversations",
        "mode",
        "ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'",
    )?;
    ensure_column(
        conn,
        "conversations",
        "code_linked",
        "ALTER TABLE conversations ADD COLUMN code_linked INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "conversations",
        "workspace_id",
        "ALTER TABLE conversations ADD COLUMN workspace_id TEXT",
    )?;
    ensure_column(
        conn,
        "conversations",
        "agent_kind",
        "ALTER TABLE conversations ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'zylara'",
    )?;
    ensure_column(
        conn,
        "conversations",
        "permission_mode",
        "ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'edit'",
    )?;
    // Retained subagent transcripts: parent link, task call id and kind.
    ensure_column(
        conn,
        "conversations",
        "parent_conversation_id",
        "ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT",
    )?;
    ensure_column(
        conn,
        "conversations",
        "subagent_task_call_id",
        "ALTER TABLE conversations ADD COLUMN subagent_task_call_id TEXT",
    )?;
    ensure_column(
        conn,
        "conversations",
        "subagent_type",
        "ALTER TABLE conversations ADD COLUMN subagent_type TEXT",
    )?;
    // Agentes: vínculo aditivo, NULL em Chat/Code e nos bancos legados. A
    // tabela `agents` já foi criada pelo `SCHEMA` antes desta migração.
    ensure_column(
        conn,
        "conversations",
        "agent_id",
        "ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT",
    )?;
    ensure_column(
        conn,
        "conversations",
        "channel_id",
        "ALTER TABLE conversations ADD COLUMN channel_id TEXT",
    )?;
    ensure_column(
        conn,
        "conversations",
        "task_id",
        "ALTER TABLE conversations ADD COLUMN task_id TEXT",
    )?;
    // Manual sidebar order (0 = fall back to recency).
    ensure_column(
        conn,
        "conversations",
        "sort_order",
        "ALTER TABLE conversations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    )?;
    // One primary conversation per agent; the partial unique index is the
    // database-level guarantee even under concurrent creation/self-heal.
    ensure_column(
        conn,
        "conversations",
        "is_main",
        "ALTER TABLE conversations ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_main_agent \
         ON conversations(agent_id) WHERE is_main = 1 AND agent_id IS NOT NULL;",
    )
    .context("falha ao criar o índice da conversa principal")?;
    ensure_column(
        conn,
        "agent_tasks",
        "origin_conversation_id",
        "ALTER TABLE agent_tasks ADD COLUMN origin_conversation_id TEXT",
    )?;
    ensure_column(
        conn,
        "agent_tasks",
        "workspace_id",
        "ALTER TABLE agent_tasks ADD COLUMN workspace_id TEXT",
    )?;
    ensure_column(
        conn,
        "agent_tasks",
        "retry_count",
        "ALTER TABLE agent_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "agent_channels",
        "kind",
        "ALTER TABLE agent_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel'",
    )?;
    ensure_column(
        conn,
        "agent_channels",
        "dm_key",
        "ALTER TABLE agent_channels ADD COLUMN dm_key TEXT",
    )?;
    ensure_column(
        conn,
        "agent_channels",
        "sort_order",
        "ALTER TABLE agent_channels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "agent_channels",
        "leader_agent_id",
        "ALTER TABLE agent_channels ADD COLUMN leader_agent_id TEXT",
    )?;
    ensure_column(
        conn,
        "artifacts",
        "task_id",
        "ALTER TABLE artifacts ADD COLUMN task_id TEXT",
    )?;
    for (column, ddl) in [
        (
            "trigger_kind",
            "ALTER TABLE agent_routines ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'schedule'",
        ),
        (
            "event_kind",
            "ALTER TABLE agent_routines ADD COLUMN event_kind TEXT NOT NULL DEFAULT ''",
        ),
        (
            "event_filter_json",
            "ALTER TABLE agent_routines ADD COLUMN event_filter_json TEXT NOT NULL DEFAULT '{}'",
        ),
        (
            "lease_until",
            "ALTER TABLE agent_routines ADD COLUMN lease_until INTEGER",
        ),
        (
            "days_of_week",
            "ALTER TABLE agent_routines ADD COLUMN days_of_week INTEGER NOT NULL DEFAULT 127",
        ),
    ] {
        ensure_column(conn, "agent_routines", column, ddl)?;
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_channels_dm_key \
           ON agent_channels(dm_key) WHERE dm_key IS NOT NULL; \
         CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id); \
         UPDATE agent_channels SET kind = 'channel' WHERE kind IS NULL OR kind = ''; \
         UPDATE artifacts SET task_id = (SELECT task_id FROM conversations \
           WHERE conversations.id = artifacts.conversation_id) \
           WHERE task_id IS NULL;",
    )
    .context("falha ao migrar colaboração multiagente")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_agent_tasks_due \
         ON agent_tasks(status, created_at);",
    )
    .context("falha ao criar o índice de tarefas")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated \
         ON conversations(agent_id, updated_at DESC, id DESC);",
    )
    .context("falha ao criar o índice de threads por agente")?;
    // Agentes com workspace opcional e modo de permissão próprio (v1.14).
    ensure_column(
        conn,
        "agents",
        "workspace_id",
        "ALTER TABLE agents ADD COLUMN workspace_id TEXT",
    )?;
    ensure_column(
        conn,
        "agents",
        "permission_mode",
        "ALTER TABLE agents ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'edit'",
    )?;
    ensure_column(
        conn,
        "agents",
        "fallback_provider_id",
        "ALTER TABLE agents ADD COLUMN fallback_provider_id TEXT",
    )?;
    ensure_column(
        conn,
        "agents",
        "fallback_model_id",
        "ALTER TABLE agents ADD COLUMN fallback_model_id TEXT",
    )?;
    ensure_column(
        conn,
        "agents",
        "docker_image",
        "ALTER TABLE agents ADD COLUMN docker_image TEXT",
    )?;
    ensure_column(
        conn,
        "agents",
        "computer_environment",
        "ALTER TABLE agents ADD COLUMN computer_environment TEXT NOT NULL DEFAULT 'auto'",
    )?;
    ensure_column(
        conn,
        "agents",
        "memory_revision",
        "ALTER TABLE agents ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 0",
    )?;
    for (column, ddl) in [
        (
            "policy_rule",
            "ALTER TABLE computer_actions ADD COLUMN policy_rule TEXT",
        ),
        (
            "initiator",
            "ALTER TABLE computer_actions ADD COLUMN initiator TEXT",
        ),
        (
            "ended_at",
            "ALTER TABLE computer_actions ADD COLUMN ended_at INTEGER",
        ),
    ] {
        ensure_column(conn, "computer_actions", column, ddl)?;
    }
    ensure_column(conn, "computer_control", "needs_observation", "ALTER TABLE computer_control ADD COLUMN needs_observation INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "computer_control", "control_target", "ALTER TABLE computer_control ADD COLUMN control_target TEXT NOT NULL DEFAULT ''")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_agent_memories_agent \
         ON agent_memories(agent_id, pinned DESC, updated_at DESC);",
    )
    .context("falha ao criar o índice de memórias do agente")?;
    Ok(())
}

/// Migrates legacy emoji avatars into `avatar_json` and drops the old column.
/// Idempotent: new databases already have `avatar_json` and no `emoji`.
fn migrate_agents_avatar_schema(conn: &Connection) -> Result<()> {
    let has_emoji = table_columns(conn, "agents")?
        .iter()
        .any(|(name, _)| name == "emoji");
    ensure_column(
        conn,
        "agents",
        "avatar_json",
        "ALTER TABLE agents ADD COLUMN avatar_json TEXT",
    )?;
    if has_emoji {
        let rows = {
            let mut stmt =
                conn.prepare("SELECT id, emoji FROM agents WHERE avatar_json IS NULL")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (id, emoji) in rows {
            let avatar = crate::agents::AgentAvatar::emoji(emoji);
            conn.execute(
                "UPDATE agents SET avatar_json = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(&avatar)?],
            )?;
        }
        conn.execute("ALTER TABLE agents DROP COLUMN emoji", [])?;
    }
    let fallback = serde_json::to_string(&crate::agents::AgentAvatar::default())?;
    conn.execute(
        "UPDATE agents SET avatar_json = ?1 WHERE avatar_json IS NULL",
        params![fallback],
    )?;
    Ok(())
}

/// Migração aditiva e idempotente da tabela `usage_log`: bancos criados antes do
/// cache de prompt ganham as colunas de cache do §5.3 do plano. Nenhuma linha é
/// perdida; reabrir o banco não recria nada. As colunas novas são preenchidas
/// apenas por [`Db::record_usage_with_cache`] (e derivadas de `UsageInfo` em
/// [`Db::record_usage`]) — linhas antigas ficam com `NULL` ("não reportado").
fn migrate_usage_log_schema(conn: &Connection) -> Result<()> {
    const CACHE_COLUMNS: &[(&str, &str)] = &[
        (
            "cache_read_tokens",
            "ALTER TABLE usage_log ADD COLUMN cache_read_tokens INTEGER",
        ),
        (
            "cache_write_tokens",
            "ALTER TABLE usage_log ADD COLUMN cache_write_tokens INTEGER",
        ),
        (
            "uncached_input_tokens",
            "ALTER TABLE usage_log ADD COLUMN uncached_input_tokens INTEGER",
        ),
        (
            "cache_hit_percent",
            "ALTER TABLE usage_log ADD COLUMN cache_hit_percent REAL",
        ),
        (
            "cache_epoch",
            "ALTER TABLE usage_log ADD COLUMN cache_epoch INTEGER",
        ),
        (
            "prefix_hash",
            "ALTER TABLE usage_log ADD COLUMN prefix_hash TEXT",
        ),
        (
            "break_reason",
            "ALTER TABLE usage_log ADD COLUMN break_reason TEXT",
        ),
        ("protocol", "ALTER TABLE usage_log ADD COLUMN protocol TEXT"),
    ];
    for (column, ddl) in CACHE_COLUMNS {
        ensure_column(conn, "usage_log", column, ddl)?;
    }
    Ok(())
}

/// Migração aditiva e idempotente da tabela `cache_state`: bancos criados antes
/// do watermark do histórico do Chat (F2b) ganham `chat_cut_seq` (`NULL` =
/// histórico sem corte). Nenhuma linha é perdida; reabrir o banco não recria a
/// coluna.
fn migrate_cache_state_schema(conn: &Connection) -> Result<()> {
    ensure_column(
        conn,
        "cache_state",
        "chat_cut_seq",
        "ALTER TABLE cache_state ADD COLUMN chat_cut_seq INTEGER",
    )
}

/* ------------------------------------------------------------------ */
/* Enum <-> TEXT helpers                                               */
/* ------------------------------------------------------------------ */

fn role_to_str(role: MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
    }
}

fn role_from_str(raw: &str) -> MessageRole {
    match raw {
        "assistant" => MessageRole::Assistant,
        "system" => MessageRole::System,
        _ => MessageRole::User,
    }
}

fn status_to_str(status: MessageStatus) -> &'static str {
    match status {
        MessageStatus::Streaming => "streaming",
        MessageStatus::Complete => "complete",
        MessageStatus::Error => "error",
        MessageStatus::Cancelled => "cancelled",
        MessageStatus::Incomplete => "incomplete",
    }
}

fn status_from_str(raw: &str) -> MessageStatus {
    match raw {
        "streaming" => MessageStatus::Streaming,
        "error" => MessageStatus::Error,
        "cancelled" => MessageStatus::Cancelled,
        "incomplete" => MessageStatus::Incomplete,
        _ => MessageStatus::Complete,
    }
}

/// `TurnKind` <-> TEXT de `messages.origin`. Os slugs espelham o
/// `#[serde(rename_all = "snake_case")]` do contrato de IPC; valor desconhecido
/// (banco legado/corrompido) cai em `User`, a origem visualizada até hoje.
fn turn_kind_to_str(kind: TurnKind) -> &'static str {
    match kind {
        TurnKind::User => "user",
        TurnKind::GoalRound => "goal_round",
    }
}

fn turn_kind_from_str(raw: &str) -> TurnKind {
    match raw.trim().to_ascii_lowercase().as_str() {
        "goal_round" => TurnKind::GoalRound,
        _ => TurnKind::User,
    }
}

fn artifact_kind_to_str(kind: &ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::Markdown => "markdown",
        ArtifactKind::Code => "code",
        ArtifactKind::Text => "text",
        ArtifactKind::Html => "html",
        ArtifactKind::Csv => "csv",
        ArtifactKind::Json => "json",
        ArtifactKind::Svg => "svg",
        ArtifactKind::Image => "image",
        ArtifactKind::Pdf => "pdf",
        ArtifactKind::Docx => "docx",
        ArtifactKind::Xlsx => "xlsx",
        ArtifactKind::Pptx => "pptx",
        ArtifactKind::Audio => "audio",
        ArtifactKind::Video => "video",
        ArtifactKind::Archive => "archive",
        ArtifactKind::Binary => "binary",
    }
}

fn artifact_kind_from_str(raw: &str) -> ArtifactKind {
    match raw {
        "markdown" => ArtifactKind::Markdown,
        "code" => ArtifactKind::Code,
        "text" => ArtifactKind::Text,
        "html" => ArtifactKind::Html,
        "csv" => ArtifactKind::Csv,
        "json" => ArtifactKind::Json,
        "svg" => ArtifactKind::Svg,
        "image" => ArtifactKind::Image,
        "pdf" => ArtifactKind::Pdf,
        "docx" => ArtifactKind::Docx,
        "xlsx" => ArtifactKind::Xlsx,
        "pptx" => ArtifactKind::Pptx,
        "audio" => ArtifactKind::Audio,
        "video" => ArtifactKind::Video,
        "archive" => ArtifactKind::Archive,
        _ => ArtifactKind::Binary,
    }
}

/// `FileChangeKind` <-> TEXT do `file_journal.change_kind`.
fn file_change_kind_to_str(kind: FileChangeKind) -> &'static str {
    match kind {
        FileChangeKind::Created => "created",
        FileChangeKind::Modified => "modified",
        FileChangeKind::Deleted => "deleted",
        FileChangeKind::Renamed => "renamed",
    }
}

fn file_change_kind_from_str(raw: &str) -> FileChangeKind {
    match raw.trim().to_ascii_lowercase().as_str() {
        "created" => FileChangeKind::Created,
        "deleted" => FileChangeKind::Deleted,
        "renamed" => FileChangeKind::Renamed,
        _ => FileChangeKind::Modified,
    }
}

/// `ApprovalDecision` <-> TEXT de `approval_rules.decision`. Valor desconhecido
/// cai em `Denied` (regra persistida nunca vira permissão por engano).
fn approval_decision_from_str(raw: &str) -> ApprovalDecision {
    match raw.trim().to_ascii_lowercase().as_str() {
        "approved" => ApprovalDecision::Approved,
        "cancelled" => ApprovalDecision::Cancelled,
        "expired" => ApprovalDecision::Expired,
        _ => ApprovalDecision::Denied,
    }
}

/// `CacheState` <-> TEXT de `cache_samples.state` e `cache_state.last_*`. Os
/// slugs espelham o `#[serde(rename_all = "snake_case")]` do contrato de IPC.
/// Valor desconhecido cai em `Cold` (nunca promove um estado sem evidência).
fn cache_state_to_str(state: CacheState) -> &'static str {
    match state {
        CacheState::Cold => "cold",
        CacheState::Warming => "warming",
        CacheState::Stable => "stable",
        CacheState::Degraded => "degraded",
        CacheState::Unsupported => "unsupported",
        CacheState::ProviderPolicy => "provider_policy",
    }
}

fn cache_state_from_str(raw: &str) -> CacheState {
    match raw.trim().to_ascii_lowercase().as_str() {
        "warming" => CacheState::Warming,
        "stable" => CacheState::Stable,
        "degraded" => CacheState::Degraded,
        "unsupported" => CacheState::Unsupported,
        "provider_policy" => CacheState::ProviderPolicy,
        _ => CacheState::Cold,
    }
}

/// `CacheBreakReason` <-> TEXT de `cache_samples.break_reason` e
/// `cache_state.last_break_reason` (slugs snake_case do contrato).
fn cache_break_reason_to_str(reason: CacheBreakReason) -> &'static str {
    match reason {
        CacheBreakReason::FirstRequest => "first_request",
        CacheBreakReason::SystemPrompt => "system_prompt",
        CacheBreakReason::ToolDefinitions => "tool_definitions",
        CacheBreakReason::HistoryRewrite => "history_rewrite",
        CacheBreakReason::HeadTrim => "head_trim",
        CacheBreakReason::Compaction => "compaction",
        CacheBreakReason::ModelSwitch => "model_switch",
        CacheBreakReason::ProtocolFallback => "protocol_fallback",
        CacheBreakReason::Attachments => "attachments",
        CacheBreakReason::ConfigChange => "config_change",
        CacheBreakReason::PluginConfigChanged => "plugin_config_changed",
        CacheBreakReason::TtlExpired => "ttl_expired",
        CacheBreakReason::ProviderPolicy => "provider_policy",
    }
}

fn cache_break_reason_from_str(raw: &str) -> Option<CacheBreakReason> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "first_request" => Some(CacheBreakReason::FirstRequest),
        "system_prompt" => Some(CacheBreakReason::SystemPrompt),
        "tool_definitions" => Some(CacheBreakReason::ToolDefinitions),
        "history_rewrite" => Some(CacheBreakReason::HistoryRewrite),
        "head_trim" => Some(CacheBreakReason::HeadTrim),
        "compaction" => Some(CacheBreakReason::Compaction),
        "model_switch" => Some(CacheBreakReason::ModelSwitch),
        "protocol_fallback" => Some(CacheBreakReason::ProtocolFallback),
        "attachments" => Some(CacheBreakReason::Attachments),
        "config_change" => Some(CacheBreakReason::ConfigChange),
        "plugin_config_changed" => Some(CacheBreakReason::PluginConfigChanged),
        "ttl_expired" => Some(CacheBreakReason::TtlExpired),
        "provider_policy" => Some(CacheBreakReason::ProviderPolicy),
        _ => None,
    }
}

/// True when the error is a SQLite constraint violation (path de workspace
/// duplicado, id repetido, …), usado para devolver mensagens amigáveis.
fn is_constraint_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

/* ------------------------------------------------------------------ */
/* Small value helpers                                                 */
/* ------------------------------------------------------------------ */

/// ~120 characters of the first user text, used by the sidebar preview.
fn preview_from_text(content: &str) -> Option<String> {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed.chars().take(120).collect())
    }
}

/// Escape `LIKE` wildcards so user input is matched literally.
fn like_pattern(query: &str) -> String {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn u32_from_db(value: Option<i64>) -> Option<u32> {
    value.and_then(|v| u32::try_from(v).ok())
}

/// Soma agregada do SQL (`SUM` devolve `i64`) com clamp em `u32::MAX`.
fn u32_from_count(value: i64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn f32_from_db(value: Option<f64>) -> Option<f32> {
    value.map(|value| value as f32)
}

/// `Some(&str)` quando o texto (trim) não é vazio; usado para colunas nullable
/// que o domínio representa como `String` (turn/provider/model/protocol).
fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

/// Percentual `part / total * 100`; `None` quando não há denominador (nada
/// reportado, nenhuma amostra) — nunca inventa 100%.
fn percent_of(part: u32, total: u32) -> Option<f32> {
    (total > 0).then(|| (part as f64 / total as f64 * 100.0) as f32)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/* ------------------------------------------------------------------ */
/* Row mappers                                                         */
/* ------------------------------------------------------------------ */

fn conversation_from_row(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    let permission_mode: String = row.get(13)?;
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        provider_id: row.get(5)?,
        model_id: row.get(6)?,
        message_count: row.get(7)?,
        preview: row.get(8)?,
        mode: row.get(9)?,
        code_linked: row.get::<_, i64>(10)? != 0,
        // Sessões do harness de código. A migração aditiva preenche os bancos
        // legados com NULL/'zylara'/'edit'; o Chat ignora os três campos.
        workspace_id: row.get(11)?,
        agent_kind: row.get(12)?,
        permission_mode: PermissionMode::from_str(&permission_mode),
        parent_conversation_id: row.get(14)?,
        subagent_task_call_id: row.get(15)?,
        subagent_type: row.get(16)?,
        agent_id: row.get(17)?,
        channel_id: row.get(18)?,
        task_id: row.get(19)?,
        sort_order: row.get(20)?,
        is_main: row.get::<_, i64>(21)? != 0,
    })
}

fn agent_from_row(row: &Row<'_>) -> rusqlite::Result<Agent> {
    let reasoning_json: Option<String> = row.get(12)?;
    let starters_json: String = row.get(15)?;
    let capabilities_json: String = row.get(16)?;
    let avatar_json: Option<String> = row.get(4)?;
    let avatar = avatar_json
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_default();
    Ok(Agent {
        id: row.get(0)?,
        name: row.get(1)?,
        role: row.get(2)?,
        description: row.get(3)?,
        avatar,
        department: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        sort_order: row.get(7)?,
        provider_id: row.get(8)?,
        model_id: row.get(9)?,
        fallback_provider_id: row.get(10)?,
        fallback_model_id: row.get(11)?,
        reasoning: reasoning_json
            .as_deref()
            .and_then(|value| serde_json::from_str(value).ok()),
        instructions: row.get(13)?,
        prompt_version: row.get(14)?,
        starters: serde_json::from_str(&starters_json).unwrap_or_default(),
        capabilities: serde_json::from_str(&capabilities_json).unwrap_or_default(),
        memory_enabled: row.get::<_, i64>(17)? != 0,
        memory_revision: row.get(18)?,
        workspace_id: row.get(19)?,
        permission_mode: PermissionMode::from_str(&row.get::<_, String>(20)?),
        docker_image: row.get(21)?,
        computer_environment: crate::agents::normalize_computer_environment(
            &row.get::<_, String>(22)?,
        ),
        archived_at: row.get(23)?,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
        thread_count: row.get(26)?,
        last_active_at: row.get(27)?,
    })
}

fn agent_memory_from_row(row: &Row<'_>) -> rusqlite::Result<AgentMemory> {
    Ok(AgentMemory {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        kind: row.get(2)?,
        content: row.get(3)?,
        source_conversation_id: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn agent_routine_from_row(row: &Row<'_>) -> rusqlite::Result<AgentRoutine> {
    Ok(AgentRoutine {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        title: row.get(2)?,
        prompt: row.get(3)?,
        schedule_kind: row.get(4)?,
        interval_minutes: row.get(5)?,
        hour: row.get::<_, i64>(6)?.clamp(0, 23) as u32,
        minute: row.get::<_, i64>(7)?.clamp(0, 59) as u32,
        enabled: row.get::<_, i64>(8)? != 0,
        conversation_id: row.get(9)?,
        next_run_at: row.get(10)?,
        last_run_at: row.get(11)?,
        last_status: row.get(12)?,
        last_error: row.get(13)?,
        trigger_kind: row.get(14)?,
        event_kind: row.get(15)?,
        event_filter_json: row.get(16)?,
        lease_until: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        days_of_week: row.get::<_, i64>(20)? as u32,
    })
}

fn agent_routine_queue_from_row(row: &Row<'_>) -> rusqlite::Result<AgentRoutineQueueItem> {
    Ok(AgentRoutineQueueItem {
        id: row.get(0)?,
        routine_id: row.get(1)?,
        agent_id: row.get(2)?,
        conversation_id: row.get(3)?,
        source: row.get(4)?,
        event_id: row.get(5)?,
        scheduled_for: row.get(6)?,
        status: row.get(7)?,
        error: row.get(8)?,
        created_at: row.get(9)?,
        started_at: row.get(10)?,
    })
}

fn agent_channel_message_from_row(row: &Row<'_>) -> rusqlite::Result<AgentChannelMessage> {
    Ok(AgentChannelMessage {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        role: row.get(2)?,
        agent_id: row.get(3)?,
        content: row.get(4)?,
        created_at: row.get(5)?,
        attachments: decode_json(&row.get::<_, String>(6)?),
    })
}

fn agent_inbox_item_from_row(row: &Row<'_>) -> rusqlite::Result<AgentInboxItem> {
    Ok(AgentInboxItem {
        id: row.get(0)?,
        recipient_agent_id: row.get(1)?,
        sender_agent_id: row.get(2)?,
        sender_user: row.get::<_, i64>(3)? != 0,
        channel_id: row.get(4)?,
        channel_name: row.get(5)?,
        message_id: row.get(6)?,
        sender_name: row.get(7)?,
        message_content: row.get(8)?,
        status: row.get(9)?,
        attempts: row.get(10)?,
        last_error: row.get(11)?,
        created_at: row.get(12)?,
        delivered_at: row.get(13)?,
    })
}

fn agent_event_from_row(row: &Row<'_>) -> rusqlite::Result<AgentEvent> {
    let payload: String = row.get(2)?;
    Ok(AgentEvent {
        id: row.get(0)?,
        kind: row.get(1)?,
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        source_agent_id: row.get(3)?,
        channel_id: row.get(4)?,
        task_id: row.get(5)?,
        created_at: row.get(6)?,
        processed_at: row.get(7)?,
    })
}

fn agent_shared_memory_from_row(row: &Row<'_>) -> rusqlite::Result<AgentSharedMemory> {
    Ok(AgentSharedMemory {
        id: row.get(0)?,
        source_agent_id: row.get(1)?,
        source_agent_name: row.get(2)?,
        source_conversation_id: row.get(3)?,
        kind: row.get(4)?,
        content: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn computer_session_from_row(row: &Row<'_>) -> rusqlite::Result<ComputerSession> {
    Ok(ComputerSession {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        conversation_id: row.get(2)?,
        backend: row.get(3)?,
        status: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
    })
}

fn computer_action_from_row(row: &Row<'_>) -> rusqlite::Result<ComputerActionRecord> {
    let target: String = row.get(7)?;
    Ok(ComputerActionRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        agent_id: row.get(2)?,
        conversation_id: row.get(3)?,
        turn_id: row.get(4)?,
        tool: row.get(5)?,
        action: row.get(6)?,
        target: serde_json::from_str(&target).unwrap_or(serde_json::Value::Null),
        approval_scope: row.get(8)?,
        decision: row.get(9)?,
        result: row.get(10)?,
        error_code: row.get(11)?,
        error_message: row.get(12)?,
        redacted_text_len: row.get(13)?,
        policy_rule: row.get(14)?,
        initiator: row.get(15)?,
        created_at: row.get(16)?,
        ended_at: row.get(17)?,
    })
}

fn agent_task_from_row(row: &Row<'_>) -> rusqlite::Result<AgentTask> {
    let artifacts: String = row.get(20)?;
    Ok(AgentTask {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        parent_task_id: row.get(2)?,
        owner_agent_id: row.get(3)?,
        created_by_agent_id: row.get(4)?,
        created_by_user: row.get::<_, i64>(5)? != 0,
        title: row.get(6)?,
        brief: row.get(7)?,
        acceptance: row.get(8)?,
        status: row.get(9)?,
        priority: row.get(10)?,
        max_turns: row.get(11)?,
        max_tokens: row.get(12)?,
        max_cost: row.get(13)?,
        deadline_at: row.get(14)?,
        conversation_id: row.get(15)?,
        origin_conversation_id: row.get(16)?,
        workspace_id: row.get(17)?,
        retry_count: row.get(18)?,
        result: row.get(19)?,
        result_artifact_ids: serde_json::from_str(&artifacts).unwrap_or_default(),
        lease_until: row.get(21)?,
        handoff_count: row.get(22)?,
        version: row.get(23)?,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
    })
}

fn agent_task_event_from_row(row: &Row<'_>) -> rusqlite::Result<AgentTaskEvent> {
    let payload: String = row.get(5)?;
    Ok(AgentTaskEvent {
        id: row.get(0)?,
        task_id: row.get(1)?,
        from_status: row.get(2)?,
        to_status: row.get(3)?,
        actor: row.get(4)?,
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        created_at: row.get(6)?,
    })
}

fn workspace_from_row(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        last_opened_at: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        trusted: row.get::<_, i64>(7)? != 0,
        sort_order: row.get(8)?,
        // `git` é detectado em memória pelo módulo `workspace`; não é coluna.
        git: None,
    })
}

fn code_event_from_row(row: &Row<'_>) -> rusqlite::Result<StoredCodeEvent> {
    Ok(StoredCodeEvent {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        seq: row.get(3)?,
        kind: row.get(4)?,
        payload: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn file_journal_from_row(row: &Row<'_>) -> rusqlite::Result<FileJournalEntry> {
    let change_kind: String = row.get(4)?;
    Ok(FileJournalEntry {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        path: row.get(3)?,
        change_kind: file_change_kind_from_str(&change_kind),
        before_hash: row.get(5)?,
        after_hash: row.get(6)?,
        added: u32_from_db(row.get(7)?),
        removed: u32_from_db(row.get(8)?),
        created_at: row.get(9)?,
    })
}

fn session_summary_from_row(row: &Row<'_>) -> rusqlite::Result<SessionSummary> {
    Ok(SessionSummary {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        from_seq: row.get(2)?,
        to_seq: row.get(3)?,
        content: row.get(4)?,
        tokens: u32_from_db(row.get(5)?),
        created_at: row.get(6)?,
    })
}

/// Colunas de `cache_samples` lidas por [`cache_sample_from_row`] (a ordem
/// precisa bater com o mapper).
const CACHE_SAMPLE_COLUMNS: &str = "turn_id, step, provider_id, model_id, protocol, epoch, \
     input_total, cache_read, cache_write, uncached, hit_percent, ceiling_percent, \
     prefix_tokens_est, delta_tokens_est, eligible, excluded_reason, state, break_reason, \
     break_detail, raw_usage, created_at";

/// Colunas de `cache_state` lidas por [`cache_state_from_row`] (ordem do mapper).
const CACHE_STATE_COLUMNS: &str = "conversation_id, provider_id, model_id, protocol, epoch, \
     prefix_hash, prefix_segments, prompt_snapshot_hash, chat_cut_seq, cache_read, cache_write, \
     uncached, samples, last_hit_percent, last_ceiling_percent, last_at, last_break_reason, \
     last_break_detail, updated_at";

/// Colunas de `prompt_snapshots` lidas por [`prompt_snapshot_from_row`].
const PROMPT_SNAPSHOT_COLUMNS: &str = "conversation_id, snapshot_key, provider_id, model_id, \
     profile, workspace_id, prompt_version, system_text, tools_json, stable_hash, tools_hash, \
     created_at, invalidated_at";

/// Colunas de `surface_items` lidas por [`surface_item_from_row`].
const SURFACE_ITEM_COLUMNS: &str = "id, conversation_id, after_message_id, after_step, seq, \
     kind, digest, text, created_at";

fn surface_item_from_row(row: &Row<'_>) -> rusqlite::Result<SurfaceItemRecord> {
    Ok(SurfaceItemRecord {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        after_message_id: row.get(2)?,
        after_step: u32_from_db(row.get(3)?),
        seq: u32_from_count(row.get(4)?),
        kind: row.get(5)?,
        digest: row.get(6)?,
        text: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn cache_sample_from_row(row: &Row<'_>) -> rusqlite::Result<CacheSample> {
    let state: String = row.get(16)?;
    let break_reason: Option<String> = row.get(17)?;
    let raw_usage: Option<String> = row.get(19)?;
    Ok(CacheSample {
        turn_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
        step: u32_from_count(row.get(1)?),
        provider_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        model_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        protocol: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        epoch: u32_from_count(row.get(5)?),
        input_total: u32_from_db(row.get(6)?).unwrap_or(0),
        cache_read: u32_from_db(row.get(7)?).unwrap_or(0),
        cache_write: u32_from_db(row.get(8)?).unwrap_or(0),
        uncached: u32_from_db(row.get(9)?).unwrap_or(0),
        hit_percent: f32_from_db(row.get(10)?),
        ceiling_percent: f32_from_db(row.get(11)?),
        prefix_tokens_est: u32_from_db(row.get(12)?).unwrap_or(0),
        delta_tokens_est: u32_from_db(row.get(13)?).unwrap_or(0),
        eligible: row.get::<_, i64>(14)? != 0,
        excluded_reason: row.get(15)?,
        state: cache_state_from_str(&state),
        break_reason: break_reason.as_deref().and_then(cache_break_reason_from_str),
        break_detail: row.get(18)?,
        raw_usage: decode_opt_value(raw_usage),
        at: row.get(20)?,
    })
}

fn cache_state_from_row(row: &Row<'_>) -> rusqlite::Result<CacheStateRecord> {
    let last_break_reason: Option<String> = row.get(16)?;
    Ok(CacheStateRecord {
        conversation_id: row.get(0)?,
        provider_id: row.get(1)?,
        model_id: row.get(2)?,
        protocol: row.get(3)?,
        epoch: u32_from_count(row.get(4)?),
        prefix_hash: row.get(5)?,
        prefix_segments: decode_opt::<Vec<SegmentDigest>>(row.get(6)?),
        prompt_snapshot_hash: row.get(7)?,
        chat_cut_seq: u32_from_db(row.get(8)?),
        cache_read: u32_from_count(row.get(9)?),
        cache_write: u32_from_count(row.get(10)?),
        uncached: u32_from_count(row.get(11)?),
        samples: u32_from_count(row.get(12)?),
        last_hit_percent: f32_from_db(row.get(13)?),
        last_ceiling_percent: f32_from_db(row.get(14)?),
        last_at: row.get(15)?,
        last_break_reason: last_break_reason.as_deref().and_then(cache_break_reason_from_str),
        last_break_detail: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

fn prompt_snapshot_from_row(row: &Row<'_>) -> rusqlite::Result<PromptSnapshotRecord> {
    Ok(PromptSnapshotRecord {
        conversation_id: row.get(0)?,
        snapshot_key: row.get(1)?,
        provider_id: row.get(2)?,
        model_id: row.get(3)?,
        profile: row.get(4)?,
        workspace_id: row.get(5)?,
        prompt_version: row.get(6)?,
        system_text: row.get(7)?,
        tools_json: row.get(8)?,
        stable_hash: row.get(9)?,
        tools_hash: row.get(10)?,
        created_at: row.get(11)?,
        invalidated_at: row.get(12)?,
    })
}

fn render_decision_from_row(row: &Row<'_>) -> rusqlite::Result<RenderDecisionRecord> {
    Ok(RenderDecisionRecord {
        message_id: row.get(0)?,
        kind: row.get(1)?,
        digest: row.get(2)?,
        payload: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn approval_rule_from_row(row: &Row<'_>) -> rusqlite::Result<ApprovalRule> {
    let scope: String = row.get(1)?;
    let decision: String = row.get(6)?;
    Ok(ApprovalRule {
        id: row.get(0)?,
        scope: ApprovalScope::from_str(&scope),
        scope_id: row.get(2)?,
        tool: row.get(3)?,
        matcher: row.get(4)?,
        pattern: row.get(5)?,
        decision: approval_decision_from_str(&decision),
        created_at: row.get(7)?,
    })
}

fn message_from_row(row: &Row<'_>) -> rusqlite::Result<ChatMessage> {
    let role: String = row.get(2)?;
    let status: String = row.get(5)?;
    let tool_calls: String = row.get(6)?;
    let citations: String = row.get(7)?;
    let attachments: String = row.get(8)?;
    // `origin` é a última coluna de `MESSAGE_COLUMNS` (posição 15). Lida por
    // posição como o resto do mapper; o default do contrato cobre banco legado.
    let origin: String = row.get(15)?;
    Ok(ChatMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: role_from_str(&role),
        content: row.get(3)?,
        reasoning: row.get(4)?,
        status: status_from_str(&status),
        tool_calls: decode_json(&tool_calls),
        citations: decode_json(&citations),
        attachments: decode_json(&attachments),
        model_id: row.get(9)?,
        provider_id: row.get(10)?,
        usage: decode_opt::<UsageInfo>(row.get(11)?),
        created_at: row.get(13)?,
        provider_state: decode_opt_value(row.get(12)?),
        trace: decode_json(&row.get::<_, String>(14)?),
        origin: turn_kind_from_str(&origin),
        error: decode_opt::<crate::domain::MessageError>(row.get(16)?),
        resume_state: decode_opt::<crate::domain::ResumeState>(row.get(17)?),
    })
}

fn attachment_from_row(row: &Row<'_>) -> rusqlite::Result<StoredAttachment> {
    Ok(StoredAttachment {
        id: row.get(0)?,
        name: row.get(1)?,
        mime_type: row.get(2)?,
        size: row.get(3)?,
        kind: row.get(4)?,
        text: row.get(5)?,
        page_count: u32_from_db(row.get(6)?),
        width: u32_from_db(row.get(7)?),
        height: u32_from_db(row.get(8)?),
        file_path: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn artifact_from_row(row: &Row<'_>) -> rusqlite::Result<Artifact> {
    let kind: String = row.get(5)?;
    Ok(Artifact {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        message_id: row.get(2)?,
        name: row.get(3)?,
        mime_type: row.get(4)?,
        kind: artifact_kind_from_str(&kind),
        language: row.get(6)?,
        size: row.get(7)?,
        created_at: row.get(8)?,
        favorite: row.get::<_, i64>(9)? != 0,
    })
}

/// Lê um artefato pela PK com a conexão já travada (usado pelos updates que
/// devolvem o registro atualizado).
fn artifact_by_id(conn: &Connection, id: &str) -> anyhow::Result<Option<Artifact>> {
    let sql = format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1");
    conn.query_row(&sql, [id], |row| artifact_from_row(row))
        .optional()
        .context("falha ao ler artefato")
}

/* ------------------------------------------------------------------ */
/* Message persistence helpers                                         */
/* ------------------------------------------------------------------ */

struct MessageColumns {
    tool_calls: String,
    citations: String,
    attachments: String,
    usage: Option<String>,
    provider_state: Option<String>,
    trace: String,
    error: Option<String>,
    resume_state: Option<String>,
}

fn serialize_message(message: &ChatMessage) -> Result<MessageColumns> {
    Ok(MessageColumns {
        tool_calls: encode_json(&message.tool_calls)?,
        citations: encode_json(&message.citations)?,
        attachments: encode_json(&message.attachments)?,
        usage: message.usage.as_ref().map(encode_json).transpose()?,
        provider_state: message
            .provider_state
            .as_ref()
            .map(encode_json)
            .transpose()?,
        trace: encode_json(&message.trace)?,
        error: message.error.as_ref().map(encode_json).transpose()?,
        resume_state: message.resume_state.as_ref().map(encode_json).transpose()?,
    })
}

fn insert_message_row(
    conn: &Connection,
    message: &ChatMessage,
    cols: &MessageColumns,
) -> Result<()> {
    conn.execute(
        "INSERT INTO messages (id, conversation_id, role, content, reasoning, status, \
         tool_calls, citations, attachments, model_id, provider_id, usage, provider_state, \
         created_at, trace, origin, error, resume_state) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            &message.id,
            &message.conversation_id,
            role_to_str(message.role),
            &message.content,
            &message.reasoning,
            status_to_str(message.status),
            &cols.tool_calls,
            &cols.citations,
            &cols.attachments,
            &message.model_id,
            &message.provider_id,
            &cols.usage,
            &cols.provider_state,
            message.created_at,
            &cols.trace,
            turn_kind_to_str(message.origin),
            &cols.error,
            &cols.resume_state,
        ],
    )
    .with_context(|| format!("falha ao inserir mensagem {}", message.id))?;
    Ok(())
}

fn update_message_row(
    conn: &Connection,
    message: &ChatMessage,
    cols: &MessageColumns,
) -> Result<usize> {
    let changed = conn
        .execute(
            "UPDATE messages SET role = ?2, content = ?3, reasoning = ?4, status = ?5, \
             tool_calls = ?6, citations = ?7, attachments = ?8, model_id = ?9, \
             provider_id = ?10, usage = ?11, provider_state = ?12, created_at = ?13, \
             trace = ?14, origin = ?15, error = ?16, resume_state = ?17 \
             WHERE id = ?1",
            params![
                &message.id,
                role_to_str(message.role),
                &message.content,
                &message.reasoning,
                status_to_str(message.status),
                &cols.tool_calls,
                &cols.citations,
                &cols.attachments,
                &message.model_id,
                &message.provider_id,
                &cols.usage,
                &cols.provider_state,
                message.created_at,
                &cols.trace,
                turn_kind_to_str(message.origin),
                &cols.error,
                &cols.resume_state,
            ],
        )
        .with_context(|| format!("falha ao atualizar mensagem {}", message.id))?;
    Ok(changed)
}

/// Recomputes `message_count`, `updated_at` and `preview` for a conversation.
fn refresh_conversation_stats(conn: &Connection, conversation_id: &str) -> Result<()> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )
        .context("falha ao contar mensagens da conversa")?;
    let first_user_text: Option<String> = conn
        .query_row(
            "SELECT content FROM messages WHERE conversation_id = ?1 AND role = 'user' \
             AND TRIM(content) <> '' ORDER BY created_at, id LIMIT 1",
            [conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("falha ao ler a prévia da conversa")?;
    let preview = first_user_text.as_deref().and_then(preview_from_text);
    conn.execute(
        "UPDATE conversations SET message_count = ?2, updated_at = ?3, preview = ?4 \
         WHERE id = ?1",
        params![conversation_id, count, now_ms(), preview],
    )
    .context("falha ao atualizar estatísticas da conversa")?;
    Ok(())
}

/// Remove os órfãos do cache de prompt quando a cauda de mensagens a partir de
/// `message_id` (inclusive) é apagada: `render_decisions` e `surface_items`
/// ancorados nessas mensagens não têm mais onde entrar no replay. Roda na
/// transação de [`Db::delete_messages_from`], **antes** do DELETE das mensagens
/// (a posição da âncora é lida de `messages`). Idempotente: se a âncora já não
/// existe, só remove o que aponta diretamente para ela.
fn delete_cache_rows_from_message(
    conn: &Connection,
    conversation_id: &str,
    message_id: &str,
) -> Result<()> {
    let anchor_created_at: Option<i64> = conn
        .query_row(
            "SELECT created_at FROM messages WHERE id = ?1 AND conversation_id = ?2",
            params![message_id, conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("falha ao localizar a mensagem âncora da cauda")?;
    let Some(created_at) = anchor_created_at else {
        conn.execute(
            "DELETE FROM render_decisions WHERE message_id = ?1",
            [message_id],
        )
        .context("falha ao remover decisões de render órfãs")?;
        conn.execute(
            "DELETE FROM surface_items WHERE conversation_id = ?1 AND after_message_id = ?2",
            params![conversation_id, message_id],
        )
        .context("falha ao remover itens de superfície órfãos")?;
        return Ok(());
    };
    // Mesma ordem usada em `delete_messages_from`: `(created_at, id)`.
    conn.execute(
        "DELETE FROM render_decisions WHERE message_id IN (\
           SELECT id FROM messages WHERE conversation_id = ?1 \
             AND (created_at > ?2 OR (created_at = ?2 AND id >= ?3)))",
        params![conversation_id, created_at, message_id],
    )
    .context("falha ao remover decisões de render da cauda")?;
    conn.execute(
        "DELETE FROM surface_items WHERE conversation_id = ?1 AND after_message_id IN (\
           SELECT id FROM messages WHERE conversation_id = ?1 \
             AND (created_at > ?2 OR (created_at = ?2 AND id >= ?3)))",
        params![conversation_id, created_at, message_id],
    )
    .context("falha ao remover itens de superfície da cauda")?;
    Ok(())
}

/// Best-effort removal of an artifact file and its `<artifact-id>` folder.
/// Only directories that look like `.../artifacts/<id>` are removed.
pub(crate) fn remove_artifact_files(artifact_id: &str, path: &str) {
    let artifact_path = Path::new(path);
    let removed = std::fs::remove_file(artifact_path).is_ok();
    if !removed {
        return;
    }
    let Some(parent) = artifact_path.parent() else {
        return;
    };
    let looks_like_artifact_dir = parent
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name == artifact_id)
        .unwrap_or(false)
        && artifact_path
            .components()
            .any(|part| part.as_os_str() == "artifacts");
    if looks_like_artifact_dir {
        let _ = std::fs::remove_dir_all(parent);
    }
}

/// Adds the manual sidebar position to `workspaces` on databases created
/// before drag-and-drop. New databases already have it from `SCHEMA`.
fn migrate_workspaces_schema(conn: &Connection) -> Result<()> {
    ensure_column(
        conn,
        "workspaces",
        "sort_order",
        "ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    )
}

/* ------------------------------------------------------------------ */
/* Agent main conversation helpers                                     */
/* ------------------------------------------------------------------ */

/// Inserts (or returns the existing) primary conversation for one agent.
/// The partial unique index makes concurrent `INSERT OR IGNORE`s safe.
fn insert_agent_main_conversation(
    conn: &Connection,
    agent_id: &str,
    provider_id: &str,
    model_id: &str,
    workspace_id: Option<&str>,
    permission_mode: &str,
    now: i64,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO conversations \
         (id, title, created_at, updated_at, pinned, sort_order, provider_id, model_id, \
          message_count, preview, mode, code_linked, workspace_id, agent_kind, permission_mode, \
          agent_id, is_main) \
         VALUES (?1, ?2, ?3, ?3, 1, 0, ?4, ?5, 0, NULL, ?6, 0, ?7, 'zylara', ?8, ?9, 1)",
        params![
            &id,
            crate::i18n::t("agents.threads.main"),
            now,
            provider_id,
            model_id,
            CONVERSATION_MODE_AGENT,
            workspace_id,
            permission_mode,
            agent_id,
        ],
    )
    .context("falha ao criar a conversa principal do agente")?;
    let main_id: Option<String> = conn
        .query_row(
            "SELECT id FROM conversations WHERE agent_id = ?1 AND is_main = 1 LIMIT 1",
            [agent_id],
            |row| row.get(0),
        )
        .optional()?;
    main_id.ok_or_else(|| anyhow::anyhow!("conversa principal do agente não encontrada"))
}

/// Creates an empty primary conversation for every agent that lacks one and
/// repoints routines to it. Used on open and after `reset`; idempotent.
fn backfill_agent_main_conversations(conn: &Connection) -> Result<()> {
    let now = now_ms();
    let agents: Vec<(String, String, String, Option<String>, String)> = {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.provider_id, a.model_id, a.workspace_id, a.permission_mode \
             FROM agents a \
             WHERE NOT EXISTS (SELECT 1 FROM conversations c \
               WHERE c.agent_id = a.id AND c.is_main = 1)",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (agent_id, provider_id, model_id, workspace_id, permission_mode) in agents {
        insert_agent_main_conversation(
            conn,
            &agent_id,
            &provider_id,
            &model_id,
            workspace_id.as_deref(),
            &permission_mode,
            now,
        )?;
    }
    conn.execute(
        "UPDATE conversations SET pinned = 1 WHERE is_main = 1",
        [],
    )
    .context("falha ao fixar as conversas principais")?;
    conn.execute(
        "UPDATE agent_routines SET conversation_id = \
         (SELECT c.id FROM conversations c \
          WHERE c.agent_id = agent_routines.agent_id AND c.is_main = 1 LIMIT 1) \
         WHERE EXISTS (SELECT 1 FROM conversations c \
           WHERE c.agent_id = agent_routines.agent_id AND c.is_main = 1)",
        [],
    )
    .context("falha ao apontar rotinas para a conversa principal")?;
    Ok(())
}

/// Resets queue items left in `running` by a previous process.
fn recover_agent_routine_queue(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE agent_routine_queue SET status = 'pending', started_at = NULL, \
         error = 'interrompida' WHERE status = 'running'",
        [],
    )
    .context("falha ao recuperar a fila de rotinas")?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Db                                                                  */
/* ------------------------------------------------------------------ */

pub struct Db {
    conn: parking_lot::Mutex<rusqlite::Connection>,
}

impl Db {
    /// Shared connection guard for subsystem modules that own their tables.
    /// Plugin persistence lives in `plugins/store_db.rs` so schema changes stay
    /// next to their consumers.
    pub(crate) fn connection(&self) -> parking_lot::MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock()
    }

    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).with_context(|| {
                    format!("falha ao criar diretório do banco: {}", parent.display())
                })?;
            }
        }
        let conn = Connection::open(path)
            .with_context(|| format!("falha ao abrir banco de dados: {}", path.display()))?;
        Self::init_connection(&conn)?;
        Ok(Self {
            conn: parking_lot::Mutex::new(conn),
        })
    }

    /// A `streaming` row can only be live inside one process; `init_connection`
    /// runs before any turn, so every leftover row is an interrupted turn. Keep
    /// the partial content, settle running tool calls and mark the message
    /// cancelled.
    ///
    /// A leftover row that has a resume point keeps it (the turn can continue
    /// from the exact step it stopped at); only the reason is rewritten to
    /// `app_closed` so the renderer explains what happened.
    fn recover_interrupted_messages(conn: &Connection) -> Result<()> {
        let mut stmt = conn.prepare(
            "SELECT id, tool_calls, resume_state FROM messages WHERE status = 'streaming'",
        )?;
        let rows: Vec<(String, String, Option<String>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let now = now_ms();
        for (id, raw, resume_state) in rows {
            let mut tool_calls: Vec<ToolCallRecord> = decode_json(&raw);
            let mut changed = false;
            for call in &mut tool_calls {
                if call.status == ToolCallStatus::Running {
                    call.status = ToolCallStatus::Error;
                    call.result = Some("Interrompida: o aplicativo foi fechado.".to_string());
                    call.finished_at = Some(now);
                    changed = true;
                }
            }
            let raw = if changed { encode_json(&tool_calls)? } else { raw };
            let resume_state = match decode_opt::<crate::domain::ResumeState>(resume_state) {
                Some(mut state) => {
                    state.reason = crate::domain::ResumeReason::AppClosed;
                    state.updated_at = now;
                    Some(encode_json(&state)?)
                }
                None => None,
            };
            conn.execute(
                "UPDATE messages SET status = 'cancelled', tool_calls = ?2, resume_state = ?3 \
                 WHERE id = ?1",
                params![id, raw, resume_state],
            )
            .context("falha ao reconciliar mensagem interrompida")?;
        }
        Ok(())
    }

    fn init_connection(conn: &Connection) -> Result<()> {
        conn.execute_batch(PRAGMAS)
            .context("falha ao configurar o SQLite (WAL/foreign keys)")?;
        conn.execute_batch(SCHEMA)
            .context("falha ao aplicar o schema do banco")?;
        // Databases created before the agent trace (and the goal origin) get
        // the columns on open; new databases already have them from `SCHEMA`.
        migrate_messages_schema(conn)?;
        // Separação Chat/Code: conversas antigas viram mode='chat', sem vínculo.
        migrate_conversations_schema(conn)?;
        // Cada persona existente ganha uma conversa principal vazia e as
        // rotinas passam a apontar para ela (idempotente a cada boot).
        backfill_agent_main_conversations(conn)?;
        // Fila de rotinas: itens interrompidos por um fechamento voltam a pending.
        recover_agent_routine_queue(conn)?;
        // Ordem manual da sidebar de projetos: coluna aditiva em `workspaces`.
        migrate_workspaces_schema(conn)?;
        // Avatares: emoji legado vira `avatar_json` e a coluna antiga é removida.
        migrate_agents_avatar_schema(conn)?;
        // Biblioteca: `favorite` + `conversation_id` nullable (uploads do usuário).
        migrate_artifacts_schema(conn)?;
        // Canais: anexos por mensagem (coluna JSON aditiva).
        migrate_agent_channel_messages_schema(conn)?;
        // Cache de prompt: colunas aditivas em `usage_log` (as tabelas novas são
        // criadas pelo próprio `SCHEMA` com `IF NOT EXISTS`).
        migrate_usage_log_schema(conn)?;
        // Watermark do histórico do Chat: coluna aditiva em `cache_state` (F2b).
        migrate_cache_state_schema(conn)?;
        // Mensagens `streaming` de um processo morto: preserva o parcial e
        // fecha como canceladas (best-effort: falha não impede o boot).
        if let Err(error) = Self::recover_interrupted_messages(conn) {
            eprintln!("zylara: falha ao reconciliar mensagens interrompidas: {error:#}");
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory().context("falha ao abrir SQLite em memória")?;
        Self::init_connection(&conn)?;
        Ok(Self {
            conn: parking_lot::Mutex::new(conn),
        })
    }

    /* ---------------- conversations ---------------- */

    pub fn list_conversations(&self) -> anyhow::Result<Vec<Conversation>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations \
             WHERE parent_conversation_id IS NULL \
             ORDER BY is_main DESC, pinned DESC, sort_order ASC, updated_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| conversation_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar conversas")
    }

    /// Top-level conversations owned by an agent (main, extra threads, channel
    /// and task threads). Retained subagent transcripts are excluded: they are
    /// removed together with their parent.
    pub fn list_conversations_for_agent(
        &self,
        agent_id: &str,
    ) -> anyhow::Result<Vec<Conversation>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations \
             WHERE agent_id = ?1 AND parent_conversation_id IS NULL \
             ORDER BY is_main DESC, pinned DESC, sort_order ASC, updated_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([agent_id], |row| conversation_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar conversas do agente")
    }

    /* ---------------- agents ---------------- */

    fn agent_query(&self, id: Option<&str>, include_archived: bool) -> Result<Vec<Agent>> {
        let conn = self.conn.lock();
        let filter = if id.is_some() {
            "a.id = ?2"
        } else {
            "(?1 = 1 OR a.archived_at IS NULL)"
        };
        let sql = format!(
            "SELECT {AGENT_COLUMNS}, COUNT(c.id), MAX(c.updated_at) \
             FROM agents a LEFT JOIN conversations c \
               ON c.agent_id = a.id AND c.channel_id IS NULL AND c.task_id IS NULL \
             WHERE {filter} GROUP BY a.id \
             ORDER BY a.pinned DESC, \
             CASE WHEN a.pinned = 1 THEN '' ELSE a.department END COLLATE NOCASE, \
             a.sort_order, a.name COLLATE NOCASE"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = match id {
            Some(id) => stmt
                .query_map(params![include_archived as i64, id], agent_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            None => stmt
                .query_map(params![include_archived as i64], agent_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows)
    }

    pub fn list_agents(&self, include_archived: bool) -> Result<Vec<Agent>> {
        self.agent_query(None, include_archived)
            .context("falha ao listar agentes")
    }

    pub fn get_agent(&self, id: &str) -> Result<Option<Agent>> {
        Ok(self
            .agent_query(Some(id), true)
            .context("falha ao ler agente")?
            .into_iter()
            .next())
    }

    pub fn get_agent_main_conversation(&self, agent_id: &str) -> Result<Option<Conversation>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations \
             WHERE agent_id = ?1 AND is_main = 1 AND channel_id IS NULL LIMIT 1"
        ))?;
        let mut rows = stmt.query_map([agent_id], conversation_from_row)?;
        Ok(rows.next().transpose()?)
    }

    /// Returns the agent's primary conversation, creating it when a legacy or
    /// damaged database is missing one.
    pub fn ensure_agent_main_conversation(&self, agent_id: &str) -> Result<Conversation> {
        if let Some(conversation) = self.get_agent_main_conversation(agent_id)? {
            return Ok(conversation);
        }
        let agent = self
            .get_agent(agent_id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{agent_id}` não existe"))?;
        {
            let conn = self.conn.lock();
            insert_agent_main_conversation(
                &conn,
                agent_id,
                &agent.provider_id,
                &agent.model_id,
                agent.workspace_id.as_deref(),
                agent.permission_mode.as_str(),
                now_ms(),
            )?;
        }
        self.get_agent_main_conversation(agent_id)?
            .ok_or_else(|| anyhow::anyhow!("conversa principal do agente não encontrada"))
    }

    pub fn create_agent(&self, input: &AgentInput) -> Result<Agent> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let reasoning = input
            .reasoning
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let starters = serde_json::to_string(&input.starters)?;
        let capabilities = serde_json::to_string(&input.capabilities)?;
        let avatar = serde_json::to_string(&input.avatar)?;
        {
            let conn = self.conn.lock();
            let tx = conn.unchecked_transaction()?;
            let sort_order: i64 = tx.query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM agents",
                [],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO agents (id, name, role, description, avatar_json, department, pinned, \
                 sort_order, provider_id, model_id, fallback_provider_id, fallback_model_id, \
                 reasoning_json, instructions, prompt_version, starters_json, capabilities_json, \
                 memory_enabled, workspace_id, permission_mode, docker_image, \
                 computer_environment, archived_at, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?15, ?16, ?17, ?18, ?19, ?20, NULL, ?21, ?21)",
                params![
                    &id,
                    &input.name,
                    &input.role,
                    &input.description,
                    &avatar,
                    &input.department,
                    sort_order,
                    &input.provider_id,
                    &input.model_id,
                    &input.fallback_provider_id,
                    &input.fallback_model_id,
                    reasoning,
                    &input.instructions,
                    starters,
                    capabilities,
                    input.memory_enabled as i64,
                    &input.workspace_id,
                    input.permission_mode.as_str(),
                    &input.docker_image,
                    &input.computer_environment,
                    now,
                ],
            )
            .context("falha ao criar agente")?;
            insert_agent_main_conversation(
                &tx,
                &id,
                &input.provider_id,
                &input.model_id,
                input.workspace_id.as_deref(),
                input.permission_mode.as_str(),
                now,
            )?;
            tx.commit()
                .context("falha ao confirmar a criação do agente")?;
        }
        self.get_agent(&id)?
            .ok_or_else(|| anyhow::anyhow!("agente recém-criado não encontrado"))
    }

    pub fn update_agent(&self, id: &str, input: &AgentInput) -> Result<Agent> {
        let current = self
            .get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))?;
        if current.is_archived() {
            return Err(anyhow::anyhow!(
                "AGENT_ARCHIVED: restaure o agente antes de editá-lo"
            ));
        }
        let next_version = if crate::agents::prompt_fields_changed(&current, input) {
            current.prompt_version + 1
        } else {
            current.prompt_version
        };
        let reasoning = input
            .reasoning
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let starters = serde_json::to_string(&input.starters)?;
        let capabilities = serde_json::to_string(&input.capabilities)?;
        let avatar = serde_json::to_string(&input.avatar)?;
        let memory_disabled = current.memory_enabled && !input.memory_enabled;
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agents SET name = ?2, role = ?3, description = ?4, avatar_json = ?5, \
             department = ?6, provider_id = ?7, model_id = ?8, fallback_provider_id = ?9, \
             fallback_model_id = ?10, reasoning_json = ?11, instructions = ?12, \
             prompt_version = ?13, starters_json = ?14, capabilities_json = ?15, \
             memory_enabled = ?16, workspace_id = ?17, permission_mode = ?18, \
             docker_image = ?19, computer_environment = ?20, updated_at = ?21 WHERE id = ?1",
            params![
                id,
                &input.name,
                &input.role,
                &input.description,
                &avatar,
                &input.department,
                &input.provider_id,
                &input.model_id,
                &input.fallback_provider_id,
                &input.fallback_model_id,
                reasoning,
                &input.instructions,
                next_version,
                starters,
                capabilities,
                input.memory_enabled as i64,
                &input.workspace_id,
                input.permission_mode.as_str(),
                &input.docker_image,
                &input.computer_environment,
                now_ms(),
            ],
        )
        .context("falha ao atualizar agente")?;
        // A principal vazia acompanha a persona até a primeira mensagem; depois
        // disso vale o congelamento normal de modelo/workspace/permissão.
        conn.execute(
            "UPDATE conversations SET provider_id = ?2, model_id = ?3, \
             workspace_id = ?4, permission_mode = ?5 \
             WHERE agent_id = ?1 AND is_main = 1 AND message_count = 0",
            params![
                id,
                &input.provider_id,
                &input.model_id,
                &input.workspace_id,
                input.permission_mode.as_str(),
            ],
        )
        .context("falha ao sincronizar a conversa principal")?;
        drop(conn);
        if memory_disabled {
            let _ = self.delete_agent_surface_items(id, "memory");
        }
        self.get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))
    }

    pub fn update_agent_avatar(
        &self,
        id: &str,
        avatar: &crate::agents::AgentAvatar,
    ) -> Result<Agent> {
        let current = self
            .get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))?;
        if current.is_archived() {
            return Err(anyhow::anyhow!(
                "AGENT_ARCHIVED: restaure o agente antes de editá-lo"
            ));
        }
        let json = serde_json::to_string(avatar)?;
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agents SET avatar_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, json, now_ms()],
        )
        .context("falha ao atualizar o avatar do agente")?;
        drop(conn);
        self.get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))
    }

    pub fn set_agent_pinned(&self, id: &str, pinned: bool) -> Result<Agent> {
        let current = self
            .get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))?;
        if current.is_archived() {
            return Err(anyhow::anyhow!(
                "AGENT_ARCHIVED: restaure o agente antes de fixá-lo"
            ));
        }
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agents SET pinned = ?2 WHERE id = ?1",
            params![id, pinned as i64],
        )
        .context("falha ao fixar agente")?;
        drop(conn);
        self.get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))
    }

    pub fn archive_agent(&self, id: &str) -> Result<Agent> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agents SET archived_at = COALESCE(archived_at, ?2), updated_at = ?2 \
             WHERE id = ?1",
            params![id, now_ms()],
        )?;
        conn.execute(
            "UPDATE agent_channels SET leader_agent_id = NULL WHERE leader_agent_id = ?1",
            [id],
        )?;
        conn.execute(
            "DELETE FROM agent_routine_queue WHERE agent_id = ?1 AND status = 'pending'",
            [id],
        )?;
        conn.execute(
            "UPDATE agent_routines SET last_status = NULL \
             WHERE agent_id = ?1 AND last_status = 'queued'",
            [id],
        )?;
        drop(conn);
        if changed == 0 {
            return Err(anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"));
        }
        self.get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))
    }

    pub fn restore_agent(&self, id: &str) -> Result<Agent> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agents SET archived_at = NULL, updated_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )?;
        drop(conn);
        if changed == 0 {
            return Err(anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"));
        }
        self.get_agent(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"))
    }

    pub fn delete_agent(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let archived_at: Option<Option<i64>> = tx
            .query_row(
                "SELECT archived_at FROM agents WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(archived_at) = archived_at else {
            return Err(anyhow::anyhow!("AGENT_NOT_FOUND: agente `{id}` não existe"));
        };
        // Hidden channel threads and the primary conversation do not block
        // deletion: the first are derived from the channel, the second is part
        // of the persona. Any other conversation (including task threads) does.
        // An archived agent is already inactive, so deletion is the explicit
        // "remove everything" step and takes its conversations with it.
        let threads: i64 = tx.query_row(
            "SELECT COUNT(*) FROM conversations WHERE agent_id = ?1 \
             AND channel_id IS NULL AND is_main = 0 \
             AND parent_conversation_id IS NULL",
            [id],
            |row| row.get(0),
        )?;
        if archived_at.is_none() && threads > 0 {
            return Err(anyhow::anyhow!(
                "AGENT_IN_USE: este agente tem {threads} conversas; arquive-o para manter o histórico"
            ));
        }
        let conversations: Vec<(String, bool)> = {
            let mut stmt = tx.prepare(
                "SELECT id, is_main FROM conversations WHERE agent_id = ?1 \
                 AND parent_conversation_id IS NULL",
            )?;
            let rows = stmt.query_map([id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute("DELETE FROM agent_channel_members WHERE agent_id = ?1", [id])?;
        tx.execute(
            "UPDATE agent_channels SET leader_agent_id = NULL WHERE leader_agent_id = ?1",
            [id],
        )?;
        tx.commit()?;
        drop(conn);
        for (conversation_id, is_main) in conversations {
            self.delete_conversation_inner(&conversation_id, is_main)?;
        }
        let conn = self.conn.lock();
        conn.execute("DELETE FROM agents WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Creates a conversation linked to an active agent. The model is frozen
    /// from the persona; the renderer cannot choose a different pair.
    pub fn create_agent_conversation(&self, agent_id: &str, title: &str) -> Result<Conversation> {
        self.create_agent_conversation_in_channel(agent_id, title, None)
    }

    /// Creates an agent thread, optionally owned by a shared channel.
    pub fn create_agent_conversation_in_channel(
        &self,
        agent_id: &str,
        title: &str,
        channel_id: Option<&str>,
    ) -> Result<Conversation> {
        let agent = self
            .get_agent(agent_id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_NOT_FOUND: agente `{agent_id}` não existe"))?;
        if agent.is_archived() {
            return Err(anyhow::anyhow!(
                "AGENT_ARCHIVED: restaure o agente antes de iniciar uma conversa"
            ));
        }
        let title = title.trim();
        let title = if title.is_empty() {
            crate::i18n::t("common.defaultConversationTitle")
        } else {
            title.to_string()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        {
            let conn = self.conn.lock();
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at, pinned, \
                 provider_id, model_id, message_count, preview, mode, code_linked, workspace_id, \
                 agent_kind, permission_mode, agent_id, channel_id) \
                 VALUES (?1, ?2, ?3, ?3, 0, ?4, ?5, 0, NULL, ?6, 0, ?7, 'zylara', ?8, ?9, ?10)",
                params![
                    &id,
                    &title,
                    now,
                    &agent.provider_id,
                    &agent.model_id,
                    CONVERSATION_MODE_AGENT,
                    &agent.workspace_id,
                    agent.permission_mode.as_str(),
                    agent_id,
                    channel_id,
                ],
            )
            .context(crate::i18n::t("db.errors.createAgentConversation"))?;
        }
        self.get_conversation(&id)?
            .ok_or_else(|| anyhow::anyhow!("conversa do agente recém-criada não encontrada"))
    }

    pub fn list_agent_threads(
        &self,
        agent_id: &str,
        cursor: Option<&AgentThreadCursor>,
        limit: Option<u32>,
    ) -> Result<AgentThreadPage> {
        let limit = limit.unwrap_or(30).clamp(1, 100) as usize;
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations \
             WHERE agent_id = ?1 AND parent_conversation_id IS NULL AND channel_id IS NULL \
             AND task_id IS NULL \
             AND (?2 IS NULL OR updated_at < ?2 OR (updated_at = ?2 AND id < ?3)) \
             ORDER BY updated_at DESC, id DESC LIMIT ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![
                agent_id,
                cursor.map(|value| value.updated_at),
                cursor.map(|value| value.id.as_str()),
                (limit + 1) as i64,
            ],
            |row| conversation_from_row(row),
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        let next_cursor = if has_more {
            items.last().map(|conversation| AgentThreadCursor {
                updated_at: conversation.updated_at,
                id: conversation.id.clone(),
            })
        } else {
            None
        };
        Ok(AgentThreadPage {
            items,
            next_cursor,
            has_more,
        })
    }

    /* ---------------- agent memories ---------------- */

    pub fn list_agent_memories(&self, agent_id: &str) -> Result<Vec<AgentMemory>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, kind, content, source_conversation_id, pinned, \
             created_at, updated_at FROM agent_memories WHERE agent_id = ?1 \
             ORDER BY pinned DESC, updated_at DESC, id",
        )?;
        let rows = stmt.query_map([agent_id], agent_memory_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_agent_memory(
        &self,
        agent_id: &str,
        input: &AgentMemoryInput,
    ) -> Result<AgentMemory> {
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agents WHERE id = ?1",
            [agent_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_NOT_FOUND: agente `{agent_id}` não existe"
            ));
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_memories WHERE agent_id = ?1",
            [agent_id],
            |row| row.get(0),
        )?;
        if count >= crate::agents::AGENT_MEMORY_MAX_ITEMS as i64 {
            return Err(anyhow::anyhow!(
                "AGENT_MEMORY_LIMIT: este agente já tem {} memórias; apague algumas antes de salvar novas.",
                crate::agents::AGENT_MEMORY_MAX_ITEMS
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        conn.execute(
            "INSERT INTO agent_memories \
             (id, agent_id, kind, content, source_conversation_id, pinned, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                id,
                agent_id,
                input.kind,
                input.content,
                input.source_conversation_id,
                input.pinned as i64,
                now
            ],
        )
        .context("falha ao salvar memória do agente")?;
        conn.execute(
            "UPDATE agents SET memory_revision = memory_revision + 1, updated_at = ?2 \
             WHERE id = ?1",
            params![agent_id, now],
        )?;
        drop(conn);
        self.get_agent_memory(agent_id, &id)?
            .ok_or_else(|| anyhow::anyhow!("memória recém-criada não encontrada"))
    }

    pub fn get_agent_memory(
        &self,
        agent_id: &str,
        memory_id: &str,
    ) -> Result<Option<AgentMemory>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, kind, content, source_conversation_id, pinned, \
             created_at, updated_at FROM agent_memories WHERE agent_id = ?1 AND id = ?2",
        )?;
        let mut rows = stmt.query_map(params![agent_id, memory_id], agent_memory_from_row)?;
        Ok(rows.next().transpose()?)
    }

    pub fn update_agent_memory(
        &self,
        agent_id: &str,
        memory_id: &str,
        input: &AgentMemoryInput,
    ) -> Result<AgentMemory> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_memories SET kind = ?3, content = ?4, source_conversation_id = ?5, \
             pinned = ?6, updated_at = ?7 WHERE id = ?2 AND agent_id = ?1",
            params![
                agent_id,
                memory_id,
                input.kind,
                input.content,
                input.source_conversation_id,
                input.pinned as i64,
                now_ms()
            ],
        )?;
        if changed > 0 {
            conn.execute(
                "UPDATE agents SET memory_revision = memory_revision + 1, updated_at = ?2 \
                 WHERE id = ?1",
                params![agent_id, now_ms()],
            )?;
        }
        drop(conn);
        if changed == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_MEMORY_NOT_FOUND: memória `{memory_id}` não existe neste agente"
            ));
        }
        self.get_agent_memory(agent_id, memory_id)?
            .ok_or_else(|| anyhow::anyhow!("memória atualizada não encontrada"))
    }

    pub fn delete_agent_memory(&self, agent_id: &str, memory_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "DELETE FROM agent_memories WHERE id = ?2 AND agent_id = ?1",
            params![agent_id, memory_id],
        )?;
        if changed > 0 {
            conn.execute(
                "UPDATE agents SET memory_revision = memory_revision + 1, updated_at = ?2 \
                 WHERE id = ?1",
                params![agent_id, now_ms()],
            )?;
        }
        if changed == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_MEMORY_NOT_FOUND: memória `{memory_id}` não existe neste agente"
            ));
        }
        Ok(())
    }

    pub fn clear_agent_memories(&self, agent_id: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "DELETE FROM agent_memories WHERE agent_id = ?1",
            [agent_id],
        )?;
        if changed > 0 {
            conn.execute(
                "UPDATE agents SET memory_revision = memory_revision + 1, updated_at = ?2 \
                 WHERE id = ?1",
                params![agent_id, now_ms()],
            )?;
        }
        Ok(changed as u64)
    }

    pub fn list_agent_shared_memories(&self) -> Result<Vec<AgentSharedMemory>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.source_agent_id, s.name, m.source_conversation_id, m.kind, \
             m.content, m.pinned, m.created_at, m.updated_at \
             FROM agent_shared_memories m LEFT JOIN agents s ON s.id = m.source_agent_id \
             ORDER BY m.pinned DESC, m.updated_at DESC, m.id",
        )?;
        let rows = stmt.query_map([], agent_shared_memory_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_agent_shared_memory(&self, id: &str) -> Result<Option<AgentSharedMemory>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.source_agent_id, s.name, m.source_conversation_id, m.kind, \
             m.content, m.pinned, m.created_at, m.updated_at \
             FROM agent_shared_memories m LEFT JOIN agents s ON s.id = m.source_agent_id \
             WHERE m.id = ?1",
        )?;
        let mut rows = stmt.query_map([id], agent_shared_memory_from_row)?;
        Ok(rows.next().transpose()?)
    }

    pub fn create_agent_shared_memory(
        &self,
        source_agent_id: &str,
        input: &AgentMemoryInput,
    ) -> Result<AgentSharedMemory> {
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agents WHERE id = ?1 AND archived_at IS NULL",
            [source_agent_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_NOT_FOUND: agente `{source_agent_id}` não existe ou está arquivado"
            ));
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_shared_memories",
            [],
            |row| row.get(0),
        )?;
        if count >= crate::agents::AGENT_MEMORY_MAX_ITEMS as i64 {
            return Err(anyhow::anyhow!(
                "AGENT_MEMORY_LIMIT: já existem {} memórias compartilhadas; apague algumas antes de salvar novas.",
                crate::agents::AGENT_MEMORY_MAX_ITEMS
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        conn.execute(
            "INSERT INTO agent_shared_memories \
             (id, source_agent_id, source_conversation_id, kind, content, pinned, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                id,
                source_agent_id,
                input.source_conversation_id,
                input.kind,
                input.content,
                input.pinned as i64,
                now
            ],
        )
        .context("falha ao salvar memória compartilhada")?;
        drop(conn);
        self.get_agent_shared_memory(&id)?
            .ok_or_else(|| anyhow::anyhow!("memória compartilhada recém-criada não encontrada"))
    }

    pub fn update_agent_shared_memory(
        &self,
        id: &str,
        source_agent_id: &str,
        input: &AgentMemoryInput,
    ) -> Result<AgentSharedMemory> {
        let now = now_ms();
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_shared_memories SET kind = ?3, content = ?4, pinned = ?5, \
             source_conversation_id = ?6, updated_at = ?7 \
             WHERE id = ?1 AND source_agent_id = ?2",
            params![
                id,
                source_agent_id,
                input.kind,
                input.content,
                input.pinned as i64,
                input.source_conversation_id,
                now
            ],
        )?;
        drop(conn);
        if changed == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_MEMORY_FORBIDDEN: memória compartilhada não encontrada ou criada por outro agente"
            ));
        }
        self.get_agent_shared_memory(id)?
            .ok_or_else(|| anyhow::anyhow!("memória compartilhada atualizada não encontrada"))
    }

    pub fn delete_agent_shared_memory(&self, id: &str, source_agent_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "DELETE FROM agent_shared_memories WHERE id = ?1 AND source_agent_id = ?2",
            params![id, source_agent_id],
        )?;
        if changed == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_MEMORY_FORBIDDEN: memória compartilhada não encontrada ou criada por outro agente"
            ));
        }
        Ok(())
    }

    pub fn delete_shared_memory(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let changed = conn.execute("DELETE FROM agent_shared_memories WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(anyhow::anyhow!("AGENT_MEMORY_NOT_FOUND: memória compartilhada não existe"));
        }
        Ok(())
    }

    /// Removes volatile context items of one kind from every thread of an
    /// agent. Used when durable memory is disabled so old blocks stop being
    /// replayed.
    pub fn delete_agent_surface_items(&self, agent_id: &str, kind: &str) -> Result<u64> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "DELETE FROM surface_items WHERE kind = ?2 AND conversation_id IN \
             (SELECT id FROM conversations WHERE agent_id = ?1)",
            params![agent_id, kind],
        )?;
        Ok(changed as u64)
    }

    /* ---------------- agent usage ---------------- */

    fn agent_usage_from_row(row: &Row<'_>) -> rusqlite::Result<AgentUsage> {
        Ok(AgentUsage {
            agent_id: row.get(0)?,
            turns: row.get(1)?,
            input_tokens: row.get(2)?,
            output_tokens: row.get(3)?,
            reasoning_tokens: row.get(4)?,
            total_tokens: row.get(5)?,
            cost: row.get(6)?,
            last_used_at: row.get(7)?,
        })
    }

    /// Tokens/cost per agent across every conversation (normal, routine and
    /// hidden channel threads). `usage_log` has one row per turn.
    pub fn list_agent_usage(&self) -> Result<Vec<AgentUsage>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT c.agent_id, COUNT(u.id), \
             COALESCE(SUM(u.input_tokens), 0), COALESCE(SUM(u.output_tokens), 0), \
             COALESCE(SUM(u.reasoning_tokens), 0), COALESCE(SUM(u.total_tokens), 0), \
             COALESCE(SUM(u.cost), 0), MAX(u.created_at) \
             FROM usage_log u JOIN conversations c ON c.id = u.conversation_id \
             WHERE c.agent_id IS NOT NULL GROUP BY c.agent_id ORDER BY c.agent_id",
        )?;
        let rows = stmt.query_map([], Self::agent_usage_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_agent_usage(&self, agent_id: &str) -> Result<AgentUsage> {
        Ok(self
            .list_agent_usage()?
            .into_iter()
            .find(|usage| usage.agent_id == agent_id)
            .unwrap_or(AgentUsage {
                agent_id: agent_id.to_string(),
                ..AgentUsage::default()
            }))
    }

    /// Usage of one agent inside a time window. The daily budget uses local
    /// midnight, so a lifetime total can no longer block the agent forever.
    pub fn agent_usage_since(&self, agent_id: &str, since: i64) -> Result<AgentUsage> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT c.agent_id, COUNT(u.id), \
             COALESCE(SUM(u.input_tokens), 0), COALESCE(SUM(u.output_tokens), 0), \
             COALESCE(SUM(u.reasoning_tokens), 0), COALESCE(SUM(u.total_tokens), 0), \
             COALESCE(SUM(u.cost), 0), MAX(u.created_at) \
             FROM usage_log u JOIN conversations c ON c.id = u.conversation_id \
             WHERE c.agent_id = ?1 AND u.created_at >= ?2 GROUP BY c.agent_id",
        )?;
        let mut rows = stmt.query_map(params![agent_id, since], Self::agent_usage_from_row)?;
        Ok(rows.next().transpose()?.unwrap_or(AgentUsage {
            agent_id: agent_id.to_string(),
            ..AgentUsage::default()
        }))
    }

    /// Global billing/usage across every conversation. `since` is an optional
    /// lower bound in milliseconds (`None` = all time). `by_model` is ordered
    /// by turns (most used first), then tokens and ids for determinism;
    /// `by_day` groups by the machine's local day and is ordered oldest first.
    pub fn usage_stats(&self, since: Option<i64>) -> Result<UsageStats> {
        let conn = self.conn.lock();

        let totals = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), \
                 COALESCE(SUM(output_tokens), 0), COALESCE(SUM(reasoning_tokens), 0), \
                 COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost), 0.0), MAX(created_at) \
                 FROM usage_log WHERE (?1 IS NULL OR created_at >= ?1)",
                params![since],
                |row| {
                    Ok(UsageStatsTotals {
                        turns: row.get(0)?,
                        input_tokens: row.get(1)?,
                        output_tokens: row.get(2)?,
                        reasoning_tokens: row.get(3)?,
                        total_tokens: row.get(4)?,
                        cost: row.get(5)?,
                        last_used_at: row.get(6)?,
                    })
                },
            )
            .context("falha ao somar uso de tokens")?;

        let mut model_stmt = conn.prepare(
            "SELECT COALESCE(provider_id, ''), COALESCE(model_id, ''), COUNT(*), \
             COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost), 0.0) \
             FROM usage_log WHERE (?1 IS NULL OR created_at >= ?1) \
             GROUP BY provider_id, model_id \
             ORDER BY COUNT(*) DESC, COALESCE(SUM(total_tokens), 0) DESC, provider_id, model_id",
        )?;
        let by_model = model_stmt
            .query_map(params![since], |row| {
                Ok(ModelUsageStats {
                    provider_id: row.get(0)?,
                    model_id: row.get(1)?,
                    turns: row.get(2)?,
                    total_tokens: row.get(3)?,
                    cost: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao agrupar uso por modelo")?;

        let mut day_stmt = conn.prepare(
            "SELECT date(created_at / 1000, 'unixepoch', 'localtime'), \
             COALESCE(SUM(total_tokens), 0) \
             FROM usage_log WHERE (?1 IS NULL OR created_at >= ?1) \
             GROUP BY 1 ORDER BY 1 ASC",
        )?;
        let by_day = day_stmt
            .query_map(params![since], |row| {
                Ok(DailyUsageStats {
                    day: row.get(0)?,
                    total_tokens: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao agrupar uso por dia")?;

        Ok(UsageStats {
            totals,
            by_model,
            by_day,
        })
    }

    /* ---------------- computer-use audit ---------------- */

    pub fn get_or_create_computer_session(
        &self,
        agent_id: Option<&str>,
        conversation_id: &str,
        backend: &str,
        now: i64,
    ) -> Result<ComputerSession> {
        let conn = self.conn.lock();
        let existing = {
            let mut stmt = conn.prepare(
                "SELECT id, agent_id, conversation_id, backend, status, started_at, ended_at \
                 FROM computer_sessions WHERE conversation_id = ?1 AND backend = ?2 \
                 AND status = 'active' ORDER BY started_at DESC LIMIT 1",
            )?;
            let mut rows = stmt.query_map(params![conversation_id, backend], computer_session_from_row)?;
            rows.next().transpose()?
        };
        if let Some(session) = existing {
            return Ok(session);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO computer_sessions (id, agent_id, conversation_id, backend, status, \
             started_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5)",
            params![id, agent_id, conversation_id, backend, now],
        )?;
        drop(conn);
        Ok(ComputerSession {
            id,
            agent_id: agent_id.map(str::to_string),
            conversation_id: conversation_id.to_string(),
            backend: backend.to_string(),
            status: "active".to_string(),
            started_at: now,
            ended_at: None,
        })
    }

    pub fn end_computer_session(
        &self,
        conversation_id: &str,
        status: &str,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE computer_sessions SET status = ?2, ended_at = ?3 \
             WHERE conversation_id = ?1 AND status = 'active'",
            params![conversation_id, status, now],
        )?;
        Ok(())
    }

    pub fn end_all_computer_sessions(&self, status: &str, now: i64) -> Result<u64> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE computer_sessions SET status = ?1, ended_at = ?2 WHERE status = 'active'",
            params![status, now],
        )?;
        Ok(changed as u64)
    }

    /// Live pause/takeover state. Missing row means "not paused".
    pub fn computer_control(&self, conversation_id: &str) -> Result<(bool, bool)> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT paused, taken_over FROM computer_control WHERE conversation_id = ?1",
                [conversation_id],
                |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, i64>(1)? != 0)),
            )
            .optional()?;
        Ok(row.unwrap_or((false, false)))
    }

    pub fn computer_needs_observation(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.query_row("SELECT needs_observation FROM computer_control WHERE conversation_id = ?1", [conversation_id], |row| row.get::<_, i64>(0)).optional()?.unwrap_or(0) != 0)
    }

    pub fn computer_control_target(&self, conversation_id: &str) -> Result<String> {
        let conn = self.conn.lock();
        Ok(conn.query_row("SELECT control_target FROM computer_control WHERE conversation_id = ?1", [conversation_id], |row| row.get(0)).optional()?.unwrap_or_default())
    }

    pub fn set_computer_control_target(&self, conversation_id: &str, target: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("INSERT INTO computer_control (conversation_id, paused, taken_over, control_target, updated_at) VALUES (?1, 0, 0, ?2, ?3) ON CONFLICT(conversation_id) DO UPDATE SET control_target = excluded.control_target, updated_at = excluded.updated_at", params![conversation_id, target, crate::domain::now_ms()])?;
        Ok(())
    }

    pub fn set_computer_needs_observation(&self, conversation_id: &str, required: bool) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("INSERT INTO computer_control (conversation_id, paused, taken_over, needs_observation, updated_at) VALUES (?1, 0, 0, ?2, ?3) ON CONFLICT(conversation_id) DO UPDATE SET needs_observation = excluded.needs_observation, updated_at = excluded.updated_at", params![conversation_id, required as i64, crate::domain::now_ms()])?;
        Ok(())
    }

    pub fn set_computer_control(
        &self,
        conversation_id: &str,
        paused: Option<bool>,
        taken_over: Option<bool>,
        now: i64,
    ) -> Result<()> {
        let (current_paused, current_taken) = self.computer_control(conversation_id)?;
        let paused = paused.unwrap_or(current_paused);
        let taken_over = taken_over.unwrap_or(current_taken);
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO computer_control (conversation_id, paused, taken_over, updated_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(conversation_id) DO UPDATE SET paused = excluded.paused, \
             taken_over = excluded.taken_over, updated_at = excluded.updated_at",
            params![conversation_id, paused as i64, taken_over as i64, now],
        )?;
        Ok(())
    }

    pub fn reset_all_computer_controls(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE computer_control SET paused = CASE WHEN taken_over != 0 THEN 1 ELSE paused END, taken_over = 0, control_target = CASE WHEN conversation_id = ?2 THEN control_target ELSE '' END, updated_at = ?1",
            params![crate::domain::now_ms(), crate::computer::control::HOST_CONTROL],
        )?;
        Ok(changed as u64)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_computer_action(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
        conversation_id: &str,
        turn_id: &str,
        tool: &str,
        action: &str,
        target: &serde_json::Value,
        approval_scope: Option<&str>,
        decision: Option<&str>,
        result: &str,
        error_code: Option<&str>,
        error_message: Option<&str>,
        redacted_text_len: Option<i64>,
        now: i64,
    ) -> Result<ComputerActionRecord> {
        let id = uuid::Uuid::new_v4().to_string();
        let target_json = serde_json::to_string(target)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO computer_actions (id, session_id, agent_id, conversation_id, turn_id, \
             tool, action, target_json, approval_scope, decision, result, error_code, \
             error_message, redacted_text_len, policy_rule, initiator, created_at, ended_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, NULL, ?15, ?15)",
            params![
                id,
                session_id,
                agent_id,
                conversation_id,
                turn_id,
                tool,
                action,
                target_json,
                approval_scope,
                decision,
                result,
                error_code,
                error_message,
                redacted_text_len,
                now,
            ],
        )?;
        drop(conn);
        Ok(ComputerActionRecord {
            id,
            session_id: session_id.to_string(),
            agent_id: agent_id.map(str::to_string),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            tool: tool.to_string(),
            action: action.to_string(),
            target: target.clone(),
            approval_scope: approval_scope.map(str::to_string),
            decision: decision.map(str::to_string),
            result: result.to_string(),
            error_code: error_code.map(str::to_string),
            error_message: error_message.map(str::to_string),
            redacted_text_len,
            policy_rule: None,
            initiator: None,
            created_at: now,
            ended_at: Some(now),
        })
    }

    /// Inserts the pending audit row *before* the action runs. A crash leaves a
    /// visible `pending` row instead of losing the action; boot marks stale
    /// pending rows as `interrupted`.
    #[allow(clippy::too_many_arguments)]
    pub fn begin_computer_action(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
        conversation_id: &str,
        turn_id: &str,
        tool: &str,
        action: &str,
        target: &serde_json::Value,
        redacted_text_len: Option<i64>,
        initiator: &str,
        now: i64,
    ) -> Result<ComputerActionRecord> {
        let id = uuid::Uuid::new_v4().to_string();
        let target_json = serde_json::to_string(target)?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO computer_actions (id, session_id, agent_id, conversation_id, turn_id, \
             tool, action, target_json, approval_scope, decision, result, error_code, \
             error_message, redacted_text_len, policy_rule, initiator, created_at, ended_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, 'pending', NULL, NULL, ?9, \
             'computer.risk', ?10, ?11, NULL)",
            params![
                id,
                session_id,
                agent_id,
                conversation_id,
                turn_id,
                tool,
                action,
                target_json,
                redacted_text_len,
                initiator,
                now,
            ],
        )?;
        drop(conn);
        Ok(ComputerActionRecord {
            id,
            session_id: session_id.to_string(),
            agent_id: agent_id.map(str::to_string),
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            tool: tool.to_string(),
            action: action.to_string(),
            target: target.clone(),
            approval_scope: None,
            decision: None,
            result: "pending".to_string(),
            error_code: None,
            error_message: None,
            redacted_text_len,
            policy_rule: Some("computer.risk".to_string()),
            initiator: Some(initiator.to_string()),
            created_at: now,
            ended_at: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_computer_action(
        &self,
        id: &str,
        result: &str,
        error_code: Option<&str>,
        error_message: Option<&str>,
        decision: Option<&str>,
        approval_scope: Option<&str>,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE computer_actions SET result = ?2, error_code = ?3, error_message = ?4, \
             decision = ?5, approval_scope = COALESCE(?6, approval_scope), ended_at = ?7 \
             WHERE id = ?1",
            params![id, result, error_code, error_message, decision, approval_scope, now],
        )?;
        Ok(())
    }

    /// Boot reconciliation: rows left `pending` by a killed process are marked
    /// interrupted so the audit never hides an unknown outcome.
    pub fn interrupt_pending_computer_actions(&self, now: i64) -> Result<u64> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE computer_actions SET result = 'interrupted', ended_at = ?1 \
             WHERE result = 'pending'",
            [now],
        )?;
        Ok(changed as u64)
    }

    pub fn count_computer_actions_for_turn(&self, turn_id: &str) -> Result<i64> {
        let conn = self.conn.lock();
        let count = conn.query_row(
            "SELECT COUNT(*) FROM computer_actions WHERE turn_id = ?1",
            [turn_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    pub fn count_computer_actions_for_agent_since(
        &self,
        agent_id: &str,
        since: i64,
    ) -> Result<i64> {
        let conn = self.conn.lock();
        let count = conn.query_row(
            "SELECT COUNT(*) FROM computer_actions WHERE agent_id = ?1 AND created_at >= ?2",
            params![agent_id, since],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    pub fn list_computer_actions(
        &self,
        conversation_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<ComputerActionRecord>> {
        let limit = limit.unwrap_or(200).clamp(1, 500) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, agent_id, conversation_id, turn_id, tool, action, \
             target_json, approval_scope, decision, result, error_code, error_message, \
             redacted_text_len, policy_rule, initiator, created_at, ended_at FROM computer_actions \
             WHERE (?1 IS NULL OR conversation_id = ?1) \
             ORDER BY created_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![conversation_id, limit], computer_action_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_active_computer_sessions(&self) -> Result<Vec<ComputerSession>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, conversation_id, backend, status, started_at, ended_at \
             FROM computer_sessions WHERE status = 'active' ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map([], computer_session_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_computer_sessions(&self, conversation_id: &str) -> Result<Vec<ComputerSession>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, conversation_id, backend, status, started_at, ended_at \
             FROM computer_sessions WHERE conversation_id = ?1 ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map([conversation_id], computer_session_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /* ---------------- turn events (reattach) ---------------- */

    pub fn append_turn_event(
        &self,
        turn_id: &str,
        seq: u64,
        conversation_id: &str,
        event_json: &str,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO turn_events (turn_id, seq, conversation_id, event_json, \
             created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![turn_id, seq as i64, conversation_id, event_json, now],
        )?;
        Ok(())
    }

    pub fn list_turn_events(
        &self,
        turn_id: &str,
        after_seq: Option<u64>,
    ) -> Result<Vec<(u64, serde_json::Value)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT seq, event_json FROM turn_events WHERE turn_id = ?1 AND seq > ?2 \
             ORDER BY seq LIMIT 5000",
        )?;
        let rows = stmt.query_map(params![turn_id, after_seq.unwrap_or(0) as i64], |row| {
            Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?))
        })?;
        let mut events = Vec::new();
        for row in rows {
            let (seq, raw) = row?;
            if let Ok(value) = serde_json::from_str(&raw) {
                events.push((seq, value));
            }
        }
        Ok(events)
    }

    pub fn prune_turn_events(&self, before: i64) -> Result<u64> {
        let conn = self.conn.lock();
        let changed = conn.execute("DELETE FROM turn_events WHERE created_at < ?1", [before])?;
        Ok(changed as u64)
    }

    /* ---------------- agent tasks (delegation) ---------------- */

    fn task_open_statuses() -> &'static str {
        "'queued','accepted','running','waiting_input','waiting_approval','review'"
    }

    pub fn create_agent_task(
        &self,
        input: &AgentTaskInput,
        created_by_agent_id: Option<&str>,
        origin_conversation_id: Option<&str>,
        created_by_user: bool,
        now: i64,
    ) -> Result<AgentTask> {
        let conn = self.conn.lock();
        let owner_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agents WHERE id = ?1 AND archived_at IS NULL",
            [&input.to_agent_id],
            |row| row.get(0),
        )?;
        if owner_exists == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_INVALID: o agente `{}` não existe ou está arquivado",
                input.to_agent_id
            ));
        }
        if let Some(channel_id) = input.channel_id.as_deref() {
            let member: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agent_channel_members WHERE channel_id = ?1 AND agent_id = ?2",
                params![channel_id, input.to_agent_id],
                |row| row.get(0),
            )?;
            if member == 0 {
                return Err(anyhow::anyhow!(
                    "AGENT_TASK_INVALID: o agente destino não participa do canal"
                ));
            }
        }
        let open: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM agent_tasks WHERE owner_agent_id = ?1 \
                 AND status IN ({})",
                Self::task_open_statuses()
            ),
            [&input.to_agent_id],
            |row| row.get(0),
        )?;
        if open >= crate::agents::AGENT_TASK_MAX_OPEN_PER_AGENT {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_LIMIT: o agente já tem {} tarefas abertas; conclua ou cancele antes",
                crate::agents::AGENT_TASK_MAX_OPEN_PER_AGENT
            ));
        }
        if let Some(parent_id) = input.parent_task_id.as_deref() {
            let depth: i64 = conn.query_row(
                "WITH RECURSIVE ancestors(id, parent_task_id, depth) AS ( \
                   SELECT id, parent_task_id, 1 FROM agent_tasks WHERE id = ?1 \
                   UNION ALL \
                   SELECT t.id, t.parent_task_id, a.depth + 1 FROM agent_tasks t \
                     JOIN ancestors a ON t.id = a.parent_task_id \
                 ) SELECT COALESCE(MAX(depth), 0) FROM ancestors",
                [parent_id],
                |row| row.get(0),
            )?;
            let parent_exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agent_tasks WHERE id = ?1",
                [parent_id],
                |row| row.get(0),
            )?;
            if parent_exists == 0 {
                return Err(anyhow::anyhow!(
                    "AGENT_TASK_INVALID: a tarefa pai não existe"
                ));
            }
            if depth as usize >= crate::agents::AGENT_TASK_MAX_DEPTH {
                return Err(anyhow::anyhow!(
                    "AGENT_TASK_LIMIT: profundidade máxima de delegação ({}) atingida",
                    crate::agents::AGENT_TASK_MAX_DEPTH
                ));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let deadline_at = input
            .deadline_minutes
            .map(|minutes| now + i64::from(minutes) * 60_000);
        conn.execute(
            "INSERT INTO agent_tasks (id, channel_id, parent_task_id, owner_agent_id, \
             created_by_agent_id, created_by_user, title, brief, acceptance, status, priority, \
             max_turns, max_tokens, max_cost, deadline_at, conversation_id, \
             origin_conversation_id, workspace_id, retry_count, result, result_artifact_ids, \
             lease_until, handoff_count, version, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', 0, ?10, ?11, ?12, ?13, \
             NULL, ?15, ?16, 0, NULL, '[]', NULL, 0, 1, ?14, ?14)",
            params![
                id,
                input.channel_id,
                input.parent_task_id,
                input.to_agent_id,
                created_by_agent_id,
                created_by_user as i64,
                input.title,
                input.brief,
                input.acceptance,
                input.max_turns.unwrap_or(8) as i64,
                input.max_tokens.unwrap_or(100_000) as i64,
                input.max_cost.unwrap_or(1.0),
                deadline_at,
                now,
                origin_conversation_id,
                input.workspace_id,
            ],
        )
        .context("falha ao criar tarefa do agente")?;
        let event_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO agent_task_events (id, task_id, from_status, to_status, actor, \
             payload_json, created_at) VALUES (?1, ?2, NULL, 'queued', ?3, '{}', ?4)",
            params![
                event_id,
                id,
                if created_by_user { "user" } else { "agent" },
                now
            ],
        )?;
        conn.execute(
            "INSERT INTO agent_events \
             (id, kind, payload_json, source_agent_id, channel_id, task_id, created_at) \
             VALUES (?1, 'task.status', ?2, ?3, ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                serde_json::json!({
                    "taskId": id,
                    "title": input.title,
                    "status": "queued",
                    "ownerAgentId": input.to_agent_id,
                    "channelId": input.channel_id,
                })
                .to_string(),
                created_by_agent_id,
                input.channel_id,
                id,
                now
            ],
        )?;
        drop(conn);
        self.get_agent_task(&id)?
            .ok_or_else(|| anyhow::anyhow!("tarefa recém-criada não encontrada"))
    }

    pub fn get_agent_task(&self, id: &str) -> Result<Option<AgentTask>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks WHERE id = ?1"
        ))?;
        let mut rows = stmt.query_map([id], agent_task_from_row)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_agent_tasks(
        &self,
        status: Option<&str>,
        owner_agent_id: Option<&str>,
        channel_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<AgentTask>> {
        let limit = limit.unwrap_or(100).clamp(1, 500) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks \
             WHERE (?1 IS NULL OR status = ?1) \
               AND (?2 IS NULL OR owner_agent_id = ?2) \
               AND (?3 IS NULL OR channel_id = ?3) \
             ORDER BY priority DESC, created_at DESC LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params![status, owner_agent_id, channel_id, limit],
            agent_task_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Tasks visible to one agent inside its current context. A task is visible
    /// when the agent owns it, created it, or it belongs to the same channel.
    pub fn list_agent_tasks_visible(
        &self,
        agent_id: &str,
        channel_id: Option<&str>,
        status: Option<&str>,
        limit: u32,
    ) -> Result<Vec<AgentTask>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks \
             WHERE (owner_agent_id = ?1 OR created_by_agent_id = ?1 \
                    OR (?2 IS NOT NULL AND channel_id = ?2)) \
               AND (?3 IS NULL OR status = ?3) \
             ORDER BY priority DESC, created_at DESC LIMIT ?4"
        ))?;
        let rows = stmt.query_map(
            params![agent_id, channel_id, status, i64::from(limit.clamp(1, 200))],
            agent_task_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_queued_agent_tasks(&self, now: i64, limit: u32) -> Result<Vec<AgentTask>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks \
             WHERE status IN ('queued','accepted') \
               AND (deadline_at IS NULL OR deadline_at > ?1) \
             ORDER BY priority DESC, created_at, id LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![now, i64::from(limit.clamp(1, 50))], agent_task_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn count_open_agent_tasks(&self, owner_agent_id: &str) -> Result<i64> {
        let conn = self.conn.lock();
        let count = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM agent_tasks WHERE owner_agent_id = ?1 \
                 AND status IN ({})",
                Self::task_open_statuses()
            ),
            [owner_agent_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    pub fn set_agent_task_conversation(
        &self,
        task_id: &str,
        conversation_id: &str,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE agent_tasks SET conversation_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![task_id, conversation_id, now],
        )?;
        tx.execute(
            "UPDATE conversations SET task_id = ?1 WHERE id = ?2",
            params![task_id, conversation_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn claim_agent_task(&self, task_id: &str, now: i64) -> Result<AgentTask> {
        let conn = self.conn.lock();
        let current = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks WHERE id = ?1"
            ))?;
            let mut rows = stmt.query_map([task_id], agent_task_from_row)?;
            rows.next()
                .transpose()?
                .ok_or_else(|| anyhow::anyhow!("AGENT_TASK_NOT_FOUND: tarefa `{task_id}` não existe"))?
        };
        if !matches!(current.status.as_str(), "queued" | "accepted") {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_BUSY: a tarefa está em `{}`",
                current.status
            ));
        }
        if current.lease_until.is_some_and(|lease| lease > now) {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_BUSY: outro runner tem a tarefa até {}",
                current.lease_until.unwrap_or(0)
            ));
        }
        let version = current.version + 1;
        let lease = now + crate::agents::AGENT_TASK_LEASE_MS;
        let changed = conn.execute(
            "UPDATE agent_tasks SET status = 'running', lease_until = ?2, version = ?3, \
             updated_at = ?4 \
             WHERE id = ?1 AND version = ?5 AND status IN ('queued','accepted') \
             AND (lease_until IS NULL OR lease_until <= ?4)",
            params![task_id, lease, version, now, current.version],
        )?;
        if changed == 0 {
            return Err(anyhow::anyhow!("AGENT_TASK_BUSY: a tarefa foi reivindicada por outro runner"));
        }
        conn.execute(
            "INSERT INTO agent_task_events (id, task_id, from_status, to_status, actor, \
             payload_json, created_at) VALUES (?1, ?2, ?3, 'running', 'system', '{}', ?4)",
            params![
                uuid::Uuid::new_v4().to_string(),
                task_id,
                current.status,
                now
            ],
        )?;
        drop(conn);
        self.get_agent_task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("tarefa reivindicada não encontrada"))
    }

    /// Extends a running task lease. Returns false when the task is no longer
    /// running/owned by another runner (the caller should cancel its harness).
    pub fn renew_agent_task_lease(
        &self,
        task_id: &str,
        owner_agent_id: &str,
        now: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_tasks SET lease_until = ?3 \
             WHERE id = ?1 AND owner_agent_id = ?2 \
             AND status NOT IN ('done','cancelled','failed','declined')",
            params![
                task_id,
                owner_agent_id,
                now + crate::agents::AGENT_TASK_LEASE_MS
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn transition_agent_task(
        &self,
        task_id: &str,
        expected_version: Option<i64>,
        expected_owner: Option<&str>,
        to_status: &str,
        actor: &str,
        payload: serde_json::Value,
        result: Option<&str>,
        artifact_ids: Option<&[String]>,
        now: i64,
    ) -> Result<AgentTask> {
        let conn = self.conn.lock();
        let current = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks WHERE id = ?1"
            ))?;
            let mut rows = stmt.query_map([task_id], agent_task_from_row)?;
            rows.next()
                .transpose()?
                .ok_or_else(|| anyhow::anyhow!("AGENT_TASK_NOT_FOUND: tarefa `{task_id}` não existe"))?
        };
        if !crate::agents::task_transition_allowed(&current.status, to_status) {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_INVALID: transição `{}` → `{to_status}` não permitida",
                current.status
            ));
        }
        let terminal = matches!(to_status, "done" | "cancelled" | "failed" | "declined");
        let artifacts = artifact_ids
            .map(|ids| serde_json::to_string(ids))
            .transpose()?
            .unwrap_or_else(|| serde_json::to_string(&current.result_artifact_ids).unwrap_or_else(|_| "[]".to_string()));
        let changed = conn.execute(
            "UPDATE agent_tasks SET status = ?2, result = COALESCE(?3, result), \
             result_artifact_ids = ?4, lease_until = CASE WHEN ?5 THEN NULL ELSE lease_until END, \
             version = version + 1, updated_at = ?6 \
             WHERE id = ?1 AND (?7 IS NULL OR version = ?7) \
             AND (?8 IS NULL OR owner_agent_id = ?8)",
            params![
                task_id,
                to_status,
                result,
                artifacts,
                terminal as i64,
                now,
                expected_version,
                expected_owner
            ],
        )?;
        if changed == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_STALE: a tarefa mudou de dono/versão; recarregue antes de transicionar"
            ));
        }
        conn.execute(
            "INSERT INTO agent_task_events (id, task_id, from_status, to_status, actor, \
             payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                uuid::Uuid::new_v4().to_string(),
                task_id,
                current.status,
                to_status,
                actor,
                serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string()),
                now
            ],
        )?;
        conn.execute(
            "INSERT INTO agent_events \
             (id, kind, payload_json, source_agent_id, channel_id, task_id, created_at) \
             VALUES (?1, 'task.status', ?2, NULL, ?3, ?4, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                serde_json::json!({
                    "taskId": task_id,
                    "title": current.title,
                    "status": to_status,
                    "ownerAgentId": current.owner_agent_id,
                    "channelId": current.channel_id,
                })
                .to_string(),
                current.channel_id,
                task_id,
                now
            ],
        )?;
        drop(conn);
        self.get_agent_task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("tarefa atualizada não encontrada"))
    }

    pub fn retry_agent_task_once(
        &self,
        task_id: &str,
        owner_agent_id: &str,
        expected_version: i64,
        now: i64,
    ) -> Result<bool> {
        let updated = self.transition_agent_task(
            task_id,
            Some(expected_version),
            Some(owner_agent_id),
            "queued",
            "system",
            serde_json::json!({ "reason": "retry", "attempt": 2 }),
            None,
            None,
            now,
        )?;
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_tasks SET retry_count = retry_count + 1, updated_at = ?2 WHERE id = ?1",
            params![task_id, now],
        )?;
        Ok(updated.retry_count == 0)
    }

    pub fn handoff_agent_task(
        &self,
        task_id: &str,
        from_agent_id: &str,
        to_agent_id: &str,
        actor: &str,
        summary: &str,
        now: i64,
    ) -> Result<AgentTask> {
        let conn = self.conn.lock();
        let current = {
            let mut stmt = conn.prepare(&format!(
                "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks WHERE id = ?1"
            ))?;
            let mut rows = stmt.query_map([task_id], agent_task_from_row)?;
            rows.next()
                .transpose()?
                .ok_or_else(|| anyhow::anyhow!("AGENT_TASK_NOT_FOUND: tarefa `{task_id}` não existe"))?
        };
        if current.owner_agent_id != from_agent_id {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_BUSY: a tarefa não pertence mais a `{from_agent_id}`"
            ));
        }
        if to_agent_id == from_agent_id {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_INVALID: o destino do handoff deve ser outro agente"
            ));
        }
        if current.handoff_count >= crate::agents::AGENT_TASK_MAX_HANDOFFS {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_LIMIT: esta tarefa já teve {} handoffs",
                crate::agents::AGENT_TASK_MAX_HANDOFFS
            ));
        }
        if !matches!(
            current.status.as_str(),
            "accepted" | "running" | "waiting_input" | "waiting_approval" | "review"
        ) {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_INVALID: não é possível fazer handoff no estado `{}`",
                current.status
            ));
        }
        let target_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agents WHERE id = ?1 AND archived_at IS NULL",
            [to_agent_id],
            |row| row.get(0),
        )?;
        if target_exists == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_INVALID: o agente destino não existe ou está arquivado"
            ));
        }
        if let Some(channel_id) = current.channel_id.as_deref() {
            let member: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agent_channel_members WHERE channel_id = ?1 AND agent_id = ?2",
                params![channel_id, to_agent_id],
                |row| row.get(0),
            )?;
            if member == 0 {
                return Err(anyhow::anyhow!(
                    "AGENT_TASK_INVALID: o agente destino não participa do canal"
                ));
            }
        }
        let target_open: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM agent_tasks WHERE owner_agent_id = ?1 \
                 AND id != ?2 AND status IN ({})",
                Self::task_open_statuses()
            ),
            params![to_agent_id, task_id],
            |row| row.get(0),
        )?;
        if target_open >= crate::agents::AGENT_TASK_MAX_OPEN_PER_AGENT {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_LIMIT: o agente destino já tem {} tarefas abertas",
                crate::agents::AGENT_TASK_MAX_OPEN_PER_AGENT
            ));
        }
        let summary_section = format!("\n\n## Handoff\n{summary}");
        let changed = conn.execute(
            "UPDATE agent_tasks SET owner_agent_id = ?2, status = 'accepted', \
             conversation_id = NULL, lease_until = NULL, handoff_count = handoff_count + 1, \
             version = version + 1, updated_at = ?3, brief = brief || ?5 \
             WHERE id = ?1 AND owner_agent_id = ?4 AND version = ?6",
            params![
                task_id,
                to_agent_id,
                now,
                from_agent_id,
                summary_section,
                current.version
            ],
        )?;
        if changed == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_TASK_BUSY: a tarefa mudou durante o handoff; recarregue antes de tentar"
            ));
        }
        // The old thread belongs to the previous owner. Keep it as history but
        // detach it from the task so the new owner gets a fresh, correctly
        // bound conversation.
        conn.execute(
            "UPDATE conversations SET task_id = NULL WHERE task_id = ?1",
            [task_id],
        )?;
        conn.execute(
            "INSERT INTO agent_task_events (id, task_id, from_status, to_status, actor, \
             payload_json, created_at) VALUES (?1, ?2, ?3, 'accepted', ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                task_id,
                current.status,
                actor,
                serde_json::json!({
                    "handoff": true,
                    "fromAgentId": current.owner_agent_id,
                    "toAgentId": to_agent_id,
                    "summary": summary,
                })
                .to_string(),
                now
            ],
        )?;
        conn.execute(
            "INSERT INTO agent_events \
             (id, kind, payload_json, source_agent_id, channel_id, task_id, created_at) \
             VALUES (?1, 'task.status', ?2, ?3, ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                serde_json::json!({
                    "taskId": task_id,
                    "title": current.title,
                    "status": "accepted",
                    "ownerAgentId": to_agent_id,
                    "channelId": current.channel_id,
                })
                .to_string(),
                from_agent_id,
                current.channel_id,
                task_id,
                now
            ],
        )?;
        drop(conn);
        self.get_agent_task(task_id)?
            .ok_or_else(|| anyhow::anyhow!("tarefa com handoff não encontrada"))
    }

    /// Recovers tasks left behind by a crash, enforces deadlines and migrates
    /// legacy `handoff_pending` rows to the immediate-handoff model.
    pub fn sweep_agent_tasks(&self, now: i64) -> Result<Vec<AgentTask>> {
        let conn = self.conn.lock();
        let mut affected_ids: Vec<String> = Vec::new();
        {
            let mut stmt = conn.prepare(&format!(
                "SELECT {AGENT_TASK_COLUMNS} FROM agent_tasks \
                 WHERE status IN ('queued','accepted','running','handoff_pending')"
            ))?;
            let rows = stmt.query_map([], agent_task_from_row)?;
            for row in rows {
                let task = row?;
                if task.status == "handoff_pending" {
                    let version = task.version + 1;
                    let changed = conn.execute(
                        "UPDATE agent_tasks SET status = 'accepted', conversation_id = NULL, \
                         lease_until = NULL, version = ?2, updated_at = ?3 \
                         WHERE id = ?1 AND version = ?4",
                        params![task.id, version, now, task.version],
                    )?;
                    if changed > 0 {
                        conn.execute(
                            "UPDATE conversations SET task_id = NULL WHERE task_id = ?1",
                            [&task.id],
                        )?;
                        conn.execute(
                            "INSERT INTO agent_task_events (id, task_id, from_status, to_status, \
                             actor, payload_json, created_at) \
                             VALUES (?1, ?2, 'handoff_pending', 'accepted', 'system', \
                             '{\"migrated\":true}', ?3)",
                            params![uuid::Uuid::new_v4().to_string(), task.id, now],
                        )?;
                        affected_ids.push(task.id);
                    }
                    continue;
                }
                let expired = task.deadline_at.is_some_and(|deadline| deadline <= now);
                if matches!(task.status.as_str(), "queued" | "accepted") && expired {
                    let version = task.version + 1;
                    let changed = conn.execute(
                        "UPDATE agent_tasks SET status = 'failed', result = ?2, \
                         lease_until = NULL, version = ?3, updated_at = ?4 \
                         WHERE id = ?1 AND version = ?5",
                        params![
                            task.id,
                            "AGENT_TASK_DEADLINE",
                            version,
                            now,
                            task.version
                        ],
                    )?;
                    if changed > 0 {
                        conn.execute(
                            "INSERT INTO agent_task_events (id, task_id, from_status, to_status, \
                             actor, payload_json, created_at) \
                             VALUES (?1, ?2, ?3, 'failed', 'system', ?4, ?5)",
                            params![
                                uuid::Uuid::new_v4().to_string(),
                                task.id,
                                task.status,
                                serde_json::json!({ "error": "AGENT_TASK_DEADLINE" }).to_string(),
                                now
                            ],
                        )?;
                        affected_ids.push(task.id);
                    }
                    continue;
                }
                if task.status == "running"
                    && task.lease_until.is_some_and(|lease| lease < now)
                {
                    let version = task.version + 1;
                    let changed = conn.execute(
                        "UPDATE agent_tasks SET status = 'queued', lease_until = NULL, \
                         version = ?2, updated_at = ?3 WHERE id = ?1 AND version = ?4",
                        params![task.id, version, now, task.version],
                    )?;
                    if changed > 0 {
                        conn.execute(
                            "INSERT INTO agent_task_events (id, task_id, from_status, to_status, \
                             actor, payload_json, created_at) \
                             VALUES (?1, ?2, 'running', 'queued', 'system', \
                             '{\"recovered\":true}', ?3)",
                            params![uuid::Uuid::new_v4().to_string(), task.id, now],
                        )?;
                        affected_ids.push(task.id);
                    }
                }
            }
        }
        drop(conn);
        let mut affected = Vec::new();
        for id in affected_ids {
            if let Some(task) = self.get_agent_task(&id)? {
                affected.push(task);
            }
        }
        Ok(affected)
    }

    /// Closes routine runs that were interrupted by a crash or app exit.
    pub fn finish_interrupted_agent_routine_runs(&self, now: i64) -> Result<usize> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_routine_runs SET status = 'error', error = 'interrompida', \
             ended_at = ?1 WHERE status = 'running'",
            [now],
        )?;
        conn.execute(
            "UPDATE agent_routines SET last_status = 'error', last_error = 'interrompida', \
             updated_at = ?1 WHERE last_status = 'running'",
            [now],
        )?;
        Ok(changed)
    }

    /// True when a terminal result message for `task_id` already exists in the
    /// origin conversation. Makes result delivery idempotent across the runner
    /// and the user-facing cancel command.
    pub fn task_result_message_exists(&self, origin_conversation_id: &str, task_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1 AND role = 'system' \
             AND instr(content, ?2) > 0",
            params![origin_conversation_id, task_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn list_agent_task_events(&self, task_id: &str) -> Result<Vec<AgentTaskEvent>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, task_id, from_status, to_status, actor, payload_json, created_at \
             FROM agent_task_events WHERE task_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map([task_id], agent_task_event_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /* ---------------- agent routines ---------------- */

    pub fn list_agent_routines(&self, agent_id: &str) -> Result<Vec<AgentRoutine>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_ROUTINE_COLUMNS} FROM agent_routines WHERE agent_id = ?1 \
             ORDER BY created_at, id"
        ))?;
        let rows = stmt.query_map([agent_id], agent_routine_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every routine across agents, used by the central routines page.
    pub fn list_all_agent_routines(&self) -> Result<Vec<AgentRoutine>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_ROUTINE_COLUMNS} FROM agent_routines ORDER BY created_at, id"
        ))?;
        let rows = stmt.query_map([], agent_routine_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_agent_routine(&self, id: &str) -> Result<Option<AgentRoutine>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_ROUTINE_COLUMNS} FROM agent_routines WHERE id = ?1"
        ))?;
        let mut rows = stmt.query_map([id], agent_routine_from_row)?;
        Ok(rows.next().transpose()?)
    }

    pub fn create_agent_routine(
        &self,
        agent_id: &str,
        input: &AgentRoutineInput,
        now: i64,
    ) -> Result<AgentRoutine> {
        let main = self.ensure_agent_main_conversation(agent_id)?;
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agents WHERE id = ?1",
            [agent_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_NOT_FOUND: agente `{agent_id}` não existe"
            ));
        }
        let routine_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_routines WHERE agent_id = ?1",
            [agent_id],
            |row| row.get(0),
        )?;
        if routine_count >= crate::agents::AGENT_ROUTINE_MAX_PER_AGENT {
            return Err(anyhow::anyhow!(
                "AGENT_ROUTINE_LIMIT: este agente já tem {} rotinas",
                crate::agents::AGENT_ROUTINE_MAX_PER_AGENT
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let next = if input.trigger_kind == "event" {
            0
        } else {
            crate::agents::routine_next_run_at(
                &input.schedule_kind,
                input.interval_minutes,
                input.hour,
                input.minute,
                input.days_of_week,
                now,
            )
        };
        conn.execute(
            "INSERT INTO agent_routines \
             (id, agent_id, title, prompt, schedule_kind, interval_minutes, hour, minute, \
              enabled, conversation_id, next_run_at, last_run_at, last_status, last_error, \
              trigger_kind, event_kind, event_filter_json, lease_until, created_at, updated_at, \
              days_of_week) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, NULL, \
                     ?12, ?13, ?14, NULL, ?15, ?15, ?16)",
            params![
                id,
                agent_id,
                input.title,
                input.prompt,
                input.schedule_kind,
                input.interval_minutes,
                input.hour as i64,
                input.minute as i64,
                input.enabled as i64,
                main.id,
                next,
                input.trigger_kind,
                input.event_kind,
                input.event_filter_json,
                now,
                input.days_of_week as i64,
            ],
        )
        .context("falha ao criar rotina do agente")?;
        drop(conn);
        self.get_agent_routine(&id)?
            .ok_or_else(|| anyhow::anyhow!("rotina recém-criada não encontrada"))
    }

    pub fn update_agent_routine(
        &self,
        id: &str,
        input: &AgentRoutineInput,
        now: i64,
    ) -> Result<AgentRoutine> {
        let next = if input.trigger_kind == "event" {
            0
        } else {
            crate::agents::routine_next_run_at(
                &input.schedule_kind,
                input.interval_minutes,
                input.hour,
                input.minute,
                input.days_of_week,
                now,
            )
        };
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_routines SET title = ?2, prompt = ?3, schedule_kind = ?4, \
             interval_minutes = ?5, hour = ?6, minute = ?7, enabled = ?8, next_run_at = ?9, \
             trigger_kind = ?10, event_kind = ?11, event_filter_json = ?12, updated_at = ?13, \
             days_of_week = ?14 WHERE id = ?1",
            params![
                id,
                input.title,
                input.prompt,
                input.schedule_kind,
                input.interval_minutes,
                input.hour as i64,
                input.minute as i64,
                input.enabled as i64,
                next,
                input.trigger_kind,
                input.event_kind,
                input.event_filter_json,
                now,
                input.days_of_week as i64,
            ],
        )?;
        drop(conn);
        if changed == 0 {
            return Err(anyhow::anyhow!("AGENT_ROUTINE_NOT_FOUND: rotina `{id}` não existe"));
        }
        self.get_agent_routine(id)?
            .ok_or_else(|| anyhow::anyhow!("rotina atualizada não encontrada"))
    }

    pub fn set_agent_routine_enabled(
        &self,
        id: &str,
        enabled: bool,
        now: i64,
    ) -> Result<AgentRoutine> {
        let routine = self
            .get_agent_routine(id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_ROUTINE_NOT_FOUND: rotina `{id}` não existe"))?;
        let next = if routine.trigger_kind == "event" {
            0
        } else {
            crate::agents::routine_next_run_at(
                &routine.schedule_kind,
                routine.interval_minutes,
                routine.hour,
                routine.minute,
                routine.days_of_week,
                now,
            )
        };
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_routines SET enabled = ?2, next_run_at = ?3, updated_at = ?4 \
             WHERE id = ?1",
            params![id, enabled as i64, next, now],
        )?;
        if !enabled {
            conn.execute(
                "DELETE FROM agent_routine_queue WHERE routine_id = ?1 AND status = 'pending'",
                [id],
            )?;
            conn.execute(
                "UPDATE agent_routines SET last_status = NULL \
                 WHERE id = ?1 AND last_status = 'queued'",
                [id],
            )?;
        }
        drop(conn);
        self.get_agent_routine(id)?
            .ok_or_else(|| anyhow::anyhow!("rotina atualizada não encontrada"))
    }

    pub fn delete_agent_routine(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let changed = conn.execute("DELETE FROM agent_routines WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(anyhow::anyhow!("AGENT_ROUTINE_NOT_FOUND: rotina `{id}` não existe"));
        }
        Ok(())
    }

    pub fn enqueue_scheduled_agent_routine(
        &self,
        routine: &AgentRoutine,
        conversation_id: &str,
        scheduled_for: i64,
        next_run_at: i64,
        now: i64,
    ) -> Result<AgentRoutineQueueItem> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO agent_routine_queue \
             (id, routine_id, agent_id, conversation_id, source, event_id, scheduled_for, \
              status, error, created_at, started_at) \
             VALUES (?1, ?2, ?3, ?4, 'schedule', NULL, ?5, 'pending', NULL, ?6, NULL)",
            params![
                &id,
                &routine.id,
                &routine.agent_id,
                conversation_id,
                scheduled_for,
                now,
            ],
        )?;
        tx.execute(
            "UPDATE agent_routines SET next_run_at = ?2, last_status = 'queued', \
             last_error = NULL, updated_at = ?3 WHERE id = ?1",
            params![&routine.id, next_run_at, now],
        )?;
        tx.commit()?;
        drop(conn);
        Ok(AgentRoutineQueueItem {
            id,
            routine_id: routine.id.clone(),
            agent_id: routine.agent_id.clone(),
            conversation_id: conversation_id.to_string(),
            source: "schedule".to_string(),
            event_id: None,
            scheduled_for,
            status: "pending".to_string(),
            error: None,
            created_at: now,
            started_at: None,
        })
    }

    pub fn enqueue_agent_routine_run(
        &self,
        routine: &AgentRoutine,
        conversation_id: &str,
        source: &str,
        event_id: Option<&str>,
        scheduled_for: i64,
        now: i64,
    ) -> Result<AgentRoutineQueueItem> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO agent_routine_queue \
             (id, routine_id, agent_id, conversation_id, source, event_id, scheduled_for, \
              status, error, created_at, started_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', NULL, ?8, NULL)",
            params![
                &id,
                &routine.id,
                &routine.agent_id,
                conversation_id,
                source,
                event_id,
                scheduled_for,
                now,
            ],
        )?;
        tx.execute(
            "UPDATE agent_routines SET last_status = 'queued', last_error = NULL, \
             updated_at = ?2 WHERE id = ?1",
            params![&routine.id, now],
        )?;
        tx.commit()?;
        drop(conn);
        Ok(AgentRoutineQueueItem {
            id,
            routine_id: routine.id.clone(),
            agent_id: routine.agent_id.clone(),
            conversation_id: conversation_id.to_string(),
            source: source.to_string(),
            event_id: event_id.map(str::to_string),
            scheduled_for,
            status: "pending".to_string(),
            error: None,
            created_at: now,
            started_at: None,
        })
    }

    pub fn list_pending_agent_routine_queue(
        &self,
        limit: u32,
    ) -> Result<Vec<AgentRoutineQueueItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_ROUTINE_QUEUE_COLUMNS} FROM agent_routine_queue \
             WHERE status = 'pending' ORDER BY created_at, rowid LIMIT ?1"
        ))?;
        let rows = stmt.query_map([limit.clamp(1, 100) as i64], agent_routine_queue_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn claim_agent_routine_queue_item(&self, id: &str, now: i64) -> Result<bool> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_routine_queue SET status = 'running', started_at = ?2, error = NULL \
             WHERE id = ?1 AND status = 'pending'",
            params![id, now],
        )?;
        Ok(changed > 0)
    }

    pub fn release_agent_routine_queue_item(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_routine_queue SET status = 'pending', started_at = NULL, error = NULL \
             WHERE id = ?1 AND status = 'running'",
            [id],
        )?;
        Ok(())
    }

    pub fn finish_agent_routine_queue_item(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM agent_routine_queue WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn clear_agent_routine_pending_status(&self, routine_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_routines SET last_status = NULL \
             WHERE id = ?1 AND last_status IN ('queued', 'running')",
            [routine_id],
        )?;
        Ok(())
    }

    pub fn recover_agent_routine_queue(&self) -> Result<()> {
        let conn = self.conn.lock();
        recover_agent_routine_queue(&conn)
    }

    pub fn list_due_agent_routines(&self, now: i64) -> Result<Vec<AgentRoutine>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_ROUTINE_COLUMNS} FROM agent_routines \
             WHERE enabled = 1 AND trigger_kind = 'schedule' AND next_run_at <= ?1 \
             ORDER BY next_run_at, id LIMIT 8"
        ))?;
        let rows = stmt.query_map([now], agent_routine_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn mark_agent_routine_run(
        &self,
        id: &str,
        conversation_id: Option<&str>,
        status: &str,
        error: Option<&str>,
        next_run_at: i64,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_routines SET conversation_id = COALESCE(?2, conversation_id), \
             last_run_at = ?3, last_status = ?4, last_error = ?5, next_run_at = ?6, \
             updated_at = ?3 WHERE id = ?1",
            params![id, conversation_id, now, status, error, next_run_at],
        )?;
        Ok(())
    }

    pub fn start_agent_routine_run(
        &self,
        routine_id: &str,
        conversation_id: Option<&str>,
        now: i64,
    ) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO agent_routine_runs (id, routine_id, conversation_id, status, started_at) \
             VALUES (?1, ?2, ?3, 'running', ?4)",
            params![id, routine_id, conversation_id, now],
        )?;
        Ok(id)
    }

    pub fn finish_agent_routine_run(
        &self,
        run_id: &str,
        status: &str,
        error: Option<&str>,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_routine_runs SET status = ?2, error = ?3, ended_at = ?4 WHERE id = ?1",
            params![run_id, status, error, now],
        )?;
        Ok(())
    }

    pub fn list_agent_routine_runs(
        &self,
        routine_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<AgentRoutineRun>> {
        let limit = limit.unwrap_or(50).clamp(1, 200) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, routine_id, conversation_id, status, error, started_at, ended_at \
             FROM agent_routine_runs WHERE routine_id = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![routine_id, limit], |row| {
            Ok(AgentRoutineRun {
                id: row.get(0)?,
                routine_id: row.get(1)?,
                conversation_id: row.get(2)?,
                status: row.get(3)?,
                error: row.get(4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /* ---------------- agent channels ---------------- */

    fn channel_members(&self, channel_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT agent_id FROM agent_channel_members WHERE channel_id = ?1 ORDER BY agent_id",
        )?;
        let rows = stmt.query_map([channel_id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_agent_channels(&self) -> Result<Vec<AgentChannel>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.name, c.kind, c.created_at, c.updated_at, MAX(m.created_at), \
             c.sort_order, c.leader_agent_id \
             FROM agent_channels c LEFT JOIN agent_channel_messages m ON m.channel_id = c.id \
             GROUP BY c.id ORDER BY c.sort_order ASC, c.updated_at DESC, c.id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
        let base = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        let mut channels = Vec::with_capacity(base.len());
        for (id, name, kind, created_at, updated_at, last_message_at, sort_order, leader_agent_id) in
            base
        {
            channels.push(AgentChannel {
                member_ids: self.channel_members(&id)?,
                id,
                name,
                kind,
                leader_agent_id,
                sort_order,
                created_at,
                updated_at,
                last_message_at,
            });
        }
        Ok(channels)
    }

    pub fn get_agent_channel(&self, id: &str) -> Result<Option<AgentChannel>> {
        Ok(self
            .list_agent_channels()?
            .into_iter()
            .find(|channel| channel.id == id))
    }

    pub fn reorder_agent_channels(&self, ids: &[String]) -> anyhow::Result<()> {
        self.apply_sort_order("agent_channels", ids)
    }

    pub fn create_agent_channel(&self, input: &AgentChannelInput, now: i64) -> Result<AgentChannel> {
        let conn = self.conn.lock();
        for agent_id in &input.member_ids {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agents WHERE id = ?1 AND archived_at IS NULL",
                [agent_id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(anyhow::anyhow!(
                    "AGENT_CHANNEL_INVALID: agente `{agent_id}` não existe ou está arquivado"
                ));
            }
        }
        if let Some(leader) = input.leader_agent_id.as_deref() {
            if !input.member_ids.iter().any(|id| id == leader) {
                return Err(anyhow::anyhow!(
                    "AGENT_CHANNEL_INVALID: o líder precisa ser um membro do canal."
                ));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO agent_channels (id, name, leader_agent_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, input.name, input.leader_agent_id, now],
        )?;
        for agent_id in &input.member_ids {
            conn.execute(
                "INSERT INTO agent_channel_members (channel_id, agent_id) VALUES (?1, ?2)",
                params![id, agent_id],
            )?;
        }
        drop(conn);
        self.get_agent_channel(&id)?
            .ok_or_else(|| anyhow::anyhow!("canal recém-criado não encontrado"))
    }

    pub fn update_agent_channel(
        &self,
        id: &str,
        input: &AgentChannelInput,
        now: i64,
    ) -> Result<AgentChannel> {
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_channels WHERE id = ?1",
            [id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(anyhow::anyhow!("AGENT_CHANNEL_NOT_FOUND: canal `{id}` não existe"));
        }
        let kind: String = conn.query_row(
            "SELECT kind FROM agent_channels WHERE id = ?1",
            [id],
            |row| row.get(0),
        )?;
        if kind == "dm" {
            return Err(anyhow::anyhow!(
                "AGENT_CHANNEL_DM_READONLY: canais diretos não podem ser editados como canais"
            ));
        }
        for agent_id in &input.member_ids {
            let agent_exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agents WHERE id = ?1 AND archived_at IS NULL",
                [agent_id],
                |row| row.get(0),
            )?;
            if agent_exists == 0 {
                return Err(anyhow::anyhow!(
                    "AGENT_CHANNEL_INVALID: agente `{agent_id}` não existe ou está arquivado"
                ));
            }
        }
        if let Some(leader) = input.leader_agent_id.as_deref() {
            if !input.member_ids.iter().any(|id| id == leader) {
                return Err(anyhow::anyhow!(
                    "AGENT_CHANNEL_INVALID: o líder precisa ser um membro do canal."
                ));
            }
        }
        conn.execute(
            "UPDATE agent_channels SET name = ?2, leader_agent_id = ?3, updated_at = ?4 \
             WHERE id = ?1",
            params![id, input.name, input.leader_agent_id, now],
        )?;
        conn.execute("DELETE FROM agent_channel_members WHERE channel_id = ?1", [id])?;
        for agent_id in &input.member_ids {
            conn.execute(
                "INSERT INTO agent_channel_members (channel_id, agent_id) VALUES (?1, ?2)",
                params![id, agent_id],
            )?;
        }
        drop(conn);
        self.get_agent_channel(id)?
            .ok_or_else(|| anyhow::anyhow!("canal atualizado não encontrado"))
    }

    /// Returns the unique direct channel between two active agents, creating it
    /// (and both memberships) on first use.
    pub fn get_or_create_dm_channel(
        &self,
        first_agent_id: &str,
        second_agent_id: &str,
        now: i64,
    ) -> Result<AgentChannel> {
        if first_agent_id == second_agent_id {
            return Err(anyhow::anyhow!("AGENT_DM_SELF: não é possível conversar consigo mesmo"));
        }
        let mut conn = self.conn.lock();
        let first = conn
            .query_row(
                "SELECT name FROM agents WHERE id = ?1 AND archived_at IS NULL",
                [first_agent_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "AGENT_DM_INVALID: agente `{first_agent_id}` não existe ou está arquivado"
                )
            })?;
        let second = conn
            .query_row(
                "SELECT name FROM agents WHERE id = ?1 AND archived_at IS NULL",
                [second_agent_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "AGENT_DM_INVALID: agente `{second_agent_id}` não existe ou está arquivado"
                )
            })?;
        let (low, high) = if first_agent_id < second_agent_id {
            (first_agent_id, second_agent_id)
        } else {
            (second_agent_id, first_agent_id)
        };
        let dm_key = format!("{low}:{high}");
        let tx = conn.transaction()?;
        let existing = tx
            .query_row(
                "SELECT id FROM agent_channels WHERE dm_key = ?1",
                [&dm_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(id) = existing {
            tx.commit()?;
            drop(conn);
            return self
                .get_agent_channel(&id)?
                .ok_or_else(|| anyhow::anyhow!("AGENT_DM_INVALID: canal direto não encontrado"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let name: String = format!("DM · {first} ↔ {second}").chars().take(60).collect();
        tx.execute(
            "INSERT INTO agent_channels (id, name, kind, dm_key, created_at, updated_at) \
             VALUES (?1, ?2, 'dm', ?3, ?4, ?4)",
            params![id, name, dm_key, now],
        )?;
        for agent_id in [first_agent_id, second_agent_id] {
            tx.execute(
                "INSERT OR IGNORE INTO agent_channel_members (channel_id, agent_id) \
                 VALUES (?1, ?2)",
                params![id, agent_id],
            )?;
        }
        tx.commit()?;
        drop(conn);
        self.get_agent_channel(&id)?
            .ok_or_else(|| anyhow::anyhow!("AGENT_DM_INVALID: canal direto recém-criado não encontrado"))
    }

    pub fn enqueue_agent_inbox(
        &self,
        recipient_agent_id: &str,
        sender_agent_id: Option<&str>,
        channel_id: &str,
        message_id: &str,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agents WHERE id = ?1 AND archived_at IS NULL",
            [recipient_agent_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(anyhow::anyhow!(
                "AGENT_INBOX_INVALID: destinatário `{recipient_agent_id}` não existe ou está arquivado"
            ));
        }
        conn.execute(
            "INSERT OR IGNORE INTO agent_inbox \
             (id, recipient_agent_id, sender_agent_id, sender_user, channel_id, message_id, \
              status, attempts, created_at) \
             VALUES (?1, ?2, ?3, 0, ?4, ?5, 'pending', 0, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                recipient_agent_id,
                sender_agent_id,
                channel_id,
                message_id,
                now
            ],
        )
        .context("falha ao enfileirar mensagem direta")?;
        Ok(())
    }

    pub fn list_pending_agent_inbox(&self, limit: u32) -> Result<Vec<AgentInboxItem>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {AGENT_INBOX_ITEM_COLUMNS} FROM agent_inbox i \
             JOIN agent_channels c ON c.id = i.channel_id \
             JOIN agent_channel_messages m ON m.id = i.message_id \
             LEFT JOIN agents s ON s.id = i.sender_agent_id \
             WHERE i.status = 'pending' ORDER BY i.created_at, i.id LIMIT ?1"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([limit.clamp(1, 100) as i64], agent_inbox_item_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_agent_inbox(&self, agent_id: &str, limit: u32) -> Result<Vec<AgentInboxItem>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {AGENT_INBOX_ITEM_COLUMNS} FROM agent_inbox i \
             JOIN agent_channels c ON c.id = i.channel_id \
             JOIN agent_channel_messages m ON m.id = i.message_id \
             LEFT JOIN agents s ON s.id = i.sender_agent_id \
             WHERE i.recipient_agent_id = ?1 ORDER BY i.created_at DESC, i.id LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![agent_id, limit.clamp(1, 100) as i64],
            agent_inbox_item_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn claim_agent_inbox(&self, id: &str, now: i64) -> Result<bool> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_inbox SET status = 'delivering', claimed_at = ?2, \
             attempts = attempts + 1 WHERE id = ?1 AND status = 'pending'",
            params![id, now],
        )?;
        Ok(changed > 0)
    }

    pub fn requeue_agent_inbox(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_inbox SET status = 'pending', claimed_at = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn finish_agent_inbox(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
        now: i64,
    ) -> Result<()> {
        let delivered_at = (status == "delivered").then_some(now);
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_inbox SET status = ?2, last_error = ?3, claimed_at = NULL, \
             delivered_at = COALESCE(?4, delivered_at) WHERE id = ?1",
            params![id, status, error, delivered_at],
        )?;
        Ok(())
    }

    pub fn requeue_stale_agent_inbox(&self, before: i64) -> Result<usize> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_inbox SET status = 'pending', claimed_at = NULL \
             WHERE status = 'delivering' AND claimed_at IS NOT NULL AND claimed_at < ?1",
            [before],
        )?;
        Ok(changed)
    }

    pub fn list_channel_inbox_counts(&self) -> Result<Vec<AgentInboxCount>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT channel_id, COUNT(*) FROM agent_inbox \
             WHERE status = 'pending' GROUP BY channel_id ORDER BY channel_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AgentInboxCount {
                channel_id: row.get(0)?,
                pending: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_unprocessed_agent_events(&self, limit: u32) -> Result<Vec<AgentEvent>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, payload_json, source_agent_id, channel_id, task_id, \
             created_at, processed_at FROM agent_events \
             WHERE processed_at IS NULL ORDER BY created_at, id LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit.clamp(1, 100) as i64], agent_event_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_agent_event(&self, id: &str) -> Result<Option<AgentEvent>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, payload_json, source_agent_id, channel_id, task_id, \
             created_at, processed_at FROM agent_events WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([id], agent_event_from_row)?;
        Ok(rows.next().transpose()?)
    }

    pub fn mark_agent_event_processed(&self, id: &str, now: i64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_events SET processed_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn list_event_routines(&self, event_kind: &str) -> Result<Vec<AgentRoutine>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {AGENT_ROUTINE_COLUMNS} FROM agent_routines \
             WHERE enabled = 1 AND trigger_kind = 'event' AND event_kind = ?1 \
             ORDER BY created_at, id"
        ))?;
        let rows = stmt.query_map([event_kind], agent_routine_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn enqueue_event_deliveries(
        &self,
        event_id: &str,
        routine_ids: &[String],
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        for routine_id in routine_ids {
            conn.execute(
                "INSERT OR IGNORE INTO agent_event_deliveries \
                 (event_id, routine_id, status, created_at) VALUES (?1, ?2, 'pending', ?3)",
                params![event_id, routine_id, now],
            )?;
        }
        Ok(())
    }

    pub fn list_pending_event_deliveries(
        &self,
        limit: u32,
    ) -> Result<Vec<(AgentEvent, AgentRoutine)>> {
        let pairs: Vec<(String, String)> = {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare(
                "SELECT event_id, routine_id FROM agent_event_deliveries \
                 WHERE status = 'pending' ORDER BY created_at, event_id LIMIT ?1",
            )?;
            let rows = stmt.query_map([limit.clamp(1, 100) as i64], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut out = Vec::new();
        for (event_id, routine_id) in pairs {
            let Some(event) = self.get_agent_event(&event_id)? else {
                continue;
            };
            let Some(routine) = self.get_agent_routine(&routine_id)? else {
                continue;
            };
            out.push((event, routine));
        }
        Ok(out)
    }

    pub fn claim_event_delivery(
        &self,
        event_id: &str,
        routine_id: &str,
        now: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_event_deliveries SET status = 'running', started_at = ?3 \
             WHERE event_id = ?1 AND routine_id = ?2 AND status = 'pending'",
            params![event_id, routine_id, now],
        )?;
        Ok(changed > 0)
    }

    pub fn finish_event_delivery(
        &self,
        event_id: &str,
        routine_id: &str,
        status: &str,
        error: Option<&str>,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_event_deliveries SET status = ?3, error = ?4, ended_at = ?5 \
             WHERE event_id = ?1 AND routine_id = ?2",
            params![event_id, routine_id, status, error, now],
        )?;
        Ok(())
    }

    pub fn skip_old_agent_events(&self, before: i64, now: i64) -> Result<usize> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_event_deliveries SET status = 'skipped', ended_at = ?2 \
             WHERE status IN ('pending','running') AND event_id IN \
             (SELECT id FROM agent_events WHERE created_at < ?1)",
            params![before, now],
        )?;
        let changed = conn.execute(
            "UPDATE agent_events SET processed_at = ?2 \
             WHERE processed_at IS NULL AND created_at < ?1",
            params![before, now],
        )?;
        Ok(changed)
    }

    pub fn claim_due_agent_routines(
        &self,
        now: i64,
        limit: u32,
    ) -> Result<Vec<AgentRoutine>> {
        let ids: Vec<String> = {
            let conn = self.conn.lock();
            let mut stmt = conn.prepare(
                "SELECT id FROM agent_routines \
                 WHERE enabled = 1 AND trigger_kind = 'schedule' AND next_run_at <= ?1 \
                   AND (lease_until IS NULL OR lease_until < ?1) \
                 ORDER BY next_run_at, id LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![now, limit.clamp(1, 50) as i64], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut claimed = Vec::new();
        for id in ids {
            let conn = self.conn.lock();
            let changed = conn.execute(
                "UPDATE agent_routines SET lease_until = ?2 \
                 WHERE id = ?1 AND enabled = 1 AND trigger_kind = 'schedule' \
                   AND next_run_at <= ?3 AND (lease_until IS NULL OR lease_until < ?3)",
                params![id, now + 5 * 60 * 1000, now],
            )?;
            drop(conn);
            if changed > 0 {
                if let Some(routine) = self.get_agent_routine(&id)? {
                    claimed.push(routine);
                }
            }
        }
        Ok(claimed)
    }

    pub fn clear_agent_routine_lease(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_routines SET lease_until = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn sweep_agent_routine_leases(&self, now: i64) -> Result<usize> {
        let conn = self.conn.lock();
        let changed = conn.execute(
            "UPDATE agent_routines SET lease_until = NULL \
             WHERE lease_until IS NOT NULL AND lease_until < ?1",
            [now],
        )?;
        Ok(changed)
    }

    pub fn delete_agent_channel(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM agent_channels WHERE id = ?1", [id])?;
        // Hidden channel threads are useless without the channel; delete them
        // (and their messages through the existing cascade).
        let mut stmt = conn.prepare("SELECT id FROM conversations WHERE channel_id = ?1")?;
        let ids = stmt
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        for conversation_id in ids {
            let _ = self.delete_conversation(&conversation_id);
        }
        Ok(())
    }

    pub fn list_agent_channel_messages(
        &self,
        channel_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<AgentChannelMessage>> {
        let limit = limit.unwrap_or(200).clamp(1, 500) as i64;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, channel_id, role, agent_id, content, created_at, attachments \
             FROM agent_channel_messages WHERE channel_id = ?1 \
             ORDER BY created_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![channel_id, limit], agent_channel_message_from_row)?;
        let mut messages = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        messages.reverse();
        Ok(messages)
    }

    pub fn append_agent_channel_message(
        &self,
        channel_id: &str,
        role: &str,
        agent_id: Option<&str>,
        content: &str,
        attachments: &[AttachmentInfo],
        now: i64,
    ) -> Result<AgentChannelMessage> {
        let id = uuid::Uuid::new_v4().to_string();
        let attachments_json = serde_json::to_string(attachments).unwrap_or_else(|_| "[]".to_string());
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO agent_channel_messages \
             (id, channel_id, role, agent_id, content, created_at, attachments) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, channel_id, role, agent_id, content, now, attachments_json],
        )?;
        conn.execute(
            "UPDATE agent_channels SET updated_at = ?2 WHERE id = ?1",
            params![channel_id, now],
        )?;
        let preview: String = content.chars().take(16_000).collect();
        conn.execute(
            "INSERT INTO agent_events \
             (id, kind, payload_json, source_agent_id, channel_id, task_id, created_at) \
             VALUES (?1, 'channel.message', ?2, ?3, ?4, NULL, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                serde_json::json!({
                    "channelId": channel_id,
                    "messageId": id,
                    "role": role,
                    "agentId": agent_id,
                    "content": preview,
                })
                .to_string(),
                agent_id,
                channel_id,
                now
            ],
        )?;
        drop(conn);
        Ok(AgentChannelMessage {
            id,
            channel_id: channel_id.to_string(),
            role: role.to_string(),
            agent_id: agent_id.map(str::to_string),
            content: content.to_string(),
            attachments: attachments.to_vec(),
            created_at: now,
        })
    }

    /// Returns (creating when needed) the hidden thread of one agent inside a channel.
    pub fn get_or_create_channel_conversation(
        &self,
        channel_id: &str,
        agent_id: &str,
        title: &str,
    ) -> Result<crate::domain::Conversation> {
        use std::sync::LazyLock;
        static CHANNEL_THREAD_LOCK: LazyLock<parking_lot::Mutex<()>> =
            LazyLock::new(|| parking_lot::Mutex::new(()));
        let _guard = CHANNEL_THREAD_LOCK.lock();
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations \
             WHERE channel_id = ?1 AND agent_id = ?2 LIMIT 1"
        ))?;
        let mut rows = stmt.query_map(params![channel_id, agent_id], conversation_from_row)?;
        if let Some(row) = rows.next() {
            return Ok(row?);
        }
        drop(rows);
        drop(stmt);
        drop(conn);
        self.create_agent_conversation_in_channel(agent_id, title, Some(channel_id))
    }

    /// Cria uma conversa no layout padrão (Chat). Mantido como wrapper para os
    /// chamadores existentes (harness, tools e testes) — o modo explícito usa
    /// [`Db::create_conversation_with_mode`].
    pub fn create_conversation(
        &self,
        title: &str,
        provider_id: &str,
        model_id: &str,
    ) -> anyhow::Result<Conversation> {
        self.create_conversation_with_mode(title, provider_id, model_id, CONVERSATION_MODE_CHAT)
    }

    /// Cria uma conversa no layout `mode` (`"chat"` | `"code"`; qualquer outro
    /// valor, inclusive vazio, cai em `"chat"`). Sessões novas nunca nascem
    /// compartilhadas com o outro layout (`code_linked = 0`).
    ///
    /// Atalho para chamadores que não escolhem o modo de permissão (Chat e
    /// testes): grava [`PermissionMode::Edit`], o mesmo default da coluna.
    /// Sessões do Code criadas pela UI usam
    /// [`Db::create_conversation_with_mode_and_permission`] com o padrão
    /// configurado pelo usuário (`Settings::code_default_permission_mode`).
    pub fn create_conversation_with_mode(
        &self,
        title: &str,
        provider_id: &str,
        model_id: &str,
        mode: &str,
    ) -> anyhow::Result<Conversation> {
        self.create_conversation_with_mode_and_permission(
            title,
            provider_id,
            model_id,
            mode,
            PermissionMode::Edit,
        )
    }

    /// Cria uma conversa no layout `mode` já com o modo de permissão da sessão.
    ///
    /// O Chat ignora os modos; o comando `create_conversation` resolve o modo
    /// inicial das sessões do Code a partir de
    /// `Settings::code_default_permission_mode` (padrão: Autônomo).
    pub fn create_conversation_with_mode_and_permission(
        &self,
        title: &str,
        provider_id: &str,
        model_id: &str,
        mode: &str,
        permission_mode: PermissionMode,
    ) -> anyhow::Result<Conversation> {
        let mode = conversation_mode_or_default(Some(mode));
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let title = title.trim();
        let title = if title.is_empty() {
            "Nova conversa"
        } else {
            title
        };
        {
            let conn = self.conn.lock();
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at, pinned, \
                 provider_id, model_id, message_count, preview, mode, code_linked, permission_mode) \
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 0, NULL, ?7, 0, ?8)",
                params![
                    &id,
                    title,
                    now,
                    now,
                    provider_id,
                    model_id,
                    &mode,
                    permission_mode.as_str()
                ],
            )
            .context("falha ao criar conversa")?;
        }
        self.get_conversation(&id)?
            .ok_or_else(|| anyhow::anyhow!("conversa recém-criada não encontrada"))
    }

    /// Creates a retained, hidden subagent transcript for `parent_id`.
    ///
    /// The child is a normal Code conversation with `read_only` permission; it
    /// is filtered out of the sidebar and cascades when the parent is deleted.
    pub fn create_subagent_conversation(
        &self,
        title: &str,
        provider_id: &str,
        model_id: &str,
        parent_id: &str,
        task_call_id: &str,
        subagent_type: &str,
    ) -> anyhow::Result<Conversation> {
        let child = self.create_conversation_with_mode_and_permission(
            title,
            provider_id,
            model_id,
            CONVERSATION_MODE_CODE,
            PermissionMode::ReadOnly,
        )?;
        if let Err(error) =
            self.set_conversation_subagent_meta(&child.id, parent_id, task_call_id, subagent_type)
        {
            let _ = self.delete_conversation(&child.id);
            return Err(error);
        }
        self.get_conversation(&child.id)?
            .ok_or_else(|| anyhow::anyhow!("conversa de subagente não encontrada"))
    }

    /// Links an existing conversation to its parent subagent transcript.
    pub fn set_conversation_subagent_meta(
        &self,
        id: &str,
        parent_id: &str,
        task_call_id: &str,
        subagent_type: &str,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE conversations SET parent_conversation_id = ?2, \
                 subagent_task_call_id = ?3, subagent_type = ?4 WHERE id = ?1",
                params![id, parent_id, task_call_id, subagent_type],
            )
            .context("falha ao vincular a conversa ao subagente")?;
        if changed == 0 {
            return Err(anyhow::anyhow!("conversa não encontrada: {id}"));
        }
        Ok(())
    }

    /// Parent-visible list of retained subagent transcripts (newest first).
    pub fn list_subagent_conversations(
        &self,
        parent_id: &str,
    ) -> anyhow::Result<Vec<Conversation>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations \
             WHERE parent_conversation_id = ?1 ORDER BY created_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([parent_id], |row| conversation_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar os subagentes da conversa")
    }

    /// Compartilha (`linked = true`) ou remove o vínculo de uma sessão do Chat
    /// com o layout Code. Só sessões `mode == "chat"` podem ser compartilhadas:
    /// uma conversa criada no Code pertence somente ao Code.
    pub fn set_conversation_code_linked(
        &self,
        id: &str,
        linked: bool,
    ) -> anyhow::Result<Conversation> {
        let conversation = self
            .get_conversation(id)?
            .ok_or_else(|| anyhow::anyhow!("conversa não encontrada: {id}"))?;
        if conversation.mode != CONVERSATION_MODE_CHAT {
            return Err(anyhow::anyhow!(
                "somente sessões do Chat podem ser compartilhadas com o Code"
            ));
        }
        {
            let conn = self.conn.lock();
            conn.execute(
                "UPDATE conversations SET code_linked = ?2 WHERE id = ?1",
                params![id, if linked { 1i64 } else { 0i64 }],
            )
            .context("falha ao atualizar o vínculo da conversa com o Code")?;
        }
        self.get_conversation(id)?
            .ok_or_else(|| anyhow::anyhow!("conversa não encontrada: {id}"))
    }

    pub fn get_conversation(&self, id: &str) -> anyhow::Result<Option<Conversation>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?1");
        conn.query_row(&sql, [id], |row| conversation_from_row(row))
            .optional()
            .context("falha ao ler conversa")
    }

    pub fn get_conversation_detail(&self, id: &str) -> anyhow::Result<Option<ConversationDetail>> {
        let Some(conversation) = self.get_conversation(id)? else {
            return Ok(None);
        };
        let messages = self.list_messages(id)?;
        Ok(Some(ConversationDetail {
            conversation,
            messages,
        }))
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> anyhow::Result<()> {
        let title = title.trim();
        let title = if title.is_empty() {
            "Nova conversa"
        } else {
            title
        };
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE conversations SET title = ?2 WHERE id = ?1",
            params![id, title],
        )
        .context("falha ao renomear conversa")?;
        Ok(())
    }

    /// Deletes the conversation and all associated records (messages, artifacts,
    /// code harness, prompt cache and `usage_log`). Orphan Library attachments
    /// are preserved by product decision.
    pub fn delete_conversation(&self, id: &str) -> anyhow::Result<()> {
        self.delete_conversation_inner(id, false)
    }

    fn delete_conversation_inner(
        &self,
        id: &str,
        allow_main: bool,
    ) -> anyhow::Result<()> {
        if !allow_main {
            let conn = self.conn.lock();
            let is_main: Option<i64> = conn
                .query_row(
                    "SELECT is_main FROM conversations WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            if is_main == Some(1) {
                return Err(anyhow::anyhow!(
                    "CONVERSATION_MAIN: a conversa principal não pode ser excluída."
                ));
            }
        }
        // Retained subagent transcripts are children of this conversation and
        // must be deleted with it (they are hidden from the sidebar).
        let child_ids: Vec<String> = {
            let conn = self.conn.lock();
            let mut stmt =
                conn.prepare("SELECT id FROM conversations WHERE parent_conversation_id = ?1")?;
            let rows = stmt.query_map([id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for child_id in child_ids {
            self.delete_conversation_inner(&child_id, false)?;
        }
        let conn = self.conn.lock();
        let artifact_paths: Vec<(String, String)> = {
            let mut stmt =
                conn.prepare("SELECT id, path FROM artifacts WHERE conversation_id = ?1")?;
            let rows = stmt.query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        {
            let tx = conn.unchecked_transaction()?;
            // Órfãos do cache de prompt: decisões de render são chaveadas por
            // `message_id` (sem `conversation_id`), então a limpeza precisa rodar
            // antes do DELETE das mensagens. As demais tabelas têm a conversa.
            tx.execute(
                "DELETE FROM render_decisions WHERE message_id IN \
                 (SELECT id FROM messages WHERE conversation_id = ?1)",
                [id],
            )?;
            tx.execute("DELETE FROM messages WHERE conversation_id = ?1", [id])?;
            tx.execute("DELETE FROM artifacts WHERE conversation_id = ?1", [id])?;
            // Trilha/journal/resumos da sessão de código.
            tx.execute("DELETE FROM code_events WHERE conversation_id = ?1", [id])?;
            tx.execute("DELETE FROM file_journal WHERE conversation_id = ?1", [id])?;
            tx.execute("DELETE FROM session_summaries WHERE conversation_id = ?1", [id])?;
            // Regras "sempre permitir/negar" com escopo de sessão.
            tx.execute(
                "DELETE FROM approval_rules WHERE scope = 'session' AND scope_id = ?1",
                [id],
            )?;
            // Cache de prompt (surface/snapshots/estado/amostras) da sessão.
            tx.execute("DELETE FROM surface_items WHERE conversation_id = ?1", [id])?;
            tx.execute("DELETE FROM prompt_snapshots WHERE conversation_id = ?1", [id])?;
            tx.execute("DELETE FROM cache_state WHERE conversation_id = ?1", [id])?;
            tx.execute("DELETE FROM cache_samples WHERE conversation_id = ?1", [id])?;
            // Turn billing/usage (including subagent usage aggregated into the
            // parent; an ephemeral conversation must not leave orphan rows).
            tx.execute("DELETE FROM usage_log WHERE conversation_id = ?1", [id])?;
            tx.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
            tx.commit()?;
        }
        drop(conn);
        for (artifact_id, path) in artifact_paths {
            remove_artifact_files(&artifact_id, &path);
        }
        Ok(())
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        let is_main: Option<i64> = conn
            .query_row(
                "SELECT is_main FROM conversations WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        if !pinned && is_main == Some(1) {
            return Err(anyhow::anyhow!(
                "CONVERSATION_MAIN: a conversa principal não pode ser desafixada."
            ));
        }
        conn.execute(
            "UPDATE conversations SET pinned = ?2 WHERE id = ?1",
            params![id, if pinned { 1i64 } else { 0i64 }],
        )
        .context("falha ao fixar/desafixar conversa")?;
        Ok(())
    }

    /// Rewrites `sort_order` for the given ids in the received order. Unknown
    /// ids are ignored; the transaction keeps a section from being half-sorted.
    fn apply_sort_order(&self, table: &'static str, ids: &[String]) -> anyhow::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock();
        let tx = conn
            .unchecked_transaction()
            .context("falha ao abrir a transação de reordenação")?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                &format!("UPDATE {table} SET sort_order = ?2 WHERE id = ?1"),
                params![id, index as i64],
            )
            .with_context(|| format!("falha ao reordenar {table}"))?;
        }
        tx.commit().context("falha ao confirmar a reordenação")?;
        Ok(())
    }

    pub fn reorder_conversations(&self, ids: &[String]) -> anyhow::Result<()> {
        self.apply_sort_order("conversations", ids)
    }

    pub fn reorder_workspaces(&self, ids: &[String]) -> anyhow::Result<()> {
        self.apply_sort_order("workspaces", ids)
    }

    pub fn reorder_agents(&self, ids: &[String]) -> anyhow::Result<()> {
        self.apply_sort_order("agents", ids)
    }

    pub fn search_conversations(&self, query: &str) -> anyhow::Result<Vec<Conversation>> {
        let query = query.trim();
        if query.is_empty() {
            return self.list_conversations();
        }
        let pattern = like_pattern(query);
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.pinned, \
             c.provider_id, c.model_id, c.message_count, c.preview, c.mode, c.code_linked, \
             c.workspace_id, c.agent_kind, c.permission_mode, c.parent_conversation_id, \
             c.subagent_task_call_id, c.subagent_type, c.agent_id, c.channel_id, c.task_id, \
             c.sort_order, c.is_main \
             FROM conversations c \
             LEFT JOIN messages m ON m.conversation_id = c.id \
             WHERE c.parent_conversation_id IS NULL \
               AND (c.title LIKE ?1 ESCAPE '\\' OR m.content LIKE ?1 ESCAPE '\\') \
             ORDER BY c.is_main DESC, c.pinned DESC, c.sort_order ASC, c.updated_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([&pattern], |row| conversation_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao buscar conversas")
    }

    pub fn touch_conversation(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )
        .context("falha ao atualizar a data da conversa")?;
        Ok(())
    }

    pub fn update_conversation_model(
        &self,
        id: &str,
        provider_id: &str,
        model_id: &str,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE conversations SET provider_id = ?2, model_id = ?3, updated_at = ?4 \
             WHERE id = ?1",
            params![id, provider_id, model_id, now_ms()],
        )
        .context("falha ao atualizar o modelo da conversa")?;
        Ok(())
    }

    /* ---------------- harness de código: workspaces ---------------- */

    /// Cria um workspace; o caminho é único (o mesmo diretório não entra duas
    /// vezes). `git` não é persistido — é detectado em memória pelo módulo
    /// `workspace`.
    pub fn create_workspace(&self, name: &str, path: &str) -> anyhow::Result<Workspace> {
        let path = path.trim();
        if path.is_empty() {
            return Err(anyhow::anyhow!("o caminho do workspace não pode ser vazio"));
        }
        let name = name.trim();
        let name = if name.is_empty() {
            path.to_string()
        } else {
            name.to_string()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        {
            let conn = self.conn.lock();
            if let Err(error) = conn.execute(
                "INSERT INTO workspaces \
                 (id, name, path, created_at, updated_at, last_opened_at, pinned, trusted) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0)",
                params![&id, &name, path, now, now],
            ) {
                if is_constraint_violation(&error) {
                    return Err(anyhow::anyhow!(
                        "já existe um workspace para o caminho `{path}`"
                    ));
                }
                return Err(error).context("falha ao criar workspace");
            }
        }
        self.get_workspace(&id)?
            .ok_or_else(|| anyhow::anyhow!("workspace recém-criado não encontrado"))
    }

    pub fn get_workspace(&self, id: &str) -> anyhow::Result<Option<Workspace>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1");
        conn.query_row(&sql, [id], workspace_from_row)
            .optional()
            .context("falha ao ler workspace")
    }

    pub fn find_workspace_by_path(&self, path: &str) -> anyhow::Result<Option<Workspace>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE path = ?1");
        conn.query_row(&sql, [path.trim()], workspace_from_row)
            .optional()
            .context("falha ao buscar workspace pelo caminho")
    }

    /// Lista na ordem da sidebar: fixados primeiro, depois os abertos mais
    /// recentemente, depois os atualizados mais recentemente.
    pub fn list_workspaces(&self) -> anyhow::Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {WORKSPACE_COLUMNS} FROM workspaces \
             ORDER BY pinned DESC, sort_order ASC, COALESCE(last_opened_at, 0) DESC, \
             name COLLATE NOCASE ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| workspace_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar workspaces")
    }

    /// Atualiza os metadados editáveis do workspace (nome, caminho, fixado,
    /// confiável e último acesso). Use [`Db::touch_workspace`] /
    /// [`Db::mark_workspace_opened`] para os carimbos de tempo.
    pub fn update_workspace(&self, workspace: &Workspace) -> anyhow::Result<()> {
        let name = workspace.name.trim();
        let path = workspace.path.trim();
        if path.is_empty() {
            return Err(anyhow::anyhow!("o caminho do workspace não pode ser vazio"));
        }
        let conn = self.conn.lock();
        let changed = match conn.execute(
            "UPDATE workspaces SET name = ?2, path = ?3, pinned = ?4, trusted = ?5, \
             last_opened_at = ?6, updated_at = ?7 WHERE id = ?1",
            params![
                &workspace.id,
                name,
                path,
                if workspace.pinned { 1i64 } else { 0i64 },
                if workspace.trusted { 1i64 } else { 0i64 },
                workspace.last_opened_at,
                now_ms(),
            ],
        ) {
            Ok(changed) => changed,
            Err(error) if is_constraint_violation(&error) => {
                return Err(anyhow::anyhow!(
                    "já existe um workspace para o caminho `{path}`"
                ));
            }
            Err(error) => return Err(error).context("falha ao atualizar workspace"),
        };
        if changed == 0 {
            return Err(anyhow::anyhow!("workspace não encontrado: {}", workspace.id));
        }
        Ok(())
    }

    pub fn touch_workspace(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE workspaces SET updated_at = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )
        .context("falha ao atualizar a data do workspace")?;
        Ok(())
    }

    /// Marca o workspace como aberto agora (ordena a sidebar).
    pub fn mark_workspace_opened(&self, id: &str) -> anyhow::Result<()> {
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE workspaces SET last_opened_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )
        .context("falha ao marcar o workspace como aberto")?;
        Ok(())
    }

    pub fn set_workspace_pinned(&self, id: &str, pinned: bool) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE workspaces SET pinned = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, if pinned { 1i64 } else { 0i64 }, now_ms()],
        )
        .context("falha ao fixar/desafixar workspace")?;
        Ok(())
    }

    /// Marca a pasta como confiável ("Confiar nesta pasta") ou revoga.
    pub fn set_workspace_trusted(&self, id: &str, trusted: bool) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE workspaces SET trusted = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, if trusted { 1i64 } else { 0i64 }, now_ms()],
        )
        .context("falha ao alterar a confiança do workspace")?;
        Ok(())
    }

    /// Remove o workspace. As sessões sobrevivem (ficam sem workspace) e as
    /// regras de aprovação com escopo de workspace são apagadas junto.
    /// Devolve `true` quando havia um workspace para remover.
    pub fn delete_workspace(&self, id: &str) -> anyhow::Result<bool> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE conversations SET workspace_id = NULL WHERE workspace_id = ?1",
            [id],
        )
        .context("falha ao desvincular as sessões do workspace")?;
        tx.execute(
            "DELETE FROM approval_rules WHERE scope = 'workspace' AND scope_id = ?1",
            [id],
        )
        .context("falha ao apagar as regras do workspace")?;
        let removed = tx
            .execute("DELETE FROM workspaces WHERE id = ?1", [id])
            .context("falha ao remover o workspace")?;
        tx.commit()?;
        Ok(removed > 0)
    }

    /// Sessões de código de um workspace (ordem da sidebar).
    pub fn list_conversations_for_workspace(
        &self,
        workspace_id: &str,
    ) -> anyhow::Result<Vec<Conversation>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE workspace_id = ?1 \
             AND parent_conversation_id IS NULL \
             ORDER BY pinned DESC, sort_order ASC, updated_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([workspace_id], |row| conversation_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar as sessões do workspace")
    }

    /* ---------------- harness de código: eventos ---------------- */

    /// Anexa um evento à trilha da conversa com `seq` monotônico (1, 2, 3…).
    /// A leitura/inserção roda numa transação, então dois appends concorrentes
    /// nunca repetem `seq` (há também um índice único como rede de segurança).
    pub fn append_code_event(
        &self,
        conversation_id: &str,
        turn_id: Option<&str>,
        kind: &str,
        payload: &str,
    ) -> anyhow::Result<StoredCodeEvent> {
        let kind = kind.trim();
        if kind.is_empty() {
            return Err(anyhow::anyhow!("o tipo do evento não pode ser vazio"));
        }
        let turn_id = turn_id.map(str::trim).filter(|value| !value.is_empty());
        let created_at = now_ms();
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM code_events WHERE conversation_id = ?1",
                [conversation_id],
                |row| row.get(0),
            )
            .context("falha ao calcular o seq do evento")?;
        tx.execute(
            "INSERT INTO code_events (conversation_id, turn_id, seq, kind, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![conversation_id, turn_id, seq, kind, payload, created_at],
        )
        .context("falha ao gravar o evento do agente")?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(StoredCodeEvent {
            id,
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.map(str::to_string),
            seq,
            kind: kind.to_string(),
            payload: payload.to_string(),
            created_at,
        })
    }

    /// Eventos da conversa a partir de `from_seq` **inclusive** (replay).
    pub fn list_code_events(
        &self,
        conversation_id: &str,
        from_seq: i64,
    ) -> anyhow::Result<Vec<StoredCodeEvent>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, seq, kind, payload, created_at \
             FROM code_events WHERE conversation_id = ?1 AND seq >= ?2 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, from_seq], |row| {
            code_event_from_row(row)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar os eventos do agente")
    }

    /// Último evento de um `kind` (projeção de estado, ex.: plano/todos/uso).
    pub fn latest_code_event(
        &self,
        conversation_id: &str,
        kind: &str,
    ) -> anyhow::Result<Option<StoredCodeEvent>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, conversation_id, turn_id, seq, kind, payload, created_at \
             FROM code_events WHERE conversation_id = ?1 AND kind = ?2 \
             ORDER BY seq DESC LIMIT 1",
            params![conversation_id, kind.trim()],
            |row| code_event_from_row(row),
        )
        .optional()
        .context("falha ao ler o último evento do agente")
    }

    /// Eventos de um conjunto de `kind`s, do mais recente (`seq` maior) para o
    /// mais antigo. `limit` corta depois do filtro; `None` devolve tudo.
    ///
    /// É a query do fold do sistema de objetivos (`harness/code/goal.rs`), que
    /// só precisa de `goal/state`, `goal/deleted`, `goal/round-started` e
    /// `goal/round` — o replay completo continua em [`Db::list_code_events`].
    /// Lista de `kinds` vazia (ou só com espaços) devolve vazio: não há o que
    /// filtrar, e um `IN ()` seria inválido no SQLite.
    pub fn list_code_events_by_kinds(
        &self,
        conversation_id: &str,
        kinds: &[&str],
        limit: Option<usize>,
    ) -> anyhow::Result<Vec<StoredCodeEvent>> {
        let kinds: Vec<&str> = kinds
            .iter()
            .map(|kind| kind.trim())
            .filter(|kind| !kind.is_empty())
            .collect();
        if kinds.is_empty() {
            return Ok(Vec::new());
        }
        // Placeholders dinâmicos: `?1` é a conversa, `?2..=?n+1` são os kinds e
        // o `LIMIT` (quando pedido) ocupa a posição seguinte.
        let placeholders = (2..=kinds.len() + 1)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut sql = format!(
            "SELECT id, conversation_id, turn_id, seq, kind, payload, created_at \
             FROM code_events WHERE conversation_id = ?1 AND kind IN ({placeholders}) \
             ORDER BY seq DESC"
        );
        if limit.is_some() {
            sql.push_str(&format!(" LIMIT ?{}", kinds.len() + 2));
        }
        let mut values: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(conversation_id.to_string())];
        values.extend(
            kinds
                .iter()
                .map(|kind| rusqlite::types::Value::Text((*kind).to_string())),
        );
        if let Some(limit) = limit {
            values.push(rusqlite::types::Value::Integer(
                i64::try_from(limit).unwrap_or(i64::MAX),
            ));
        }
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
            code_event_from_row(row)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar os eventos do agente por tipo")
    }

    /* ---------------- harness de código: journal ---------------- */

    /// Registra uma escrita/edição de arquivo feita pelo agente.
    /// Devolve o id da linha inserida.
    pub fn append_file_journal(&self, entry: &FileJournalEntry) -> anyhow::Result<i64> {
        let path = entry.path.trim();
        if path.is_empty() {
            return Err(anyhow::anyhow!("o caminho do arquivo não pode ser vazio"));
        }
        if entry.turn_id.trim().is_empty() {
            return Err(anyhow::anyhow!("o turno do journal não pode ser vazio"));
        }
        let created_at = if entry.created_at > 0 {
            entry.created_at
        } else {
            now_ms()
        };
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO file_journal \
             (conversation_id, turn_id, path, change_kind, before_hash, after_hash, added, \
              removed, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &entry.conversation_id,
                entry.turn_id.trim(),
                path,
                file_change_kind_to_str(entry.change_kind),
                entry.before_hash,
                entry.after_hash,
                entry.added.map(i64::from),
                entry.removed.map(i64::from),
                created_at,
            ],
        )
        .context("falha ao gravar o journal de arquivos")?;
        Ok(conn.last_insert_rowid())
    }

    /// Journal de um turno (painel Alterações), em ordem cronológica.
    pub fn list_file_journal_for_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> anyhow::Result<Vec<FileJournalEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, path, change_kind, before_hash, after_hash, \
             added, removed, created_at \
             FROM file_journal WHERE conversation_id = ?1 AND turn_id = ?2 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, turn_id], |row| {
            file_journal_from_row(row)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar o journal do turno")
    }

    /// Turno mais recente com eventos persistidos (`turn_events`), mesmo sem
    /// alterações de arquivo.
    pub fn last_turn_id(&self, conversation_id: &str) -> anyhow::Result<Option<String>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT turn_id FROM turn_events WHERE conversation_id = ?1 \
             ORDER BY created_at DESC, seq DESC LIMIT 1",
            [conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("falha ao ler o último turno da conversa")
    }

    /// Fallback para sessões antigas sem `turn_events`: último turno que
    /// registrou escrita de arquivo.
    pub fn last_file_journal_turn(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT turn_id FROM file_journal WHERE conversation_id = ?1 \
             ORDER BY id DESC LIMIT 1",
            [conversation_id],
            |row| row.get(0),
        )
        .optional()
        .context("falha ao ler o último turno do journal")
    }

    /// Journal completo da sessão, em ordem cronológica.
    pub fn list_file_journal(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<Vec<FileJournalEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, turn_id, path, change_kind, before_hash, after_hash, \
             added, removed, created_at \
             FROM file_journal WHERE conversation_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| file_journal_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar o journal da sessão")
    }

    /* ---------------- harness de código: resumos ---------------- */

    /// Registra um resumo de compactação para a faixa `[from_seq, to_seq]`.
    pub fn insert_session_summary(
        &self,
        conversation_id: &str,
        from_seq: i64,
        to_seq: i64,
        content: &str,
        tokens: Option<u32>,
    ) -> anyhow::Result<SessionSummary> {
        if from_seq < 1 || to_seq < from_seq {
            return Err(anyhow::anyhow!(
                "faixa de compactação inválida: {from_seq}..{to_seq}"
            ));
        }
        let summary = SessionSummary {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            from_seq,
            to_seq,
            content: content.to_string(),
            tokens,
            created_at: now_ms(),
        };
        {
            let conn = self.conn.lock();
            conn.execute(
                "INSERT INTO session_summaries \
                 (id, conversation_id, from_seq, to_seq, content, tokens, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &summary.id,
                    &summary.conversation_id,
                    summary.from_seq,
                    summary.to_seq,
                    &summary.content,
                    summary.tokens.map(i64::from),
                    summary.created_at,
                ],
            )
            .context("falha ao gravar o resumo da sessão")?;
        }
        Ok(summary)
    }

    pub fn list_session_summaries(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<Vec<SessionSummary>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, from_seq, to_seq, content, tokens, created_at \
             FROM session_summaries WHERE conversation_id = ?1 ORDER BY from_seq ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| session_summary_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar os resumos da sessão")
    }

    /// Resumo mais recente (maior `to_seq`), usado para montar o contexto.
    pub fn latest_session_summary(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<Option<SessionSummary>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, conversation_id, from_seq, to_seq, content, tokens, created_at \
             FROM session_summaries WHERE conversation_id = ?1 \
             ORDER BY to_seq DESC, created_at DESC LIMIT 1",
            [conversation_id],
            |row| session_summary_from_row(row),
        )
        .optional()
        .context("falha ao ler o resumo mais recente da sessão")
    }

    /* ---------------- harness de código: regras de aprovação ---------------- */

    /// Persiste uma regra já montada (id/created_at fornecidos pelo chamador).
    pub fn insert_approval_rule(&self, rule: &ApprovalRule) -> anyhow::Result<()> {
        if rule.tool.trim().is_empty() {
            return Err(anyhow::anyhow!("a regra precisa de uma ferramenta"));
        }
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO approval_rules \
             (id, scope, scope_id, tool, matcher, pattern, decision, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &rule.id,
                rule.scope.as_str(),
                rule.scope_id,
                rule.tool.trim(),
                rule.matcher.trim(),
                rule.pattern.trim(),
                rule.decision.as_str(),
                rule.created_at,
            ],
        )
        .context("falha ao gravar a regra de aprovação")?;
        Ok(())
    }

    /// Cria a regra gerando `id`/`created_at` (caminho usado pelos comandos).
    pub fn create_approval_rule(
        &self,
        spec: &NewApprovalRule<'_>,
    ) -> anyhow::Result<ApprovalRule> {
        let tool = spec.tool.trim();
        if tool.is_empty() {
            return Err(anyhow::anyhow!("a regra precisa de uma ferramenta"));
        }
        let matcher = spec.matcher.trim();
        if matcher.is_empty() {
            return Err(anyhow::anyhow!("a regra precisa de um matcher"));
        }
        let rule = ApprovalRule {
            id: uuid::Uuid::new_v4().to_string(),
            scope: spec.scope,
            scope_id: spec.scope_id.map(str::to_string),
            tool: tool.to_string(),
            matcher: matcher.to_string(),
            pattern: spec.pattern.trim().to_string(),
            decision: spec.decision,
            created_at: now_ms(),
        };
        self.insert_approval_rule(&rule)?;
        Ok(rule)
    }

    pub fn list_approval_rules(&self) -> anyhow::Result<Vec<ApprovalRule>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, scope, scope_id, tool, matcher, pattern, decision, created_at \
             FROM approval_rules ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| approval_rule_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar as regras de aprovação")
    }

    /// Regras de um escopo exato (`scope_id` `None` casa com NULL).
    pub fn list_approval_rules_for_scope(
        &self,
        scope: ApprovalScope,
        scope_id: Option<&str>,
    ) -> anyhow::Result<Vec<ApprovalRule>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, scope, scope_id, tool, matcher, pattern, decision, created_at \
             FROM approval_rules WHERE scope = ?1 AND scope_id IS ?2 \
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![scope.as_str(), scope_id], |row| {
            approval_rule_from_row(row)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar as regras do escopo")
    }

    /// Regras que valem para uma sessão: globais + as da sessão + as do
    /// workspace dela (insumo direto da política de permissões).
    pub fn list_approval_rules_for_context(
        &self,
        conversation_id: Option<&str>,
        workspace_id: Option<&str>,
    ) -> anyhow::Result<Vec<ApprovalRule>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, scope, scope_id, tool, matcher, pattern, decision, created_at \
             FROM approval_rules \
             WHERE scope = 'global' \
                OR (scope = 'session' AND scope_id = ?1) \
                OR (scope = 'workspace' AND scope_id = ?2) \
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![conversation_id, workspace_id], |row| {
            approval_rule_from_row(row)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar as regras de aprovação aplicáveis")
    }

    /// Devolve `true` quando existia uma regra com o id.
    pub fn delete_approval_rule(&self, id: &str) -> anyhow::Result<bool> {
        let conn = self.conn.lock();
        let removed = conn
            .execute("DELETE FROM approval_rules WHERE id = ?1", [id])
            .context("falha ao remover a regra de aprovação")?;
        Ok(removed > 0)
    }

    pub fn delete_approval_rules_for_scope(
        &self,
        scope: ApprovalScope,
        scope_id: Option<&str>,
    ) -> anyhow::Result<usize> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM approval_rules WHERE scope = ?1 AND scope_id IS ?2",
            params![scope.as_str(), scope_id],
        )
        .context("falha ao remover as regras do escopo")
    }

    /* ---------------- harness de código: sessão ---------------- */

    /// Associa (ou desassocia, com `None`) a sessão a um workspace. O workspace
    /// precisa existir; a conversa também (erro claro em ambos os casos).
    pub fn set_conversation_workspace(
        &self,
        id: &str,
        workspace_id: Option<&str>,
    ) -> anyhow::Result<()> {
        if let Some(workspace_id) = workspace_id {
            if self.get_workspace(workspace_id)?.is_none() {
                return Err(anyhow::anyhow!(
                    "workspace não encontrado: {workspace_id}"
                ));
            }
        }
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE conversations SET workspace_id = ?2 WHERE id = ?1",
                params![id, workspace_id],
            )
            .context("falha ao associar a sessão ao workspace")?;
        if changed == 0 {
            return Err(anyhow::anyhow!("conversa não encontrada: {id}"));
        }
        Ok(())
    }

    pub fn clear_conversation_workspace(&self, id: &str) -> anyhow::Result<()> {
        self.set_conversation_workspace(id, None)
    }

    /// Define o motor do agente da sessão (`zylara` hoje). Vazio é rejeitado.
    pub fn set_conversation_agent_kind(&self, id: &str, agent_kind: &str) -> anyhow::Result<()> {
        let agent_kind = agent_kind.trim();
        if agent_kind.is_empty() {
            return Err(anyhow::anyhow!("o motor do agente não pode ser vazio"));
        }
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE conversations SET agent_kind = ?2 WHERE id = ?1",
                params![id, agent_kind],
            )
            .context("falha ao atualizar o motor do agente")?;
        if changed == 0 {
            return Err(anyhow::anyhow!("conversa não encontrada: {id}"));
        }
        Ok(())
    }

    pub fn set_conversation_permission_mode(
        &self,
        id: &str,
        mode: PermissionMode,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE conversations SET permission_mode = ?2 WHERE id = ?1",
                params![id, mode.as_str()],
            )
            .context("falha ao atualizar o modo de permissão da sessão")?;
        if changed == 0 {
            return Err(anyhow::anyhow!("conversa não encontrada: {id}"));
        }
        Ok(())
    }

    pub fn get_conversation_permission_mode(
        &self,
        id: &str,
    ) -> anyhow::Result<Option<PermissionMode>> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT permission_mode FROM conversations WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .context("falha ao ler o modo de permissão da sessão")?;
        Ok(raw.map(|value| PermissionMode::from_str(&value)))
    }

    /* ---------------- messages ---------------- */

    pub fn list_messages(&self, conversation_id: &str) -> anyhow::Result<Vec<ChatMessage>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?1 \
             ORDER BY created_at, id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([conversation_id], |row| message_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar mensagens")
    }

    // Somente os testes de persistência leem mensagens individuais; a produção não usa.
    #[cfg(test)]
    pub fn get_message(&self, id: &str) -> anyhow::Result<Option<ChatMessage>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1");
        conn.query_row(&sql, [id], |row| message_from_row(row))
            .optional()
            .context("falha ao ler mensagem")
    }

    pub fn insert_message(&self, message: &ChatMessage) -> anyhow::Result<()> {
        let cols = serialize_message(message)?;
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        insert_message_row(&tx, message, &cols)?;
        refresh_conversation_stats(&tx, &message.conversation_id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn update_message(&self, message: &ChatMessage) -> anyhow::Result<()> {
        let cols = serialize_message(message)?;
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let changed = update_message_row(&tx, message, &cols)?;
        if changed == 0 {
            // Self-heal: the harness may persist a message it never inserted.
            insert_message_row(&tx, message, &cols)?;
        }
        refresh_conversation_stats(&tx, &message.conversation_id)?;
        tx.commit()?;
        Ok(())
    }

    /// Lightweight progress write while a turn streams: only the mutable message
    /// columns, without `refresh_conversation_stats`/`updated_at` churn.
    pub fn checkpoint_message(&self, message: &ChatMessage) -> anyhow::Result<()> {
        let tool_calls = encode_json(&message.tool_calls)?;
        let citations = encode_json(&message.citations)?;
        let trace = encode_json(&message.trace)?;
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE messages SET content = ?2, reasoning = ?3, status = ?4, tool_calls = ?5, \
             citations = ?6, trace = ?7 WHERE id = ?1",
            params![
                &message.id,
                &message.content,
                &message.reasoning,
                status_to_str(message.status),
                &tool_calls,
                &citations,
                &trace,
            ],
        )
        .context("falha ao salvar checkpoint da mensagem")?;
        Ok(())
    }

    /// Writes (or clears) the resume point of one assistant message. Called at
    /// every step boundary of a live turn and on every terminal path, so a
    /// crash never loses more than the step in flight.
    pub fn save_resume_state(
        &self,
        message_id: &str,
        state: Option<&crate::domain::ResumeState>,
    ) -> anyhow::Result<()> {
        let raw = state.map(encode_json).transpose()?;
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE messages SET resume_state = ?2 WHERE id = ?1",
            params![message_id, raw],
        )
        .context("falha ao salvar ponto de retomada do turno")?;
        Ok(())
    }

    /// Drops every resume point of a conversation. Only the newest turn can be
    /// resumed, so a new user message invalidates the older points.
    pub fn clear_resume_states(&self, conversation_id: &str) -> anyhow::Result<usize> {
        let conn = self.conn.lock();
        let cleared = conn
            .execute(
                "UPDATE messages SET resume_state = NULL \
                 WHERE conversation_id = ?1 AND resume_state IS NOT NULL",
                params![conversation_id],
            )
            .context("falha ao limpar os pontos de retomada da conversa")?;
        Ok(cleared)
    }

    /// Deletes `message_id` and every message after it (used by edit/regenerate).
    pub fn delete_messages_from(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let target_created_at: Option<i64> = tx
            .query_row(
                "SELECT created_at FROM messages WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(created_at) = target_created_at {
            // Órfãos do cache de prompt da cauda (PLAN §4.4: apagados no mesmo
            // passo em que a mensagem âncora sai do replay).
            delete_cache_rows_from_message(&tx, conversation_id, message_id)?;
            tx.execute(
                "DELETE FROM messages WHERE conversation_id = ?1 \
                 AND (created_at > ?2 OR (created_at = ?2 AND id >= ?3))",
                params![conversation_id, created_at, message_id],
            )?;
            refresh_conversation_stats(&tx, conversation_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    /* ---------------- attachments ---------------- */

    pub fn insert_attachment(&self, attachment: &StoredAttachment) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO attachments (id, name, mime_type, size, kind, text, page_count, \
             width, height, file_path, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &attachment.id,
                &attachment.name,
                &attachment.mime_type,
                attachment.size,
                &attachment.kind,
                &attachment.text,
                attachment.page_count.map(i64::from),
                attachment.width.map(i64::from),
                attachment.height.map(i64::from),
                &attachment.file_path,
                attachment.created_at,
            ],
        )
        .with_context(|| format!("falha ao inserir anexo {}", attachment.id))?;
        Ok(())
    }

    pub fn get_attachment(&self, id: &str) -> anyhow::Result<Option<StoredAttachment>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?1");
        conn.query_row(&sql, [id], |row| attachment_from_row(row))
            .optional()
            .context("falha ao ler anexo")
    }

    pub fn delete_attachment(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM attachments WHERE id = ?1", [id])
            .context("falha ao remover anexo")?;
        Ok(())
    }

    /* ---------------- artifacts ---------------- */

    pub fn insert_artifact(&self, artifact: &StoredArtifact) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO artifacts (id, conversation_id, message_id, name, mime_type, kind, \
             language, size, created_at, path, favorite, task_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, \
                     (SELECT task_id FROM conversations WHERE id = ?2))",
            params![
                &artifact.artifact.id,
                &artifact.artifact.conversation_id,
                &artifact.artifact.message_id,
                &artifact.artifact.name,
                &artifact.artifact.mime_type,
                artifact_kind_to_str(&artifact.artifact.kind),
                &artifact.artifact.language,
                artifact.artifact.size,
                artifact.artifact.created_at,
                &artifact.path,
                artifact.artifact.favorite as i64,
            ],
        )
        .with_context(|| format!("falha ao inserir artefato {}", artifact.artifact.id))?;
        Ok(())
    }

    pub fn list_artifacts(&self, conversation_id: &str) -> anyhow::Result<Vec<Artifact>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE conversation_id = ?1 \
             ORDER BY created_at, id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([conversation_id], |row| artifact_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar artefatos")
    }

    /// Todos os artefatos do usuário (todas as conversas), na ordem canônica de
    /// criação (`created_at, id`). É a fonte de verdade da biblioteca global do
    /// agente; o recorte por conversa continua em [`Db::list_artifacts`].
    pub fn list_all_artifacts(&self) -> anyhow::Result<Vec<Artifact>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts ORDER BY created_at, id");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| artifact_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar os artefatos")
    }

    /// Biblioteca do usuário: todos os artefatos (gerados em qualquer conversa
    /// **e** os enviados direto à biblioteca, `conversation_id IS NULL`), mais
    /// recentes primeiro, com o título da conversa de origem (`None` para
    /// uploads). Uma única query com `LEFT JOIN`.
    pub fn list_library_artifacts(&self) -> anyhow::Result<Vec<LibraryArtifact>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {ARTIFACT_JOIN_COLUMNS}, c.title \
             FROM artifacts a LEFT JOIN conversations c ON c.id = a.conversation_id \
             ORDER BY a.created_at DESC, a.id DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(LibraryArtifact {
                artifact: artifact_from_row(row)?,
                conversation_title: row.get(11)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar a biblioteca de artefatos")
    }

    pub fn get_artifact(&self, id: &str) -> anyhow::Result<Option<StoredArtifact>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {ARTIFACT_COLUMNS}, path FROM artifacts WHERE id = ?1");
        conn.query_row(&sql, [id], |row| {
            Ok(StoredArtifact {
                artifact: artifact_from_row(row)?,
                path: row.get(11)?,
            })
        })
        .optional()
        .context("falha ao ler artefato")
    }

    pub fn artifact_belongs_to_task(&self, artifact_id: &str, task_id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT a.task_id, a.conversation_id FROM artifacts a WHERE a.id = ?1",
                [artifact_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((artifact_task, conversation_id)) = row else {
            return Ok(false);
        };
        if artifact_task.as_deref() == Some(task_id) {
            return Ok(true);
        }
        if artifact_task.is_some() {
            return Ok(false);
        }
        let Some(conversation_id) = conversation_id else {
            return Ok(false);
        };
        let conversation_task: Option<String> = conn
            .query_row(
                "SELECT task_id FROM conversations WHERE id = ?1",
                [conversation_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(conversation_task.as_deref() == Some(task_id))
    }

    pub fn delete_artifact(&self, id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM artifacts WHERE id = ?1", [id])
            .context("falha ao remover artefato")?;
        Ok(())
    }

    /// Marca/desmarca o favorito na Biblioteca e devolve o artefato atualizado.
    /// `None` quando o id não existe (o comando transforma em erro).
    pub fn set_artifact_favorite(
        &self,
        id: &str,
        favorite: bool,
    ) -> anyhow::Result<Option<Artifact>> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE artifacts SET favorite = ?2 WHERE id = ?1",
                params![id, if favorite { 1i64 } else { 0i64 }],
            )
            .context("falha ao atualizar o favorito do artefato")?;
        if changed == 0 {
            return Ok(None);
        }
        artifact_by_id(&conn, id)
    }

    /// Atualiza os metadados de um artefato renomeado (o arquivo em disco é
    /// renomeado pelo comando). O `path` da linha é atualizado em
    /// [`Db::update_artifact_rename`], no mesmo UPDATE do rename — por isso o
    /// comando de produção usa o método combinado; este fica coberto pelos
    /// testes da API do banco.
    /// `None` quando o id não existe.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn update_artifact_metadata(
        &self,
        id: &str,
        name: &str,
        mime_type: &str,
        kind: ArtifactKind,
        language: Option<&str>,
    ) -> anyhow::Result<Option<Artifact>> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE artifacts SET name = ?2, mime_type = ?3, kind = ?4, language = ?5 \
                 WHERE id = ?1",
                params![id, name, mime_type, artifact_kind_to_str(&kind), language],
            )
            .context("falha ao atualizar os metadados do artefato")?;
        if changed == 0 {
            return Ok(None);
        }
        artifact_by_id(&conn, id)
    }

    /// Rename: grava metadados **e** o novo caminho do arquivo em um único
    /// UPDATE (evita linha com path/metadados divergentes). `None` quando o id
    /// não existe.
    pub fn update_artifact_rename(
        &self,
        id: &str,
        name: &str,
        mime_type: &str,
        kind: ArtifactKind,
        language: Option<&str>,
        path: &str,
    ) -> anyhow::Result<Option<Artifact>> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE artifacts SET name = ?2, mime_type = ?3, kind = ?4, language = ?5, \
                 path = ?6 WHERE id = ?1",
                params![id, name, mime_type, artifact_kind_to_str(&kind), language, path],
            )
            .context("falha ao renomear o artefato no banco")?;
        if changed == 0 {
            return Ok(None);
        }
        artifact_by_id(&conn, id)
    }

    /* ---------------- usage ---------------- */

    /// Removes only the usage rows of a conversation (used by retained
    /// subagent transcripts: their usage is aggregated into the parent turn).
    pub fn delete_usage_for_conversation(&self, conversation_id: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM usage_log WHERE conversation_id = ?1",
            [conversation_id],
        )
        .context("falha ao remover o uso da conversa")?;
        Ok(())
    }

    /// Registra o uso de um turno em `usage_log` (billing; 1 linha por turno,
    /// conforme §5.3 do plano). Os contadores de cache de `UsageInfo` são
    /// gravados normalizados; epoch/prefixo/quebra/protocolo ficam `NULL` até
    /// existirem — use [`Db::record_usage_with_cache`] para preenchê-los.
    pub fn record_usage(
        &self,
        conversation_id: &str,
        message_id: &str,
        provider_id: &str,
        model_id: &str,
        usage: &UsageInfo,
    ) -> anyhow::Result<()> {
        self.record_usage_with_cache(
            conversation_id,
            message_id,
            provider_id,
            model_id,
            usage,
            &UsageLogCache::default(),
        )
    }

    /// Como [`Db::record_usage`], mas aceita os metadados de cache de prompt
    /// (epoch, prefixo, razão de quebra e protocolo). `cache_hit_percent` é
    /// derivado de `UsageInfo` (`cache_read / input_total * 100`) quando
    /// `cache.cache_hit_percent` é `None` e o provedor reportou cache — se não
    /// reportou, fica `NULL` (nunca 100%).
    pub fn record_usage_with_cache(
        &self,
        conversation_id: &str,
        message_id: &str,
        provider_id: &str,
        model_id: &str,
        usage: &UsageInfo,
        cache: &UsageLogCache<'_>,
    ) -> anyhow::Result<()> {
        let cache_usage = usage.cache_usage();
        let hit_percent = cache.cache_hit_percent.or_else(|| {
            if !cache_usage.reported {
                return None;
            }
            percent_of(
                cache_usage.cache_read_tokens.unwrap_or(0),
                cache_usage.input_total_tokens.unwrap_or(0),
            )
        });
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO usage_log (conversation_id, message_id, provider_id, model_id, \
             input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens, \
             cost, cache_read_tokens, cache_write_tokens, uncached_input_tokens, \
             cache_hit_percent, cache_epoch, prefix_hash, break_reason, protocol, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
                     ?17, ?18, ?19)",
            params![
                conversation_id,
                message_id,
                provider_id,
                model_id,
                usage.input_tokens.map(i64::from),
                usage.output_tokens.map(i64::from),
                usage.reasoning_tokens.map(i64::from),
                usage.cached_tokens.map(i64::from),
                usage.total_tokens.map(i64::from),
                usage.cost,
                cache_usage.cache_read_tokens.map(i64::from),
                cache_usage.cache_write_tokens.map(i64::from),
                cache_usage.uncached_input_tokens.map(i64::from),
                hit_percent.map(f64::from),
                cache.cache_epoch.map(i64::from),
                cache.prefix_hash,
                cache.break_reason.map(cache_break_reason_to_str),
                cache.protocol,
                now_ms(),
            ],
        )
        .context("falha ao registrar uso de tokens")?;
        Ok(())
    }

    // Somente os testes de persistência agregam o uso; a produção não usa.
    #[cfg(test)]
    pub fn usage_summary(&self) -> anyhow::Result<serde_json::Value> {
        const SUM_COLUMNS: &str = "COUNT(*), COALESCE(SUM(input_tokens), 0), \
             COALESCE(SUM(output_tokens), 0), COALESCE(SUM(reasoning_tokens), 0), \
             COALESCE(SUM(cached_tokens), 0), COALESCE(SUM(total_tokens), 0), \
             COALESCE(SUM(cost), 0.0), COALESCE(SUM(cache_read_tokens), 0), \
             COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(uncached_input_tokens), 0)";

        fn stats(row: &Row<'_>, offset: usize) -> rusqlite::Result<serde_json::Value> {
            let requests: i64 = row.get(offset)?;
            let input_tokens: i64 = row.get(offset + 1)?;
            let output_tokens: i64 = row.get(offset + 2)?;
            let reasoning_tokens: i64 = row.get(offset + 3)?;
            let cached_tokens: i64 = row.get(offset + 4)?;
            let total_tokens: i64 = row.get(offset + 5)?;
            let cost: f64 = row.get(offset + 6)?;
            let cache_read_tokens: i64 = row.get(offset + 7)?;
            let cache_write_tokens: i64 = row.get(offset + 8)?;
            let uncached_input_tokens: i64 = row.get(offset + 9)?;
            Ok(serde_json::json!({
                "requests": requests,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "reasoningTokens": reasoning_tokens,
                "cachedTokens": cached_tokens,
                "totalTokens": total_tokens,
                "cost": cost,
                "cacheReadTokens": cache_read_tokens,
                "cacheWriteTokens": cache_write_tokens,
                "uncachedInputTokens": uncached_input_tokens,
            }))
        }

        let conn = self.conn.lock();

        let totals_sql = format!("SELECT {SUM_COLUMNS} FROM usage_log");
        let totals = conn
            .query_row(&totals_sql, [], |row| stats(row, 0))
            .context("falha ao somar uso de tokens")?;

        let by_provider_sql = format!(
            "SELECT provider_id, {SUM_COLUMNS} FROM usage_log GROUP BY provider_id \
             ORDER BY provider_id"
        );
        let mut stmt = conn.prepare(&by_provider_sql)?;
        let rows = stmt.query_map([], |row| {
            let provider_id: Option<String> = row.get(0)?;
            let mut value = stats(row, 1)?;
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "providerId".into(),
                    Value::String(provider_id.unwrap_or_default()),
                );
            }
            Ok(value)
        })?;
        let by_provider = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao agrupar uso por provedor")?;

        let by_model_sql = format!(
            "SELECT provider_id, model_id, {SUM_COLUMNS} FROM usage_log \
             GROUP BY provider_id, model_id ORDER BY provider_id, model_id"
        );
        let mut stmt = conn.prepare(&by_model_sql)?;
        let rows = stmt.query_map([], |row| {
            let provider_id: Option<String> = row.get(0)?;
            let model_id: Option<String> = row.get(1)?;
            let mut value = stats(row, 2)?;
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "providerId".into(),
                    Value::String(provider_id.unwrap_or_default()),
                );
                object.insert(
                    "modelId".into(),
                    Value::String(model_id.unwrap_or_default()),
                );
            }
            Ok(value)
        })?;
        let by_model = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao agrupar uso por modelo")?;

        Ok(serde_json::json!({
            "totals": totals,
            "byProvider": by_provider,
            "byModel": by_model,
        }))
    }

    /* ---------------- cache de prompt (PLAN §5.3) ---------------- */

    /// Persiste uma amostra de cache por request de wire e aplica a retenção de
    /// [`CACHE_SAMPLES_RETENTION`] amostras por conversa: quando a 501ª chega, a
    /// mais antiga cai em rotação (o agregado já está em `cache_state`).
    /// `prefix_hash` é o hash canônico do prefixo do request, quando houver.
    /// Devolve o `id` da linha inserida.
    pub fn insert_cache_sample(
        &self,
        conversation_id: &str,
        sample: &CacheSample,
        prefix_hash: Option<&str>,
    ) -> anyhow::Result<i64> {
        let conversation_id = conversation_id.trim();
        if conversation_id.is_empty() {
            return Err(anyhow::anyhow!("a amostra de cache precisa de uma conversa"));
        }
        let created_at = if sample.at > 0 { sample.at } else { now_ms() };
        let raw_usage = sample.raw_usage.as_ref().map(encode_json).transpose()?;
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO cache_samples (conversation_id, turn_id, step, provider_id, model_id, \
             protocol, epoch, prefix_hash, input_total, cache_read, cache_write, uncached, \
             hit_percent, ceiling_percent, prefix_tokens_est, delta_tokens_est, eligible, \
             excluded_reason, state, break_reason, break_detail, raw_usage, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
                     ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
            params![
                conversation_id,
                non_empty(&sample.turn_id),
                i64::from(sample.step),
                non_empty(&sample.provider_id),
                non_empty(&sample.model_id),
                non_empty(&sample.protocol),
                i64::from(sample.epoch),
                prefix_hash.and_then(non_empty),
                i64::from(sample.input_total),
                i64::from(sample.cache_read),
                i64::from(sample.cache_write),
                i64::from(sample.uncached),
                sample.hit_percent.map(f64::from),
                sample.ceiling_percent.map(f64::from),
                i64::from(sample.prefix_tokens_est),
                i64::from(sample.delta_tokens_est),
                if sample.eligible { 1i64 } else { 0i64 },
                &sample.excluded_reason,
                cache_state_to_str(sample.state),
                sample.break_reason.map(cache_break_reason_to_str),
                &sample.break_detail,
                &raw_usage,
                created_at,
            ],
        )
        .context("falha ao registrar a amostra de cache")?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "DELETE FROM cache_samples WHERE conversation_id = ?1 AND id NOT IN (\
               SELECT id FROM cache_samples WHERE conversation_id = ?1 \
                ORDER BY id DESC LIMIT ?2)",
            params![conversation_id, i64::from(CACHE_SAMPLES_RETENTION)],
        )
        .context("falha ao aplicar a retenção das amostras de cache")?;
        tx.commit()?;
        Ok(id)
    }

    /// Amostras de cache da conversa, **mais recentes primeiro** (`limit` 0
    /// devolve vazio). É a fonte do `recent` do `CacheStatsView` (diagnóstico).
    pub fn list_cache_samples(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<CacheSample>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {CACHE_SAMPLE_COLUMNS} FROM cache_samples \
             WHERE conversation_id = ?1 ORDER BY id DESC LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![conversation_id, i64::from(limit)], |row| {
            cache_sample_from_row(row)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar as amostras de cache")
    }

    /// Agregado canônico da sessão a partir de `cache_samples`: somas
    /// token-weighted de `input_total`/read/write/uncached (ciclo de vida) e as
    /// mesmas somas restritas às amostras elegíveis (base do hit% de sessão).
    pub fn cache_session_aggregate(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<CacheSessionAggregate> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT COUNT(*), \
                    COALESCE(SUM(CASE WHEN eligible <> 0 THEN 1 ELSE 0 END), 0), \
                    COALESCE(SUM(input_total), 0), \
                    COALESCE(SUM(cache_read), 0), \
                    COALESCE(SUM(cache_write), 0), \
                    COALESCE(SUM(uncached), 0), \
                    COALESCE(SUM(CASE WHEN eligible <> 0 THEN input_total ELSE 0 END), 0), \
                    COALESCE(SUM(CASE WHEN eligible <> 0 THEN cache_read ELSE 0 END), 0) \
               FROM cache_samples WHERE conversation_id = ?1",
            [conversation_id],
            |row| {
                Ok(CacheSessionAggregate {
                    samples: u32_from_count(row.get(0)?),
                    eligible_samples: u32_from_count(row.get(1)?),
                    input_total: u32_from_count(row.get(2)?),
                    cache_read: u32_from_count(row.get(3)?),
                    cache_write: u32_from_count(row.get(4)?),
                    uncached: u32_from_count(row.get(5)?),
                    eligible_input_total: u32_from_count(row.get(6)?),
                    eligible_cache_read: u32_from_count(row.get(7)?),
                })
            },
        )
        .context("falha ao agregar as amostras de cache da sessão")
    }

    /// Upsert do estado canônico de cache da conversa (`cache_state`): 1 linha
    /// por conversa, atualizada a cada request. `prefix_segments` é gravado como
    /// JSON com cap de [`CACHE_STATE_MAX_SEGMENTS`] segmentos; `updated_at` = 0
    /// vira `now_ms()`. `chat_cut_seq` = 0 não é um `seq` válido (o `seq` do
    /// replay começa em 1) e é normalizado para `NULL` ("sem corte").
    pub fn upsert_cache_state(&self, state: &CacheStateRecord) -> anyhow::Result<()> {
        let conversation_id = state.conversation_id.trim();
        if conversation_id.is_empty() {
            return Err(anyhow::anyhow!("o estado de cache precisa de uma conversa"));
        }
        let prefix_segments = state
            .prefix_segments
            .as_ref()
            .map(|segments| {
                let capped = &segments[..segments.len().min(CACHE_STATE_MAX_SEGMENTS)];
                encode_json(capped)
            })
            .transpose()?;
        // Watermark 0 não existe no replay: grava NULL (histórico sem corte).
        let chat_cut_seq = state.chat_cut_seq.filter(|seq| *seq > 0);
        let updated_at = if state.updated_at > 0 {
            state.updated_at
        } else {
            now_ms()
        };
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO cache_state (conversation_id, provider_id, model_id, protocol, epoch, \
             prefix_hash, prefix_segments, prompt_snapshot_hash, chat_cut_seq, cache_read, \
             cache_write, uncached, samples, last_hit_percent, last_ceiling_percent, last_at, \
             last_break_reason, last_break_detail, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
                     ?17, ?18, ?19) \
             ON CONFLICT(conversation_id) DO UPDATE SET \
               provider_id = excluded.provider_id, \
               model_id = excluded.model_id, \
               protocol = excluded.protocol, \
               epoch = excluded.epoch, \
               prefix_hash = excluded.prefix_hash, \
               prefix_segments = excluded.prefix_segments, \
               prompt_snapshot_hash = excluded.prompt_snapshot_hash, \
               chat_cut_seq = excluded.chat_cut_seq, \
               cache_read = excluded.cache_read, \
               cache_write = excluded.cache_write, \
               uncached = excluded.uncached, \
               samples = excluded.samples, \
               last_hit_percent = excluded.last_hit_percent, \
               last_ceiling_percent = excluded.last_ceiling_percent, \
               last_at = excluded.last_at, \
               last_break_reason = excluded.last_break_reason, \
               last_break_detail = excluded.last_break_detail, \
               updated_at = excluded.updated_at",
            params![
                conversation_id,
                &state.provider_id,
                &state.model_id,
                &state.protocol,
                i64::from(state.epoch),
                &state.prefix_hash,
                &prefix_segments,
                &state.prompt_snapshot_hash,
                chat_cut_seq.map(i64::from),
                i64::from(state.cache_read),
                i64::from(state.cache_write),
                i64::from(state.uncached),
                i64::from(state.samples),
                state.last_hit_percent.map(f64::from),
                state.last_ceiling_percent.map(f64::from),
                state.last_at,
                state.last_break_reason.map(cache_break_reason_to_str),
                &state.last_break_detail,
                updated_at,
            ],
        )
        .context("falha ao gravar o estado de cache da conversa")?;
        Ok(())
    }

    /// Estado canônico de cache da conversa (último request/epoch) ou `None`.
    pub fn get_cache_state(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<Option<CacheStateRecord>> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {CACHE_STATE_COLUMNS} FROM cache_state WHERE conversation_id = ?1");
        conn.query_row(&sql, [conversation_id], |row| cache_state_from_row(row))
            .optional()
            .context("falha ao ler o estado de cache da conversa")
    }

    /// Insere um `surface_item` **idempotente por digest**
    /// (`UNIQUE(conversation_id, digest)`): devolve `true` quando a linha entrou
    /// e `false` quando o mesmo conteúdo já existia na conversa (ou o `id` já
    /// estava ocupado). O chamador fornece a posição; use [`SurfaceItemRecord::new`].
    pub fn insert_surface_item(&self, item: &SurfaceItemRecord) -> anyhow::Result<bool> {
        if item.id.trim().is_empty() {
            return Err(anyhow::anyhow!("o item de superfície precisa de um id"));
        }
        if item.conversation_id.trim().is_empty() {
            return Err(anyhow::anyhow!("o item de superfície precisa de uma conversa"));
        }
        if item.kind.trim().is_empty() {
            return Err(anyhow::anyhow!("o item de superfície precisa de um tipo"));
        }
        if item.digest.trim().is_empty() {
            return Err(anyhow::anyhow!("o item de superfície precisa de um digest"));
        }
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO surface_items (id, conversation_id, after_message_id, \
                 after_step, seq, kind, digest, text, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    &item.id,
                    &item.conversation_id,
                    &item.after_message_id,
                    item.after_step.map(i64::from),
                    i64::from(item.seq),
                    &item.kind,
                    &item.digest,
                    &item.text,
                    item.created_at,
                ],
            )
            .context("falha ao inserir o item de superfície")?;
        Ok(changed == 1)
    }

    /// Itens da conversa em ordem de append (ordem de inserção no banco, que é a
    /// ordem em que a superfície cresceu). O harness posiciona cada item no
    /// replay pelo par `(after_message_id, after_step, seq)`.
    pub fn list_surface_items(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<Vec<SurfaceItemRecord>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {SURFACE_ITEM_COLUMNS} FROM surface_items \
             WHERE conversation_id = ?1 ORDER BY rowid ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([conversation_id], |row| surface_item_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar os itens de superfície")
    }

    /// Remove um item de superfície pelo id (restrito à conversa). `false`
    /// quando não existia.
    pub fn delete_surface_item(
        &self,
        conversation_id: &str,
        id: &str,
    ) -> anyhow::Result<bool> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "DELETE FROM surface_items WHERE conversation_id = ?1 AND id = ?2",
                params![conversation_id, id],
            )
            .context("falha ao remover o item de superfície")?;
        Ok(changed > 0)
    }

    /// Remove os itens ancorados na mensagem `message_id` **ou depois dela** no
    /// replay — mesma ordem `(created_at, id)` usada pela poda de mensagens —,
    /// limpando os órfãos quando a cauda é cancelada/regenerada/truncada
    /// (PLAN §4.4). Itens sem âncora (`after_message_id = NULL`, início do
    /// replay) e itens ancorados em mensagens anteriores ficam. Devolve quantos
    /// itens foram removidos. Se a âncora já não existir, remove apenas os itens
    /// que apontam diretamente para ela (idempotente).
    pub fn delete_surface_items_after(
        &self,
        conversation_id: &str,
        message_id: &str,
    ) -> anyhow::Result<usize> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let anchor_created_at: Option<i64> = tx
            .query_row(
                "SELECT created_at FROM messages WHERE id = ?1 AND conversation_id = ?2",
                params![message_id, conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("falha ao localizar a mensagem âncora dos itens de superfície")?;
        let removed = match anchor_created_at {
            Some(created_at) => tx.execute(
                "DELETE FROM surface_items WHERE conversation_id = ?1 AND after_message_id IN (\
                   SELECT id FROM messages WHERE conversation_id = ?1 \
                     AND (created_at > ?2 OR (created_at = ?2 AND id >= ?3)))",
                params![conversation_id, created_at, message_id],
            ),
            None => tx.execute(
                "DELETE FROM surface_items WHERE conversation_id = ?1 AND after_message_id = ?2",
                params![conversation_id, message_id],
            ),
        }
        .context("falha ao remover os itens de superfície da cauda")?;
        tx.commit()?;
        Ok(removed)
    }

    /// Grava (ou substitui) o `prompt_snapshot` congelado de uma sessão. O par
    /// `(conversation_id, snapshot_key)` identifica o snapshot; um novo upsert
    /// substitui o conteúdo (usado na invalidação explícita com epoch novo).
    pub fn upsert_prompt_snapshot(
        &self,
        snapshot: &PromptSnapshotRecord,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO prompt_snapshots (conversation_id, snapshot_key, provider_id, \
             model_id, profile, workspace_id, prompt_version, system_text, tools_json, \
             stable_hash, tools_hash, created_at, invalidated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
             ON CONFLICT(conversation_id, snapshot_key) DO UPDATE SET \
               provider_id = excluded.provider_id, \
               model_id = excluded.model_id, \
               profile = excluded.profile, \
               workspace_id = excluded.workspace_id, \
               prompt_version = excluded.prompt_version, \
               system_text = excluded.system_text, \
               tools_json = excluded.tools_json, \
               stable_hash = excluded.stable_hash, \
               tools_hash = excluded.tools_hash, \
               created_at = excluded.created_at, \
               invalidated_at = excluded.invalidated_at",
            params![
                &snapshot.conversation_id,
                &snapshot.snapshot_key,
                &snapshot.provider_id,
                &snapshot.model_id,
                &snapshot.profile,
                &snapshot.workspace_id,
                snapshot.prompt_version,
                &snapshot.system_text,
                &snapshot.tools_json,
                &snapshot.stable_hash,
                &snapshot.tools_hash,
                snapshot.created_at,
                snapshot.invalidated_at,
            ],
        )
        .context("falha ao gravar o snapshot de prompt da sessão")?;
        Ok(())
    }

    /// Snapshot de prompt congelado de uma sessão (`snapshot_key` específica).
    pub fn get_prompt_snapshot(
        &self,
        conversation_id: &str,
        snapshot_key: &str,
    ) -> anyhow::Result<Option<PromptSnapshotRecord>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT {PROMPT_SNAPSHOT_COLUMNS} FROM prompt_snapshots \
             WHERE conversation_id = ?1 AND snapshot_key = ?2"
        );
        conn.query_row(&sql, params![conversation_id, snapshot_key], |row| {
            prompt_snapshot_from_row(row)
        })
        .optional()
        .context("falha ao ler o snapshot de prompt da sessão")
    }

    /// Grava (ou substitui) a decisão de render congelada de
    /// `(message_id, kind)`. Replay usa [`Db::get_render_decision`] /
    /// [`Db::list_render_decisions`] e nunca recalcula uma mensagem já enviada.
    pub fn upsert_render_decision(
        &self,
        decision: &RenderDecisionRecord,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO render_decisions (message_id, kind, digest, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(message_id, kind) DO UPDATE SET \
               digest = excluded.digest, \
               payload = excluded.payload, \
               created_at = excluded.created_at",
            params![
                &decision.message_id,
                &decision.kind,
                &decision.digest,
                &decision.payload,
                decision.created_at,
            ],
        )
        .context("falha ao gravar a decisão de render")?;
        Ok(())
    }

    /// Decisão de render congelada de uma mensagem para um tipo (`image`,
    /// `document`, `attachment`, `replay`), ou `None` se ainda não existe.
    pub fn get_render_decision(
        &self,
        message_id: &str,
        kind: &str,
    ) -> anyhow::Result<Option<RenderDecisionRecord>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT message_id, kind, digest, payload, created_at FROM render_decisions \
             WHERE message_id = ?1 AND kind = ?2",
            params![message_id, kind],
            |row| render_decision_from_row(row),
        )
        .optional()
        .context("falha ao ler a decisão de render")
    }

    /// Todas as decisões de render congeladas de uma mensagem (replay v2).
    pub fn list_render_decisions(
        &self,
        message_id: &str,
    ) -> anyhow::Result<Vec<RenderDecisionRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT message_id, kind, digest, payload, created_at FROM render_decisions \
             WHERE message_id = ?1 ORDER BY kind ASC",
        )?;
        let rows = stmt.query_map([message_id], |row| render_decision_from_row(row))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar as decisões de render da mensagem")
    }

    /// Deletes every conversation, message, attachment, artifact, code-harness
    /// record (workspaces/journal/eventos/resumos/regras), prompt-cache record
    /// (snapshots/decisões de render/surface/estado/amostras) and meta key.
    pub fn reset(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        for table in [
            "messages",
            "artifacts",
            "attachments",
            "usage_log",
            "render_decisions",
            "surface_items",
            "cache_samples",
            "cache_state",
            "prompt_snapshots",
            "code_events",
            "file_journal",
            "session_summaries",
            "approval_rules",
            "workspaces",
            "agent_routine_runs",
            "conversations",
            "meta",
        ] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .with_context(|| format!("falha ao limpar a tabela {table}"))?;
        }
        tx.commit()?;
        // Agents survive a data reset; give each one a fresh primary
        // conversation and repoint its routines.
        backfill_agent_main_conversations(&conn)?;
        conn.execute(
            "UPDATE agent_routines SET last_status = NULL, last_error = NULL",
            [],
        )?;
        Ok(())
    }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        CacheBreakReason, CacheState, Citation, MessageStatus, SegmentKind, ToolCallRecord,
        ToolCallStatus, TraceStep, TurnKind,
    };

    fn test_db() -> Db {
        Db::open_in_memory().expect("in-memory database")
    }

    fn agent_input(name: &str) -> AgentInput {
        AgentInput {
            name: name.to_string(),
            role: "Engenheiro".to_string(),
            description: "Cuida do backend.".to_string(),
            avatar: crate::agents::AgentAvatar::emoji("🛠️"),
            department: "Engenharia".to_string(),
            provider_id: "opencode-go".to_string(),
            model_id: "glm-5.3-flash".to_string(),
            fallback_provider_id: None,
            fallback_model_id: None,
            reasoning: None,
            instructions: "Seja direto.".to_string(),
            starters: vec!["Analise o projeto.".to_string()],
            capabilities: crate::agents::AgentCapabilities::default(),
            memory_enabled: false,
            workspace_id: None,
            permission_mode: crate::domain::PermissionMode::Edit,
            docker_image: None,
            computer_environment: "auto".to_string(),
        }
    }

    #[test]
    fn agents_crud_prompt_version_and_thread_aggregate() {
        let db = test_db();
        let created = db.create_agent(&agent_input("Irineu")).expect("create agent");
        assert_eq!(created.name, "Irineu");
        assert_eq!(created.prompt_version, 1);
        assert_eq!(created.thread_count, 1);
        assert_eq!(db.list_agents(false).expect("list").len(), 1);

        let mut edit = agent_input("Irineu");
        edit.instructions = "Seja ainda mais direto.".to_string();
        let updated = db.update_agent(&created.id, &edit).expect("update");
        assert_eq!(updated.prompt_version, 2);
        // Pinning is not a prompt change.
        let pinned = db.set_agent_pinned(&created.id, true).expect("pin");
        assert!(pinned.pinned);
        assert_eq!(pinned.prompt_version, 2);
        // Changing only the model does not rebuild the prompt.
        let mut model_edit = agent_input("Irineu");
        model_edit.instructions = updated.instructions.clone();
        model_edit.model_id = "deepseek-v4.1-flash".to_string();
        let model_updated = db.update_agent(&created.id, &model_edit).expect("model update");
        assert_eq!(model_updated.prompt_version, 2);
    }

    #[test]
    fn migrates_legacy_agent_emoji_to_avatar_and_drops_the_column() {
        let conn = Connection::open_in_memory().expect("in-memory connection");
        conn.execute_batch(SCHEMA).expect("schema");
        conn.execute("ALTER TABLE agents DROP COLUMN avatar_json", [])
            .expect("drop avatar_json");
        conn.execute(
            "ALTER TABLE agents ADD COLUMN emoji TEXT NOT NULL DEFAULT '🤖'",
            [],
        )
        .expect("add emoji");
        conn.execute(
            "INSERT INTO agents (id, name, role, provider_id, model_id, emoji, created_at, updated_at) \
             VALUES ('legacy-agent', 'Legacy', 'Assistant', 'opencode-go', 'glm-5.3-flash', '🛠️', 1, 1)",
            [],
        )
        .expect("legacy row");

        Db::init_connection(&conn).expect("migration");
        Db::init_connection(&conn).expect("idempotent migration");

        let columns = table_columns(&conn, "agents").expect("columns");
        assert!(!columns.iter().any(|(name, _)| name == "emoji"));
        let raw: String = conn
            .query_row(
                "SELECT avatar_json FROM agents WHERE id = 'legacy-agent'",
                [],
                |row| row.get(0),
            )
            .expect("avatar_json");
        let avatar: crate::agents::AgentAvatar = serde_json::from_str(&raw).expect("avatar");
        match &avatar.source {
            crate::agents::AgentAvatarSource::Emoji { value } => assert_eq!(value, "🛠️"),
            other => panic!("unexpected avatar: {other:?}"),
        }
        assert_eq!(avatar.shape, crate::agents::AgentAvatarShape::Rounded);

        let db = Db {
            conn: parking_lot::Mutex::new(conn),
        };
        let agent = db
            .get_agent("legacy-agent")
            .expect("get legacy")
            .expect("legacy row preserved");
        assert_eq!(agent.avatar, avatar);
    }

    #[test]
    fn update_agent_avatar_persists_without_bumping_prompt_version() {
        let db = test_db();
        let created = db.create_agent(&agent_input("Irineu")).expect("create");
        assert_eq!(created.avatar, crate::agents::AgentAvatar::emoji("🛠️"));
        let avatar = crate::agents::AgentAvatar::image("data:image/png;base64,AAAA");
        let updated = db
            .update_agent_avatar(&created.id, &avatar)
            .expect("avatar update");
        assert_eq!(updated.avatar, avatar);
        assert_eq!(updated.prompt_version, created.prompt_version);

        let mut edit = agent_input("Irineu");
        edit.avatar = crate::agents::AgentAvatar::default();
        let full = db.update_agent(&created.id, &edit).expect("full update");
        assert_eq!(full.avatar, crate::agents::AgentAvatar::default());
    }

    #[test]
    fn agent_routines_crud_and_due_selection() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Irineu")).expect("agent");
        let input = crate::agents::AgentRoutineInput {
            title: "Resumo".to_string(),
            prompt: "Liste as mudanças.".to_string(),
            schedule_kind: "interval".to_string(),
            interval_minutes: 60,
            hour: 9,
            minute: 0,
            days_of_week: crate::agents::AGENT_ROUTINE_ALL_DAYS,
            enabled: true,
            trigger_kind: "schedule".to_string(),
            event_kind: String::new(),
            event_filter_json: "{}".to_string(),
        };
        let now = now_ms();
        let routine = db
            .create_agent_routine(&agent.id, &input, now)
            .expect("routine");
        assert!(routine.next_run_at > now);
        assert_eq!(db.list_agent_routines(&agent.id).expect("list").len(), 1);
        assert_eq!(db.list_due_agent_routines(now).expect("due").len(), 0);
        assert_eq!(
            db.list_due_agent_routines(routine.next_run_at + 1)
                .expect("due")
                .len(),
            1
        );

        let mut edit = input.clone();
        edit.title = "Resumo diário".to_string();
        edit.days_of_week = 31;
        let updated = db
            .update_agent_routine(&routine.id, &edit, now)
            .expect("update");
        assert_eq!(updated.title, "Resumo diário");
        assert_eq!(updated.days_of_week, 31);
        let disabled = db
            .set_agent_routine_enabled(&routine.id, false, now)
            .expect("disable");
        assert!(!disabled.enabled);
        assert_eq!(
            db.list_due_agent_routines(now + 10 * 60 * 60 * 1000)
                .expect("due")
                .len(),
            0
        );
        db.delete_agent_routine(&routine.id).expect("delete");
        assert!(db.list_agent_routines(&agent.id).expect("list").is_empty());
    }

    #[test]
    fn list_all_agent_routines_across_agents() {
        let db = test_db();
        let first = db.create_agent(&agent_input("Ana")).expect("agent");
        let second = db.create_agent(&agent_input("Bia")).expect("agent");
        let input = |title: &str| crate::agents::AgentRoutineInput {
            title: title.to_string(),
            prompt: "Resuma o dia.".to_string(),
            schedule_kind: "interval".to_string(),
            interval_minutes: 60,
            hour: 9,
            minute: 0,
            days_of_week: crate::agents::AGENT_ROUTINE_ALL_DAYS,
            enabled: true,
            trigger_kind: "schedule".to_string(),
            event_kind: String::new(),
            event_filter_json: "{}".to_string(),
        };
        let first_routine = db
            .create_agent_routine(&first.id, &input("Primeira"), now_ms())
            .expect("first routine");
        let second_routine = db
            .create_agent_routine(&second.id, &input("Segunda"), now_ms() + 1)
            .expect("second routine");

        let all = db.list_all_agent_routines().expect("all routines");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, first_routine.id);
        assert_eq!(all[1].id, second_routine.id);
        assert_eq!(all[0].days_of_week, crate::agents::AGENT_ROUTINE_ALL_DAYS);
    }

    #[test]
    fn agent_main_conversation_is_created_pinned_and_protected() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Ana")).expect("agent");
        let main = db
            .get_agent_main_conversation(&agent.id)
            .expect("main")
            .expect("primary exists");
        assert_eq!(main.title, "Conversa principal");
        assert!(main.is_main);
        assert!(main.pinned);
        assert_eq!(main.agent_id.as_deref(), Some(agent.id.as_str()));
        assert_eq!(main.provider_id, agent.provider_id);
        assert_eq!(main.model_id, agent.model_id);
        assert_eq!(agent.thread_count, 1);
        assert_eq!(
            db.ensure_agent_main_conversation(&agent.id)
                .expect("ensure")
                .id,
            main.id
        );
        let error = db.set_pinned(&main.id, false).expect_err("unpin");
        assert!(format!("{error:#}").contains("CONVERSATION_MAIN"));
        let error = db.delete_conversation(&main.id).expect_err("delete");
        assert!(format!("{error:#}").contains("CONVERSATION_MAIN"));

        db.delete_agent(&agent.id).expect("delete agent");
        assert!(db.get_agent(&agent.id).expect("get").is_none());
        assert!(db.get_conversation(&main.id).expect("conversation").is_none());
    }

    #[test]
    fn ensure_agent_main_conversation_recreates_a_missing_primary() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Bia")).expect("agent");
        let first = db
            .get_agent_main_conversation(&agent.id)
            .expect("main")
            .expect("primary");
        db.delete_conversation_inner(&first.id, true)
            .expect("force delete primary");
        let second = db
            .ensure_agent_main_conversation(&agent.id)
            .expect("ensure");
        assert_ne!(first.id, second.id);
        assert!(second.is_main);
        let count: i64 = db
            .conn
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE agent_id = ?1 AND is_main = 1",
                [&agent.id],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 1);
    }

    #[test]
    fn update_agent_syncs_only_an_empty_primary_route() {
        use crate::domain::PermissionMode;

        let db = test_db();
        let agent = db.create_agent(&agent_input("Caio")).expect("agent");
        let main = db
            .get_agent_main_conversation(&agent.id)
            .expect("main")
            .expect("primary");
        let mut edit = agent_input("Caio");
        edit.provider_id = "opencode-zen".to_string();
        edit.model_id = "deepseek-v4.1-flash".to_string();
        edit.workspace_id = Some("ws-main".to_string());
        edit.permission_mode = PermissionMode::ReadOnly;
        db.update_agent(&agent.id, &edit).expect("update");
        let synced = db.get_conversation(&main.id).expect("conversation").unwrap();
        assert_eq!(synced.provider_id, "opencode-zen");
        assert_eq!(synced.model_id, "deepseek-v4.1-flash");
        assert_eq!(synced.workspace_id.as_deref(), Some("ws-main"));
        assert_eq!(synced.permission_mode, PermissionMode::ReadOnly);

        db.conn
            .lock()
            .execute(
                "UPDATE conversations SET message_count = 1 WHERE id = ?1",
                [&main.id],
            )
            .expect("mark used");
        edit.model_id = "another-model".to_string();
        db.update_agent(&agent.id, &edit).expect("update used");
        let frozen = db.get_conversation(&main.id).expect("conversation").unwrap();
        assert_eq!(frozen.model_id, "deepseek-v4.1-flash");
    }

    #[test]
    fn reset_recreates_primary_and_repoints_routines() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Dora")).expect("agent");
        let routine = db
            .create_agent_routine(
                &agent.id,
                &crate::agents::AgentRoutineInput {
                    title: "Olhar o dia".to_string(),
                    prompt: "Resuma o dia.".to_string(),
                    schedule_kind: "interval".to_string(),
                    interval_minutes: 60,
                    hour: 9,
                    minute: 0,
                    days_of_week: crate::agents::AGENT_ROUTINE_ALL_DAYS,
                    enabled: true,
                    trigger_kind: "schedule".to_string(),
                    event_kind: String::new(),
                    event_filter_json: "{}".to_string(),
                }
                .normalize()
                .expect("input"),
                now_ms(),
            )
            .expect("routine");
        let old_main = db
            .get_agent_main_conversation(&agent.id)
            .expect("main")
            .expect("primary");
        assert_eq!(
            routine.conversation_id.as_deref(),
            Some(old_main.id.as_str())
        );

        db.reset().expect("reset");
        let new_main = db
            .get_agent_main_conversation(&agent.id)
            .expect("main")
            .expect("recreated primary");
        assert_ne!(old_main.id, new_main.id);
        let persisted = db
            .get_agent_routine(&routine.id)
            .expect("routine")
            .expect("still exists");
        assert_eq!(
            persisted.conversation_id.as_deref(),
            Some(new_main.id.as_str())
        );
        assert_eq!(
            db.get_agent(&agent.id).expect("agent").unwrap().thread_count,
            1
        );
    }

    #[test]
    fn agent_routine_queue_transitions_recovery_and_cascade() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Eva")).expect("agent");
        let routine = db
            .create_agent_routine(
                &agent.id,
                &crate::agents::AgentRoutineInput {
                    title: "Fila".to_string(),
                    prompt: "Execute.".to_string(),
                    schedule_kind: "interval".to_string(),
                    interval_minutes: 60,
                    hour: 9,
                    minute: 0,
                    days_of_week: crate::agents::AGENT_ROUTINE_ALL_DAYS,
                    enabled: true,
                    trigger_kind: "schedule".to_string(),
                    event_kind: String::new(),
                    event_filter_json: "{}".to_string(),
                }
                .normalize()
                .expect("input"),
                now_ms(),
            )
            .expect("routine");
        let main = db
            .get_agent_main_conversation(&agent.id)
            .expect("main")
            .expect("primary");
        let now = now_ms();
        let scheduled_for = routine.next_run_at;
        let next = scheduled_for + 60_000;
        let item = db
            .enqueue_scheduled_agent_routine(&routine, &main.id, scheduled_for, next, now)
            .expect("enqueue");
        assert_eq!(item.status, "pending");
        assert_eq!(db.list_pending_agent_routine_queue(10).expect("pending").len(), 1);
        let queued = db.get_agent_routine(&routine.id).expect("routine").unwrap();
        assert_eq!(queued.last_status.as_deref(), Some("queued"));
        assert_eq!(queued.next_run_at, next);

        assert!(db.claim_agent_routine_queue_item(&item.id, now).expect("claim"));
        assert!(db.list_pending_agent_routine_queue(10).expect("pending").is_empty());
        db.release_agent_routine_queue_item(&item.id).expect("release");
        assert_eq!(db.list_pending_agent_routine_queue(10).expect("pending").len(), 1);
        assert!(db.claim_agent_routine_queue_item(&item.id, now).expect("claim"));
        db.recover_agent_routine_queue().expect("recover");
        let recovered = db.list_pending_agent_routine_queue(10).expect("pending");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].status, "pending");
        assert!(db.claim_agent_routine_queue_item(&item.id, now).expect("claim"));
        db.finish_agent_routine_queue_item(&item.id).expect("finish");
        assert!(db.list_pending_agent_routine_queue(10).expect("pending").is_empty());

        db.set_agent_routine_enabled(&routine.id, true, now).expect("enable");
        let manual = db
            .enqueue_agent_routine_run(&routine, &main.id, "manual", None, now, now)
            .expect("manual");
        assert_eq!(manual.source, "manual");
        db.set_agent_routine_enabled(&routine.id, false, now).expect("disable");
        assert!(db.list_pending_agent_routine_queue(10).expect("pending").is_empty());
        let paused = db.get_agent_routine(&routine.id).expect("routine").unwrap();
        assert_ne!(paused.last_status.as_deref(), Some("queued"));

        db.set_agent_routine_enabled(&routine.id, true, now).expect("enable");
        db.enqueue_agent_routine_run(&routine, &main.id, "event", None, now, now)
            .expect("event");
        db.delete_agent_routine(&routine.id).expect("delete routine");
        assert!(db.list_pending_agent_routine_queue(10).expect("pending").is_empty());
    }

    #[test]
    fn agent_channels_keep_members_messages_and_hide_private_threads() {
        let db = test_db();
        let first = db.create_agent(&agent_input("Ana")).expect("agent");
        let second = db.create_agent(&agent_input("Bia")).expect("agent");
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Lançamento".to_string(),
                    member_ids: vec![first.id.clone(), second.id.clone()],
                    leader_agent_id: None,
                },
                now_ms(),
            )
            .expect("channel");
        assert_eq!(channel.member_ids.len(), 2);
        assert_eq!(db.list_agent_channels().expect("channels").len(), 1);

        let message = db
            .append_agent_channel_message(&channel.id, "user", None, "Olá", &[], now_ms())
            .expect("message");
        assert_eq!(message.role, "user");
        assert_eq!(
            db.list_agent_channel_messages(&channel.id, Some(10))
                .expect("messages")
                .len(),
            1
        );

        let thread = db
            .get_or_create_channel_conversation(&channel.id, &first.id, "#Lançamento · Ana")
            .expect("thread");
        assert_eq!(thread.channel_id.as_deref(), Some(channel.id.as_str()));
        assert_eq!(
            db.get_agent(&first.id).expect("agent").expect("found").thread_count,
            1
        );
        let threads = db
            .list_agent_threads(&first.id, None, Some(10))
            .expect("threads")
            .items;
        assert_eq!(threads.len(), 1);
        assert!(threads[0].is_main);
        assert_eq!(
            db.get_or_create_channel_conversation(&channel.id, &first.id, "ignored")
                .expect("reuse")
                .id,
            thread.id
        );

        db.delete_agent_channel(&channel.id).expect("delete channel");
        assert!(db.list_agent_channels().expect("channels").is_empty());
        assert!(db.get_conversation(&thread.id).expect("get").is_none());
    }

    #[test]
    fn agent_channel_messages_roundtrip_attachments() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Ana")).expect("agent");
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Anexos".to_string(),
                    member_ids: vec![agent.id.clone()],
                    leader_agent_id: None,
                },
                now_ms(),
            )
            .expect("channel");
        let attachment = AttachmentInfo {
            id: "att-1".to_string(),
            name: "contrato.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            size: 2048,
            kind: "pdf".to_string(),
            page_count: Some(2),
            ..Default::default()
        };

        let message = db
            .append_agent_channel_message(
                &channel.id,
                "user",
                None,
                "olá",
                std::slice::from_ref(&attachment),
                now_ms(),
            )
            .expect("message");
        assert_eq!(message.attachments, vec![attachment.clone()]);

        let listed = db
            .list_agent_channel_messages(&channel.id, Some(10))
            .expect("messages");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].attachments, vec![attachment]);
    }

    #[test]
    fn channel_leader_is_persisted_and_cleared_on_archive() {
        let db = test_db();
        let first = db.create_agent(&agent_input("Ana")).expect("first");
        let second = db.create_agent(&agent_input("Bia")).expect("second");
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Lançamento".to_string(),
                    member_ids: vec![first.id.clone(), second.id.clone()],
                    leader_agent_id: Some(first.id.clone()),
                },
                now_ms(),
            )
            .expect("channel");
        assert_eq!(channel.leader_agent_id.as_deref(), Some(first.id.as_str()));

        let updated = db
            .update_agent_channel(
                &channel.id,
                &crate::agents::AgentChannelInput {
                    name: "Lançamento".to_string(),
                    member_ids: vec![first.id.clone(), second.id.clone()],
                    leader_agent_id: Some(second.id.clone()),
                },
                now_ms(),
            )
            .expect("update");
        assert_eq!(
            updated.leader_agent_id.as_deref(),
            Some(second.id.as_str())
        );

        db.archive_agent(&second.id).expect("archive");
        assert_eq!(
            db.get_agent_channel(&channel.id)
                .expect("reload")
                .expect("channel")
                .leader_agent_id,
            None
        );
    }

    #[test]
    fn opens_legacy_agent_channels_without_dm_key() {
        let temp = TempDir::new("zylara-db-legacy-channels");
        let path = temp.path.join("zylara.db");
        {
            let conn = rusqlite::Connection::open(&path).expect("legacy connection");
            conn.execute_batch(
                "CREATE TABLE agent_channels (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );",
            )
            .expect("legacy channels table");
        }
        let db = Db::open(&path).expect("migrate legacy channels");
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Geral".to_string(),
                    member_ids: Vec::new(),
                    leader_agent_id: None,
                },
                now_ms(),
            )
            .expect("create");
        assert_eq!(channel.kind, "channel");
    }

    #[test]
    fn migrates_legacy_agent_channel_messages_with_attachments_column() {
        let temp = TempDir::new("zylara-db-legacy-channel-messages");
        let path = temp.path.join("zylara.db");
        {
            let conn = rusqlite::Connection::open(&path).expect("legacy connection");
            conn.execute_batch(
                "CREATE TABLE agent_channels (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE agent_channel_messages (
                   id TEXT PRIMARY KEY,
                   channel_id TEXT NOT NULL,
                   role TEXT NOT NULL,
                   agent_id TEXT,
                   content TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );
                 INSERT INTO agent_channels (id, name, created_at, updated_at)
                   VALUES ('c1', 'Geral', 1, 1);
                 INSERT INTO agent_channel_messages
                   (id, channel_id, role, agent_id, content, created_at)
                   VALUES ('m1', 'c1', 'user', NULL, 'oi', 1);",
            )
            .expect("legacy channel tables");
        }

        let db = Db::open(&path).expect("migrate legacy messages");
        let messages = db
            .list_agent_channel_messages("c1", Some(10))
            .expect("messages");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].attachments.is_empty());
    }

    #[test]
    fn event_routines_are_not_scheduled_and_record_channel_events() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Eventos")).expect("agent");
        let routine = db
            .create_agent_routine(
                &agent.id,
                &crate::agents::AgentRoutineInput {
                    title: "Reagir ao canal".to_string(),
                    prompt: "Leia a mensagem.".to_string(),
                    schedule_kind: "interval".to_string(),
                    interval_minutes: 60,
                    hour: 9,
                    minute: 0,
                    days_of_week: crate::agents::AGENT_ROUTINE_ALL_DAYS,
                    enabled: true,
                    trigger_kind: "event".to_string(),
                    event_kind: "channel.message".to_string(),
                    event_filter_json: "{}".to_string(),
                }
                .normalize()
                .expect("input"),
                now_ms(),
            )
            .expect("routine");
        assert_eq!(routine.next_run_at, 0);
        assert!(db.list_due_agent_routines(now_ms()).expect("due").is_empty());
        assert_eq!(
            db.list_event_routines("channel.message")
                .expect("event routines")
                .len(),
            1
        );
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Geral".to_string(),
                    member_ids: vec![agent.id.clone()],
                    leader_agent_id: None,
                },
                now_ms(),
            )
            .expect("channel");
        db.append_agent_channel_message(&channel.id, "user", None, "oi", &[], now_ms())
            .expect("message");
        let events = db.list_unprocessed_agent_events(10).expect("events");
        assert!(events.iter().any(|event| event.kind == "channel.message"));
        assert!(events
            .iter()
            .any(|event| crate::agents::event_filter_matches(
                &routine.event_filter_json,
                &event.payload
            )));
    }

    #[test]
    fn memory_mutations_bump_the_agent_revision() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Memória")).expect("agent");
        assert_eq!(db.get_agent(&agent.id).expect("get").unwrap().memory_revision, 0);
        let memory = db
            .create_agent_memory(
                &agent.id,
                &crate::agents::AgentMemoryInput {
                    kind: "fact".to_string(),
                    content: "Prefere Rust.".to_string(),
                    source_conversation_id: None,
                    pinned: false,
                }
                .normalize()
                .expect("normalize"),
            )
            .expect("memory");
        assert_eq!(db.get_agent(&agent.id).expect("get").unwrap().memory_revision, 1);
        db.clear_agent_memories(&agent.id).expect("clear");
        assert_eq!(db.get_agent(&agent.id).expect("get").unwrap().memory_revision, 2);
        db.delete_agent_memory(&agent.id, &memory.id)
            .expect_err("memory already deleted");
    }

    #[test]
    fn shared_memories_are_global_and_keep_source_after_agent_delete() {
        let db = test_db();
        let mut input = agent_input("Compartilha");
        input.memory_enabled = true;
        input.capabilities.shared_memory = true;
        let agent = db.create_agent(&input).expect("agent");
        let memory = db
            .create_agent_shared_memory(
                &agent.id,
                &crate::agents::AgentMemoryInput {
                    kind: "procedure".to_string(),
                    content: "Revise o changelog antes do release.".to_string(),
                    source_conversation_id: None,
                    pinned: true,
                }
                .normalize()
                .expect("normalize"),
            )
            .expect("shared memory");
        assert_eq!(db.list_agent_shared_memories().expect("list").len(), 1);
        assert_eq!(
            db.get_agent_shared_memory(&memory.id)
                .expect("get")
                .expect("exists")
                .source_agent_name
                .as_deref(),
            Some("Compartilha")
        );
        db.delete_agent(&agent.id).expect("delete agent");
        assert!(db
            .get_agent_shared_memory(&memory.id)
            .expect("get")
            .expect("exists")
            .source_agent_id
            .is_none());
    }

    #[test]
    fn task_workspace_is_stored_for_handoff_continuity() {
        let db = test_db();
        let owner = db.create_agent(&agent_input("Dona")).expect("agent");
        let input = crate::agents::AgentTaskInput {
            to_agent_id: owner.id.clone(),
            title: "Workspace".to_string(),
            brief: "Compartilhe arquivos.".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            ..crate::agents::AgentTaskInput::default()
        }
        .normalize()
        .expect("input");
        let task = db
            .create_agent_task(&input, None, None, true, now_ms())
            .expect("task");
        assert_eq!(task.workspace_id.as_deref(), Some("workspace-1"));
        assert_eq!(task.retry_count, 0);
    }

    #[test]
    fn task_artifacts_are_owned_by_the_task_across_handoff() {
        let db = test_db();
        let owner = db.create_agent(&agent_input("Dona")).expect("agent");
        let input = crate::agents::AgentTaskInput {
            to_agent_id: owner.id.clone(),
            title: "Artefato".to_string(),
            brief: "Produza o arquivo.".to_string(),
            ..crate::agents::AgentTaskInput::default()
        }
        .normalize()
        .expect("input");
        let task = db
            .create_agent_task(&input, None, None, true, now_ms())
            .expect("task");
        let conversation = db
            .create_agent_conversation(&owner.id, "Tarefa: Artefato")
            .expect("conversation");
        db.set_agent_task_conversation(&task.id, &conversation.id, now_ms())
            .expect("bind");
        db.insert_artifact(&stored_artifact("art-task", &conversation.id))
            .expect("artifact");
        assert!(db
            .artifact_belongs_to_task("art-task", &task.id)
            .expect("belongs"));
        assert!(!db
            .artifact_belongs_to_task("art-task", "another-task")
            .expect("belongs"));
    }

    #[test]
    fn agent_task_conversation_binding_is_atomic_and_idempotent() {
        let db = test_db();
        let owner = db.create_agent(&agent_input("Dona")).expect("agent");
        let input = crate::agents::AgentTaskInput {
            to_agent_id: owner.id.clone(),
            title: "Vincular thread".to_string(),
            brief: "Faça algo.".to_string(),
            ..crate::agents::AgentTaskInput::default()
        }
        .normalize()
        .expect("input");
        let task = db
            .create_agent_task(&input, None, None, true, now_ms())
            .expect("task");
        let conversation = db
            .create_agent_conversation(&owner.id, "Tarefa: Vincular thread")
            .expect("conversation");

        db.set_agent_task_conversation(&task.id, &conversation.id, now_ms())
            .expect("binding");
        let bound_task = db.get_agent_task(&task.id).expect("task").expect("exists");
        assert_eq!(bound_task.conversation_id.as_deref(), Some(conversation.id.as_str()));
        let bound_conversation = db
            .get_conversation(&conversation.id)
            .expect("conversation")
            .expect("exists");
        assert_eq!(bound_conversation.task_id.as_deref(), Some(task.id.as_str()));

        db.set_agent_task_conversation(&task.id, &conversation.id, now_ms())
            .expect("idempotent");
        assert_eq!(
            db.get_agent_task(&task.id)
                .expect("task")
                .expect("exists")
                .conversation_id
                .as_deref(),
            Some(conversation.id.as_str())
        );
    }

    #[test]
    fn agent_tasks_claim_transition_handoff_and_events() {
        let db = test_db();
        let first = db.create_agent(&agent_input("Ana")).expect("agent");
        let second = db.create_agent(&agent_input("Bia")).expect("agent");
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Entrega".to_string(),
                    member_ids: vec![first.id.clone(), second.id.clone()],
                    leader_agent_id: None,
                },
                now_ms(),
            )
            .expect("channel");
        let input = crate::agents::AgentTaskInput {
            to_agent_id: second.id.clone(),
            title: "Revisar contrato".to_string(),
            brief: "Leia o contrato e liste riscos.".to_string(),
            acceptance: "Lista com referência de página.".to_string(),
            channel_id: Some(channel.id.clone()),
            parent_task_id: None,
            workspace_id: None,
            max_turns: Some(4),
            max_tokens: Some(20_000),
            max_cost: Some(0.5),
            deadline_minutes: Some(30),
        }
        .normalize()
        .expect("input");
        let task = db
            .create_agent_task(&input, Some(&first.id), None, false, now_ms())
            .expect("task");
        assert_eq!(task.status, "queued");
        assert_eq!(task.owner_agent_id, second.id);
        assert_eq!(task.channel_id.as_deref(), Some(channel.id.as_str()));

        let claimed = db.claim_agent_task(&task.id, now_ms()).expect("claim");
        assert_eq!(claimed.status, "running");
        assert!(claimed.lease_until.is_some());
        assert!(db.claim_agent_task(&task.id, now_ms()).is_err());
        let lease_before = claimed.lease_until.expect("lease");
        assert!(db
            .renew_agent_task_lease(&task.id, &second.id, now_ms() + 1_000)
            .expect("renew"));
        let renewed = db
            .get_agent_task(&task.id)
            .expect("get")
            .expect("task");
        assert!(renewed.lease_until.expect("lease") > lease_before);

        let waiting = db
            .transition_agent_task(
                &task.id,
                Some(claimed.version),
                Some(&second.id),
                "waiting_approval",
                "agent",
                serde_json::json!({ "reason": "precisa de acesso" }),
                None,
                None,
                now_ms(),
            )
            .expect("waiting");
        assert_eq!(waiting.status, "waiting_approval");
        let _resumed = db
            .transition_agent_task(
                &task.id,
                Some(waiting.version),
                Some(&second.id),
                "running",
                "user",
                serde_json::json!({}),
                None,
                None,
                now_ms(),
            )
            .expect("resume");

        let conversation = db
            .create_agent_conversation(&second.id, "Tarefa: Revisar contrato")
            .expect("conversation");
        db.set_agent_task_conversation(&task.id, &conversation.id, now_ms())
            .expect("bind");

        let handoff = db
            .handoff_agent_task(
                &task.id,
                &second.id,
                &first.id,
                "agent",
                "Precisa da visão de engenharia.",
                now_ms(),
            )
            .expect("handoff");
        assert_eq!(handoff.owner_agent_id, first.id);
        assert_eq!(handoff.status, "accepted");
        assert_eq!(handoff.handoff_count, 1);
        assert_eq!(handoff.conversation_id, None);
        assert!(handoff.brief.contains("## Handoff"));
        assert!(db
            .handoff_agent_task(&task.id, &second.id, &first.id, "agent", "de novo", now_ms())
            .is_err());
        assert!(db
            .list_queued_agent_tasks(now_ms(), 10)
            .expect("queued")
            .iter()
            .any(|entry| entry.id == task.id));
        let detached = db
            .get_conversation(&conversation.id)
            .expect("conversation")
            .expect("exists");
        assert_eq!(detached.task_id, None);

        let claimed_again = db.claim_agent_task(&task.id, now_ms()).expect("claim again");
        assert_eq!(claimed_again.owner_agent_id, first.id);
        assert_eq!(claimed_again.status, "running");
        let done = db
            .transition_agent_task(
                &task.id,
                Some(claimed_again.version),
                Some(&first.id),
                "done",
                "agent",
                serde_json::json!({ "usage": { "totalTokens": 120 } }),
                Some("Contrato revisado; 3 riscos."),
                Some(&["artifact-1".to_string()]),
                now_ms(),
            )
            .expect("done");
        assert_eq!(done.status, "done");
        assert_eq!(done.result.as_deref(), Some("Contrato revisado; 3 riscos."));
        assert_eq!(done.result_artifact_ids, vec!["artifact-1".to_string()]);
        assert!(!db
            .renew_agent_task_lease(&task.id, &first.id, now_ms())
            .expect("renew after done"));
        let events = db.list_agent_task_events(&task.id).expect("events");
        assert!(events.len() >= 7);
        assert_eq!(
            db.list_agent_tasks(Some("done"), Some(&first.id), None, Some(10))
                .expect("list")
                .len(),
            1
        );
    }

    #[test]
    fn agent_task_open_limit_is_enforced_per_owner() {
        let db = test_db();
        let owner = db.create_agent(&agent_input("Owner")).expect("agent");
        for index in 0..crate::agents::AGENT_TASK_MAX_OPEN_PER_AGENT {
            let input = crate::agents::AgentTaskInput {
                to_agent_id: owner.id.clone(),
                title: format!("Tarefa {index}"),
                brief: "Faça algo.".to_string(),
                ..crate::agents::AgentTaskInput::default()
            }
            .normalize()
            .expect("input");
            db.create_agent_task(&input, None, None, true, now_ms())
                .expect("task");
        }
        let input = crate::agents::AgentTaskInput {
            to_agent_id: owner.id.clone(),
            title: "Excedente".to_string(),
            brief: "Faça algo.".to_string(),
            ..crate::agents::AgentTaskInput::default()
        }
        .normalize()
        .expect("input");
        assert!(db
            .create_agent_task(&input, None, None, true, now_ms())
            .is_err());
    }

    #[test]
    fn agent_task_sweep_fails_expired_queued_and_recovers_expired_leases() {
        let db = test_db();
        let owner = db.create_agent(&agent_input("Sweep")).expect("agent");
        let input = crate::agents::AgentTaskInput {
            to_agent_id: owner.id.clone(),
            title: "Expira".to_string(),
            brief: "Faça algo.".to_string(),
            deadline_minutes: Some(1),
            ..crate::agents::AgentTaskInput::default()
        }
        .normalize()
        .expect("input");
        let expired = db
            .create_agent_task(&input, None, None, true, now_ms())
            .expect("task");
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE agent_tasks SET deadline_at = ?1 WHERE id = ?2",
                params![now_ms() - 1_000, &expired.id],
            )
            .expect("expire");
        }
        let swept = db.sweep_agent_tasks(now_ms()).expect("sweep");
        assert!(swept.iter().any(|task| task.id == expired.id && task.status == "failed"));
        assert_eq!(
            db.get_agent_task(&expired.id)
                .expect("task")
                .expect("exists")
                .result
                .as_deref(),
            Some("AGENT_TASK_DEADLINE")
        );

        let running_input = crate::agents::AgentTaskInput {
            to_agent_id: owner.id.clone(),
            title: "Lease".to_string(),
            brief: "Faça algo.".to_string(),
            ..crate::agents::AgentTaskInput::default()
        }
        .normalize()
        .expect("input");
        let running = db
            .create_agent_task(&running_input, None, None, true, now_ms())
            .expect("task");
        let claimed = db.claim_agent_task(&running.id, now_ms()).expect("claim");
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE agent_tasks SET lease_until = ?1 WHERE id = ?2",
                params![now_ms() - 1_000, &claimed.id],
            )
            .expect("expire lease");
        }
        let swept = db.sweep_agent_tasks(now_ms()).expect("sweep");
        assert!(swept.iter().any(|task| task.id == running.id && task.status == "queued"));
    }

    #[test]
    fn computer_audit_records_actions_without_text_and_counts_limits() {
        let db = test_db();
        let now = now_ms();
        let session = db
            .get_or_create_computer_session(Some("agent-1"), "conv-1", "local", now)
            .expect("session");
        assert_eq!(session.status, "active");
        let action = db
            .insert_computer_action(
                &session.id,
                Some("agent-1"),
                "conv-1",
                "turn-1",
                "computer_type",
                "computer_type",
                &serde_json::json!({ "textLength": 12 }),
                Some("once"),
                Some("approved"),
                "ok",
                None,
                None,
                Some(12),
                now,
            )
            .expect("action");
        assert_eq!(action.redacted_text_len, Some(12));
        assert!(!serde_json::to_string(&action)
            .expect("json")
            .contains("segredo"));
        assert_eq!(
            db.count_computer_actions_for_turn("turn-1")
                .expect("count"),
            1
        );
        assert_eq!(
            db.count_computer_actions_for_agent_since("agent-1", now - 1000)
                .expect("count"),
            1
        );
        assert_eq!(
            db.list_computer_actions(Some("conv-1"), Some(10))
                .expect("list")
                .len(),
            1
        );
        db.end_computer_session("conv-1", "completed", now + 1)
            .expect("end");
        assert_eq!(
            db.list_computer_sessions("conv-1").expect("sessions")[0].status,
            "completed"
        );
    }

    #[test]
    fn turn_events_are_persisted_in_order_and_pruned() {
        let db = test_db();
        let now = now_ms();
        db.append_turn_event("turn-1", 1, "conv-1", r#"{"type":"step_started"}"#, now)
            .expect("event 1");
        db.append_turn_event("turn-1", 2, "conv-1", r#"{"type":"text_delta"}"#, now)
            .expect("event 2");
        db.append_turn_event(
            "turn-2",
            1,
            "conv-1",
            r#"{"type":"turn_started"}"#,
            now + 1,
        )
        .expect("event turn-2");
        assert_eq!(
            db.last_turn_id("conv-1").expect("last turn").as_deref(),
            Some("turn-2")
        );
        assert!(db.last_turn_id("conv-9").expect("sem eventos").is_none());
        let events = db.list_turn_events("turn-1", None).expect("list");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, 1);
        assert_eq!(events[1].0, 2);
        assert_eq!(
            db.list_turn_events("turn-1", Some(1))
                .expect("after")
                .len(),
            1
        );
        assert_eq!(
            db.prune_turn_events(now + 1).expect("prune"),
            2
        );
        assert!(db.list_turn_events("turn-1", None).expect("empty").is_empty());
    }

    #[test]
    fn agent_computer_environment_roundtrips_and_routine_runs_are_logged() {
        let db = test_db();
        let created = db.create_agent(&agent_input("Navegador")).expect("agent");
        assert_eq!(created.computer_environment, "auto");
        let mut input = agent_input("Navegador");
        input.computer_environment = "private_desktop".to_string();
        let updated = db.update_agent(&created.id, &input).expect("update");
        assert_eq!(updated.computer_environment, "private_desktop");

        let routine = db
            .create_agent_routine(
                &created.id,
                &crate::agents::AgentRoutineInput {
                    title: "Olhar o dia".to_string(),
                    prompt: "Resuma o dia.".to_string(),
                    schedule_kind: "interval".to_string(),
                    interval_minutes: 15,
                    hour: 9,
                    minute: 0,
                    days_of_week: crate::agents::AGENT_ROUTINE_ALL_DAYS,
                    enabled: true,
                    trigger_kind: "schedule".to_string(),
                    event_kind: String::new(),
                    event_filter_json: "{}".to_string(),
                }
                .normalize()
                .expect("routine input"),
                now_ms(),
            )
            .expect("routine");
        let run_id = db
            .start_agent_routine_run(&routine.id, None, now_ms())
            .expect("run");
        db.finish_agent_routine_run(&run_id, "error", Some("falhou"), now_ms())
            .expect("finish");
        let runs = db
            .list_agent_routine_runs(&routine.id, Some(10))
            .expect("runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "error");
        assert_eq!(runs[0].error.as_deref(), Some("falhou"));
        assert!(runs[0].ended_at.is_some());
    }

    #[test]
    fn computer_audit_pending_action_is_finished_or_interrupted() {
        let db = test_db();
        let now = now_ms();
        let session = db
            .get_or_create_computer_session(None, "conv-2", "local", now)
            .expect("session");
        let pending = db
            .begin_computer_action(
                &session.id,
                None,
                "conv-2",
                "turn-2",
                "computer_click",
                "computer_click",
                &serde_json::json!({ "x": 10, "y": 20 }),
                None,
                "human",
                now,
            )
            .expect("begin");
        assert_eq!(pending.result, "pending");
        assert_eq!(pending.initiator.as_deref(), Some("human"));
        assert!(pending.ended_at.is_none());
        db.finish_computer_action(
            &pending.id,
            "ok",
            None,
            None,
            Some("approved"),
            Some("once"),
            now + 1,
        )
        .expect("finish");
        let actions = db.list_computer_actions(Some("conv-2"), Some(10)).expect("list");
        assert_eq!(actions[0].result, "ok");
        assert_eq!(actions[0].decision.as_deref(), Some("approved"));
        assert!(actions[0].ended_at.is_some());

        let stale = db
            .begin_computer_action(
                &session.id,
                None,
                "conv-2",
                "turn-3",
                "computer_type",
                "computer_type",
                &serde_json::json!({ "textLength": 4 }),
                Some(4),
                "goal_round",
                now,
            )
            .expect("begin stale");
        assert_eq!(
            db.interrupt_pending_computer_actions(now + 2)
                .expect("interrupt"),
            1
        );
        let actions = db.list_computer_actions(Some("conv-2"), Some(10)).expect("list");
        assert!(actions
            .iter()
            .any(|action| action.id == stale.id && action.result == "interrupted"));
    }

    #[test]
    fn agent_daily_usage_ignores_rows_before_the_window() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Diário")).expect("agent");
        let conversation = db
            .create_agent_conversation(&agent.id, "Thread")
            .expect("thread");
        let usage = UsageInfo {
            input_tokens: Some(10),
            output_tokens: Some(5),
            total_tokens: Some(15),
            cost: Some(0.5),
            ..UsageInfo::default()
        };
        db.record_usage(
            &conversation.id,
            "old",
            "opencode-go",
            "glm-5.3-flash",
            &usage,
        )
        .expect("old usage");
        db.record_usage(
            &conversation.id,
            "today",
            "opencode-go",
            "glm-5.3-flash",
            &usage,
        )
        .expect("today usage");
        let now = now_ms();
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE usage_log SET created_at = ?1 WHERE message_id = 'old'",
                [now - 86_400_000],
            )
            .expect("shift old usage");
        }
        let all = db.get_agent_usage(&agent.id).expect("all usage");
        assert_eq!(all.turns, 2);
        let today = db
            .agent_usage_since(&agent.id, crate::domain::local_day_start_ms(now))
            .expect("daily usage");
        assert_eq!(today.turns, 1);
        assert_eq!(today.total_tokens, 15);
        assert!((today.cost - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn agent_usage_aggregates_tokens_and_cost_per_agent() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Uso")).expect("agent");
        let other = db.create_agent(&agent_input("Outro")).expect("agent");
        let first = db
            .create_agent_conversation(&agent.id, "Thread 1")
            .expect("thread");
        let second = db
            .create_agent_conversation(&agent.id, "Thread 2")
            .expect("thread");
        let other_thread = db
            .create_agent_conversation(&other.id, "Thread 3")
            .expect("thread");
        let usage = |input: u32, output: u32, cost: f64| UsageInfo {
            input_tokens: Some(input),
            output_tokens: Some(output),
            reasoning_tokens: Some(5),
            total_tokens: Some(input + output + 5),
            cost: Some(cost),
            ..UsageInfo::default()
        };
        db.record_usage(&first.id, "m1", "opencode-go", "glm-5.3-flash", &usage(100, 20, 0.5))
            .expect("usage 1");
        db.record_usage(&second.id, "m2", "opencode-go", "glm-5.3-flash", &usage(50, 10, 0.25))
            .expect("usage 2");
        db.record_usage(
            &other_thread.id,
            "m3",
            "opencode-go",
            "glm-5.3-flash",
            &usage(1_000, 1_000, 9.0),
        )
        .expect("usage 3");

        let aggregate = db.get_agent_usage(&agent.id).expect("usage");
        assert_eq!(aggregate.turns, 2);
        assert_eq!(aggregate.input_tokens, 150);
        assert_eq!(aggregate.output_tokens, 30);
        assert_eq!(aggregate.reasoning_tokens, 10);
        assert_eq!(aggregate.total_tokens, 190);
        assert!((aggregate.cost - 0.75).abs() < f64::EPSILON);
        assert!(aggregate.last_used_at.is_some());
        assert_eq!(
            db.get_agent_usage(&other.id).expect("usage").turns,
            1
        );
        // An agent without turns still gets a zeroed, correctly keyed row.
        let untouched = db.create_agent(&agent_input("Sem uso")).expect("agent");
        let empty = db.get_agent_usage(&untouched.id).expect("usage");
        assert_eq!(empty.agent_id, untouched.id);
        assert_eq!(empty.turns, 0);
        assert_eq!(empty.total_tokens, 0);
    }

    #[test]
    fn agent_threads_are_linked_paginated_and_delete_is_restricted() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Lívia")).expect("agent");
        let first = db
            .create_agent_conversation(&agent.id, "Primeira")
            .expect("thread");
        let second = db
            .create_agent_conversation(&agent.id, "Segunda")
            .expect("thread");
        assert_eq!(first.mode, CONVERSATION_MODE_AGENT);
        assert_eq!(first.agent_id.as_deref(), Some(agent.id.as_str()));
        assert_eq!(db.list_agent_threads(&agent.id, None, Some(1)).expect("page").items.len(), 1);
        assert!(db.list_agent_threads(&agent.id, None, Some(1)).expect("page").has_more);
        assert_eq!(db.get_agent(&agent.id).expect("get").unwrap().thread_count, 3);

        assert!(db.delete_agent(&agent.id).is_err());
        db.delete_conversation(&first.id).expect("delete first");
        db.delete_conversation(&second.id).expect("delete second");
        db.delete_agent(&agent.id).expect("delete agent");
        assert!(db.list_agents(false).expect("list").is_empty());
    }

    #[test]
    fn archived_agent_delete_removes_its_conversations() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Nina")).expect("agent");
        let main = db
            .get_agent_main_conversation(&agent.id)
            .expect("main")
            .expect("primary exists");
        let extra = db
            .create_agent_conversation(&agent.id, "Extra")
            .expect("thread");
        db.archive_agent(&agent.id).expect("archive");

        db.delete_agent(&agent.id).expect("delete archived agent");
        assert!(db.get_agent(&agent.id).expect("get").is_none());
        assert!(db.get_conversation(&main.id).expect("main").is_none());
        assert!(db.get_conversation(&extra.id).expect("extra").is_none());
        assert!(db.list_conversations().expect("list").is_empty());
    }

    #[test]
    fn archived_agent_cannot_start_a_new_thread_and_is_restorable() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Ravi")).expect("agent");
        let archived = db.archive_agent(&agent.id).expect("archive");
        assert!(archived.archived_at.is_some());
        assert!(db.create_agent_conversation(&agent.id, "Nova").is_err());
        assert_eq!(db.list_agents(false).expect("active").len(), 0);
        assert_eq!(db.list_agents(true).expect("all").len(), 1);
        let restored = db.restore_agent(&agent.id).expect("restore");
        assert!(restored.archived_at.is_none());
        db.create_agent_conversation(&agent.id, "Nova").expect("thread");
    }

    fn user_message(conversation_id: &str, content: &str, created_at: i64) -> ChatMessage {
        let mut message = ChatMessage::user(conversation_id, content);
        message.created_at = created_at;
        message
    }

    fn assistant_message(conversation_id: &str, created_at: i64) -> ChatMessage {
        let mut message = ChatMessage::assistant(conversation_id);
        message.created_at = created_at;
        message
    }

    fn stored_attachment(id: &str, text: &str) -> StoredAttachment {
        StoredAttachment {
            id: id.to_string(),
            name: "nota.txt".to_string(),
            mime_type: "text/plain".to_string(),
            size: 42,
            kind: "text".to_string(),
            text: text.to_string(),
            page_count: None,
            width: None,
            height: None,
            file_path: Some(format!("attachments/{id}.txt")),
            created_at: 1_700_000_000_000,
        }
    }

    fn stored_artifact(id: &str, conversation_id: &str) -> StoredArtifact {
        StoredArtifact {
            artifact: Artifact {
                id: id.to_string(),
                conversation_id: Some(conversation_id.to_string()),
                message_id: None,
                name: "resumo.md".to_string(),
                mime_type: "text/markdown".to_string(),
                kind: ArtifactKind::Markdown,
                language: None,
                size: 12,
                created_at: 1_700_000_000_000,
                favorite: false,
            },
            path: std::env::temp_dir()
                .join("zylara-db-tests")
                .join("artifacts")
                .join(id)
                .join("resumo.md")
                .to_string_lossy()
                .to_string(),
        }
    }

    /// Artefato enviado pelo usuário direto à Biblioteca: não tem conversa.
    fn library_artifact(id: &str, name: &str, created_at: i64) -> StoredArtifact {
        StoredArtifact {
            artifact: Artifact {
                id: id.to_string(),
                conversation_id: None,
                message_id: None,
                name: name.to_string(),
                mime_type: "application/pdf".to_string(),
                kind: ArtifactKind::Pdf,
                language: None,
                size: 4_096,
                created_at,
                favorite: false,
            },
            path: std::env::temp_dir()
                .join("zylara-db-tests")
                .join("artifacts")
                .join(id)
                .join(name)
                .to_string_lossy()
                .to_string(),
        }
    }

    #[test]
    fn creates_and_lists_conversations() {
        let db = test_db();
        let conversation = db
            .create_conversation("Primeira", "opencode-go", "glm-5.3-flash")
            .expect("create conversation");
        assert_eq!(conversation.title, "Primeira");
        assert_eq!(conversation.provider_id, "opencode-go");
        assert_eq!(conversation.model_id, "glm-5.3-flash");
        assert!(!conversation.pinned);
        assert_eq!(conversation.message_count, 0);
        assert!(conversation.preview.is_none());

        // Empty titles fall back to the default label.
        let untitled = db
            .create_conversation("   ", "opencode-go", "glm-5.3-flash")
            .expect("create untitled");
        assert_eq!(untitled.title, "Nova conversa");

        let listed = db.list_conversations().expect("list");
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn messages_roundtrip_and_conversation_stats() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");

        let mut user = user_message(&conversation.id, "  Olá   mundo, tudo bem?  ", 1_000);
        user.citations = vec![Citation {
            id: "c1".to_string(),
            title: "Exemplo".to_string(),
            url: "https://example.com".to_string(),
            snippet: None,
            site_name: None,
        }];
        db.insert_message(&user).expect("insert user");

        let mut assistant = assistant_message(&conversation.id, 2_000);
        assistant.content = "Tudo ótimo!".to_string();
        assistant.status = MessageStatus::Complete;
        assistant.model_id = Some("glm-5.3-flash".to_string());
        assistant.provider_id = Some("opencode-go".to_string());
        assistant.reasoning = Some("pensando...".to_string());
        assistant.tool_calls = vec![ToolCallRecord::running("t1", "web_search")];
        assistant.usage = Some(UsageInfo {
            input_tokens: Some(10),
            output_tokens: Some(20),
            reasoning_tokens: Some(5),
            cached_tokens: Some(2),
            cache_read_tokens: Some(2),
            cache_write_tokens: None,
            uncached_input_tokens: None,
            cache_reported: false,
            total_tokens: Some(30),
            cost: Some(0.001),
            duration_ms: Some(1500),
        });
        assistant.provider_state = Some(serde_json::json!({ "items": [1, 2, 3] }));
        assistant.trace = vec![
            TraceStep {
                reasoning: Some("vou pesquisar".to_string()),
                text: Some("narração intermediária".to_string()),
                duration_ms: Some(2_000),
                tool_calls: 1,
            },
            TraceStep {
                reasoning: Some("resumo final".to_string()),
                text: None,
                duration_ms: None,
                tool_calls: 0,
            },
        ];
        db.insert_message(&assistant).expect("insert assistant");

        let messages = db.list_messages(&conversation.id).expect("list messages");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, user.id);
        assert_eq!(messages[1].id, assistant.id);
        assert_eq!(messages[1].role, MessageRole::Assistant);
        assert_eq!(messages[1].status, MessageStatus::Complete);
        assert_eq!(messages[1].tool_calls.len(), 1);
        assert_eq!(messages[1].tool_calls[0].status, ToolCallStatus::Running);
        assert_eq!(
            messages[1].provider_state,
            Some(serde_json::json!({ "items": [1, 2, 3] }))
        );
        assert_eq!(
            messages[1].usage.as_ref().and_then(|u| u.total_tokens),
            Some(30)
        );
        assert_eq!(messages[1].trace, assistant.trace);

        let refreshed = db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("present");
        assert_eq!(refreshed.message_count, 2);
        assert_eq!(refreshed.preview.as_deref(), Some("Olá mundo, tudo bem?"));

        // Updates keep every JSON column intact.
        assistant.content = "Tudo ótimo! (editado)".to_string();
        assistant.status = MessageStatus::Cancelled;
        db.update_message(&assistant).expect("update");
        let stored = db
            .get_message(&assistant.id)
            .expect("get message")
            .expect("present");
        assert_eq!(stored.content, "Tudo ótimo! (editado)");
        assert_eq!(stored.status, MessageStatus::Cancelled);
        assert_eq!(stored.citations.len(), 0);

        assistant.status = MessageStatus::Incomplete;
        db.update_message(&assistant).expect("update incomplete");
        let stored = db
            .get_message(&assistant.id)
            .expect("get message")
            .expect("present");
        assert_eq!(stored.status, MessageStatus::Incomplete);
        assert_eq!(stored.provider_state, assistant.provider_state);
        assert_eq!(stored.trace, assistant.trace, "trace survives updates");

        // Structured failure survives every write/read path.
        assistant.error = Some(MessageError {
            message: "stream ended without finish_reason".to_string(),
            code: Some("stream_interrupted".to_string()),
            hint: Some("tente novamente".to_string()),
            retryable: true,
            retry_after_ms: Some(1_500),
            attempts: 3,
        });
        db.update_message(&assistant).expect("update with error");
        let stored = db
            .get_message(&assistant.id)
            .expect("get message")
            .expect("present");
        assert_eq!(stored.error, assistant.error);

        // update_message creates the row when it does not exist yet.
        let mut orphan = assistant_message(&conversation.id, 3_000);
        orphan.content = "recurso".to_string();
        db.update_message(&orphan).expect("upsert");
        assert!(db.get_message(&orphan.id).expect("get orphan").is_some());
    }

    #[test]
    fn migrates_legacy_databases_with_the_trace_column() {
        // A database created before the thinking trace existed.
        let conn = Connection::open_in_memory().expect("in-memory connection");
        conn.execute_batch(
            "CREATE TABLE messages (
               id              TEXT PRIMARY KEY,
               conversation_id TEXT NOT NULL,
               role            TEXT NOT NULL,
               content         TEXT NOT NULL DEFAULT '',
               reasoning       TEXT,
               status          TEXT NOT NULL,
               tool_calls      TEXT NOT NULL DEFAULT '[]',
               citations       TEXT NOT NULL DEFAULT '[]',
               attachments     TEXT NOT NULL DEFAULT '[]',
               model_id        TEXT,
               provider_id     TEXT,
               usage           TEXT,
               provider_state  TEXT,
               created_at      INTEGER NOT NULL
             );
             INSERT INTO messages (id, conversation_id, role, status, created_at)
               VALUES ('m1', 'c1', 'assistant', 'complete', 1);",
        )
        .expect("legacy schema");

        Db::init_connection(&conn).expect("migration");
        let trace: String = conn
            .query_row("SELECT trace FROM messages WHERE id = 'm1'", [], |row| row.get(0))
            .expect("trace column");
        assert_eq!(trace, "[]");
        let error: Option<String> = conn
            .query_row("SELECT error FROM messages WHERE id = 'm1'", [], |row| row.get(0))
            .expect("error column");
        assert_eq!(error, None);

        // Opening the same database again is a no-op.
        Db::init_connection(&conn).expect("idempotent migration");
    }

    /// Banco legado (anterior à separação Chat/Code): a tabela `conversations`
    /// não tem `mode` nem `code_linked`.
    fn legacy_conversations_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE conversations (
               id            TEXT PRIMARY KEY,
               title         TEXT NOT NULL,
               created_at    INTEGER NOT NULL,
               updated_at    INTEGER NOT NULL,
               pinned        INTEGER NOT NULL DEFAULT 0,
               provider_id   TEXT NOT NULL,
               model_id      TEXT NOT NULL,
               message_count INTEGER NOT NULL DEFAULT 0,
               preview       TEXT
             );
             INSERT INTO conversations
               (id, title, created_at, updated_at, pinned, provider_id, model_id,
                message_count, preview)
               VALUES ('legacy-1', 'Conversa antiga', 10, 20, 1, 'opencode-go',
                       'glm-5.3-flash', 0, NULL);",
        )
        .expect("legacy conversations schema");
    }

    #[test]
    fn migrates_legacy_conversations_to_chat_mode_preserving_rows() {
        let conn = Connection::open_in_memory().expect("in-memory connection");
        legacy_conversations_table(&conn);

        Db::init_connection(&conn).expect("migration");
        // Migração aditiva é idempotente: reabrir o banco não recria nada.
        Db::init_connection(&conn).expect("idempotent migration");

        let columns = table_columns(&conn, "conversations").expect("columns");
        assert!(columns.iter().any(|(name, _)| name == "mode"));
        assert!(columns.iter().any(|(name, _)| name == "code_linked"));

        let raw: (String, i64) = conn
            .query_row(
                "SELECT mode, code_linked FROM conversations WHERE id = 'legacy-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("legacy row migrated");
        assert_eq!(raw, ("chat".to_string(), 0));

        // O mapper e o `Conversation` devolvido ao renderer refletem a migração.
        let db = Db {
            conn: parking_lot::Mutex::new(conn),
        };
        let conversation = db
            .get_conversation("legacy-1")
            .expect("get legacy")
            .expect("legacy row preserved");
        assert_eq!(conversation.title, "Conversa antiga");
        assert!(conversation.pinned);
        assert_eq!(conversation.mode, "chat");
        assert!(!conversation.code_linked);

        let listed = db.list_conversations().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mode, "chat");
    }

    #[test]
    fn create_conversation_defaults_to_chat_mode() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        assert_eq!(conversation.mode, "chat");
        assert!(!conversation.code_linked);

        let listed = db.list_conversations().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mode, "chat");
        assert!(!listed[0].code_linked);
    }

    #[test]
    fn creates_conversations_with_code_mode_and_normalizes_invalid_modes() {
        let db = test_db();
        let code = db
            .create_conversation_with_mode("Projeto Aurora", "opencode-go", "glm-5.3-flash", "code")
            .expect("create code");
        assert_eq!(code.mode, "code");
        assert!(!code.code_linked, "sessão nova não nasce compartilhada");

        let fallback = db
            .create_conversation_with_mode("Banana", "opencode-go", "glm-5.3-flash", "banana")
            .expect("create fallback");
        assert_eq!(fallback.mode, "chat");
        let empty = db
            .create_conversation_with_mode("Vazio", "opencode-go", "glm-5.3-flash", "")
            .expect("create empty");
        assert_eq!(empty.mode, "chat");

        let listed = db.list_conversations().expect("list");
        assert_eq!(listed.len(), 3);
        let listed_code = listed
            .iter()
            .find(|conversation| conversation.id == code.id)
            .expect("code conversation listed");
        assert_eq!(listed_code.mode, "code");
        let listed_chat = listed
            .iter()
            .find(|conversation| conversation.id == fallback.id)
            .expect("chat conversation listed");
        assert_eq!(listed_chat.mode, "chat");

        // A busca também devolve o modo (colunas qualificadas do JOIN).
        let found = db.search_conversations("Projeto").expect("search code");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].mode, "code");
    }

    #[test]
    fn creates_code_conversations_with_an_explicit_permission_mode() {
        let db = test_db();
        let code = db
            .create_conversation_with_mode_and_permission(
                "Projeto Aurora",
                "opencode-go",
                "glm-5.3-flash",
                "code",
                PermissionMode::Autonomous,
            )
            .expect("create code autonomous");
        assert_eq!(code.mode, "code");
        assert_eq!(code.permission_mode, PermissionMode::Autonomous);
        assert_eq!(
            db.get_conversation_permission_mode(&code.id)
                .expect("modo persistido")
                .expect("sessão presente"),
            PermissionMode::Autonomous
        );

        // O atalho sem modo explícito continua usando o default da coluna (Editar)
        // para não mudar o contrato dos chamadores existentes.
        let chat = db
            .create_conversation_with_mode("Chat", "opencode-go", "glm-5.3-flash", "chat")
            .expect("create chat");
        assert_eq!(chat.permission_mode, PermissionMode::Edit);
    }

    #[test]
    fn links_and_unlinks_a_chat_conversation_to_code() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");

        let linked = db
            .set_conversation_code_linked(&conversation.id, true)
            .expect("link");
        assert!(linked.code_linked);
        assert_eq!(linked.mode, "chat");
        assert!(db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("present")
            .code_linked);

        let unlinked = db
            .set_conversation_code_linked(&conversation.id, false)
            .expect("unlink");
        assert!(!unlinked.code_linked);
        assert!(!db.list_conversations().expect("list")[0].code_linked);
    }

    #[test]
    fn code_conversations_cannot_be_shared_with_the_code_layout() {
        let db = test_db();
        let conversation = db
            .create_conversation_with_mode("Projeto", "opencode-go", "glm-5.3-flash", "code")
            .expect("create code");

        let error = db
            .set_conversation_code_linked(&conversation.id, true)
            .expect_err("linking a code conversation must fail");
        assert!(
            format!("{error:#}").contains("somente sessões do Chat"),
            "mensagem clara em pt-BR: {error:#}"
        );

        // Desvincular também só faz sentido para sessões do Chat.
        let unlink_error = db
            .set_conversation_code_linked(&conversation.id, false)
            .expect_err("unlinking a code conversation must fail");
        assert!(format!("{unlink_error:#}").contains("somente sessões do Chat"));
        assert!(!db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("present")
            .code_linked);
    }

    #[test]
    fn linking_an_unknown_conversation_returns_a_clear_error() {
        let db = test_db();
        let error = db
            .set_conversation_code_linked("inexistente", true)
            .expect_err("unknown conversation must fail");
        assert!(
            format!("{error:#}").contains("conversa não encontrada"),
            "mensagem clara em pt-BR: {error:#}"
        );
    }

    #[test]
    fn search_matches_title_and_message_content() {
        let db = test_db();
        let cake = db
            .create_conversation("Receita de bolo", "opencode-go", "glm-5.3-flash")
            .expect("create cake");
        let other = db
            .create_conversation("Outro assunto", "opencode-go", "glm-5.3-flash")
            .expect("create other");

        let message = user_message(&other.id, "os ingredientes secretos são...", 1_000);
        db.insert_message(&message).expect("insert");

        let by_title = db.search_conversations("bolo").expect("search title");
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].id, cake.id);

        let by_content = db
            .search_conversations("ingredientes")
            .expect("search content");
        assert_eq!(by_content.len(), 1);
        assert_eq!(by_content[0].id, other.id);

        // Wildcards are matched literally, not as LIKE patterns.
        assert!(db.search_conversations("%").expect("search %").is_empty());
        assert!(db.search_conversations("").expect("search empty").len() == 2);
        assert!(db
            .search_conversations("inexistente")
            .expect("search none")
            .is_empty());
    }

    #[test]
    fn delete_messages_from_drops_the_tail() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        let first = user_message(&conversation.id, "primeira", 1_000);
        let second = assistant_message(&conversation.id, 2_000);
        let third = user_message(&conversation.id, "terceira", 3_000);
        db.insert_message(&first).expect("insert 1");
        db.insert_message(&second).expect("insert 2");
        db.insert_message(&third).expect("insert 3");

        db.delete_messages_from(&conversation.id, &second.id)
            .expect("truncate");
        let remaining = db.list_messages(&conversation.id).expect("list");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, first.id);

        let refreshed = db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("present");
        assert_eq!(refreshed.message_count, 1);
        assert_eq!(refreshed.preview.as_deref(), Some("primeira"));

        // Unknown message id is a no-op.
        db.delete_messages_from(&conversation.id, "missing")
            .expect("noop");
        assert_eq!(db.list_messages(&conversation.id).expect("list").len(), 1);
    }

    #[test]
    fn delete_conversation_cascades_but_keeps_orphan_attachments() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        let message = user_message(&conversation.id, "oi", 1_000);
        db.insert_message(&message).expect("insert message");
        db.insert_artifact(&stored_artifact("art-1", &conversation.id))
            .expect("insert artifact");
        db.insert_attachment(&stored_attachment("att-1", "texto"))
            .expect("insert attachment");

        db.delete_conversation(&conversation.id).expect("delete");

        assert!(db
            .get_conversation(&conversation.id)
            .expect("get")
            .is_none());
        assert!(db
            .list_messages(&conversation.id)
            .expect("messages")
            .is_empty());
        assert!(db
            .list_artifacts(&conversation.id)
            .expect("artifacts")
            .is_empty());
        assert!(db.get_artifact("art-1").expect("get artifact").is_none());
        // Attachments stay behind (they are not tied to a conversation row).
        assert!(db
            .get_attachment("att-1")
            .expect("get attachment")
            .is_some());
    }

    #[test]
    fn attachments_roundtrip() {
        let db = test_db();
        let attachment = stored_attachment("att-42", "conteúdo extraído do PDF");
        db.insert_attachment(&attachment).expect("insert");
        let stored = db.get_attachment("att-42").expect("get").expect("present");
        assert_eq!(stored.name, "nota.txt");
        assert_eq!(stored.text, "conteúdo extraído do PDF");
        let info = stored.info();
        assert_eq!(info.kind, "text");
        assert_eq!(
            info.text_preview.as_deref(),
            Some("conteúdo extraído do PDF")
        );

        db.delete_attachment("att-42").expect("delete");
        assert!(db.get_attachment("att-42").expect("get").is_none());
    }

    #[test]
    fn artifacts_roundtrip() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        let artifact = stored_artifact("art-7", &conversation.id);
        db.insert_artifact(&artifact).expect("insert");

        let listed = db.list_artifacts(&conversation.id).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, ArtifactKind::Markdown);
        assert_eq!(listed[0].name, "resumo.md");

        let stored = db.get_artifact("art-7").expect("get").expect("present");
        assert_eq!(stored.path, artifact.path);

        db.delete_artifact("art-7").expect("delete");
        assert!(db.get_artifact("art-7").expect("get").is_none());
    }

    #[test]
    fn list_all_artifacts_orders_by_creation_across_conversations() {
        let db = test_db();
        let first = db
            .create_conversation("Primeira", "opencode-go", "glm-5.3-flash")
            .expect("create first");
        let second = db
            .create_conversation("Segunda", "opencode-go", "glm-5.3-flash")
            .expect("create second");

        // Inserção fora de ordem de propósito: a ordenação vem do SQL, não da
        // sequência de inserts. Dois artefatos empatam em `created_at` para
        // exercitar o desempate por `id`.
        let mut newest = stored_artifact("art-3", &first.id);
        newest.artifact.created_at = 3_000;
        let mut middle = stored_artifact("art-2", &second.id);
        middle.artifact.created_at = 2_000;
        let mut tied = stored_artifact("art-9", &first.id);
        tied.artifact.created_at = 1_000;
        let mut oldest = stored_artifact("art-1", &second.id);
        oldest.artifact.created_at = 1_000;
        for artifact in [&newest, &middle, &tied, &oldest] {
            db.insert_artifact(artifact).expect("insert artifact");
        }

        let all = db.list_all_artifacts().expect("list all");
        let ids: Vec<&str> = all.iter().map(|artifact| artifact.id.as_str()).collect();
        assert_eq!(
            ids,
            ["art-1", "art-9", "art-2", "art-3"],
            "ordem canônica created_at, id"
        );
        assert_eq!(
            all[0].conversation_id.as_deref(),
            Some(second.id.as_str()),
            "artefato da segunda conversa entra na biblioteca do usuário"
        );
        assert_eq!(all[1].conversation_id.as_deref(), Some(first.id.as_str()));
        assert_eq!(all[2].conversation_id.as_deref(), Some(second.id.as_str()));
        assert_eq!(all[3].conversation_id.as_deref(), Some(first.id.as_str()));
    }

    #[test]
    fn list_all_artifacts_is_empty_without_artifacts() {
        let db = test_db();
        assert!(
            db.list_all_artifacts().expect("list all").is_empty(),
            "sem artefatos a biblioteca do usuário é vazia"
        );

        // Uma conversa sem artefatos não inventa linhas na biblioteca global.
        db.create_conversation("Vazia", "opencode-go", "glm-5.3-flash")
            .expect("create");
        assert!(db.list_all_artifacts().expect("list all").is_empty());
    }

    #[test]
    fn list_all_artifacts_keeps_metadata_of_every_conversation() {
        let db = test_db();
        let first = db
            .create_conversation("Primeira", "opencode-go", "glm-5.3-flash")
            .expect("create first");
        let second = db
            .create_conversation("Segunda", "opencode-go", "glm-5.3-flash")
            .expect("create second");

        db.insert_artifact(&stored_artifact("art-first", &first.id))
            .expect("insert first");
        let mut artifact = stored_artifact("art-second", &second.id);
        artifact.artifact.name = "relatorio-q3.md".to_string();
        artifact.artifact.language = Some("markdown".to_string());
        db.insert_artifact(&artifact).expect("insert second");

        let all = db.list_all_artifacts().expect("list all");
        assert_eq!(all.len(), 2, "artefatos das duas conversas");
        let listed = all
            .iter()
            .find(|row| row.id == "art-second")
            .expect("artefato da segunda conversa listado");
        assert_eq!(listed.conversation_id.as_deref(), Some(second.id.as_str()));
        assert_eq!(listed.name, "relatorio-q3.md");
        assert_eq!(listed.kind, ArtifactKind::Markdown);

        // `get_artifact` continua sendo a fonte do path e dos metadados.
        let stored = db
            .get_artifact("art-second")
            .expect("get")
            .expect("artefato presente");
        assert_eq!(
            stored.artifact.conversation_id.as_deref(),
            Some(second.id.as_str())
        );
        assert_eq!(stored.artifact.name, "relatorio-q3.md");
        assert_eq!(stored.artifact.kind, ArtifactKind::Markdown);
        assert_eq!(stored.artifact.language.as_deref(), Some("markdown"));
        assert_eq!(stored.path, artifact.path, "path round-trip");
    }

    /// Todos os variants do contrato. A lista é mantida à mão de propósito: um
    /// kind novo em `domain.rs` quebra `artifact_kind_to_str` (match exaustivo)
    /// e deve ser adicionado aqui para o round-trip continuar completo.
    fn all_artifact_kinds() -> [ArtifactKind; 16] {
        [
            ArtifactKind::Markdown,
            ArtifactKind::Code,
            ArtifactKind::Text,
            ArtifactKind::Html,
            ArtifactKind::Csv,
            ArtifactKind::Json,
            ArtifactKind::Svg,
            ArtifactKind::Image,
            ArtifactKind::Pdf,
            ArtifactKind::Docx,
            ArtifactKind::Xlsx,
            ArtifactKind::Pptx,
            ArtifactKind::Audio,
            ArtifactKind::Video,
            ArtifactKind::Archive,
            ArtifactKind::Binary,
        ]
    }

    #[test]
    fn artifact_kind_slugs_roundtrip_and_match_the_ipc_json() {
        for kind in all_artifact_kinds() {
            let stored = artifact_kind_to_str(&kind);
            assert_eq!(
                artifact_kind_from_str(stored),
                kind,
                "{kind:?} não sobrevive ao round-trip pelo banco"
            );
            // A coluna `kind` precisa usar o mesmo slug que o renderer recebe
            // (`ArtifactKind` é `#[serde(rename_all = "lowercase")]`).
            assert_eq!(
                serde_json::to_value(&kind).expect("serializar kind"),
                serde_json::Value::String(stored.to_string()),
                "slug do banco divergente do IPC para {kind:?}"
            );
        }
    }

    #[test]
    fn unknown_artifact_kind_falls_back_to_binary() {
        for raw in ["", "desconhecido", "imagem", "AUDIO", "video ", "binary-"] {
            assert_eq!(
                artifact_kind_from_str(raw),
                ArtifactKind::Binary,
                "valor legado/desconhecido {raw:?} deve cair em Binary"
            );
        }
    }

    #[test]
    fn media_and_archive_kinds_persist_through_the_artifacts_table() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        for (index, kind) in all_artifact_kinds().into_iter().enumerate() {
            let mut artifact = stored_artifact(&format!("art-{index:02}"), &conversation.id);
            artifact.artifact.kind = kind;
            db.insert_artifact(&artifact).expect("insert");
        }

        let listed = db.list_artifacts(&conversation.id).expect("list");
        let stored_kinds: Vec<ArtifactKind> = listed.into_iter().map(|row| row.kind).collect();
        assert_eq!(
            stored_kinds,
            all_artifact_kinds().to_vec(),
            "todos os kinds, inclusive áudio/vídeo/compactado, devem voltar iguais"
        );

        // `get_artifact` (usado por preview/conteúdo) faz o mesmo mapeamento.
        let audio = db
            .get_artifact("art-12")
            .expect("get")
            .expect("artefato de áudio presente");
        assert_eq!(audio.artifact.kind, ArtifactKind::Audio);
        let archive = db
            .get_artifact("art-14")
            .expect("get")
            .expect("artefato compactado presente");
        assert_eq!(archive.artifact.kind, ArtifactKind::Archive);
    }

    #[test]
    fn usage_summary_aggregates_by_provider_and_model() {
        let db = test_db();
        let usage = |input, output: u32| UsageInfo {
            input_tokens: Some(input),
            output_tokens: Some(output),
            reasoning_tokens: Some(1),
            cached_tokens: Some(0),
            total_tokens: Some(input + output),
            cost: Some(0.5),
            duration_ms: None,
            ..UsageInfo::default()
        };
        db.record_usage(
            "conv-1",
            "msg-1",
            "opencode-go",
            "glm-5.3-flash",
            &usage(10, 20),
        )
        .expect("usage 1");
        db.record_usage(
            "conv-1",
            "msg-2",
            "opencode-go",
            "glm-5.3-flash",
            &usage(1, 2),
        )
        .expect("usage 2");
        db.record_usage(
            "conv-2",
            "msg-3",
            "opencode-zen",
            "gpt-6-luna",
            &usage(5, 5),
        )
        .expect("usage 3");

        let summary = db.usage_summary().expect("summary");
        let totals = &summary["totals"];
        assert_eq!(totals["requests"], 3);
        assert_eq!(totals["inputTokens"], 16);
        assert_eq!(totals["outputTokens"], 27);
        assert_eq!(totals["totalTokens"], 43);
        assert_eq!(summary["byProvider"].as_array().expect("array").len(), 2);
        assert_eq!(summary["byModel"].as_array().expect("array").len(), 2);
    }

    #[test]
    fn usage_stats_aggregates_totals_models_days_and_window() {
        let db = test_db();
        let usage = |input, output: u32| UsageInfo {
            input_tokens: Some(input),
            output_tokens: Some(output),
            reasoning_tokens: Some(1),
            cached_tokens: Some(0),
            total_tokens: Some(input + output),
            cost: Some(0.5),
            duration_ms: None,
            ..UsageInfo::default()
        };
        db.record_usage(
            "conv-1",
            "msg-1",
            "opencode-go",
            "glm-5.3-flash",
            &usage(10, 20),
        )
        .expect("usage 1");
        db.record_usage(
            "conv-1",
            "msg-2",
            "opencode-go",
            "glm-5.3-flash",
            &usage(1, 2),
        )
        .expect("usage 2");
        db.record_usage(
            "conv-2",
            "msg-3",
            "opencode-zen",
            "gpt-6-luna",
            &usage(5, 5),
        )
        .expect("usage 3");

        // Pin both "today" rows to the same instant so the daily bucket cannot
        // split if the test crosses local midnight.
        let now = now_ms();
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE usage_log SET created_at = ?1 WHERE message_id IN ('msg-1', 'msg-2')",
                [now],
            )
            .expect("pin today usage");
            conn.execute(
                "UPDATE usage_log SET created_at = ?1 WHERE message_id = 'msg-3'",
                [now - 86_400_000],
            )
            .expect("shift yesterday usage");
        }

        let all = db.usage_stats(None).expect("all stats");
        assert_eq!(all.totals.turns, 3);
        assert_eq!(all.totals.input_tokens, 16);
        assert_eq!(all.totals.output_tokens, 27);
        assert_eq!(all.totals.total_tokens, 43);
        assert!((all.totals.cost - 1.5).abs() < f64::EPSILON);
        assert_eq!(all.totals.last_used_at, Some(now));
        assert_eq!(all.by_model.len(), 2);
        assert_eq!(all.by_model[0].model_id, "glm-5.3-flash");
        assert_eq!(all.by_model[0].turns, 2);
        assert_eq!(all.by_model[0].total_tokens, 33);
        assert_eq!(all.by_day.len(), 2);
        assert!(all
            .by_day
            .iter()
            .any(|day| day.total_tokens == 33 && day.day.len() == 10));

        let recent = db
            .usage_stats(Some(now - 12 * 60 * 60 * 1000))
            .expect("recent stats");
        assert_eq!(recent.totals.turns, 2);
        assert_eq!(recent.by_model.len(), 1);
        assert_eq!(recent.by_model[0].model_id, "glm-5.3-flash");

        let empty = db
            .usage_stats(Some(now + 60_000))
            .expect("future stats");
        assert_eq!(empty.totals.turns, 0);
        assert_eq!(empty.totals.total_tokens, 0);
        assert!(empty.totals.last_used_at.is_none());
        assert!(empty.by_model.is_empty());
        assert!(empty.by_day.is_empty());
    }

    #[test]
    fn reset_clears_every_table() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        db.insert_message(&user_message(&conversation.id, "oi", 1_000))
            .expect("insert");
        db.insert_artifact(&stored_artifact("art-9", &conversation.id))
            .expect("artifact");
        db.insert_attachment(&stored_attachment("att-9", "texto"))
            .expect("attachment");

        db.reset().expect("reset");
        assert!(db.list_conversations().expect("conversations").is_empty());
        assert!(db
            .list_artifacts(&conversation.id)
            .expect("artifacts")
            .is_empty());
        assert!(db.get_attachment("att-9").expect("attachment").is_none());
        assert_eq!(
            db.usage_summary().expect("summary")["totals"]["requests"],
            0
        );
    }

    #[test]
    fn pinned_conversations_sort_first() {
        let db = test_db();
        let older = db
            .create_conversation("Antiga", "opencode-go", "glm-5.3-flash")
            .expect("create old");
        let newer = db
            .create_conversation("Nova", "opencode-go", "glm-5.3-flash")
            .expect("create new");
        db.touch_conversation(&older.id).expect("touch");
        db.set_pinned(&older.id, true).expect("pin");
        let listed = db.list_conversations().expect("list");
        assert_eq!(listed[0].id, older.id);
        assert_eq!(listed[1].id, newer.id);
        let stored = db
            .get_conversation(&older.id)
            .expect("get")
            .expect("present");
        assert!(stored.pinned);
    }

    /* -------------------------------------------------------------- */
    /* Biblioteca: uploads sem conversa, favoritos e migração          */
    /* -------------------------------------------------------------- */

    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "{prefix}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("criar diretório temporário");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// Banco no schema anterior à Biblioteca: `conversation_id NOT NULL` e sem
    /// a coluna `favorite`.
    fn create_legacy_database(path: &Path) {
        let conn = Connection::open(path).expect("abrir banco legado");
        conn.execute_batch(
            "CREATE TABLE artifacts (
               id              TEXT PRIMARY KEY,
               conversation_id TEXT NOT NULL,
               message_id      TEXT,
               name            TEXT NOT NULL,
               mime_type       TEXT NOT NULL,
               kind            TEXT NOT NULL,
               language        TEXT,
               size            INTEGER NOT NULL,
               created_at      INTEGER NOT NULL,
               path            TEXT NOT NULL
             );
             INSERT INTO artifacts (id, conversation_id, message_id, name, mime_type, kind,
                                    language, size, created_at, path)
               VALUES ('art-legacy', 'conv-1', 'msg-1', 'antigo.md', 'text/markdown',
                       'markdown', NULL, 12, 1000,
                       'C:\\dados\\artifacts\\art-legacy\\antigo.md');
             INSERT INTO artifacts (id, conversation_id, message_id, name, mime_type, kind,
                                    language, size, created_at, path)
               VALUES ('art-legacy-2', 'conv-1', NULL, 'relatorio.pdf', 'application/pdf',
                       'pdf', NULL, 2048, 2000,
                       'C:\\dados\\artifacts\\art-legacy-2\\relatorio.pdf');",
        )
        .expect("criar schema legado com dados");
    }

    #[test]
    fn joined_artifact_columns_stay_in_sync_with_the_row_mapper() {
        let plain: Vec<&str> = ARTIFACT_COLUMNS.split(',').map(str::trim).collect();
        let prefixed: Vec<&str> = ARTIFACT_JOIN_COLUMNS
            .split(',')
            .map(|column| column.trim().strip_prefix("a.").unwrap_or_else(|| column.trim()))
            .collect();
        assert_eq!(
            prefixed, plain,
            "a query com JOIN precisa listar as colunas na mesma ordem do mapper"
        );
        assert_eq!(plain.len(), 11);
        assert_eq!(plain[9], "favorite", "favorite precede task_id");
        assert_eq!(plain[10], "task_id");
    }

    #[test]
    fn insert_artifact_roundtrips_a_library_upload_without_conversation() {
        let db = test_db();
        db.insert_artifact(&library_artifact("art-upload", "contrato.pdf", 1_000))
            .expect("inserir upload");

        let stored = db
            .get_artifact("art-upload")
            .expect("ler upload")
            .expect("upload presente");
        assert!(stored.artifact.conversation_id.is_none());
        assert!(!stored.artifact.favorite);
        assert_eq!(stored.artifact.name, "contrato.pdf");
        assert_eq!(stored.artifact.kind, ArtifactKind::Pdf);

        // Aparece na listagem global do agente (todas as origens).
        let all = db.list_all_artifacts().expect("list all");
        assert_eq!(all.len(), 1);
        assert!(all[0].conversation_id.is_none());
    }

    #[test]
    fn list_library_artifacts_orders_desc_and_joins_conversation_titles() {
        let db = test_db();
        let first = db
            .create_conversation("Receitas de bolo", "opencode-go", "glm-5.3-flash")
            .expect("create first");
        let second = db
            .create_conversation("Segunda conversa", "opencode-go", "glm-5.3-flash")
            .expect("create second");

        let mut oldest = stored_artifact("art-a", &first.id);
        oldest.artifact.created_at = 1_000;
        db.insert_artifact(&oldest).expect("insert old");
        // Upload e artefato gerado empatam em `created_at`: o desempate é por
        // `id DESC` (art-c antes de art-b).
        db.insert_artifact(&library_artifact("art-b", "contrato.pdf", 2_000))
            .expect("insert upload");
        let mut generated = stored_artifact("art-c", &second.id);
        generated.artifact.created_at = 2_000;
        generated.artifact.favorite = true;
        db.insert_artifact(&generated).expect("insert generated");

        let library = db.list_library_artifacts().expect("listar biblioteca");
        let ids: Vec<&str> = library
            .iter()
            .map(|row| row.artifact.id.as_str())
            .collect();
        assert_eq!(
            ids,
            ["art-c", "art-b", "art-a"],
            "mais recentes primeiro, id DESC no empate"
        );

        let upload = &library[1];
        assert!(upload.artifact.conversation_id.is_none());
        assert!(
            upload.conversation_title.is_none(),
            "upload não tem conversa de origem"
        );
        assert_eq!(upload.artifact.name, "contrato.pdf");

        assert_eq!(
            library[0].conversation_title.as_deref(),
            Some("Segunda conversa")
        );
        assert!(library[0].artifact.favorite);
        assert_eq!(
            library[2].conversation_title.as_deref(),
            Some("Receitas de bolo")
        );
        assert!(!library[2].artifact.favorite);
    }

    #[test]
    fn set_artifact_favorite_persists_and_returns_the_updated_artifact() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        db.insert_artifact(&stored_artifact("art-fav", &conversation.id))
            .expect("insert");

        let favorited = db
            .set_artifact_favorite("art-fav", true)
            .expect("favoritar")
            .expect("artefato presente");
        assert!(favorited.favorite);
        assert_eq!(favorited.id, "art-fav");
        // O recorte por conversa também vê o favorito.
        let listed = db.list_artifacts(&conversation.id).expect("list");
        assert!(listed[0].favorite);

        let unfavorited = db
            .set_artifact_favorite("art-fav", false)
            .expect("desfavoritar")
            .expect("artefato presente");
        assert!(!unfavorited.favorite);

        assert!(
            db.set_artifact_favorite("inexistente", true)
                .expect("id desconhecido não é erro de SQL")
                .is_none(),
            "id inexistente devolve None para o comando virar erro"
        );
    }

    #[test]
    fn update_artifact_metadata_changes_name_mime_kind_and_language() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        db.insert_artifact(&stored_artifact("art-meta", &conversation.id))
            .expect("insert");

        let updated = db
            .update_artifact_metadata(
                "art-meta",
                "renomeado.pdf",
                "application/pdf",
                ArtifactKind::Pdf,
                None,
            )
            .expect("atualizar metadados")
            .expect("artefato presente");
        assert_eq!(updated.name, "renomeado.pdf");
        assert_eq!(updated.mime_type, "application/pdf");
        assert_eq!(updated.kind, ArtifactKind::Pdf);
        assert!(updated.language.is_none());
        // O path continua o mesmo: o arquivo em disco é movido pelo comando.
        let stored = db
            .get_artifact("art-meta")
            .expect("get")
            .expect("presente");
        assert_eq!(
            stored.path,
            std::env::temp_dir()
                .join("zylara-db-tests")
                .join("artifacts")
                .join("art-meta")
                .join("resumo.md")
                .to_string_lossy()
                .to_string()
        );

        assert!(
            db.update_artifact_metadata(
                "inexistente",
                "x.txt",
                "text/plain",
                ArtifactKind::Text,
                Some("text")
            )
            .expect("id desconhecido não é erro de SQL")
            .is_none()
        );
    }

    #[test]
    fn update_artifact_rename_saves_metadata_and_path_together() {
        let db = test_db();
        db.insert_artifact(&library_artifact("art-rename", "antigo.pdf", 1_000))
            .expect("insert");

        let new_path = std::env::temp_dir()
            .join("zylara-db-tests")
            .join("artifacts")
            .join("art-rename")
            .join("contrato-final.pdf")
            .to_string_lossy()
            .to_string();
        let renamed = db
            .update_artifact_rename(
                "art-rename",
                "contrato-final.pdf",
                "application/pdf",
                ArtifactKind::Pdf,
                None,
                &new_path,
            )
            .expect("renomear")
            .expect("artefato presente");
        assert_eq!(renamed.name, "contrato-final.pdf");

        let stored = db
            .get_artifact("art-rename")
            .expect("get")
            .expect("presente");
        assert_eq!(stored.path, new_path, "path do rename gravado no mesmo UPDATE");
        assert_eq!(stored.artifact.name, "contrato-final.pdf");
    }

    #[test]
    fn delete_conversation_keeps_library_uploads() {
        let db = test_db();
        let conversation = db
            .create_conversation("Chat", "opencode-go", "glm-5.3-flash")
            .expect("create");
        db.insert_artifact(&stored_artifact("art-conv", &conversation.id))
            .expect("insert generated");
        db.insert_artifact(&library_artifact("art-upload", "contrato.pdf", 1_000))
            .expect("insert upload");

        db.delete_conversation(&conversation.id).expect("delete");

        let library = db.list_library_artifacts().expect("listar");
        assert_eq!(library.len(), 1, "upload sem conversa sobrevive");
        assert_eq!(library[0].artifact.id, "art-upload");
    }

    #[test]
    fn migrates_legacy_artifacts_table_preserving_rows_and_allowing_uploads() {
        let temp = TempDir::new("zylara-db-migrate");
        let path = temp.path.join("zylara.db");
        create_legacy_database(&path);

        // `Db::open` roda o schema novo (idempotente) e a migração.
        let db = Db::open(&path).expect("abrir e migrar banco legado");
        let legacy = db
            .get_artifact("art-legacy")
            .expect("ler artefato legado")
            .expect("nenhum artefato antigo pode ser perdido");
        assert_eq!(legacy.artifact.name, "antigo.md");
        assert_eq!(legacy.artifact.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(legacy.artifact.created_at, 1_000);
        assert!(
            !legacy.artifact.favorite,
            "linha antiga entra com favorite = 0"
        );
        assert_eq!(
            legacy.path,
            "C:\\dados\\artifacts\\art-legacy\\antigo.md",
            "path original preservado"
        );
        assert_eq!(db.list_all_artifacts().expect("listar").len(), 2);

        // A coluna `conversation_id` agora aceita NULL (upload da Biblioteca),
        // e `favorite` funciona nas linhas antigas e novas.
        db.insert_artifact(&library_artifact("art-upload", "contrato.pdf", 3_000))
            .expect("upload sem conversa depois da migração");
        db.set_artifact_favorite("art-upload", true)
            .expect("favoritar upload")
            .expect("upload presente");
        let upload = db
            .get_artifact("art-upload")
            .expect("ler upload")
            .expect("presente");
        assert!(upload.artifact.conversation_id.is_none());
        assert!(upload.artifact.favorite);
        drop(db);

        // Reabrir (migração idempotente) mantém tudo.
        let reopened = Db::open(&path).expect("reabrir banco migrado");
        assert!(reopened.get_artifact("art-legacy").expect("legado").is_some());
        let upload = reopened
            .get_artifact("art-upload")
            .expect("upload")
            .expect("presente");
        assert!(upload.artifact.favorite);
        assert_eq!(reopened.list_all_artifacts().expect("listar").len(), 3);
    }

    #[test]
    fn migration_is_idempotent_when_favorite_already_exists() {
        // Estado intermediário: `favorite` já foi adicionada, mas a tabela ainda
        // tem `conversation_id NOT NULL` (uma migração anterior foi interrompida
        // entre os dois passos). O rebuild precisa copiar a coluna existente.
        let temp = TempDir::new("zylara-db-migrate-partial");
        let path = temp.path.join("zylara.db");
        create_legacy_database(&path);
        {
            let conn = Connection::open(&path).expect("abrir legado");
            conn.execute_batch(
                "ALTER TABLE artifacts ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
                 UPDATE artifacts SET favorite = 1 WHERE id = 'art-legacy';",
            )
            .expect("adicionar favorite manualmente");
        }

        let db = Db::open(&path).expect("abrir e terminar a migração");
        let legacy = db
            .get_artifact("art-legacy")
            .expect("get")
            .expect("presente");
        assert!(
            legacy.artifact.favorite,
            "o rebuild preserva o favorite já gravado"
        );
        assert_eq!(legacy.artifact.name, "antigo.md");
        db.insert_artifact(&library_artifact("art-upload", "contrato.pdf", 3_000))
            .expect("upload depois da migração");
        drop(db);

        // E segue idempotente na terceira abertura.
        let reopened = Db::open(&path).expect("reabrir");
        assert_eq!(reopened.list_all_artifacts().expect("listar").len(), 3);
    }

    #[test]
    fn reset_clears_library_uploads_too() {
        let db = test_db();
        db.insert_artifact(&library_artifact("art-upload", "contrato.pdf", 1_000))
            .expect("insert upload");
        db.reset().expect("reset");
        assert!(db.list_library_artifacts().expect("biblioteca").is_empty());
        assert!(db.list_all_artifacts().expect("artefatos").is_empty());
    }

    /* -------------------------------------------------------------- */
    /* Harness de código: migração e persistência                     */
    /* -------------------------------------------------------------- */

    fn code_conversation(db: &Db) -> Conversation {
        db.create_conversation_with_mode(
            "Sessão de código",
            "opencode-go",
            "glm-5.3-flash",
            "code",
        )
        .expect("criar conversa de código")
    }

    fn code_harness_rule<'a>(
        scope: ApprovalScope,
        scope_id: Option<&'a str>,
        tool: &'a str,
    ) -> NewApprovalRule<'a> {
        NewApprovalRule {
            scope,
            scope_id,
            tool,
            matcher: "prefix",
            pattern: "npm run",
            decision: ApprovalDecision::Approved,
        }
    }

    /// Banco legado (anterior ao harness de código) com a tabela `conversations`
    /// sem `workspace_id`/`agent_kind`/`permission_mode`.
    fn create_legacy_code_harness_database(path: &Path) {
        let conn = Connection::open(path).expect("abrir banco legado");
        legacy_conversations_table(&conn);
    }

    #[test]
    fn migrates_legacy_conversations_with_the_code_harness_columns() {
        let temp = TempDir::new("zylara-db-code-harness-migrate");
        let path = temp.path.join("zylara.db");
        create_legacy_code_harness_database(&path);

        // `Db::open` roda o schema novo (idempotente) e as migrações aditivas.
        let db = Db::open(&path).expect("abrir e migrar banco legado");
        let conversation = db
            .get_conversation("legacy-1")
            .expect("ler conversa legada")
            .expect("conversa antiga preservada");
        assert_eq!(conversation.title, "Conversa antiga");
        assert!(conversation.pinned);
        assert_eq!(conversation.mode, "chat");
        assert_eq!(conversation.workspace_id, None);
        assert_eq!(conversation.agent_kind, "zylara");
        assert_eq!(conversation.permission_mode, PermissionMode::Edit);
        drop(db);

        // As colunas existem fisicamente e os defaults valem para a linha antiga.
        let conn = Connection::open(&path).expect("reabrir banco migrado");
        let columns = table_columns(&conn, "conversations").expect("colunas");
        for column in ["workspace_id", "agent_kind", "permission_mode"] {
            assert!(
                columns.iter().any(|(name, _)| name == column),
                "coluna {column} ausente após a migração"
            );
        }
        let raw: (Option<String>, String, String) = conn
            .query_row(
                "SELECT workspace_id, agent_kind, permission_mode FROM conversations \
                 WHERE id = 'legacy-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("valores migrados");
        assert_eq!(raw, (None, "zylara".to_string(), "edit".to_string()));
        drop(conn);

        // A migração é idempotente: reabrir o arquivo mantém tudo.
        let reopened = Db::open(&path).expect("reabrir");
        let conversation = reopened
            .get_conversation("legacy-1")
            .expect("get")
            .expect("presente");
        assert_eq!(conversation.permission_mode, PermissionMode::Edit);
    }

    #[test]
    fn creates_lists_and_finds_workspaces() {
        let db = test_db();
        let alpha = db
            .create_workspace("  Alpha  ", "C:\\projetos\\alpha")
            .expect("criar alpha");
        assert_eq!(alpha.name, "Alpha", "nome é aparado");
        assert_eq!(alpha.path, "C:\\projetos\\alpha");
        assert!(alpha.last_opened_at.is_none());
        assert!(!alpha.pinned);
        assert!(!alpha.trusted);
        assert!(alpha.git.is_none(), "git não é coluna; é detectado em memória");

        let found = db
            .find_workspace_by_path("  C:\\projetos\\alpha  ")
            .expect("buscar por caminho")
            .expect("workspace presente");
        assert_eq!(found.id, alpha.id);
        assert!(db
            .find_workspace_by_path("C:\\projetos\\inexistente")
            .expect("buscar")
            .is_none());

        let duplicate = db.create_workspace("Outro nome", "C:\\projetos\\alpha");
        let error = duplicate.expect_err("caminho duplicado é rejeitado");
        assert!(
            format!("{error}").contains("já existe"),
            "erro amigável: {error}"
        );
        assert!(db.create_workspace("Vazio", "   ").is_err());

        let beta = db
            .create_workspace("Beta", "C:\\projetos\\beta")
            .expect("criar beta");
        let listed = db.list_workspaces().expect("listar");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, alpha.id, "empate de data: ordena por nome");
        assert_eq!(listed[1].id, beta.id);
    }

    #[test]
    fn updates_pins_trusts_and_opens_workspaces() {
        let db = test_db();
        let workspace = db
            .create_workspace("Projeto", "C:\\projetos\\p")
            .expect("criar");
        let created_at = workspace.created_at;

        db.set_workspace_pinned(&workspace.id, true)
            .expect("fixar");
        db.set_workspace_trusted(&workspace.id, true)
            .expect("confiar");
        db.mark_workspace_opened(&workspace.id).expect("abrir");
        let mut loaded = db
            .get_workspace(&workspace.id)
            .expect("get")
            .expect("presente");
        assert!(loaded.pinned);
        assert!(loaded.trusted);
        assert!(
            loaded.last_opened_at.is_some_and(|value| value >= created_at),
            "last_opened_at carimbado"
        );
        assert!(loaded.updated_at >= created_at);

        // `update_workspace` grava o estado completo do struct (inclusive
        // pinned/trusted), por isso parte do estado recém-lido.
        loaded.name = "Projeto renomeado".to_string();
        loaded.pinned = false;
        db.update_workspace(&loaded).expect("atualizar metadados");
        let reloaded = db
            .get_workspace(&workspace.id)
            .expect("get")
            .expect("presente");
        assert_eq!(reloaded.name, "Projeto renomeado");
        assert!(!reloaded.pinned);
        assert!(reloaded.trusted);

        // `mark_workspace_opened` ordena a sidebar pelo último acesso.
        let other = db
            .create_workspace("Outro", "C:\\projetos\\o")
            .expect("criar outro");
        db.mark_workspace_opened(&other.id).expect("abrir outro");
        let listed = db.list_workspaces().expect("listar");
        assert_eq!(listed[0].id, other.id, "último aberto vem primeiro");

        db.touch_workspace(&other.id).expect("touch");
        let missing = Workspace {
            id: "ws-inexistente".to_string(),
            ..other.clone()
        };
        assert!(
            db.update_workspace(&missing).is_err(),
            "update de workspace desconhecido é erro claro"
        );
    }

    #[test]
    fn deletes_workspace_unlinks_sessions_and_drops_its_rules() {
        let db = test_db();
        let workspace = db
            .create_workspace("App", "C:\\projetos\\app")
            .expect("criar workspace");
        let conversation = code_conversation(&db);
        db.set_conversation_workspace(&conversation.id, Some(&workspace.id))
            .expect("associar");
        db.create_approval_rule(&code_harness_rule(
            ApprovalScope::Workspace,
            Some(&workspace.id),
            "shell",
        ))
        .expect("regra do workspace");
        assert_eq!(db.list_approval_rules().expect("regras").len(), 1);

        assert!(db.delete_workspace(&workspace.id).expect("remover"));
        assert!(
            !db.delete_workspace(&workspace.id).expect("remover de novo"),
            "segunda remoção devolve false"
        );
        let reloaded = db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("sessão sobrevive");
        assert!(reloaded.workspace_id.is_none(), "sessão fica sem workspace");
        assert!(
            db.list_approval_rules().expect("regras").is_empty(),
            "regras de escopo do workspace são apagadas junto"
        );
    }

    #[test]
    fn appends_code_events_with_monotonic_seq_per_conversation() {
        let db = test_db();
        let first = db
            .append_code_event("conv-1", Some("turn-1"), "step", r#"{"step":1}"#)
            .expect("evento 1");
        let second = db
            .append_code_event("conv-1", None, "tool", r#"{"tool":"read"}"#)
            .expect("evento 2");
        let third = db
            .append_code_event("conv-1", Some("turn-2"), "step", r#"{"step":2}"#)
            .expect("evento 3");
        assert_eq!((first.seq, second.seq, third.seq), (1, 2, 3));
        assert_eq!(first.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(second.turn_id, None);
        assert_eq!(first.conversation_id, "conv-1");
        assert_eq!(first.kind, "step");

        let other = db
            .append_code_event("conv-2", None, "step", "{}")
            .expect("outra conversa");
        assert_eq!(other.seq, 1, "o seq é por conversa");

        let from_two = db.list_code_events("conv-1", 2).expect("listar desde seq 2");
        assert_eq!(
            from_two.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(db
            .list_code_events("conv-1", 9)
            .expect("listar")
            .is_empty());

        let latest_step = db
            .latest_code_event("conv-1", "step")
            .expect("último step")
            .expect("presente");
        assert_eq!(latest_step.seq, 3);
        assert!(db
            .latest_code_event("conv-1", "inexistente")
            .expect("último")
            .is_none());
        assert!(db
            .append_code_event("conv-1", None, "   ", "{}")
            .is_err());
    }

    #[test]
    fn journals_file_changes_per_turn_and_conversation() {
        let db = test_db();
        let created = FileJournalEntry::new(
            "conv-1",
            "turn-1",
            "src/main.rs",
            FileChangeKind::Created,
        )
        .with_hashes(None, Some("abc123"))
        .with_line_counts(12, 0);
        let id = db.append_file_journal(&created).expect("journal");
        assert!(id > 0);

        let modified = FileJournalEntry::new(
            "conv-1",
            "turn-1",
            "src/lib.rs",
            FileChangeKind::Modified,
        )
        .with_hashes(Some("old"), Some("new"))
        .with_line_counts(4, 2);
        db.append_file_journal(&modified).expect("journal 2");
        db.append_file_journal(&FileJournalEntry::new(
            "conv-1",
            "turn-2",
            "README.md",
            FileChangeKind::Deleted,
        ))
        .expect("journal 3");

        let turn = db
            .list_file_journal_for_turn("conv-1", "turn-1")
            .expect("por turno");
        assert_eq!(turn.len(), 2);
        assert_eq!(turn[0].path, "src/main.rs");
        assert_eq!(turn[0].change_kind, FileChangeKind::Created);
        assert_eq!(turn[0].after_hash.as_deref(), Some("abc123"));
        assert_eq!((turn[0].added, turn[0].removed), (Some(12), Some(0)));
        assert_eq!(turn[1].change_kind, FileChangeKind::Modified);
        assert_eq!(turn[1].before_hash.as_deref(), Some("old"));

        assert_eq!(
            db.last_file_journal_turn("conv-1")
                .expect("último turno")
                .as_deref(),
            Some("turn-2")
        );
        assert!(db
            .last_file_journal_turn("conv-9")
            .expect("sem journal")
            .is_none());
        let all = db.list_file_journal("conv-1").expect("por conversa");
        assert_eq!(all.len(), 3);
        assert_eq!(all[2].change_kind, FileChangeKind::Deleted);
        assert!(db
            .list_file_journal_for_turn("conv-1", "turn-9")
            .expect("vazio")
            .is_empty());

        assert!(db
            .append_file_journal(&FileJournalEntry::new(
                "conv-1",
                "turn-1",
                "  ",
                FileChangeKind::Modified,
            ))
            .is_err());
        assert!(db
            .append_file_journal(&FileJournalEntry::new(
                "conv-1",
                "  ",
                "a.txt",
                FileChangeKind::Modified,
            ))
            .is_err());
    }

    #[test]
    fn session_summaries_roundtrip_and_latest() {
        let db = test_db();
        let first = db
            .insert_session_summary("conv-1", 1, 10, "Resumo inicial", Some(500))
            .expect("resumo 1");
        assert_eq!(first.from_seq, 1);
        assert_eq!(first.tokens, Some(500));
        assert_eq!(first.content, "Resumo inicial");
        db.insert_session_summary("conv-1", 11, 20, "Resumo seguinte", None)
            .expect("resumo 2");
        db.insert_session_summary("conv-2", 1, 5, "Outra sessão", Some(1))
            .expect("outra sessão");

        let listed = db.list_session_summaries("conv-1").expect("listar");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].from_seq, 1);
        let latest = db
            .latest_session_summary("conv-1")
            .expect("último")
            .expect("presente");
        assert_eq!(latest.to_seq, 20);
        assert_eq!(latest.tokens, None);
        assert!(db
            .latest_session_summary("conv-9")
            .expect("último")
            .is_none());

        assert!(db
            .insert_session_summary("conv-1", 0, 5, "x", None)
            .is_err());
        assert!(db
            .insert_session_summary("conv-1", 10, 5, "x", None)
            .is_err());
    }

    #[test]
    fn approval_rules_scope_lookup_and_delete() {
        let db = test_db();
        db.create_approval_rule(&code_harness_rule(ApprovalScope::Global, None, "shell"))
            .expect("global");
        db.create_approval_rule(&code_harness_rule(
            ApprovalScope::Session,
            Some("conv-1"),
            "shell",
        ))
        .expect("sessão 1");
        db.create_approval_rule(&code_harness_rule(
            ApprovalScope::Session,
            Some("conv-2"),
            "shell",
        ))
        .expect("sessão 2");
        db.create_approval_rule(&code_harness_rule(
            ApprovalScope::Workspace,
            Some("ws-1"),
            "shell",
        ))
        .expect("workspace 1");
        db.create_approval_rule(&code_harness_rule(
            ApprovalScope::Workspace,
            Some("ws-2"),
            "shell",
        ))
        .expect("workspace 2");

        assert_eq!(db.list_approval_rules().expect("todas").len(), 5);
        assert_eq!(
            db.list_approval_rules_for_scope(ApprovalScope::Global, None)
                .expect("global")
                .len(),
            1
        );
        let session = db
            .list_approval_rules_for_scope(ApprovalScope::Session, Some("conv-1"))
            .expect("sessão");
        assert_eq!(session.len(), 1);
        assert_eq!(session[0].scope_id.as_deref(), Some("conv-1"));
        assert_eq!(session[0].decision, ApprovalDecision::Approved);
        assert_eq!(session[0].matcher, "prefix");
        assert_eq!(session[0].pattern, "npm run");

        // Contexto da política: globais + regras da sessão + regras do workspace.
        let context = db
            .list_approval_rules_for_context(Some("conv-1"), Some("ws-1"))
            .expect("contexto");
        assert_eq!(context.len(), 3);
        let only_session = db
            .list_approval_rules_for_context(Some("conv-2"), None)
            .expect("contexto sem workspace");
        assert_eq!(only_session.len(), 2);

        assert!(db
            .create_approval_rule(&NewApprovalRule {
                scope: ApprovalScope::Global,
                scope_id: None,
                tool: "  ",
                matcher: "exact",
                pattern: "x",
                decision: ApprovalDecision::Denied,
            })
            .is_err());
        assert!(db
            .create_approval_rule(&NewApprovalRule {
                scope: ApprovalScope::Global,
                scope_id: None,
                tool: "shell",
                matcher: " ",
                pattern: "x",
                decision: ApprovalDecision::Denied,
            })
            .is_err());

        assert_eq!(
            db.delete_approval_rules_for_scope(ApprovalScope::Workspace, Some("ws-1"))
                .expect("apagar escopo"),
            1
        );
        assert_eq!(db.list_approval_rules().expect("todas").len(), 4);
        let single = db
            .create_approval_rule(&code_harness_rule(
                ApprovalScope::Session,
                Some("conv-1"),
                "shell",
            ))
            .expect("regra individual");
        assert!(db.delete_approval_rule(&single.id).expect("apagar"));
        assert!(!db.delete_approval_rule(&single.id).expect("apagar de novo"));
    }

    #[test]
    fn associates_workspace_and_updates_session_settings() {
        let db = test_db();
        let workspace = db
            .create_workspace("App", "C:\\projetos\\app")
            .expect("workspace");
        let conversation = code_conversation(&db);
        assert!(conversation.workspace_id.is_none());
        assert_eq!(conversation.agent_kind, "zylara");
        assert_eq!(conversation.permission_mode, PermissionMode::Edit);

        db.set_conversation_workspace(&conversation.id, Some(&workspace.id))
            .expect("associar workspace");
        let loaded = db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("presente");
        assert_eq!(
            loaded.workspace_id.as_deref(),
            Some(workspace.id.as_str())
        );
        assert_eq!(
            db.list_conversations_for_workspace(&workspace.id)
                .expect("sessões do workspace")
                .len(),
            1
        );

        db.set_conversation_permission_mode(&conversation.id, PermissionMode::ReadOnly)
            .expect("modo de permissão");
        assert_eq!(
            db.get_conversation_permission_mode(&conversation.id)
                .expect("ler modo"),
            Some(PermissionMode::ReadOnly)
        );
        let loaded = db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("presente");
        assert_eq!(loaded.permission_mode, PermissionMode::ReadOnly);

        db.set_conversation_agent_kind(&conversation.id, " acp:codex ")
            .expect("motor do agente");
        let loaded = db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("presente");
        assert_eq!(loaded.agent_kind, "acp:codex");

        db.clear_conversation_workspace(&conversation.id)
            .expect("desassociar");
        let loaded = db
            .get_conversation(&conversation.id)
            .expect("get")
            .expect("presente");
        assert!(loaded.workspace_id.is_none());

        // Erros orientativos para ids/campos inválidos.
        assert!(db
            .set_conversation_workspace(&conversation.id, Some("ws-inexistente"))
            .is_err());
        assert!(db
            .set_conversation_workspace("conv-inexistente", None)
            .is_err());
        assert!(db
            .set_conversation_agent_kind(&conversation.id, "   ")
            .is_err());
        assert!(db
            .set_conversation_permission_mode("conv-inexistente", PermissionMode::Edit)
            .is_err());
        assert_eq!(
            db.get_conversation_permission_mode("conv-inexistente")
                .expect("sem conversa"),
            None
        );
        assert!(db
            .list_conversations_for_workspace("ws-inexistente")
            .expect("workspace sem sessões")
            .is_empty());
    }

    #[test]
    fn delete_conversation_cleans_code_harness_records() {
        let db = test_db();
        let workspace = db
            .create_workspace("App", "C:\\projetos\\app")
            .expect("workspace");
        let conversation = code_conversation(&db);
        db.set_conversation_workspace(&conversation.id, Some(&workspace.id))
            .expect("associar");
        db.append_code_event(&conversation.id, Some("turn-1"), "step", "{}")
            .expect("evento");
        db.append_file_journal(&FileJournalEntry::new(
            &conversation.id,
            "turn-1",
            "a.txt",
            FileChangeKind::Created,
        ))
        .expect("journal");
        db.insert_session_summary(&conversation.id, 1, 5, "resumo", None)
            .expect("resumo");
        db.create_approval_rule(&NewApprovalRule {
            scope: ApprovalScope::Session,
            scope_id: Some(&conversation.id),
            tool: "shell",
            matcher: "exact",
            pattern: "ls",
            decision: ApprovalDecision::Approved,
        })
        .expect("regra da sessão");
        db.create_approval_rule(&NewApprovalRule {
            scope: ApprovalScope::Workspace,
            scope_id: Some(&workspace.id),
            tool: "shell",
            matcher: "exact",
            pattern: "ls",
            decision: ApprovalDecision::Approved,
        })
        .expect("regra do workspace");
        db.record_usage(
            &conversation.id,
            "msg-1",
            "opencode-go",
            "deepseek-v4.1-flash",
            &crate::domain::UsageInfo {
                input_tokens: Some(10),
                output_tokens: Some(5),
                total_tokens: Some(15),
                ..Default::default()
            },
        )
        .expect("uso do turno");

        db.delete_conversation(&conversation.id)
            .expect("excluir sessão");

        assert!(db
            .list_code_events(&conversation.id, 0)
            .expect("eventos")
            .is_empty());
        assert!(db
            .list_file_journal(&conversation.id)
            .expect("journal")
            .is_empty());
        assert!(db
            .list_session_summaries(&conversation.id)
            .expect("resumos")
            .is_empty());
        let rules = db.list_approval_rules().expect("regras restantes");
        assert_eq!(rules.len(), 1, "só a regra do workspace sobrevive");
        assert_eq!(rules[0].scope, ApprovalScope::Workspace);
        assert!(
            db.get_workspace(&workspace.id)
                .expect("workspace")
                .is_some(),
            "apagar a sessão não apaga o workspace"
        );
        let usage_rows: i64 = db
            .conn
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM usage_log WHERE conversation_id = ?1",
                [&conversation.id],
                |row| row.get(0),
            )
            .expect("contar usage_log");
        assert_eq!(usage_rows, 0, "uso da conversa efêmera não pode ficar órfão");
    }

    #[test]
    fn subagent_transcripts_are_hidden_and_cascade_with_the_parent() {
        let db = test_db();
        let parent = code_conversation(&db);
        let child = db
            .create_subagent_conversation(
                "Subagente: revisar",
                "opencode-go",
                "deepseek-v4.1-flash",
                &parent.id,
                "task-call-1",
                "review",
            )
            .expect("subagente");
        assert_eq!(child.parent_conversation_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(child.subagent_task_call_id.as_deref(), Some("task-call-1"));
        assert_eq!(child.subagent_type.as_deref(), Some("review"));
        assert_eq!(child.permission_mode, PermissionMode::ReadOnly);
        assert_eq!(db.list_conversations().expect("sidebar").len(), 1);
        assert_eq!(
            db.list_subagent_conversations(&parent.id)
                .expect("subagentes")
                .len(),
            1
        );
        db.delete_conversation(&parent.id).expect("excluir pai");
        assert!(db
            .get_conversation(&child.id)
            .expect("buscar filho")
            .is_none());
        assert!(db
            .list_subagent_conversations(&parent.id)
            .expect("subagentes")
            .is_empty());
    }

    #[test]
    fn reorder_conversations_assigns_positions() {
        let db = test_db();
        let first = db
            .create_conversation("Primeira", "opencode-go", "glm-5.3-flash")
            .expect("primeira");
        let second = db
            .create_conversation("Segunda", "opencode-go", "glm-5.3-flash")
            .expect("segunda");
        let third = db
            .create_conversation("Terceira", "opencode-go", "glm-5.3-flash")
            .expect("terceira");

        db.reorder_conversations(&[
            second.id.clone(),
            third.id.clone(),
            first.id.clone(),
        ])
        .expect("reordenar");

        let listed = db.list_conversations().expect("listar");
        let ids = listed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![second.id.as_str(), third.id.as_str(), first.id.as_str()]
        );
        assert_eq!(
            listed.iter().map(|item| item.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn reorder_with_unknown_ids_is_ignored() {
        let db = test_db();
        let first = db
            .create_conversation("Primeira", "opencode-go", "glm-5.3-flash")
            .expect("primeira");
        let second = db
            .create_conversation("Segunda", "opencode-go", "glm-5.3-flash")
            .expect("segunda");

        db.reorder_conversations(&[
            first.id.clone(),
            "conversa-inexistente".to_string(),
            second.id.clone(),
        ])
        .expect("reordenar com id desconhecido");

        let listed = db.list_conversations().expect("listar");
        let ids = listed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, vec![first.id.as_str(), second.id.as_str()]);
    }

    #[test]
    fn reorder_workspaces_assigns_positions() {
        let db = test_db();
        let first = db
            .create_workspace("Primeiro", "C:\\projetos\\primeiro")
            .expect("primeiro");
        let second = db
            .create_workspace("Segundo", "C:\\projetos\\segundo")
            .expect("segundo");
        let third = db
            .create_workspace("Terceiro", "C:\\projetos\\terceiro")
            .expect("terceiro");

        db.reorder_workspaces(&[
            third.id.clone(),
            first.id.clone(),
            second.id.clone(),
        ])
        .expect("reordenar");

        let listed = db.list_workspaces().expect("listar");
        let ids = listed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![third.id.as_str(), first.id.as_str(), second.id.as_str()]
        );
        assert_eq!(
            listed.iter().map(|item| item.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn reorder_agents_orders_sections() {
        let db = test_db();
        let first = db.create_agent(&agent_input("Ana")).expect("ana");
        let second = db.create_agent(&agent_input("Bia")).expect("bia");
        let third = db.create_agent(&agent_input("Caio")).expect("caio");

        db.reorder_agents(&[third.id.clone(), first.id.clone(), second.id.clone()])
            .expect("reordenar departamento");
        let listed = db.list_agents(false).expect("listar");
        let ids = listed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![third.id.as_str(), first.id.as_str(), second.id.as_str()]
        );

        let mut other_department = agent_input("Dora");
        other_department.department = "Qualidade".to_string();
        let fourth = db.create_agent(&other_department).expect("dora");
        db.set_agent_pinned(&first.id, true).expect("fixar ana");
        db.set_agent_pinned(&fourth.id, true).expect("fixar dora");
        db.reorder_agents(&[fourth.id.clone(), first.id.clone()])
            .expect("reordenar fixados");

        let listed = db.list_agents(false).expect("listar fixados");
        let pinned = listed
            .iter()
            .filter(|item| item.pinned)
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(pinned, vec![fourth.id.as_str(), first.id.as_str()]);
    }

    #[test]
    fn reorder_agent_channels_assigns_positions() {
        let db = test_db();
        let agent = db.create_agent(&agent_input("Ana")).expect("agent");
        let channel_input = |name: &str| crate::agents::AgentChannelInput {
            name: name.to_string(),
            member_ids: vec![agent.id.clone()],
            leader_agent_id: None,
        };
        let first = db
            .create_agent_channel(&channel_input("Primeiro"), now_ms())
            .expect("primeiro");
        let second = db
            .create_agent_channel(&channel_input("Segundo"), now_ms())
            .expect("segundo");
        let third = db
            .create_agent_channel(&channel_input("Terceiro"), now_ms())
            .expect("terceiro");

        db.reorder_agent_channels(&[
            third.id.clone(),
            first.id.clone(),
            second.id.clone(),
        ])
        .expect("reordenar");

        let listed = db.list_agent_channels().expect("listar");
        let ids = listed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![third.id.as_str(), first.id.as_str(), second.id.as_str()]
        );
        assert_eq!(
            listed.iter().map(|item| item.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn reset_clears_code_harness_records() {
        let db = test_db();
        let workspace = db
            .create_workspace("App", "C:\\projetos\\app")
            .expect("workspace");
        let conversation = code_conversation(&db);
        db.set_conversation_workspace(&conversation.id, Some(&workspace.id))
            .expect("associar");
        db.append_code_event(&conversation.id, Some("turn-1"), "step", "{}")
            .expect("evento");
        db.append_file_journal(&FileJournalEntry::new(
            &conversation.id,
            "turn-1",
            "a.txt",
            FileChangeKind::Modified,
        ))
        .expect("journal");
        db.insert_session_summary(&conversation.id, 1, 5, "resumo", None)
            .expect("resumo");
        db.create_approval_rule(&code_harness_rule(ApprovalScope::Global, None, "shell"))
            .expect("regra global");

        db.reset().expect("reset");

        assert!(db.list_workspaces().expect("workspaces").is_empty());
        assert!(db
            .list_code_events(&conversation.id, 0)
            .expect("eventos")
            .is_empty());
        assert!(db
            .list_file_journal(&conversation.id)
            .expect("journal")
            .is_empty());
        assert!(db
            .list_session_summaries(&conversation.id)
            .expect("resumos")
            .is_empty());
        assert!(db.list_approval_rules().expect("regras").is_empty());
    }

    /* -------------------------------------------------------------- */
    /* Cache de prompt (F0b.3): schema, migração, CRUD e agregado      */
    /* -------------------------------------------------------------- */

    /// Nomes dos objetos do schema (`type` = `table` | `index`).
    fn schema_objects(conn: &Connection, kind: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name")
            .expect("inspecionar sqlite_master");
        let names = stmt
            .query_map([kind], |row| row.get::<_, String>(0))
            .expect("listar objetos do schema")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("coletar objetos do schema");
        names
    }

    fn indexed_segment(index: u32) -> SegmentDigest {
        let mut sha256 = [0u8; 32];
        sha256[..4].copy_from_slice(&index.to_le_bytes());
        SegmentDigest {
            kind: SegmentKind::Message,
            index,
            sha256,
            chars: 10,
        }
    }

    /// Amostra de cache representativa: número do passo e instante controlados.
    fn cache_sample_at(step: u32, at: i64) -> CacheSample {
        CacheSample {
            turn_id: "turn-1".to_string(),
            step,
            provider_id: "anthropic".to_string(),
            model_id: "claude-sonnet-5".to_string(),
            protocol: "anthropic".to_string(),
            epoch: 2,
            input_total: 1_000,
            cache_read: 900,
            cache_write: 0,
            uncached: 100,
            hit_percent: Some(90.0),
            ceiling_percent: Some(98.5),
            prefix_tokens_est: 900,
            delta_tokens_est: 100,
            eligible: true,
            excluded_reason: None,
            state: CacheState::Stable,
            break_reason: None,
            break_detail: None,
            raw_usage: Some(serde_json::json!({ "cache_read_input_tokens": 900 })),
            at,
        }
    }

    fn prompt_snapshot_for(conversation_id: &str) -> PromptSnapshotRecord {
        PromptSnapshotRecord {
            conversation_id: conversation_id.to_string(),
            snapshot_key: "anthropic|claude-sonnet-5|chat|ws-1|3".to_string(),
            provider_id: "anthropic".to_string(),
            model_id: "claude-sonnet-5".to_string(),
            profile: "chat".to_string(),
            workspace_id: Some("ws-1".to_string()),
            prompt_version: 3,
            system_text: "system prompt congelado".to_string(),
            tools_json: "[{\"name\":\"web_search\"}]".to_string(),
            stable_hash: "stable-hash".to_string(),
            tools_hash: "tools-hash".to_string(),
            created_at: 1_000,
            invalidated_at: None,
        }
    }

    fn render_decision_for(message_id: &str, kind: &str) -> RenderDecisionRecord {
        RenderDecisionRecord {
            message_id: message_id.to_string(),
            kind: kind.to_string(),
            digest: "digest-a".to_string(),
            payload: "{\"mode\":\"text\"}".to_string(),
            created_at: 1_000,
        }
    }

    #[test]
    fn new_databases_create_the_prompt_cache_schema() {
        let db = test_db();
        let conn = db.conn.lock();

        let tables = schema_objects(&conn, "table");
        for table in [
            "prompt_snapshots",
            "render_decisions",
            "surface_items",
            "cache_state",
            "cache_samples",
        ] {
            assert!(
                tables.iter().any(|name| name == table),
                "tabela {table} ausente: {tables:?}"
            );
        }

        let usage_columns: Vec<String> = table_columns(&conn, "usage_log")
            .expect("colunas de usage_log")
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        for column in [
            "cache_read_tokens",
            "cache_write_tokens",
            "uncached_input_tokens",
            "cache_hit_percent",
            "cache_epoch",
            "prefix_hash",
            "break_reason",
            "protocol",
        ] {
            assert!(
                usage_columns.iter().any(|name| name == column),
                "coluna {column} ausente de usage_log: {usage_columns:?}"
            );
        }

        // `cache_state` novo já nasce com o watermark do Chat (F2b).
        let cache_state_columns: Vec<String> = table_columns(&conn, "cache_state")
            .expect("colunas de cache_state")
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert!(
            cache_state_columns.iter().any(|name| name == "chat_cut_seq"),
            "coluna chat_cut_seq ausente de cache_state: {cache_state_columns:?}"
        );

        let indexes = schema_objects(&conn, "index");
        for index in [
            "idx_surface_items_dedupe",
            "idx_surface_items_order",
            "idx_surface_items_conv",
            "idx_cache_samples_conv",
        ] {
            assert!(
                indexes.iter().any(|name| name == index),
                "índice {index} ausente: {indexes:?}"
            );
        }
    }

    #[test]
    fn migrates_legacy_usage_log_with_cache_columns_preserving_rows() {
        let temp = TempDir::new("zylara-db-cache-migrate");
        let path = temp.path.join("zylara.db");
        {
            // Banco anterior ao cache de prompt: `usage_log` sem as colunas novas.
            let conn = Connection::open(&path).expect("abrir banco legado");
            conn.execute_batch(
                "CREATE TABLE usage_log (
                   id               INTEGER PRIMARY KEY AUTOINCREMENT,
                   conversation_id  TEXT,
                   message_id       TEXT,
                   provider_id      TEXT,
                   model_id         TEXT,
                   input_tokens     INTEGER,
                   output_tokens    INTEGER,
                   reasoning_tokens INTEGER,
                   cached_tokens    INTEGER,
                   total_tokens     INTEGER,
                   cost             REAL,
                   created_at       INTEGER NOT NULL
                 );
                 INSERT INTO usage_log
                   (conversation_id, message_id, provider_id, model_id, input_tokens,
                    output_tokens, created_at)
                   VALUES ('conv-legado', 'msg-legado', 'opencode-go', 'glm-5.3-flash',
                           10, 20, 5);",
            )
            .expect("schema legado de usage_log");
        }

        let db = Db::open(&path).expect("migrar banco legado");
        {
            let conn = db.conn.lock();
            let columns: Vec<String> = table_columns(&conn, "usage_log")
                .expect("colunas migradas")
                .into_iter()
                .map(|(name, _)| name)
                .collect();
            for column in [
                "cache_read_tokens",
                "cache_write_tokens",
                "uncached_input_tokens",
                "cache_hit_percent",
                "cache_epoch",
                "prefix_hash",
                "break_reason",
                "protocol",
            ] {
                assert!(
                    columns.iter().any(|name| name == column),
                    "coluna {column} não migrada: {columns:?}"
                );
            }
            // A linha antiga sobrevive à migração com as colunas novas em NULL.
            let (input_tokens, cache_read): (i64, Option<i64>) = conn
                .query_row(
                    "SELECT input_tokens, cache_read_tokens FROM usage_log \
                     WHERE message_id = 'msg-legado'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("linha legada preservada");
            assert_eq!(input_tokens, 10);
            assert_eq!(cache_read, None);
        }

        // O banco migrado continua operável: amostras e uso com cache funcionam.
        let sample = cache_sample_at(1, 1_000);
        let sample_id = db
            .insert_cache_sample("conv-legado", &sample, Some("prefix-hash"))
            .expect("amostra no banco migrado");
        assert!(sample_id > 0);
        db.record_usage_with_cache(
            "conv-legado",
            "msg-novo",
            "anthropic",
            "claude-sonnet-5",
            &UsageInfo {
                input_tokens: Some(100),
                cache_read_tokens: Some(80),
                cache_write_tokens: Some(10),
                uncached_input_tokens: Some(10),
                cache_reported: true,
                ..UsageInfo::default()
            },
            &UsageLogCache {
                cache_epoch: Some(1),
                protocol: Some("anthropic"),
                ..UsageLogCache::default()
            },
        )
        .expect("uso com cache no banco migrado");
        drop(db);

        // Migração idempotente: reabrir não perde nada nem duplica colunas.
        let reopened = Db::open(&path).expect("reabrir banco migrado");
        assert_eq!(
            reopened.list_cache_samples("conv-legado", 10).expect("amostras").len(),
            1
        );
        let usage_rank: i64 = {
            let conn = reopened.conn.lock();
            conn.query_row("SELECT COUNT(*) FROM usage_log", [], |row| row.get(0))
                .expect("contar usage_log")
        };
        assert_eq!(usage_rank, 2);
    }

    #[test]
    fn migrates_legacy_cache_state_with_the_chat_cut_watermark() {
        let temp = TempDir::new("zylara-db-chat-cut-migrate");
        let path = temp.path.join("zylara.db");
        {
            // `cache_state` do F0b.3, antes do watermark do histórico do Chat.
            let conn = Connection::open(&path).expect("abrir banco legado");
            conn.execute_batch(
                "CREATE TABLE cache_state (
                   conversation_id      TEXT PRIMARY KEY,
                   provider_id          TEXT,
                   model_id             TEXT,
                   protocol             TEXT,
                   epoch                INTEGER NOT NULL DEFAULT 0,
                   prefix_hash          TEXT,
                   prefix_segments      TEXT,
                   prompt_snapshot_hash TEXT,
                   cache_read           INTEGER NOT NULL DEFAULT 0,
                   cache_write          INTEGER NOT NULL DEFAULT 0,
                   uncached             INTEGER NOT NULL DEFAULT 0,
                   samples              INTEGER NOT NULL DEFAULT 0,
                   last_hit_percent     REAL,
                   last_ceiling_percent REAL,
                   last_at              INTEGER,
                   last_break_reason    TEXT,
                   last_break_detail    TEXT,
                   updated_at           INTEGER NOT NULL
                 );
                 INSERT INTO cache_state
                   (conversation_id, provider_id, model_id, protocol, epoch, cache_read,
                    samples, last_hit_percent, updated_at)
                   VALUES ('conv-legado', 'anthropic', 'claude-sonnet-5', 'anthropic', 2, 900,
                           1, 97.5, 1700000000000);",
            )
            .expect("schema legado de cache_state");
        }

        let db = Db::open(&path).expect("migrar banco legado");
        {
            let conn = db.conn.lock();
            let columns: Vec<String> = table_columns(&conn, "cache_state")
                .expect("colunas migradas")
                .into_iter()
                .map(|(name, _)| name)
                .collect();
            assert!(
                columns.iter().any(|name| name == "chat_cut_seq"),
                "coluna chat_cut_seq não migrada: {columns:?}"
            );
            // A linha antiga sobrevive com o watermark NULL (= sem corte).
            let (epoch, cache_read, chat_cut_seq): (i64, i64, Option<i64>) = conn
                .query_row(
                    "SELECT epoch, cache_read, chat_cut_seq FROM cache_state \
                     WHERE conversation_id = 'conv-legado'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("linha legada preservada");
            assert_eq!(epoch, 2);
            assert_eq!(cache_read, 900);
            assert_eq!(chat_cut_seq, None);
        }

        // O mapper enxerga a coluna migrada como `None` (sem corte).
        let stored = db
            .get_cache_state("conv-legado")
            .expect("get legado")
            .expect("presente");
        assert_eq!(stored.chat_cut_seq, None);
        assert_eq!(stored.cache_read, 900);

        // Upsert grava o watermark no banco migrado.
        let mut updated = stored.clone();
        updated.epoch = 3;
        updated.chat_cut_seq = Some(17);
        updated.updated_at = 1_700_000_000_100;
        db.upsert_cache_state(&updated).expect("upsert no banco migrado");
        assert_eq!(
            db.get_cache_state("conv-legado").expect("get 2").expect("presente"),
            updated
        );
        drop(db);

        // Migração idempotente: reabrir mantém a coluna e o valor.
        let reopened = Db::open(&path).expect("reabrir banco migrado");
        let persisted = reopened
            .get_cache_state("conv-legado")
            .expect("get 3")
            .expect("presente");
        assert_eq!(persisted.chat_cut_seq, Some(17));
        let columns = {
            let conn = reopened.conn.lock();
            table_columns(&conn, "cache_state").expect("colunas reabertas")
        };
        assert_eq!(
            columns.iter().filter(|(name, _)| name == "chat_cut_seq").count(),
            1,
            "a coluna não pode duplicar ao reabrir"
        );
    }

    #[test]
    fn record_usage_with_cache_persists_columns_and_usage_summary_aggregates() {
        let db = test_db();
        let usage = UsageInfo {
            input_tokens: Some(100),
            cache_read_tokens: Some(70),
            cache_write_tokens: Some(20),
            uncached_input_tokens: Some(10),
            cache_reported: true,
            ..UsageInfo::default()
        };
        db.record_usage_with_cache(
            "conv-1",
            "msg-1",
            "anthropic",
            "claude-sonnet-5",
            &usage,
            &UsageLogCache {
                cache_epoch: Some(3),
                prefix_hash: Some("abc123"),
                break_reason: Some(CacheBreakReason::TtlExpired),
                protocol: Some("anthropic"),
                ..UsageLogCache::default()
            },
        )
        .expect("uso com cache");

        // `record_usage` (assinatura antiga, usada pelo harness) grava os campos
        // derivados de `UsageInfo` e deriva o hit% quando o provedor reportou.
        db.record_usage(
            "conv-2",
            "msg-2",
            "openai",
            "gpt-6-luna",
            &UsageInfo {
                input_tokens: Some(200),
                cached_tokens: Some(40),
                cache_reported: true,
                ..UsageInfo::default()
            },
        )
        .expect("uso legado com cache");

        // `cache_hit_percent` explícito tem prioridade sobre o derivado.
        db.record_usage_with_cache(
            "conv-3",
            "msg-3",
            "openai",
            "gpt-6-luna",
            &usage,
            &UsageLogCache {
                cache_hit_percent: Some(42.5),
                ..UsageLogCache::default()
            },
        )
        .expect("hit explícito");

        {
            let conn = db.conn.lock();
            let row: (
                Option<i64>,
                Option<i64>,
                Option<i64>,
                Option<f64>,
                Option<i64>,
                Option<String>,
                Option<String>,
                Option<String>,
            ) = conn
                .query_row(
                    "SELECT cache_read_tokens, cache_write_tokens, uncached_input_tokens, \
                     cache_hit_percent, cache_epoch, prefix_hash, break_reason, protocol \
                     FROM usage_log WHERE message_id = 'msg-1'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    },
                )
                .expect("linha com cache");
            assert_eq!(row.0, Some(70));
            assert_eq!(row.1, Some(20));
            assert_eq!(row.2, Some(10));
            assert_eq!(row.3, Some(70.0));
            assert_eq!(row.4, Some(3));
            assert_eq!(row.5.as_deref(), Some("abc123"));
            assert_eq!(row.6.as_deref(), Some("ttl_expired"));
            assert_eq!(row.7.as_deref(), Some("anthropic"));

            let derived: (Option<i64>, Option<f64>) = conn
                .query_row(
                    "SELECT cache_read_tokens, cache_hit_percent FROM usage_log \
                     WHERE message_id = 'msg-2'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("linha derivada");
            assert_eq!(derived.0, Some(40));
            assert_eq!(derived.1, Some(20.0));

            let explicit: Option<f64> = conn
                .query_row(
                    "SELECT cache_hit_percent FROM usage_log WHERE message_id = 'msg-3'",
                    [],
                    |row| row.get(0),
                )
                .expect("hit explícito");
            assert_eq!(explicit, Some(42.5));
        }

        let summary = db.usage_summary().expect("summary");
        assert_eq!(summary["totals"]["requests"], 3);
        assert_eq!(summary["totals"]["cacheReadTokens"], 180);
        assert_eq!(summary["totals"]["cacheWriteTokens"], 40);
        assert_eq!(summary["totals"]["uncachedInputTokens"], 20);
    }

    #[test]
    fn cache_samples_roundtrip_newest_first_with_session_aggregate() {
        let db = test_db();
        let first = cache_sample_at(1, 1_000);
        let first_id = db
            .insert_cache_sample("conv-1", &first, Some("prefix-1"))
            .expect("amostra 1");
        assert!(first_id > 0);

        let mut second = cache_sample_at(2, 2_000);
        second.eligible = false;
        second.excluded_reason = Some("below_min".to_string());
        second.state = CacheState::Warming;
        second.break_reason = Some(CacheBreakReason::FirstRequest);
        second.hit_percent = None;
        second.ceiling_percent = None;
        second.raw_usage = None;
        db.insert_cache_sample("conv-1", &second, None)
            .expect("amostra 2");

        let samples = db.list_cache_samples("conv-1", 10).expect("listar");
        assert_eq!(samples.len(), 2);
        // Diagnóstico: a amostra mais recente vem primeiro.
        assert_eq!(samples[0].step, 2);
        assert_eq!(
            serde_json::to_value(&samples[1]).expect("json amostra"),
            serde_json::to_value(&first).expect("json esperado")
        );
        assert_eq!(
            serde_json::to_value(&samples[0]).expect("json amostra 2"),
            serde_json::to_value(&second).expect("json esperado 2")
        );
        // Isolamento por conversa e limite (0 = vazio).
        assert!(db.list_cache_samples("conv-2", 10).expect("outra").is_empty());
        assert_eq!(db.list_cache_samples("conv-1", 1).expect("limite").len(), 1);
        assert!(db.list_cache_samples("conv-1", 0).expect("zero").is_empty());

        // `prefix_hash` (ausente do contrato de IPC) também é persistido.
        let stored_prefix: Option<String> = {
            let conn = db.conn.lock();
            conn.query_row(
                "SELECT prefix_hash FROM cache_samples \
                 WHERE conversation_id = 'conv-1' AND step = 1",
                [],
                |row| row.get(0),
            )
            .expect("prefix_hash")
        };
        assert_eq!(stored_prefix.as_deref(), Some("prefix-1"));

        let aggregate = db.cache_session_aggregate("conv-1").expect("agregado");
        assert_eq!(aggregate.samples, 2);
        assert_eq!(aggregate.eligible_samples, 1);
        assert_eq!(aggregate.input_total, 2_000);
        assert_eq!(aggregate.cache_read, 1_800);
        assert_eq!(aggregate.cache_write, 0);
        assert_eq!(aggregate.uncached, 200);
        assert_eq!(aggregate.eligible_input_total, 1_000);
        assert_eq!(aggregate.eligible_cache_read, 900);
        assert_eq!(aggregate.hit_percent(), Some(90.0));
        assert_eq!(aggregate.eligible_hit_percent(), Some(90.0));

        // Sem amostras o agregado é neutro e não inventa hit%.
        let empty = db.cache_session_aggregate("conv-vazia").expect("vazio");
        assert_eq!(empty, CacheSessionAggregate::default());
        assert_eq!(empty.hit_percent(), None);
        assert_eq!(empty.eligible_hit_percent(), None);
    }

    #[test]
    fn cache_samples_retention_keeps_the_most_recent_500() {
        let db = test_db();
        let total = CACHE_SAMPLES_RETENTION + 5;
        for step in 0..total {
            let mut sample = cache_sample_at(step, i64::from(step) + 1);
            sample.input_total = step;
            sample.cache_read = 0;
            sample.uncached = step;
            sample.prefix_tokens_est = 0;
            sample.delta_tokens_est = step;
            db.insert_cache_sample("conv-retencao", &sample, None)
                .expect("inserir amostra");
        }

        let samples = db
            .list_cache_samples("conv-retencao", total + 10)
            .expect("listar após retenção");
        assert_eq!(samples.len() as u32, CACHE_SAMPLES_RETENTION);
        // As 5 mais antigas rodaram: a mais nova e a mais antiga mantida.
        assert_eq!(samples[0].step, total - 1);
        assert_eq!(
            samples[samples.len() - 1].step,
            total - CACHE_SAMPLES_RETENTION
        );
        let aggregate = db
            .cache_session_aggregate("conv-retencao")
            .expect("agregado");
        assert_eq!(aggregate.samples, CACHE_SAMPLES_RETENTION);
    }

    #[test]
    fn cache_state_upserts_roundtrips_and_caps_prefix_segments() {
        let db = test_db();
        assert!(db.get_cache_state("conv-1").expect("get vazio").is_none());

        let mut state = CacheStateRecord::new("conv-1");
        state.provider_id = Some("anthropic".to_string());
        state.model_id = Some("claude-sonnet-5".to_string());
        state.protocol = Some("anthropic".to_string());
        state.epoch = 2;
        state.prefix_hash = Some("prefix-sha".to_string());
        state.prefix_segments = Some(vec![indexed_segment(0), indexed_segment(1)]);
        state.prompt_snapshot_hash = Some("snapshot-sha".to_string());
        state.chat_cut_seq = Some(42);
        state.cache_read = 1_800;
        state.cache_write = 100;
        state.uncached = 100;
        state.samples = 2;
        state.last_hit_percent = Some(90.0);
        state.last_ceiling_percent = Some(98.5);
        state.last_at = Some(1_700_000_000_000);
        state.last_break_reason = Some(CacheBreakReason::SystemPrompt);
        state.last_break_detail = Some("system mudou".to_string());
        state.updated_at = 1_700_000_000_100;

        db.upsert_cache_state(&state).expect("upsert");
        assert_eq!(
            db.get_cache_state("conv-1").expect("get").expect("presente"),
            state
        );

        // Upsert substitui (1 linha por conversa) os contadores e o epoch.
        state.epoch = 3;
        state.samples = 3;
        state.last_hit_percent = None;
        state.last_break_reason = Some(CacheBreakReason::ModelSwitch);
        state.updated_at = 1_700_000_000_200;
        db.upsert_cache_state(&state).expect("upsert 2");
        assert_eq!(
            db.get_cache_state("conv-1").expect("get 2").expect("presente"),
            state
        );
        let rows: i64 = {
            let conn = db.conn.lock();
            conn.query_row(
                "SELECT COUNT(*) FROM cache_state WHERE conversation_id = 'conv-1'",
                [],
                |row| row.get(0),
            )
            .expect("contar cache_state")
        };
        assert_eq!(rows, 1);

        // O JSON de `prefix_segments` tem cap de 500 segmentos (head preservado).
        let mut capped = CacheStateRecord::new("conv-cap");
        capped.prefix_segments = Some(
            (0..CACHE_STATE_MAX_SEGMENTS as u32 + 10)
                .map(indexed_segment)
                .collect(),
        );
        db.upsert_cache_state(&capped).expect("upsert cap");
        let stored = db
            .get_cache_state("conv-cap")
            .expect("get cap")
            .expect("presente");
        let segments = stored.prefix_segments.expect("segmentos");
        assert_eq!(segments.len(), CACHE_STATE_MAX_SEGMENTS);
        assert_eq!(segments[0], indexed_segment(0));

        // JSON corrompido em banco antigo cai em `None` sem quebrar a leitura.
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE cache_state SET prefix_segments = 'nao-e-json' \
                 WHERE conversation_id = 'conv-cap'",
                [],
            )
            .expect("corromper json");
        }
        assert_eq!(
            db.get_cache_state("conv-cap")
                .expect("get corrompido")
                .expect("presente")
                .prefix_segments,
            None
        );
    }

    #[test]
    fn cache_state_chat_cut_watermark_roundtrips_and_partial_updates_keep_the_rest() {
        let db = test_db();

        // `NULL` = histórico do Chat sem corte: roundtrip com todos os campos.
        let mut state = CacheStateRecord::new("conv-cut");
        state.provider_id = Some("anthropic".to_string());
        state.model_id = Some("claude-sonnet-5".to_string());
        state.protocol = Some("anthropic".to_string());
        state.epoch = 1;
        state.prefix_hash = Some("prefix".to_string());
        state.prefix_segments = Some(vec![indexed_segment(0)]);
        state.prompt_snapshot_hash = Some("snapshot".to_string());
        state.chat_cut_seq = None;
        state.cache_read = 100;
        state.cache_write = 10;
        state.uncached = 5;
        state.samples = 1;
        state.last_hit_percent = Some(95.0);
        state.last_ceiling_percent = Some(99.0);
        state.last_at = Some(1_000);
        state.last_break_reason = Some(CacheBreakReason::FirstRequest);
        state.last_break_detail = Some("primeiro request".to_string());
        state.updated_at = 2_000;
        db.upsert_cache_state(&state).expect("upsert sem corte");
        assert_eq!(
            db.get_cache_state("conv-cut").expect("get").expect("presente"),
            state
        );

        // Watermark definido: roundtrip exato do `seq` da primeira mensagem incluída.
        state.chat_cut_seq = Some(42);
        db.upsert_cache_state(&state).expect("upsert com corte");
        let stored = db
            .get_cache_state("conv-cut")
            .expect("get 2")
            .expect("presente");
        assert_eq!(stored.chat_cut_seq, Some(42));
        assert_eq!(stored, state);

        // Atualização posterior do watermark (e do `updated_at`) não perde os
        // demais campos da linha única da conversa.
        state.chat_cut_seq = Some(60);
        state.updated_at = 3_000;
        db.upsert_cache_state(&state).expect("upsert watermark novo");
        let updated = db
            .get_cache_state("conv-cut")
            .expect("get 3")
            .expect("presente");
        assert_eq!(updated.chat_cut_seq, Some(60));
        assert_eq!(updated, state);
        assert_eq!(updated.provider_id.as_deref(), Some("anthropic"));
        assert_eq!(updated.cache_read, 100);
        assert_eq!(updated.prefix_segments, state.prefix_segments);

        // Voltar para `NULL` (fim do corte de emergência) também persiste.
        state.chat_cut_seq = None;
        db.upsert_cache_state(&state).expect("upsert sem corte 2");
        let cleared = db
            .get_cache_state("conv-cut")
            .expect("get 4")
            .expect("presente");
        assert_eq!(cleared.chat_cut_seq, None);
        assert_eq!(cleared, state);

        // `Some(0)` não é um `seq` válido (o replay começa em 1): vira `NULL` e
        // os outros campos continuam gravados.
        state.chat_cut_seq = Some(0);
        db.upsert_cache_state(&state).expect("upsert zero");
        let normalized = db
            .get_cache_state("conv-cut")
            .expect("get 5")
            .expect("presente");
        assert_eq!(normalized.chat_cut_seq, None);
        assert_eq!(normalized.cache_read, 100);
        assert_eq!(normalized.prefix_hash.as_deref(), Some("prefix"));
    }

    #[test]
    fn surface_items_dedupe_by_digest_and_list_in_append_order() {
        let db = test_db();
        let conversation = db
            .create_conversation("Cache", "anthropic", "claude-sonnet-5")
            .expect("conversa");
        let first = user_message(&conversation.id, "oi", 1_000);
        let second = assistant_message(&conversation.id, 2_000);
        db.insert_message(&first).expect("mensagem 1");
        db.insert_message(&second).expect("mensagem 2");

        assert!(db
            .insert_surface_item(&SurfaceItemRecord::new(
                &conversation.id,
                None,
                None,
                "runtime",
                "runtime: chat",
            ))
            .expect("item inicial"));
        let plan = SurfaceItemRecord::new(
            &conversation.id,
            Some(&first.id),
            None,
            "plan",
            "plano v1",
        )
        .with_seq(1);
        assert!(db.insert_surface_item(&plan).expect("item plano"));
        let mode = SurfaceItemRecord::new(
            &conversation.id,
            Some(&first.id),
            Some(2),
            "mode",
            "modo: edit",
        );
        assert!(db.insert_surface_item(&mode).expect("item modo"));
        let workspace = SurfaceItemRecord::new(
            &conversation.id,
            Some(&second.id),
            None,
            "workspace",
            "workspace: app",
        );
        assert!(db.insert_surface_item(&workspace).expect("item workspace"));

        // Mesmo texto (mesmo digest, id novo) não duplica na mesma conversa.
        let duplicate = SurfaceItemRecord::new(
            &conversation.id,
            Some(&second.id),
            None,
            "workspace",
            "workspace: app",
        );
        assert_eq!(duplicate.digest, workspace.digest);
        assert!(!db.insert_surface_item(&duplicate).expect("dedupe"));

        // O dedupe é por conversa: em outra sessão o mesmo texto entra.
        let other = db
            .create_conversation("Outra", "anthropic", "claude-sonnet-5")
            .expect("outra conversa");
        assert!(db
            .insert_surface_item(&SurfaceItemRecord::new(
                &other.id,
                None,
                None,
                "runtime",
                "runtime: chat",
            ))
            .expect("mesmo texto em outra conversa"));

        let items = db.list_surface_items(&conversation.id).expect("listar");
        let kinds: Vec<&str> = items.iter().map(|item| item.kind.as_str()).collect();
        assert_eq!(kinds, ["runtime", "plan", "mode", "workspace"]);
        assert_eq!(items[0].digest, surface_digest("runtime: chat"));
        assert_eq!(items[0].digest.len(), 64);
        assert!(items[0].digest.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(items[1].after_message_id.as_deref(), Some(first.id.as_str()));
        assert_eq!(items[1].seq, 1);
        assert_eq!(items[2].after_step, Some(2));
        assert_eq!(
            items[3].after_message_id.as_deref(),
            Some(second.id.as_str())
        );
        assert_eq!(db.list_surface_items(&other.id).expect("outra").len(), 1);

        // Delete por id, restrito à conversa, idempotente.
        assert!(db
            .delete_surface_item(&conversation.id, &items[2].id)
            .expect("delete"));
        assert!(!db
            .delete_surface_item(&conversation.id, &items[2].id)
            .expect("delete 2"));
        assert!(!db
            .delete_surface_item(&other.id, &items[1].id)
            .expect("delete de outra conversa"));
        assert_eq!(
            db.list_surface_items(&conversation.id).expect("após delete").len(),
            3
        );
    }

    #[test]
    fn delete_surface_items_after_removes_only_the_anchored_tail() {
        let db = test_db();
        let conversation = db
            .create_conversation("Cache", "anthropic", "claude-sonnet-5")
            .expect("conversa");
        let first = user_message(&conversation.id, "um", 1_000);
        let second = assistant_message(&conversation.id, 2_000);
        let third = user_message(&conversation.id, "três", 3_000);
        for message in [&first, &second, &third] {
            db.insert_message(message).expect("mensagem");
        }
        db.insert_surface_item(&SurfaceItemRecord::new(
            &conversation.id,
            None,
            None,
            "runtime",
            "runtime: chat",
        ))
        .expect("inicial");
        db.insert_surface_item(&SurfaceItemRecord::new(
            &conversation.id,
            Some(&first.id),
            None,
            "plan",
            "plano",
        ))
        .expect("no primeiro");
        db.insert_surface_item(&SurfaceItemRecord::new(
            &conversation.id,
            Some(&second.id),
            None,
            "mode",
            "modo",
        ))
        .expect("no segundo");
        db.insert_surface_item(&SurfaceItemRecord::new(
            &conversation.id,
            Some(&third.id),
            None,
            "workspace",
            "workspace",
        ))
        .expect("no terceiro");

        // Remove a partir de `second` inclusive: sobram início + ancorado no first.
        assert_eq!(
            db.delete_surface_items_after(&conversation.id, &second.id)
                .expect("poda"),
            2
        );
        let items = db.list_surface_items(&conversation.id).expect("após poda");
        let kinds: Vec<&str> = items.iter().map(|item| item.kind.as_str()).collect();
        assert_eq!(kinds, ["runtime", "plan"]);

        // Âncora já removida: remove só o que aponta diretamente para ela.
        assert_eq!(
            db.delete_surface_items_after(&conversation.id, &second.id)
                .expect("poda idempotente"),
            0
        );
        assert_eq!(
            db.delete_surface_items_after(&conversation.id, &first.id)
                .expect("poda do restante"),
            1
        );
        assert_eq!(
            db.list_surface_items(&conversation.id).expect("final").len(),
            1
        );
    }

    #[test]
    fn prompt_snapshots_and_render_decisions_roundtrip_and_upsert() {
        let db = test_db();
        assert!(db
            .get_prompt_snapshot("conv-1", "anthropic|claude-sonnet-5|chat|ws-1|3")
            .expect("get vazio")
            .is_none());

        let snapshot = prompt_snapshot_for("conv-1");
        db.upsert_prompt_snapshot(&snapshot).expect("upsert");
        assert_eq!(
            db.get_prompt_snapshot("conv-1", &snapshot.snapshot_key)
                .expect("get")
                .expect("presente"),
            snapshot
        );

        // Upsert na mesma chave substitui o conteúdo (invalidação explícita).
        let mut invalidated = snapshot.clone();
        invalidated.prompt_version = 4;
        invalidated.system_text = "system prompt v2".to_string();
        invalidated.invalidated_at = Some(2_000);
        db.upsert_prompt_snapshot(&invalidated).expect("upsert 2");
        let stored = db
            .get_prompt_snapshot("conv-1", &snapshot.snapshot_key)
            .expect("get 2")
            .expect("presente");
        assert_eq!(stored.prompt_version, 4);
        assert_eq!(stored.invalidated_at, Some(2_000));
        assert_eq!(stored.system_text, "system prompt v2");

        // Chave diferente na mesma conversa é outro snapshot; outra conversa idem.
        let mut other_key = snapshot.clone();
        other_key.snapshot_key = "anthropic|claude-sonnet-5|code|ws-1|4".to_string();
        db.upsert_prompt_snapshot(&other_key).expect("outra chave");
        assert!(db
            .get_prompt_snapshot("conv-1", &other_key.snapshot_key)
            .expect("get outra chave")
            .is_some());
        assert!(db
            .get_prompt_snapshot("conv-2", &snapshot.snapshot_key)
            .expect("outra conversa")
            .is_none());

        // Decisões de render congeladas: get/upsert/list por mensagem.
        assert!(db
            .get_render_decision("msg-1", "image")
            .expect("get vazio")
            .is_none());
        let decision = render_decision_for("msg-1", "image");
        db.upsert_render_decision(&decision).expect("upsert");
        assert_eq!(
            db.get_render_decision("msg-1", "image")
                .expect("get")
                .expect("presente"),
            decision
        );
        let mut updated = decision.clone();
        updated.digest = "digest-b".to_string();
        updated.payload = "{\"mode\":\"attachment\"}".to_string();
        db.upsert_render_decision(&updated).expect("upsert 2");
        assert_eq!(
            db.get_render_decision("msg-1", "image")
                .expect("get 2")
                .expect("presente"),
            updated
        );
        let attachment = render_decision_for("msg-1", "attachment");
        db.upsert_render_decision(&attachment).expect("attachment");
        let decisions = db.list_render_decisions("msg-1").expect("listar");
        assert_eq!(decisions.len(), 2);
        assert_eq!(decisions[0].kind, "attachment");
        assert_eq!(decisions[1].kind, "image");
    }

    #[test]
    fn delete_conversation_and_reset_clean_the_prompt_cache_rows() {
        let db = test_db();
        let conversation = db
            .create_conversation("Cache", "anthropic", "claude-sonnet-5")
            .expect("conversa");
        let message = user_message(&conversation.id, "oi", 1_000);
        db.insert_message(&message).expect("mensagem");
        db.insert_surface_item(&SurfaceItemRecord::new(
            &conversation.id,
            Some(&message.id),
            None,
            "plan",
            "plano",
        ))
        .expect("surface");
        db.insert_cache_sample(&conversation.id, &cache_sample_at(1, 1_000), None)
            .expect("amostra");
        db.upsert_cache_state(&CacheStateRecord::new(&conversation.id))
            .expect("estado");
        db.upsert_prompt_snapshot(&prompt_snapshot_for(&conversation.id))
            .expect("snapshot");
        db.upsert_render_decision(&render_decision_for(&message.id, "image"))
            .expect("decisão");

        db.delete_conversation(&conversation.id)
            .expect("apagar conversa");
        assert!(db
            .list_surface_items(&conversation.id)
            .expect("surface")
            .is_empty());
        assert_eq!(
            db.cache_session_aggregate(&conversation.id).expect("agregado"),
            CacheSessionAggregate::default()
        );
        assert!(db.get_cache_state(&conversation.id).expect("estado").is_none());
        assert!(db
            .get_prompt_snapshot(&conversation.id, "anthropic|claude-sonnet-5|chat|ws-1|3")
            .expect("snapshot")
            .is_none());
        assert!(db
            .list_render_decisions(&message.id)
            .expect("decisões")
            .is_empty());

        // `reset` limpa as tabelas de cache também.
        let other = db
            .create_conversation("Outra", "anthropic", "claude-sonnet-5")
            .expect("outra conversa");
        db.insert_surface_item(&SurfaceItemRecord::new(
            &other.id,
            None,
            None,
            "runtime",
            "runtime: chat",
        ))
        .expect("surface reset");
        db.insert_cache_sample(&other.id, &cache_sample_at(1, 1_000), None)
            .expect("amostra reset");
        db.upsert_cache_state(&CacheStateRecord::new(&other.id))
            .expect("estado reset");
        db.upsert_prompt_snapshot(&prompt_snapshot_for(&other.id))
            .expect("snapshot reset");
        db.upsert_render_decision(&render_decision_for("msg-reset", "image"))
            .expect("decisão reset");

        db.reset().expect("reset");
        assert!(db.list_surface_items(&other.id).expect("surface").is_empty());
        assert!(db.list_cache_samples(&other.id, 10).expect("amostras").is_empty());
        assert!(db.get_cache_state(&other.id).expect("estado").is_none());
        assert!(db
            .get_prompt_snapshot(&other.id, "anthropic|claude-sonnet-5|chat|ws-1|3")
            .expect("snapshot")
            .is_none());
        assert!(db
            .list_render_decisions("msg-reset")
            .expect("decisões")
            .is_empty());
    }

    #[test]
    fn deleting_messages_from_drops_the_prompt_cache_orphans_of_the_tail() {
        let db = test_db();
        let conversation = db
            .create_conversation("Cache", "anthropic", "claude-sonnet-5")
            .expect("conversa");
        let first = user_message(&conversation.id, "um", 1_000);
        let second = assistant_message(&conversation.id, 2_000);
        let third = user_message(&conversation.id, "três", 3_000);
        for message in [&first, &second, &third] {
            db.insert_message(message).expect("mensagem");
        }
        db.insert_surface_item(&SurfaceItemRecord::new(
            &conversation.id,
            Some(&first.id),
            None,
            "plan",
            "plano mantido",
        ))
        .expect("surface mantido");
        db.insert_surface_item(&SurfaceItemRecord::new(
            &conversation.id,
            Some(&second.id),
            None,
            "mode",
            "modo removido",
        ))
        .expect("surface removido");
        db.upsert_render_decision(&render_decision_for(&first.id, "image"))
            .expect("decisão mantida");
        db.upsert_render_decision(&render_decision_for(&third.id, "replay"))
            .expect("decisão removida");

        db.delete_messages_from(&conversation.id, &second.id)
            .expect("poda de mensagens");

        assert_eq!(db.list_messages(&conversation.id).expect("mensagens").len(), 1);
        let items = db.list_surface_items(&conversation.id).expect("surface");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "plano mantido");
        assert_eq!(db.list_render_decisions(&first.id).expect("mantida").len(), 1);
        assert!(db
            .list_render_decisions(&third.id)
            .expect("removida")
            .is_empty());
    }

    #[test]
    fn migrates_legacy_messages_with_origin_defaulting_to_user() {
        // Banco anterior ao sistema de objetivos: a tabela `messages` não tem
        // `origin` (nem o `trace` da trilha do agente, migrado no mesmo passo).
        let conn = Connection::open_in_memory().expect("in-memory connection");
        conn.execute_batch(
            "CREATE TABLE messages (
               id              TEXT PRIMARY KEY,
               conversation_id TEXT NOT NULL,
               role            TEXT NOT NULL,
               content         TEXT NOT NULL DEFAULT '',
               reasoning       TEXT,
               status          TEXT NOT NULL,
               tool_calls      TEXT NOT NULL DEFAULT '[]',
               citations       TEXT NOT NULL DEFAULT '[]',
               attachments     TEXT NOT NULL DEFAULT '[]',
               model_id        TEXT,
               provider_id     TEXT,
               usage           TEXT,
               provider_state  TEXT,
               created_at      INTEGER NOT NULL
             );
             INSERT INTO messages (id, conversation_id, role, status, content, created_at)
               VALUES ('m1', 'c1', 'user', 'complete', 'pergunta antiga', 1),
                      ('m2', 'c1', 'assistant', 'complete', 'resposta antiga', 2);",
        )
        .expect("legacy schema");

        Db::init_connection(&conn).expect("migration");

        // Todas as linhas continuam lá e viram `origin = 'user'` — a origem que
        // o app exibia antes do sistema de objetivos.
        let origins: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT origin FROM messages ORDER BY created_at")
                .expect("prepare origins");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query origins");
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect origins")
        };
        assert_eq!(origins, vec!["user", "user"]);

        // O mapper também cai no default `TurnKind::User` e preserva o conteúdo.
        let db = Db {
            conn: parking_lot::Mutex::new(conn),
        };
        let stored = db.list_messages("c1").expect("listar mensagens");
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].content, "pergunta antiga");
        assert_eq!(stored[1].content, "resposta antiga");
        assert!(
            stored
                .iter()
                .all(|message| message.origin == TurnKind::User),
            "bancos legados não têm rodada de objetivo"
        );

        // Reabrir o banco roda a migração de novo sem alterar nada.
        {
            let conn = db.conn.lock();
            Db::init_connection(&conn).expect("idempotent migration");
        }
        assert_eq!(db.list_messages("c1").expect("listar de novo").len(), 2);
    }

    #[test]
    fn messages_roundtrip_the_origin_turn_kind() {
        let db = test_db();
        let conversation = db
            .create_conversation("Objetivo", "anthropic", "claude-sonnet-5")
            .expect("conversa");

        let mut round = user_message(&conversation.id, "primeira rodada", 1_000);
        round.origin = TurnKind::GoalRound;
        db.insert_message(&round).expect("inserir rodada");
        let stored = db.get_message(&round.id).expect("ler").expect("presente");
        assert_eq!(stored.origin, TurnKind::GoalRound);
        assert_eq!(stored.role, MessageRole::User);

        // O default do contrato continua `user`.
        let human = user_message(&conversation.id, "mensagem humana", 2_000);
        db.insert_message(&human).expect("inserir humana");
        assert_eq!(
            db.get_message(&human.id)
                .expect("ler humana")
                .expect("presente")
                .origin,
            TurnKind::User
        );

        let listed = db.list_messages(&conversation.id).expect("listar");
        assert_eq!(
            listed
                .iter()
                .map(|message| message.origin)
                .collect::<Vec<_>>(),
            vec![TurnKind::GoalRound, TurnKind::User],
            "a origem sobrevive à leitura em lista, não só por id"
        );

        // `update_message` também persiste a troca de origem.
        let mut human = human;
        human.origin = TurnKind::GoalRound;
        db.update_message(&human).expect("update origem");
        assert_eq!(
            db.get_message(&human.id)
                .expect("ler")
                .expect("presente")
                .origin,
            TurnKind::GoalRound
        );
        let mut round = round;
        round.origin = TurnKind::User;
        db.update_message(&round).expect("update origem de volta");
        assert_eq!(
            db.get_message(&round.id)
                .expect("ler")
                .expect("presente")
                .origin,
            TurnKind::User
        );

        // Valor desconhecido (banco legado/corrompido) cai em `user`.
        {
            let conn = db.conn.lock();
            conn.execute(
                "UPDATE messages SET origin = 'legado' WHERE id = ?1",
                [&human.id],
            )
            .expect("valor desconhecido");
        }
        assert_eq!(
            db.get_message(&human.id)
                .expect("ler")
                .expect("presente")
                .origin,
            TurnKind::User
        );
    }

    #[test]
    fn lists_code_events_by_kind_ordered_and_limited() {
        let db = test_db();
        // seq: 1 goal/state, 2 step, 3 goal/round, 4 goal/state, 5 tool,
        // 6 goal/round-started.
        for (kind, payload) in [
            ("goal/state", r#"{"status":"active","revision":1}"#),
            ("step", r#"{"step":1}"#),
            ("goal/round", r#"{"index":1,"outcome":"done"}"#),
            ("goal/state", r#"{"status":"active","revision":2}"#),
            ("tool", r#"{"tool":"read"}"#),
            ("goal/round-started", r#"{"index":2,"turnId":"turn-2"}"#),
        ] {
            db.append_code_event("conv-1", None, kind, payload)
                .expect("evento");
        }
        db.append_code_event("conv-2", None, "goal/state", "{}")
            .expect("outra conversa");

        let selected = db
            .list_code_events_by_kinds("conv-1", &["goal/state", "goal/round"], None)
            .expect("filtrar");
        assert_eq!(
            selected.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![4, 3, 1],
            "mais recentes primeiro"
        );
        assert_eq!(
            selected
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["goal/state", "goal/round", "goal/state"]
        );
        assert_eq!(
            selected[0].payload, r#"{"status":"active","revision":2}"#,
            "o payload inteiro é preservado"
        );

        let limited = db
            .list_code_events_by_kinds("conv-1", &["goal/state", "goal/round"], Some(2))
            .expect("limite");
        assert_eq!(
            limited.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![4, 3],
            "o limite corta depois do filtro e da ordenação"
        );

        // Espaços em volta dos kinds são ignorados (como em append_code_event).
        let trimmed = db
            .list_code_events_by_kinds("conv-1", &["  goal/round-started  "], None)
            .expect("trim");
        assert_eq!(trimmed.len(), 1);
        assert_eq!(trimmed[0].seq, 6);

        // Lista vazia/só espaços, limite 0 e conversa vazia devolvem vazio.
        assert!(db
            .list_code_events_by_kinds("conv-1", &[], None)
            .expect("vazio")
            .is_empty());
        assert!(db
            .list_code_events_by_kinds("conv-1", &["   "], None)
            .expect("só espaços")
            .is_empty());
        assert!(db
            .list_code_events_by_kinds("conv-1", &["goal/state"], Some(0))
            .expect("limite 0")
            .is_empty());
        assert!(db
            .list_code_events_by_kinds("conv-inexistente", &["goal/state"], None)
            .expect("conversa vazia")
            .is_empty());
        // Eventos de outra conversa não vazam para o filtro.
        assert_eq!(
            db.list_code_events_by_kinds("conv-2", &["goal/state"], None)
                .expect("conversa 2")
                .len(),
            1
        );
    }

    #[test]
    fn interrupted_streaming_messages_are_settled_on_open() {
        let dir = TempDir::new("zylara-interrupted-messages");
        let path = dir.path.join("test.db");
        let message_id = {
            let db = Db::open(&path).expect("open");
            let conversation = db
                .create_conversation("Nova conversa", "opencode-go", "deepseek-v4.1-flash")
                .expect("conversation");
            let mut message = ChatMessage::assistant(&conversation.id);
            message.content = "parcial".to_string();
            message.tool_calls = vec![ToolCallRecord::running("call-1", "run_command")];
            db.insert_message(&message).expect("insert message");
            message.id
        };

        let reopened = Db::open(&path).expect("reopen");
        let stored = reopened
            .get_message(&message_id)
            .expect("read message")
            .expect("stored message");
        assert_eq!(stored.status, MessageStatus::Cancelled);
        assert_eq!(stored.content, "parcial");
        assert_eq!(stored.tool_calls.len(), 1);
        assert_eq!(stored.tool_calls[0].status, ToolCallStatus::Error);
        assert_eq!(
            stored.tool_calls[0].result.as_deref(),
            Some("Interrompida: o aplicativo foi fechado.")
        );
        assert!(stored.tool_calls[0].finished_at.is_some());
    }

    #[test]
    fn resume_state_roundtrips_and_clears_with_the_conversation() {
        let db = Db::open_in_memory().expect("open");
        let conversation = db
            .create_conversation("Nova conversa", "opencode-go", "deepseek-v4.1-flash")
            .expect("conversation");
        let mut message = ChatMessage::assistant(&conversation.id);
        message.status = MessageStatus::Error;
        let mut state = crate::domain::ResumeState::new("turn-1", crate::domain::ResumeReason::ProviderError);
        state.step = 3;
        state.detail = Some("gateway indisponível".to_string());
        message.resume_state = Some(state);
        db.insert_message(&message).expect("insert message");

        let stored = db
            .get_message(&message.id)
            .expect("read message")
            .expect("stored message");
        let point = stored.resume_state.expect("resume point");
        assert_eq!(point.step, 3);
        assert_eq!(point.turn_id, "turn-1");
        assert_eq!(point.detail.as_deref(), Some("gateway indisponível"));

        assert_eq!(
            db.clear_resume_states(&conversation.id).expect("clear"),
            1
        );
        let cleared = db
            .get_message(&message.id)
            .expect("read message")
            .expect("stored message");
        assert!(cleared.resume_state.is_none());
    }

    #[test]
    fn interrupted_streaming_message_keeps_its_resume_point() {
        let dir = TempDir::new("zylara-interrupted-resume");
        let path = dir.path.join("test.db");
        let message_id = {
            let db = Db::open(&path).expect("open");
            let conversation = db
                .create_conversation("Nova conversa", "opencode-go", "deepseek-v4.1-flash")
                .expect("conversation");
            let mut message = ChatMessage::assistant(&conversation.id);
            message.content = "parcial".to_string();
            let mut state =
                crate::domain::ResumeState::new("turn-1", crate::domain::ResumeReason::Running);
            state.step = 2;
            message.resume_state = Some(state);
            db.insert_message(&message).expect("insert message");
            db.save_resume_state(&message.id, message.resume_state.as_ref())
                .expect("save point");
            message.id
        };

        let reopened = Db::open(&path).expect("reopen");
        let stored = reopened
            .get_message(&message_id)
            .expect("read message")
            .expect("stored message");
        assert_eq!(stored.status, MessageStatus::Cancelled);
        let point = stored.resume_state.expect("resume point survives the restart");
        assert_eq!(point.step, 2);
        assert_eq!(point.reason, crate::domain::ResumeReason::AppClosed);
    }
}
