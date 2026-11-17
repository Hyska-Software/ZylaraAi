# Plugin security model

## Fronteiras

- **Declarative**: só manifesto; nada executa no host.
- **Sandboxed**: iframe `sandbox="allow-scripts"` sem `allow-same-origin`,
  `allow-popups`, `allow-forms` ou `allow-top-navigation`. Origem separada via
  protocolo `zplugin`; CSP por resposta; sem listagem de diretório; assets só da
  versão ativa.
- **Trusted**: JavaScript na webview principal, por definição com privilégios do
  app. Exige `pluginAllowTrusted`, permissão `unsafe.renderer` e consentimento
  extra. Não é um sandbox; a assinatura identifica o publisher, não prova
  segurança.

Nenhum `invoke` genérico é exposto. O iframe só fala com `plugin_rpc`, que
verifica grants persistidos no Rust e audita cada capacidade.

## Pacotes

- ZIP sem symlink, `..`, caminho absoluto, ADS (`:`), nomes reservados do
  Windows, colisão case-insensitive ou entradas especiais.
- Limites de pacote/arquivos/bytes descompactados/prompt/KV/rede/RPC/tool
  definidos no contrato; ZIP bomb falha de forma explícita.
- Extração em staging e rename atômico; rollback em falha.
- Assinatura Ed25519 sobre o digest canônico dos arquivos (não os bytes do ZIP).
- Publisher/registry keys pinadas; chave revogada bloqueia. Rotação de publisher
  exige consentimento digitado e revoga a chave anterior após instalar.

## Rede

`net.request` exige grant `net:<host>`, HTTPS (HTTP só em developer mode),
bloqueia localhost/loopback/privado/link-local/metadata, resolve DNS e revalida
cada redirect (máx. 3), aplica timeout, limita corpo e remove `set-cookie`,
`authorization` e `www-authenticate` da resposta. Credenciais só entram via
`secretRef` mediado; o valor nunca volta ao plugin.

## Arquivos

`fs.read/write/list` exigem globs `fs.read:<glob>`/`fs.write:<glob>`, rejeitam
caminhos relativos, canonicalizam o caminho (symlink/`..`) e só então comparam
com o glob. Leitura 10 MiB, escrita 2 MiB, listagem 500 entradas.

## Segredos

`secrets.json` guarda `plugin:<id>:<chave>`. O renderer nunca recebe o valor;
`secrets.has/names` só expõem existência/nomes. `secrets.use` injeta o segredo
em um header de `net.request`; `secrets.read` é trusted-only, devolve o valor
apenas para plugins trusted com a permissão concedida e passa pela auditoria
normal (`plugin_audit`, digest dos params — nunca o valor).

## Permissões reservadas

`reservedPermissions` lista capacidades publicadas no contrato que este host
**não** implementa (`process.spawn`, `dialog`). Um manifesto que as declare é
recusado com `PLUGIN_PERMISSION_RESERVED`, em vez de receber uma permissão sem
API. O renderer também só aplica contribuições cuja permissão está concedida
(`pluginHasPermission`), então revogar uma permissão desliga a superfície.

## Superfícies novas

- `ui.sidebar` (abas de conteúdo na sidebar) e `ui.genui` (componentes de UI
  generativa) são low/medium: nunca executam código no host sem sandbox ou lane
  trusted.
- `agent.modes` pode injetar instruções e alterar o catálogo de tools do turno;
  um modo com `writes: "blocked"` esconde tools mutadoras no catálogo **e** no
  prompt. O estado do modo vive no backend (`code_events`), nunca no payload do
  renderer.
- `agent.templates` só pode **restringir** capabilities (deny-only); criar o
  agente continua sendo um ato explícito no editor.
- `providers` não aceita credenciais declarativas: headers `authorization`,
  `cookie` e `host` são recusados no manifesto; a chave entra pelo formulário
  normal e fica em `secrets.json`.
- `chat.write` é mediado por `chat.draft` (o backend emite o texto e o host o
  aplica no composer); o plugin nunca escreve no DOM.

## Safe mode e crash loop

Antes de carregar contribuições, o manager grava `plugin-boot.json`. O renderer
chama `plugin_runtime_ready` depois de montar o host; se o marcador sobrevive, o
próximo boot entra em safe mode. `--safe-mode`/`--disable-plugins` também
desligam terceiros. Safe mode nunca apaga plugins, dados ou segredos.

## Auditoria

Toda capacidade privilegiada gera `plugin_audit` (decisão + digest dos params) e
chamadas de tool geram `plugin_tool_calls`. Logs passam por limite por plugin e
são redigidos quando contêm segredos conhecidos.
