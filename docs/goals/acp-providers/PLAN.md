# PLAN — Suporte completo a agentes ACP via ACP Registry

> **Objetivo**: permitir descobrir, instalar, autenticar e executar agentes
> compatíveis com **Agent Client Protocol** dentro do Zylara, integrados a Chat,
> Code e Agentes, sem alterar o funcionamento dos provedores HTTP atuais.
>
> **Status**: planejamento revisado e **READY para implementação**; nenhuma
> implementação ACP foi feita neste documento. Pesquisa/baseline em `RESEARCH.md`
> e trilha de revisão em `REVIEW.md`.
>
> **Data**: 2026-11-24.

## 1. Resumo executivo

ACP é um protocolo de **runtime de agente**, não um protocolo de inferência HTTP.
Um agente ACP roda como subprocesso, mantém sua própria sessão/histórico, executa
suas próprias tools e pode pedir permissão, arquivos, terminal e autenticação ao
cliente.

Por isso, a implementação correta não é acrescentar entradas em
`data/catalog.json` nem adaptar `CompletionRequest`. O Zylara ganha um segundo
runtime de turno:

```text
runtime::run_turn (turn interativo, tarefas, rotinas, canais e inbox)
  ├─ agent_kind = "zylara"  → harness::run_turn (caminho atual, intacto)
  └─ agent_kind = "acp:<id>" → acp::run_turn (novo)
```

Os dois runtimes usam o mesmo registro de turno, o mesmo `PersistingEmitter`, os
mesmos `TurnEvent`s neutros e a mesma persistência SQLite. O renderer continua
vendo texto, raciocínio, tools, uso, erro e cancelamento da mesma forma.

Decisões principais:

1. **ACP v1 estável** na primeira entrega; ACP v2 Preview fica para follow-up.
2. **SDK Rust oficial** `agent-client-protocol = "=5.6.0"` para tipos, traits e
   sessão; transporte stdio próprio usando o runner endurecido do app.
3. **Registry oficial** como catálogo, com cache offline e snapshot versionado.
4. **Instalação explícita**: binário, `npx` ou `uvx`, com validação de plataforma,
   checksum quando disponível, extração segura e consentimento.
5. **Persistência aditiva**: instalações, sessões ACP e seleção ACP por persona.
6. **Segurança fail-closed**: roots, path canonicalization, política de permissão,
   ambiente higienizado e nenhuma chave do Zylara injetada no agente.
7. **Zero mudança comportamental nos provedores atuais**: `providers/**`, catálogo
   HTTP, OAuth OpenAI e adaptadores existentes não são alterados.

## 2. Estado atual e restrições

### 2.1 Caminho atual

- `data/catalog.json` descreve provedores/modelos HTTP.
- `src-tauri/src/providers/mod.rs` traduz um `CompletionRequest` de um passo para
  `openai-chat`, `openai-responses`, `anthropic` ou `google`.
- `src-tauri/src/harness/mod.rs` executa o loop interno de tools, persistência,
  retry, cache, título e resume.
- `src-tauri/src/commands/turn.rs` admite o turno, cria o emitter persistente e
  chama o harness.
- `Conversation.agent_kind` já existe como `zylara` e está reservado para
  `acp:<agente>` (`domain.rs`); há teste de round-trip em `db.rs`.
- O renderer já recebe `agentKind` em `Conversation` (`types.ts`).

### 2.2 O que não pode mudar

- Bodies, headers, endpoints, fallback de protocolo, retry, OAuth e streaming dos
  provedores atuais.
- O lock de modelo do Chat e a troca de modelo/provedor no Code para rotas nativas.
- A semântica de um turno por conversa, fila, reattach e journal de eventos.
- O padrão de permissão **Autônomo** das novas sessões Code nativas.
- A forma dos `TurnEvent`s existentes e a persistência das mensagens nativas.

### 2.3 Baseline de verificação

`pnpm typecheck` e `cargo check` passam. A suíte Vitest atual termina com **3288
passes e 8 falhas preexistentes** (4 arquivos); `cargo test --lib` termina com
**1688 passes, 0 falhas e 22 ignorados**. Detalhes em `RESEARCH.md`. Antes da
implementação, o Lead deve:

- corrigir essas falhas em commit separado; ou
- registrar a lista exata como baseline permitido e exigir que a entrega ACP não
  aumente a contagem.

Não é aceitável chamar falha preexistente de regressão ACP, nem esconder uma
regressão nova dentro de um baseline vermelho.

## 3. Contrato oficial utilizado

### 3.1 Registry

Endpoint oficial:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

Schema do wrapper agregado:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.schema.json
```

Schema de cada entrada:

```text
https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json
```

Snapshot em 2026-11-24: Registry `1.0.0`, 46 agentes, 23 distribuições `npx`, 24
`binary` e 2 `uvx`. O schema permite `sha256` ausente; 5 agentes binários não
oferecem checksum em nenhuma plataforma.

Cada entrada declara `id`, `name`, `version`, `description`, `distribution` e
`license_url` (obrigatório exceto `dimcode`); `repository`, `authors`, `license` e
`icon` são opcionais, e `preview` é opcional. O Registry não declara capabilities
ACP; elas vêm do handshake.

O Registry publicado não é um índice assinado. TOFU prova apenas integridade
local do primeiro artefato, não autenticidade do publisher. A UI mostra essa
limitação; `npx`/`uvx` podem baixar dependências transitivas e executar scripts de
lifecycle, e o consentimento diz isso explicitamente.

### 3.2 Protocolo

Baseline implementado:

- JSON-RPC 2.0 sobre stdio newline-delimited UTF-8.
- `initialize` com `protocolVersion: 1`, `clientInfo` e capabilities.
- `authenticate` para métodos `agent`; terminal auth para métodos `terminal`.
- `session/new`, `session/load`, `session/resume`, `session/close` quando
  anunciados.
- `session/prompt` + `session/update` + `stopReason`.
- `session/cancel`.
- `session/request_permission`.
- `fs/read_text_file`, `fs/write_text_file`.
- `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
  `terminal/kill`, `terminal/release`.
- `elicitation/create` e `elicitation/complete`.
- `session/set_config_option`, `session/set_mode` quando aplicáveis.
- `session/list`, `session/delete`, `logout` quando anunciados.
- Updates: mensagens, thought, tool call/update, plan/plan_update/plan_removed,
  available commands, mode/config, session info, usage, notice, compaction e
  subagents.

ACP v2 está em Preview. O plano mantém uma interface versionada
(`AcpProtocolAdapter`) para adicionar v2 depois, mas não compila nem anuncia v2 na
primeira entrega.

### 3.3 Segurança oficial

ACP não sandboxa o agente. O cliente deve tratar todo texto, URI, path, diff,
comando e update do agente como não confiável. Permissões são consultivas para
operações que o próprio agente executa. O cliente valida tudo que passa por
`fs/*` e `terminal/*`.

## 4. Decisões de arquitetura

### D1 — Runtime paralelo, não adaptador HTTP

Rejeitado: transformar ACP em `ProviderInfo` + `CompletionRequest`.

Motivo: ACP tem sessão, autenticação, permissões, tools e resume; um completion de
um passo não representa esse contrato. Além disso, o harness interno tentaria
executar tools que o agente ACP já executou.

Escolhido: `acp::run_turn` como segundo runtime, selecionado por
`conversation.agent_kind`. Um dispatcher compartilhado `runtime::run_turn` é usado
por `commands::turn` **e** pelos callers diretos de tarefas, rotinas, canais e
inbox; o branch nativo continua chamando `harness::run_turn` sem mudança. ACP fica
no core, não em plugins: `process.spawn` continua reserved na plataforma de
plugins.

### D2 — Stable v1 primeiro

ACP v1 é estável e suportado pelo SDK/Rust 5.6.0. ACP v2 é Preview e muda a
semântica de `session/prompt`, remove `fs/*` e `terminal/*` do cliente e introduz
`state_update`. Suporte v2 será aditivo e opt-in após estabilização.

### D3 — SDK oficial + transporte endurecido

Usar:

```toml
agent-client-protocol = "=5.6.0"
```

Sem feature `process`; usar `Client::v1`, `Lines` e os tipos de `v1::schema`.
`Lines` recebe um codec newline-delimitado próprio, com limite rígido por frame,
CRLF/BOM tratados e UTF-8 validado. O transporte recebe `stdin/stdout` de um
processo criado pelo runner do Zylara, com Job Object no Windows e
processo-group/árvore no Unix.

Motivo: o launcher `process` do SDK não mata a ávore no Windows. O app já tem
`workspace/exec.rs`, `process_env` e kill de árvore testados. `ByteStreams` do SDK
usa `read_until` sem teto e não serve como boundary de segurança para stdout.

A dependência `tokio-util` ganha a feature `io` se o spike confirmar necessidade
do adapter Tokio↔futures. O Job Object e o kill de árvore são extraídos de
`workspace/exec.rs` para um módulo compartilhado `process_guard.rs`, sem mudar o
comportamento do runner atual.

### D4 — Persistência aditiva e compatível

- `conversations.agent_kind` passa a ser a seleção real do runtime.
- `provider_id/model_id` da conversa permanecem uma rota nativa válida, usada
  pelas funções auxiliares e por compatibilidade de downgrade. A UI mostra o
  modelo ACP vindo do estado da sessão ACP, não desse par.
- Mensagens produzidas por ACP usam `provider_id = "acp:<agent-id>"` e
  `model_id` = option `category: model` ou `"default"`.
- `TurnPayload.provider_id/model_id/reasoning` nativos não selecionam o runtime ACP;
  ficam apenas como rota auxiliar/compatibilidade. Config ACP vem de
  `acp_sessions.state_json`.
- Sessões e instalações ACP ficam em tabelas novas; nada é gravado em
  `provider_state` dos provedores HTTP.

### D5 — Consentimento e padrão seguro

- Instalar e executar um binário de terceiro exige consentimento explícito.
- Novas sessões ACP no Code nascem em **Revisar**, não em Autônomo.
- O agente recebe apenas ambiente higienizado; nenhuma API key do Zylara é
  injetada.
- Autenticação pertence ao agente. O Zylara guarda apenas status/métodos, nunca
  token.
- `allow_always`/`reject_always` são devolvidos ao agente; o agente é dono da
  memória da decisão. O Zylara não cria regra global de aprovação a partir de uma
  opção ACP.
- Permissões do próprio agente nunca são auto-aprovadas só pelo modo Autônomo.
  `acp_auto_approve_permissions` é opt-in separado, default `false`; quando ligado,
  só seleciona `allow_once`, nunca `allow_always`.

### D6 — Feature flag de rollout

`Settings.acp_enabled` começa `false` durante o desenvolvimento e vira `true` na
release após os gates. Com a flag desligada, uma sessão ACP falha com
`ACP_DISABLED`; nunca cai silenciosamente para o harness nativo.

Settings aditivas:

```text
acp_enabled = false
acp_registry_auto_refresh = true
acp_idle_timeout_secs = 300
acp_auto_approve_permissions = false
acp_share_host_tools = false
default_acp_agent_id = null
```

`default_acp_agent_id` permite escolher ACP como runtime das novas conversas sem
alterar `default_provider/default_model` nativos.

Validação: `agent_kind` só aceita `zylara` ou `acp:<id>` com id de agente
instalado/custom válido. Toda mutação valida no backend; `acp_enabled` é checado
antes de emitir `accepted`. Runtime desconhecido/malformado falha fechado, nunca
cai para nativo. Conversas históricas sem instalação continuam podendo ser
lidas, renomeadas, exportadas e excluídas; instalação/enabled/consent são exigidos
só para executar ou trocar runtime.

### D7 — Sem MCP automático nem tools internas por padrão

O agente ACP usa suas próprias tools. A Fase 6 adiciona uma ponte MCP stdio
opcional executada por um helper do próprio binário, desligada por padrão e
filtrada pelas capabilities da persona. Shell/FS não são expostos por essa ponte
para não criar duas autoridades de segurança. A ponte não usa a feature unstable
`unstable_mcp_over_acp`.

## 5. Experiência-alvo

### 5.1 Configurações → Provedores

Nova seção **Agentes ACP**, visualmente separada dos provedores de API:

- busca, filtro por distribuição/licença e status;
- detalhe com descrição, autor, licença, versão, plataforma, requisitos e hash;
- ações: Instalar, Atualizar, Testar conexão, Autenticar, Sair, Remover;
- indicação de runtime ausente (Node/npm/uv), plataforma incompatível ou agente
  fora do ar;
- aviso: “O agente roda com as permissões do seu usuário. ACP não é um sandbox.”

Quando nenhum agente ACP está instalado, os seletores de modelo atuais não
mudam.

### 5.2 Chat

- O seletor de modelo ganha um grupo **Agentes ACP** somente quando há agentes
  instalados.
- Escolher ACP cria `agent_kind = acp:<id>`.
- Depois da primeira mensagem, o agente fica travado como o modelo atual do Chat.
- O segmento ✦ abre as `configOptions` ACP (`model_config`/`thought_level`), não o
  catálogo HTTP. Se o agente expuser `category: model`, a mudança é permitida
  durante a sessão, mas não troca o runtime/agente.
- ACP usa uma pasta interna isolada quando não há workspace; o composer informa
  isso. Toggles internos de web/arquivos são substituídos por “gerenciado pelo
  agente ACP”.

### 5.3 Code

- “Novo agente” passa a oferecer **Zylara** ou **Agente ACP instalado**.
- A sessão ACP usa o workspace explícito como `cwd` e root set. Workspace precisa
  ser confiável ou ter consentimento ACP explícito/informado; sem isso, o turno é
  recusado.
- Entre turnos, o usuário pode trocar o agente ACP; `configOptions` e modes podem
  mudar também durante o turno, como ACP permite.
- O chip de permissão continua governando `fs/*` e `terminal/*` mediados pelo
  Zylara. Modos próprios do agente ACP aparecem em um controle separado.
- O painel Alterações continua funcionando: diffs ACP são mapeados e mudanças
  diretas são capturadas no início/fim do turno.

### 5.4 Agentes

- A aba Modelo do editor ganha **Runtime: Zylara | ACP**.
- Ao escolher ACP, o usuário seleciona um agente instalado e opções iniciais.
- `provider_id/model_id` nativos continuam disponíveis para “Criar com IA” e
  “Editar com IA”; essas ações não usam o runtime ACP.
- A persona cria conversas com `agent_kind = acp:<id>`.
- `Agent`/`AgentInput` ganham `acpAgentId` opcional; criação/update sincroniza o
  runtime atomicamente para principal/canal vazios e preserva o lock de threads
  já iniciadas. Export/import v2 preserva a referência ACP; import sem agente
  instalado cria a persona em estado indisponível/não executável até escolha
  explícita de instalar ou trocar runtime.
- Rotinas e respostas em canal com ACP são permitidas, mas permissão/elicitation
  sem canal humano falha fechado. Tarefas e líder de canal exigem a ponte host
  tools; `/goal` é desativado para ACP na v1.

### 5.5 Autenticação

- Método `agent`: botão “Conectar” chama `authenticate(methodId)`.
- Método `terminal`: diálogo mostra comando/args/env, abre terminal interativo,
  aguarda exit 0 e reconecta.
- `logout` só aparece se capability anunciada.
- `auth_required` durante `session/new` abre o mesmo fluxo sem perder a conversa.

## 6. Contratos de dados e IPC

### 6.1 Novos tipos Rust (`domain.rs` ou módulo ACP)

```rust
AcpRegistryView { version, fetched_at, agents }
AcpRegistryAgent { id, name, version, description, distribution, ... }
AcpInstallation {
  agent_id, source, name, version,
  status: not_installed|installing|installed|update_available|error|disabled|incompatible|uninstalled,
  ...
}
AcpInstallEvent { stage, progress?, message? }
AcpProbeResult { protocol_version, agent_info?, capabilities, auth_methods }
AcpAuthMethod { id, name, description, r#type, args, env: Map<String,String> }
AcpSessionSummary { session_id, cwd, title?, updated_at?: String, additional_directories? }
AcpSessionPage { sessions, next_cursor? }
AcpSessionEvent { seq, kind, payload, created_at }
AcpSessionEventPage { items, next_seq? }
AcpEntityPage { items, next_cursor? }
AcpEntityChunk { entity, payload_text?, data_base64?, done }
AcpContentBlock {
  content_id, owner_kind, owner_id, seq, r#type, mime?, text?,
  artifact_id?, uri?, size?, thumbnail_data_url?
}
AcpSessionState {
    session_id, cwd, approved_roots, protocol_version, agent_version,
    config_options, modes, available_commands, context_usage, reported_cost,
    title, auth_state, children, plans, compactions, session_messages
}
AcpConfigOption {
    id, name, description?, category?, r#type,
    current_value: String | Bool,
    options?: FlatSelectOption[] | SelectGroup[]
}
AcpPermissionRequest { request_id, session_id, tool_call, options }
AcpElicitationRequest {
    request_id, session_id?, tool_call_id?, acp_request_id?, mode, message,
    requested_schema?, elicitation_id?, url?
}
AcpContentPage { items, next_cursor? }
AcpContentChunk { block: AcpContentBlock, offset, text?, data_base64?, done }
AcpReportedCost { amount, currency, cumulative, session_id, updated_at }
AcpConsentPreview { agent_id, version, manifest_digest, launch_digest, command, args, env_preview, scopes }
AcpCustomAgentInput { name, command, args, env, version? }
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
AcpConsentCandidate =
  | Installed { agent_id }
  | Registry { agent_id, distribution, channel, target?, version? }
  | Custom { input: AcpCustomAgentInput }
  | HistoryInjection { conversation_id, truncate_before_message_id? }
  | SessionImport { agent_id, session_id, cwd }
  | AdditionalRoots { conversation_id, roots }
AcpConsentChallenge { challenge_id, candidate_digest, scopes, expires_at, preview: AcpConsentPreview }
AcpAuthTerminalHandle { terminal_id, agent_id, method_id }
AcpAuthTerminalStatus { state: running|exited|failed|cancelled, exit_code?, signal? }
AcpRuntimeStatus {
    state: connecting|ready|running|waiting_action|idle|auth_required|disconnected|error,
    agent_id, protocol_version, agent_version
}
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
RuntimeSelection =
    | Native { provider_id, model_id, reasoning }
    | Acp { agent_id, config_fingerprint? }
```

O union Rust usa tagged internal serialization compatível com
`{ kind: "native", ... }` / `{ kind: "acp", ... }` do TypeScript; teste de
round-trip Rust↔TypeScript é obrigatório.

Os DTOs de protocolo espelham de perto `agent_client_protocol::v1::schema`; não
criam um dialeto próprio. `type` ausente em `AcpAuthMethod` significa `agent`.
`currentValue` bool e selects agrupados são first-class. Áudio, resource, resource
link, image, annotations e `_meta` seguem o schema oficial. Campos desconhecidos
são ignorados; enums abertos preservam o valor desconhecido com apresentação
genérica. Enum fechado inválido falha apenas o update/request, não derruba a
conexão.

Todos com `#[serde(rename_all = "camelCase")]` e defaults aditivos. Espelhos em
`src/lib/types.ts`.

Capabilities do cliente são anunciadas somente quando o handler correspondente
existe:

```json
{
  "auth": { "terminal": true },
  "fs": { "readTextFile": true, "writeTextFile": true },
  "terminal": true,
  "elicitation": { "form": {}, "url": {} },
  "plan": {},
  "session": {
    "configOptions": { "boolean": {} },
    "notices": {},
    "compaction": {}
  },
  "subagents": {}
}
```

`terminal` só é anunciado em execução local; `auth.terminal` só é anunciado quando
o launch reproduz argv com segurança. Demais capabilities só são anunciadas
quando handlers completos existem.

Prompt capabilities do agente (`text`/`resource_link` baseline; `image`, `audio`,
`embeddedContext` opcionais) controlam o que pode ser enviado. Testes de schema
cobrem todas as variantes estáveis de content e session update.

### 6.2 SQLite (`db.rs`)

Migrações aditivas, idempotentes, com teste de banco legado:

```sql
CREATE TABLE acp_installations (
  agent_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- registry | custom
  name TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  distribution_kind TEXT NOT NULL,   -- binary | npx | uvx | custom
  install_root TEXT,
  launch_json TEXT NOT NULL,         -- comando/args; sem segredos
  distribution_json TEXT NOT NULL,   -- manifesto imutável + env público
  user_env_names_json TEXT NOT NULL DEFAULT '[]',
  artifact_sha256 TEXT,
  executable_sha256 TEXT,
  file_manifest_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  probe_json TEXT,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE acp_consents (
  agent_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL,
  launch_digest TEXT NOT NULL,
  version TEXT NOT NULL,
  scopes_json TEXT NOT NULL,       -- probe | execute | auth | update
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE acp_sessions (
  conversation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  approved_roots_json TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  agent_version TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_id, session_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE acp_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  spill_path TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE acp_message_map (
  conversation_id TEXT NOT NULL,
  acp_session_id TEXT NOT NULL,
  acp_message_id TEXT,
  synthetic_key TEXT,
  message_role TEXT NOT NULL,        -- user | assistant | thought | session
  zylara_message_id TEXT NOT NULL,
  segment_seq INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, acp_session_id, segment_seq),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE acp_content_blocks (
  content_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  acp_session_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,        -- message | thought | tool | session_message
  owner_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content_type TEXT NOT NULL,      -- text | image | audio | resource | resource_link
  mime_type TEXT,
  text_content TEXT,
  artifact_id TEXT,
  uri TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE acp_entities (
  conversation_id TEXT NOT NULL,
  acp_session_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,      -- tool | plan | compaction | subagent | session_message
  entity_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  spill_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, acp_session_id, entity_kind, entity_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE acp_cost_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  acp_session_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  cumulative INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE acp_processes (
  pid INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  process_start INTEGER NOT NULL,
  executable TEXT NOT NULL,
  conversation_id TEXT,
  auth_terminal_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pid, boot_id)
);

ALTER TABLE agents ADD COLUMN acp_agent_id TEXT;
ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';
```

Índices: `acp_sessions(agent_id, session_id)`,
`acp_session_events(conversation_id, seq)` (único),
`acp_message_map(zylara_message_id)`, `acp_content_blocks(owner_kind, owner_id)`
(único com `seq`), `acp_cost_samples(conversation_id)` e `agents(acp_agent_id)`.
Índice único parcial em
`acp_message_map(conversation_id, acp_session_id, message_role, acp_message_id)`
quando `acp_message_id IS NOT NULL`. Índice único equivalente usa
`(conversation_id, acp_session_id, message_role, synthetic_key)` quando não há ID
ACP. `agent_kind` continua sendo a autoridade do runtime.

Na migração, `title_source` é backfill com `should_auto_title`: títulos que não
são placeholder viram `user`; placeholders viram `auto`. `acp_session_events` é
apenas cache de replay/live, podado por idade (7 dias) e limite por conversa
(10 mil eventos). Mensagens user-facing fora do turno viram `ChatMessage`
duradouro; tools/plan/compaction/subagents/session messages ficam em
`acp_entities` não podado. `acp_sessions.state_json` é snapshot, não fonte única.
Payloads de entidade têm até 64 KiB inline; excedente vai para `spill/` e o DB
guarda referência. `acp_cost_samples` é coalescido por turno/5 s e podado após registrar o delta em
`usage_log`.

Não persistir tokens, valores de env sensíveis, stdout bruto ou prompts completos
em `launch_json`, `probe_json` ou logs. `distribution_json` guarda o manifesto
público versionado; segredos do usuário ficam apenas em `secrets.json`.
`acp_consents` não tem FK para permitir consentimento antes do install; registros
órfãos/cancelados são limpos no boot.

### 6.3 Comandos Tauri (`commands/acp.rs`)

```text
acp_refresh_registry() -> AcpRegistryView
acp_list_registry(query?) -> AcpRegistryAgent[]
acp_install_agent(agent_id, distribution, channel, target?, challenge_id, on_event: Channel<AcpInstallEvent>) -> AcpInstallation
acp_update_agent(agent_id, challenge_id, on_event: Channel<AcpInstallEvent>) -> AcpInstallation
acp_remove_agent(agent_id) -> ()
acp_set_agent_enabled(agent_id, enabled) -> AcpInstallation
acp_preview_consent(candidate, scopes) -> AcpConsentChallenge
acp_grant_consent(challenge_id) -> ()
acp_revoke_consent(agent_id) -> ()
acp_list_installed_agents() -> AcpInstallation[]
acp_save_custom_agent(input, challenge_id) -> AcpInstallation
acp_set_agent_secret(agent_id, name, value?) -> AcpInstallation
acp_agent_icon(agent_id) -> string /* data URL SVG sanitizado */
acp_probe_agent(agent_id) -> AcpProbeResult
acp_authenticate(agent_id, method_id) -> AcpProbeResult
acp_logout(agent_id) -> AcpProbeResult
acp_list_sessions(agent_id, cwd?, cursor?) -> AcpSessionPage
acp_import_session(agent_id, session_id, title?, cwd, challenge_id) -> Conversation
acp_delete_session(agent_id, session_id) -> ()
acp_get_session_state(conversation_id) -> AcpSessionState
acp_list_session_events(conversation_id, after_seq?, limit?) -> AcpSessionEventPage
acp_list_entities(conversation_id, kind?, cursor?) -> AcpEntityPage
acp_get_entity(conversation_id, kind, entity_id) -> AcpEntityChunk
acp_get_content_blocks(owner_kind, owner_id, cursor?) -> AcpContentPage
acp_get_content_block(content_id, offset?, max_bytes?) -> AcpContentChunk
acp_continue_turn(conversation_id, assistant_message_id) -> TurnResult
acp_regenerate(conversation_id, assistant_message_id, challenge_id) -> TurnResult
acp_restart_with_history(conversation_id, truncate_before_message_id?, challenge_id) -> TurnResult
acp_send_history_context(conversation_id, challenge_id) -> TurnResult
acp_cancel_session(conversation_id) -> ()
acp_close_session(conversation_id) -> ()
acp_set_config_option(conversation_id, config_id, value, type?) -> AcpSessionState
set_conversation_runtime(conversation_id, selection) -> Conversation
acp_set_mode(conversation_id, mode_id) -> AcpSessionState
acp_respond_permission(request_id, option_id) -> ()
acp_respond_elicitation(request_id, action, content?) -> ()
acp_open_auth_terminal(agent_id, method_id, on_event: Channel<TerminalEvent>) -> AcpAuthTerminalHandle
acp_write_auth_terminal(terminal_id, data) -> ()
acp_resize_auth_terminal(terminal_id, cols, rows) -> ()
acp_auth_terminal_status(terminal_id) -> AcpAuthTerminalStatus
acp_close_auth_terminal(terminal_id) -> ()
```

`create_conversation` ganha argumento opcional `acp_agent_id`/`agent_kind`.
Chamadas nativas continuam idênticas. Se ambos forem enviados, precisam
corresponder; `acp_agent_id` deriva `agent_kind = acp:<id>`.

Consentimento é backend e persistido em `acp_consents`, com digest exato de
manifesto/launch, versão, timestamp, scopes e revogação. Os digests são calculados
pelo backend a partir do candidato resolvido, nunca aceitos do renderer.
`acp_preview_consent(candidate, scopes)` resolve distribuição/channel/target/versão,
comando custom, histórico/import ou roots e devolve um challenge one-time de vida
curta ligado ao digest **e ao conjunto exato de scopes**. Install/update/custom/
grant/history/import verificam o challenge atomicamente contra candidato e scopes
atuais; challenge velho, reaproveitado, divergente ou com escopo ampliado falha. O
preview mostra versão/comando/args/env/digests, roots/histórico afetados e riscos
de processo/filesystem/rede/subprocessos.
Install consent inclui `probe`; executar, autenticar, listar/importar sessões e
lançar o helper MCP exigem `execute`/`auth` correspondente. Todo caminho que
spawna o agente chama `require_consent`; renderer nunca é autoridade.
Update/versão nova exige novo consentimento. Revogar consentimento fecha sessões
ativas antes de valer. A estratégia de distribuição, channel, target e versão
resolvida ficam no `distribution_json`; update não muda de estratégia sem
consentimento.

`session/list` só é chamado com `sessionCapabilities.list`, usa cursor opaco e
paginação; não persiste cursor. Import exige `loadSession`, consentimento de
`cwd`/roots, `cwd` canônico igual ao listado e cria uma conversa nova. Se
`(agent_id, session_id)` já está mapeado, retorna a conversa existente ou erro de
duplicata, nunca cria segunda. Replay falho faz rollback da conversa/import ou a
marca como incompleta, sem mensagens parciais inventadas.
`session/delete` só é chamado com capability e remove a sessão externa, não a
conversa Zylara; a UI pede confirmação separada. Sessão ativa é fechada antes de
delete; `-32002` é sucesso e mapping stale é limpo.

`set_conversation_runtime` é a única troca de runtime de sessão existente:
recusa turno ativo, fecha/invalida a sessão ACP antiga, atualiza `agent_kind` e o
par nativo auxiliar atomicamente, invalida itens de fila incompatíveis, grava
`code_events` `runtime/changed` e emite `acp_runtime_status`. Selecionar `Native`
restaura `zylara` + `ModelSelection`; selecionar `Acp` grava `acp:<id>`. No Chat
iniciado e em threads de persona iniciadas, o lock atual continua valendo; no
Code, a troca é permitida entre turnos.

### 6.4 Eventos (`events.rs` + `types.ts`)

Variantes aditivas:

```text
acp_runtime_status
acp_state_updated
acp_content_block
acp_resource_link
acp_permission_requested
acp_permission_resolved
acp_elicitation_requested
acp_elicitation_resolved
acp_notice
acp_compaction_updated
acp_plan_updated
acp_plan_removed
acp_subagent_updated
acp_session_message
```

Reutilização direta:

| ACP | Evento Zylara |
| --- | --- |
| `agent_message_chunk` | `text_delta` |
| `agent_thought_chunk` | `reasoning_delta` |
| `user_message_chunk` | replay/reconciliação somente; delta vivo duplicado é ignorado |
| `tool_call` | `tool_call_started` |
| `tool_call_update` | `tool_call_executing` / `tool_call_finished` / `tool_progress` |
| diff content | `file_changed` + presentation `file_change` |
| `plan`/`plan_update`/`plan_removed` | `acp_plan_updated` / `acp_plan_removed` |
| `usage_update` | `acp_state_updated` (contexto/custo), não `usage` cobrado |
| `session_info_update.title` | `title_updated` |
| `stopReason: cancelled` | `cancelled` |
| `stopReason: end_turn` | `done` |
| `stopReason: refusal` | `done` com `MessageStatus::Refused` |
| `max_tokens`/`max_turn_requests` | `done` com status `incomplete` |
| erro JSON-RPC | `error` + `MessageError` persistido |

O plano de execução ACP não é o modo Plano do Zylara e não concede aprovação de
implementação. Ele usa eventos próprios para preservar entries, prioridade,
status, Markdown e `planId` sem falsificar `PlanView`.

`ToolCallStatus` ganha a variante aditiva `Cancelled` para cancelamento local ACP;
rotas nativas nunca a emitem. `MessageStatus` ganha `Refused` para o stop reason
ACP; o union TypeScript e os renderizadores passam a tratá-las sem alterar os
estados nativos.

## 7. Organização do backend

Novo módulo `src-tauri/src/acp/`:

```text
mod.rs              registry/manager público e tipos internos
protocol.rs         interface versionada v1 (v2 no futuro)
registry.rs         fetch, schema, cache, diff de versões
install.rs          download, hash, extração, instalação/rollback
launch.rs           resolução de binário/npx/uv, argv, env, Windows wrappers
codec.rs            framing newline limitado, CRLF/BOM e UTF-8
transport.rs        processo endurecido + Lines + stderr limitado
state.rs            supervisor de conexão/sessão e eventos fora do turno
client.rs           Client v1, handlers fs/terminal/permission/elicitation
session.rs          new/load/resume/close/list/delete e reconciliação
mapper.rs           ACP updates → TurnEvents/ToolCallRecord/FileChange
permissions.rs      requests ACP e respostas exatas por optionId
filesystem.rs       fs/read_text_file e fs/write_text_file
terminal.rs         terminal registry ACP sobre o runner do app
auth.rs             authenticate/terminal auth/logout
auth_terminal.rs    PTY dedicado para login interativo
runtime.rs          run_turn ACP, persistência, cancelamento e fecho
host_tools.rs       definições filtradas das tools do host
mcp_bridge.rs       helper stdio + IPC local one-time token
```

Modificações compartilhadas:

| Arquivo | Mudança |
| --- | --- |
| `src-tauri/src/lib.rs` | `mod acp`, `mod runtime`, registro de comandos, manager init/shutdown e helper MCP antes do single-instance |
| `src-tauri/src/state.rs` | `AppState.acp: AcpManager`, dirs ACP e cleanup de boot |
| `src-tauri/src/runtime.rs` | dispatcher único native/ACP usado por todos os callers |
| `src-tauri/src/commands/mod.rs` | `pub mod acp` |
| `src-tauri/src/commands/turn.rs` | preflight + dispatcher; admissão/emitter/fecho nativos continuam iguais após o gate |
| `src-tauri/src/commands/{tasks,routines,channels,inbox}.rs` | trocar `harness::run_turn` direto por `runtime::run_turn` |
| `src-tauri/src/commands/conversations.rs` | criação/seleção ACP, `set_conversation_runtime`, guard de `set_conversation_model`, Chat→Code sem escalar permissão, truncate/delete/workspace e `title_source=user` no rename |
| `src-tauri/src/commands/code.rs` | `/compact` ACP ou recusa explícita; pending ACP no snapshot |
| `src-tauri/src/commands/settings.rs` | Fechar ACP antes de `reset_app_data` |
| `src-tauri/src/commands/agents.rs` | validar/sincronizar runtime ACP da persona |
| `src-tauri/src/db.rs` | tabelas/migrações/CRUD ACP, runtime nas conversas de persona e cleanup |
| `src-tauri/src/domain.rs` | contratos ACP e defaults |
| `src-tauri/src/events.rs` | eventos aditivos |
| `src-tauri/src/config.rs` | settings ACP, namespace de segredos ACP e resolução de runtimes |
| `src-tauri/src/harness/mod.rs` | extração mecânica do ciclo de vida de mensagem/checkpoint; comportamento nativo igual |
| `src-tauri/src/tools/code/exec.rs` | Reutilizar helpers de mutação/journal/aprovação sem mudar comportamento |
| `src-tauri/src/policy/mod.rs` | Fatos ACP de terminal com programa/argv/env, sem alterar matching nativo |
| `src-tauri/src/process_guard.rs` | Job Object/kill de árvore compartilhado |
| `src-tauri/src/workspace/exec.rs` | API `spawn_interactive`; `run()` existente continua igual |
| `src-tauri/src/Cargo.toml` / `Cargo.lock` | SDK ACP; `agent-client-protocol-rmcp = { version = "=5.6.0", features = ["rmcp_3"] }`; `rmcp = { version = "3.4", features = ["macros", "server", "schemars"] }`; `futures`, `jsonschema` (draft-07), `tar`, `flate2`, `bzip2`; feature `stdio` do SDK |
| `package.json` | Script `acp:registry:sync` e teste do snapshot |
| `.github/workflows/acp.yml` | Matrix Windows/macOS/Linux para codec, processo, archive, paths e shims |
| `src/lib/types.ts` | espelhos dos contratos/eventos |
| `src/lib/api.ts` | comandos ACP |

Arquivos que **não devem ser editados**:

```text
src-tauri/src/providers/**
data/catalog.json
scripts/build-catalog.mjs
scripts/provider-seeds.mjs
src-tauri/src/oauth/**
```

### 7.1 Dispatcher e ciclo de vida compartilhado

`runtime::run_turn` recebe o mesmo `HarnessDeps`, payload, settings, emitter e
cancellation usados hoje. Ele:

1. carrega a conversa para selecionar o runtime;
2. se `agent_kind == "zylara"`, chama `harness::run_turn` sem nenhuma transformação;
3. se `agent_kind` começa com `acp:`, obtém `AppState.acp` pelo `AppHandle` e chama
   `acp::run_turn`;
4. sem `AppHandle` em teste e runtime ACP, falha com erro explícito.

O dispatcher **não** adquire `workspace_gate`: o harness nativo já o faz e um
segundo read lock no mesmo task pode causar self-deadlock com writer pendente. O
runtime ACP adquire o gate depois de resolver a conversa e o mantém durante todo o
turno; `set_conversation_workspace` continua recusando mudança com turno ativo.

`runtime::preflight_turn` roda antes de `register_turn_if_idle` e de qualquer
`accepted`/`queued`, em todos os callers. Valida feature flag, gramática/instalação
do runtime, consentimento, existência da conversa e lock. Para ACP, também aplica
o budget diário: usa o último delta USD conhecido; com limite configurado e custo
desconhecido/não-USD, falha fechado com `ACP_COST_UNKNOWN`. Falha de preflight não
cria journal de turno.

Os callers `commands::tasks`, `routines`, `channels` e `inbox` hoje chamam
`harness::run_turn` direto. Eles passam a chamar o dispatcher; caso contrário,
personas ACP funcionariam no Chat mas quebrariam silenciosamente em execuções de
fundo. O próprio `harness::run_turn` ganha um guard defensivo que recusa
`agent_kind != "zylara"` com erro estável de dispatch.

Os helpers privados `prepare_new_turn`, `prepare_regenerate`, `prepare_resume`,
`StreamCheckpoint`, `ResumeCheckpoint` e conversão de `TurnFailure` são extraídos
sem mudança semântica para um módulo de ciclo de vida. O harness nativo passa a
usar esses helpers e testes de golden path provam que mensagens, eventos e
`provider_state` continuam idênticos. ACP não usa `ResumeState.step` nem
`provider_state`; usa `acp_sessions`.

## 8. Fluxos detalhados

### 8.1 Descoberta e cache do Registry

1. Baixar apenas do origin oficial fixo; não aceitar URL arbitrário do renderer.
2. Validar o wrapper `{version, agents}` com `registry.schema.json` e depois cada
   entrada com `agent.schema.json` via resolver draft-07 local, sem `$ref` remoto.
3. Exigir versão de schema suportada, ids únicos, ≤ 500 agentes e ordenação
   determinística; normalizar targets de plataforma e distribuições.
4. Gravar cache atômico em `<app-data>/acp/registry.json` com ETag/Last-Modified.
5. Sem rede, usar cache; sem cache, usar snapshot embutido no binário.
6. Mudança de Registry nunca instala ou atualiza sozinbo.
7. Canal `preview` só aparece com opt-in; stable é o default.
8. Target Linux prioriza a variante de libc detectada e usa a alternativa apenas
   com fallback compatível/consentimento; Windows ARM64 pode usar x64 por emulação
   somente com confirmação.

Artefatos versionados: `data/acp-registry.snapshot.json`,
`data/acp-registry.schema.json` (wrapper), `data/acp-agent.schema.json` (entrada) e
`scripts/sync-acp-registry.mjs` (+ script npm e teste). Falha de rede mantém o
snapshot commitado; o script não altera o catálogo HTTP. Refresh runtime automático
só ocorre com `acp_enabled=true` (startup, a cada 6 h e foco); com a flag desligada,
somente refresh manual explícito acessa a rede. Sempre nonblocking.

### 8.2 Instalação

#### Binário

1. Selecionar target exato de OS/arquitetura.
2. Baixar via `AppState::http`, com limite de tamanho, timeout e cancelamento.
3. Verificar `sha256` quando presente.
4. Se ausente: mostrar “sem checksum”, exigir segundo consentimento, calcular e
   pinar o hash local após download.
5. Extrair em staging dentro de `<app-data>/acp/staging/<uuid>`.
6. Rejeitar path traversal, absoluto, `..`, symlink/hardlink, ADS, nomes reservados
   Windows, colisão case-insensitive, zip bomb e excesso de arquivos/bytes.
7. Formatos: `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2` e binário raw.
8. Validar `cmd`/`args`: argv separado, caminho resolvido dentro do staging,
   executável existente e permissão Unix correta.
9. Mover atomicamente para `<app-data>/acp/agents/<id>/<version>`.
10. Probe `initialize`; só então marcar instalado.

#### `npx`

- Resolver `node.exe`/`node` (primeiro `Settings.codeNodePath`, depois PATH) e o
  `npx-cli.js` do npm; invocar Node diretamente no Windows para evitar parsing de
  `.cmd`.
- Comando: `node <npx-cli.js> --yes <package-spec> <args...>`.
- Usar o `package` do Registry como está quando já contém versão; só acrescentar
  `@<agent.version>` quando não houver spec. Nunca usar `latest`.
- Validar grammar npm: nome escopado/não escopado + versão exata; rejeitar leading
  dash, URLs, tags e opções. O pacote nunca é interpretado como argumento do npm.
- Detectar npm/Node ausente e orientar instalação. O consentimento informa que
  npm/uv podem baixar dependências transitivas e executar scripts de lifecycle.

#### `uvx`

- Resolver `uv.exe`/`uv`; comando `uvx <package-spec> <args...>`.
- Preservar a versão exata do Registry ou acrescentá-la somente se ausente;
  detectar runtime ausente. Gramática Python/PEP 440 aceita `name==X.Y.Z` e
  `name@X.Y.Z` exatos (incluindo o fixture real `fast-agent-acp==0.10.66`), mas
  rejeita tags, URLs, ranges e opções.

#### Windows `.cmd` e terminal auth

- Launcher `.cmd` só é aceito por um resolvedor de shim validado: lê o arquivo,
  reconhece o template npm/Node ou um wrapper simples que termina em `%*`, resolve
  o executável/script real dentro do install root e invoca argv diretamente.
- Shims com `call`, `for`, delayed expansion, mutação de env ou parsing complexo
  retornam `ACP_UNSAFE_LAUNCHER`; não há fallback para `cmd.exe /C`.
- O shim Windows do Cursor é coberto por fixture do texto/template npm e por teste
  live ignorado com o artefato oficial; não redistribui o binário proprietário.
  Testes incluem espaços, aspas, `&`, `|`, `%` e Unicode.
- Terminal auth usa um `AcpAuthTerminalRegistry` com portable-pty e o comando real
  do agente; não reutiliza o terminal de workspace. É desativado para shims que
  reinterpretam argv. O handle é ligado a agent/method/usuário; Channel recebe
  output/exit, e comandos write/resize/status/close são obrigatórios. Cancel,
  reconnect, logout e shutdown liberam o PTY.

#### Ambiente

- Partir de `process_env` higienizado.
- Aplicar somente env declarado e aprovado.
- Rejeitar/avisar `PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`,
  `BASH_ENV`, `HTTPS_PROXY`, `SSL_CERT_FILE` e variáveis equivalentes.
- Nunca repassar `*API_KEY*`, `*TOKEN*` ou `*SECRET*` do Zylara.

#### Agentes customizados e segredos

- “Adicionar agente ACP” aceita comando absoluto (ou executável resolvido e então
  fixado como caminho absoluto), args, env não sensível e id
  `custom-<slug>-<8hex>` (com checagem de colisão).
- Valores marcados como secret ficam em `secrets.json` no namespace
  `acp:<agent-id>:<ENV_NAME>`; o renderer só recebe nome/status mascarado.
- Nomes de env seguem `[A-Z_][A-Z0-9_]*`; segredos nunca aparecem em args, logs,
  `launch_json` ou eventos.
- Ícones do Registry são baixados apenas do CDN oficial, sanitizados (≤ 64 KiB) e
  expostos por `acp_agent_icon` como data URL; fallback usa `ProviderGlyph`.

#### Limites e rollback de instalação

- Limites iniciais: download ≤ 1 GiB, descompactado ≤ 4 GiB, ≤ 50 mil arquivos,
  probe/initialize ≤ 30 s e session/new ≤ 60 s.
- Redirects são revalidados: HTTPS, hosts públicos, sem credenciais. O downloader
  desliga redirect automático e segue no máximo 5 hops manuais; em cada hop resolve
  e valida todos os IPs contra loopback/privado/link-local/metadata e fixa a
  resolução daquele request para resistir a DNS rebinding.
- Download bounded valida `Content-Length`, hash e magic; divergência/cancelamento
  remove parcial. Tipo de arquivo é detectado por magic bytes antes da extração,
  não só extensão.
- Binário instalado tem manifesto de hash de todos os executáveis/scripts/libs
  necessários ao launch closure. Verificação completa ocorre no install/update;
  antes de cada launch, tamanho/mtime são conferidos e qualquer divergência
  dispara rehash ou reinstalação. O hash do executável principal é apenas um
  atalho, não a garantia completa.
- Update mantém a versão anterior até o probe da nova passar; sessões ativas
  continuam na versão antiga até o próximo turno. No Windows, usar staging +
  ponteiro `current`/backup swap, nunca rename in-place de diretório aberto.
- Instalação/update emitem `AcpInstallEvent` (`download`, `verify`, `extract`,
  `probe`, `commit`, `rollback`) por Channel e aceitam cancelamento. Cancelamento
  remove staging e não altera a instalação atual.
- Uninstall é recusado com sessão ativa; após encerrar, remove o launch root mas
  preserva um tombstone de instalação e metadados para exibição histórica.
- `reset_app_data` fecha processos ACP antes de apagar arquivos/DB e remove tabelas
  ACP, registry cache, staging, installations, sessões, attachments, content,
  processos e namespace de segredos ACP. Tokens que o agente guarda fora do
  app-data não são apagados pelo app.

### 8.3 Probe e autenticação

Probe:

1. Spawnar o agente com stdio.
2. Enviar `initialize` v1.
3. Validar versão negociada, capabilities e `authMethods`. `agentInfo` ausente
   usa nome configurado/versão `unknown`, sem rejeitar agente custom válido.
   Entrada Registry sem nenhum método de auth é recusada como não conforme;
   custom pode declarar nenhum.
4. Encerrar o processo; não criar sessão.
5. Persistir apenas metadados não sensíveis.

Autenticação:

- `agent`: `authenticate(methodId)` e reconnectar se o agente exigir.
- `terminal`: mostrar args/env, abrir terminal interativo, aguardar exit 0,
  reconectar e repetir `initialize`. Valores env secret-like são redigidos e
  exigem aprovação explícita. Se o launch base usa `.cmd`/batch ou outro
  alvo que reinterprete argv, não oferecer terminal auth; exigir fluxo `agent` ou
  login externo.
- `logout`: chamar apenas com capability. Se houver sessão ativa, bloquear ou
  cancelar/fechar antes; invalidar mapeamentos. Sessões que sobreviverem podem
  terminar ou passar a `auth_required`; o app marca `reauth-required` e nunca cai
  para rota HTTP.
- Status possível: `unknown`, `required`, `authenticating`, `authenticated`,
  `expired`, `signed_out`. Não inferir sucesso só porque `initialize` respondeu.

### 8.4 Criação/resumo de sessão

1. Resolver `cwd`: workspace explícito ou pasta interna isolada.
2. Root set: `[cwd, ...approved_roots]` somente se capability anunciada;
   load/resume reenviam a lista completa pretendida, nunca dependem de estado
   armazenado. Roots relatadas pelo agente/import são propostas display-only e só
   entram no set autorizado via challenge `AdditionalRoots`.
3. System prompt em modo `append` somente se capability anunciada; conteúdo
   confiável e estável (idioma, Markdown, privacidade, instruções da persona e
   `Settings.systemPrompt`), nunca override. Sem capability, o contexto confiável
   entra delimitado no primeiro prompt, nunca como autoridade do agente. Load e
   resume reenviam o mesmo system prompt usado na criação.
4. MCP servers: nenhum por padrão; ponte host tools na Fase 6 se opt-in.
5. Fingerprint inclui agent id/version, launch argv/env names, protocolo, cwd,
   roots, system prompt, MCP config e estado local de auth. Logout invalida o
   mapeamento de sessão.
6. Se já existe mapeamento e o fingerprint bate:
   - `session/resume` se suportado (sem replay);
   - senão `session/load` se suportado, bufferizando/reconciliando replay;
   - senão criar uma sessão nova **sem injetar histórico automaticamente**.
7. Se `agent_version` ou fingerprint mudou, não reutilizar sessão silenciosamente.
8. Persistir `session_id`, versão, capabilities, approved roots e estado.

`session/close` e `session/delete` em sessão inexistente são tratados como
sucesso idempotente; `-32002` não apaga a conversa Zylara.

Sem `loadSession`/`resume`, o app oferece “Nova sessão ACP sem contexto externo” e,
somente com consentimento, uma ação separada “Enviar histórico como contexto”.
Nunca finge que o agente retomou o contexto nem reenvia o último prompt.

Replay de `session/load`:

- Bufferizar todos os updates até a resposta do request em staging bounded
  (≤ 256 MiB/100 mil eventos); não emitir replay como deltas vivos na bolha
  placeholder. Overflow aborta o load.
- `acp_message_map` relaciona `(sessionId, messageId)` ou `syntheticKey` a mensagens
  Zylara. Import/replay criam uma linha por mensagem ACP; no turno ao vivo, várias
  mensagens ACP do mesmo turno são segmentos da única bolha assistant e ficam no
  journal ACP.
- `messageId` ausente gera chave sintética determinística por sessão + role + seq;
  chunks consecutivos sem ID ficam no mesmo segmento. Na dúvida, não duplicar.
- Updates de tool/plan/compaction são entidades ID-keyed com substituição/patch,
  não novas linhas de mensagem.
- Depois da resposta, reconciliar apenas entidades ausentes em uma transação; o DB
  continua fonte de exibição. Replay falhado descarta o buffer inteiro.

### 8.5 Turno ACP

1. Após `runtime::preflight_turn`, `commands::turn` registra e emite `accepted`
   como hoje.
2. ACP runtime persiste user + assistant placeholder e emite `turn_started`.
3. Conecta/retoma a sessão.
4. Converte anexos:
   - imagem → `image` se capability;
   - texto → `resource` se `embeddedContext` e ≤ 1 MiB; maior é staging
     `resource_link`; sem capability, prefixo textual delimitado dentro do limite;
   - binário → `resource` blob se suportado e dentro do limite;
   - fallback → `resource_link` file:// dentro dos roots autorizados.
   - Anexos sem `embeddedContext` são copiados para
     `<app-data>/acp/sessions/<conversation>/attachments/`; esse diretório entra no
     root set via `additionalDirectories` se anunciado. Sem esse capability, o
     binário é recusado com orientação; nunca aponta para fora da raiz.
   - Limites: 25 MiB por anexo, 100 MiB por turno; binário inline só até 8 MiB
     (frame base64 ≤ 16 MiB). Acima, usa `resource_link` staging; sem
     `additionalDirectories`, recusa com orientação. MIME validado; cleanup no
     fecho da sessão/exclusão.
5. Envia uma única `session/prompt`.
6. Consome updates até a resposta com `stopReason`.
7. Emite eventos neutros incrementalmente.
8. Persiste assistente, contexto/custo reportado, erro/resume e estado ACP.
9. Emite `done`/`cancelled`/`error`.
10. Fecha ou mantém a conexão ociosa por timeout configurável.

O harness interno não é chamado em nenhum ponto desse fluxo.

### 8.5.1 Supervisor de conexão e eventos fora do turno

ACP pode enviar updates sem um `session/prompt` pendente: comandos após
`session/new`, notices, mudanças de configuração e trabalho de subagents que
continua depois da resposta do pai. Portanto, o driver da conexão não termina
quando `session/prompt` responde.

- `AcpConnectionSupervisor` mantém processo, conexão, sessões ativas e terminals
  até `session/close`, idle timeout, cancelamento ou shutdown.
- Updates durante o turno usam `PersistingEmitter`/`zylara:turn-event`.
- Updates fora do turno são persistidos em `acp_session_events` e espelhados em
  `zylara:acp-event`; mensagens user-facing viram `ChatMessage` e entidades viram
  `acp_entities` duráveis. Ao reabrir, `acp_get_session_state` reconstrói o estado
  sem depender do journal podado.
- Subagents que continuam após o fim do turno pai aparecem como atividade aninhada
  e não são tratados como turno Zylara.
- Perda da conexão marca estado `disconnected`; nunca inventa sucesso/falha/cancel
  para tools filhas inacabadas.

### 8.5.2 Continuar, regenerar e truncar

- `resumeAssistantMessageId` nativo não é aceito em ACP. `acp_continue_turn`
  envia uma mensagem explícita de continuação para a mesma sessão e reutiliza a
  bolha assistant quando o último stop reason permite.
- `max_tokens`/`max_turn_requests` marcam a bolha como `incomplete` e oferecem
  Continuar; não prometem retomar o passo interno do modelo.
- Regenerar/editar/truncar não faz fork nem rewind: cria uma nova sessão ACP e,
  somente com consentimento explícito, injeta um contexto histórico bounded via
  `acp_restart_with_history`/`acp_send_history_context`. Nunca reenvia o prompt
  para a sessão antiga como se fosse idempotente.
- O contexto injetado é claramente delimitado, limitado pelo orçamento de prompt e
  não reivindica ser o histórico nativo do agente.
- Excluir conversa chama `session/close` apenas se houver conexão/sessão ativa e
  launch disponível/consentido; sem instalação, marca mapping stale e remove o
  transcript local. Nunca spawna um agente só para excluir histórico.
- Adicionar uma sessão ACP do Chat ao Code não muda seu `cwd` nem reduz o modo de
  permissão para Autônomo silenciosamente; mantém Review ou pede escolha explícita.
  Trocar workspace exige nova sessão ACP com consentimento.

### 8.5.3 Admissão e reattach

`acp_continue_turn`, `acp_regenerate` e `acp_restart_with_history` não são atalhos
que burlam o turno: passam por `runtime::preflight_turn`,
`register_turn_if_idle`, `PersistingEmitter` e `finish_turn` como qualquer turno.
Chamadas duplicadas/enquanto ativo recebem `TURN_BUSY`; após reload, o renderer
reattacha por `turn_events`/`zylara:acp-event` sem reenviar o prompt. Comandos sem
`turnId` recebem um id backend e são canceláveis por `cancel_turn`.

### 8.6 Mapeamento de tools

- Criar `ToolCallRecord` no primeiro `tool_call`.
- Atualizar por `(sessionId, toolCallId)`; IDs de renderer são namespaced por
  sessão para não colidir entre pai e filho.
- `pending`/`in_progress` → Running; `completed` → Done; `failed` → Error.
- Cancelamento local marca tool não finalizada como cancelada, mas aceita updates
  posteriores.
- `rawInput` vira args; `rawOutput` vira resultado. Inline limitado a 64 KiB;
  excedente vai para spill e o card mostra referência paginada.
- `content.type=diff` vira presentation `file_change` com path absoluto validado.
- `content.type=terminal` referencia o terminal ACP; streaming vai para
  `tool_progress`.
- `content.type=content` vira texto/imagem/resource no card.
- Nunca renderizar HTML/SVG ativo vindo do agente; usar o renderer seguro atual.

### 8.6.1 Pipeline de conteúdo não textual

Todo `ContentBlock` é persistido em `acp_content_blocks` e referenciado por
`acp_content_block`/`acp_resource_link`; eventos nunca carregam binaries grandes.

| Variante | Persistência/renderização |
| --- | --- |
| `text` | Delta de texto/thought ou texto de tool; limite 1 MiB |
| `image` | Artefato `Image` + thumbnail inline ≤ 256 KiB; original abre no painel |
| `audio` | Artefato `Audio`; player existente, sem inline |
| `resource` blob de vídeo | Artefato `Video`; ACP v1 não tem bloco `video` direto |
| `resource` texto | Texto delimitado ou artefato textual se > 1 MiB |
| `resource` blob | Artefato pelo MIME/tamanho; sem IPC inline |
| `resource_link` | Metadado/URI persistido; nenhum fetch automático |

`acp_get_content_blocks` pagina no máximo 20 itens/1 MiB de metadados+thumbnails;
backend valida que owner/content pertence a uma conversa acessível. Artefatos são
associados à conversa/mensagem e emitem `artifact_created`; o painel
Biblioteca/Artefatos existente continua sendo a fonte de exibição. Bytes recebidos
têm MIME/magic e tamanho validados antes do writer.

Binários ficam em `artifacts/` via writer existente; `acp_get_content_block`
retorna texto ou chunks com `data_base64` ≤ 768 KiB codificado, deixando margem
para o envelope IPC de 1 MiB (`max_bytes` clamp). Conteúdo maior abre o painel de artefato existente (limites
próprios de artefato) ou é paginado. Imagens remotas só carregam após clique. A
mesma pipeline vale em mensagens, thoughts, tools, replay/import e session
messages.

### 8.7 Duas camadas de autorização

1. **Permissão ACP**: operação executada pelo próprio agente. O cliente devolve o
   `optionId` exato ou `cancelled`; é advisory.
2. **Operação mediada pelo cliente**: `fs/*` e `terminal/*`. O Zylara valida roots,
   trust, argv completo, args e env, aplica `policy::decide` e pode pedir aprovação
   própria mesmo sem permission request ACP anterior.

As camadas não se substituem. `allow_always` ACP não cria regra Zylara. Sem canal
humano, operações mediadas e permissões ACP falham fechado. A política ACP de
terminal recebe fatos específicos de programa/argv/env, sem achatar tudo para uma
string de shell.

### 8.8 Permissões ACP

ACP envia options com `optionId`/`kind` próprios. Não converter para
`ApprovalDecision` porque `allow_once`, `allow_always`, `reject_once` e
`reject_always` precisam voltar exatamente ao agente.

Fluxo:

1. Registrar `AcpPermissionRequest` em memória.
2. Emitir `acp_permission_requested`.
3. Aguardar `acp_respond_permission(option_id)` ou cancelamento.
4. Responder ao JSON-RPC com `{ outcome: { outcome: "selected", optionId } }`.
5. No cancelamento do turno, responder `{ outcome: { outcome: "cancelled" } }`.
6. Timeout/canal fechado também responde `cancelled`; nunca inventa um `optionId`.
7. No `session/cancel`, o cliente responde diretamente aos requests inbound:
   permission com `cancelled`, elicitation com `cancel` e fs/terminal cancelados
   com erro JSON-RPC `-32800`. `$/cancel_request` só trafega na direção do
   requisitante para cancelar requests que ele mesmo enviou; o SDK cancela
   requests Zylara→agente dessa forma.

UI mostra título, kind, locations, conteúdo, comandos/paths completos e as opções
exatas. Automação só permite opções compatíveis com a política; nunca decidir
pelo texto do título. Em Autônomo, a opção separada `acp_auto_approve_permissions`
é necessária para auto-selecionar `allow_once`.

### 8.9 Filesystem

`fs/read_text_file`:

- path absoluto, canonicalizado e dentro do root set;
- `line` é 1-based; `limit` clamp ≥ 1; resposta mantém conteúdo textual;
- arquivo regular, limite de bytes/linhas;
- erro `-32002` se ausente;
- conteúdo UTF-8 com perda controlada se necessário.

`fs/write_text_file`:

- `fs/read_text_file` registra o hash observado da conversa;
- path absoluto, canonicalizado e dentro do root set;
- criar diretórios apenas dentro da raiz;
- adquirir `workspace::access`; arquivo novo é permitido. Arquivo existente com
  observação `Fresh` usa CAS; sem observação, captura before sob o lock e exige
  aprovação explícita (autoatendida somente pela política Autônomo), depois
  recheca o hash e escreve. `FS_NOT_OBSERVED` só ocorre se não for possível ler/
  capturar ou se não houver canal de aprovação; divergência → `FS_STALE_VERSION`;
- escrita atômica preservando EOL e journal;
- capturar before/after e emitir `file_changed`;
- exigir aprovação extra para `.git/hooks`, configuração de agente/editor, MCP e
  arquivos que controlam execução.

Fora da raiz: negar ou pedir consentimento explícito em um card específico; nunca
confiar em URI/path vindo do modelo. Paths são canônicos/dunce no Windows; file
URIs usam `Url::from_file_path` com percent-encoding, nunca concatenação manual.
Parâmetros inválidos → `-32602`; arquivo ausente → `-32002`; falha interna →
`-32603` com mensagem sanitizada.

### 8.10 Terminais

Novo `AcpTerminalRegistry`, separado do terminal PTY da UI:

- todo terminal ID é ligado à sessão dona; métodos de outra sessão recebem
  `-32002`/`-32602`;
- `cwd` omitido usa o cwd da sessão; `command` `.cmd`/`.bat` é rejeitado ou passa
  pelo resolvedor de shim validado;
- em `Settings.executionEnvironment=docker`, o cliente não anuncia `terminal` e
  recusa `terminal/*` com JSON-RPC `-32601` + data `ACP_TERMINAL_DOCKER_UNSUPPORTED`
  (tradução de paths e Docker ficam para follow-up);
- `terminal/create` retorna imediatamente;
- argv separado, sem shell;
- `cwd` dentro do root set;
- env higienizado e aprovado;
- política avalia comando completo + args + env;
- ring buffer com `outputByteLimit` clamp 64 KiB–1 MiB, truncamento em fronteira
  UTF-8;
- `terminal/output`, `wait_for_exit`, `kill` e `release`;
- kill de árvore no Windows/Unix;
- streaming sanitizado para `tool_progress`;
- sequências ANSI/controle neutralizadas na renderização;
- release mata se ainda estiver rodando, mas preserva o output para o card.

### 8.11 Cancelamento, crash e retry

- `CancellationToken` do app → `session/cancel`.
- Responder `cancelled` a todas as permissões pendentes da sessão.
- Matar terminals ACP da sessão.
- Aguardar a resposta do prompt por uma janela curta; se não vier, matar a árvore
  e persistir parcial como cancelada/interrompida.
- Perda de conexão depois de enviar prompt **não** reenvia automaticamente: em v1
  não há idempotency key. Marcar `ACP_SESSION_LOST`, avisar risco de duplicação e
  exigir confirmação antes de qualquer reenvio manual.
- Reconnectar antes do prompt pode ser tentado uma vez.
- Erro 401/403 HTTP não existe aqui; mapear `-32000` para auth obrigatória.
- JSON-RPC `-32800` é cancellation, não erro genérico.
- Não reutilizar `ProviderError` nem o retry HTTP.

Orfãos e shutdown:

- `spawn_interactive` é fail-closed: no Windows, falha ao anexar Job Object mata o
  filho e retorna erro; no Unix, usa processo-group + parent-death signal.
- Shutdown gracioso usa um orçamento total de **2 s**, alinhado a
  `begin_graceful_exit`: ≤ 750 ms para cancelar/persistir parcial, ≤ 250 ms para
  stdin EOF, ≤ 500 ms para SIGTERM e o restante para SIGKILL/taskkill. Fora do
  shutdown do app, conexão ociosa pode usar graça maior de 3 s. Cancelamento do
  app mata imediatamente após o budget.
- `acp_processes` guarda pid, boot id, start time e executável. No boot, só mata
  processo órfão se boot id diferir **e** identidade ainda bater; evita matar PID
  reutilizado.
- Perda da conexão marca sessão `disconnected`; requests pendentes desaparecem e
  tools inacabadas ficam com estado desconhecido, nunca inventado.
- Após crash/restart, turno interrompido vira `interrupted`; o app oferece
  Continuar ou Nova sessão, nunca reenvia automaticamente.

### 8.12 Workspace e painel Alterações

- No início do turno, capturar estado dos arquivos do workspace usando o journal
  existente.
- Diffs ACP são display-only até serem confrontados com o disco; nunca provam
  mutação nem autorizam revert.
- No fim, comparar before/after e registrar mudanças diretas que o agente não
  reportou.
- Snapshot limitado: arquivos ≤ 2 MiB guardam conteúdo; maiores/binary guardam
  hash+tamanho e não prometem revert. Ignorar diretórios build/dependência.
- Usar `workspace::access` no snapshot; escritas diretas concorrentes continuam
  fora do lock. Mudanças observadas são rotuladas “durante o turno”, não atribuídas
  com certeza ao agente.
- Emitir `workspace_changes` para o card de resumo e painel.
- Reverter arquivo/turno usa o object store existente quando há captura válida.
- Se a captura falhar, o turno continua, mas a UI mostra “diff indisponível para
  este agente”; nunca fingir que não houve mudança.

### 8.13 Título, uso e custo

- `session_info_update.title` só é aplicado quando `conversations.title_source` é
  `auto`; rename do usuário grava `user`. Títulos nativos continuam usando
  `should_auto_title`, mas a coluna remove a ambiguidade do placeholder.
- `usage_update.used/size` vira `ContextStats`; não são tokens cobrados do turno.
  Conversão é checked/saturating para `u32`; `outputCap=0` e breakdown vazio
  significam desconhecido. Contexto de filhos nunca é somado ao do pai.
- `usage_update.cost` é **cumulativo por sessão** e já inclui descendentes. Fica em
  `AcpReportedCost`/`acp_cost_samples`, nunca direto em `UsageInfo.cost` por turno.
- Delta por turno só é derivado quando moeda e sessão-root são iguais e o novo
  cumulativo é ≥ o baseline anterior. Cumulativo menor indica reset/sessão nova e
  não gera delta negativo. Só o delta USD inequívoco pode entrar em
  `usage_log`; custo de filho nunca é somado ao do pai.
- Outras moedas são exibidas como “custo reportado pelo agente”, sem conversão.
- Sem usage: tokens/custo/cache aparecem como `—`, nunca zero inventado.
- Cache do Zylara não é calculado para ACP.
- Orçamento diário em USD usa apenas deltas registrados; não consegue impedir
  overspend no meio do turno e a UI avisa essa limitação.

### 8.14 Elicitation

- Anunciar `form` e `url` somente se ambos os fluxos estiverem implementados.
- Form mode cobre todas as variantes estáveis: string, integer, number, boolean,
  enum e array multi-select de tipos suportados; aplica defaults, valida no
  cliente e deixa o usuário revisar antes do `accept`.
- Rejeitar campos com nomes de segredo (`password`, `token`, `secret`, `api_key`,
  chave privada etc.); ACP exige URL mode para credenciais.
- URL mode mostra URL completa/host, nunca faz prefetch, exige HTTPS fora de dev,
  rejeita userinfo e caracteres de controle, bloqueia hosts privados/loopback e
  só abre no navegador do sistema após consentimento com target completo.
- `elicitation/complete` só é aceito para o ID original da mesma conexão; IDs
  desconhecidos/repetidos são ignorados.
- `decline`/`cancel`/timeout são fallbacks seguros; nunca assumir sucesso.

### 8.15 Entidades ID-keyed e subagents

O estado ACP persistente é um fold de entidades, não uma lista de eventos. Toda
entidade é chaveada por `(sessionId, entityId)`; IDs de renderer recebem namespace
de sessão.

- Plan por `planId`: `items` ou `markdown`, entries/path, substituição integral e
  `plan_removed`; posição na timeline fixada na primeira aparição.
- Compaction por `compactionId`: status, summary chunks, replacement/null/clear,
  erro e posição fixa. Replay usa a mesma semântica.
- Session message por `messageId`: content, sender/recipient session e mensagens
  linkadas; chunks acumulam, update substitui, omission preserva e `null`/`[]`
  limpa conforme o schema. Views só são linkadas por `senderMessageId`/
  `recipientMessageId`, nunca por IDs iguais.
- Tool call por `toolCallId`: omitted = unchanged, `null` = clear onde o schema
  permite, content/locations arrays substituem; `content.type=session` é referência
  display-only.
- Notice é evento independente, sem ID/histórico; severidade desconhecida é
  preservada com apresentação genérica. `available_commands_update` substitui a
  lista completa de comandos.
- `configOptions` preserva a ordem do agente; opção com `type` desconhecido é
  ignorada e o agente mantém `currentValue`. `configOptions` tem precedência sobre
  `modes` quando ambos existem. `config_option_update` substitui a lista completa;
  `session/set_config_option` valida id/tipo/value contra as opções anunciadas
  antes do envio.

Subagents:

- Árvore tipada pai/filho com roots próprios, capabilities e estado
  `running|requires_action|idle|unknown`. Updates patcham campos; capabilities é
  substituído como um todo.
- Cliente nunca envia prompt/load/resume/close/delete/config para filho; só
  `session/cancel` quando `capabilities.cancel` existe.
- `session/close` do pai cancela e libera descendentes; filhos nunca recebem
  `session/close` diretamente.
- Load/resume descarta capabilities/estado correntes dos filhos. No `load`,
  anúncios antes da resposta são históricos e só snapshots após a resposta são
  atuais; no `resume` (sem replay), todos os anúncios são atuais.
- Roots filhas reportadas são display-only até aprovação. O root set efetivo para
  `fs/*`/`terminal/*` é a interseção canônica com roots aprovados; fora dela, negar
  ou pedir consentimento por diretório. Nunca expandir autoridade só porque o
  agente relatou um caminho. Anúncios seguem ordem ancestral antes de updates/
  requests filhos.
- Comandos/config de filhos são read-only; requests de descendentes só são
  cancelados quando o filho reporta idle/cancelled ou o pai é fechado. Perda de
  conexão deixa estado `unknown`.
- Custo do pai já inclui descendentes; nunca somar filho ao pai.
- Filhos não viram conversas Zylara nem usam `SubagentStarted` nativo.

### 8.16 Recursos nativos em sessão ACP

O backend recusa, com código estável, operações que dependem do harness interno:
`/goal`, completion gate, forced-final-answer, protocol fallback, cache/compact
nativo e `set_conversation_model`. O toggle Plano nativo fica oculto em ACP;
modos do agente aparecem em controle separado. `/compact` só é aceito se o agente
expuser um comando/config ACP equivalente; caso contrário a UI explica que a
compactação é gerenciada pelo agente. Plugins modes/prompt não são injetados no
ACP; somente a ponte host tools opt-in pode reutilizar tools do Zylara.

### 8.17 Persona, memória e capabilities

- Nome, role, descrição e instructions da persona entram no system prompt `append`
  confiável; sem capability, entram como bloco delimitado no primeiro turno.
- Memória e histórico de canal entram como contexto volátil marcado como não
  confiável, nunca como autoridade de sistema.
- Na v1, memória ACP é snapshot read-only; escrita durável exige a tool `memory`
  da ponte host tools.
- Allowlists nativas não conseguem restringir tools internas do agente externo. A
  UI esconde/desativa capabilities não aplicáveis e avisa; a ponte host tools
  filtra pelo `AgentCapabilities`.
- Tarefas ACP e líder de canal ficam desativados até existir runner ACP de tasks,
  budget/pré-turno e a ponte expor `finish_task`/`delegate_task`. Responder em canal
  e rotinas simples são permitidos com fail-closed para permissão/elicitation.
- Governor, fila, cancelamento e notificações continuam passando pelo dispatcher
  compartilhado.
- Runner ACP de tasks (Fase 6) define conclusão/continuação/recusa/cancel,
  `ResumeState` próprio, delta de custo reportado e comportamento `unknown`. O
  budget diário é checado antes do turno com o último delta USD conhecido; sem
  custo reportado, a UI mostra desconhecido e o limite não é fingido.

## 9. Matriz de capabilities

| Capacidade ACP | Suporte na entrega | Observação |
| --- | --- | --- |
| Texto/imagem/áudio/resource no prompt | Sim | Conforme capabilities anunciadas |
| Streaming texto/thought | Sim | Eventos neutros |
| Tool calls/diffs/terminals | Sim | Mapeamento dedicado |
| Permissões | Sim | Card e resposta exata por optionId |
| FS cliente | Sim | Roots + journal |
| Terminal cliente | Sim | Runner endurecido |
| Auth agent/terminal/logout | Sim | UI dedicada |
| Session new/load/resume/close | Sim | Reconciliação de replay |
| Session list/delete/import | Sim | Import cria conversa Zylara |
| Config options/model/thought | Sim | Bool, selects agrupados e mudança durante turno |
| Modes legados | Sim | Separados da permissão Zylara |
| Slash commands | Sim | Badge ACP e namespacing em colisão |
| Elicitation form/URL | Sim | Cards novos; URL com consentimento |
| Notices | Sim | Toast/banner, não mensagem |
| Compaction | Sim | Timeline + resumo |
| Subagents | Sim | Cards aninhados; não são conversas Zylara |
| System prompt append | Sim | Somente conteúdo confiável |
| MCP host tools | Sim, Fase 6 | Opt-in; não bloqueia o release ACP base |
| Memória durável de persona | Somente com Fase 6 | Snapshot read-only sem bridge |
| Tarefas/líder de canal ACP | Somente com Fase 6 | Exigem `finish_task`/`delegate_task` |
| ACP v2 | Não nesta entrega | Preview |
| Transporte remoto | Não | Ainda não estável |
| `/goal` Zylara | Não em ACP v1 | Depende da tool interna |
| Completion gate interno | Não em ACP v1 | Depende das tools internas |
| Fallback de modelo HTTP | Não em ACP | Evita troca de runtime silenciosa |

## 10. Organização do renderer

### 10.0 Seleção runtime-aware

`ModelSelection` nativo não é alterado. Novo union:

```ts
type RuntimeSelection =
  | {
      kind: 'native';
      providerId: string;
      modelId: string;
      reasoning?: ReasoningSelection | null;
    }
  | { kind: 'acp'; agentId: string; configFingerprint?: string };
```

- `appStore` mantém catálogo/keys nativos e `acpStore` mantém instalações/estado;
  readiness é `nativeReady` ou `acpReady`, nunca uma só função `providerReady`.
- `ModelPill`/`ModelPickerDialog` ramificam por runtime; labels ACP vêm do agente e
  das `configOptions`, não de `ProviderInfo`.
- `chatStore` persiste `agentKind`/`acpAgentId`; `messageQueueStore` guarda
  `runtime`, `acpAgentId` e fingerprint. No dispatch, a conversa é autoridade e
  item incompatível falha com orientação.
- `codeStore` consome eventos ACP, pending requests e estado da sessão.
- Favoritos nativos continuam por par; favoritos ACP são lista separada de agent
  ids. `defaultAcpAgentId` não mexe em `defaultProvider/defaultModel`.

### 10.1 Novos componentes

```text
src/lib/store/acpStore.ts
src/lib/acp.ts
src/components/settings/AcpAgentsSection.tsx
src/components/settings/AcpAgentDialog.tsx
src/components/settings/AcpAuthDialog.tsx
src/components/models/AcpAgentPicker.tsx
src/components/models/AcpConfigControls.tsx
src/components/chat/AcpPermissionCard.tsx
src/components/chat/AcpElicitationCard.tsx
src/components/chat/AcpNotice.tsx
src/components/chat/AcpSubagentCard.tsx
src/components/code/AcpSessionControls.tsx
```

### 10.2 Modificações

| Arquivo/área | Mudança |
| --- | --- |
| `ProvidersTab.tsx` | Seção ACP separada |
| `ModelTab.tsx` | Default runtime nativo/ACP |
| `appStore.ts` | Defaults ACP e readiness separada |
| `store/index.ts` | Export do `acpStore` |
| `ModelPill.tsx` | Rota ACP, label agente/modelo, opções ACP |
| `ModelPickerDialog.tsx` | Grupo/aba ACP só quando instalado |
| `modelMenu.ts` | Busca runtime-aware sem mudar grupos nativos |
| `chatStore.ts` | Seleção ACP, lock, eventos e estado da sessão |
| `messageQueueStore.ts` | Runtime/agente/fingerprint no item da fila |
| `codeStore.ts` | Eventos, pending requests e custo reportado ACP |
| `sessionCost.ts` | Custo reportado ACP separado do preço por tokens |
| `agentStore.ts` | Runtime ACP da persona |
| `AgentEditorDialog.tsx` | Seletor Zylara/ACP |
| `AgentHome`/`TeamView`/`AgentPanel` | Runtime, status e custo ACP |
| `CodeSidebar.tsx`/`useWorkspaces.ts` | Novo agente ACP e criação da sessão |
| `Composer` | Readiness runtime-aware e toggles internos gerenciados pelo agente |
| `AgentSteps`/`ToolCallRow` | Permissões, elicitation, notices e subagents ACP |
| `AgentActivityDialog`/sidebar | Pendências ACP, atenção e notificações |
| `CodeSessionHeader`/`CodeAgentWidgets` | Modo ACP + contexto/custo reportado |
| `Markdown.tsx`/`MarkdownImage.tsx` | Modo ACP-safe sem alterar o nativo |
| `App.tsx` | Listener `zylara:acp-event` |
| `commands.ts` | Slash commands ACP com `displayName` + `rawName` |
| `src/locales/{en,pt-BR,es}` | Todas as copies novas |

### 10.3 Regras de UI

- Não alterar contagens/labels dos provedores HTTP quando não houver ACP
  instalado.
- ACP e modelo HTTP não aparecem como o mesmo tipo de “provedor”.
- Mostrar versão do agente e protocolo no detalhe da sessão.
- Durante streaming, o agente ACP continua bloqueado; `configOptions`/modes podem
  mudar durante o turno conforme ACP permite. O lock nativo de modelo não muda.
- Todo conteúdo do agente passa por um **modo ACP-safe** do Markdown:
  - imagens `data:` por padrão; imagem remota exige clique com URL completa;
  - fences `html`, `svg` e `mermaid` viram código inerte por padrão;
  - previews ativos só abrem por ação explícita do usuário;
  - links/URI remotos só abrem com ação do usuário.
- O modo nativo atual do Markdown não muda.
- Cache nativo não é exibido como suportado em ACP; o indicador fica oculto ou
  mostra “não reportado”.
- Ícones SVG do Registry são sanitizados e cacheados; fallback para `Bot`.
- Comandos ACP guardam `displayName` e `rawName`; colisões são exibidas com
  namespace, mas o texto enviado continua sendo o `/rawName` original. Built-ins
  locais são filtrados por runtime.
- Permissões/elicitations ACP entram na Atividade, nas notificações e nos
  indicadores de atenção da sidebar; executions não assistidas falham fechado.
- Sessões ociosas com filhos ativos têm ações explícitas Cancelar/Fechar, que
  propagam descendentes e terminals.

## 11. Segurança e privacidade

Checklist obrigatório:

- [ ] Consentimento antes de instalar e antes do primeiro turno.
- [ ] Aviso explícito de que ACP não é sandbox.
- [ ] Binário/argv separado; nenhuma string de shell interpolada.
- [ ] Windows `.cmd` tratado por launcher seguro e testado com espaços/metacaracteres.
- [ ] Job Object/process group e kill de ávore no cancelamento/shutdown/crash.
- [ ] Nenhuma chave/token do Zylara no ambiente do agente.
- [ ] Env do Registry revisado; variáveis perigosas negadas sem aprovação.
- [ ] Checksum verificado quando existente; TOFU explícito quando ausente.
- [ ] Extração segura contra traversal, links, ADS, nomes reservados e bombs.
- [ ] Roots canônicos e verificados no momento do uso.
- [ ] `fs/*` e `terminal/*` passam pela política do app.
- [ ] Permissão ACP nunca é aprovada só pelo título.
- [ ] Comandos/paths/URLs revelam ou removem caracteres bidirecionais/zero-width/
      tag/controle antes da política e da exibição.
- [ ] Nenhuma URI fora de `http(s)`/`mailto`/`file` autorizado abre sem confirmação
      explícita; schemes custom não abrem automaticamente.
- [ ] Cancelamento responde a todos os requests pendentes.
- [ ] stdout limitado por linha; stderr limitado e sem credenciais.
- [ ] Erros/stderr passam por redaction de tokens antes da UI/log.
- [ ] Conteúdo remoto/SVG/HTML do agente não executa nem busca sozinho.
- [ ] URL de elicitation mostra host/URL completa e exige consentimento.
- [ ] Logs/telemetria não incluem prompts, tokens, env ou stdout bruto.
- [ ] Registry/TOFU descritos como não assinados; lifecycle scripts de npm/uv
      informados no consentimento.
- [ ] Markdown ACP-safe: sem fetch remoto/ativo automático.
- [ ] Limites rígidos de frame, processo, terminal, pending requests, updates,
      anexos e IPC; backpressure testado.
- [ ] `agent_kind` validado contra gramática/agente instalado e feature flag.
- [ ] Sessões órfãs são fechadas no boot e no shutdown.

### 11.1 Limites iniciais

| Recurso | Limite |
| --- | --- |
| Frame stdout ACP | 16 MiB; excesso aborta conexão |
| stderr retido | 64 KiB por processo |
| Processos ACP ativos | 32 por app; excedente recebe `ACP_CAPACITY` |
| Idle timeout | 300 s por conexão |
| Terminais | 8 por sessão / 64 global |
| Output por terminal | 1 MiB ring buffer |
| Permissões/elicitations pendentes | 8 por sessão; 60 pedidos/min por sessão |
| Estado ACP folded | ≤ 1 MiB por sessão; excedente poda entidades antigas/spill |
| `_meta`/erro | ≤ 16 KiB/8 KiB; allowlist + redaction, nunca persistir bruto |
| Updates | 200 eventos/s por sessão; payload IPC ≤ 1 MiB, maior usa spill/referência |
| Journal/session list | ≤ 100 itens e ≤ 1 MiB por página; cursors opacos |
| Estado ACP resumido | ≤ 256 KiB; entidades paginadas separadamente |
| Entidades/conteúdo duráveis | 100 mil itens/2 GiB por conversa; excedente falha visível, sem poda silenciosa |
| Deltas de texto/thought | Coalescer até 50 ms/16 KiB sem perder conteúdo |
| Anexos | 25 MiB cada / 100 MiB por turno; inline binário ≤ 8 MiB |
| Texto/resource | 1 MiB por bloco; maior vira artefato/spill |
| Prompt/resource | Frame outbound ≤ 16 MiB; texto ≤ 1 MiB |

Limites são constantes de contrato testadas; não afetam o runtime nativo. O 9º
pending request é recusado com erro estável; journal é podado por idade/tamanho;
payloads grandes usam spill/referência. `_meta` desconhecido é descartado após
allowlist/limite, e erros são redigidos antes de persistir/emitir. Acima de 200
updates/s, deltas são coalescidos sem perda; se a fila bounded estourar, a conexão
falha fechado com `ACP_UPDATE_OVERFLOW`, nunca descarta silenciosamente.
`acp_get_session_state` devolve apenas resumo; entidades/conteúdo são paginados.
`acp_list_entities` devolve metadados, nunca payload completo; `acp_get_entity`
entrega chunks bounded. `acp_list_session_events` inclui payload inline só até
64 KiB; maiores usam referência de spill. Resposta `session/list` acima do limite
é rejeitada com erro estável, nunca retornada inteira por IPC.

## 12. Estratégia de testes

### 12.1 Testes de Registry/instalação

- Parse do wrapper `registry.schema.json` e de cada entrada `agent.schema.json`
  contra o snapshot real de 46 agentes; ids únicos/versão/ordem.
- Plataforma/arquitetura, distribuição ausente, preview channel e seleção explícita
  binary/npx/uvx.
- Hash válido/inválido/ausente; TOFU.
- ZIP/tar.gz/tar.bz2/raw; path traversal, symlink, hardlink, ADS, nome reservado,
  colisão Windows, zip bomb, arquivo grande demais.
- `npx`/`uv` resolution, gramáticas npm e PEP 440 com specs reais do Registry e
  args seguros.
- DNS rebinding, IP privado/link-local/metadata e redirect host hopping.
- Windows `.cmd` launcher com espaços, aspas, `&`, `|`, `%`, Unicode.
- Consentimento persistido por digest/version/scope; challenge one-time correto,
  velho/reaproveitado/divergente ou com escopo ampliado falha; histórico/import/
  roots usam o mesmo challenge; IPC direto sem consentimento não spawna;
  revogação/update invalida.
- Cache offline, ETag, falha de rede e Registry inválido.
- `acp_enabled=false` não faz refresh automático; manual explícito funciona.
- `agentInfo` ausente em custom válido usa nome configurado/`unknown`.
- Update/rollback sem interromper sessão ativa.

### 12.2 Agente ACP fake

Criar duas camadas:

1. **Peer Rust in-process** usando `Channel`/`Lines` do SDK, sem Python/Node, para
   todos os testes de protocolo, replay, cancelamento e handlers.
2. Fixture executável em Python ou Node (stdlib, condicional ao runtime) para E2E
   real de processo/stdout/stderr/kill de árvore.

O fixture cobre:

- initialize/capabilities/authMethods;
- session/new, prompt com streaming de texto/thought;
- tool_call/create/update, diff, terminal e rawInput/rawOutput;
- permission request allow/reject/cancel;
- `$/cancel_request` inbound/outbound e respostas diretas a requests do agente;
- fs read/write dentro/fora da raiz, line/limit e erros -32602/-32002;
- terminal create/output/wait/kill/release, ownership, UTF-8 boundary e recusa em
  Docker/shim inseguro;
- elicitation form (string/integer/number/boolean/enum/array) e URL;
- config options, modes e available commands;
- session info, usage, notice, compaction e subagent;
- image/audio/resource/resource_link em mensagem, thought, tool e replay;
- stop reasons (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`,
  `cancelled`), erro JSON-RPC, crash, stderr ruidoso e stdout inválido;
- config select agrupado, boolean com discriminator e precedência sobre modes;
- load/resume/close/list/delete;
- cancelamento lento e processo que ignora stdin EOF.

O fixture nunca exige rede ou credencial.

### 12.3 Testes de integração do turno

- Preflight `ACP_DISABLED`/sem consentimento não emite `accepted` nem cria mensagem.
- `agent_kind=zylara` continua chamando o harness nativo; harness defensivo
  recusa runtime não nativo.
- `agent_kind=acp:*` chama apenas o runtime ACP.
- Todos os callers (`turn`, tasks, routines, channels, inbox) usam o dispatcher.
- Budget diário ACP é verificado em todos os callers; custo desconhecido falha
  fechado quando há limite.
- Dispatcher nativo com writer de workspace pendente não faz self-deadlock; ACP
  mantém um único gate durante o turno.
- Um turno por conversa, cancelamento, fila e reattach.
- Persistência de parcial, erro, usage e título.
- Restart com resume/load/new e sem duplicação.
- Transcript/entidades ACP sobrevivem após poda de `acp_session_events`.
- Replay com/sem `messageId`, múltiplas mensagens e falha no meio do buffer.
- Colisão de `call_001` entre pai/filho; load histórico vs resume current.
- Root filha fora do workspace não amplia autoridade sem consentimento.
- Import/load/resume persistem e reenviam approved roots; roots relatadas não
  expandem o set automaticamente.
- Mudança de versão/config invalida sessão.
- Anexos texto/imagem/áudio/binary conforme capabilities e roots.
- Custo cumulativo, moeda e delta sem double-count de filhos.
- `updatedAt` RFC3339, contexto checked/saturating e filhos não somados.
- Workspace ACP exige trust/consentimento; `fs/write_text_file` usa lock/CAS e
  retorna `FS_STALE_VERSION` em escrita concorrente; arquivo existente sem leitura
  pede aprovação com before-capture, e `FS_NOT_OBSERVED` só bloqueia quando não há
  como capturar/aprovar.
- Workspace changes, diff display-only e revert limits.
- Órfão com PID reutilizado não é morto; boot id/start time conferem.
- 9º pending request, frame 16 MiB, chunk 768 KiB + envelope ≤ 1 MiB, journal/
  session list/entidades paginados, `_meta`/erro redigidos e poda de estado.
- Shutdown em menos de 2 s com kill da árvore.

### 12.4 Testes de renderer

- Registry, instalação, update, auth, PTY interativo e erros.
- Seleção ACP em Chat/Code/Agentes.
- `RuntimeSelection` Rust↔TypeScript round-trip com tag `kind`.
- Lock de agente no Chat e troca no Code; config ACP durante streaming.
- Import exige cwd igual/capability; replay falho rollback; delete ativo fecha antes.
- Continue/regenerate/restart ACP passam por admissão/reattach e chamadas duplicadas
  recebem `TURN_BUSY`.
- Regenerate/edit/truncate criam nova sessão só com consentimento de contexto.
- `set_conversation_runtime` recusa turno ativo, invalida sessão/fila e preserva lock.
- Logout com sessão ativa bloqueia/fecha; Chat→Code ACP não vira Autônomo.
- Fila com runtime/agente/fingerprint e item incompatível.
- Slash commands, `rawName` e colisão com built-ins.
- Permission/elicitation/notice/subagent/plan/compaction cards.
- Tool calls, diffs, terminal e output sanitizado.
- Conteúdo image/audio/resource/link persistido e renderizado sem fetch automático.
- Markdown ACP-safe: imagem remota, HTML/SVG/Mermaid inerte.
- Unicode bidirecional/zero-width/tag em comandos, paths, URLs e aprovações.
- Custo USD vs outra moeda; cumulativo e delta; usage ausente.
- Atividade/notificações/sidebar com pendências ACP.
- Sessão ociosa com filho ativo oferece Cancelar/Fechar e limpa descendentes.
- ACP desligado/removido durante sessão.
- Conversa histórica sem instalação ainda abre/renomeia/exporta/exclui sem spawn.
- Persona importada com ACP ausente fica indisponível e não executa.
- Acessibilidade: foco, labels, teclado, `aria-live`.

### 12.5 Gates de não regressão

- Nenhum diff em `providers/**`, `data/catalog.json`,
  `scripts/build-catalog.mjs`, `scripts/provider-seeds.mjs` ou `oauth/**`.
- Fixtures de request/response dos quatro protocolos continuam idênticos.
- Testes nativos de Chat/Code/Agentes continuam passando.
- Contagem de provedores HTTP e abas do seletor não muda sem ACP instalado.
- Reset remove processos/tabelas/dirs/segredos ACP sem tocar dados nativos.
- Migração de banco legado preserva todas as linhas e defaults.
- `pnpm typecheck`, `pnpm test`, `cargo check`, `cargo test --lib`,
  `pnpm i18n:check` e `pnpm test:scripts`.
- Build determinístico ACP: `pnpm exec tsc --noEmit && pnpm exec vite build`.
  `pnpm build` completo é rodado à parte; se `sync-catalog.mjs` gerar diff, ele é
  revisado como mudança de catálogo, nunca escondido no diff ACP.
- CI Windows/macOS/Linux para codec, processo, archive, paths e shims.

### 12.6 Gates de performance

- Startup não bloqueia em Registry; cache local aparece imediatamente.
- Refresh é nonblocking e mostra `fetchedAt`/stale.
- Lista de 46 agentes mantém busca/filtro responsivos sem carregar ícones remotos
  em massa.
- IPC e journal ACP respeitam os limites da §11.1; backpressure não acumula memória
  sem teto.
- Idle timeout e cap de 32 processos evitam crescimento sem fim.

## 13. Fases, tarefas e dependências

### Fase 0 — Baseline e contrato

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T0.1 | Resolver/registrar as 8 falhas Vitest preexistentes | Lead | — |
| T0.2 | Criar tipos Rust/TS, settings, eventos e migrations aditivas (consent, mensagens, conteúdo, entidades, custo) | Lead + storage-dev | T0.1 |
| T0.3 | Feature flag `acp_enabled=false`, gramática `agent_kind` e guard no harness | Lead | T0.2 |
| T0.4 | Pin do SDK e spike `Lines` + codec limitado + processo interativo | Lead + code-runtime-dev | T0.2 |
| T0.5 | `runtime::run_turn`, `preflight_turn` (incl. budget ACP) e todos os callers de fundo | Lead | T0.3 |
| T0.6 | Extração mecânica do ciclo de vida + gate exclusivo do runtime ACP | Lead + harness-dev | T0.5 |
| T0.7 | `RuntimeSelection`, `acpStore`, fila e defaults | Lead + ui-core/ui-systems | T0.2 |

Saída: compila, dispatcher cobre todos os runtimes/callers, testes nativos verdes,
nenhuma mudança de comportamento.

### Fase 1 — Registry e instalação

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T1.1 | Fetch/cache/schema do Registry | Lead | T0.4 |
| T1.2 | Downloader/checksum/extractor seguro | Lead | T1.1 |
| T1.3 | Launcher binário/npx/uv + Windows wrappers | Lead | T1.2 |
| T1.4 | CRUD de instalações, consentimento e probe `initialize` com transporte mínimo | Lead + storage-dev | T1.3, T0.4 |
| T1.5 | UI Registry/instalação/update/progress | ui-systems | T1.4 |

Saída: instalar, atualizar, remover e fazer probe `initialize` sem criar turno;
autenticação entra na Fase 4.

### Fase 2 — Sessão e turno mínimo

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T2.1 | Client v1, transporte, codec e handler base | Lead | T0.4 |
| T2.2 | new/resume/load/close, message map, conteúdo/entidades duráveis e reconciliação | Lead + storage-dev | T2.1 |
| T2.3 | Prompt texto/imagem/áudio/resource + staging de anexos | Lead | T2.2 |
| T2.4 | Streaming texto/thought/tool/contexto/custo/stopReason | Lead | T2.3 |
| T2.5 | Dispatcher ACP, persistência durável, budget e supervisor fora do turno | Lead | T2.4, T0.5 |
| T2.6 | Peer Rust in-process + fixture executável + integração | Lead | T2.5 |

Saída: turno ACP real de ponta a ponta em Code, com texto, thought, tool e uso.

### Fase 3 — Permissões, filesystem e terminal

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T3.1 | `session/request_permission` + UI | Lead + ui-core | T2.5 |
| T3.2 | `fs/read_text_file`/`write_text_file` + roots/journal | Lead + harness-dev | T2.5 |
| T3.3 | Terminal registry ACP sobre runner endurecido | Lead + code-runtime-dev | T2.5 |
| T3.4 | Cancelamento/crash/kill de árvore | Lead | T3.1–T3.3 |
| T3.5 | Workspace snapshot/diff/revert ACP | Lead + ui-code | T3.2 |

Saída: agente externo pode operar o workspace com aprovação e cancelamento.

### Fase 4 — Integração de produto

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T4.1 | ACP em Chat e Code (picker, lock, `set_conversation_runtime`, controles) | Lead + ui-core/ui-code | T2.5, T0.7 |
| T4.2 | ACP em personas Agentes + export/import | Lead + ui-agent | T4.1 |
| T4.3 | Auth agent/terminal/logout backend + UI, incluindo PTY Channel/write/resize/exit | Lead + ui-systems | T1.4, T2.1 |
| T4.4 | Config options, modes e slash commands (`rawName`) | Lead + ui-systems/ui-core | T2.5 |
| T4.5 | Session list/delete/import + cursor/duplicate | Lead + storage-dev | T2.2 |
| T4.6 | Atividade, notificações, sidebar e fila ACP | Lead + ui-core/ui-agent | T4.1 |

Saída: seleção e gestão ACP nos três layouts.

### Fase 5 — Updates avançadas estáveis

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T5.1 | Elicitation form/URL | Lead + ui-core | T4.4 |
| T5.2 | Notices, compaction e session info | Lead + ui-core | T2.4 |
| T5.3 | Subagents ACP | Lead + ui-core | T2.4 |
| T5.4 | Plano ACP e reconciliação de replay | Lead | T2.2 |
| T5.5 | Testes de acessibilidade e conteúdo hostil | ui-core + ui-systems | T5.1–T5.4 |

Saída: paridade com as capacidades estáveis do ACP v1.

### Fase 6 — Ponte MCP opcional

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T6.1 | Helper MCP stdio (`rmcp_3` + `rmcp` 3.4) do próprio binário + IPC local one-time token | harness-dev + Lead | T3.2 |
| T6.2 | Expor web/fetch/artifacts/skills/validate_ui/memory/colaboração filtrados | harness-dev | T6.1 |
| T6.3 | Opt-in, capabilities, auditoria e cleanup | Lead + harness-dev | T6.2 |
| T6.4 | Testes com fake agent e MCP | harness-dev | T6.3 |
| T6.5 | Runner ACP de tasks, budget e líder de canal | Lead + harness-dev | T6.2 |

O helper usa a API MCP stdio estável do SDK + `agent-client-protocol-rmcp` com a
feature obrigatória `rmcp_3` (o crate não tem default features) e `rmcp` 3.4 para
macros/tools. O entrypoint é `acp::mcp_bridge::helper_main()` em `lib.rs::run`,
antes do plugin single-instance. `session/new.mcpServers` aponta para `current_exe()` com o modo
helper/token. Não usa `unstable_mcp_over_acp`. O token é de uso único, vinculado
à conversa/sessão e ao boot, com expiração curta; o socket/named pipe tem ACL local
e cada request revalida sessão/admission. Shell/FS não são expostos.
Cada tool tem mapa explícito de capability e escopo de dados; `read_artifact` é
user-wide e isso é informado na UI. O token trafega apenas no env do helper, nunca
em state/log/evento, e é redigido de erros. O agente necessariamente recebe esse
token; a segurança vem do escopo/expiração/admission no helper e no host. Testes
Rust de integração do helper entram em `cargo test --lib` e na CI; não há registro
em `test:scripts` por não ser script Node.

Saída: agente ACP pode usar ferramentas específicas do Zylara sem receber shell/FS
duplicado. Esta fase não bloqueia o release ACP base.

### Fase 7 — Endurecimento e release

| # | Tarefa | Dono | Depende de |
| --- | --- | --- | --- |
| T7.1 | Matriz ao vivo com agentes do Registry | Lead | T4–T5 |
| T7.2 | Testes de processo/rede/arquivo hostis | Lead | T7.1 |
| T7.3 | Docs (`ARCHITECTURE`, `MODELS`, `DESIGN`, `AGENTS`, README, research SDK), i18n, evidência e rollback | Lead | T7.2 |
| T7.4 | CI matrix e testes cross-platform | Lead | T7.2 |
| T7.5 | Ligar `acp_enabled` por padrão | Lead | T7.3, T7.4 |

Matriz ao vivo mínima, quando o usuário tiver credenciais:

```text
Codex, Claude Agent, Gemini CLI, GitHub Copilot, Kimi Code,
OpenCode, Cursor, Goose
```

Cada linha registra: instala, initialize, auth, new/resume, prompt, tool,
permission, cancel, logout. Falhas do agente são classificadas como
“não conforme” ou “credencial pendente”, nunca mascaradas.

### 13.1 Convenções de implementação

- Código e comentários novos em inglês; UI exclusivamente via i18n nos três
  locales.
- Cores/espaçamentos apenas com tokens do Tailwind; ícones lucide; acessibilidade
  desde o primeiro teste.
- Testes unitários/integração são critério; screenshots/SendKeys/CDP não são usados
  como prova de conclusão, conforme `AGENTS.md`.
- Cada tarefa começa com teste automatizado que falha antes da implementação.

## 14. Critérios de aceite

1. O Registry oficial é descoberto, validado por wrapper + schema de entrada,
   cacheado e exibido no app.
2. As três distribuições (`binary`, `npx`, `uvx`) instalam e atualizam com
   consentimento, checksum/TOFU, extração segura, progresso e cancelamento.
3. Um agente ACP pode ser autenticado por fluxo `agent` ou `terminal` com PTY
   interativo completo; logout invalida/cancela sessões sem vazar tokens.
4. Chat, Code e Agentes podem selecionar/trocar o agente ACP instalado; seleção,
   fila, defaults e favoritos são runtime-aware.
5. Turnos ACP fazem streaming de texto, thought, áudio/resource, tools, uso e erro
   para a UI existente, incluindo pipeline persistente de conteúdo não textual.
6. Todos os métodos e updates estáveis anunciados têm handler e fixture de
   conformidade. Capacidade opcional só pode degradar se **não for anunciada**;
   método baseline ausente é falha de release.
7. O transcript local sobrevive a restart. Quando `resume`/`load` é anunciado, a
   sessão ACP também sobrevive, com message map e fronteira de replay sem
   duplicação; caso contrário, o fluxo explícito de nova sessão/histórico é usado.
8. Cancelamento e shutdown encerram o processo e a árvore; parcial é persistido e
   órfãos são reaping seguro por identidade.
9. Workspace diff/revert funciona para mudanças observadas e limita arquivos
   grandes/binary/concorrentes sem falsa atribuição.
10. Custo ACP cumulativo/moeda não é double-counted; usage de contexto não vira
    token cobrado.
11. Nenhum arquivo de provedor HTTP, catálogo ou OAuth é alterado.
12. Todos os testes nativos continuam passando; nenhuma falha nova além do
    baseline registrado.
13. Rotinas/canais/inbox/tasks usam o dispatcher; tasks/líder ACP só são habilitados
    com as tools de colaboração correspondentes.
14. Regenerate/edit/truncate/retry ACP têm semântica própria e confirmação de risco
    após prompt ambíguo.
15. Conteúdo ACP usa o modo seguro; Markdown remoto/ativo não roda sozinho.
16. Documentação, i18n e evidência de verificação estão completas.
17. Todo spawn ACP exige consentimento backend persistido e vinculado ao digest da
    versão/launch; IPC direto não contorna isso.
18. Contratos Rust↔TypeScript (incluindo `RuntimeSelection`) têm round-trip e schema
    fixture; regenerar/editar/truncar usam nova sessão + contexto consentido.
19. Roots filhas não ampliam autoridade; budget ACP vale para todos os callers e
    falha fechado quando custo é desconhecido sob limite.

## 15. Riscos e mitigação

| Risco | Mitigação |
| --- | --- |
| Agente malicioso ignora permissão | Aviso claro, consentimento, default Review, sem promessa de sandbox |
| Binário sem checksum | TOFU explícito, HTTPS fixo, hash local pinado, segunda confirmação |
| `.cmd`/shell injection no Windows | Invocar Node/uv/binário diretamente; launcher Windows testado |
| Processo filho órfão | Job Object/process group + kill de árvore + cleanup no boot |
| Prompt duplicado após queda | Não reenviar prompt v1 sem confirmação; marcar sessão perdida |
| Replay duplica mensagens | DB como fonte de exibição; reconciliação por ID e snapshot |
| Agente exige auth | Fluxo agent/terminal integrado; status persistido sem token |
| Capacidade ausente | Anunciar somente o implementado; degradar com copy específica |
| Uso/custo não reportado | Mostrar `—`; não inventar tokens, cache ou preço |
| Runtime ACP quebra features internas | Matriz explícita; `/goal`, completion gate e fallback desativados |
| Mudança de versão invalida resume | Fingerprint de versão/config; load ou nova sessão explícita |
| Baseline de testes vermelho | Corrigir antes ou registrar lista exata; gate de não regressão |
| Gate duplo/self-deadlock | Um único dono por runtime; teste com writer pendente |
| IPC contorna consentimento | Consentimento persistido e `require_consent` em todo spawn |
| Schema de Registry errado | Validar wrapper e entrada separadamente com snapshot real |
| Registry muda formato | Schema versionado, validação estrita e cache último bom |
| Agente Registry só fala v2 | Marcado incompatível até o adapter v2; nunca finge fallback |
| `npx`/`uv` indisponível | Detecção e orientação; sem instalador automático silencioso |
| Conteúdo do agente perigoso | Markdown sanitizado, sem HTML ativo, URI com ação do usuário |

## 16. Fora de escopo desta entrega

- ACP v2 estável (hoje Preview).
- Transporte remoto Streamable HTTP/WebSocket ACP.
- Sandbox de SO para o processo ACP.
- Instalação automática de Node/Python/uv.
- Telemetria de prompts ou credenciais.
- Controle de cliente sobre subagents ACP (ACP v1 não permite prompt/config neles).
- `/goal`, completion gate e fallback HTTP dentro de uma sessão ACP.
- Sincronização de histórico ACP entre dois clientes simultâneos.

## 17. Rollout e rollback

### Rollout

1. Entregar todas as fases atrás de `acp_enabled=false`.
2. Habilitar em build beta com agentes fake e Registry real.
3. Rodar matriz ao vivo e corrigir não conformidades.
4. Habilitar por padrão na release estável.

### Rollback

- Desligar `acp_enabled`: sessões ACP ficam bloqueadas com `ACP_DISABLED`.
- Remover instalação é recusado com sessão ativa; após encerrar, preserva
  conversas e metadados.
- Migrações são aditivas; banco continua abrindo sem ACP.
- Reverter commits não altera dados dos provedores atuais.
- Export de persona v2 inclui `acpAgentId` opcional; import sem agente instalado
  marca runtime indisponível e exige escolha explícita. Export de conversa mostra
  agente/modelo ACP, não o par nativo auxiliar. Versões antigas podem
  descartar o campo; a UI avisa antes de exportar.
- Downgrade para versão sem ACP: `provider_id/model_id` nativos permanecem válidos;
  a versão antiga ignora `agent_kind` e trata a conversa como nativa. A UI de
  exportação/downgrade mostra esse risco explicitamente.

## 18. Checklist de revisão do plano

- [x] ACP tratado como runtime, não adaptador HTTP.
- [x] Registry oficial e schema usados como fonte.
- [x] v1 estável escolhido; v2 Preview adiado.
- [x] Instalação cobre binário, npx e uvx.
- [x] Checksum opcional tratado explicitamente.
- [x] Autenticação agent/terminal/logout coberta.
- [x] Sessão new/load/resume/close/list/delete coberta.
- [x] Streaming, tools, permissões, fs e terminal cobertos.
- [x] Elicitation, config, comandos, notices, compaction e subagents cobertos.
- [x] Cancelamento, crash, retry e shutdown cobertos.
- [x] Chat, Code e Agentes integrados.
- [x] Segurança e privacidade detalhadas.
- [x] Provedores atuais isolados e testes de não regressão definidos.
- [x] Fases, donos, dependências e critérios de aceite definidos.
- [x] Baseline vermelho registrado sem ser confundido com ACP.
- [x] Rollout e rollback definidos.
