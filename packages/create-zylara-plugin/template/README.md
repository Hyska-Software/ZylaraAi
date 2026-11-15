# __PLUGIN_NAME__

Generated sandboxed plugin.

1. Edit `manifest.json`, `ui/page.html`, `backend/index.html` and
   `skills/example/SKILL.md`.
2. Enable **Settings → Plugins → Developer mode** and use **Load unpacked**
   (or `node ../../scripts/plugin/cli.mjs dev .`).
3. Build a signed package:
   `node ../../scripts/plugin/cli.mjs build . __PLUGIN_ID__.zplugin --key META-INF/publisher.pem --publisher example`
4. Verify it with `node ../../scripts/plugin/cli.mjs verify __PLUGIN_ID__.zplugin`.

`META-INF/publisher.pem` is a local test key. Never publish or commit it for a
real plugin; rotate keys with the publisher flow before using the public store.
