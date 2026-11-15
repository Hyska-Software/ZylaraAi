# Acme Notes (fixture)

Sandboxed reference plugin. It exercises slots, a sidebar view, a right panel,
commands, a declarative theme, plugin tools, prompt sections, skills, an artifact
viewer, locales and the hidden backend iframe.

Build and sign it with the fixture key:

```bash
node scripts/plugin/cli.mjs pack plugins/fixtures/sandbox-demo plugins/fixtures/sandbox-demo.zplugin \
  --key plugins/fixtures/sandbox-demo/META-INF/publisher.pem \
  --key-id acme-fixture-2026 --publisher acme
node scripts/plugin/cli.mjs verify plugins/fixtures/sandbox-demo.zplugin
```

Install the `.zplugin` from Zylara → Plugins → Install file. The key is a
non-production fixture; never reuse it for a real publisher.
