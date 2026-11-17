# Plugins

Plataforma de plugins do Zylara: instalação assinada, UI sandboxed em iframe,
tools/prompt/skills do agente, provedores declarativos e a lane **trusted** que
roda na webview principal e pode substituir componentes, wrappers, o shell e CSS
global.

A fonte única do contrato é [`data/plugin-contract.json`](../data/plugin-contract.json);
o JSON Schema do manifesto fica em
[`data/plugin-manifest.schema.json`](../data/plugin-manifest.schema.json).
Tipos e constantes derivados ficam em `src/lib/plugins/contract.ts`,
`src-tauri/src/plugins/contract.rs` e `packages/plugin-sdk`. Rode
`pnpm plugin:contract` após editar o JSON.

## 1. Níveis de plugin

| Nível | Runtime | Pode alterar | Código roda em |
|---|---|---|---|
| **Declarative** | manifesto | botões em slots, views, painéis, comandos, abas de settings, temas, i18n | nada executa no host |
| **Sandboxed** | iframe `sandbox="allow-scripts"` + backend JS oculto | UI própria, lógica, tools | origem `zplugin` isolada |
| **Trusted** | JS na webview principal + React compartilhado | componentes de override do contrato, wrappers, shell, CSS global, stores via bridge, tools | webview principal |

Código não confiável **nunca** roda na webview principal. Trusted é opt-in
explícito (`pluginAllowTrusted` + permissão `unsafe.renderer`).

## 2. Estrutura de um pacote `.zplugin`

```
com.acme.notes-1.2.0.zplugin (ZIP)
  manifest.json
  META-INF/signature.json          # assinatura opcional (obrigatória na loja)
  ui/page.html
  ui/panel.html
  backend/index.html
  prompt.md
  skills/acme-notes/SKILL.md
  locales/en.json, pt-BR.json, es.json
```

O ZIP é validado antes de qualquer extração: sem `..`, caminho absoluto,
symlink, ADS, nomes reservados do Windows, colisão case-insensitive, ZIP bomb
(limites em `data/plugin-contract.json`) ou entradas especiais.

### Manifesto

```json
{
  "schemaVersion": 1,
  "id": "com.acme.notes",
  "name": "Acme Notes",
  "version": "1.2.0",
  "description": "Notes panel",
  "apiVersion": 1,
  "engines": { "zylara": ">=0.11.0 <1.0.0" },
  "publisher": { "id": "acme", "name": "Acme", "keyId": "acme-2026" },
  "permissions": [
    "ui.slot:chat.composer.toolbar",
    "ui.view",
    "ui.panel",
    "ui.command",
    "agent.tools",
    "agent.prompt",
    "agent.skills",
    "storage",
    "net:api.example.com"
  ],
  "contributes": {
    "ui": {
      "slots": [{ "slot": "chat.composer.toolbar", "entry": "ui/toolbar.html" }],
      "views": [{
        "id": "notes",
        "title": "Notes",
        "surface": "chat",
        "location": "sidebar",
        "entry": "ui/page.html"
      }],
      "panels": [{
        "id": "notes-panel",
        "title": "Notes",
        "entry": "ui/panel.html",
        "dock": "right"
      }],
      "commands": [{
        "id": "open",
        "title": "Open notes",
        "command": "notes",
        "action": { "kind": "openView", "target": "notes" }
      }],
      "settingsTabs": [{ "id": "config", "title": "Notes", "entry": "ui/settings.html" }],
      "sidebarTabs": [{
        "id": "notes-tab",
        "title": "Notes",
        "icon": "Library",
        "sidebars": ["chat", "code"],
        "entry": "ui/notes-tab.html",
        "order": 10
      }],
      "themes": [{
        "id": "paper",
        "name": "Paper",
        "light": { "accent": "#8b5cf6" },
        "dark": { "accent": "#a78bfa" }
      }]
    },
    "tools": [{
      "name": "save_note",
      "description": "Save a note.",
      "risk": "write",
      "parameters": {
        "type": "object",
        "properties": { "title": { "type": "string" }, "body": { "type": "string" } },
        "required": ["title", "body"]
      }
    }],
    "promptSections": [{ "id": "rules", "title": "Notes", "file": "prompt.md" }],
    "skills": ["skills"],
    "locales": ["locales"],
    "artifactViewers": [{
      "id": "csv",
      "title": "CSV",
      "mimeTypes": ["text/csv"],
      "entry": "ui/csv.html",
      "priority": 50
    }],
    "providers": [{
      "id": "gateway",
      "name": "Acme Gateway",
      "baseUrl": "https://api.acme.example/v1",
      "icon": "ui/acme.svg",
      "authHeader": "authorization",
      "authPrefix": "Bearer ",
      "headers": { "x-acme-tenant": "public" },
      "models": [{ "id": "acme-chat-1", "name": "Acme Chat 1" }]
    }],
    "modes": [{
      "id": "review",
      "title": "Review",
      "icon": "ListChecks",
      "description": "Review every change before answering",
      "profiles": ["chat", "code"],
      "promptFile": "modes/review.md",
      "tools": { "add": ["web_search"], "remove": ["install_plugin"] },
      "writes": "blocked"
    }],
    "agentTemplates": [{
      "id": "reviewer",
      "name": "Reviewer",
      "role": "Code reviewer",
      "instructionsFile": "templates/reviewer.md",
      "starters": ["Review this pull request"],
      "capabilities": { "code_execution": false },
      "permissionMode": "read_only"
    }]
  },
  "runtime": {
    "ui": "sandbox",
    "entry": null,
    "backend": { "kind": "js", "entry": "backend/index.html" }
  }
}
```

Trusted plugins usam `"runtime": { "ui": "trusted", "entry": "main.js" }` e
`"trusted": true`.

## 3. Slots e componentes

Slots disponíveis (catálogo em `data/plugin-contract.json`):
`titlebar.actions`, `chat.sidebar.header`, `chat.sidebar.footer`,
`chat.header.actions`, `chat.composer.toolbar`, `chat.welcome.actions`,
`chat.message.actions`, `code.header.actions`, `code.panel.header`,
`agent.sidebar.footer`, `right.panel.header`, `settings.plugins.header`,
`plugins.detail.actions`, `artifact.preview.toolbar`, além de
`sidebar.nav.before`/`sidebar.nav.after` nos três layouts.

### Como habilitar uma superfície reservada

`reservedSlots` e `reservedComponents` listam as superfícies declaradas que este
host **ainda não** monta; `scripts/check-plugin-surfaces.mjs` falha se um id
"live" não estiver montado ou se um id reservado estiver montado. Habilitar uma
superfície é sempre o mesmo par de passos, no mesmo commit:

1. montar `<Slot name="<id>" …/>`, `<PluginSlot slot="<id>" …/>` ou
   `<ComponentSlot name="<id>">…</ComponentSlot>` no componente do host;
2. remover o id de `reservedSlots`/`reservedComponents` em
   `data/plugin-contract.json` e rodar `pnpm plugin:contract`.

`reservedPermissions` funciona do mesmo jeito para permissões sem API
(`process.spawn`, `dialog`): o manifesto é recusado com
`PLUGIN_PERMISSION_RESERVED`.

Alguns ids seguem reservados de propósito porque o host ainda **não tem** a
superfície correspondente (não é só falta de mount): `agent.tabs` e
`right.panel.tabs` descrevem faixas de abas genéricas que hoje não existem no
centro de Agentes nem no dock direito — cada painel tem seu próprio strip
(`code.panel.tabs`, `agent.panel.tabs`). Habilitá-los exige desenhar a faixa,
não apenas montar um slot.

Os componentes abaixo continuam em `reservedComponents` por decisão explícita —
a região já é **wrappável** pelo slot hoc equivalente, então um plugin trusted
consegue substituí-la renderizando sua própria UI no lugar de `children`:

| Componente | Superfície equivalente | Por que não tem ComponentSlot |
|---|---|---|
| `chat.composer.input` | `chat.composer.input.frame` | o textarea depende de ref, IME e `aria-activedescendant` do combobox |
| `chat.message.tool-group` | `chat.message.tool.group.frame` | idem (grupo dentro do `<ol>` de steps) |
| `chat.message.tool-row` | `chat.message.tool` (keyed por tool) | o renderer por tool já é o slot keyed |
| `code.tab.strip` | `code.tab.strip.frame` | o strip é `RecipeDiv` com refs de sortable/drag |
| `agent.tab.strip` | `agent.tabs` | faixa inexistente (ver acima) |
| `agent.channel.view` | `agent.channel.view.frame` | — |
| `agent.channel.message` | `agent.channel.message.before/after/body.frame` | — |
| `agent.channel.composer` | `agent.channel.composer.frame` | — |

`code.workbench`, `settings.page` e `settings.rail` **saíram** dessa lista: agora
têm `ComponentSlot` de verdade (`WorkspaceCenter` e `SettingsDialog`), com
fallback de identidade que repassa a árvore do host como `children` (o rail
recebe `pluginTabs`, a página recebe `tab`). O fixture trusted
`plugins/fixtures/surfaces-demo` demonstra os três: envolve o workbench, substitui
a página de configurações e injeta uma linha declarativa em `palette.actions`.

O *dock takeover* também é renderizado: `App.tsx` calcula `takeoverDock` a partir
dos painéis com `takeover` e o mostra no lugar do dock do host até o usuário
dispensá-lo (`dismissPluginDockTakeover`).

## 3.1 Abas de conteúdo nas sidebars (`ui.sidebarTabs`)

`contributes.ui.sidebarTabs[]` adiciona abas de conteúdo **dentro** da sidebar de
qualquer layout (`sidebars: ["chat"|"code"|"agent"]`), sem tomar o centro:

- `entry` (sandboxed, iframe) ou `component` (trusted, exportado pelo `main.js`);
- `order` (padrão 300) e `badge` (até 24 caracteres);
- permissão `ui.sidebar`; limite `uiLimits.sidebarTabsPerPlugin`.

A aba ativa é estado de UI por layout (`uiStore.pluginSidebarTab`); o corpo é
renderizado por `PluginSidebarTabHost`, que aplica o `PluginBoundary` e respeita
o "desativar plugin UI" (prefs).

## 3.2 Modos do harness (`contributes.modes`)

Um modo é um interruptor persistente por conversa que injeta instruções no bloco
de plugins do system prompt e pode ajustar o catálogo de tools:

| Campo | Efeito |
|---|---|
| `profiles` | `chat` e/ou `code` (vazio = ambos) |
| `prompt` / `promptFile` | texto injetado (um dos dois, ≤ `limits.modePromptChars`) |
| `tools.add` | reexpõe tools do catálogo (`web_search`, `create_file`, …) |
| `tools.remove` | esconde tools pelo nome (`install_plugin`, …) |
| `writes: "blocked"` | esconde tools mutadoras; reforçado por prompt |
| `defaultOn` | ativo por padrão até o usuário desligar |

Permissão `agent.modes`. O estado vive em `code_events` (`plugin/modes`,
append-only, último vence), é lido no backend a cada turno
(`harness::plugin_modes`) e nunca vem do renderer. As chips do composer
(`PluginModeChips`) e o comando `set_plugin_mode` são a interface; comandos
declarativos usam `{ "kind": "toggleMode", "target": "<pluginId>:<modeId>" }`.
O conjunto ativo entra no fingerprint de plugins, então alternar um modo invalida
o snapshot de prompt (`break_reason=plugin_config_changed`).

Cada modo do layout ativo também vira um slash command (`pluginModeCommands` em
`src/components/composer/commands.ts`): `/<modeId>` ou, quando o nome já está
tomado por um builtin/command, `/<plugin-slug>-<modeId>`. Executar alterna o modo
da conversa aberta e emite `zylara:plugin-mode-changed`, que as chips escutam.

## 3.3 Templates de agentes (`contributes.agentTemplates`)

Templates aparecem na galeria de criação do layout Agentes com selo do plugin.
`instructions`/`instructionsFile` (≤ `limits.templateInstructionsChars`),
`starters`, `role`, `icon`, `permissionMode` (`read_only|edit|autonomous|review`)
e `capabilities` — **deny-only**: só restringem os defaults, como os templates
embutidos. Permissão `agent.templates`. Criar o agente continua sendo consentimento
explícito no editor.

Quando o agente nasce de um template de plugin, o renderer envia
`template: { pluginId, templateId }` junto do `AgentInput`. O backend revalida
(`validate_template`): o template precisa existir num plugin ativo, e o agente não
pode reativar uma capability que o template desativou (`AGENT_TEMPLATE_INVALID`)
nem usar `null` ("todos") onde o template reduziu a lista. A origem é gravada em
`plugin_audit` (`capability = agent.template`, `decision = applied`); falha de
auditoria só loga e nunca bloqueia a criação.

## 3.4 Provedores

Além de `contributes.providers` (plugins), o usuário pode criar provedores em
Configurações → Provedores → "Adicionar provedor" (id `custom__<slug>`), com
baseUrl, auth header/prefix, headers estáticos e lista manual de modelos. Os dois
caminhos entram no mesmo catálogo (`AppState::catalog_with_plugins`), então Chat,
Code e Agentes resolvem modelo/credencial pelo mesmo caminho; a UI marca a origem
(`origin: custom|plugin`). Só `openai-chat` é suportado; `http://` apenas em
localhost (Ollama/LM Studio/vLLM). Credenciais nunca são declarativas: headers
`authorization`/`cookie`/`host` são recusados no manifesto.

O botão "Testar conexão" usa `validate_provider` para provedores do catálogo e
`test_custom_provider` (mesmo probe, restrito a ids `custom__…`) para os definidos
pelo usuário. Um `icon` declarado no provedor é resolvido pelo `ProviderGlyph`
antes do fallback de iniciais.

Componentes que trusted pode substituir/wrapar:
`layout.shell`, `layout.center`, `chat.welcome`, `settings.dialog`, `plugins.view`
e os demais ids listados em `components` no contrato.
Views/painéis, abas de sidebar e slots cobrem o restante da UI sem expor IDs
internos.

Contribuições declarativas em slots podem ser um botão (`action` + `title`) ou
um iframe (`entry`). Views e painéis aparecem na sidebar/painel direito; abas de
settings usam o dialogo existente. Todos os rótulos passam por i18n
(`plugin.<id>.<chave>` ou uma key explícita `namespace:key`).

## 4. Runtime sandboxed

- Iframe sem `allow-same-origin`, carregado de `zplugin` (`zplugin.localhost` no
  Windows), com CSP próprio.
- SDK virtual em `zplugin…/@zylara/sdk.js`; disponível como `window.ZylaraPlugin`.
- Handshake por nonce + `postMessage`; qualquer evento de outra origem é
  ignorado.
- RPC mediado pelo Rust (`plugin_rpc`), com permissões e auditoria.
- Backend oculto é montado sob demanda na primeira tool/command.
- Resultados de tools limitados a 120k chars e imagens a 4 arquivos PNG/JPEG/WebP/GIF.

```js
ZylaraPlugin.on('init', () => {
  document.body.textContent = ZylaraPlugin.t('welcome', 'Hello');
});
ZylaraPlugin.onTool(async ({ tool, arguments: args }) => {
  if (tool === 'save_note') {
    await ZylaraPlugin.rpc('storage.set', { key: 'last', value: args });
    return { content: 'saved', summary: 'Note saved' };
  }
  throw new Error('unknown tool');
});
```

## 5. Runtime trusted

`main.js` é avaliado com um `host` estreito que compartilha React/ReactDOM e
expõe:

```js
host.registerPlugin({ activate(host) {}, deactivate() {} });
host.registerView(id, Component);
host.registerPanel(id, Component);
host.registerSlot(slotId, Component);
host.registerSettingsTab(id, Component);
host.registerArtifactViewer(id, Component);
host.replaceComponent(id, Component);
host.wrapComponent(id, Wrapper);
host.replaceShell(Component);
host.addGlobalCss(css);
host.registerToolHandler(toolName, fn);
host.registerCommandHandler(method, fn);
host.on(event, handler);
host.rpc(method, params);
```

Substituições exigem `ui.override:<componente>`; shell exige `ui.shell`; CSS
exige `ui.css.global`. Wrappers recebem `Host` + `children`. O loader valida
`unsafe.renderer`, isola erros, desativa após 3 falhas e chama `deactivate` ao
desabilitar.

Fixtures: `plugins/fixtures/sandbox-demo`, `trusted-demo` e `provider-demo`.
O fixture trusted demonstra override de `chat.welcome`, wrapper de
`layout.shell`, React view/painel, CSS global e tool handler. O fixture provider
demonstra um provedor OpenAI-compatible declarativo.

## 6. Tools, prompt e skills

- Wire name: `plugin__<slug>__<tool>` (≤64 chars).
- Perfis `chat`/`code`; subagentes não recebem tools/prompt de plugin por padrão.
- Colisão de wire name rejeita a tool e registra log.
- Execução: Rust emite `zylara:plugin-tool-call`, o renderer chama o handler
  trusted ou o backend iframe e responde via `plugin_call_result`.
- Prompt sections: 4k chars por plugin, 12k total, delimitadas e marcadas como
  configuração (não autoridade). O fingerprint entra no `config_hash`; mudanças
  habilitam epoch novo com `break_reason=plugin_config_changed`.
- Skills: source `plugin:<id>`, entram no catálogo normal, scripts passam pelas
  tools de código existentes.
- Auditoria: `plugin_audit` e `plugin_tool_calls`; segredos nunca aparecem.

## 7. Permissões e broker

Catálogo e risco em `data/plugin-contract.json`. Escopos:

- `ui.slot:<slot>`, `ui.override:<componente>`
- `ui.view`, `ui.nav`, `ui.sidebar`, `ui.panel`, `ui.settings`, `ui.command`,
  `ui.artifact`, `ui.variant`, `ui.preset`, `ui.genui`, `ui.shell`,
  `ui.css.global`, `ui.theme`
- `agent.tools`, `agent.prompt`, `agent.skills`, `agent.modes`, `agent.templates`
- `providers`, `chat.read`, `chat.write`, `commands`, `hotkeys`, `events:<scope>`
- `net:<host>` (HTTPS, allowlist, redirects revalidados, loopback/privado bloqueado)
- `fs.read:<glob>`, `fs.write:<glob>` (caminho absoluto canonicalizado)

O broker Rust expõe: `storage.*`, `settings.*`, `secrets.has/names`,
`net.request` (com injeção de segredo), `chat.read`, `chat.list`, `log`,
`notify`, `opener.open`, `clipboard.read`, `fs.read/write/list` e `ping`.
Nenhum `invoke` genérico. Negação sempre vira `PLUGIN_PERMISSION_DENIED` e é
auditada.

Segredos usam `secrets.json` com namespace `plugin:<id>:<key>`; `hasSecret`
não retorna o valor; `net.request.secret` injeta o header no backend.

## 8. Ciclo de vida e dados

Tabelas aditivas: `plugins`, `plugin_permissions`, `plugin_settings`,
`plugin_state`, `plugin_logs`, `plugin_audit`, `plugin_tool_calls`,
`plugin_store_cache`, `plugin_publisher_keys`, `plugin_publishers`,
`plugin_cache_state`.

Instalação:
1. staging em `<app-data>/plugins/.staging/<uuid>`;
2. ZIP/manifesto/limites/assinatura verificados;
3. extração atômica para `<app-data>/plugins/<id>/<versão>`;
4. DB + permissões + pin da chave do publisher;
5. reload da registry de contribuições.

Updates preservam a versão anterior para rollback; rollback troca
`version/root` e mantém a atual como anterior. Uninstall com `keepData` preserva
KV/settings/secrets. Revogação desabilita sem apagar dados. Safe mode
(`--safe-mode`/`--disable-plugins`, crash marker ou setting) não carrega
terceiros e permite recuperar um por um.

## 9. Loja e assinaturas

O registry é JSON assinado (Ed25519); a assinatura cobre o JSON canônico sem o
campo `signature`. Chaves de registry e publisher são pinadas na primeira
instalação; troca de chave exige confirmação digitada do id do plugin
(`PLUGIN_KEY_CHANGED`) e a chave antiga é revogada após a instalação. Chave
revogada bloqueia a atualização.

O cliente baixa com HTTPS/limite, valida `packageSha256`, id/versão do manifesto
e a assinatura do publisher contra a chave do índice **antes** de extrair.
Canais `stable`/`beta`, `yanked`, `minAppVersion`, revogações e cache HTTP
(ETag) estão no índice. O registry local (`file://` ou caminho) só funciona em
developer mode. Vários registries (oficial + empresa) podem ser configurados
separados por vírgula/linha; cada índice tem chave pinada independente e a UI
mostra canal/origem do candidato.

Fixtures locais: `plugins/fixtures/registry.json` (assine/regenere com o CLI).

## 10. UI

Sidebar → **Plugins** (Installed / Discover / Updates), detalhe com publisher,
assinatura, permissões, tools, prompt, skills, logs/auditoria, segredos, temas,
auto-update, rollback e uninstall. Configurações → Plugins: registry,
auto-update, developer mode, trusted, safe mode e "desativar todos".

Temas contribuídos por plugins (`ui.themes`) aparecem no seletor normal
Configurações → Temas, com selo de plugin, e são persistidos em
`settings.themeId` como qualquer tema instalado. Não existe seletor separado
de temas de plugin; desabilitar ou desinstalar o plugin remove o tema e volta
o seletor para o tema ativo padrão.

O painel/views de plugins ocupam o centro/painel direito; slots aparecem na
titlebar, sidebar, composer e detalhe. Templates/shapes são os componentes do
design system (nenhum CSS solto na UI do host).

Instalação por arquivo (`.zplugin`, picker ou drag & drop), URL inspecionada e
deep link (`zylara://plugin/install?url=https%3A%2F%2F…` ou
`zylara://plugin/https%3A%2F%2F…`) sempre passam por inspeção + consentimento.

O agente também pode instalar um plugin pelo tool `install_plugin`:

- Code: caminho `.zplugin` dentro do workspace ou URL HTTPS.
- Chat: apenas URL HTTPS.
- O pacote é validado, as permissões declaradas ficam registradas e o plugin é
  gravado **desativado** (`activation_required`); nenhum código do plugin roda.
- O tool nunca substitui um plugin já instalado. O usuário revisa as permissões
  e ativa o plugin em Settings → Plugins; a ativação é o consentimento.
- Fora do developer mode o pacote precisa ser assinado.

## 11. CLI e fixtures

```bash
node scripts/plugin/cli.mjs init plugins/fixtures/sandbox-demo com.acme.notes
node scripts/plugin/cli.mjs build plugins/fixtures/sandbox-demo plugins/fixtures/sandbox-demo-1.2.0.zplugin \
  --key plugins/fixtures/sandbox-demo/META-INF/publisher.pem \
  --key-id acme-fixture-2026 --publisher acme
node scripts/plugin/cli.mjs pack plugins/fixtures/sandbox-demo plugins/fixtures/sandbox-demo-1.2.0.zplugin \
  --key plugins/fixtures/sandbox-demo/META-INF/publisher.pem \
  --key-id acme-fixture-2026 --publisher acme
node scripts/plugin/cli.mjs sign package.zplugin --key publisher.pem --out package.signed.zplugin
node scripts/plugin/cli.mjs verify plugins/fixtures/sandbox-demo-1.2.0.zplugin
node scripts/plugin/cli.mjs publish package.signed.zplugin --registry plugins/fixtures \
  --key plugins/fixtures/registry-fixture.pem --channel stable
node scripts/plugin/cli.mjs registry plugins/fixtures --base-url "" \
  --key plugins/fixtures/registry-fixture.pem --key-id registry-fixture-2026 \
  --out plugins/fixtures/registry.json
```

`init` também gera um par Ed25519 de fixture. Nunca reutilize as chaves de
fixture para um publisher real.

## 12. Modo Plugin Creator (`/creator`)

`/creator` funciona em conversas do **Chat** (sem workspace) e do **Code** (em
qualquer pasta). Ativa um modo persistente da conversa (evento `creator/mode`,
independente do modo Plano), injeta o workflow de criação de plugins e expõe a
tool `plugin_studio`; `validate_plugin` continua disponível no Code para pacotes
e pastas do workspace, e `install_plugin` continua para URLs/paths do Code.

A fonte do plugin fica em `<app-data>/plugin-studio/<conversation>/<slug>` no
Chat, ou em `<workspace>/plugins/<slug>` no Code com workspace confiável
(`target=studio` usa app-data em qualquer layout). O `plugin_studio` faz
`init` → `write` → `validate` → `pack` (assinatura Ed25519) → `install`
(sempre desativado). A chave do studio e o `studio.json` nunca entram no
`.zplugin`; `write`/`read`/`remove` rejeitam `META-INF/**`.

O conhecimento é autocontido nas skills embarcadas `plugin-authoring`,
`plugin-manifest`, `plugin-ui`, `plugin-genui`, `plugin-agent`,
`plugin-trusted` e `plugin-package`; o agente não lê contrato/schema/docs/
fixtures do repositório nem pede um guia ao usuário. As tabelas factuais são
geradas por `scripts/build-plugin-skills.mjs` a partir do contrato e do schema,
com `--check` no teste de paridade.

O agente nunca ativa o plugin nem concede permissões: o pacote instalado pelo
studio fica `activation_required`; o usuário revisa e ativa em Settings →
Plugins. Trusted exige `allowTrusted`, `unsafe.renderer`, assinatura e
consentimento.

`/creator off` (ou o chip no composer) desativa o modo. O modo não substitui o
modo Plano: com ambos ativos, o agente primeiro planeja e só implementa após a
aprovação.

## 13. Verificação

- `pnpm typecheck`
- `pnpm test`
- `pnpm i18n:check`
- `pnpm plugin:contract` + `node scripts/check-plugin-surfaces.mjs`
- `cd src-tauri && cargo check`
- `cd src-tauri && cargo test --lib plugins::`
- Smoke manual: instalar `.zplugin`, abrir view/painel/aba de sidebar, conceder/revogar
  permissão, ver tool no Chat/Code, alternar um modo de plugin, criar agente por
  template de plugin, habilitar plugin e conferir `plugin_config_changed`, safe
  mode, update/rollback.

Fora do v1 (issue): dylibs Rust, sandbox de SO/sidecar para pacotes públicos,
WASM, OAuth broker, pagamentos, telemetria e dependências plugin→plugin.
`process.spawn` fica em `reservedPermissions` até existir um sandbox de processo.
