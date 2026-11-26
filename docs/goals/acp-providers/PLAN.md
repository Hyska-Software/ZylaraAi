# Provedores via ACP (Agent Client Protocol) — planejamento completo

**Status:** proposta completa para revisão (sem código implementado neste documento).
**Data:** 2026-11-25.
**Objetivo:** adicionar suporte completo a provedores que falam ACP — em especial os agentes do
[ACP Registry](https://agentclientprotocol.com/get-started/registry) — **além** dos quatro
protocolos HTTP atuais, com integração total no app (Chat, Code, Agentes, Configurações,
seletor de modelo, persistência, eventos, aprovações), sem alterar o comportamento dos
provedores existentes.

**Contrato de versão:** ACP **v1 estável** é o contrato primário (é a única versão estável do
protocolo em 2026-11-25). O cliente também negocia **v2 Preview** quando o agente o exige, com
o subconjunto de capacidades que a v2 define (§2.4). Nada depende de features `unstable_*` do
SDK para o caminho v1.

---

## 0. Resumo executivo

| Item | Decisão |
| --- | --- |
| O que é um "provedor ACP" | Um agente externo instalado a partir do Registry (ou adicionado manualmente) que roda como subprocesso e fala JSON-RPC over stdio. Ele aparece como **mais um provedor no seletor único existente** (`ModelPill`/`ModelPickerDialog`), com modelos descobertos via `configOptions`. **Nenhum seletor ACP separado.** |
| Onde o código entra | Novo módulo `src-tauri/src/acp/**`; uma única branch de transporte em `providers::stream_one` (`providers/mod.rs:1367`) + um discriminador `transport` em `ProviderInfo`. O loop do harness, `TurnEvent`, SQLite de mensagens e o renderer **não** são reescritos. |
| Como o agente é executado | Processo próprio por conversa, spawn pelo `Command` endurecido já existente (`workspace::exec::run` / `process_env`), transporte `ByteStreams` do SDK oficial `agent-client-protocol` 5.x; cancel = `session/cancel` → Job Object / kill tree. |
| Registro de modelos | Não entram em `data/catalog.json`. São descobertos em `session/new` (`configOptions` com `category: "model"`) e cacheados no SQLite, como os modelos dinâmicos de conta. |
| Ferramentas e permissões | O agente executa as **próprias** ferramentas; Zylara projeta `session/update` em eventos existentes e responde `session/request_permission` pelo `ApprovalRegistry` + `policy::decide`. Servidores MCP do app podem ser passados em `session/new`; `fs/*` e `terminal/*` só são anunciados com confiança explícita do agente. |
| Segurança | Instalação verificada (sha256, zip-slip, limites), agente instalado confiável com capacidades ativadas por padrão (reverse opt-out), segredos apenas no backend, conteúdo do agente tratado como não confiável. |
| Compatibilidade | Todo campo novo com `#[serde(default)]`; id `acp__<registry-id>` separado de `custom__`/`plugin__`; provedores HTTP seguem exatamente o caminho atual. |

vê o catálogo oficial, instala um agente com um clique, autentica (quando o agente pede), escolhe o
agente e seus modelos **no mesmo seletor** de Chat/Code/Agentes — o mesmo usado hoje para
Go/Zen/OpenAI/Anthropic —, envia mensagens com streaming de texto,
raciocínio, ferramentas, plano, uso e aprovações — e os provedores Go/Zen/OpenAI/Anthropic
continuam idênticos.

---

## 1. Estado atual — evidências do repositório

### 1.1 Provedores hoje são HTTP por construção

| Camada | Evidência | Estado |
| --- | --- | --- |
| Catálogo | `src-tauri/src/catalog.rs:11-17` `CatalogFile`; `:23-71` `ProviderInfo` (sem campo de transporte); `:145-211` `ModelInfo.protocols`; `:285-301` `load/provider/model`. `data/catalog.json` é embutido por `include_str!` (`:9`). | Nenhum provedor ACP. |
| Mesclagem | `src-tauri/src/state.rs:343-351` `catalog_with_plugins()` = bundle + plugins + `custom::list`; `:364-370` `provider()`; `:374-419` `models()/model()`. | Ponto natural de entrada de uma 4ª origem. |
| Comandos | `src-tauri/src/commands/models.rs:631-643` `catalog_view`; `:674-725` refresh/remote models; `src-tauri/src/commands/settings.rs:112-130` `set_provider_key`; `:424-552` `validate_provider` (HTTP GET p/ `endpoints["models"]`). | Validação, refresh e chave são HTTP-only. |
| Custom | `src-tauri/src/providers/custom.rs:18-93` (`ID_PREFIX = "custom__"`, limites, `CustomProviderInput`); `:97-180` save; `:250-347` conversão/validação força `openai-chat` + `/models` e exige HTTPS. | Não serve para ACP (base URL não existe). |
| Wire | `src-tauri/src/providers/mod.rs:37-65` `WireProtocol` fechado (4 variantes); `:172-257` `ProviderConfig` com `base_url/endpoints`; `:1306-1378` `stream_completion`/`stream_one`. | Branch de transporte não existe. |
| Renderer | `src/lib/types.ts:11,98-169`; `src/lib/catalog.ts:24-31` `CURATED_PROVIDER_IDS`; `src/lib/modelMenu.ts:61-88` `selectorProviders`; `src/lib/store/appStore.ts:137-186,219-241,291-354`; `src/components/settings/ProvidersTab.tsx:372-418,565-579,1360-1454`; `CustomProviderDialog.tsx` (OpenAI-chat only). | Nenhuma noção de agente/subprocesso. |
| Reservas já no código | `src-tauri/src/domain.rs:63` `conversations.agent_kind` ("lumina hoje; `acp:<agente>` no futuro"); `src-tauri/src/db.rs:418`; `src/lib/types.ts:1762`; diretórios vazios `src-tauri/src/acp/runtime/`, `src-tauri/src/acp/testdata/`. | Porta já aberta; sem implementação. |
| Pesquisa prévia | `docs/research/paseo-workbench.md:122-127` descreve exatamente o modelo "ACP (catálogo) → adaptador genérico + adição manual"; `docs/research/workspace-runtime-options.md:164-166` recomenda **não** escrever JSON-RPC à mão e compartilhar `ProcessRunner`; `docs/goals/code-harness/GOAL.md:61` P8 (`agentKind = acp:<agente>`). | Direção já validada internamente. |

### 1.2 Fluxo de um turno (por onde o ACP entra)

`chatStore.startTurn` (`src/lib/store/chatStore.ts:1840-1878`) → `api.runTurn` (`src/lib/api.ts:1002`)
→ `commands::turn::run_turn` (`src-tauri/src/commands/turn.rs:47-125`) → `harness::run_turn`
(`src-tauri/src/harness/mod.rs:1850`) → `resolve_turn_route` (`:5852`) →
`run_step_with_retry` (`:769`) → `run_stream_attempt` (`:621`) → `run_provider_stream` (`:926`)
→ `providers::stream_completion` (`providers/mod.rs:1306`) → `stream_one` (`:1367`) → um dos 4
adaptadores HTTP.

`run_stream_attempt` converte `ProviderEvent` (`providers/mod.rs:376-409`) em `TurnEvent`
(`src-tauri/src/events.rs:18+`); `PersistingEmitter` (`commands/turn.rs:17-45`) grava em
`turn_events` e emite `zylara:turn-event`; `App.tsx:444-457` → `chatStore.handleTurnEvent`
(`:3255`) → `applyEnvelope` por `seq` (`:1590`). Tudo isso é **agnóstico ao protocolo**: basta o
novo transporte emitir os mesmos eventos.

Seams úteis já existentes: `HarnessDeps.streamer` (`harness/mod.rs:93-95`, `:926-935`) permite
injetar um transporte em testes sem tocar na produção.

### 1.3 Processo / stdio existentes (reuso obrigatório)

| Recurso | Onde | Reuso no ACP |
| --- | --- | --- |
| Cliente JSON-RPC stdio | `src-tauri/src/mcp/mod.rs:31-33,138-146,163-323` — spawn, writer, reader, correlação `id → oneshot`, timeout, `FAKE_SERVER` em `:514-569`. | Referência de implementação; **não** usar diretamente: é privado, MCP-hardcoded, não responde requests initiated pelo servidor e não drena `pending` no EOF. |
| Runner endurecido | `src-tauri/src/workspace/exec.rs:183-228` (`run`), `:300-328` (`sanitized_env`), `:540` (`resolve_program`), `:770-841` (Job Object + `kill_process_tree`). | Spawn do agente ACP, env limpo, teto de saída, cancelamento e morte de árvore no Windows. |
| Confinamento de caminhos | `src-tauri/src/workspace/safe_path.rs:60-201` (`resolve`, `is_within`, `to_relative`); `workspace/access.rs:20-84` (lock cancelável por operação). | Implementar `fs/read_text_file`, `fs/write_text_file` e validar `cwd`/`additionalDirectories`. |
| Política e aprovação | `src-tauri/src/policy/mod.rs:28-170` (`decide`), `policy/approval.rs:21-245` (`ApprovalRegistry`, `request_interactive_until_decided`). | Responder `session/request_permission` e `elicitation/create` com a mesma UX de gate do Code. |
| PTY / terminal | `src-tauri/src/terminal/mod.rs:103-197,332-464,508-599` + `terminal/env.rs:12-120`. | Auth `type: "terminal"` (login interativo do agente) e, se habilitado, `terminal/*` do ACP v1. |
| Registries em `AppState` | `src-tauri/src/state.rs:221-290` (approvals, jobs, mcp, terminals); `lib.rs:78-92,559-579` (shutdown). | Adicionar `AcpManager` ao mesmo ciclo de vida (`close_all` no exit). |
| ZIP / hash | `zip = "9"`, `sha2 = "0.11"`, `flate2` transitivo em `src-tauri/Cargo.lock`. | Instalador de arquivos do Registry (adicionar `tar` + `flate2` diretos para `.tar.gz`). |

### 1.4 Fatos do ACP Registry (verificados hoje)

- Endpoint oficial: `GET https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  → `{ "version": "1.0.0", "agents": [...] }`.
- Snapshot consultado em 2026-11-25: **46 agentes**; distribuição: **24 `binary`**, **23 `npx`**,
  **2 `uvx`** (alguns com mais de uma); plataformas binárias incluem `windows-x86_64` (22),
  `windows-aarch64` (11), `darwin-*`, `linux-*` e variantes `musl`.
- Campos presentes em todos os agentes: `id`, `name`, `version`, `description`, `authors`,
  `license`, `license_url`, `distribution`, `icon`. Opcionais: `repository` (36), `website` (39).
- `distribution.binary.<os-arch>` = `{ archive, sha256?, cmd, args?, env? }`;
  `distribution.npx|uvx` = `{ package, args?, env? }`. O schema do manifesto exige ao menos
  uma distribuição e que um agente anuncie ao menos um método de autenticação no `initialize`.
- Ícones são SVGs servidos pelo CDN (16×16, monochrome `currentColor`) — **nunca** injetar SVG
  remoto direto na webview (§7).

---

## 2. Contrato ACP adotado (fontes oficiais)

### 2.1 Registry

Fonte: `https://agentclientprotocol.com/get-started/registry` e
`https://agentclientprotocol.com/rfds/acp-agent-registry.md`.

- `id`: `^[a-z][a-z0-9-]*$` — usado como diretório e como sufixo do provider id (`acp__<id>`).
- `version`: semver da release; usada como chave de instalação e para detectar upgrade.
- `distribution`: `binary` (por target, com `archive`, `cmd`, `args`, `env`, `sha256`), `npx`,
  `uvx`. Clientes buscam `registry.json` e filtram localmente.
- O Registry é **curado**, mas os binários são de terceiros e rodam com os privilégios do
  usuário: curadoria ≠ sandbox (§7).

### 2.2 Protocolo v1 — baseline estável

Fonte: `https://agentclientprotocol.com/protocol/v1/*` (overview, initialization,
authentication, session-setup, prompt-turn, content, tool-calls, file-system, terminals,
session-config-options, session-modes, elicitation, cancellation, error, security).

Ciclo: `initialize` → (auth) → `session/new` (ou `session/load`/`session/resume`) →
`session/prompt` → `session/update`* → resposta com `stopReason`.

- Transporte: JSON-RPC 2.0, UTF-8, **uma mensagem por linha**, stdin/stdout; stderr é log.
- `initialize`: cliente envia `protocolVersion: 1`, `clientCapabilities` e `clientInfo`; agente
  responde `protocolVersion`, `agentCapabilities`, `authMethods`, `agentInfo`.
- Auth: método `agent` → `authenticate { methodId }`; método `terminal` → relançar o mesmo
  programa com `args`/`env` extras em terminal interativo, esperar exit 0, reconectar; `logout`
  condicionado a `agentCapabilities.auth.logout`.
- `session/new { cwd, mcpServers, additionalDirectories?, systemPrompt? }` → `sessionId`,
  opcionalmente `modes` e `configOptions`.
- `session/prompt { sessionId, prompt: ContentBlock[] }`; `ContentBlock` = `text`, `image`,
  `audio`, `resource`, `resource_link`; capacidades `image`/`audio`/`embeddedContext` são
  negociadas; `text` + `resource_link` são baseline.
- `session/update` cobre: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`,
  `config_option_update`, `session_info_update`, `usage_update`, `notice`,
  `compaction_update`, `compaction_summary_chunk`, `subagent_update`, mensagens entre sessões.
- `session/request_permission` é **request do agente ao cliente** com `options` (`allow_once`,
  `allow_always`, `reject_once`, `reject_always`); cliente responde `selected` ou `cancelled`.
- `session/cancel` (notification) + `$/cancel_request`; cliente **deve** responder requests de
  permissão pendentes com `cancelled`.
- `StopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- Erros ACP: `-32000 auth_required`, `-32002 resource not found`, `-32800 cancelled`,
  `-32601 method not found`, etc.
- Cliente pode oferecer `fs/read_text_file`, `fs/write_text_file`, `terminal/*`,
  `elicitation/create` — **todos** dependem de capacidades anunciadas no initialize.
- Segurança: agente não é sandboxed pelo protocolo; toda string/URI/caminho do agente é
  não confiável; permissões são consultivas — o cliente aplica as próprias checagens em
  `fs/*` e `terminal/*`; nunca seguir `file:` fora do root set nem buscar URIs remotas sem ação
  do usuário; não colocar credenciais em `_meta`.

### 2.3 Diferenças v2 relevantes (Preview)

Fonte: `https://agentclientprotocol.com/protocol/v2/migration.md`.

- `session/prompt` apenas **acknowledita**; conclusão e `stopReason` vêm em `state_update`.
- `initialize` usa `capabilities`/`info` (em vez de `clientCapabilities`/`clientInfo`); markers
  são objetos `{}`, não booleanos.
- `auth/login`/`auth/logout`; `session/load` removido (usar `session/resume` com `replayFrom`);
  `session/list` e `session/close` são obrigatórios; `session/set_mode` removido.
- `fs/*` e `terminal/*` do cliente **removidos**; `tool_call` vira `tool_call_update` upsert;
  planos, notas e compactação não precisam mais de capacidade do cliente.
- Um agente v1 pode responder `protocolVersion: 1` a um cliente que pediu 2; um agente
  v2-only responde erro `-32022`. **Plano:** pedir v1 primeiro; se o agente exigir v2, abrir
  conexão v2 separada com capabilities reduzidas (§5.9).

### 2.4 SDK oficial

`agent-client-protocol` **5.6.1** (crates.io, 2026-11-25; `rust_version = 1.88.0`, edition 2024)
— compatível com o `rust-version = 1.89` do app. Fornece `Client.v1()` / `Client.v2()`,
`AcpAgent`, `AcpAgentConfig` (feature `process`), `ByteStreams::new(outgoing: AsyncWrite,
incoming: AsyncRead)` sobre newline-delimited JSON, `connect_with`, `SessionBuilder`, handlers
de `RequestPermissionRequest`, correlação de requests e `RequestCancellationHandle`.

**Decisão:** usar o SDK (não reescrever JSON-RPC). O spawn continua sendo feito pelo `Command`
endurecido do app — os pipes são entregues ao `ByteStreams` via `tokio_util::compat`
(`TokioAsyncReadCompatExt`/`TokioAsyncWriteCompatExt`; `tokio-util` já é dependência, falta a
feature `compat`). Assim o app mantém Job Object, env saneado, limites e cancelamento por árvore
sem reimplementar transporte.
Dependências: `agent-client-protocol = { version = "=5.6.1", features = ["unstable_protocol_v2"] }`
(o feature só habilita o caminho v2 de D11; o caminho v1 não usa nenhum `unstable_*`),
`tokio-util` ganha a feature `compat`, e `tar` + `flate2` entram como dependências diretas para
extrair `.tar.gz`. Features `process`/`stdio` do SDK **não** são habilitadas: o spawn é do app.
Qualquer upgrade do SDK passa por `cargo check` antes de mexer no `rust-version`.

---

## 3. Decisões de arquitetura

### D1 — ACP como transporte dentro do adaptador, não como segundo harness

`stream_one` (`providers/mod.rs:1367`) ganha o arm `WireProtocol::Acp`, com
`as_str() = "acp"` e `parse("acp")`. O adaptador `acp::stream(&CompletionRequest, &EventSink)`
emite `ProviderEvent`; `run_stream_attempt` (`:621`), o loop de tools, a persistência e o
renderer permanecem os mesmos.

*Rejeitado:* branch cedo em `harness::run_turn` (`~:2038`) com `harness::acp::run_turn`
duplicando eventos e persistência — mais código, mais risco de divergência de `TurnEvent` e
do journal `turn_events`. As únicas exceções ao "nenhuma mudança no harness" são o resolve de rota
(§5.5) e os novos braços de `ProviderEvent` em `run_stream_attempt` (§5.7), todos aditivos.

### D2 — Agente é dono do turno; Zylara é cliente ACP, não reexecuta as tools dele

O agente executa suas próprias ferramentas e reporta `tool_call`/`tool_call_update`. O adaptador
projeta isso em `ProviderEvent::ToolCallStart/ArgsDelta/Done` **para a UI**, mas **não** devolve
tool calls ao harness para execução local (isso duplicaria ações). Para que o harness não tente
um "wrap-up" forçado, o último passo ACP só emite `Done` quando o agente respondeu `session/prompt`
com `stopReason`.
O harness pode decidir mais de um passo por turno (completion gate do Code, resposta forçada).
Cada passo vira um `session/prompt` adicional **na mesma sessão ACP**, sempre com a última
mensagem de usuário do `CompletionRequest.history` daquele passo — nunca com o histórico inteiro.

Zylara oferece suas ferramentas ao agente como **servidor MCP client-provided** em
`session/new.mcpServers`, filtrado por capabilities da persona e aprovado pelo usuário (§5.8).
É a ponte documentada pelo próprio ACP ("Clients MAY use this ability to provide tools directly
to the underlying language model").

### D3 — Configuração e modelos via `configOptions`, não via catálogo estático

`data/catalog.json` **não** ganha agentes ACP: eles são instalados/desinstalados em runtime.
Modelos vêm de `configOptions` com `category: "model"` no `session/new` (ou `session/load`),
são cacheados na tabela `acp_models` e mesclados em `catalogView.catalog.providers[].models`
como `ModelInfo` com `protocols: ["acp"]`. É essa fusão que alimenta o seletor existente —
nenhum componente de seleção é criado. Antes de `session/prompt`, o adaptador chama
`session/set_config_option { configId, value }` com o `model_id` escolhido nesse mesmo seletor.
Se o agente não expor `configOptions`, o provedor ACP contribui com uma única entrada
"Padrão do agente" dentro do seletor comum e nenhum `session/set_config_option` é enviado.

### D4 — Um processo por conversa, com pool limitado e TTL

Cada `(conversation_id, provider_id)` mantém um processo ACP com uma sessão ativa: isolamento
de cancelamento, de cwd e de estado, alinhado com a barreira por conversa já existente
(`register_turn_if_idle`). Limites: máximo global de processos (padrão 8) e TTL ocioso
(padrão 10 min); ao exceder, fecha a sessão (`session/close` se suportado) e mata a árvore.
Um mesmo agente pode ter várias sessões em paralelo — o protocolo suporta, e o app já permite
N turnos paralelos por conversas distintas.

### D5 — Histórico pertence à sessão ACP

O `CompletionRequest.history` do harness é montado para protocolos HTTP (cada turno reenvia
tudo). Para ACP, o adaptador envia em `session/prompt` **apenas a última mensagem do usuário**
(texto + anexos convertidos em `image`/`resource`, respeitando `promptCapabilities`).

- Sessão existente (resume/load): sem replay — o agente já tem o histórico.
- Sessão nova: se o agente não suporta `session/load`/`session/resume`, abrir nova sessão e
  enviar **um bloco de contexto** com resumo compacto do histórico do SQLite (limite 8 KiB,
  explicitamente rotulado "Contexto da conversa anterior"), com aviso honesto na UI de que a
  memória/detalhes anteriores do agente não são preservados. Nunca reenviar `provider_state`
  de outro protocolo.

### D6 — Namespace, transport e compatibilidade de serialização

- Novo id: `acp__<registry-id>` (slug validado pelo regex do Registry); namespaces `custom__`,
  `plugin__`, `acp__` são disjuntos.
- `ProviderInfo.transport: ProviderTransport { Http (default), Acp }`, `#[serde(default)]`.
  `data/catalog.json`, linhas de `custom_providers` e manifests de plugin continuam parses.
- `ModelInfo.protocols = ["acp"]` para modelos ACP; `ProviderInfo.endpoints` fica vazio para
  eles — `ProviderConfig::endpoint_for` nunca é chamada nesse caminho.
- `ProviderAuth` ganha variante `Acp` com `#[serde(default)]` (default continua `ApiKey`).

### D7 — Auth do agente, não API key do app

Credenciais ACP ficam no próprio agente. `resolve_credential` (`harness/mod.rs:301`) recebe um
atalho para `transport == Acp`: `Credential::None`, sem exigir `api_key`. O estado de auth vem do
`initialize` (`authMethods`) e de um probe `session/new`; mapeado para `ProviderAuthStatus` com
`mode: "acp"`. `set_provider_key` permanece HTTP-only (chave de API do provedor ACP, quando o
agente precisar de uma, é enviada como variável de ambiente **nomeada pelo usuário** e guardada
em `secrets.json`, nunca em `settings.json`/`CatalogView`).

### D8 — Instalação com verificação, mas sem autoexecução silenciosa

Binários: baixar HTTPS → validar `version`/`id`/target → exigir `sha256` **quando presente** →
extrair com proteção contra zip-slip/ADS/symlink → gravar em `<data>/acp/agents/<id>/<version>/`
de forma atômica → gravar `acp_agents`. `npx`/`uvx`: sem download próprio; verificar
`node`/`uv` no PATH, mostrar **comando exato + args + nomes de env** e exigir consentimento
antes do primeiro launch (o pacote é buscado pelo gerenciador na primeira execução).

### D9 — Confiança explícita por agente

Agentes instalados passam a nascer confiáveis, com `fs/*`, `terminal/*` e `elicitation` ativados
(decisão revisada em 2026-11-25 a pedido do usuário). O consentimento do comando/args/env na
instalação continua obrigatório e o painel permite desativar cada capacidade individualmente.
`fs/*`, `terminal/*` e `elicitation` só são anunciados no `initialize` quando `trusted = 1` **e**
a capacidade correspondente está marcada para aquele agente.

### D10 — Erros e cancelamento mapeados para a taxonomia existente

`auth_required` → `ProviderError::AuthRequired` (com retry único após auth, análogo ao refresh
OAuth do harness); `-32800` / `stopReason: cancelled` → `Cancelled`; `max_tokens` /
`max_turn_requests` / `refusal` → `Done` com aviso; `-32601` / `-32602` →
`UnsupportedCapability`/`BadRequest`; falha de transporte → `Network`/`Timeout`. `session/cancel`
é enviado no `CancellationToken` do turno; se o agente não responder em 3 s, matar a árvore.

### D11 — v2 Preview como capacidade negociada, não como way of life

O `AcpManager` tenta v1; se o agente responder `-32022` ou `protocolVersion: 2`, abre uma
conexão v2 via `Client.v2()` com capabilities reduzidas (sem `fs/*`/`terminal/*`), mapeando
`state_update` para os mesmos `ProviderEvent`. Agentes que não aceitam nenhuma das versões
aparecem como incompatíveis com motivo explícito — nunca como "erro genérico".

### D12 — Documentação e i18n desde o primeiro phase

Novas chaves em `src/locales/{en,pt-BR,es}/settings.json` (inglês = origem), textos de erro no
backend via `t` (`src-tauri/src/i18n.rs` + `src-tauri/locales/*.json`), e `pnpm i18n:check` no
critério de pronto. Nenhum texto de UI hardcoded.

### D13 — Um único seletor para todos os provedores

O seletor existente é composto por `src/components/models/ModelPill.tsx` (pill do composer) e
`ModelPickerDialog.tsx`, ambos alimentados pelas funções puras de `src/lib/modelMenu.ts`
(`selectorProviders`, `modelKey`, `selectionKey`). A integração ACP acontece **nos dados**:
`catalog_view` devolve os agentes como `ProviderInfo` com `transport: "acp"` e os modelos de
`acp_models` dentro de `models`, exatamente como acontecem custom/plugin/modelos de conta.
`ModelPill`, `ModelPickerDialog`, `ModelTab` (Configurações) e o editor de persona leem a
mesma lista e o mesmo par `providerId/modelId`. Não há novo dialog, novo tab, novo `<select>`
nem novo estado de seleção: `ModelSelection` já é a chave (`providerId:modelId`) usada em todo
o app, inclusive no congelamento por conversa e na troca entre turnos do Code.

---

## 4. Modelo de dados e layout de arquivos

### 4.1 Novas tabelas SQLite (migração aditiva em `db.rs`, padrão `IF NOT EXISTS` + `ensure_column`)

```sql
-- Catálogo local de agentes instalados (uma linha por id do Registry ou entrada manual)
CREATE TABLE IF NOT EXISTS acp_agents (
  id TEXT PRIMARY KEY,                  -- acp__<registry-id> ou acp__manual__<slug>
  registry_id TEXT,                     -- null para manual
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  homepage TEXT, repository TEXT, license TEXT,
  icon_path TEXT,                       -- SVG validado, copiado para app-data
  kind TEXT NOT NULL,                   -- 'binary' | 'npx' | 'uvx' | 'manual'
  command TEXT NOT NULL,                -- caminho absoluto do binário / 'npx' / 'uvx' / exe manual
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}',  -- nomes/valores não-secretos; segredos ficam em secrets.json
  env_secret_names_json TEXT NOT NULL DEFAULT '[]',
  install_dir TEXT,                     -- binary: caminho absoluto sob <data>/acp/agents/
  sha256 TEXT,
  trusted INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_fs INTEGER NOT NULL DEFAULT 0,
  supports_terminal INTEGER NOT NULL DEFAULT 0,
  supports_elicitation INTEGER NOT NULL DEFAULT 0,
  auth_state TEXT NOT NULL DEFAULT 'unknown', -- unknown|ready|auth_required|error
  auth_hint TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Sessão ACP por conversa/provedor (o sessionId é opaco e pertence ao agente)
CREATE TABLE IF NOT EXISTS acp_sessions (
  conversation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  config_state_json TEXT NOT NULL DEFAULT '{}', -- valores de configOptions já aplicados
  capabilities_json TEXT NOT NULL DEFAULT '{}', -- snapshot do initialize (comportamento estável)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, provider_id)
);

-- Modelos descobertos via configOptions (equivalente ao models-cache.json de conta)
CREATE TABLE IF NOT EXISTS acp_models (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '{}',
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

-- Cache do Registry (ETag + snapshot) e log de auditoria local
CREATE TABLE IF NOT EXISTS acp_registry_cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT, provider_id TEXT, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
```

`conversations.agent_kind` passa a aceitar `acp:<registry-id>` (além de `zylara`), sem mudar
o default. `agents.acp_agent_id` (nullable) permite fixar uma persona a um agente ACP; a rota
`providerId/modelId` da persona continua sendo editada **pelo mesmo seletor do composer** —
`acp_models` é apenas a fonte de `ProviderInfo.models`, não um seletor à parte. `reset_app_data`
(`commands/settings.rs:230-250`) apaga também as tabelas `acp_*` e o diretório `<data>/acp`.

### 4.2 Arquivos em app-data

```
<app-data>/acp/
  registry-cache.json        # snapshot local + ETag, renovado no máximo 1×/dia
  agents/<id>/<version>/     # binários extraídos (binary)
  icons/<id>.svg             # SVG validado (nunca iframe/import remoto)
  logs/<conversation>.log    # stderr do agente, limitado/rotacionado
```

### 4.3 Contratos IPC aditivos (`src-tauri/src/domain.rs`, espelhados em `src/lib/types.ts`)

```rust
#[serde(rename_all = "camelCase")]
struct AcpRegistryAgent {
    id: String, name: String, version: String, description: String,
    homepage: Option<String>, repository: Option<String>, license: Option<String>,
    icon_url: Option<String>,
    distributions: Vec<String>,        // ["binary","npx","uvx"]
    platforms: Vec<String>,            // targets disponíveis
    installed: bool, supported: bool,  // supported = target atual disponível
    install_reason: Option<String>,    // ex.: "requires-acp-v2", "no-windows-build"
}

#[serde(rename_all = "camelCase")]
struct AcpAgentView { /* espelho de acp_agents + auth_state + model_count */ }

#[serde(rename_all = "camelCase")]
struct AcpInstallRequest { registry_id: String, accept_command: bool } // consentimento explícito

#[serde(rename_all = "camelCase")]
struct AcpCustomAgentInput {
    name: String, command: String, args: Vec<String>,
    env: BTreeMap<String, String>, cwd: Option<String>,
}

#[serde(rename_all = "camelCase")]
struct AcpAuthView { agent_id: String, state: String, methods: Vec<AcpAuthMethod>, hint: Option<String> }

#[serde(rename_all = "camelCase")]
enum AcpAuthAction { Login { method_id: String }, TerminalLogin { method_id: String }, Logout }
```

Todos os comandos retornam `Result<T, String>`; nada de token cru, caminho de segredo ou `env`
com valor sensível cruza o IPC.

---

## 5. Backend — módulos, comandos e comportamento

### 5.1 Estrutura de módulos

```
src-tauri/src/acp/
  mod.rs          # reexports, AcpManager, constantes, erros
  registry.rs     # fetch/parse/validate/cache do registry.json + snapshot offline
  install.rs      # download, sha256, extração segura, npx/uvx, remoção, upgrade
  config.rs       # AcpAgentConfig -> ProviderInfo/ModelInfo, env, segredos
  client.rs       # spawn endurecido + SDK Client.v1()/v2() + handlers de requests
  session.rs      # estado da sessão (new/load/resume/close), registry, TTL, cancel
  mapping.rs      # ACP SessionUpdate/StopReason/Error -> ProviderEvent/ProviderError
  host.rs         # implementação do Client: permission, elicitation, fs, terminal, MCP
  commands.rs     # thin wrappers #[tauri::command] (ou em commands/acp.rs)
```

`mod acp;` entra em `src-tauri/src/lib.rs:14-43`. Nenhum módulo existente é renomeado.

### 5.2 Comandos Tauri (registrados em `lib.rs`)

| Comando | Assinatura (resumo) | Efeito |
| --- | --- | --- |
| `acp_list_registry` | `() -> Result<Vec<AcpRegistryAgent>, String>` | cache do Registry + merge com instalados; nunca lança processo. |
| `acp_refresh_registry` | `(force: bool) -> Result<Vec<AcpRegistryAgent>, String>` | refetch com ETag; fallback para cache/snapshot. |
| `acp_install_agent` | `(req: AcpInstallRequest) -> Result<AcpAgentView, String>` | verifica e instala; `accept_command` é o consentimento. |
| `acp_add_custom_agent` | `(input: AcpCustomAgentInput) -> Result<AcpAgentView, String>` | comando absoluto + args, sem Registry. |
| `acp_remove_agent` | `(agent_id: String) -> Result<(), String>` | remove sessões, binários e linha; preserva chaves de API. |
| `acp_set_trusted` | `(agent_id: String, trusted: bool, caps: AcpCapabilities) -> Result<AcpAgentView, String>` | gate de confiança + capacidades de cliente. |
| `acp_auth_status` | `(agent_id: String) -> Result<AcpAuthView, String>` | proba `initialize` (sem sessão de prompt). |
| `acp_auth` | `(agent_id: String, action: AcpAuthAction) -> Result<AcpAuthView, String>` | `authenticate`, terminal auth, `logout`. |
| `acp_test_agent` | `(agent_id: String) -> Result<ProviderValidation, String>` | handshake + `session/new` em tmp + contagem de modelos. |
| `acp_list_sessions` / `acp_close_session` | — | diagnóstico e limpeza (espelham `TerminalRegistry`). |
| `acp_stderr` | `(conversation_id: String) -> Result<String, String>` | trecho limitado do log para diagnóstico. |

### 5.3 Registry client (`registry.rs`)

1. `GET` com `User-Agent: Zylara/<versão>`, `If-None-Match` quando há ETag, timeout 20 s,
   `AppState.http`.
2. Validar `version` semver suportada (`1.x`), `agents[].id` pelo regex, `version` semver,
   `distribution` não vazio, `archive`/`cmd` presentes quando `binary`, `icon` apenas
   `https://cdn.agentclientprotocol.com/...` (§7). Rejeitar entradas inválidas **apenas
   individualmente** — uma entrada ruim não invalida o catálogo todo.
3. Selecionar target: `windows-x86_64`/`windows-aarch64` (cfg do build), `darwin-*`,
   `linux-*`; `musl` apenas quando detectado. Preferir `binary` do target; senão `npx`; senão
   `uvx`; senão `supported = false` com `install_reason`.
4. Persistir em `<data>/acp/registry-cache.json` (atômico) + `acp_registry_cache`; TTL 24 h;
   snapshot embarcado `data/acp-registry.json` (gerado por `scripts/build-acp-registry.mjs`,
   atualizado por `pnpm catalog:sync`) cobre o primeiro launch offline.
5. Testes: fixture real do Registry, ETag 304, JSON malformado, id inválido, entradas sem
   target, ícone hostil, preserve-último-cache-em-falha.

### 5.4 Instalador (`install.rs`)

- `binary`: `reqwest` → streaming para arquivo temporário → `sha256` comparado **antes** de
  extrair (sha2 já no `Cargo.toml`) → `zip` (já) ou `tar` + `flate2` (novos) → validação de
  cada entrada (sem `..`, absoluto, symlink, ADS, nomes reservados do Windows, colisão
  case-insensitive, tamanho descomprimido ≤ 512 MiB, ratio ≤ 200) → rename atômico para
  `<data>/acp/agents/<id>/<version>/`. Falha = rollback sem apagar versão anterior.
- Localizar `cmd` dentro do diretório extraído com `Path::join` + canonicalização + checagem de
  prefixo por componente (`dunce` já disponível). Nunca concatenar strings de path.
- `npx`/`uvx`: resolver executável com `workspace::exec::resolve_program`; não instalar nada
  automaticamente; guardar `package@version` e `args` exatamente como publicados; `env` do
  manifesto é exibido por nome e só aplicado após consentimento.
- Upgrade: nova `version` no Registry → status `update_available`; instalação só após confirmação;
  manter versão anterior até o rename final.
- Testes: download fake, hash errado, zip-slip, ADS, pacote npx inexistente, rollback.

### 5.5 Integração com catálogo e harness (pontos aditivos)

1. `catalog.rs`: `ProviderTransport` + `ProviderAuth::Acp` + campos ACP opcionais em
   `ProviderInfo`, todos `#[serde(default)]`. Teste existente de JSON legado
   (`catalog.rs:403-434`) continua verde.
2. `state.rs`: `catalog_with_plugins()` passa a incluir `acp::config::providers(&db)`;
   `provider()`/`model()` conhecem o namespace `acp__`; `models()` usa `acp_models` como
   fonte dinâmica; `AppState.acp: Arc<AcpManager>` entra em `init` e no shutdown.
3. `commands/models.rs:631-643`: `catalog_view` inclui auth statuses ACP; `:694-725`
   `refresh_catalog` **pula** provedores `transport == acp` (não têm `endpoints["models"]`);
   `list_remote_models` devolve erro explícito para ACP em vez de montar URL vazia.
4. `commands/settings.rs:112-130`: `set_provider_key` recusa `transport == acp` com código
   `ACP_AGENT_OWNED_AUTH`; `:424-552` `validate_provider` chama `acp_test_agent` quando aplicável.
5. `harness/mod.rs:271-296` `provider_config`: para ACP, preencher só `provider_id`,
   `provider_name`, `model`, `session_id` (chave de `acp_sessions`) e o descritor do agente;
   nunca chamar `endpoint_for`.
6. `harness/mod.rs:301-353` `resolve_credential`: atalho ACP (D7).
7. `harness/mod.rs:5852-5901` `resolve_turn_route`/`resolve_protocols`: aceitar `"acp"`;
   garantir que nenhum provider ACP herda protocolos HTTP de fallback.
8. `providers/mod.rs:37-65,1367-1378`: nova variante `Acp` e dispatch para
   `acp::client::stream`. Assinatura do adaptador espelha os outros quatro:
   `async fn stream(request: &CompletionRequest, sink: &EventSink) -> ProviderResult<()>`
   (sem `reqwest::Client`).

### 5.6 Ciclo de vida da sessão (`session.rs`)

```
route (provider_id acp__)
  → lookup acp_sessions(conversation_id, provider_id)
  → [nenhuma] spawn + initialize (+auth) + session/new(cwd, mcpServers, configOptions)
       → persistir session_id + capabilities + config_state
  → [existe]  session/resume (se sessionCapabilities.resume) | session/load (se loadSession)
       | nova sessão + bloco de contexto (D5)
  → session/set_config_option(model) se configOptions contém category=model
  → session/prompt(última mensagem do usuário + anexos permitidos)
  → loop de session/update -> ProviderEvent
  → resposta: stopReason -> Done | erro -> ProviderError (D10)
  → cancel: session/cancel + responder permissões pendentes como cancelled; timeout -> kill tree
```

`cwd` = workspace da conversa quando houver; senão o diretório interno
`<app-data>/agent-workspaces/<sha256>` (já usado por threads de agente, `docs/AGENTS.md:179`).
`additionalDirectories` só se `sessionCapabilities.additionalDirectories`. `systemPrompt` só se
`sessionCapabilities.systemPrompt` — usar `mode: "append"` com o prompt de persona; `override`
nunca é usado automaticamente (a doc exige responsabilidade total pelo comportamento do agente).

### 5.7 Mapeamento de eventos (`mapping.rs`)

| ACP `sessionUpdate` / sinal | `ProviderEvent` (harness) | `TurnEvent` final / UI |
| --- | --- | --- |
| `agent_message_chunk` (text) | `TextDelta` | `text_delta` → bolha em streaming |
| `agent_thought_chunk` | `ReasoningDelta` (fechamento em `Done`, como nos adaptadores atuais) | `reasoning_delta` / `reasoning_done` |
| `tool_call` | `ToolCallStart { index, id, name }` (+ `name` do `kind`) | `tool_call_started` |
| `tool_call_update` (args/.status/content/diff) | `ToolCallArgsDelta`, `ToolCallDone`, novo `ProviderEvent::ToolCallFinished { presentation }` | `tool_call_args`, `tool_call_finished` com presentation de diff |
| `usage_update` | `Usage(UsageInfo)` + `UsageRaw` | `usage` + medidor de contexto/custo |
| `plan` / `plan_update` / `plan_removed` | novo `ProviderEvent::Plan(Value)` | `plan_updated` (já existe no `TurnEvent`) |
| `compaction_update`/`_summary_chunk` | novo `ProviderEvent::Compaction(Value)` | `compacted` / `context_stats` |
| `notice` | novo `ProviderEvent::Notice { severity, title, description }` | toast/banner (sem conteúdo de histórico) |
| `available_commands_update` | `ProviderEvent::Meta(Value)` | chips de slash commands no composer |
| `config_option_update` (modelo) | `ProviderEvent::Meta(Value)` | atualizar a lista do **mesmo** seletor via `reloadCatalog()`; sem novo seletor no cabeçalho |
| `current_mode_update` | `ProviderEvent::Meta(Value)` | `profile_changed` quando mapeado ao modo de permissão |
| `session_info_update` | `ProviderEvent::Meta(Value)` | `title_updated` quando houver título |
| `subagent_update` / mensagens entre sessões | `ProviderEvent::Meta(Value)` | `subagent_started`/`subagent_event` (já existem) |
| `session/prompt` response | `Done` | `Done { result }` |

Novas variantes de `ProviderEvent` são **aditivas**: os quatro adaptadores atuais não as emitem;
`run_stream_attempt` (`harness/mod.rs:621-740`) ganha arms que as convertem nos `TurnEvent`
correspondentes. `ToolCallFinished` é necessário porque hoje `ToolCallDone` só atualiza o
acumulador local (`:695-701`) — sem ele, uma tool executada pelo agente ficaria "running" na UI.
`ProviderEvent::Meta` nunca carrega segredo nem `_meta` de autenticação.

**Regras de conteúdo não confiável:** texto do agente passa pelo mesmo sanitizador Markdown;
`resource_link.uri` e imagens com `uri` não são buscados automaticamente; diffs e comandos passam
pela neutralização de caracteres de controle/bidirecionais antes de virar UI; títulos de plano e
notices são texto simples.

### 5.8 Host de capacidades do cliente (`host.rs`)

| Request do agente | Implementação | Gate |
| --- | --- | --- |
| `session/request_permission` | `policy::decide` + `ApprovalRegistry::request_interactive_until_decided` (`policy/approval.rs:91-245`), emitindo `ApprovalRequested`/`Resolved`. Nunca aprovar só por `title`/`name`; escolher option por `kind`. | `permission_mode` da conversa; regras persistidas; `cancelled` no cancel do turno. |
| `elicitation/create` (form/url) | Novo diálogo no renderer via evento `question_requested` generalizado; validar schema raso; URL: mostrar host, exigir consentimento, abrir com `plugin-opener` sem prefetch. | `supports_elicitation` + `trusted`; nunca coletar segredos em form. |
| `fs/read_text_file` / `fs/write_text_file` | `workspace::safe_path::resolve` com root set da sessão (`cwd` + `additionalDirectories`); escrita passa por `policy::decide` + approvação + journal de arquivo. | `supports_fs` + trusted; negar fora do root; arquivos de execução/aprovação (hooks, settings, MCP config) exigem confirmação. |
| `terminal/create|output|wait_for_exit|kill|release` | Reaproveitar `TerminalRegistry`/`workspace::exec::run` com `sanitized_env`, cwd confinado, `outputByteLimit`, escape de sequências de controle na exibição. | `supports_terminal` + trusted + política sobre `command`, `args` **e** `env`. |
| `$/cancel_request` | Mapear para o `CancellationToken` da requisição correspondente; responder `-32800`. | — |

Se uma capacidade não foi anunciada, o agente não deve chamá-la; se chamar, responder
`-32601`/`-32602` e registrar em `acp_events` (sem quebrar o turno).

**MCP para o agente:** `session/new.mcpServers` recebe apenas os servidores já configurados e
aprovados no app, convertidos para `{name, command, args, env}` (stdio) ou `{type:"http",url,
headers}` quando `mcpCapabilities.http`. Nomes de segredo são resolvidos no backend a partir de
`secrets.json`. Nenhum servidor vindo de workspace/arquivo do agente é enviado sem aprovação
explícita do comando/args/env (§2.2).

### 5.9 v2 Preview (`client.rs`, `mapping.rs`)

- `initialize` com `protocolVersion: 1`; se erro `-32022` ou resposta `2`, reconectar via
  `Client.v2()` com `capabilities: {}` + `info` obrigatório.
- `state_update` (`running`/`idle`/`requires_action`/`unknown`) é o sinal de fim; `stopReason`
  vem daí. `tool_call_update` é upsert (omit = inalterado, `null = limpar`).
- Sem `fs/*` e `terminal/*`; notícias/compactação/subagentes viram baseline e usam o mesmo
  mapping da tabela. `session/resume` com `replayFrom: {type:"start"}` substitui `session/load`.
- Teste com agente fake v2 cobrindo aceitação, fim de turno por `idle` e erro `-32022`.

### 5.10 Auth (`client.rs` + `commands/acp.rs`)

1. Após `initialize`, se `authMethods` não vazio e `session/new` falhar com `-32000`:
   - método `agent` → `authenticate { methodId }`; sucesso = novo probe;
   - método `terminal` → `terminal_command(cwd, settings)` com `args`/`env` do descritor,
     `pwsh`/`powershell` no Windows, janela visível, esperar exit 0; reconectar. Respeitar a
     lista de variáveis proibidas da doc (PATH, LD_*, NODE_OPTIONS, HTTPS_PROXY, SSL_CERT_FILE…)
     sem aprovação; mostrar args/env antes de abrir.
   - `logout` só se `agentCapabilities.auth.logout` (v1) / `authMethods` não vazio (v2).
2. Nenhum token recebido pelo app é persistido: o agente guarda o próprio estado. O app guarda
   apenas `auth_state`/`auth_hint` e, se o usuário forneceu uma chave para `env`, ela vai em
   `secrets.json`.
3. UI espelha `ProviderAuthStatus`: `signed-in`, `signed-out`, `reauth-required`, bloqueios de
   plano — com CTA para o método adequado; nunca inventa percentual de cota.

### 5.11 Cancelamento e shutdown

- `CancellationToken` do turno é passado em `CompletionRequest.cancel`; o adaptador registra um
  `select!`: cancel → `session/cancel` (se sessão viva) → responder `-32800`/`cancelled` a
  permissões pendentes → esperar até 3 s pelo `session/prompt` → `session/close` (se suportado)
  → matar árvore (Job Object/`kill_process_tree`) → drenar stderr → fechar pipes.
- `AcpManager::close_all` no `RunEvent::Exit` e em `begin_graceful_exit` (`lib.rs:78-92,570-579`),
  junto com `terminals.close_all()`.
- Processos órfãos de versões antigas são mortos no boot (registro em `acp_events` + PID no
  arquivo de sessão em memória; sem confiar em PID persistido após reboot).

---

## 6. Renderer e UX

### 6.1 Configurações › Provedores

Nova seção **Agentes ACP** (ao lado de "Provedores populares"/"Ver mais provedores"):

- `AcpRegistryDialog`: lista do Registry com busca, filtro por distribuição/licença, badge
  "Instalado"/"Atualização disponível"/"Requer ACP v2"/"Sem build para Windows", ícone validado,
  link para `repository`/`website`, botão **Instalar**. O dialog mostra, antes de instalar,
  `name`, `version`, `license`, target, comando, args e **nomes** de env (`AcpInstallRequest.accept_command`).
- Linha do agente instalado: estado de auth, **Confiar**, **Testar conexão**, **Entrar**,
  **Sair**, **Remover**, **Atualizar catálogo** (modelos via `configOptions`).
- `AcpCustomAgentDialog`: comando absoluto + args + env + cwd opcional, com o mesmo aviso de
  confiança. `CustomProviderDialog` existente permanece HTTP-only (inalterado).
- `ProviderInfo.transport === 'acp'` troca o corpo de API key por um painel ACP;
  `rowStateOf` (`ProvidersTab.tsx:840`) ganha ramo ACP sem alterar os ramos OAuth/API key.

### 6.2 Seletor de modelo — integração, não um segundo seletor

O único seletor do app continua sendo `ModelPill` (no composer dos 3 layouts) + `ModelPickerDialog`
(busca/filtros), ambos derivados de `src/lib/modelMenu.ts:1-11`. ACP não cria outro:

- Backend: `catalog_view` (`commands/models.rs:631-643`) devolve cada agente instalado como
  `ProviderInfo { transport: "acp", models: <acp_models>, origin: "acp", icon: <svg local> }`.
  `state.models()` já mescla fontes dinâmicas; `acp_models` entra nessa mesma mesclagem.
- `src/lib/modelMenu.ts:73-95`: `selectorProviders` passa a considerar `transport === 'acp'`
  com `installed && auth_state !== 'error'` **na mesma condição** em que hoje considera
  `origin === 'custom'|plugin` ou credencial/account conectado. O provider ACP aparece nos
  tabs/grupos do `ModelPickerDialog` como qualquer outro, com seu ícone validado e o badge de
  auth apropriado — sem categoria exclusiva que o isole do resto.
- `selectionKey`/`modelKey` (`modelMenu.ts:40-57`) permanecem intactos: `acp__<id>:<model>` é
  só mais uma chave no mesmo mapa de seleção. Nenhum `ModelSelection` novo, nenhum store novo.
- `ModelTab.tsx:48-73`: a lista de providers/default model é a mesma `storeProviders`; removida
  a ideia de um `<select>` ACP separado. Trocar o modelo padrão de um agente ACP funciona como
  trocar o de qualquer provedor.
- Layout Agentes: o pill do composer já edita a rota da persona (`docs/AGENTS.md:65-68`);
  com `agents.acp_agent_id` ele apenas passa a apontar para o provider ACP. Sem segundo pill,
  sem "Modelo do agente" em outro lugar.
- Atualização dinâmica: quando o agente anuncia novos `configOptions`, o backend atualiza
  `acp_models` e o renderer chama `reloadCatalog()` (`appStore.ts:291-320`) — o mesmo caminho
  usado hoje após salvar um provider custom. A seleção corrente é preservada se o modelo
  continuar existindo; se desaparecer, cai no primeiro modelo do mesmo provider.
- reasoning/temperature: se o agente não expõe config option correspondente, os controles do
  composer ficam ocultos — nunca enviar parâmetro inventado.

### 6.3 Layout Agentes

- `conversations.agent_kind = 'acp:<id>'`: a thread mostra apenas um **selo informativo** do
  agente externo (e o estado de auth/permissões); modelo e modo continuam sendo escolhidos no
  seletor único existente e no chip de permissão, sem painel paralelo de "recursos do agente".
- `agents.acp_agent_id`: persona pode fixar um agente; instruções/memórias são enviadas via
  `systemPrompt` se suportado (`append`), senão como bloco de contexto no primeiro prompt — com
  aviso honesto na UI quando um recurso da persona não puder ser honrado.
- Routines/canais/tasks continuam usando o mesmo `run_turn`; nenhum comando novo é necessário.

### 6.4 Novas superfícies de interação

| Superfície | Evento | Componente |
| --- | --- | --- |
| Aprovação ACP | `approval_requested`/`resolved` (reuso) | cards existentes do Code, com `kind`, `locations` e diff completos |
| Elicitação form/url | `question_requested` estendido (`mode`, `schema`/`url`, `agent` ) | `ElicitationDialog` com revisão antes de enviar; URL mostra host + consentimento |
| Notice | `notice` (novo `TurnEvent`) | toast sonner + banner compacto, descartável |
| Config options da sessão | `config_option_update` | atualizar o **seletor único** via `reloadCatalog()`; opções que não sejam modelo (ex.: modo) usam o chip existente |
| Planos | `plan_updated` (reuso) | painel de plano existente no Code/Agentes |
| Log do agente | — | painel "Diagnóstico" em Configurações (`acp_stderr`) |

Acessibilidade: `aria-label` em ícones, foco visível nos diálogos, `role="dialog"`/`alertdialog`,
navegação por teclado nas opções de permissão/elicitação.

### 6.5 i18n e ícones

- Chaves `providers.acp.*` nos três namespaces `settings.json`; chaves backend
  `acp.*` nos três `src-tauri/locales/*.json`. `pnpm i18n:check` é gate.
- Ícone do Registry: baixado no install para `<data>/acp/icons/<id>.svg`, validado como SVG
  16×16/monochrome (`currentColor`/`none` apenas) e renderizado pelo componente de ícone
  existente; se inválido, fallback para iniciais. **Nunca** `<img src="https://cdn…svg">`
  direto na webview (risco de script em SVG).

---

## 7. Modelo de segurança

| Ameaça | Mitigação |
| --- | --- |
| Binário malicioso do Registry | Registry curado + `trusted` opt-in + mostrar comando/args/env + sha256 quando presente + execução sem shell + log de stderr + nenhum auto-upgrade. Curadoria não é sandbox: UI deixa isso explícito. |
| ZIP slip / ADS / bomb | Validação deentradas antes de extrair, limites de tamanho/ratio, canonicalização por componente, nomes reservados do Windows, rollback atômico. |
| Injeção via `npx`/`uvx` | `package@version` fixado, exibir comando exato, consentimento no primeiro launch, PATH/loader/env perigosos bloqueados (D8, §5.10). |
| Segredos vazando para renderer | `secrets.json` 0600/backend-only; `CatalogView`/`AcpAgentView` só expõem nomes de env e máscaras; `_meta` de auth nunca propagado; `ProviderEvent::Meta` filtrado por allowlist. |
| Agente editando fora do workspace | root set = `cwd` + `additionalDirectories`; `safe_path::resolve` no ato do uso; `fs/*`, `terminal/*` desligados por padrão; journal/diff por turno quando o agente usa `fs/write_text_file`. |
| Permissão "aceita" mal mapeada | Escolher por `PermissionOption.kind`, nunca por posição/nome; `policy::decide` revalida; `allow_always` é guardado pelo agente, mas o app mostra o escopo; cancel → `cancelled`. |
| Prompt injection no conteúdo do agente | Todo texto é dado, não instrução; Markdown sanitizado; links com esquema não-http(s) exigem confirmação; URIs `file:` fora do root não abertas; caracteres bidirecionais/controle neutralizados em comandos/paths; sem fetch automático de URI remota. |
| Processo filho sobrevivendo ao app | Job Object no Windows, `process_group(0)` no Unix, `kill_process_tree`, `close_all` no shutdown, TTL e limite de processos. |
| Agente v2-only ou incompatível | Negociação explícita e status "incompatível" com motivo; nunca fallback silencioso que esconda erro de protocolo. |
| Upgrade quebrando provedores atuais | Todos os campos novos `#[serde(default)]`, dispatch por `transport`, suítes existentes de catálogo/custom/plugin/HTTP rodam em cada fase. |

Fora do escopo de sandbox (como o próprio ACP declara): agente binário malicioso já executado,
detecção de prompt injection e isolamento de SO. A UI não promete sandbox.

---

## 8. Fases de implementação (cada fase termina em estado funcional e testado)

### F0 — Contratos, fixtures e ciclo de teste
- Esqueleto `src-tauri/src/acp/**` com tipos, erros e `ProviderTransport`.
- Snapshot real `data/acp-registry.json` + script `scripts/build-acp-registry.mjs`.
- `src-tauri/src/acp/testdata/fake-agent.mjs`: agente fake com `initialize`, auth,
  `session/new` (configOptions com `model`), `session/prompt`, `session/update` de
  texto/thought/tool/plan/usage/notice, `session/request_permission`, `session/cancel`.
- Testes de contrato: registry fixture, fake agent, mapeamento de eventos.
- **Pronto quando:** `cargo test --lib acp::` passa com o fake agent; nenhum comando novo
  registrado ainda.

### F1 — Registry + instalação
- `registry.rs`, `install.rs`, comandos `acp_list_registry`, `acp_refresh_registry`,
  `acp_install_agent`, `acp_add_custom_agent`, `acp_remove_agent`, cache e migrations.
- **Pronto quando:** instalar e remover um agente do snapshot funciona via comando; sha256
  errado e zip-slip falham fechado; upgrade preserva versão anterior até o commit.

### F2 — Runtime ACP e sessão
- `client.rs`, `session.rs`, spawn endurecido + `ByteStreams`, initialize/nauth/session/new/
  prompt/cancel/close, auth status e log de stderr.
- **Pronto quando:** um turno contra o fake agent produz `TurnEvent`s e persiste mensagem;
  cancel aborta e mata a árvore; shutdown fecha tudo; teste com agente fake v2 passa.

### F3 — Integração com provedor e seletor único
- `ProviderTransport` em `ProviderInfo`, merge em `state.rs`, `acp_models` mesclado em
  `catalogView.catalog.providers[].models`, `WireProtocol::Acp`, `stream_one`,
  `resolve_turn_route`, atalho de credencial, `catalog_view`/`validate_provider` com branch ACP,
  `api.ts`/`types.ts`/store/`selectorProviders` — **sem componente novo de seleção**.
- **Pronto quando:** o agente instalado e seus modelos aparecem no `ModelPill` e no
  `ModelPickerDialog` existentes (mesmo teste de `modelMenu`, sem outro seletor), um turno real
  pelo `run_turn` funciona, e `pnpm typecheck` + suítes de catálogo/modelMenu/appStore passam.

### F4 — Capacidades interativas
- `host.rs`: permissões, elicitação, fs, terminal, MCP, notices, planos, compactação,
  config options, subagentes; `AcpCapabilities` no dialog de confiança.
- **Pronto quando:** aprovar/negar uma tool do agente aparece no card do Code; elicitação form
  e url abrem diálogo; fora-do-root é negado; `pnpm test` e `cargo test --lib` verdes.

### F5 — UX completa e layout Agentes
- Dialogs do Registry, painel do agente nas Configurações, selo `agent_kind`,
  `agents.acp_agent_id`, diagnóstico, i18n nos 3 idiomas, ícones validados.
- **Pronto quando:** `pnpm i18n:check`, `pnpm test`, `pnpm typecheck`, `cargo check`,
  `cargo test --lib` passam; smoke manual de instalação → auth → seleção → turno →
  cancel → remoção nos três layouts (sem automação de UI, conforme `AGENTS.md`).

### F6 — Documentação e verificação final
- Atualizar `docs/ARCHITECTURE.md` (nova seção de provedores ACP), `docs/MODELS.md`
  (como adicionar agente), `docs/AGENTS.md` (`agent_kind`), `docs/PLUGINS.md` (fronteira),
  este plano com `EVIDENCE.md` de verificação.
- Teste `#[ignore]` de integração com Registry real e um agente disponível na máquina do
  desenvolvedor (ex.: Gemini CLI/Codex via npx, se instalado), sem depender de rede na suíte.
- **Pronto quando:** a matriz de verificação §11 está toda marcada e o comportamento dos
  provedores HTTP foi comparado antes/depois (mesmos testes, mesmos eventos).

---

## 9. Estratégia de testes (TDD, conforme `AGENTS.md`)

| Nível | O que cobre | Onde |
| --- | --- | --- |
| Rust unitário | parsing/validação do Registry, seleção de target, sha256, zip-slip, mapeamento ACP→ProviderEvent/ProviderError, estado da sessão, limites/TTL, env sanitizado, negociação v1/v2. | `#[cfg(test)]` em `acp/*.rs`; fixtures em `acp/testdata/`. |
| Rust integração (determinística) | `run_turn` com provider ACP contra `fake-agent.mjs` (Node no PATH; pular condicionalmente se ausente, como as skills): eventos, persistência, cancel, aprovação. | `acp/tests.rs` + `harness` com `streamer` injetado. |
| Rust smoke `#[ignore]` | Registry real + agente real instalado localmente; sem rede na suíte padrão. | `acp::smoke`. |
| Renderer Vitest | `selectorProviders` inclui ACP; `ModelPill`/`ModelPickerDialog` mostram o provedor sem componente novo; store ACP, diálogos, eventos `notice`/elicitation; consumidores existentes de `ProviderInfo` continuam. | `src/lib/__tests__/`, `src/components/models/*.test.tsx`, `src/components/settings/*.test.tsx`. |
| Scripts | snapshot do Registry gerado deterministicamente; `pnpm test:scripts`. | `scripts/__tests__/`. |
| i18n | paridade en/pt-BR/es e ausência de texto hardcoded. | `pnpm i18n:check`. |
| Regressão dos atuais | suítes de catálogo, custom, plugin, providers HTTP e `modelMenu` rodam em **toda** fase; nenhuma linha de teste existente é reescrita para acomodar ACP. | `cargo test --lib`, `pnpm test`. |

Regras: teste novo só se pega bug observável do consumidor; sem testar "não lançou" ou eco de
configuração; nenhuma automação de navegador/screenshot como critério (regra do repo).

---

## 10. Riscos e mitigação específica

| Risco | Sinal de alerta | Mitigação |
| --- | --- | --- |
| Agentes do Registry mudam schema da distribuição | `registry version` != 1.x ou `distribution` desconhecido | validação por entrada com `install_reason`; versão pinada no install; snapshot versionado. |
| SDK 5.x sobe MSRV acima do app | `cargo check` falha em toolchain | pin `=5.6.1` primeiro; qualquer upgrade passa por `cargo check` antes de mudar `rust-version`. |
| Agente reporta tool calls que o harness tentaria reexecutar | tool result duplicado no histórico | mapping mark-to-UI (D2): nenhum tool call ACP volta para `execute_tools`; teste de integração assere zero execuções locais. |
| Duplicação de histórico ao reabrir conversa | prompt very long / repetição visível | D5 + teste de prompt com sessão existente vs nova. |
| `session/set_config_option` rejeitado | erro `-32602` no início do turno | cachear apenas valores presentes em `options`; limpar `config_state` do banco se o agente atualizar o catálogo; nunca reenviar valor obsoleto. |
| Auth `terminal` abre janela em ambiente sem shell | exit != 0 / timeout | usar `terminal_command` existente; mostrar erro com hint; não repetir automaticamente. |
| Processo do agente segura lock do workspace | turno "pendurado" | TTL + cancel com kill tree + locks por operação (`workspace/access.rs`), nunca segurar lock durante IO do subprocesso. |
| Ícone/SVG remoto com script | CSP/console | download no install + validação allowlist + render local; nunca fonte remota. |
| Texto ACP com sequência de controle no terminal | escape sequence | neutralização no `host.rs` e no renderer antes de exibir logs/diffs. |

---

## 11. Critérios de pronto e verificação

Comandos (todos na raiz, salvo cargo):

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm i18n:check
node scripts/build-acp-registry.mjs --check
cd src-tauri && cargo check && cargo test --lib && cargo build
```

Matriz mínima de evidência antes de marcar o goal como concluído:

- [ ] Registry oficial parseia; snapshot com 46 agentes (ou mais) e targets corretos.
- [ ] Instalação de um agente `binary` com sha256 válido; falha com hash inválido; nenhum zip-slip.
- [ ] Instalação/primeiro launch de um agente `npx`/`uvx` mostra comando e exige consentimento.
- [ ] `initialize` v1 e v2 (fake) negociam; auth `agent` e `terminal` com sucesso/erro.
- [ ] Turno ACP via `run_turn` gera eventos idênticos em forma aos de um provedor HTTP
      (mesmo `TurnEvent`, mesma persistência de mensagem/usage) — comparar com teste existente.
- [ ] Cancelamento durante streaming não deixa processo nem tool órfã.
- [ ] Permissão do agente aparece no card de aprovação; negar é respeitado.
- [ ] Modelos do agente aparecem no **seletor existente** (`ModelPill`/`ModelPickerDialog`),
      sem segundo seletor, e `session/set_config_option` é enviado com o `model_id` escolhido.
- [ ] Agentes Go/Zen/OpenAI/Anthropic e custom/plugin rodam os mesmos testes de antes, sem
      diff de comportamento.
- [ ] Textos nos 3 idiomas passam em `i18n:check`; nenhum segredo em `CatalogView`/IPC.
- [ ] `docs/ARCHITECTURE.md`, `docs/MODELS.md`, `docs/AGENTS.md` e `EVIDENCE.md` atualizados.

---

## 12. Referências oficiais e internas

**ACP / Registry (primárias)**
- Registry: https://agentclientprotocol.com/get-started/registry
- RFD do Registry: https://agentclientprotocol.com/rfds/acp-agent-registry.md
- registry.json: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- Visão geral: https://agentclientprotocol.com/protocol/v1/overview.md
- Initialization: https://agentclientprotocol.com/protocol/v1/initialization.md
- Authentication: https://agentclientprotocol.com/protocol/v1/authentication.md
- Session setup: https://agentclientprotocol.com/protocol/v1/session-setup.md
- Prompt turn: https://agentclientprotocol.com/protocol/v1/prompt-turn.md
- Content / Tool calls / Plan: https://agentclientprotocol.com/protocol/v1/content.md ·
  https://agentclientprotocol.com/protocol/v1/tool-calls.md ·
  https://agentclientprotocol.com/protocol/v1/agent-plan.md
- FS / Terminals / Config options / Modes / Elicitation: `https://agentclientprotocol.com/protocol/v1/<nome>.md`
- Cancellation / Errors / Security / Transports: idem.
- v2 migration: https://agentclientprotocol.com/protocol/v2/migration.md
- Rust SDK: https://agentclientprotocol.com/libraries/rust.md ·
  https://docs.rs/agent-client-protocol/latest/agent_client_protocol/ ·
  https://docs.rs/agent-client-protocol-cookbook/latest/agent_client_protocol_cookbook/connecting_as_client/

**Internas**
- `docs/ARCHITECTURE.md` §7 (provedores), `docs/MODELS.md`, `docs/AGENTS.md`.
- `docs/goals/code-harness/{PLAN,HARNESS,GOAL}.md` (P8: `agentKind = acp:<agente>`).
- `docs/research/paseo-workbench.md:113-149`, `docs/research/workspace-runtime-options.md:164-166`.
- `docs/goals/provider-resilience/PLAN.md` (taxonomia de erro reutilizada em D10).
- `AGENTS.md` (TDD, ownership, i18n, proibição de automação de UI como verificação).
