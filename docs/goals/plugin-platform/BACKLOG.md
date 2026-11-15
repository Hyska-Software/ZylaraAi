# Plataforma de plugins — backlog

> Status: **proposta, não implementado**.
> Base: análise técnica do repositório em 2026-11-10.
> Issue épico: [#3](https://github.com/Hyska-Software/ZylaraAi/issues/3).
> Este documento é a fonte do issue épico no GitHub. Atualize os dois juntos.

## 1. Objetivo

Permitir que plugins de terceiros instalados em runtime:

1. alterem a interface (slots, views, componentes, temas e, no nível trusted, o shell);
2. adicionem comandos, abas de configuração, atalhos e viewers de artefatos;
3. adicionem tools, skills e seções de prompt ao agente;
4. adicionem provedores OpenAI-compatible declarativos;
5. sejam instalados, atualizados, desabilitados, auditados e removidos por uma loja assinada.

O objetivo de produto é ter um ecossistema comparável a extensões de editores de código, mas com uma regra central: **código não confiável nunca roda na webview principal**.

## 2. Decisão de arquitetura

### 2.1 Três níveis de plugin

| Nível | Runtime | Pode alterar | Segurança | Canal |
|---|---|---|---|---|
| **Declarativo** | manifesto + host renderiza | botões, comandos, abas, temas, i18n, settings, skills | alta: nada executa no host | loja pública |
| **Sandboxed** | iframe `sandbox` + backend JS oculto | UI própria em slots/views, lógica JS, tools | média: RPC mediado e auditado | loja pública |
| **Trusted** | módulo JS na webview principal + sidecar opcional | qualquer componente, layout, stores, DOM, IPC, CSS global | usuário confia totalmente | sideload ou loja curada |

**Controle total é a lane Trusted.** As lanes Declarative e Sandboxed cobrem a maioria dos plugins e são as únicas que devem entrar na loja pública sem revisão manual. Se a loja aceitar Trusted sem revisão, ela vira um vetor de malware com acesso a conversas, artefatos, workspaces e gasto de tokens.

### 2.2 Invariantes de segurança

- Nenhum JS não confiável na webview principal. A fronteira é iframe ou processo.
- Nenhum plugin recebe um `invoke` genérico para comandos do app. O broker expõe APIs estreitas.
- Nenhum segredo de provedor chega ao renderer ou ao iframe. Segredos usam `secrets.json` com namespace e uso mediado.
- Toda chamada privilegiada é auditada (`plugin_audit`) e limitada por quota.
- Assinatura identifica publisher, não garante segurança. Permissões, sandbox, revisão e revogação continuam obrigatórias.
- Backend nativo (sidecar) roda com privilégios do usuário; não é sandbox de SO. Na loja, só com revisão ou dentro de Docker/WASM.
- `tauri.conf.json` hoje tem `"csp": null`; CSP de produção é pré-requisito para loja pública.
- Comandos registrados em `generate_handler!` não têm ACL por plugin; a capability atual só cobre core/plugins do Tauri. Não tratar a webview como sandbox.

### 2.3 Fora de escopo (v1)

- Carregar dylibs Rust em runtime (`panic = "abort"`, ABI instável, sem unload seguro).
- Rodar JS de plugin não confiável na webview principal.
- Sandbox de SO para binários nativos sem Docker/WASM.
- Componentes GenUI declarados por plugin (o contrato é compilado nos dois lados; fica para a Fase 5).
- Dependências plugin→plugin no v1.
- Pagamentos, reviews e analytics no v1.
- Acesso de plugin a API keys de provedores.
- Substituição do shell por plugin não confiável.

## 3. Fases

| Fase | Nome | Escopo | Critério de saída |
|---|---|---|---|
| **0** | Fundação | contrato único, registries, overlay de tools, hash de prompt, DB, CSP/asset skeleton | app idêntico em comportamento; built-ins registrados pelos seams; paridade TS/Rust passando |
| **1** | Sandboxed MVP | manager, packaging, assinatura, iframe UI, permissões, gestão, safe mode | instalar fixture assinado, renderizar slot, desabilitar/desinstalar; fixtures maliciosos rejeitados |
| **2** | Agente | tools, prompt, skills, policy, cache | tool de fixture executável no Chat e no Code; aprovação e auditoria; snapshot recriado ao habilitar plugin |
| **3** | Loja | registry assinado, updates, rollback, revogação, CLI, revisão | instalar/atualizar/rollback de registry local; assinatura inválida e versão revogada bloqueadas |
| **4** | Trusted | loader, overrides, shell, sidecar, providers | fixture trusted substitui componente e registra provider; crash desabilita plugin e entra em safe mode |
| **5** | Ecossistema | GenUI de plugin, dependências, WASM, OAuth, pago, enterprise | componentes de plugin validados nos dois lados; resolução de dependências; loja com moderação |

**Definição do MVP (Fase 1):** instalar um `.zplugin` de fixture, ver contribuições declarativas e um slot sandboxed, conceder/revogar permissões, desabilitar, desinstalar e entrar em safe mode. Sem tools de agente, sem loja e sem trusted.

## 4. Épicos e tarefas

Legenda: `P0` bloqueia o MVP; `P1` bloqueia loja/uso real; `P2` avançado. Cada tarefa deve virar uma issue filha ou um PR pequeno.

### E0 — Fundação de contratos e seams (Fase 0)

- [ ] **PLG-001 — Contrato único de plugin** `P0`
  - Entregável: `data/plugin-contract.json`, `scripts/build-plugin-contract.mjs`, tipos TS/Rust/SDK e docs geradas.
  - Conteúdo: `apiVersion`, slots + props, permissões, limites, schemas de settings, nomes de comandos.
  - Aceite: gerador determinístico; teste de paridade falha se TS e Rust divergirem; nenhuma lista duplicada em outros arquivos.

- [ ] **PLG-002 — Registries de layout/view/slot** `P0`
  - Entregável: `src/lib/plugins/registry.ts`, `src/lib/plugins/slots.tsx`; `App.tsx` e `WorkspaceCenter` resolvem layouts/views pelo registry.
  - Aceite: built-ins Chat/Code/Agentes registrados no boot; comportamento atual preservado; testes de registry e ordem.

- [ ] **PLG-003 — Registry de abas de settings** `P0`
  - Entregável: `src/lib/settingsTabs.ts` deixa de ser união fechada; `SettingsDialog.tsx` renderiza abas do registry.
  - Aceite: abas built-in mantêm labels/ícones/ordem; plugin pode acrescentar aba; `isSettingsTabId` continua validando valores persistidos.

- [ ] **PLG-004 — Registry de comandos e slash commands** `P0`
  - Entregável: merge em `usePaletteActions.ts` e `composer/commands.ts`; detecção de conflito, origem e prioridade.
  - Aceite: comandos built-in inalterados; comando de plugin aparece na paleta e no `/`; conflito falha com mensagem clara; testes.

- [ ] **PLG-005 — Overlay dinâmico de tools** `P0`
  - Entregável: `DynamicToolSpec` em `tools/registry.rs`; `definitions_for`, `find_spec` e dispatch consultam tools dinâmicas.
  - Aceite: tools MCP continuam funcionando como hoje; plugin tool aparece no perfil correto; colisão de nome é rejeitada; testes de catálogo e execução.

- [ ] **PLG-006 — Hash de plugin no prompt snapshot** `P0`
  - Entregável: `config_hash`/`code_config_hash` incluem id, versão, hash do prompt, tools e skills de plugins habilitados.
  - Aceite: habilitar/desabilitar/editar plugin muda a snapshot key; teste mostra novo prefixo e `break_reason=plugin_config_changed`; snapshot antigo não é mutado.

- [ ] **PLG-007 — Registry de viewers de artefatos** `P0`
  - Entregável: `ArtifactPreview.tsx` usa registry por kind/MIME; built-ins registrados.
  - Aceite: previews atuais idênticos; plugin viewer pode ser associado a um MIME; fallback binário preservado.

- [ ] **PLG-008 — Namespace de i18n para plugins** `P0`
  - Entregável: merge de `plugin.<id>.*` em `src/lib/i18n`; validação de chaves e fallback `en`.
  - Aceite: locale de fixture aparece na UI; chave ausente cai no fallback; `pnpm i18n:check` cobre fixtures.

- [ ] **PLG-009 — Schema de dados e settings** `P0`
  - Entregável: tabelas aditivas em `db.rs`, migrações idempotentes, campos em `Settings`/`SettingsView` (`pluginsEnabled`, `pluginRegistryUrl`, `pluginAutoUpdate`, `pluginAllowTrusted`, `pluginSafeMode`, `pluginDevMode`).
  - Aceite: banco antigo migra sem perda; defaults seguros (trusted desligado, dev desligado); testes de migração.

- [ ] **PLG-010 — CSP e asset protocol skeleton** `P0`
  - Entregável: CSP de produção em `tauri.conf.json` (com `devCsp` separado), custom protocol `zplugin://` em Rust, validação de id/caminho.
  - Aceite: app atual funciona com CSP; fixture asset é servido; path traversal, symlink e plugin desabilitado são bloqueados; teste em WebView2 e WebKitGTK documentado.

### E1 — PluginManager, packaging e assinatura (Fase 1)

- [ ] **PLG-101 — Manifest e validação** `P0`
  - Entregável: `plugins/manifest.rs` + JSON Schema; validação de id, semver, `apiVersion`, `engines`, permissões e contribuições.
  - Aceite: ids reservados/duplicados e permissões desconhecidas são rejeitados; erros apontam campo e valor.

- [ ] **PLG-102 — Instalador de pacote** `P0`
  - Entregável: `plugins/package.rs`; staging, limites, extração atômica, rollback.
  - Aceite: ZIP bomb, `..`, caminho absoluto, symlink, ADS e nomes reservados do Windows rejeitados; instalação concorrente não corrompe; testes com fixtures.

- [ ] **PLG-103 — Assinatura e confiança** `P0`
  - Entregável: Ed25519 do publisher sobre o digest do pacote; índice da loja assinado; pinning de publisher e rotação.
  - Aceite: assinatura inválida/hash divergente bloqueiam; troca de chave exige confirmação; chave revogada bloqueia.

- [ ] **PLG-104 — PluginManager e lifecycle** `P0`
  - Entregável: `plugins/mod.rs` em `AppState`; scan no boot, enable/disable, uninstall, cache de contribuições.
  - Aceite: boot não executa código de plugin; estado persiste; disable cancela RPCs pendentes e desmonta contribuições.

- [ ] **PLG-105 — Servidor de assets** `P0`
  - Entregável: `plugins/assets.rs`; MIME, cache, CSP por resposta, bloqueio de plugin desabilitado.
  - Aceite: somente arquivos da versão atual; sem listagem de diretório; range request para mídia; testes de path.

- [ ] **PLG-106 — Comandos Tauri** `P0`
  - Entregável: `commands/plugins.rs` com a superfície mínima.
  - Aceite: comandos retornam `Result<T, String>`; erros não vazam segredos; testes de permissão.
  - Superfície: `list_plugins`, `inspect_plugin_package`, `install_plugin`, `install_plugin_url`, `uninstall_plugin`, `set_plugin_enabled`, `set_plugin_permissions`, `plugin_rpc`, `plugin_call_result`, `list_plugin_logs`, `open_plugin_dir`, `plugin_dev_reload`.

- [ ] **PLG-107 — Safe mode e crash loop** `P0`
  - Entregável: flag `--safe-mode`/`--disable-plugins`, marcador de boot, detecção de boot anterior incompleto, banner de recuperação.
  - Aceite: safe mode não carrega plugins de terceiros; não apaga dados; usuário consegue reabilitar um por um; teste de estado.

- [ ] **PLG-108 — Logs, auditoria e quotas** `P0`
  - Entregável: `plugin_logs`, `plugin_audit`, limites de payload, data, KV, rede, tempo de tool e tamanho de prompt.
  - Aceite: quota excedida retorna erro acionável; logs rotacionam; segredos conhecidos são redigidos.

### E2 — Runtime sandboxed (Fase 1)

- [ ] **PLG-201 — Host de iframe + MessagePort** `P0`
  - Entregável: `src/lib/plugins/frame.tsx`, `bridge.ts`; sandbox sem `allow-same-origin`; handshake com nonce e `MessagePort`.
  - Aceite: iframe não acessa Tauri/DOM do host; evento de outra origem não é aceito; resize e tema funcionam; teste com fixture.

- [ ] **PLG-202 — Broker de permissões** `P0`
  - Entregável: `plugins/permissions.rs` + cliente no SDK; validação no Rust, não no iframe.
  - Aceite: chamada sem permissão retorna `permission_denied`; escopo por slot/recurso; auditoria; testes negativos.

- [ ] **PLG-203 — Storage, settings e secrets** `P0`
  - Entregável: KV por plugin, settings schema, secrets namespaced e uso mediado.
  - Aceite: plugin só lê o próprio namespace; segredo nunca volta ao iframe; `hasSecret` e injeção em HTTP funcionam.

- [ ] **PLG-204 — Broker de rede** `P0`
  - Entregável: `net.request` com allowlist, HTTPS, bloqueio de localhost/IP privado, redirect revalidado, timeout e limite de resposta.
  - Aceite: domínio fora da allowlist falha; redirect para host proibido falha; resposta grande é truncada; testes com servidor local de fixture.

- [ ] **PLG-205 — Backend JS oculto** `P0`
  - Entregável: iframe oculto `backend/index.html`, lifecycle lazy, RPC de tool, timeout e cancelamento.
  - Aceite: tool de fixture responde; iframe não carregado inicia sob demanda; crash retorna erro e não derruba o app.

- [ ] **PLG-206 — Contribuições declarativas** `P0`
  - Entregável: manifest declara botões, itens de menu, comandos e settings; host renderiza com `src/components/ui`.
  - Aceite: ícones só da whitelist; labels via i18n; ações nunca enviam mensagem sozinhas; testes de render.

- [ ] **PLG-207 — Views na sidebar** `P0`
  - Entregável: `ui.views` registra uma página no layout Chat; chrome do host preservado.
  - Aceite: view abre/fecha, mantém estado, respeita tema/i18n; conflito de id rejeitado.

- [ ] **PLG-208 — Tema e locale no iframe** `P0`
  - Entregável: mensagem de tema com tokens `--background`, `--surface`, `--foreground`, `--accent`, `--radius-*`; troca em runtime.
  - Aceite: modo claro/escuro reflete no iframe; locale e `t()` funcionam; `prefers-reduced-motion` respeitado.

- [ ] **PLG-209 — Isolamento de erro e timeouts** `P0`
  - Entregável: error boundary por contribuição, timeout de load/RPC, desabilitação após N falhas.
  - Aceite: plugin quebrado mostra fallback e não derruba a UI; logs; notificação.

### E3 — Integração com o agente (Fase 2)

- [ ] **PLG-301 — Catálogo de tools de plugin** `P0`
  - Entregável: tools do manifesto validadas e expostas em Chat/Code/Agente; wire name `plugin__<slug>__<tool>` ≤ 64 chars.
  - Aceite: colisão rejeitada; schema inválido rejeitado; tools de plugin não aparecem se plugin desabilitado.

- [ ] **PLG-302 — Execução de tool** `P0`
  - Entregável: dispatch Rust → broker → backend JS/sidecar → `ToolOutcome`.
  - Aceite: texto/JSON/imagem suportados; limite de resultado; timeout; cancelamento de turno; teste no Chat e no Code.

- [ ] **PLG-303 — Seções de prompt** `P1`
  - Entregável: `prompt.md` de plugin com delimitadores, limite por plugin e total, ordem determinística.
  - Aceite: texto aparece no system prompt; hash muda; usuário consegue ver o texto no detalhe do plugin; teste de truncamento.

- [ ] **PLG-304 — Skills de plugin** `P1`
  - Entregável: skills empacotadas entram no catálogo existente com source `plugin:<id>` e namespace.
  - Aceite: conflito de nome rejeitado; enable/disable acompanha o plugin; scripts passam por `run_code`.

- [ ] **PLG-305 — Policy e aprovação** `P1`
  - Entregável: origem `Plugin` nas `ToolSpec`/auditoria; regras de aprovação; risco por tipo de plugin.
  - Aceite: `review`/`edit` pedem aprovação; `autonomous` respeita permissão; auditoria registra plugin/tool/turno.

- [ ] **PLG-306 — Subagentes** `P1`
  - Entregável: tools de plugin excluídas de subagentes por default; opt-in explícito.
  - Aceite: teste de catálogo de subagente; prompt não menciona tools ausentes.

- [ ] **PLG-307 — GenUI baseline** `P1`
  - Entregável: tools de plugin podem emitir blocos `ui` com componentes embutidos; nada de componente GenUI novo.
  - Aceite: validação existente aceita o bloco; renderer desenha; componente desconhecido degrada como hoje.

- [ ] **PLG-308 — Cache e diagnósticos** `P1`
  - Entregável: `break_reason=plugin_config_changed`; UI de cache mostra a mudança.
  - Aceite: teste de snapshot antes/depois de habilitar plugin; cache não reutiliza prefixo antigo.

### E4 — Gestão e UX (Fase 1 + Fase 3)

- [ ] **PLG-401 — View Plugins** `P0`
  - Entregável: `PluginsView` com Discover/Installed/Updates no layout Chat.
  - Aceite: lista, busca, filtros, estado vazio, loading e erro; usa design system.

- [ ] **PLG-402 — Detalhe do plugin** `P0`
  - Entregável: publisher, versão, assinatura, tamanho, permissões, tools, prompt, skills, logs, pasta de dados, rollback.
  - Aceite: strings escapadas; link externo via opener; acessibilidade.

- [ ] **PLG-403 — Instalação e consentimento** `P0`
  - Entregável: diálogos de install/update com permissões em linguagem clara e diff de permissões.
  - Aceite: trusted exige confirmação extra; permissão nova bloqueia auto-update; cancelar não altera estado.

- [ ] **PLG-404 — Settings → Plugins** `P0`
  - Entregável: registry, auto-update, developer mode, safe mode, “desabilitar todos”.
  - Aceite: mudanças persistem; policy enterprise pode ocultar sideload/trusted.

- [ ] **PLG-405 — Diagnóstico** `P1`
  - Entregável: logs, auditoria, “copiar diagnóstico”, abrir pasta, reload.
  - Aceite: exporta sem segredos; logs grandes paginados/rotacionados.

- [ ] **PLG-406 — Update, rollback e uninstall** `P1`
  - Entregável: stage/apply, rollback para versão anterior, uninstall com opção de manter dados.
  - Aceite: update com turno ativo é bloqueado; falha restaura anterior; dados somem só com confirmação.

- [ ] **PLG-407 — Atalhos de instalação** `P1`
  - Entregável: deep link `zylara://plugin/...`, drag & drop `.zplugin`, “instalar de arquivo”, comando na paleta.
  - Aceite: toda origem mostra confirmação e valida assinatura; link inválido não instala.

### E5 — Loja, publicação e atualização (Fase 3)

- [ ] **PLG-501 — Protocolo do registry** `P1`
  - Entregável: `registry.json` assinado, canais stable/beta, `yanked`, `minAppVersion`, permissões por versão.
  - Aceite: schema versionado; assinatura JCS verificada; índice inválido é rejeitado.

- [ ] **PLG-502 — Cliente do registry** `P1`
  - Entregável: fetch com ETag/cache em `plugin-store-cache`, fallback offline, timeout.
  - Aceite: não bloqueia boot; cache corrompido é ignorado; teste de rede mockada.

- [ ] **PLG-503 — Multi-registry** `P1`
  - Entregável: registries oficiais e de empresa, chave pública por registry.
  - Aceite: instalação mostra origem; registry sem chave válida não é usado.

- [ ] **PLG-504 — Publisher e assinatura** `P1`
  - Entregável: conta de publisher, chave pública, rotação assinada, CLI de assinatura.
  - Aceite: pacote sem assinatura não entra na loja; rotação inválida rejeitada.

- [ ] **PLG-505 — Revogação** `P1`
  - Entregável: feed assinado de versões revogadas; checagem no boot/update.
  - Aceite: versão revogada é desabilitada e notificada; não apaga dados.

- [ ] **PLG-506 — CLI `zylara-plugin`** `P1`
  - Entregável: `init`, `build`, `pack`, `sign`, `verify`, `dev`, `publish`.
  - Aceite: pacote gerado instala no app; `verify` detecta hash/assinatura inválidos.

- [ ] **PLG-507 — Template e SDK** `P1`
  - Entregável: `@zylara/plugin-sdk` + `create-zylara-plugin` com Vite, UI sandboxed, backend JS e testes.
  - Aceite: template roda `dev`, gera `.zplugin` e passa no harness de teste.

- [ ] **PLG-508 — Site da loja** `P2`
  - Entregável: browse, detalhe, deep link, publicação de publisher.
  - Aceite: SEO básico; link abre o app; sem coleta de dados sem consentimento.

- [ ] **PLG-509 — Pipeline de revisão** `P1`
  - Entregável: validação de schema/assinatura, scan de malware, análise de permissões, checagem de binários.
  - Aceite: high-risk/trusted exige revisão manual; rejeição explica o motivo; histórico auditável.

- [ ] **PLG-510 — Analytics opt-in** `P2`
  - Entregável: instalações/crashes agregados, sem conteúdo de conversa.
  - Aceite: desligado por default; consentimento explícito; docs de privacidade.

### E6 — Trusted e controle total (Fase 4)

- [ ] **PLG-601 — Loader trusted** `P2`
  - Entregável: script na webview principal, `window.Zylara` com React/ReactDOM/jsx-runtime compartilhados, `activate/deactivate`.
  - Aceite: hooks funcionam; plugin com React próprio é detectado/avisado em dev; timeout de boot.

- [ ] **PLG-602 — Overrides e wrappers** `P2`
  - Entregável: `host.ui.replace(id, Component)` e `wrap(id, Wrapper)` com catálogo estável de IDs.
  - Aceite: conflito exige escolha do usuário; erro isola e desabilita; props documentadas; testes.

- [ ] **PLG-603 — Layout e shell** `P2`
  - Entregável: `layoutRegistry` para layout de plugin; `ui.shell` para substituir o AppShell.
  - Aceite: chrome do host continua disponível; fallback built-in; apenas trusted.

- [ ] **PLG-604 — CSS global** `P2`
  - Entregável: `ui.css.global` com `<style>` gerenciado e remoção no disable.
  - Aceite: sem vazamento após disable; escopo recomendado; revisão obrigatória.

- [ ] **PLG-605 — Sidecar supervisor** `P2`
  - Entregável: processo filho JSON-RPC stdio, env limpo, cwd no data dir, restart/backoff, stderr capturado.
  - Aceite: tool via sidecar funciona; crash não derruba o app; matar no exit; Windows job object.

- [ ] **PLG-606 — Backend Docker** `P2`
  - Entregável: execução de backend em container com rede off, FS limitado e caps existentes.
  - Aceite: backend sem rede funciona; escape de path bloqueado; fallback claro quando Docker não existe.

- [ ] **PLG-607 — Consentimento trusted** `P2`
  - Entregável: permissão `unsafe.renderer`, aviso explícito, assinatura, bloqueio em managed policy.
  - Aceite: loja pública não instala trusted por default; sideload exige confirmação digitada; auditoria.

### E7 — Ecossistema (Fase 5)

- [ ] **PLG-701 — GenUI de plugin** `P2`
  - Entregável: componentes declarados no manifesto, schemas de props, validador Rust genérico, renderer TS e prompt.
  - Aceite: paridade TS/Rust; a11y; store review; componente inválido degrada.

- [ ] **PLG-702 — Dependências entre plugins** `P2`
  - Entregável: resolver semver, conflitos, ordem de ativação.
  - Aceite: ciclo detectado; versão incompatível explica; desinstalar dependência bloqueia.

- [ ] **PLG-703 — Backend WASM** `P2`
  - Entregável: runtime wasmtime com imports de host, sem FS/rede diretos.
  - Aceite: tool WASM executa; quotas; sem panic no host.

- [ ] **PLG-704 — OAuth broker** `P2`
  - Entregável: fluxo OAuth mediado pelo host, tokens nunca no iframe.
  - Aceite: callback loopback; refresh; revogação; auditoria.

- [ ] **PLG-705 — Parsers de anexo** `P2`
  - Entregável: parser de documento via backend sandboxed ou tool.
  - Aceite: MIME suportado; limites; sem acesso fora do arquivo concedido.

- [ ] **PLG-706 — Licenciamento/pago** `P2`
  - Entregável: metadados de preço/licença; validação pelo publisher.
  - Aceite: app não processa pagamento; compra fora do app; estado de licença exibido.

- [ ] **PLG-707 — Política enterprise** `P2`
  - Entregável: allowlist de plugins/registries, bloquear sideload/trusted, settings gerenciadas.
  - Aceite: política vence preferência do usuário; UI explica bloqueio.

- [ ] **PLG-708 — Telemetria de plugins** `P2`
  - Entregável: métricas locais e envio opt-in.
  - Aceite: sem conteúdo de conversa; usuário vê o que é enviado; desligado por default.

- [ ] **PLG-709 — Abas nativas de plugin nos painéis Code/Agentes** `P2`
  - Entregável: contribuição `ui.panelTabs` no manifesto com `host: "code" | "agent"`, `id`, título, ícone, ordem, `entry`/`component` e permissão `ui.panel`; validação Rust/TS/SDK, registry e merge com as abas nativas dos painéis.
  - Aceite: plugin adiciona aba ao lado de Arquivos/Alterações/Terminal (Code) e Tela/Rotinas/Browser/Dados (Agentes); ids reservados/colisão rejeitados; frame/trusted isolado com error boundary, tema, i18n, a11y e persistência da aba ativa; desabilitar plugin remove a aba; paridade TS/Rust e testes de ordem/teclado.

## 5. Contratos e dados

### 5.1 Fonte única

`data/plugin-contract.json` define:

- `apiVersion` corrente e política de compatibilidade;
- catálogo de slots (`id`, props, tipos de contribuição, modos permitidos);
- catálogo de permissões (`id`, escopo, risco, descrição i18n);
- limites (pacote, arquivos, prompt, KV, rede, tool, logs);
- schemas de settings e tools suportados.

Geração: `pnpm plugin:contract` produz tipos TS, constantes Rust, tipos do SDK e tabelas de docs. Teste de paridade semelhante ao GenUI.

### 5.2 Pacote e manifesto

```text
com.acme.github-1.4.0.zplugin
  manifest.json
  ui/toolbar.html
  ui/page.html
  backend/index.html
  tools.json
  settings.schema.json
  prompt.md
  skills/github/SKILL.md
  locales/en.json
  locales/pt-BR.json
  locales/es.json
  assets/...
  native/windows-x64/server.exe   # opcional, trusted
```

```json
{
  "schemaVersion": 1,
  "id": "com.acme.github",
  "name": "GitHub",
  "version": "1.4.0",
  "apiVersion": 1,
  "engines": { "zylara": ">=0.7.0 <1.0.0" },
  "publisher": { "id": "acme", "name": "Acme", "keyId": "acme-2026" },
  "permissions": [
    "ui.slot:chat.composer.toolbar",
    "agent.tools",
    "net:api.github.com",
    "storage"
  ],
  "contributes": {
    "ui": {
      "slots": [{ "slot": "chat.composer.toolbar", "entry": "ui/toolbar.html" }],
      "views": [{ "id": "github", "titleKey": "views.github", "entry": "ui/page.html" }]
    },
    "tools": "tools.json",
    "settings": "settings.schema.json",
    "promptSections": ["prompt.md"],
    "skills": ["skills/"],
    "locales": ["locales/"]
  },
  "runtime": {
    "ui": "sandbox",
    "backend": { "kind": "js", "entry": "backend/index.html" }
  }
}
```

### 5.3 Limites

- Pacote: 50 MB (200 MB só trusted/nativo aprovado).
- Arquivos: 2.000; teto de bytes descompactados.
- Sem symlink, `..`, caminho absoluto, ADS, nomes reservados do Windows, colisão case-insensitive.
- Ícones: PNG/WebP/JPEG; SVG só sanitizado ou proibido.
- Tool name wire ≤ 64 caracteres (limite prático dos provedores).
- Prompt: 4k chars por plugin, 12k total.
- KV: 5 MB; dados: 100 MB; log: 5 MB; resposta de rede: 10 MB; RPC: 1 MB.
- Tool timeout: 60 s default, cancelável.

### 5.4 Banco (aditivo)

```sql
plugins(id TEXT PRIMARY KEY, version TEXT NOT NULL, api_version INTEGER NOT NULL,
        root TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
        trusted INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
        signature_status TEXT NOT NULL, installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, last_used_at INTEGER,
        auto_update INTEGER NOT NULL DEFAULT 0, previous_version TEXT,
        disabled_reason TEXT);
plugin_permissions(plugin_id TEXT, permission TEXT, granted INTEGER NOT NULL,
                   granted_at INTEGER NOT NULL, PRIMARY KEY(plugin_id, permission));
plugin_settings(plugin_id TEXT, key TEXT, value_json TEXT NOT NULL,
                PRIMARY KEY(plugin_id, key));
plugin_state(plugin_id TEXT, key TEXT, value_json TEXT NOT NULL,
             PRIMARY KEY(plugin_id, key));
plugin_logs(id INTEGER PRIMARY KEY, plugin_id TEXT, level TEXT, message TEXT,
            created_at INTEGER);
plugin_audit(id INTEGER PRIMARY KEY, plugin_id TEXT, capability TEXT,
             params_digest TEXT, decision TEXT, created_at INTEGER);
plugin_tool_calls(id INTEGER PRIMARY KEY, plugin_id TEXT, tool TEXT,
                  conversation_id TEXT, turn_id TEXT, status TEXT, duration_ms INTEGER,
                  created_at INTEGER);
plugin_store_cache(key TEXT PRIMARY KEY, etag TEXT, body TEXT NOT NULL,
                   fetched_at INTEGER NOT NULL);
```

Segredos: `secrets.json` com namespace `plugin:<id>:<key>`; o banco guarda apenas nomes/flags. Nunca devolver segredo ao renderer/iframe; usar `secrets.use` mediado.

### 5.5 Comandos Tauri

```text
list_plugins, inspect_plugin_package, install_plugin, install_plugin_url,
uninstall_plugin, set_plugin_enabled, set_plugin_permissions,
plugin_rpc, plugin_call_result, list_plugin_logs, open_plugin_dir,
store_refresh, check_plugin_updates, update_plugin, rollback_plugin,
set_plugin_auto_update, plugin_dev_reload
```

`plugin_rpc` e `plugin_call_result` são internos do host bridge; o iframe nunca os invoca diretamente.

### 5.6 Mapa de arquivos

| Área | Arquivos |
|---|---|
| Contrato | `data/plugin-contract.json`, `scripts/build-plugin-contract.mjs` |
| Backend | `src-tauri/src/plugins/{mod,manifest,package,registry,permissions,runtime,assets}.rs`, `commands/plugins.rs` |
| Estado/DB | `state.rs`, `db.rs`, `domain.rs`, `config.rs` |
| Frontend | `src/lib/plugins/{contract,host,registry,bridge,frame,slots,i18n}.ts(x)` |
| UI | `src/components/plugins/*`, `src/components/settings/PluginsTab.tsx` |
| Agent | `tools/mod.rs`, `tools/registry.rs`, `harness/mod.rs`, `harness/prompt.rs`, `harness/code/*`, `policy/*` |
| SDK/CLI | `packages/plugin-sdk`, `packages/create-zylara-plugin`, `scripts/plugin/*` |
| Testes | `plugins/fixtures/*`, testes Rust/TS, registry local de fixture |
| Docs | `docs/PLUGINS.md`, `docs/PLUGIN_SDK.md`, `docs/PLUGIN_STORE.md`, `docs/PLUGIN_SECURITY.md`, `docs/ARCHITECTURE.md`, `AGENTS.md` |

## 6. Permissões

| Permissão | Permite | Risco |
|---|---|---|
| `ui.slot:<id>` | Adicionar conteúdo a um slot | baixo |
| `ui.view` | Registrar página na sidebar | baixo |
| `ui.override:<id>` | Substituir componente do host | crítico (trusted) |
| `ui.css.global` | CSS global | crítico (trusted) |
| `commands` / `hotkeys` | Comandos e atalhos | baixo/médio |
| `settings` | Schema/página de configuração | baixo |
| `agent.tools` | Expor tools ao agente | alto |
| `agent.prompt` | Injetar texto no system prompt | alto (prompt injection por design) |
| `agent.skills` | Empacotar skills/scripts | alto |
| `chat.read` / `chat.write` | Ler/escrever conversas | alto |
| `fs.read:<glob>` / `fs.write:<glob>` | Arquivos fora do data dir | alto |
| `net:<hosts>` | HTTP mediado | médio/alto |
| `process.spawn` | Backend nativo | crítico |
| `secrets.use` | Usar segredo sem vê-lo | médio |
| `secrets.read` | Ler segredo | crítico |
| `storage` | KV isolado | baixo |
| `events:<scope>` | Assinar eventos normalizados | baixo/médio |
| `clipboard.read` | Ler clipboard | alto |
| `notifications` | Notificar | baixo |
| `dialog` / `opener` | Diálogos e links | conforme o caso |

Regras: permissão concedida no install; mudança em update exige novo consentimento; revogação desabilita o plugin; toda negação é auditada.

## 7. Loja e distribuição

### MVP (sem servidor)

- `registry.json` assinado em CDN/GitHub Pages.
- Pacotes em GitHub Releases/R2.
- Publicação via PR + CI que valida, assina e atualiza o índice.
- Busca no cliente; sem contas/reviews.
- Revogação em `revocations.json` assinado.

### Escala

- API para busca, contas de publisher, reviews, contagem de instalações e moderação.
- Múltiplos registries (oficial, empresa, beta).
- Pagamento fora do app; licença validada pelo publisher.

### Fluxo de instalação

1. Origem: loja, `.zplugin`, drag & drop, deep link ou pasta de dev.
2. Download/leitura em staging; HTTPS e limite de tamanho.
3. Verificar assinatura do índice, SHA-256 do pacote e assinatura do publisher.
4. Validar ZIP/manifesto/semver/engine/permissões.
5. Consentimento com publisher, versão, tamanho, origem, assinatura e permissões.
6. Extrair atomicamente, gravar DB, registrar contribuições.
7. Em update: diff de permissões, bloqueio com turno ativo, rollback em falha.

### Atualizações e revogação

- Checagem manual/periódica; canal stable/beta; auto-update por plugin.
- Nova permissão → consentimento; recusa mantém versão antiga.
- Versão revogada → desabilitar, notificar, manter dados.
- App update incompatível → desabilitar com motivo e sugerir versão compatível.

## 8. Integração com o agente

| Área | Decisão |
|---|---|
| Tools | overlay dinâmico; wire name `plugin__<slug>__<tool>`; perfis chat/code/agent; schema validado |
| Execução | broker Rust → iframe oculto ou sidecar; timeout/cancelamento; resultado limitado |
| Prompt | seções com delimitadores, ordem por id, limite por plugin/total; `agent.prompt` de alto risco |
| Skills | mesmo catálogo das skills existentes; source `plugin:<id>`; scripts via `run_code` |
| Policy | origem auditável; aprovação por modo; `autonomous` só com permissão |
| Subagentes | tools de plugin excluídas por default; opt-in explícito |
| GenUI | v1 usa apenas componentes embutidos; componentes de plugin na Fase 5 |
| Providers | declarativo OpenAI-compatible (`plugin:<id>`); protocolo proprietário via sidecar trusted |
| Cache | `config_hash`/`code_config_hash` incluem contribuições; nova snapshot key e `break_reason=plugin_config_changed` |
| Snapshot | nunca mutar snapshot congelado; tools/prompt congelados por sessão |
| Auditoria | `plugin_tool_calls` + `plugin_audit`; redigir segredos |

## 9. UX

- Sidebar → **Plugins** (Discover / Installed / Updates).
- Detalhe: publisher, versão, assinatura, tamanho, permissões, tools, prompt, skills, logs, data dir, rollback, uninstall com opção de manter dados.
- Settings → Plugins: registry, auto-update, developer mode, safe mode, “desabilitar todos”.
- Instalação: consentimento claro, sem dark patterns; trusted com aviso vermelho e confirmação extra.
- Atualização: diff de permissões; “atualizar todos”; badge de update.
- Safe mode: banner de recuperação, habilitar um por um.
- Developer: load unpacked, reload, logs, abrir pasta, inspecionar iframe.
- Acessibilidade: foco, teclado, contraste, `prefers-reduced-motion`, labels i18n.

## 10. Testes e critérios de pronto

### Matriz

| Camada | Testes |
|---|---|
| Rust | manifesto, semver, ZIP, path traversal, assinatura, permissões, quotas, RPC, tool dispatch, prompt hash, registry, revogação, safe mode |
| TS | registry, ordem de slots, overrides, bridge, MessagePort, i18n, comandos, error boundaries |
| Fixtures | declarativo, sandboxed, tool JS, trusted, malicioso (traversal, zip bomb, permissão indevida, SSRF, assinatura inválida, update com permissão nova) |
| Integração | instalar/habilitar/desabilitar/atualizar/rollback/desinstalar; registry local assinado |
| Manual | smoke no app real; sem automação de UI como critério |

### Critérios de pronto por fase

- `pnpm typecheck`, `pnpm test`, `cargo check`, `cargo test --lib` verdes.
- Nenhum `todo!()`/`unimplemented!()` na área.
- Docs atualizados junto do contrato.
- Nenhum segredo em logs/test fixtures.
- Nenhum plugin de terceiro executa no boot sem ação do usuário.
- Permissões testadas negativamente, não só o caminho feliz.
- Fixture malicioso falha de forma explícita.

## 11. Riscos e decisões abertas

| Risco/decisão | Recomendação |
|---|---|
| Trusted na loja pública? | Não por default; seção curada/revisada no futuro |
| Sidecar nativo na loja? | Não no v1; só trusted/revisado ou Docker |
| Componentes GenUI de plugin? | Adiar para Fase 5; exige contrato runtime e paridade |
| Dependências plugin→plugin? | Fora do v1; resolver depois |
| Layouts de plugin? | Views primeiro; layout/shell só trusted |
| Abas nativas em painéis existentes? | Fora do v1; `ui.panels` permite um painel próprio. `PLG-709` planeja `ui.panelTabs` para Code/Agentes |
| Loja oficial? | MVP estático assinado; API só quando houver demanda |
| Pagamentos? | Fora do v1; licença validada pelo publisher |
| Telemetria? | Opt-in, agregada, sem conteúdo de conversa |
| Plataformas? | Windows primeiro; macOS/Linux depois; JS sandboxed é cross-platform |
| CSP | Obrigatória antes de loja pública; validar WebView2/WebKitGTK |
| Nome de tool > 64 chars | slug curto + hash; mapping persistido |
| Plugin quebrado | error boundary, timeout, desabilitar após N falhas, safe mode |

## 12. Checklist de issues filhas

- [ ] E0 — Fundação de contratos e seams
- [ ] E1 — PluginManager, packaging e assinatura
- [ ] E2 — Runtime sandboxed
- [ ] E3 — Integração com o agente
- [ ] E4 — Gestão e UX
- [ ] E5 — Loja, publicação e atualização
- [ ] E6 — Trusted e controle total
- [ ] E7 — Ecossistema

## 13. Definition of Done do épico

- [ ] Instalar um `.zplugin` assinado de fixture e ver a contribuição na UI.
- [ ] Conceder/revogar uma permissão e ver o plugin falhar de forma segura.
- [ ] Executar uma tool de plugin no Chat e no Code, com aprovação e auditoria.
- [ ] Habilitar um plugin e ver a snapshot key mudar; desabilitar e ver outra.
- [ ] Instalar/atualizar/rollback/desinstalar via registry local assinado.
- [ ] Rejeitar fixtures maliciosos (traversal, zip bomb, SSRF, assinatura inválida, permissão indevida).
- [ ] Entrar em safe mode após crash simulado e reabilitar um plugin por vez.
- [ ] Fixture trusted substituir um componente e registrar um provider.
- [ ] Documentação de contrato, permissões, SDK, loja e segurança publicada.
- [ ] `pnpm typecheck`, `pnpm test`, `cargo check` e `cargo test --lib` verdes.
