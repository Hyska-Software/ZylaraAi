# Provedores ACP — comparação Zylara × Paseo, achados e plano de correção

**Data:** 2026-11-25.
**Referência:** Paseo `getpaseo/paseo` @ `e51bb7b` (clone local em `.research/paseo-src`,
ignorado pelo git). Zylara = estado atual de `main` nesta árvore.
**Objetivo:** comparar as duas implementações ponto a ponto, achar problemas/inconsistências
no Zylara — em especial a integração da UI com a execução do agente ACP — e corrigir tudo
que for defeito verificável. Este documento é o plano; `EVIDENCE.md` continua como o
registro do que já estava implementado.

---

## 1. Metodologia e fontes

- Backend Paseo: `packages/server/src/server/agent/providers/acp-agent.ts`,
  `generic-acp-agent.ts`, `provider-launch-config.ts`, `provider-registry.ts`,
  `provider-installation/*`, `packages/plugin/src/server/acp-internal/connection.ts`.
- UI Paseo: `packages/app/src/data/acp-provider-catalog.ts`,
  `hooks/use-acp-provider-catalog.ts`, `provider-settings/internal/*`,
  `provider-selection/provider-selection.ts`, `components/message.tsx`,
  `components/plan-card.tsx`, `agent-stream/view.tsx` (permissões), `composer/*`.
- Backend Zylara: `src-tauri/src/acp/**`, `commands/acp.rs`, integração em
  `harness/mod.rs`, `providers/mod.rs`, `commands/turn.rs`, `state.rs`, `db.rs`.
- Renderer Zylara: `src/lib/{api,types,modelMenu}.ts`, `src/lib/store/{appStore,chatStore}.ts`,
  `src/components/settings/Acp{AgentPanel,RegistryDialog}.tsx`, i18n nos 3 idiomas.
- Cada achado abaixo tem evidência em código (não documentação) e foi confirmado por leitura
  direta nesta árvore. Testes do Paseo foram usados apenas para confirmar intenção.

## 2. Matriz de comparação (resumo)

| Dimensão | Paseo | Zylara | Veredito |
| --- | --- | --- | --- |
| Catálogo | estático, com `command/env/params`, 1 clique, **sem download pelo app**; update via CLI do próprio agente | Registry oficial com 46 agentes, download+sha256, consentimento, detection por PATH, ETag no `fetch` mas não usado | Zylara mais forte em instalação verificada; falta ETag/update status e transparência do comando no diálogo |
| Execução | 1 subprocesso por sessão, NDJSON, `initialize`, `newSession`/`loadSession`/`resumeSession`, `listSessions`, cancel, close | 1 subprocesso por conversa, SDK ACP 5.6.1, v1 com fallback v2, `session/new|load|resume|close`, kill tree, TTL/limite | Paridade funcional no essencial; Zylara tem v2 e auth que o Paseo não tem; falta listagem/importação de sessões (lacuna de paridade, não defeito) |
| Auth | `authMethods` não é usado; erro `-32000` é só mensagem | `authenticate`, login agent/terminal, logout, estado persistido | Zylara à frente |
| Permissões | opções mapeadas por `behavior`, `selectedActionId` honrado, chooser, deny+interrupt, cancel no fim do turno | `PermissionOption.kind`, gate via `policy::decide` + `ApprovalRegistry`, mas **sempre escolhe `allow_once`/`reject_once`** | defeito: escolha "sempre" do usuário ignorada + eventos do gate com `turnId` sintético (UI não vê) |
| Elicitação/fs/terminal | sem elicitação ACP; `fs/*` e terminal com output limitado | elicitação com formulário, `fs/*` com safe_path, terminal one-shot; **resposta de opções ignorada** | defeito no Zylara (selected vs custom) |
| Eventos | texto/raciocínio/tool/plan/usage/status normalizados; plan vira card | mesmos eventos via `ProviderEvent`/`TurnEvent`; plan/compaction/notice **sem consumidor no renderer** | defeito de UI no Zylara |
| Ferramentas do agente | o CLI é dono das tools; daemon só normaliza | agente ACP é dono, **mas o harness reexecuta as tool calls localmente** | defeito crítico no Zylara |
| Modelos/config | `models.availableModels`, `thought_level`, modos, comandos, stale-value tolerance | `configOptions` `category:model`, `thought_level`, apply_model/apply_thinking; sem modos/slash commands | paridade parcial; defeitos no probe e no update de modelos |
| Seletor UI | combinado provider+modelo, gear para settings, modos separados, steer/queue/cancel | mesmo seletor (D13), badge ACP, reasoning probe; sem modos/steer | base correta; falta feedback de auth/update no composer |
| Instalação → uso | Add grava config e **faz probe imediato** | install só grava a linha: sem modelos, `auth_state=unknown`, composer bloqueia o envio | defeito crítico no Zylara |

## 3. Achados (correções obrigatórias nesta entrega)

| ID | Severidade | Achado (evidência) | Correção |
| --- | --- | --- | --- |
| F1 | Crítico | `harness/mod.rs:3690-3778` transforma `ToolCallStart/Args/Done/Finished` do ACP em `step_calls` e chama `execute_tools`: a tool que o agente já executou é executada de novo, com efeitos colaterais duplicados e segundo `ToolCallFinished` (`:3802`). | Marcar o turno ACP, guardar o resultado já emitido em `StreamingToolCall` e, em vez de `execute_tools`, converter as chamadas em `ToolOutcome` sem reexecução, sem reemissão de eventos duplicados. |
| F2 | Crítico | `acp/host.rs:62-91` (`IpcEmitter`) emite aprovações/elicitação/`FileChanged` com `turnId = "acp-<conv>-<agente>"` e `seq` próprio; `chatStore.ts:1615-1616` descarta qualquer envelope cujo `turnId` difira do turno ativo. O gate de permissão nunca aparece e a resposta espera até o timeout. | Registrar o `EventEmitter` real do turno em `acp::host`, ligado em `commands/turn.rs` (mesmo `Arc` do `PersistingEmitter`, `turn_id` real, `seq` compartilhado) e removido ao final; manter fallback sintético apenas para probes sem turno. |
| F3 | Crítico | `commands/acp.rs:141-214` salva o agente sem probe: `acp_models` fica vazio, `default_model_id=""` (`acp/mod.rs:480`), `providerReady` exige `authState` pronto (`appStore.ts:675-688`). Agente instalado não consegue iniciar turno até boot scan/teste manual. | Fazer probe após a instalação, persistir modelos (com fallback "default") e auth state, devolver a view já pronta; falha do probe não desfaz a instalação. |
| F4 | Alto | `session.rs:845` calcula `fresh = session_id.is_empty()` **depois** de `session/new` (`833-844`) — sempre `false`; o resumo de histórico de D5 nunca é enviado. | Calcular `fresh` no momento da decisão de resume/new e cobrir com teste de integração. |
| F5 | Alto | `client.rs:203-208` lê `value.result.sessionId`, mas a resposta de `session/new` é plana (`session.rs:837-843`): `session/set_config_option` do probe usa `sessionId=""`. | Ler `value.sessionId` com fallback tolerante; teste unitário. |
| F6 | Alto | `host.rs:398-413` usa apenas `answer.custom`; o campo `AskUserAnswer.selected` é descartado → elicitação responde string vazia quando o usuário escolhe opções. | Usar `selected` quando presente, `custom` como complemento; serializar múltiplas escolhas; teste. |
| F7 | Alto | `host.rs:220-253` + `PermissionPicker::allowed/rejected` (`:288-309`) ignoram `outcome.scope` e devolvem sempre `allow_once`/`reject_once`. | Escolher `allow_always` quando o usuário approved com escopo `session/workspace/global`; `reject_always` no counterpart; teste. |
| F8 | Médio | `harness/mod.rs:722-740` procura `configId`/`id` no topo do `config_option_update`, cujas opções vêm em `configOptions[]`; `ConfigOptionUpdated` nunca é emitido. Além disso `acp_models_replace` só roda em `acquire`/probe, então `reloadCatalog()` não vê novos modelos. | Emitir um evento por opção alterada e fazer `chatStore` pedir re-probe ACP (novo comando leve) em vez de só recarregar catálogo estático. |
| F9 | Médio | `events.rs:239-242` define `AcpPlan`/`AcpCompaction` e `Notice`, mas `chatStore.ts:1510-1512` ignora `notice` e não há caso para plan/compaction (somente `types.ts:2106`). | Exibir notice/plan/compaction por toast i18nificado no fluxo local e externo; manter fora do histórico de mensagens. |
| F10 | Médio | `commands/acp.rs:51-89` ignoram o ETag devolvido por `registry.rs:113-148` e não comparam versão instalada vs Registry; diálogo não mostra `command/args/envNames` apesar do consentimento. | Guardar/reutilizar ETag, expor `update_available` e `command/args/envNames` em `AcpRegistryAgent`, mostrar no diálogo e habilitar reinstalação de atualização. |
| F11 | Médio | `commands/models.rs:753-763` chama `fetch_remote_models` para ACP (base_url vazia) em vez de usar modelos descobertos. | Branch ACP devolvendo ids de `acp_models` ou erro explícito. |
| F12 | Médio | `commands/acp.rs:461-470` compõe caminho de log com `conversation_id` do renderer sem sanitizar; `session.rs:517-524` já tem `safe_log_name` (privado). | Tornar `safe_log_name` público e usar nos dois lugares. |
| F13 | Médio | Erros ACP hardcoded em inglês (`client.rs:29,34,53`, `session.rs:836`, `commands/acp.rs:142,159`, `mod.rs:419`) e `protocolLabel` (`modelMenu.ts:727-739`) não traduz `acp`. | Chaves i18n `acp.errors.*` nos 3 idiomas + `models:protocols.acp`. |
| F14 | Baixo | Código morto: `db.rs:3304` (`acp_event_append`, tabela `acp_events` nunca escrita), `client.rs:541-545` (`cancel` sem chamador), `AcpManager::close_all` sem chamador, `agents.acp_agent_id` sem leitura/escrita. | Remover writer/alias/coluna morta e o `cancel` redundante (o cancelamento já vai pelo `CancellationToken` do turno); manter `close_all` do manager apenas se usado, senão remover. |
| F15 | Baixo | `appStore.ts:74` default `trusted=false` no fallback `deriveAcpAgents`, contrariando D9 (novos agentes nascem confiáveis); backend sempre envia `acpAgents`, mas o fallback pode pintar agentes como não confiáveis. | Alinhar default a `true` e observar capabilities do provider quando disponíveis. |

## 4. Lacunas de paridade com o Paseo — documentadas, não confundidas com defeito

- `listSessions`/importação de sessões do agente, `available_commands_update` como slash commands,
  modos/perfil por sessão, steering/fila e subagentes cross-provider do Paseo não existem no
  Zylara. São features novas com contrato próprio (PLAN §5.8/v2), não regressões do ACP.
- `fs/*`/terminal do plugin SDK do Paseo são mais limitados que o Zylara; não há elicitação ACP no Paseo.
- Terminal ACP no Zylara é one-shot (EVIDENCE registra o desvio); Paseo mantém processo por terminal.
- Auth do agente, verificação sha256 e capabilities confiáveis são implementações **exclusivas** do Zylara.

## 5. Ordem de implementação e verificação

1. **Backend — execução e eventos (F1, F2, F4–F7, F12, F14)**: alterações em `harness/mod.rs`,
   `acp/{host,session,client,mod}.rs`, `commands/{turn,acp,models}.rs`. Compilar com
   `cargo check` e cobrir com `cargo test --lib acp::` + testes de harness existentes.
2. **Backend — catálogo/instalação/i18n (F3, F8, F10, F11, F13, F15)**: `commands/acp.rs`,
   `acp/registry.rs`, `acp/mod.rs`, `commands/models.rs`, locales Rust, `modelMenu.ts`/locales TS.
3. **Renderer (F2, F8, F9, F10, F13, F15)**: `chatStore.ts`, `appStore.ts`, `AcpRegistryDialog.tsx`,
   `ProviderGlyph`/i18n; testes Vitest para cada comportamento novo.
4. **Documentação**: atualizar `EVIDENCE.md` com esta comparação e as correções; remover
   afirmações que o código não sustenta.
5. **Verificação final**: `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`,
   `cargo check`, `cargo test --lib acp::`, `cargo test --lib`. Falhas pré-existentes
   listadas em `EVIDENCE.md` são mantidas como base, não atribuídas a esta mudança.

## 6. Critérios de aceitação

- Agente ACP instalado aparece com modelo padrão e estado de auth correto **sem** boot scan manual.
- Turno ACP não executa ferramenta alguma no harness; cada tool call do agente aparece uma única vez.
- Aprovação/pergunta do agente ACP chega ao renderer com o `turnId` do turno ativo e é respondida;
  a escolha "sempre" é propagada ao ACP.
- Plano, compactação e avisos do agente aparecem na UI sem virar mensagem no histórico.
- Sessão nova recebe o resumo de histórico limitado; sessão retomada não recebe.
- Registry usa ETag, mostra comando/args/env e sinaliza atualização disponível.
- Nenhum `todo!()`/`unimplemented!()` novo; todos os testes ACP seguem passando.
