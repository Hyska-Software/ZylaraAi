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
      "models": [{ "id": "acme-chat-1", "name": "Acme Chat 1" }]
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
`plugins.detail.actions`, `artifact.preview.toolbar`.

Componentes que trusted pode substituir/wrapar:
`layout.shell`, `layout.center`, `chat.welcome`, `settings.dialog`, `plugins.view`.
Views/painéis e slots cobrem o restante da UI sem expor IDs internos.

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
- `net:<host>` (HTTPS, allowlist, redirects revalidados, loopback/privado bloqueado)
- `fs.read:<glob>`, `fs.write:<glob>` (caminho absoluto canonicalizado)
- `events:<scope>`

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
- `cd src-tauri && cargo check`
- `cd src-tauri && cargo test --lib plugins::`
- Smoke manual: instalar `.zplugin`, abrir view/painel, conceder/revogar
  permissão, ver tool no Chat/Code, habilitar plugin e conferir
  `plugin_config_changed`, safe mode, update/rollback.

Fora do v1 (issue): dylibs Rust, sandbox de SO/sidecar para pacotes públicos,
WASM, OAuth broker, componentes GenUI declarados por plugin, pagamentos,
telemetria e dependências plugin→plugin.
