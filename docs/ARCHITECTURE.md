# Zylara — Arquitetura

Zylara é um aplicativo desktop de conversação com LLMs, construído em **Tauri 2 + React 19 + Tailwind CSS 4**. O objetivo é reproduzir a experiência dos chats de IA modernos (ChatGPT/Claude) — streaming com raciocínio visível, ferramentas, anexos, artefatos e UI generativa — usando **OpenCode Go**, **OpenCode Zen**, **OpenAI** (plano ChatGPT via "Sign in with ChatGPT" ou API key) e **Anthropic** (API oficial, API key) como provedores.

## 1. Princípios

1. **Local-first**: conversas, anexos e artefatos ficam no disco do usuário (SQLite + arquivos no app-data). Nenhum servidor próprio.
2. **Um único ponto de verdade para modelos**: o catálogo embutido (`data/catalog.json`) descreve protocolo de wire, capacidades de raciocínio, visão, limites e preço de cada modelo. É gerado/atualizado no build a partir da documentação oficial + models.dev, com sondagens reais contra o gateway quando disponíveis.
3. **Protocolo neutro**: o harness não conhece OpenAI/Anthropic/Google; ele fala com uma camada de provedores que traduz um modelo neutro de conversa para 4 protocolos de wire.
4. **Segurança por construção**: a UI generativa é declarativa (JSON com whitelist de componentes), nunca `eval`. HTML/SVG do agente roda em `<iframe sandbox>`.
5. **Degradação graciosa**: se um protocolo não é suportado pelo modelo, tenta o próximo; se um parâmetro de raciocínio falha, reenvia sem ele; se a rede cai, a mensagem parcial é preservada.

## 2. Stack

| Camada | Tecnologia |
| --- | --- |
| Shell desktop | Tauri 2 (Rust), janela frameless com titlebar própria |
| UI | React 19, TypeScript 7, Vite 8, Tailwind CSS 4, Radix UI, lucide-react, motion, sonner |
| Markdown | react-markdown + remark-gfm (tabelas, task lists, notas de rodapé, autolinks, riscado) + remark-math/rehype-katex, `rehype-raw` com sanitizador allowlist próprio (HTML cru seguro), Prism para código, Mermaid (lazy) — contrato em `docs/MARKDOWN.md` |
| Estado | Zustand (app, chat, ui) |
| Backend | Rust: tokio + reqwest (rustls) + rusqlite (SQLite embutido) + scraper/zip/quick-xml/calamine/pdf-extract |
| Streaming | SSE lido no Rust, reemitido ao renderer via `tauri::ipc::Channel` |
| Persistência | SQLite (`zylara.db`) + arquivos em `attachments/` e `artifacts/` |

## 3. Visão de processos

```
┌──────────────────────── WebView (React) ────────────────────────┐
│ AppShell → Sidebar/CodeSidebar │ WorkspaceCenter (ChatView)      │
│            │ Composer │ CodePanel │ Dialogs │ ArtifactUI         │
│        Zustand stores: appStore · chatStore · uiStore            │
│                 src/lib/api.ts  (invoke + Channel)                │
└───────────────▲──────────────────────────────┬──────────────────┘
                │ eventos (Channel<TurnEvent>)  │ comandos (invoke)
┌───────────────┴──────────────────────────────▼──────────────────┐
│                        Rust core (Tauri)                         │
│ commands/  →  harness/  →  providers/ (4 protocolos)             │
│      │            │              └── SSE → ProviderEvent         │
│      │            ├── tools/ (web_search, fetch_url, create_file)│
│      │            └── documents/ (pdf, docx, xlsx, pptx, texto)  │
│      └── db.rs (SQLite) · config.rs (settings/segredos)          │
└──────────────────────────────────────────────────────────────────┘
```

O renderer tem três layouts (`uiStore.layoutMode`): **Chat** (sidebar de conversas, Biblioteca,
Skills, painéis de artefatos/fontes), **Code** (sidebar de workspaces/sessões, cabeçalho/abas de
agente, painel Arquivos/Alterações/commit; sem Biblioteca) e **Agentes** (sidebar de personas,
canais e threads; home/thread do agente com memória, workspace opcional, fila e rotinas). Os três
compartilham a mesma instância de `ChatView` e o mesmo `TitleBar` com o seletor. **As sessões são
separadas por layout** (`conversations.mode`): uma sessão do Chat nunca aparece no Code/Agentes e
vice-versa; uma sessão do Chat pode ser marcada como compartilhada com o Code (`code_linked`). O
contrato do layout Agentes (memória, capabilities, workspace, fila, rotinas, canais e portabilidade)
está em **`docs/AGENTS.md`**.

O **harness de código** é real neste app (v1.9): sessões do Code apontam para um `workspaces`
(pasta do usuário, git opcional), rodam o perfil `Code` do mesmo loop de agente (prompt próprio,
tools de FS/shell/git/plano, política de permissões com aprovação, journal reversível, jobs e
compactação de contexto) e fecham em revisão de diff + commit no painel. Contrato/desenho:
**`docs/goals/code-harness/`** (`PLAN.md`, `HARNESS.md`, `TOOLS.md`, `WORKBENCH.md`,
`EVIDENCE.md`) e pesquisa em `docs/research/`.

## 4. Fluxo de um turno

```
UI: send()
  ├─ cria conversa (se necessário) e mensagens otimistas
  ├─ api.runTurn(payload, onEvent)  ──invoke──▶  commands::turn::run_turn
  │                                                ├─ registra CancellationToken
  │                                                ├─ harness::run_turn
  │                                                │   1. persiste user message
  │                                                │   2. monta histórico + anexos
  │                                                │   3. loop:
  │                                                │      provider.stream_completion
  │                                                │        └─ reasoning/text/tool_* events
  │                                                │      executa tools → anexa resultados
  │                                                │      repete até resposta final
  │                                                │   4. persiste assistant message + usage
  │                                                └─ retorna TurnResult
  └─ eventos chegam por Channel e atualizam o estado incrementalmente
```

Eventos (`TurnEvent`): `turn_started`, `step_started`, `reasoning_delta`, `reasoning_done`,
`text_delta`, `tool_call_started`, `tool_call_args`, `tool_call_finished` (com
`presentation`), `artifact_created`, `usage`, `message_updated`, `title_updated`, `done`,
`cancelled`, `error` e os eventos do harness de código: `approval_requested/resolved`,
`tool_progress`, `file_changed`, `workspace_changes`, `todos_updated`, `plan_updated`,
`goal_updated` (estado do objetivo persistente), `context_stats`, `cache_stats`, `compacted`,
`job_updated`, `profile_changed`.

**Perfis de turno.** `TurnPayload.profile` (`chat` | `code`, default `chat`) seleciona o perfil do
mesmo loop: prompt, catálogo de tools, política e orçamentos. O perfil `code` é aceito em sessão
do Code (nativa ou `code_linked`) e em threads de agente. Threads de agente usam o runtime Code
mesmo quando o pedido chega como Chat e, a cada passo, passam por: compactação de contexto (se
necessário), política/aprovação por tool, journal de arquivos e emissão de eventos de sessão.
No layout Code o par `provider_id`/`model_id` é uma **propriedade da sessão** e pode ser trocado
entre turnos (comando `set_conversation_model`); cada resposta persiste o modelo que a produziu e
mensagens assistant de outra rota entram no histórico seguinte pelo fallback neutro
(`render::frozen_replay_mode`), nunca pelo replay bruto do `provider_state`.

**Objetivo (Goal).** Além do perfil, o turno tem `TurnPayload.turnKind` (`user` default |
`goal_round`) e `TurnPayload.goalRequest` (fluxo `/goal`: intenção de criação no turno humano,
injetada no runtime context como `## Goal request`). Uma rodada de objetivo é um turno normal com
prompt de continuação, `origin` próprio na mensagem do usuário e fecho em `goal/round` +
`goal/state`; o contrato completo (estado, eventos, comandos, driver de rodadas e UI) está em
`docs/goals/code-goals/PLAN.md`.

## 5. Modelo de dados

### SQLite (`%APPDATA%/app.zylara.chat/zylara.db`)

```sql
conversations(id PK, title, created_at, updated_at, pinned, provider_id, model_id, message_count, preview,
              mode, code_linked, workspace_id NULL, agent_kind, permission_mode,
              parent_conversation_id NULL, subagent_task_call_id NULL, subagent_type NULL,
              agent_id NULL, channel_id NULL)
-- agentes (v1.14, docs/AGENTS.md)
agents(id PK, name, role, description, emoji, department, pinned, sort_order, provider_id, model_id,
       fallback_provider_id NULL, fallback_model_id NULL, reasoning_json, instructions,
       prompt_version, starters_json, capabilities_json, memory_enabled, workspace_id NULL,
       permission_mode, archived_at NULL, created_at, updated_at)
agent_memories(id PK, agent_id, kind, content, source_conversation_id NULL, pinned, created_at, updated_at)
agent_routines(id PK, agent_id, title, prompt, schedule_kind, interval_minutes, hour, minute, enabled,
               conversation_id NULL, next_run_at, last_run_at NULL, last_status NULL, last_error NULL,
               created_at, updated_at)
agent_channels(id PK, name, created_at, updated_at)
agent_channel_members(channel_id, agent_id, PK(channel_id, agent_id))
agent_channel_messages(id PK, channel_id, role, agent_id NULL, content, created_at)
messages(id PK, conversation_id, role, content, reasoning, status, tool_calls JSON,
         citations JSON, attachments JSON, model_id, provider_id, usage JSON,
         provider_state JSON, created_at, seq, trace JSON, origin)
-- `origin` (`user` default | `goal_round`) é aditivo (v1.11, docs/goals/code-goals):
-- rodadas automáticas do objetivo não se disfarçam de mensagem do usuário na UI.
attachments(id PK, name, mime_type, size, kind, text, page_count, width, height, file_path, created_at)
artifacts(id PK, conversation_id NULL, message_id, name, mime_type, kind, language, size,
         created_at, path, favorite)
usage_log(id, conversation_id, message_id, provider_id, model_id, tokens..., cache_read_tokens, cache_write_tokens, uncached_input_tokens, cache_hit_percent, cache_epoch, prefix_hash, break_reason, protocol, cost, created_at)
-- cache de prompt (v1.10, docs/goals/prompt-cache/PLAN.md)
prompt_snapshots(conversation_id, snapshot_key, provider_id, model_id, profile, workspace_id,
                 prompt_version, system_text, tools_json, stable_hash, tools_hash, created_at,
                 invalidated_at)
surface_items(id PK, conversation_id, after_message_id, after_step, seq, kind, digest, text,
              created_at)  -- contexto volátil na cauda; UNIQUE(conversation_id, digest)
render_decisions(message_id, kind, digest, payload JSON, created_at)
cache_state(conversation_id PK, provider_id, model_id, protocol, epoch, prefix_hash,
            prefix_segments JSON, prompt_snapshot_hash, cache_read, cache_write, uncached,
            samples, last_hit_percent, last_ceiling_percent, last_at, last_break_reason,
            last_break_detail, updated_at)
cache_samples(id PK, conversation_id, turn_id, step, provider_id, model_id, protocol, epoch,
              prefix_hash, input_total, cache_read, cache_write, uncached, hit_percent,
              ceiling_percent, prefix_tokens_est, delta_tokens_est, eligible, excluded_reason,
              state, break_reason, break_detail, raw_usage JSON, created_at)
-- harness de código (v1.9, docs/goals/code-harness/HARNESS.md §11)
workspaces(id PK, name, path UNIQUE, created_at, updated_at, last_opened_at, pinned, trusted)
code_events(id PK, conversation_id, turn_id NULL, seq, kind, payload JSON, created_at)
-- kinds do objetivo (v1.11): goal/state, goal/deleted, goal/round-started, goal/round
-- projeção única `harness::code::goal` (fold do último goal/state; tombstone em goal/deleted)
file_journal(id PK, conversation_id, turn_id, path, change_kind, before_hash, after_hash,
             added, removed, created_at)
session_summaries(id PK, conversation_id, from_seq, to_seq, content, tokens, created_at)
approval_rules(id PK, scope, scope_id NULL, tool, matcher, pattern, decision, created_at)
meta(key PK, value)
```

`artifacts.conversation_id` é **nulo** para arquivos enviados pelo usuário
direto à página **Biblioteca** (sem conversa); artefatos criados pelo agente
continuam sempre associados a uma conversa. `favorite` é uma marcação do
usuário na Biblioteca e não influencia o agente. Bancos antigos são migrados na
abertura (a coluna passa a aceitar `NULL` e ganha `favorite`, preservando as
linhas existentes) — ver `docs/FILES.md` §14 (v1.8).

`conversations.mode` (`chat` | `code`) guarda o layout de origem da sessão e é
imutável após a criação; `code_linked` marca uma sessão do Chat que foi
adicionada ao Code (compartilhada — aparece nos dois layouts e é a mesma
conversa). Bancos antigos ganham as duas colunas na abertura via migração
aditiva, com `mode='chat'` e `code_linked=0` (logo o Code começa vazio para
quem já usava o app). O renderer filtra as listas por layout em
`src/lib/conversations.ts`; `list_conversations`/`search_conversations`
continuam devolvendo todas as sessões com os dois campos. O par
`provider_id`/`model_id` da conversa é o modelo **atual** da sessão: o harness o
atualiza no início de cada turno e, no layout Code, `set_conversation_model`
permite trocá-lo entre turnos (o Chat mantém o modelo travado após o primeiro
envio).

`provider_state` guarda o replay do turno do agente no formato **v2** (JSON opaco, só no backend — não trafega no IPC): `{"version":2,"steps":[{"state":<payload bruto do passo ou null>,"text":"<texto do passo>","toolCallIds":["id1", …]}]}`. Há um passo por resposta do provedor — um por passo com ferramentas e um para a resposta final (a resposta final forçada é o último) — e `toolCallIds` referencia `tool_calls` em ordem cronológica. No turno seguinte o harness reconstrói o turno multi-step no histórico (um assistant por passo + os tool results daquele passo), exatamente como o loop em memória faz, para que o provedor aceite os outputs das ferramentas. Bancos antigos (payload bruto de um único passo) continuam funcionando: o estado só é replayado quando a mensagem não tem tool calls e o modelo/provedor conferem; caso contrário é descartado e o histórico cai no fallback neutro (texto + tool calls + tool results).

`trace` guarda o traço do loop de agentes usado pelo espaço de pensamento do chat: uma entrada por passo com o `reasoning` visível daquele passo, a narração intermediária (`text` — só nos passos que pediram tools; a resposta final continua só em `content`), a duração do request do passo (`durationMs`) e a quantidade de tool calls que ele pediu (as chamadas em si continuam em `tool_calls`, na ordem cronológica). Nos layouts Code e Agentes o `text` separa o transcript por resposta; no Chat ele é ignorado e o bloco de pensamento continua único. Bancos antigos recebem a coluna automaticamente na abertura (migração aditiva) e traces antigos decodificam com os campos novos vazios.

### Arquivos

```
<app-data>/
  settings.json        # preferências (sem segredos)
  secrets.json         # API keys (nunca enviadas ao renderer)
  attachments/<id>.<ext>
  artifacts/<id>/<nome>
  agent-workspaces/<sha256 da conversa>/  # pasta interna de agente sem workspace escolhido
  checkpoints/objects/<sha256>   # journal do harness de código (conteúdo por hash)
  spill/<conversa>/<id>.txt      # saída completa de tool acima do limite inline
  zylara.db
```

`workspaces.path` aponta para uma pasta real do usuário (nada é copiado para o app-data);
`conversations.workspace_id` é nulo em sessões sem workspace, e `conversations.agent_kind`
(`zylara`) deixa a porta aberta para agentes externos via ACP no futuro.
`conversations.permission_mode` (`read_only` | `review` | `edit` | `autonomous`) é o modo de
permissões da sessão de código; o Chat ignora os modos. Cada sessão guarda o próprio modo (o
chip do composer troca por sessão) e as **novas sessões do Code** nascem com
`Settings.codeDefaultPermissionMode` — padrão **Autônomo**, configurável em
Configurações → Ferramentas → Sessões de código — inclusive quando uma sessão do Chat é
compartilhada com o Code. `code_events` é o log append-only dos fatos da sessão (permissões, plano,
tarefas, contexto, aprovações, alterações, reversões, turno encerrado); `file_journal` guarda as
capturas por turno (hash antes/depois) que dão o diff e o "reverter turno/arquivo";
`session_summaries` guarda os resumos de compactação; `approval_rules` guarda as regras
"sempre permitir/negar".

## 6. Catálogo de modelos

`scripts/build-catalog.mjs` gera `data/catalog.json` combinando:

1. **Tabelas oficiais** de [OpenCode Go](https://opencode.ai/v2/docs/console/go) e [Zen](https://opencode.ai/v2/docs/console/models/) — ids, nomes e protocolo de wire por modelo;
2. **models.dev** — `reasoning_options`, visão/anexos, limites de contexto, preço, família (Go/Zen/OpenAI/**Anthropic**);
3. **Docs oficiais da Anthropic** ([platform.claude.com](https://platform.claude.com/docs/en/api/overview)) — modelo Claude do provedor direto (IDs dateless, limites, preços) e o header obrigatório `anthropic-version`, que entra no catálogo como header estático;
4. **Sondagens reais** (`scripts/probe-models.mjs`) — quais protocolos o gateway aceita para cada modelo (há modelos multi-protocolo); artefato local opcional, ausente em CI;
5. **Heurísticas por família** para modelos novos que ainda não estão no models.dev;
6. **Atualização no build** — `scripts/sync-catalog.mjs` roda antes de `pnpm build`, `pnpm build:fast` (usado pelo `beforeBuildCommand` do Tauri) e `pnpm app:build`: baixa as fontes públicas (docs Go/Zen + models.dev), regrava `.research/` e regenera todos os provedores possíveis. Falhas de rede mantêm o catálogo commitado; `--strict` falha o build. Entradas de Go/Zen já presentes são preservadas (esses provedores não têm refresh da lista viva em runtime); OpenAI/Anthropic também mesclam `GET /v1/models` da conta em runtime.

Formato (resumo):

```json
{ "id": "glm-5.3-flash", "protocols": ["openai-chat"],
  "reasoningOptions": [{ "type": "effort", "values": ["low","high","max"] }],
  "attachment": true, "contextWindow": 1000000, "maxOutput": 131072,
  "modalities": { "input": ["text","image"], "output": ["text"] }, "status": "stable" }
```

O frontend importa o catálogo estaticamente (render instantâneo) e o backend o embute com `include_str!`; ambos leem o mesmo arquivo.

## 7. Provedores (4 protocolos)

| Provedor | Base URL | Protocolos | Autenticação |
| --- | --- | --- | --- |
| OpenCode Go | `https://opencode.ai/inference/go` | openai-chat, openai-responses, anthropic, google | API key |
| OpenCode Zen | `https://opencode.ai/inference` | idem | API key |
| OpenAI | `https://api.openai.com/v1` | openai-responses | OAuth ChatGPT (plano) ou API key |
| Anthropic | `https://api.anthropic.com/v1` | anthropic | API key `sk-ant-…` (pay-as-you-go) |

Os endpoints de cada protocolo vêm do mapa `endpoints` do catálogo (não há
caminhos fixos no código dos adaptadores; o Google usa o placeholder `{model}` e
o sufixo `:streamGenerateContent?alt=sse`). `x-opencode-session` só é enviado a
provedores OpenCode. Headers estáticos do provedor (ex.: `anthropic-version`)
vêm de `ProviderInfo.headers` e são enviados em toda requisição (inferência,
listagem de modelos e validação).

| Protocolo | Endpoint (base OpenCode) | Modelos típicos |
| --- | --- | --- |
| `openai-chat` | `/openai/v1/chat/completions` | GLM, DeepSeek, Kimi (chat), Qwen, MiMo, LongCat, Step |
| `openai-responses` | `/openai/v1/responses` (OpenAI: `/responses`) | GPT, Grok, Muse, OpenAI `gpt-*` |
| `anthropic` | `/anthropic/v1/messages` (Anthropic direto: `/messages`) | Claude, MiniMax, Kimi K3/K3.1, Qwen (alguns) |
| `google` | `/google/v1beta/models/{model}` | Gemini |

Cabeçalhos: `Authorization: Bearer <key>`, `x-opencode-session: <session>` (só
OpenCode), `User-Agent: Zylara/<versão>` e os headers estáticos do catálogo
(`ProviderInfo.headers`).

### Autenticação OpenAI (plano ChatGPT)

`src-tauri/src/oauth/**` implementa o fluxo oficial "Sign in with ChatGPT —
ChatGPT plan usage" para apps open-source/locais: PKCE S256 + `state` + `nonce`,
registro dinâmico (`dynamic_agent_client`) com `ext_agent_host_id` persistido,
callback loopback em `127.0.0.1` (porta efêmera), troca de code, validação do ID
token por JWKS, refresh rotativo single-flight e revogação no sign-out (mantendo
o mapping conta/`client_id`). Tokens ficam no backend (`secrets.json` v2, 0600,
escrita atômica sob um único writer); o renderer recebe apenas
`ProviderAuthStatus` (e-mail, ids mascarados, escopos, expiração). A lista de
modelos é específica da conta (`/v1/models`), cacheada em `models-cache.json` e
mesclada ao catálogo no `CatalogView`; o harness resolve modelos pela visão
mesclada. Perfis de request: `chatgpt-plan` (store:false/stream:true, sem
`max_output_tokens`/`temperature`, `instructions` + function tools) e `standard`
(API key). Detalhes/limites: `docs/MODELS.md`.

### Autenticação Anthropic (API key)

O provedor `anthropic` usa a API oficial (`https://api.anthropic.com/v1`), o
mesmo adaptador `anthropic` e o perfil `standard`. A credencial é a API key do
Claude Console (`ANTHROPIC_API_KEY` ou chave salva em Configurações →
Provedores), enviada como `Authorization: Bearer <key>` (formato documentado
atual; `x-api-key` é o fallback legado da Anthropic e não é usado). O header
obrigatório `anthropic-version` vem de `ProviderInfo.headers` no catálogo
(`{"anthropic-version": "2026-10-21"}`), então inferência, listagem de modelos
(`GET /v1/models`, com paginação `after_id`/`has_more`/`last_id`) e "Testar
conexão" enviam exatamente o mesmo contrato sem código específico de provedor.

Não há OAuth/assinatura: a Anthropic não oferece um programa público de login
para apps de terceiros (o OAuth do Claude Code é interno e proibido para
terceiros sem aprovação). Cobrança é por token na conta do usuário; a lista de
modelos da conta é mesclada ao seed do catálogo e modelos novos aparecem como
`estimated` com as capacidades lidas de `/v1/models` (`max_input_tokens`,
`max_tokens`, `capabilities.effort`/`thinking`/`image_input`). Detalhes:
`docs/MODELS.md` e `docs/goals/anthropic-api-provider/PLAN.md`.

### Mapeamento de "modo de pensamento"

O usuário escolhe `off | esforço | orçamento` conforme as capacidades do modelo. O adaptador traduz:

| Protocolo | Desligar | Esforço | Orçamento |
| --- | --- | --- | --- |
| openai-chat | `thinking: {type:"disabled"}` | `reasoning_effort` | — |
| openai-responses | `reasoning.effort = "none"` | `reasoning: {effort, summary:"detailed"}` | — |
| anthropic | `thinking: {type:"disabled"}` | `thinking:{type:"adaptive"} + output_config:{effort}` | `thinking:{type:"enabled",budget_tokens}` |
| google | `thinkingConfig:{thinkingBudget:0}` | `thinkingConfig:{thinkingLevel}` | `thinkingConfig:{thinkingBudget}` |

Fatos descobertos por sondagem (ver `docs/MODELS.md`):
* Claude 5.x recusa `thinking.enabled`; exige `adaptive` + `output_config.effort`.
* GLM 5.x é *thinking-only*: desligar retorna 400 → o adaptador reenvia sem o parâmetro e sinaliza na UI.
* Kimi expõe reasoning apenas via protocolo Anthropic; MiniMax idem.
* GPT/Grok/Muse só mostram raciocínio com `summary` explícito.

### Fallback de protocolo

`providers::stream_completion` percorre `model.protocols` em ordem. Se o gateway responder `ModelProtocolUnsupported`, tenta o próximo. Erros de parâmetro de raciocínio são reenviados uma vez sem o parâmetro (auto-healing).

### Retry, timeouts e stream truncado

`ProviderError` classifica a falha (transitória, refresh de auth ou permanente) e cada
`CompletionRequest` carrega `StreamTimeouts` (headers, primeiro evento, idle e total),
construído pelas settings `provider*`. `providers::sse` impõe os deadlines e cada adapter
exige o sinal terminal do protocolo (`finish_reason`/`[DONE]`, `response.completed`,
`message_stop`, `finishReason`); EOF antes disso vira `StreamInterrupted`, nunca uma resposta
truncada salva como completa.

O retry vive no harness (`run_step_with_retry`): só repete quando o attempt não emitiu texto,
reasoning nem tool calls; 401 com bearer renova a credencial uma vez fora do orçamento de
retries; `Retry-After` é honrado até o teto configurado. Cada espera emite
`TurnEvent::Retrying` (fase `retrying` na UI) e cancelamento vence o sleep. Falhas terminais
são persistidas em `messages.error` (`MessageError`: mensagem, código, dica, `retryable`,
`attempts`, `retryAfterMs`), então o banner e o botão de retry sobrevivem a reloads; falhas
antes do primeiro request (credencial/modelo/protocolo) também persistem usuário + bolha de
erro para turnos novos.

### Turnos retomáveis (continuar do passo exato)

Um turno que termina sem concluir (erro do provedor, rota sem credencial, Stop, app fechado
ou gate de completion) guarda um **ponto de retomada** na própria mensagem assistant:
`messages.resume_state` (`ResumeState`: `step`, motivo, `TurnOptions` e seleção de raciocínio
do turno). O resto do estado já vive na linha — conteúdo, raciocínio, `trace`, tool calls com
resultados, citações, usage e o envelope de replay por passo (`provider_state` v2) — então o
ponto só carrega o metadado do loop. Ele é reescrito a cada passo (`ResumeCheckpoint`), limpo
quando o turno conclui e invalidado quando a conversa recebe uma mensagem nova
(`clear_resume_states`); no boot, `recover_interrupted_messages` mantém o ponto e só troca o
motivo para `app_closed`.

`run_turn` aceita `resumeAssistantMessageId`: em vez de criar usuário + bolha, recarrega a
mesma linha (status volta a `streaming`), semeia o loop com o estado persistido, devolve ao
modelo a cauda já produzida (`resume_history_tail`: um assistant por passo + resultados das
tools; replay bruto só quando provedor/modelo continuam os mesmos) e continua em `step + 1`.
O `turn_started` anuncia os **mesmos ids**, então o renderer mantém o mesmo transcript e os
mesmos cards, e o botão **Continuar** (`chatStore.resumeMessage`) só dispara esse turno —
`regenerate` continua existindo como ação separada, que descarta a resposta anterior.

## 8. Harness

`harness::run_turn` executa:

1. Carrega conversa e histórico, injeta anexos (texto extraído + imagens quando o modelo suporta).
2. Monta o system prompt (`harness/prompt.rs`, instruções em inglês): identidade, idioma (regra de resposta em pt-BR), regras de ferramentas, **guia de formatação Markdown/GFM** (ver §8.1), formato de **UI generativa**, formato de artefatos e citações.
3. Loop de até `max_steps`:
   - chama `providers::stream_completion` e reemite eventos;
   - acumula texto, reasoning e tool calls;
   - se houver tool calls: executa `tools::execute` em paralelo (máx. 4), emite `tool_call_finished`, adiciona resultados ao histórico e repete;
   - se não houver: finaliza.
   Cada passo alimenta `ChatMessage.trace` (`reasoning` do passo, narração intermediária `text`, duração do request `durationMs` e número de tool calls), o que permite reconstruir a timeline de pensamento e o transcript separado por resposta dos layouts Code/Agentes depois de reabrir a conversa (DESIGN §6.3).
4. Persiste mensagem final + `provider_state` (envelope **v2** com o replay de cada passo do loop — ver §5) + usage; gera título automático (primeiro turno) com o próprio modelo (requisição curta, não-streaming) ou heurística local.
5. Cancelamento: `CancellationToken` interrompe o stream; mensagem parcial é salva com status `cancelled`.

### Ferramentas

| Tool | Descrição | Saída para o modelo |
| --- | --- | --- |
| `web_search` | busca no DuckDuckGo (HTML/lite) + fallback Bing; retorna até 8 resultados com título, URL e snippet | JSON compacto + citações para a UI |
| `fetch_url` | GET + extração de conteúdo legível (scraper), limite de ~120k chars, respeita `text/html` | texto com metadados e URL final |
| `create_file` | cria artefato (md, html, csv, json, código, svg) no disco e registra no DB | confirmação + id do artefato |
| `run_code` | executa um script Python/Node num workspace isolado (`code-runs/`), com timeout, limites e cancelamento; os arquivos gerados viram artefatos | resumo + exit code + cauda de stdout/stderr + ids dos artefatos |
| `list_skills` / `read_skill` | lista as skills locais (embutidas + usuário) e carrega instruções/scripts de uma skill | JSON com descrição, `baseDir` e arquivos |
| `list_artifacts` | lista/pesquisa a biblioteca de artefatos **do usuário (todas as conversas)** por nome, título da conversa e conteúdo textual (sem acentos), com filtro de tipo, limite, trechos com número de linha e a conversa de origem de cada arquivo | JSON compacto (id, nome, tipo, tamanho, data, `conversationTitle`/`currentConversation` e trechos) |
| `read_artifact` | carrega o conteúdo de **qualquer artefato do usuário (de qualquer conversa)** como contexto: texto raw, texto extraído de PDF/DOCX/XLSX/PPTX, metadados/estrutura de imagem/ZIP/mídia/binário; paginação por caracteres e conversa de origem no cabeçalho | texto com cabeçalho, faixa e próximo `offset` |
| `validate_ui` | valida um bloco ` ```ui ` (JSON declarativo) contra o contrato: normaliza, valida e roda o lint de design; disponível no Chat e no Code (exceto no subagente read-only) | `{ ok, errors, warnings, normalized }` |

`validate_ui`, `list_skills` e `read_skill` estão sempre disponíveis e não contam
no orçamento de ferramentas de dados (no Code, `validate_ui` também fica fora do
orçamento e não exige workspace). `list_artifacts` e `read_artifact` também
estão sempre disponíveis (leitura local e somente leitura), mas **contam** no
orçamento de 6 chamadas de ferramentas de dados; a biblioteca é **do usuário**:
`list_artifacts` lista todas as conversas (mais recentes primeiro, com título da
conversa de origem) e `read_artifact` lê qualquer artefato pelo id — a leitura é
escopada ao usuário, não à conversa atual (decisão §16 #15). `read_artifact`
devolve páginas de até 20 mil caracteres (o resultado total, com cabeçalho e
rodapé, fica abaixo do limite de 24 mil caracteres de resultado de ferramenta do
harness). `run_code` é **opt-in**:
`Settings::code_execution_enabled` (default `false`) e o harness aplica o gate
em `TurnOptions::run_code`; sem ele a ferramenta não entra na definição enviada
ao modelo.

As ferramentas de pesquisa (web_search, etch_url) devolvem citações que a
UI mostra como chips na mensagem (até 8, deduplicadas por URL); o excedente abre o
**painel lateral de fontes** da conversa, no mesmo padrão do painel de artefatos
(DESIGN §5/§6.3, docs/FILES.md §14 v1.4).

### 8.2 Execução de código e skills

`run_code` executa o script em `<app-data>/code-runs/<uuid>/`, com `stdin`
fechado, `stdout/stderr` limitados a 64 KB cada, timeout (5 s–10 min) e morte da
árvore de processos no cancelamento/timeout. Variáveis de ambiente sensíveis
(`*API_KEY*`, `*TOKEN*`, `*SECRET*`) são removidas; as chaves do app nunca são
injetadas. O mesmo vale para overrides do loader/contexto herdados do launcher
(`LD_*`/`DYLD_*`, `APPDIR` e caminhos do AppImage, `SHELLOPTS`/`BASH_ENV` e
`GIT_DIR`/equivalentes), para que o script use o runtime e o repositório do
workspace (`process_env`). Arquivos novos do workspace (até 20, 25 MB cada / 64 MB no total) são
gravados em `artifacts/<id>/` pelo mesmo writer do `create_file`
(`tools::artifacts`) e viram artefatos mesmo quando o script termina com erro.

Skills são diretórios com `SKILL.md` (frontmatter `name`/`description` +
instruções) opcionalmente com `scripts/`. O backend materializa as skills
embutidas (`src-tauri/skills/**`, via `include_dir!`) em
`<app-data>/skills-bundled/` e varre `<app-data>/skills/` (usuário vence por
nome). Além da pasta do Zylara, o catálogo lê **em modo somente leitura** os
repositórios padrão usados por outros agentes: `~/.agents/skills` (Agent
Skills), `~/.codex/skills`/`CODEX_HOME`, `~/.claude/skills`/`CLAUDE_CONFIG_DIR`
e `~/.config/opencode/skills`/XDG (precedência: Zylara > agents > codex >
claude > opencode > embutidas). O catálogo entra no system prompt e
`read_skill` devolve `instructions` + `baseDir` + lista de arquivos,
permitindo ao agente rodar o helper stdlib da skill por `run_code`. Skills
desativadas (`Settings.disabled_skills`) são filtradas do prompt, de
`list_skills` e de `read_skill`; a gestão (ativar/desativar; excluir apenas as
do Zylara) fica na sidebar e em Configurações → Ferramentas. Desenho completo,
limites e segurança: **`docs/FILES.md`**.

### 8.3 Harness de código (perfil `code`)

Mesmo loop do Chat, com `TurnPayload.profile = "code"` (só em sessão do Code). O que muda:

1. **Contexto do turno** (`harness/code/context.rs`): workspace da sessão, git (branch/ahead/
   behind/dirty), perfil do projeto (comandos de test/lint/build detectados), instruções do
   projeto (`AGENTS.md`/`CLAUDE.md` + `.zylara/instructions.md`, raiz, cap 32 KiB, só em
   workspace confiável), árvore resumida (2 níveis) e estado da
   sessão (plano/tarefas/contexto) projetado de `code_events`. O loop injeta `[loop-guard]`
   após 3 lotes idênticos consecutivos de tool calls (exceto `ask_user`, `job_output` e
   `task_wait`); `read_file` com saída idêntica 3 vezes anexa um aviso; e o gate de conclusão só
   exige novo check após mudança comportamental (docs não invalidam um check verde).
2. **Prompt próprio** (`harness/code/prompt.rs`): identidade de agente de código, ambiente,
   política de permissões, orientações das tools (geradas do registry — fonte única),
   regras de edição/verificação, projeto, formato de resposta e **UI generativa** (notas do
   Code + a seção gerada de `data/genui-contract.json`).
3. **Tools do perfil** (`tools/registry.rs` + `tools/code/*`): 25 tools — 20 de código + web/skills
   + `validate_ui`:
   `read_file`, `list_dir`, `search_files`, `search_text`, `read_tool_output`,
   `write_file`, `edit_file`, `run_command`, `job_list`/`job_output`/`job_kill`,
   `git_status`/`git_diff`/`git_log`, `todo_write`, `submit_plan`, `ask_user` (perguntas
estruturadas com opções e texto livre, respondidas pelo card da timeline via
`respond_question`), `goal` (progresso/conclusão/bloqueio do objetivo da sessão —
`docs/goals/code-goals/PLAN.md`), `run_checks` (verificação detectada do projeto), `task`
(subagente somente leitura, profundidade 1, sem MCP/escrita/shell, catálogo efetivo como
fronteira de execução, transcript filho retido/oculto com cascata no pai, eventos ao vivo,
modelo/effort por delegação, paralelismo limitado, limpeza RAII e session id do pai para cache),
`validate_ui` (validação local de blocos `ui`; sempre disponível, exceto no subagente)
e tools dinâmicas de servidores **MCP** (mcp__servidor__tool, stdio JSON-RPC, aprovação
explícita nos modos interativos; o Autônomo executa direto; config <app-data>/mcp.json;
indisponíveis em subagentes).
   O modelo **não** recebe commit/push.
4. **Política e aprovação** (`policy/`): modos `read_only`/`review`/`edit`/`autonomous` + overlay Plano
   + regras persistidas. Novas sessões nascem no modo padrão configurado (Autônomo de fábrica).
   No Autônomo nenhuma confirmação de comando/edição/segredo/computador/MCP é pedida (regras
   explícitas de negação e o modo Plano continuam valendo); nos demais modos toda mutação passa
   por `policy::decide` → `ApprovalRegistry` (evento `approval_requested`, card na timeline,
   `respond_approval`) ou negação com código estável. Timeout/cancelamento resolvem como falha
   fechada; a revisão do plano é a exceção e aguarda a decisão sem prazo.
5. **Confinamento e journal** (`workspace/`): todo path resolve contra a raiz do workspace
   (`safe_path`: `..`, symlink/junction, UNC, device paths); leitura antes da escrita por hash
   (`FS_NOT_OBSERVED`/`FS_STALE_VERSION`); escrita atômica com EOL/BOM preservados; journal
   por turno no object store (`checkpoints/objects/<sha256>`) → diff, "Reverter arquivo" e
   "Reverter turno". Execução de processos com `CREATE_NO_WINDOW`, env higienizado, timeout,
   kill de árvore (`taskkill /T`) e streaming de saída.
6. **Git**: CLI do usuário (`git status --porcelain=v2 -z`, `diff`, `log`, `stage`,
   `unstage`, `commit`, `for-each-ref` em `refs/heads`+`refs/remotes` para as branches,
   `switch`/`switch --create` para trocar e criar), sem libgit2. Uma branch remota
   (`origin/feat`) é aceita pelo switch e vira a branch local de tracking. Operações
   mutantes são ações do usuário no painel, nunca tools do modelo.
7. **Jobs**: `run_command` pode rodar em background (`JobRegistry` com ring buffer 256 KB,
   limite 8 por sessão, cursor de saída, `JobUpdated`); foreground que estoura o timeout é
   promovido a job em vez de morto.
8. **Contexto**: medidor (`context_stats`), poda de resultados antigos e compactação por resumo
   (`harness/code/compaction.rs`, template de 8 seções, persistido em `session_summaries` e
   aplicado nos turnos seguintes).
9. **Terminal PTY**: src-tauri/src/terminal/** (portable-pty/ConPTY) com open_terminal/write_terminal/
esize_terminal/close_terminal/list_terminals e Channel<TerminalEvent>; o painel abre em xterm.js no cwd do workspace (terminal do usuário; o agente usa 
un_command/jobs).
10. **Fecho do turno**: `file_journal` → `workspace_changes`, `context_stats`, `turn/ended` em
   `code_events` e cancelamento das aprovações pendentes da sessão. O transcript do Code
   termina cada turno com o card de resumo de arquivos alterados (dados das presentations
   `file_change` persistidas; `docs/DESIGN.md` §6.3, `WORKBENCH.md` §5.1).
11. **Objetivo (v1.11)**: `harness/code/goal.rs` projeta `goal/state` (último vence; `goal/deleted`
    fecha) e o histórico de rodadas; `run_turn` aceita `turnKind=goal_round` só com objetivo
    ativo/workspace/plano inativo/sem aprovação, abre a rodada (`goal/round-started`), injeta a
    seção volátil `## Objective` no runtime context e fecha (`goal/round` + pausa em
    erro/cancel/limite/estol). O driver de rodadas é do renderer (`chatStore.maybeContinueGoal`,
    após `done`, uma rodada por vez, só com a sessão ativa no Code); a tool `goal` reporta
    progresso/conclusão/bloqueio. **Ativação (v1.12)**: `/goal` ativa um chip no composer (a
    mensagem do usuário não é alterada); o turno humano leva `goalRequest=true` e o runtime context
    instrui o agente a criar o objetivo (`goal` action `create` com objetivo/título/limite/
    `auto_continue=true`); o botão do objetivo no composer é somente ícone e **alterna** o chip
    `/goal` com o mesmo padrão do toggle de Plano (accent + `aria-pressed` quando armado; clicar no
    chip remove a intenção); com objetivo persistente, abre o popover de controle.
    Plano completo: `docs/goals/code-goals/PLAN.md`.
12. **Troca de modelo/provedor na sessão**: `set_conversation_model` persiste o par da conversa
    entre turnos (só sessões do Code; recusa turno ativo e sessão nativa do Chat). A UI libera o
    seletor no layout Code, mantém o bloqueio durante o streaming e marca a troca no transcript com
    o divisor "Modelo alterado para …". As respostas antigas mantêm o modelo que as produziu
    (histórico neutro) e o epoch de cache registra “Modelo ou provedor mudou”. Contrato/evidência:
    `docs/goals/code-model-switch/`.

Contratos completos (tools/eventos/comandos/UI): `docs/goals/code-harness/TOOLS.md`,
`HARNESS.md` e `WORKBENCH.md`.

### 8.3.1 Layout Agentes (v1.14)

Contrato completo: **`docs/AGENTS.md`**. Resumo:

- **Persona**: `agents` + `conversations.agent_id`; o backend é a autoridade do
  prompt, do modelo e das capabilities. `prompt_version` + `agent.id` entram na
  snapshot key.
- **Memória**: `agent_memories` + tool `memory`; o bloco entra como
  `surface_item kind="memory"` na cauda volátil (nunca no system prompt). Só o
  item de memória mais recente é renderizado.
- **Capabilities**: allowlists de tools/skills/MCP são aplicadas no catálogo,
  na execução e no conteúdo; `Some([])` nega tudo.
- **Workspace**: threads de agente usam o runtime Code com pasta explícita
  confiável ou pasta interna isolada por conversa. Sem pasta explícita,
  `run_command`, `run_checks`, `task` e MCP não são liberados; ferramentas de
  artefatos e `run_code` seguem os gates do Chat. A escolha pode ser alterada
  em Agentes entre turnos. `executionEnvironment` alterna `run_command`/jobs
  entre a máquina local e Docker (workspace em `/workspace`, rede desligada por padrão).
- **Concorrência**: `chatStore.streamsByConversation` mantém um stream por
  conversa; `streaming` é a fatia visível de `activeId`. Várias threads de agente
  rodam ao mesmo tempo, com erro/notificação por thread.
- **Fila**: FIFO por conversa em `messageQueueStore` (persistida e sanitizada),
  usada por Chat, Code e Agentes; **Enviar agora** cancela o turno atual e inicia
  o item assim que o backend libera a conversa, e a fila drena antes da rodada
  automática do Goal. O backend aceita um turno por conversa (`register_if_idle`).
- **Rotinas**: `agent_routines` + agendador Rust em paralelo (enquanto o app
  está aberto); cada run é um turno normal na conversa principal do agente,
  passando pela fila persistente `agent_routine_queue`, sob o governador e com
  lease/sweep.
- **Canais**: `agent_channels` + membros + mensagens; só os membros mencionados
  (ou todos, sem menção) respondem em threads privadas; o histórico entra como
  `surface_item` volátil e um evento `zylara:agent-channel-updated` atualiza a
  view.
- **Delegação**: `agent_tasks`/`agent_task_events` com dono, lease, orçamento,
  deadline, `origin_conversation_id` e máquina de estados; tools
  `delegate_task`/`handoff_task`/`task_wait`/`task_cancel`/`finish_task`;
  handoff imediato e resultado entregue como mensagem `system` na origem;
  runner Rust a cada 5 s em paralelo sob o governador (`docs/TASKS.md`).
- **Computer use**: screenshot/clique/teclado/janelas/UI tree local no Windows e
  Docker gráfico (Xvfb + noVNC); input com aprovação fora do Autônomo
  (`RiskClass::Computer`), contrato em `docs/COMPUTER.md`.
- **Docker**: `run_command`/jobs com hardening (non-root, cap-drop, read-only,
  limites, workspace único, rede off), validação de imagem e cleanup
  (`docs/DOCKER.md`).
- **Modelo de reserva**: `fallback_provider_id`/`fallback_model_id`; se a rota
  principal não resolve ou não tem credencial, o turno usa a reserva antes de
  persistir mensagens.
- **Uso/custo**: `usage_log` agregado por `conversations.agent_id`
  (`get_agent_usage`/`list_agent_usage`), exibido na Equipe/home.
- **Portabilidade/edição**: templates locais, construtor por IA (`suggest_agent`),
  revisão por IA com diff (`revise_agent`), duplicar e export/import de documento
  `zylara-agent` versionado.

### 8.4 Cache de prompt (v1.10)

O harness mede o cache por **request de wire** (não por turno) e expõe em tempo
real no medidor de contexto (Code: anel + selo `cache NN%`; Chat: chip
cache-first no composer). A verdade é o `usage` reportado pelo provedor:
`hit = cache_read / (cache_read + cache_write + uncached)`; sem reporte, `—`.

- **Prefix digest** (`providers/cache.rs`): segmentos canônicos do body final
  (system/tools/mensagens), SHA-256 encadeado; metadados de cache
  (`cache_control`, `prompt_cache_key`, TTL) ficam **fora** do hash. O digest é
  emitido antes do SSE (`ProviderEvent::CacheDigest`).
- **Tracker** (`harness/cache`): compara o digest com o último request do epoch,
  calcula `P`/`Δ`/`ceiling`, hit%, quebra (system/tools/histórico/compactação/
  modelo/protocolo), estado (`cold`/`warming`/`stable`/`degraded`/`unsupported`/
  `provider_policy`) e elegibilidade (`cold`, `not_reported`, `write_only`,
  `below_min`, `unknown_min`). É persistido em `cache_state`/`cache_samples` e
  restaurado no turno seguinte e após restart; `usage_log` ganha as colunas de
  cache.
- **Evento** `cache_stats` (uma amostra por request, nos dois perfis e no final
  forçado); `get_cache_stats` restaura o agregado ao abrir a conversa.
- **Mecanismos por protocolo**: Anthropic `cache_control` (breakpoints em
  tools/system/cauda, TTL 1h), OpenAI `prompt_cache_key`/retenção/TTL, gateways
  OpenCode com `x-opencode-session` e `usage.opencode.tokens`, Google implícito
  (`cachedContentTokenCount`), DeepSeek hit/miss. Capacidades vêm do catálogo
  (`provider.cache`/`model.cache`) e são refinadas pelo probe
  (`scripts/probe-cache.mjs`, F4.0).
- **Estabilidade de prefixo**: `prompt_snapshots` congela system prompt e tools
  por sessão; o volátil (git/tree/plano/modo/data) vai em `surface_items` na
  cauda, nunca no system prompt (o system precede o histórico nos 4 protocolos).
- **Painel**: `ContextMeter` (Code) e `CacheHitChip` (Chat) mostram hit do último
  request, sessão ponderada, teto `P/(P+Δ)`, estado, última quebra, TTL, economia
  estimada e “copiar usage bruto”. O `ContextMeter` também mostra o custo da
  sessão em USD (mensagens + subagentes, preços oficiais do catálogo por modelo)
  com entrada, saída e cache no popover. O custo acompanha **cada request** — o
  evento `usage` leva o total acumulado do turno (passos + subagentes já
  concluídos), na mesma cadência do `cache_stats`/`context_stats`, em vez de só no
  fecho — e o valor derivado é relido no máximo a cada 10 s enquanto o turno roda
  (`CodeContextMeterChip`). `Settings.cache` controla o indicador, o TTL
  Anthropic e a retenção OpenAI.

Plano/evidência: `docs/goals/prompt-cache/{PLAN,GOAL,EVIDENCE}.md`; pesquisa por
provedor/OpenCode/DSH: `docs/research/prompt-caching.md`.

### 8.1 Markdown do chat

O contrato completo (sintaxe suportada, decisões e matriz de testes) está em
**`docs/MARKDOWN.md`**; o renderer fica em `src/components/chat/Markdown.tsx`.

- **Pipeline**: `remark-gfm` (tabelas com alinhamento, task lists, notas de
  rodapé, autolinks, riscado), `remark-math` + `rehype-katex` (`$…$` inline e
  `$$…$$` display), `rehype-raw` para HTML cru e, em seguida, o sanitizador
  próprio `rehypeSafeHtml` (allowlist de tags/attrs/URLs, roda **antes** do
  KaTeX para não descartar a saída dele). Antes do parse, `protectEscapedDollars`
  protege `\$` (o micromark de math não trata `\$` como escape e fecharia o span
  antes da hora); `remarkRestoreMathDollars` devolve `\$` ao conteúdo de math e
  `$` à prosa/código após o parse.
- **Componentes**: código cercado com header de linguagem + botão copiar
  (Prism); fences especiais `ui`, `mermaid`, `chart`, `html`, `svg`; links
  externos e `mailto:` via plugin-opener; âncoras internas (notas de rodapé);
  imagens com fallback; alertas GitHub (`> [!NOTE]` etc.); tabelas com wrapper
  rolável.
- **Segurança**: o Markdown nunca usa `innerHTML`; o HTML cru passa por
  allowlist (sem `script`/`style`/`iframe`/`on*`/`style` inline) e as URLs
  aceitas são apenas `http(s)`, `mailto:` e `#âncora`. O prompt (seção
  `# Markdown formatting` em `harness/prompt.rs`) orienta o modelo a preferir
  Markdown puro e nunca emitir HTML perigoso.
- **Thinking do modelo**: o raciocínio visível (`ChatMessage.reasoning` e
  `trace[].reasoning`) usa o **mesmo** renderer pela variante
  `variant="thinking"` (modificador `.zylara-prose--thinking`: 13px,
  `foreground-muted`, ritmo compacto), com a **mesma** sanitização/allowlist. A
  timeline (`src/lib/agentTrace.ts` → `AgentSteps`) devolve o Markdown **bruto
  por passo** (sem dividir por linha em branco nem remover marcadores de lista) e
  preserva as diferenças entre layouts (Chat: resumos agrupados de tools e header
  "Pensou por Xs"; Code: uma linha por chamada do harness e header "Trabalhou por
  Xs"). Cada passo de raciocínio é uma linha `Pensou` recolhível, fechada por
  padrão como as tools. Contrato em `docs/MARKDOWN.md` §10.
- **Testes**: `src/components/chat/Markdown.test.tsx` (matriz funcional, incluindo
  a variante `thinking`), `Markdown.security.test.tsx` (vetores XSS/atributos/URLs
  nas duas variantes), `src/lib/__tests__/agentTrace.test.ts` (Markdown bruto por
  passo) e `src/components/code/CodeTranscriptThinking.test.tsx` (transcript do
  layout Code).

## 9. UI generativa

O agente emite blocos cercados com a linguagem `ui` contendo **um objeto JSON declarativo**. A interface normaliza o JSON e desenha somente componentes da whitelist — **nunca** `eval`, HTML ou JavaScript arbitrário.

O mesmo contrato vale no **Chat e no Code**: o transcript do Code usa o mesmo
renderer e o perfil `code` recebe a seção gerada do contrato + notas específicas
(não duplicar o fecho de arquivos/diff, decisões bloqueantes via `ask_user`,
nada de `ui` dentro do plano).

````
```ui
{ "version": 2, "components": [
  { "type": "card", "props": { "title": "Resumo" }, "children": [
    { "type": "stat", "props": { "label": "Receita", "value": "R$ 12.400" } },
    { "type": "actions", "props": { "items": [
      { "label": "Comparar trimestres", "prompt": "Compare este trimestre com o anterior.", "tone": "primary" }
    ]}}
  ]}
]}
```
````

### Contrato único

A fonte de verdade é **`data/genui-contract.json`** (v2): tipos, props, limites
rígidos, ícones, semântica das ações e as **regras de design** que o agente deve
seguir. Ele é consumido pelos três lados, sem listas duplicadas:

| Consumidor | Uso |
| --- | --- |
| `src-tauri/src/tools/genui` | normalizador + validador + lint + ferramenta `validate_ui` |
| `src-tauri/src/harness/prompt.rs` | gera a seção do system prompt do Chat (catálogo, regras, limites, exemplo) |
| `src-tauri/src/harness/code/prompt.rs` | notas do Code + a mesma seção gerada no system prompt do perfil `code` |
| `src/lib/genui` + `src/components/genui` | normalização/validação defensiva final e renderer |

### Pipeline

1. **Normalização** (determinística, igual nos dois lados): coerções seguras
   (`number`→`text`, string numérica→`number`, enum case-insensitive), formas
   legadas (`labels`+`values`→`data`, `keyvalue` objeto→`items`), truncamento
   de textos/arrays nos limites rígidos, clamp de `progress`/`grid.columns`.
2. **Validação estrutural** contra o contrato: whitelist de 26 componentes
   (`card`, `stack`, `grid`, `tabs`, `reveal`, `section`, `divider`, `table`,
   `chart`, `stat`, `progress`, `timeline`, `steps`, `checklist`, `keyvalue`,
   `list`, `code`, `quote`, `text`, `callout`, `badge`, `image`, `source`,
   `link`, `actions`, `choices`), props obrigatórias/tipos/enums/URLs,
   `children` só em containers, profundidade 8 e 120 nós. Erro → o bloco
   degrada para código com o diagnóstico exato.
   `callout` está **descontinuado** para novas respostas (regra
   `ui.callout-style`): notas/ressalvas vão em Markdown; o componente segue
   renderizando mensagens antigas.
3. **Lint de design**: 30 regras do contrato (hierarquia, densidade, copy
   pt-BR, acessibilidade, interação) viram avisos com `code`/`path`/`hint`.
   Avisos não bloqueiam: a árvore normalizada é renderizada. O máximo de blocos
   por mensagem é orientação do prompt (`blocks.maxPerMessage`), não regra de
   lint por bloco.

### Autovalidação durante a execução

A ferramenta **`validate_ui(block)`** (sempre disponível nos dois perfis; no Code,
exceto no subagente read-only; não conta no orçamento de ferramentas de dados)
recebe o JSON candidato e devolve
`{ ok, summary, errors, warnings, normalized }`. O system prompt instrui o
agente a validar o bloco e emitir só depois de `ok: true` (orientação de até 2
validações por resposta; não há contador imposto pelo harness), corrigindo os
`errors` e os `warnings` de design. O campo `normalized` é o JSON canônico para
a emissão final.

### Interação

`actions` são declarativas e seguras: `prompt` **preenche o composer** (evento
`zylara:suggest`) — nunca envia sozinho — e `copy` copia texto. `choices` é um
formulário de seleção **com estado local** (rádio/checkbox/segmentado, contador
e progresso sincronizados); o botão de envio preenche o composer com
`submitPrefix + seleção`, mantendo a regra de ouro: a interface nunca dispara um
turno sozinha. `tabs` e `reveal` usam Radix/`<details>` do design system; não há
inputs de texto livres dentro da interface (o composer é o único campo de
texto).

### Garantias

`data/genui-fixtures.json` é o corpus de paridade executado por
`cargo test` **e** `pnpm test`: para todos os casos válidos a árvore normalizada
inteira e os códigos de erro/aviso são idênticos nos dois lados (casos com erro
comparam os códigos e a ausência de spec). O renderer valida de novo (defesa em
profundidade), os exemplos de `docs/GENUI.md` são validados por teste e os
prompts do Chat e do Code são gerados a partir do contrato — nenhuma
documentação de UI pode divergir do validador.

Fenced blocks extras com rendering especial: `mermaid` (diagramas), `chart`
(JSON de dados → SVG), `html`/`svg` (preview em iframe sandbox), `ui`.

> Regras completas de UI/UX, catálogo de props e checklist do agente:
> **`docs/GENUI.md`**.

## 10. Anexos

`documents::extract` converte:

| Tipo | Estratégia |
| --- | --- |
| PDF | `pdf-extract` (texto por página) |
| DOCX | ZIP + `quick-xml` (`word/document.xml` → parágrafos, headings, tabelas) |
| PPTX | ZIP + XML (`ppt/slides/*.xml`, notas) |
| XLSX/ODS/CSV | `calamine` (células por planilha) / parser CSV |
| Texto/código/JSON/HTML | detecção de encoding (`chardetng` + `encoding_rs`) |
| Imagens | metadados + base64 (enviadas nativamente se o modelo tem visão) |

Limite de 400k caracteres por documento, truncamento sinalizado. Anexos são copiados para `attachments/` e referenciados por id no payload.

## 11. Artefatos

`create_file` grava o arquivo em `artifacts/<id>/<nome>`, persiste metadados e
emite `artifact_created`. A UI mostra cards compactos no chat (grid de até duas
colunas; acima de 4 artefatos por mensagem aparece o botão **+ Ver todos (N)**,
que abre o painel lateral na lista) e um painel lateral (Canvas-like) com dois
modos: **lista** de artefatos gerados (cards compactos, contador) e **prévia**
por tipo, com navegação e ações "Salvar como…" (dialog nativo) e "Abrir". O
writer é compartilhado com `run_code` (`tools::artifacts`), que aceita **bytes**
— permitindo artefatos binários (PDF/DOCX/XLSX/PPTX/imagens).

O agente consulta a biblioteca de artefatos **do usuário (todas as conversas)**
com as tools `list_artifacts` (lista/pesquisa por nome, título da conversa e
conteúdo textual, com trechos e a conversa de origem) e `read_artifact` (traz o
conteúdo ao contexto; extrai texto de PDF/DOCX/XLSX/PPTX, mostra
metadados/estrutura de imagem, ZIP, áudio, vídeo e binário, e pagina o texto).
O escopo é o usuário, não a conversa (decisão §16 #15): qualquer artefato pode
ser lido, mas a biblioteca expõe apenas artefatos e metadados — nunca mensagens
de outras conversas — e o conteúdo entra no contexto como **dado não confiável**
(nunca como instrução).

**Detecção/reconciliação**: o renderer aplica `artifact_created` em ordem
canônica (`created_at, id` — a mesma de `db::list_artifacts`) e só para a
conversa ativa (eventos de um turno em segundo plano não vazam para outra
conversa). Ao fim de cada turno (`done`/`cancelled`/`error`), ao abrir uma
conversa (mesmo com mensagens em cache), após editar/regenerar e ao excluir a
conversa, o `chatStore.syncArtifacts` refaz a leitura autoritativa
(`list_artifacts`) — um token monotônico descarta respostas fora de ordem e
respostas de uma conversa que o usuário já deixou. Assim, eventos perdidos não
deixam a lista do painel nem os cards do chat desatualizados, e o painel volta
para a lista quando o artefato ativo deixa de existir.

| Tipo | Criação | Preview (v1.5) |
| --- | --- | --- |
| md | `create_file` | Markdown renderizado (GFM/math) + alternância Documento/Código |
| txt/log | `create_file` | código/texto com números de linha e toggle de quebra |
| html | `create_file` | HTML sandbox |
| csv/tsv | `create_file` | tabela com delimitador detectado (`,`/`;`/tab/`\|`) |
| json/jsonl | `create_file` | árvore colapsável + modo código realçado |
| código (30+ linguagens) | `create_file` | syntax highlight Prism (grammars extras), linhas e wrap |
| SVG | `create_file` | SVG sanitizado com zoom/pan/ajuste |
| PDF | `run_code` + skill `pdf` | **pdf.js** (páginas em canvas, zoom e navegação) |
| DOCX | `run_code` + skill `office-docx` | OOXML → HTML (`documents::preview`) em iframe sandbox |
| XLSX | `run_code` + skill `office-xlsx` | grade com abas por planilha (`calamine`) |
| PPTX | `run_code` + skill `office-pptx` | cartões de slide (título + texto, prévia simplificada) |
| PNG/JPG/WebP/GIF/AVIF/BMP/ICO | `run_code` (Pillow quando instalado) | imagem nativa com zoom/pan/xadrez e dimensões |
| TIFF | `run_code` (Pillow) | convertido para PNG no backend (`image`, ≤2560 px) |
| áudio/vídeo | `run_code` | player nativo (mp4/webm/ogg/mp3/wav/…) até 24 MiB inline |
| ZIP | `run_code` | listagem de entradas (até 400) + resumo, sem extração |
| outros contêineres | `run_code` | cartão binário + Salvar/Abrir |
| binários | `run_code` | cartão com formato detectado + hexdump (4 KB) + ações |

As prévias estruturadas vêm do comando `get_artifact_preview` e nunca injetam
HTML do documento sem sanitização (DOCX vira HTML allowlist dentro de iframe
`sandbox`; o PDF é desenhado pelo pdf.js; SVG é sanitizado antes de renderizar).
`get_artifact_content` só transporta payload necessário (texto, PDF, imagem
web-safe, áudio/vídeo ≤24 MiB); Office/ZIP/binário são lidos pelo backend na
prévia. Formatos e limites: `docs/FILES.md` §9.

### 11.1 Página Biblioteca (v1.8)

A página **Biblioteca** (`src/components/library`, view `activeView: 'library'`)
dá ao usuário uma visão única de **todos os artefatos do usuário** — criados
pelo agente em qualquer conversa **e** enviados por ele — com busca (nome, tipo
e título da conversa de origem), filtros por categoria
(Tudo/Favoritos/Imagens/Documentos/Código/Mídia/Outros), ordenação, grade/lista
e prévia por tipo (reaproveitando `ArtifactPreview`). A página fica no lugar da
coluna do chat (mesmo padrão da SkillsView) e é aberta pelo item **Biblioteca**
da sidebar, acima de **Skills**.

- **Envio**: “Enviar arquivos…” (seletor nativo múltiplo; drag & drop com a
  página aberta) importa os arquivos para `artifacts/<id>/` com
  `conversation_id = NULL` e metadados no SQLite. Os limites e a sanitização de
  nome são os mesmos do writer compartilhado (`tools::artifacts`); arquivos
  enviados são **dados do usuário** como qualquer artefato.
- **Gestão**: favoritar/desfavoritar, renomear (arquivo + metadados), “Salvar
  como…”, “Abrir” e excluir com confirmação; miniaturas de imagem são geradas
  no backend (`get_artifact_thumbnail`, PNG ≤512 px) e caem no ícone do tipo
  quando indisponíveis.
- **Agente**: os arquivos enviados entram em `db::list_all_artifacts` e,
  portanto, em `list_artifacts`/`read_artifact` com `conversationId` e
  `conversationTitle` nulos; o prompt documenta a origem “Biblioteca (enviado
  pelo usuário)”. Nenhuma tool nova é necessária.
- **Contrato**: `docs/FILES.md` §14 (v1.8) e
  `docs/goals/library-page/PLAN.md` (plano/evidências).

## 12. IPC

Comandos (todos camelCase no JS):

```
app_info, get_settings, save_settings, set_provider_key, validate_provider,
open_data_dir, reset_app_data, get_catalog, refresh_catalog, list_remote_models,
refresh_provider_models, openai_login_start, openai_login_wait,
openai_login_cancel, openai_sign_out, openai_auth_status,
list_conversations, create_conversation (mode: chat|code), get_conversation,
get_cache_stats,  -- agregado/amostras de cache da conversa (medidor em tempo real)
rename_conversation, delete_conversation, set_conversation_pinned,
set_conversation_code_linked (Chat session → Code),
set_conversation_model (Code: troca o par provedor/modelo da sessão entre turnos),
search_conversations, truncate_conversation, export_conversation, import_attachments, get_attachment,
delete_attachment, list_artifacts, list_library_artifacts, import_library_files,
rename_artifact, set_artifact_favorite, get_artifact_thumbnail,
get_artifact_content, get_artifact_preview,
save_artifact, open_artifact, delete_artifact, get_code_environment,
open_skills_dir, get_skills, set_skill_enabled, delete_skill, get_skill_content,
-- atualizações (v1.12)
update_status, check_for_update (force), get_update_notes (version),
download_update (version, Channel<UpdateEvent>), cancel_update_download,
install_update (version), reveal_update (version),
set_update_preferences (autoCheck), skip_update_version (version?),
mark_update_notified (version), acknowledge_update_result,
run_turn, cancel_turn,
-- harness de código (v1.9): workspace
pick_workspace_folder, add_workspace, list_workspaces, get_workspace_context,
rename_workspace, remove_workspace, set_workspace_trusted,
set_conversation_workspace, open_workspace_in_explorer, list_workspace_files,
search_workspace_files, read_workspace_file,
-- sessão de código
get_code_session_state, set_permission_mode, set_plan_mode, respond_approval,
list_approval_rules, save_approval_rule, delete_approval_rule,
get_workspace_changes, get_file_diff, revert_file, revert_turn, compact_session,
-- objetivo (v1.11, docs/goals/code-goals/PLAN.md §9)
create_goal (input {objective,title?,maxRounds?,autoContinue?}),
update_goal (action edit|arm|disarm|pause|resume|complete|reopen|block|delete,
             input?, expectedRevision? — CAS),
list_goal_rounds (limit? 1..=200), goal_can_continue (auto? — preflight),
list_jobs, get_job_output, kill_job,
-- git (painel)
git_status, git_diff, git_stage, git_unstage, git_discard, git_commit,
git_branches, git_create_branch, git_switch_branch, git_log, suggest_commit_message,
-- terminal PTY
open_terminal, write_terminal, resize_terminal, kill_terminal, close_terminal, list_terminals
```

O login ChatGPT é **em duas fases**: `openai_login_start` devolve
`{ attemptId, authUrl, expiresAt, browserOpened, browserError }` e tenta abrir o
navegador; `browserOpened: false` (com `browserError` redigido, sem a URL)
significa que o opener do sistema falhou e a UI oferece **Copiar link**.
`openai_login_wait` (`async`, até 10 min) resolve quando o callback chega;
`openai_login_cancel` encerra. `refresh_provider_models` devolve o `CatalogView`
mesclado (catálogo + modelos da conta).

## 13. Segurança

- API keys ficam só no backend; o renderer recebe apenas `hasKey`, `masked`, `source`.
- **OAuth ChatGPT**: access/refresh/id tokens também ficam só no backend
  (`secrets.json` v2, 0600, escrita atômica sob um único writer, com lock de
  RMW; arquivo corrompido nunca é sobrescrito — a UI mostra `secretsError`). O
  renderer recebe só `ProviderAuthStatus` (e-mail, ids mascarados, escopos,
  expiração). `state`+PKCE+`nonce` protegem o loopback; o ID token é verificado
  por JWKS; refresh é single-flight e rotativo; sign-out revoga o refresh token e
  mantém apenas o mapping conta/`client_id`. Tokens nunca vão para URL, log,
  localStorage ou mensagens; `id_token_hint` só aparece na URL de authorize
  (redigida em diagnósticos).
- **Harness de código**: confinamento de path ao workspace (`safe_path`), leitura antes da
  escrita com CAS por hash, aprovação interativa para mutações/comandos/segredos, classificação
  de comandos destrutivos (pedem aprovação fora do modo Autônomo), env higienizado
  (`*API_KEY*`/`*TOKEN*`/`*SECRET*` removidos), timeout e kill de árvore, auditoria em
  `code_events`, journal reversível e commit apenas pelo usuário. **Não é sandbox de SO**: no
  Windows não prometemos isolamento de processo/arquivo fora do workspace — a barreira é
  política + confinamento + aprovação (HARNESS.md §4/§13).
- **CSP**: `tauri.conf.json` ainda está com `csp: null` (dívida pré-existente, registrada em
  `docs/goals/code-harness/EVIDENCE.md`); a mitigação atual é não injetar conteúdo remoto no
  webview (arquivos são renderizados como texto sanitizado e HTML/SVG sempre em iframe sandbox).
  Endurecer a CSP é item de hardening separado, com validação manual no app empacotado.
- HTML/SVG de artefatos e blocos `html` rodam em iframe `sandbox="allow-scripts"` sem acesso ao IPC (sem `allow-same-origin`).
- Links externos abrem no navegador padrão via plugin-opener, nunca no webview.
- Markdown com HTML cru passa por sanitizador allowlist (`rehypeSafeHtml`): sem `script`/`style`/`iframe`/eventos/`style` inline, classes e `data-*` fora da allowlist, e URLs restritas a `http(s)`, `mailto:` e âncoras internas. React nunca injeta o markdown via `innerHTML`.
- Toda saída de ferramentas é tratada como dados; o system prompt instrui o modelo a ignorar instruções vindas de páginas web.
- **Execução de código** (`run_code`) é opt-in (default desligado), roda com o
  interpretador e as permissões do usuário (não é sandbox de SO), em workspace
  dedicado, com timeout, cancelamento, teto de saída/arquivos e ambiente sem
  segredos. Riscos e mitigações: `docs/FILES.md` §8.
- **Atualizações**: feed e artefatos só são aceitos sob o prefixo de release do
  repositório oficial (`https://github.com/Hyska-Software/ZylaraAi/releases/`;
  HTTP só em `127.0.0.1` para fixtures de debug), nomes de arquivo são
  validados contra path traversal, o download é limitado a 1,5 GB e o SHA-256
  do `release.json` é conferido durante o stream e **de novo antes de
  executar**. Nenhum binário fora de `<app-data>/updates/<versão>/` e de
  `<app-data>/managed-update/helper/` é executado; o helper só é iniciado por
  **Instalar e reiniciar** e revalida o job e o hash antes de aplicar. A
  instalação nunca acontece sem uma ação explícita do usuário.
- Scripts de skills e código do agente nunca recebem as API keys do app.

## 14. Build

```bash
pnpm install
pnpm typecheck          # TypeScript
pnpm build              # Vite (renderer)
pnpm installer          # build + instalador da plataforma atual
pnpm app:dev            # dev com HMR
```

O instalador é gerado por `scripts/build-installer.mjs` (versão única, build
recente, testes, checksums e manifesto). No Windows o próprio binário roda em
modo setup com UI React; a instalação copia o binário duas vezes
(`Zylara.exe` + `Uninstall Zylara.exe`) e o desinstalador reusa a mesma UI em
modo uninstall, com dados preservados por padrão. macOS usa DMG e Linux usa
`.deb`/`.rpm`/`.AppImage`. Contrato completo: `docs/INSTALLER.md`.

**Atualizações no app** (`src-tauri/src/update/**`): a checagem lê o
`release.json` da release estável mais recente via
`/releases/latest/download/release.json` (sem rate limit; fallback para a API do
GitHub), compara SemVer e guarda o resultado em `<app-data>/updates.json`. O
renderer agenda a checagem ao abrir e a cada 60 min (`useUpdateCheck`), mostra o
chip na title bar e o popover com notas/progresso. O download vai para
`<app-data>/updates/<versão>/`, com SHA-256 conferido durante o stream e de novo
antes de instalar. No Windows a instalação abre o wizard Zylara existente e
encerra o app em seguida; não há execução silenciosa. No Linux x64 e no macOS arm64, uma instalação feita pelo
script gerenciado da release grava `<app-data>/managed-install.json`; quando o
marcador, o destino e o caminho em execução coincidem, o estado `ready` oferece
**Instalar e reiniciar**. O backend revalida o download, grava o job em
`<app-data>/managed-update/job.json`, inicia o helper e encerra o app. O helper
espera o processo sair, substitui o payload (staging/backup) e grava
`result.json`, que a próxima abertura mostra e confirma. Instalações manuais e
o Windows mantêm o fluxo anterior. Contrato e matriz por plataforma:
`docs/INSTALLER.md` §9.

## 15. Verificação (TDD)

A verificação é feita por testes automatizados — unitários e de integração — e por build:

1. **Renderer**: `pnpm test` (Vitest + jsdom) cobre utilitários, catálogo/raciocínio, o **núcleo da UI generativa** (contrato, normalização, lint, fixtures de paridade Rust↔TS, ações interativas, exemplos da documentação, render do bloco `ui` no transcript do Code e a linha `Validou a interface`), sanitização de SVG, parser CSV, o reducer de streaming do `chatStore` (eventos → mensagens → finalização, erro, regeneração, cancelamento, trace ao vivo), a timeline do espaço de pensamento (trace → passos, fallback de mensagens legadas, grupos de ferramentas e componente `AgentSteps`, incluindo a opção de raciocínio recolhido por padrão), o **renderer de Markdown** (matriz CommonMark/GFM, math, notas de rodapé, alertas, HTML sanitizado e vetores de segurança), as **prévias de artefatos** (PDF via pdf.js mockado, DOCX/XLSX/PPTX por JSON/HTML, imagem e fallback binário; e, na v1.5, imagem com zoom/transparência/TIFF-convertido, áudio/vídeo, ZIP, hexdump, Markdown renderizado, árvore JSON, CSV/TSV com delimitador detectado e código com syntax highlight via Prism estendido — `src/lib/highlight`), a **UI de artefatos** (cards compactos, lista e modos lista↔prévia do painel, botão "+" do chat), a **página Biblioteca** (grade/lista, busca, filtros, ordenação, upload, favoritos, rename/exclusão e prévia) e a **detecção/reconciliação de artefatos no store** (eventos filtrados pela conversa ativa, sync autoritativo ao fim do turno/ao reabrir, ordem canônica e proteção contra respostas fora de ordem) e as **fontes/citações** (chips até 8, painel lateral de fontes da conversa, dedupe por URL e abertura no navegador).
2. **Backend**: `cd src-tauri && cargo test --lib` cobre parser SSE, mapeamento de raciocínio por protocolo, **o pipeline/validador/lint da UI generativa em paridade com os mesmos fixtures do renderer**, a ferramenta `validate_ui` (Chat e Code), os prompts gerados do contrato (Chat e Code), o turno Code que valida e emite um bloco `ui`, parsers de busca, extração de texto de PDF/DOCX/XLSX/PPTX/imagem (fixtures reais em `src/documents/testdata`), **prévias DOCX→HTML/XLSX/PPTX**, **prévias v1.5 de imagem (TIFF→PNG real), ZIP (fixtures e truncamento) e binário (hexdump de 4096 bytes)**, SQLite (conversas/mensagens/anexos/artefatos/usage/`trace` + migração de bancos antigos, incluindo os kinds `audio`/`video`/`archive` e, na v1.8, a migração de `artifacts` com `conversation_id` nulo e `favorite`), settings/segredos, exportação, **execução de código (interpretador, timeout, cancelamento, coleta de artefatos, sem interpretador)**, **skills embutidas/usuário (frontmatter, precedência, scripts→preview)** e o **loop do harness** com um provedor falso injetado (`ProviderStreamer`): descarte de narração intermediária, execução de ferramentas no último passo, resposta final forçada, erro do provedor, cancelamento e o trace por passo — incluindo as tools
`list_artifacts`/`read_artifact` (busca/leitura com fixtures reais, biblioteca
global entre conversas — artefatos de outras conversas são listados/lidos com
`conversationTitle`/`currentConversation` — e o teste de loop que prova que o
texto de um artefato de outra conversa chega ao modelo). Na v1.11 cobre também o **sistema de
Goal**: fold/transições/rodadas/interrupção/estol/bloqueio de `harness/code/goal.rs`, validação e
fecho de `goal_round` no harness (recusas antes do provider, origin, `goal_updated`, prompt
estável), a tool `goal` (limites, presentation, ausência em subagente), os comandos IPC
(CAS/idempotência/preflight/degradação de rodada órfã) e a migração de `messages.origin`.
3. **Integração com o gateway real** (testes `#[ignore]`, executados sob demanda): streaming nos 4 protocolos, tool call + replay de `provider_state`, fallback de protocolo, mapeamento de 401, cancelamento e o caso canônico **DeepSeek V4.1 Flash com esforço máximo**.
4. **Build**: `pnpm typecheck`, `pnpm build` e `pnpm tauri build --no-bundle` (artefato em `src-tauri/target/release/zylara.exe`).
5. **Manual (release)**: abrir o app e validar visualmente os fluxos principais.

## 16. Decisões registradas

| # | Decisão | Alternativa descartada | Motivo |
| --- | --- | --- | --- |
| 1 | Harness em Rust | Loop no renderer | streaming robusto, cancelamento, persistência atômica, sem round-trips JS |
| 2 | SQLite | arquivos JSON por conversa | consultas, integridade, busca |
| 3 | Catálogo gerado no build (fallback offline commitado) | hardcode manual | 120+ modelos, dados voláteis |
| 4 | UI generativa declarativa | React dinâmico via eval | segurança e determinismo |
| 5 | Protocolo neutro + adaptadores | SDK único (ai-sdk) | controle de SSE, headers e reasoning por protocolo |
| 6 | Zustand | Redux/Context | leveza e atualizações granulares em streaming |
| 7 | Execução de código **opt-in** com workspace + timeout | execução livre por padrão / sandbox de SO | risco de prompt injection; sandbox completo não cabe no escopo local-first v1 |
| 8 | Skills em arquivos Markdown + scripts | tool nativa por formato Office | extensível pelo usuário, sem pip obrigatório e com instruções versionáveis |
| 9 | Preview de PDF com pdf.js | viewer nativo do WebView2 / conversão via LibreOffice | comportamento igual em Windows/macOS/Linux e testável; sem dependência externa |
| 10 | Prévia de imagem no backend (TIFF→PNG com `image`) e ZIP listado sem extração | conversão no renderer (WASM) / abrir no app externo | WebView não abre TIFF; listar entradas é seguro, barato e cobre `.jar/.epub` |
| 11 | Prism estendido com grammars extras carregadas sob demanda | trocar por Shiki/highlight.js | reaproveita o `prism-react-renderer` já usado no chat e mantém um tema único de tokens |
| 12 | OpenAI via "Sign in with ChatGPT" (plano) + API key, endpoints/perfis no catálogo | OAuth interno do Codex CLI/`backend-api` | caminho documentado para apps OSS, sem headers/tokens internos; o backend `backend-api` não é autorizado a terceiros (ver `docs/research/openai-oauth.md`) |
| 13 | Instância única do app + refresh OAuth single-flight | múltiplas instâncias com refresh rotativo concorrente | refresh token é rotativo; duas instâncias poderiam invalidar a sessão uma da outra |
| 14 | Anthropic via API oficial só com API key (Bearer) + `anthropic-version` como header estático do catálogo | OAuth/assinatura do Claude Code; `x-api-key` embutido no transporte | a Anthropic não tem programa público de login/plano para apps de terceiros (proibido sem aprovação); Bearer é o formato documentado atual e o header versionado é configurável sem código (ver `docs/goals/anthropic-api-provider/PLAN.md`) |
| 15 | Biblioteca de artefatos com **escopo de usuário** (todas as conversas) | escopo por conversa (v1 inicial) | pedido do produto: o usuário precisa reaproveitar arquivos criados em outras conversas como contexto; a exposição é limitada a artefatos/metadados (mensagens de outras conversas continuam privadas) e a leitura é local/read-only |
| 16 | **Página Biblioteca** no lugar do chat (como Skills) + upload do usuário para a biblioteca (`conversation_id NULL` no mesmo `artifacts`) + favoritos/rename | página separada de "arquivos enviados" com tabela própria; pastas/coleções | o usuário precisa de uma visão única dos seus arquivos e o agente precisa do mesmo caminho de leitura; usar a tabela existente evita segunda fonte de verdade, e `Option<conversation_id>` preserva a proveniência sem inventar conversa sintética. Pastas/edição de conteúdo ficam para v2 (pedido não as exige) |
| 17 | **Sessões separadas por layout** (`conversations.mode`) + vínculo explicitamente compartilhado (`code_linked`) | uma única lista de conversas filtrada por “origem” no renderer sem coluna nova / workspace tables | os modos são produto distintos: o Chat não deve ver sessões do Code e vice-versa, mas o usuário precisa poder promover uma sessão do Chat ao Code compartilhando a **mesma** conversa; duas colunas aditivas guardam a intenção sem duplicar mensagens/artefatos e a migração deixa todo o histórico existente no Chat (docs/goals/chat-code-sessions/PLAN.md) |
| 18 | **Harness de código nativo** (perfil `code` do mesmo loop), não orquestração de CLIs externos | daemon + Codex/Claude Code (modelo Paseo) | o Zylara já é dono do loop/histórico/provedores; um runtime próprio evita dependência de CLIs instalados e mantém o estado (SQLite + `provider_state`) sob controle. O seam `agent_kind` deixa a porta aberta para ACP no futuro (docs/goals/code-harness/PLAN.md §3 D1) |
| 19 | **Workspace = pasta real do usuário**, git opcional, 1 workspace ↔ N sessões | pasta gerenciada no app-data / worktree por tarefa | ninguém trabalha num repo espelhado; o journal cobre diff/revert sem git e worktrees ficam para v2 (Windows + build compartilhado desencorajam paralelismo no mesmo repo) |
| 20 | **Permissões por modos + regras**, confinamento de path e aprovação interativa; **sem prometer sandbox de SO** no Windows | AppContainer/token restrito como requisito da v1 | Windows não tem equivalente barato a Seatbelt/Landlock; a barreira honesta é política + path jail + auditoria + kill de processo. Sandbox nativo (token/ACL/AppContainer) é spike de v2 (docs/research/workspace-runtime-options.md §4) |
| 21 | **Git via CLI do usuário** (porcelain v2) com trait futuro para backend nativo | libgit2/gix como backend principal | hooks, filtros, LFS, `core.autocrlf`, credential manager e worktrees se comportam como o usuário espera, sem dependência nativa; o painel usa o mesmo status/diff do terminal |
| 22 | **Journal de arquivos por hash** (checkpoint por turno) + commit só pelo usuário | auto-commit a cada edição (Aider) / snapshot completo do workspace | reversibilidade sem poluir o histórico do git e com custo proporcional aos arquivos tocados; o commit continua sendo uma decisão humana no painel (HARNESS.md §7.4/§9) |
| 23 | **Compromisso de docs/evidência**: toda fase do harness entra com testes e `EVIDENCE.md` atualizado | implementar sem registrar decisões | o repo usa TDD e evidência por objetivo; o harness mexe em dinheiro/arquivos do usuário, então cada incremento precisa de prova executável |
| 24 | **Objetivo persiste em `code_events`** (`goal/state` + rodadas), rodada = turno normal com `turnKind=goal_round`, driver de rodadas no renderer e `messages.origin` aditivo | tabela `goals` própria, segundo loop de agente, round driver process-wide (DSH) | mantém a projeção única/append-only já usada por plano/tarefas, reaproveita streaming/aprovações/replay/journal (sem daemon nem transporte paralelo), preserva o prefix cache (estado só no runtime context) e torna a rodada automática honesta no transcript; retomada após reinício é sempre decisão do usuário (docs/goals/code-goals/PLAN.md §4) |
| 25 | **UI generativa também no perfil Code** (mesmo contrato + `validate_ui` no catálogo; notas específicas no prompt) | manter GenUI só no Chat | o renderer já é compartilhado e o agente de código produz evidência estruturada (checks, métricas, comparação, achados); o custo é uma tool a mais no catálogo e uma seção gerada no snapshot congelado, com testes de catálogo/prompt/execução/render (docs/GENUI.md) |
