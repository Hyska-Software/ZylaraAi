# ACP Registry — pesquisa e baseline

> Data de referência: **2026-11-24**. Este arquivo registra as fontes oficiais e o
> estado do repositório usados para escrever `PLAN.md`. Não é evidência de
> implementação ACP; é a base de análise do planejamento.

## 1. Fontes oficiais

| Fonte | URL | Uso no plano |
| --- | --- | --- |
| ACP Registry | <https://agentclientprotocol.com/get-started/registry> | Descoberta e instalação de agentes |
| Registry JSON | <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json> | Contrato programático do catálogo |
| Registry schema | <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.schema.json> | Validação do wrapper agregado |
| Agent schema | <https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json> | Validação de cada entrada |
| Registry RFD | <https://agentclientprotocol.com/rfds/acp-agent-registry> | Formato, autenticação obrigatória e distribuição |
| ACP v1 overview | <https://agentclientprotocol.com/protocol/v1/overview> | JSON-RPC, papéis e ciclo de vida |
| ACP v1 initialization | <https://agentclientprotocol.com/protocol/v1/initialization> | Negociação de versão e capabilities |
| ACP v1 authentication | <https://agentclientprotocol.com/protocol/v1/authentication> | `authenticate`, terminal auth e `logout` |
| ACP v1 session setup | <https://agentclientprotocol.com/protocol/v1/session-setup> | `session/new`, `load`, `resume`, `close`, roots e system prompt |
| ACP v1 prompt turn | <https://agentclientprotocol.com/protocol/v1/prompt-turn> | Streaming, updates, usage, notices, compaction e stop reasons |
| ACP v1 content | <https://agentclientprotocol.com/protocol/v1/content> | Texto, imagem, áudio, resource e resource link |
| ACP v1 tool calls | <https://agentclientprotocol.com/protocol/v1/tool-calls> | Tools, diffs, terminais e permissões |
| ACP v1 file system | <https://agentclientprotocol.com/protocol/v1/file-system> | `fs/read_text_file` e `fs/write_text_file` |
| ACP v1 terminals | <https://agentclientprotocol.com/protocol/v1/terminals> | `terminal/create/output/wait_for_exit/kill/release` |
| ACP v1 elicitation | <https://agentclientprotocol.com/protocol/v1/elicitation> | Form mode e URL mode |
| ACP v1 session config | <https://agentclientprotocol.com/protocol/v1/session-config-options> | Modelo, modo, thought level e opções booleanas |
| ACP v1 slash commands | <https://agentclientprotocol.com/protocol/v1/slash-commands> | Comandos anunciados pelo agente |
| ACP v1 subagents | <https://agentclientprotocol.com/protocol/v1/subagents> | Sessões filhas e mensagens entre sessões |
| ACP v1 transports | <https://agentclientprotocol.com/protocol/v1/transports> | stdio newline-delimited JSON-RPC |
| ACP v1 security | <https://agentclientprotocol.com/protocol/v1/security> | Modelo de confiança e conteúdo não confiável |
| Rust SDK | <https://agentclientprotocol.com/libraries/rust> | SDK oficial para cliente Rust |
| ACP v2 preview | <https://agentclientprotocol.com/announcements/acp-v2-preview> | Decisão de adiar v2 |

## 2. Snapshot do Registry

Consulta executada contra o endpoint oficial em 2026-11-24:

```text
registry version: 1.0.0
agents: 46
distribution entries: npx=23, binary=24, uvx=2
platform artifacts: windows=33, darwin=47, linux=63
binary artifacts without sha256: 37
binary agents with no checksum on any platform: 5
```

Agentes sem checksum em nenhum artefato binário:

```text
cortex-code, corust-agent, cursor, devin, junie
```

O schema torna `sha256` opcional. Portanto, o instalador não pode presumir que
todo binário tem hash. O plano adota verificação obrigatória quando o hash existe
e confirmação explícita + pinning local do hash calculado quando não existe.

O Registry exige que cada agente anuncie pelo menos um método de autenticação no
handshake ACP. O catálogo não contém tokens, credenciais nem capabilities de
protocolo; essas informações são descobertas por `initialize`.

## 3. Contrato ACP estável

- ACP v1 é o baseline estável.
- ACP v2 está em **Preview** desde 2026-11-20; não deve ser o caminho padrão da
  primeira entrega.
- Transporte estável: subprocesso + stdio, JSON-RPC 2.0 UTF-8, uma mensagem por
  linha. `stderr` é apenas diagnóstico; `stdout` só pode conter ACP.
- Fluxo: `initialize` → autenticação opcional → `session/new` ou
  `session/load`/`session/resume` → `session/prompt` → `session/update` → resposta
  com `stopReason`.
- Cancellation: `session/cancel`; o cliente responde `cancelled` a permissões
  pendentes.
- Erros ACP relevantes: `-32000` auth obrigatória, `-32002` recurso/sessão
  desconhecida, `-32601` método ausente, `-32602` parâmetros inválidos e `-32800`
  request cancelado.
- ACP não cria sandbox. O agente roda com as permissões do processo. Permissões
  são consultivas para operações feitas pelo próprio agente; o cliente é
  responsável por validar `fs/*` e `terminal/*`.

## 4. SDK Rust oficial

Em 2026-11-24, o crates.io publica `agent-client-protocol` **5.6.0**:

- MSRV: Rust 1.88 (o projeto exige 1.89).
- Features default vazias.
- `process`: launcher nativo do SDK.
- `stdio`: adapter nativo.
- `unstable_protocol_v2`: API v2 Preview.
- `ByteStreams` e `Lines` estão disponíveis sem features nativas.
- A conexão MCP-over-ACP in-process (`Builder::with_mcp_server`) fica atrás da
  feature **unstable** `unstable_mcp_over_acp`. O caminho estável é declarar um
  servidor MCP stdio em `session/new.mcpServers`.

Decisão do plano: usar os tipos/traits/session APIs estáveis do SDK, mas alimentar
`Lines` com um codec newline delimitado e limitado do próprio Zylara. O launcher
  `process` do SDK não mata a árvore no Windows; o app já possui Job Object/kill de
  árvore em `workspace/exec.rs`, que deve continuar sendo a autoridade de processo.

## 5. Baseline do repositório

### Estado da árvore

```text
git status --short -> limpo (antes da criação desta pasta de planejamento)
```

### Verificações executadas

| Comando | Resultado observado |
| --- | --- |
| `pnpm typecheck` | Passou |
| `cargo check` | Passou com 205 warnings preexistentes |
| `pnpm test` (120 s) | Interrompido pelo timeout; 8 falhas visíveis antes do fim |
| `pnpm exec vitest run --reporter=dot` (600 s) | **3288 passed; 8 failed; 4 arquivos falharam** (330,04 s) |
| `cargo test --lib` (120 s) | Interrompido pelo timeout durante compilação/execução |
| `cargo test --lib` (600 s) | **1688 passed; 0 failed; 22 ignored** (66,54 s) |

Falhas Vitest visíveis no baseline:

```text
src/lib/__tests__/modelMenu.test.ts                 2
src/lib/__tests__/sessionCost.test.ts               1
src/components/code/CodeAgentWidgets.test.tsx      4
src/components/models/ModelPill.edge.test.tsx      1
Total                                               8
```

Essas falhas são preexistentes e devem ser tratadas em trabalho separado ou
registradas como baseline permitido. A entrega ACP precisa provar que não aumenta
esse conjunto.

### Evidências de arquitetura no código

- `src-tauri/src/domain.rs:63-65`: `Conversation.agent_kind` já existe e está
  documentado como reservado para `acp:<agente>`.
- `src-tauri/src/db.rs:11852-11858`: teste já persiste e relê `acp:codex`.
- `src-tauri/src/commands/turn.rs:47-125`: todo turno interativo passa por
  `register_turn_if_idle`, `PersistingEmitter` e `harness::run_turn`.
- `src-tauri/src/providers/mod.rs:171-409`: o caminho atual é um completion HTTP
  de um passo (`ProviderConfig`, `CompletionRequest`, `ProviderEvent`), não um
  runtime de sessão com tools/permissões.
- `src-tauri/src/events.rs:18-227`: o app já possui eventos neutros para texto,
  raciocínio, tools, usage, aprovações, perguntas, plano, contexto e compactação.
- `src/lib/types.ts:1761-1762`: o renderer já conhece `agentKind`.

## 6. Conclusão da análise

ACP não deve ser implementado como mais um `ProviderInfo` HTTP. Isso forçaria o
runtime externo a caber em um único `CompletionRequest` e perderia sessão,
autenticação, permissões, tools e resume próprios do agente.

O caminho correto é um **segundo runtime de turno**, selecionado apenas quando
`conversation.agent_kind` começa com `acp:`. O runtime nativo continua chamando
`harness::run_turn` exatamente como hoje. O runtime ACP traduz a sessão externa
para os mesmos eventos e persistência do app.
