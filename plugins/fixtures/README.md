# Plugin fixtures

- `sandbox-demo/` → `sandbox-demo-1.2.0.zplugin`: slots, view, right panel,
  commands (including `mod+shift+n`), declarative theme, tools
  (`list_notes`/`save_note`), prompt section, skill, artifact viewer, locales and
  hidden backend iframe.
- `trusted-demo/` → `trusted-demo-1.0.0.zplugin`: main-webview React view/panel,
  `chat.welcome` override, `layout.shell` wrapper, global CSS, tool handler,
  command handler and declarative provider (`trusted-gateway`).
- `provider-demo/` → `provider-demo-1.0.0.zplugin`: declarative OpenAI-compatible
  provider (`plugin__com_acme_gateway__gateway`).
- `registry.json`: signed local registry pointing at the three packages with
  relative URLs. Use it in developer mode (Settings → Plugins → registry URL =
  this file path) to exercise Discover/Updates.
- `registry-fixture.pem`, `*/META-INF/publisher.pem`: **test-only** signing keys.
  They are excluded from packages and must never be reused for a real publisher.

Rebuild everything:

```bash
pnpm plugin:fixtures
```

Install manually from Zylara → Plugins → Install file. For the trusted fixture,
also enable Settings → Plugins → Allow trusted plugins and leave safe mode.
