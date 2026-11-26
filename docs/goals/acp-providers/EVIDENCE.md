# Provedores ACP — evidência de implementação

Data: 2026-11-25.

## Escopo implementado

- **Registry**: `src-tauri/src/acp/registry.rs` (fetch com ETag, validação por entrada, seleção de
  distribuição, conversão para `AcpRegistryAgent`, snapshot embutido), `scripts/build-acp-registry.mjs`
  e `data/acp-registry.json` (46 agentes reais, gerado do CDN oficial).
- **Instalação**: `src-tauri/src/acp/install.rs` — download, sha256 antes da extração, zip/tar.gz,
  anti-traversal/ADS/symlink, limites de tamanho/ratio, extração atômica, npx/uvx.
- **Runtime**: `src-tauri/src/acp/{client,session,mapping,host}.rs` — SDK oficial
  `agent-client-protocol` 5.6.1 sobre pipes endurecidos, v1 com negociação v2, sessões persistidas,
  `session/update → ProviderEvent`, permissões/elicitação/fs/terminal/MCP, cancelamento e kill tree.
- **Integração**: `ProviderTransport` em `ProviderInfo`, `WireProtocol::Acp`, 5 novos
  `ProviderEvent`, novos `TurnEvent`, `AppState.acp`, mesclagem de `acp_models` no catálogo,
  comandos Tauri em `commands/acp.rs`, branches ACP em settings/catalog.
- **Renderer**: tipos/wrappers/store, painel de agentes ACP, diálogo do Registry, i18n nos 3
  idiomas e o agente ACP aparece no **mesmo** seletor (`ModelPill`/`ModelPickerDialog`) — sem
  seletor separado.
- **Dados**: tabelas `acp_agents`, `acp_sessions`, `acp_models`, `acp_registry_cache`, `acp_events`
  e coluna aditiva `agents.acp_agent_id`. Turnos ACP gravam
  `conversations.agent_kind = 'acp:<registry-id>'` no harness.
- **Testes ACP**: fixture `src-tauri/src/acp/testdata/fake-agent.mjs` (agente JSON-RPC determinístico),
  teste de integração initialize → session/new → session/prompt → `ProviderEvent` e smoke
  `#[ignore]` contra o Registry real.
- **Correção pós-entrega**: `acp_install_agent` e `acp_add_custom_agent` esperavam um único objeto
  (`req`/`input`) enquanto o renderer envia argumentos achatados; as assinaturas Rust foram
  achatadas e `src/lib/__tests__/acpApi.test.ts` fixa o contrato IPC.
- **Correção de spawn no Windows**: `launch_program` (`acp/mod.rs`) prefere `npx.cmd`/`uvx.cmd`
  ao resolver agentes `npx`/`uvx`; antes, o shim sem extensão (script de shell) era escolhido e
  `Command::new` falhava. Erros de `acp_auth_status`/`acp_auth` agora incluem a causa raiz (`{e:#}`).
  Teste `package_agents_prefer_native_shims_on_windows` verifica a resolução.
- Limites de conexão ampliados para conexões lentas: `PROBE_TIMEOUT` e `INIT_TIMEOUT` passaram de
  30 s/20 s para **2 minutos** (`client.rs`, `session.rs`). O timeout de login terminal (10 min) e a
  graça de cancelamento (3 s) permanecem inalterados.
- Padrões de confiança alterados a pedido: novos agentes (Registry, npx/uvx e manuais) nascem com
  `trusted`, `supports_fs`, `supports_terminal` e `supports_elicitation` ativados. Uma migração
  única (`meta.acp_defaults_v1`) aplica os mesmos padrões a agentes já instalados sem sobrescrever
  mudanças futuras do usuário. `PLAN.md` D9 e `MODELS.md` refletem a decisão revisada.
- Ícones do Registry: download e validação do SVG monochrome no install, storage em
  `<data>/acp/icons/<id>.svg`, exposição como `iconSvg` em `ProviderInfo`/`AcpAgentView` e
  renderização pelo mesmo `ProviderGlyph` dos provedores HTTP (settings, painel ACP e diálogo do
  Registry). Agentes instalados antes dessa mudança recebem o ícone via backfill em
  `acp_list_registry`. Fallback para iniciais se o SVG for inválido.
  A lista de agentes disponíveis também recebe `iconSvg`: `acp_list_registry` cacheia os SVGs de
  todos os manifests (até 8 downloads em paralelo) e devolve o conteúdo validado para o diálogo do
  Registry. Nas cargas seguintes os arquivos já estão em disco.

## Verificações executadas

| Comando | Resultado |
| --- | --- |
| `node scripts/build-acp-registry.mjs --check` | `acp-registry OK (46 agents)` |
| `pnpm test:scripts` | 20/20 testes passaram (inclui `acp-registry.test.mjs`) |
| `pnpm typecheck` | sem erros |
| ACP component/store tests (Vitest) | 4 arquivos, 19 testes passaram |
| `cd src-tauri && cargo check` | `Finished dev profile` (sem erros) |
| `cd src-tauri && cargo test --lib acp::` | 35/35 testes (1 smoke `#[ignore]`) |
| `pnpm test` (suíte completa) | 3315/3323 passaram; 8 falhas pré-existentes não-ACP |
| `cd src-tauri && cargo test --lib` (suíte completa) | 1717/1724 passaram; 7 falhas pré-existentes não-ACP |

## Observações

- `pnpm i18n:check`: chaves ACP passam. Restam 7 literais em português em arquivos **não ACP**
  (`db.rs`, `providers/{mod,anthropic,openai_responses}.rs`) que já existiam antes desta mudança.
- Suíte completa do renderer: as 8 falhas restantes são pré-existentes e não relacionadas a ACP
  (preços em `data/catalog.json` divergem de fixtures de `modelMenu`, `sessionCost` e
  `CodeContextMeterChip`; um teste de largura do `ModelPill`). Antes da correção dos testes ACP a
  suíte tinha 13 falhas (5 delas dos novos componentes/store ACP).
- Suíte completa do backend: as 7 falhas restantes são pré-existentes em `plugins::tests`
  (assinatura do registry de plugins) e `tools::{genui,pipeline}` (fixture/ordenação de JSON),
  nenhuma em módulos ACP. Antes da correção dos testes ACP eram 12 falhas (5 ACP).

## Desvios documentados do plano

- Elicitação URL emite `TurnEvent::Notice` e recusa a operação com segurança (sem bridge de consentimento
  com `plugin-opener`); nenhum segredo é enviado ao renderer.
- `terminal/*` do ACP v1 usa execução one-shot via `workspace::exec::run`; não há shells PTY persistentes
  por terminal ACP.
- Servidores MCP passados ao agente são somente stdio, a partir da configuração já aprovada do app.
- Kill de árvore usa helper local (o `workspace::exec::kill_process_tree` é privado ao módulo).
- `agents.acp_agent_id` existe como coluna aditiva; a seleção do agente ACP para uma persona usa o
  `provider_id = acp__…` no seletor comum (conforme D13 — um único seletor).
