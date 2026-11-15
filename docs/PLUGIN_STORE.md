# Plugin store

O registry é um JSON assinado servido por HTTPS (CDN/GitHub Pages/releases) ou
lido de um caminho local em developer mode. Não há servidor próprio no v1.
Settings → Plugins aceita vários registries separados por vírgula/linha; cada
índice tem sua própria chave pinada e o resultado é mesclado por id.

## Formato

```json
{
  "schemaVersion": 1,
  "name": "Zylara plugins",
  "generatedAt": "2026-11-14T00:00:00Z",
  "plugins": [{
    "id": "com.acme.notes",
    "name": "Acme Notes",
    "version": "1.2.0",
    "apiVersion": 1,
    "publisher": {
      "id": "acme",
      "name": "Acme",
      "keyId": "acme-2026",
      "publicKey": "base64-ed25519"
    },
    "summary": "Notes panel and tools",
    "description": "…",
    "icon": "https://cdn.example/icons/notes.png",
    "homepage": "https://acme.example/notes",
    "packageUrl": "acme-notes-1.2.0.zplugin",
    "packageSha256": "hex",
    "packageSize": 17611,
    "minAppVersion": "0.11.0",
    "channel": "stable",
    "permissions": ["ui.view", "agent.tools"],
    "yanked": false,
    "publishedAt": "2026-11-14T00:00:00Z"
  }],
  "revoked": [{ "id": "com.acme.notes", "version": "1.1.0", "reason": "CVE-…" }],
  "signature": {
    "schemaVersion": 1,
    "algorithm": "ed25519",
    "keyId": "registry-2026",
    "publicKey": "base64-ed25519",
    "signature": "base64"
  }
}
```

A assinatura cobre `schemaVersion`, `name`, `generatedAt`, `plugins` e `revoked`
em JSON canônico (chaves ordenadas, sem espaços). `packageUrl` relativo é
resolvido contra o registry; pacotes locais só funcionam em developer mode.

## Fluxo

1. `store_refresh` baixa com ETag/cache (15 min) e valida assinatura/chave.
   Se o registry estiver offline, o índice assinado do cache continua sendo
   usado (nunca um cache sem verificação de assinatura/pin); cache JSON corrompido
   é descartado e o índice é baixado novamente.
2. Chave do registry é pinada; troca/revogação bloqueia.
3. `check_plugin_updates` compara semver e lista permissões novas.
4. `update_plugin`/`install_plugin_store` exige consentimento quando há
   permissão nova; baixa, confere SHA-256, id/versão e assinatura do publisher
   contra a chave do índice **antes** de extrair.
5. Falha restaura a versão anterior; rollback explícito usa `rollback_plugin`.
6. Versão revogada é desabilitada com motivo, mantendo dados.

## Publicação (referência)

- Pacotes em GitHub Releases/R2/CDN.
- Registry gerado por CI a partir dos pacotes e assinado com a chave do registry.
- Revisão manual obrigatória para trusted/high-risk; a assinatura não substitui
  revisão.
- Gate local/CI: `pnpm plugin:review <arquivo.zplugin>` verifica ZIP/assinatura,
  permissões contra o contrato, binários e heurísticas de comandos perigosos.
  O workflow `.github/workflows/plugin-review.yml` roda em PRs com `.zplugin` e
  exige `allow_high_risk` explícito no dispatch manual após revisão humana.
- CLI: `node scripts/plugin/cli.mjs registry <dir> --base-url <url> --key …`.

## Fixtures

`plugins/fixtures/registry.json` é assinado com
`plugins/fixtures/registry-fixture.pem` e aponta para pacotes irmãos com URL
relativa. Em developer mode, configure a URL do registry com o caminho local do
JSON e use Discover/Updates.
