# Plugin SDK

O SDK de referência vive em `packages/plugin-sdk`. O contrato é gerado de
`data/plugin-contract.json` por `pnpm plugin:contract`; o runtime do host é a
fonte de verdade para slots, permissões e limites.

`pnpm plugin:create <pasta> <plugin.id>` gera um plugin sandboxed completo
(manifest, view, slot, backend, skill, locale e chave de teste Ed25519) a partir
de `packages/create-zylara-plugin`. O pacote resultante instala no app depois de
`pnpm plugin:build`/`pnpm plugin:sign` e `pnpm plugin:verify`.

## Ciclo de um plugin sandboxed

1. O iframe carrega uma página do pacote em `zplugin`/`zplugin.localhost`.
2. `<script src="/@zylara/sdk.js"></script>` instala `window.ZylaraPlugin`.
3. O host envia `init` com tema, locale, bundle de tradução e contexto.
4. O plugin chama `onTool` para expor tools e `rpc` para capacidades mediadas.

```js
ZylaraPlugin.on('init', ({ context }) => {
  console.log(context.conversationId);
  ZylaraPlugin.resize();
});

ZylaraPlugin.onTool(async ({ tool, arguments: args }) => {
  if (tool === 'lookup') {
    const response = await ZylaraPlugin.rpc('net.request', {
      url: `https://api.example.com/items?q=${encodeURIComponent(args.query)}`,
    });
    return { content: response.body, summary: `${response.status}` };
  }
  throw new Error(`unknown tool: ${tool}`);
});
```

`onTool` recebe todas as tools do plugin; o nome local está em `tool`. O backend
oculto é iniciado sob demanda. Use `ZylaraPlugin.rpc('storage.set', …)` para
persistir estado e `ZylaraPlugin.t('chave', 'fallback')` para i18n. Para navegar
entre contribuições do próprio plugin use `ZylaraPlugin.openView(id)`,
`openPanel(id)` e `closeOverlays()` (não há API para abrir views de outro plugin).

Uma tool pode devolver `presentation` com `{ kind: 'genui', source }`. O host
valida `source` com o mesmo contrato GenUI do Chat antes de renderizar; um
bloco inválido vira erro da tool, não quebra a timeline.

## Temas no iframe

O host envia tokens CSS (`--background`, `--surface`, `--foreground`,
`--foreground-muted`, `--border`, `--accent`, `--radius-*`, `--font-*`) em
`init` e em cada troca de tema. Use-os diretamente; não assuma cores do host.
`prefers-reduced-motion` é refletido em `html[data-reduce-motion="true"]`.

## Trusted

Trusted não usa iframe. `runtime.entry` é avaliado na webview principal com um
objeto `host`; registre React components/tools/handlers e limpe tudo em
`deactivate`. Veja `plugins/fixtures/trusted-demo/main.js`.

```js
host.registerPlugin({
  activate(host) {
    host.registerView('lab', function Lab() {
      return host.react.createElement('div', null, 'Hello');
    });
    host.registerToolHandler('echo', ({ arguments: args }) => ({
      content: String(args.text ?? ''),
    }));
    host.addGlobalCss('.my-plugin { color: var(--accent); }');
  },
  deactivate() {},
});
```

Erros de um plugin trusted isolam a contribuição e desativam o plugin após 3
falhas. O React compartilhado evita duas cópias do React e hooks inválidos.
O bridge `host.stores.{ui,app,chat}` expõe `getState/setState/subscribe` apenas
para a lane trusted; código sandboxed nunca recebe esses objetos.

## Tipos

`packages/plugin-sdk/src/contract.generated.ts` contém `PLUGIN_API_VERSION`,
`SLOT_IDS`, `COMPONENT_IDS`, `PERMISSION_IDS`, `RESERVED_PERMISSION_IDS` e
`PLUGIN_LIMITS`. Mantenha o manifesto sincronizado com o contrato; o backend
rejeita ids/slots/permissões desconhecidos.

`packages/plugin-sdk/src/index.ts` tipa as contribuições:

| Tipo | `contributes` | Notas |
|---|---|---|
| `ModeContribution` | `modes` | `prompt`/`promptFile`, `profiles`, `tools.add/remove`, `writes`, `defaultOn`; permissão `agent.modes` |
| `AgentTemplateContribution` | `agentTemplates` | capabilities deny-only, `permissionMode`; permissão `agent.templates` |
| `SidebarTabContribution` | `ui.sidebarTabs` | `sidebars`, `entry`/`component`, `order`, `badge`; permissão `ui.sidebar` |
| `ProviderContribution` | `providers` | `icon`, `authHeader`, `authPrefix`, `headers` (sem credenciais); permissão `providers` |

`PluginPermission` é derivado de `PERMISSION_IDS` e aceita os escopos
(`ui.slot:*`, `ui.override:*`, `events:*`, `net:*`, `fs.read:*`, `fs.write:*`).
`ReservedPermission` lista o que o host publica mas **não** implementa
(`process.spawn`, `dialog`) — declarar uma dessas falha com
`PLUGIN_PERMISSION_RESERVED`.

`plugins/fixtures/modes-demo` é o exemplo executável: dois modos (`review` com
`promptFile` + `writes: "blocked"`, `deep-dive` inline) e um template de agente
`reviewer` com `permissionMode: "read_only"`. Cada modo também aparece como slash
command (`/<modeId>`, ou `/<plugin-slug>-<modeId>` em caso de colisão), e o
template enviado ao backend leva `template: { pluginId, templateId }`, auditado
como `agent.template`.

`plugins/fixtures/surfaces-demo` cobre a camada de UI: envolve `code.workbench`,
substitui `settings.page` e injeta uma linha em `palette.actions` — o roteiro de
aceitação para "qualquer alteração de UI".
