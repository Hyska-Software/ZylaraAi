# Acme Trusted Lab (fixture)

Trusted reference plugin. It replaces the chat welcome component, wraps the
application shell, adds a React view and panel, injects global CSS and registers
a tool handler.

Enabling it requires **Settings → Plugins → Allow trusted plugins** plus the
installation consent. The signing key is a fixture, never reuse it.

```bash
node scripts/plugin/cli.mjs pack plugins/fixtures/trusted-demo plugins/fixtures/trusted-demo-1.0.0.zplugin \
  --key plugins/fixtures/trusted-demo/META-INF/publisher.pem \
  --key-id acme-fixture-2026 --publisher acme
```
