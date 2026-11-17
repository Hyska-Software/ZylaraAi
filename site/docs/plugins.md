---
title: Plugins
description: Install extensions from a URL or file, review their permissions, and recover safely when one misbehaves.
---

A plugin is a package that extends Zylara: pages, panels, sidebar entries, settings tabs,
commands, hotkeys, themes, tools, prompt sections, skills, providers, modes and agent
templates. Plugins are optional, and none of them run until you install and enable it.

## What a package contains

A `.zplugin` file is a ZIP with a `manifest.json`, an optional `META-INF/signature.json`, and
the files the plugin needs — UI HTML, backend JavaScript, prompts, skills and locales.

There are three levels:

| Level | What runs | When |
| --- | --- | --- |
| **Declarative** | Nothing: the manifest only adds entries, commands, settings and themes | Always safe to install |
| **Sandboxed** | UI HTML/JS inside an isolated `zplugin` iframe with `allow-scripts` | Default for third-party code |
| **Trusted** | JavaScript in the main window with a narrow bridge | Only with **Allow trusted plugins** on, a signature, and your explicit consent |

A signature proves **who published** the package. It does not make the code safe — read the
permissions before installing.

## Installing

1. Open **Plugins** in the sidebar.
2. Use **Install from URL** (HTTPS only) or pick a `.zplugin` file; drag and drop works too.
3. Press **Inspect package**: the app downloads it, verifies the hash and signature and shows
   the permissions it requests.
4. Review the list, then press **Install**.

Deep links such as `zylara://plugin/install?url=…` open the same review step. A plugin
installed by an agent lands **disabled** with the reason `activation_required`: only you can
enable it.

## Permissions

| Scope | Grants |
| --- | --- |
| `ui.*` | Pages, panels, slots, sidebar entries, settings tabs |
| `agent.*` | Prompt sections, tools, agent templates |
| `providers` | Registering a model provider |
| `chat.read` / `chat.write` | Reading the conversation and adding content |
| `commands`, `hotkeys` | Palette commands and keyboard shortcuts |
| `net:<host>` | Network access to a specific host |
| `fs.read:<glob>` / `fs.write:<glob>` | File access within a glob |

Anything outside the granted scopes fails with `PLUGIN_PERMISSION_DENIED`. `process.spawn`
and `dialog` are reserved and rejected: a plugin cannot start processes or open native
dialogs.

## Settings

**Settings → Plugins**:

| Control | Effect |
| --- | --- |
| **Enable plugins** | Master switch |
| **Automatic updates** | Installs newer versions from the configured registries |
| **Allow trusted plugins** | Required for the trusted lane |
| **Developer mode** | Loads local packages and shows extra diagnostics |
| **Safe mode** | Starts with every plugin disabled, without deleting anything |
| **Registry URLs** | One per line; local paths only in developer mode |
| **Disable all plugins** | Turns everything off at once |

If a plugin makes the app unusable, start in **Safe mode** (or run the app with
`--disable-plugins`), then remove or update the plugin. Your data is untouched.

## The store

Registries are signed JSON documents served over HTTPS. The app checks the registry key, the
package hash and the publisher signature **before** extracting anything, and supports:

- **stable** and **beta** channels;
- revocations, which block an update;
- rollback to the previous version when an update fails;
- multiple registries, comma or newline separated.

The store in v1 has no telemetry and no payments.

## Updating and removing

- **Updates** in the Plugins page shows available versions; **Automatic updates** installs
  them as they appear.
- **Uninstall** removes the code. Plugin key-value data, settings and secrets are kept unless
  you choose to delete them, so reinstalling restores the previous state.
- If an update breaks something, roll back to the previous version from the plugin's page.

## Building a plugin

The SDK is a separate topic, but the entry points are:

- `packages/plugin-sdk` and `packages/create-zylara-plugin` for scaffolding;
- `node scripts/plugin/cli.mjs init|build|pack|sign|verify|publish|registry` for the
  lifecycle;
- `pnpm plugin:review <file.zplugin>` as a review gate;
- the in-app `/creator` mode, which builds a plugin with the bundled authoring skills and
  installs it disabled.

Next: [Settings reference](/docs/settings-reference).
