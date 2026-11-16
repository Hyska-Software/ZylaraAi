---
name: plugin-genui
description: Complete Zylara GenUI reference for plugins: the ui block format, every built-in component and prop, design rules, limits, tool presentation and plugin GenUI components (sandboxed or trusted).
---

# Plugin GenUI

Use this skill when a plugin tool returns a `ui` block, when a plugin declares a
GenUI component, or when a plugin renders a `presentation` of kind `genui`.

## Generated GenUI contract

<!-- BEGIN GENERATED:genui -->
### GenUI components

| Type | Kind | Category | Summary | Props |
| --- | --- | --- | --- | --- |
| `card` | container | layout | Surface with a title/subtitle/footer/icon that groups one unit of content. | `title`: text ≤120; `subtitle`: text ≤240; `footer`: text ≤200; `variant`: enum (default/accent/muted); `icon`: icon |
| `stack` | container | layout | Flex container for stacking or aligning components. | `direction`: enum (column/row); `gap`: enum (none/sm/md/lg); `align`: enum (start/center/end/stretch); `justify`: enum (start/center/between/end); `wrap`: boolean |
| `grid` | container | layout | Responsive grid for metrics and cards side by side. | `columns`: number; `gap`: enum (none/sm/md/lg) |
| `tabs` | container | layout | Tabs for switching between views of the same subject. | `label`: text ≤80 |
| `reveal` | container | layout | Collapsible section for details that do not need to take up space. | `title`: text ≤120; `open`: boolean |
| `section` | container | layout | Section header (eyebrow, title, icon, description and divider) with content below — no card frame. | `title`: text ≤100; `eyebrow`: text ≤40; `description`: text ≤200; `icon`: icon; `divider`: boolean |
| `divider` | leaf | layout | Horizontal separator with an optional label. | `label`: text ≤60 |
| `table` | leaf | data | Compact data table with a fixed header. | `columns`: array; `rows`: array; `caption`: text ≤200 |
| `chart` | leaf | data | SVG bar, line or pie chart for numeric series. | `type`: enum (bar/line/pie); `data`: array; `title`: text ≤120; `suffix`: text ≤24 |
| `stat` | leaf | data | Single metric with label, value and trend. | `label`: text ≤60; `value`: text ≤32; `trend`: enum (up/down/flat); `hint`: text ≤200 |
| `progress` | leaf | data | Progress bar for a completed fraction. | `value`: number; `max`: number; `label`: text ≤100; `suffix`: text ≤24 |
| `timeline` | leaf | data | Timeline of events with status. | `items`: array |
| `steps` | leaf | data | Numbered steps with the current step highlighted. | `items`: array; `current`: number |
| `checklist` | leaf | data | List with an icon/state per item (simulations, stages, capabilities). | `items`: array |
| `keyvalue` | leaf | data | Label/value pairs for short specifications. | `items`: array |
| `list` | leaf | data | Bulleted or numbered list with optional descriptions. | `items`: array; `ordered`: boolean |
| `code` | leaf | content | Code block with syntax highlighting and a copy button. | `code`: text ≤20000; `language`: text ≤32; `title`: text ≤120 |
| `quote` | leaf | content | Short quote with attribution. | `text`: text ≤1000; `cite`: text ≤200 |
| `text` | leaf | content | Plain text paragraph inside the generative UI. | `text`: text ≤1200; `variant`: enum (body/muted/lead/strong/small) |
| `callout` | container | content | Colored info/warning highlight — DEPRECATED: do not emit in new responses. | `variant`: enum (info/warning/success/danger); `title`: text ≤120; `text`: text ≤800 |
| `badge` | leaf | content | Short status label. | `label`: text ≤40; `tone`: enum (neutral/accent/success/warning/danger/outline); `icon`: icon |
| `image` | leaf | content | Remote image or data URI with a caption. | `src`: imageSrc; `alt`: text ≤300; `caption`: text ≤200; `size`: enum (full/thumb/avatar); `aspect`: enum (auto/video/square/wide) |
| `source` | leaf | content | External source/link chip with the site name. | `label`: text ≤80; `href`: url; `title`: text ≤120 |
| `link` | leaf | content | External link that opens in the default browser. | `href`: url; `label`: text ≤120 |
| `actions` | leaf | interaction | Row of suggested actions that fill the composer or copy text. | `items`: array; `align`: enum (start/end) |
| `choices` | leaf | interaction | Interactive options group (radio, checkbox or segmented) with a count and a submit that sends the selection to the composer. | `label`: text ≤80; `mode`: enum (single/multiple); `layout`: enum (list/segmented); `options`: array; `default`: array; `countLabel`: text ≤60; `submitLabel`: text ≤40; `submitPrefix`: text ≤300 |

### GenUI rules

| Severity | Rule | Prompt guidance |
| --- | --- | --- |
| warning | A raiz tem componentes demais. | Group the content into 1 root `card`/`stack` (max. 4 root components). |
| warning | Card de topo sem `title`: a hierarquia fica ambígua. | Every top-level `card` needs a `title`. |
| warning | Card dentro de card duplica a hierarquia. | Never nest `card` inside `card`. |
| warning | Caixa de destaque colorida (`callout`) não faz parte do padrão do chat. | NEVER use `callout` (colored note box): caveats go in Markdown; status in `badge`. |
| warning | Muitos cards no mesmo bloco. | At most 4 `card` per block. |
| warning | O número de filhos do `grid` não completa as colunas. | In `grid`, the number of children must fill the columns. |
| warning | Grid com muitos filhos por linha. | At most 3 children per column in `grid`. |
| warning | Divisores demais fragmentam o conteúdo. | Use at most 2 `divider`. |
| warning | Container sem filhos não tem conteúdo. | Do not emit empty containers. |
| warning | Gráfico sem `title`. | Every `chart` needs a `title`. |
| warning | Gráfico com menos de 2 pontos. | `chart` needs 2+ points; a single value goes in `stat`. |
| warning | Gráfico de pizza com fatias demais fica ilegível. | Pie: at most 7 slices. |
| warning | Tabela com muitas colunas. | Table: at most 8 columns. |
| warning | Há linha com número de células diferente das colunas. | Each table row must have the same number of cells as the columns. |
| warning | Métrica com texto longo demais. | `stat`: label ≤ 32, value ≤ 20, hint ≤ 100. |
| warning | Lista muito longa. | `list`: at most 20 items. |
| warning | Linha do tempo muito longa. | `timeline`: at most 12 items. |
| warning | Passos demais para uma UI compacta. | `steps`: at most 10 items. |
| warning | Muitos pares chave/valor. | `keyvalue`: at most 12 pairs. |
| warning | Abas demais. | `tabs`: at most 6 tabs (2–4 ideal). |
| warning | UI densa demais para uma mensagem de chat. | Compact UI: ~60 components and at most 6 levels. |
| warning | Há sintaxe Markdown dentro de props (não é renderizada). | Props are plain text: no `**`, `#` or Markdown links inside the block. |
| warning | Emoji decorativo em título/rótulo de UI. | No decorative emojis in titles/labels. |
| warning | Rótulo terminando com ponto final. | No trailing period in labels and buttons. |
| warning | Texto em caixa alta demais. | No ALL CAPS in labels. |
| warning | Ações repetidas no mesmo bloco. | Actions with distinct labels. |
| warning | Mais de uma ação primária. | At most 1 `primary` action per block. |
| warning | Rótulo de ação longo. | `actions` labels: verb + object, ≤ 40 chars. |
| warning | Seção sem cabeçalho não agrega hierarquia. | Every `section` needs a `title` or `eyebrow`. |
| warning | Grupo de escolhas sem ação de envio. | Every `choices` needs a `submitLabel`. |

### GenUI limits

```json
{
  "sourceChars": 200000,
  "depth": 8,
  "nodes": 120,
  "props": 24,
  "arrayItems": 200,
  "stringChars": 4000,
  "diagnosticsPerCode": 3
}
```
<!-- END GENERATED:genui -->

## `ui` block format

A tool result may include:

```json
{
  "content": "Three services are healthy.",
  "summary": "Health check",
  "presentation": {
    "kind": "genui",
    "source": "```ui\n{\"root\":\"card1\",\"components\":[{\"type\":\"card\",\"id\":\"card1\",\"props\":{\"title\":\"Services\"},\"children\":[\"s1\"]},{\"type\":\"stat\",\"id\":\"s1\",\"props\":{\"label\":\"API\",\"value\":\"OK\",\"tone\":\"success\"}}]}\n```"
  }
}
```

The host validates the block with the same contract as the chat. An invalid
block becomes a tool error; it never crashes the timeline. Use Markdown for
prose and a `ui` block only for structured/actionable data. Do not duplicate the
same content in both.

## Plugin GenUI components

Declare up to 8 components under `contributes.ui.genui.components`; require
`ui.genui` (and `unsafe.renderer` for trusted rendering):

```json
{
  "id": "metric",
  "title": "Metric",
  "summary": "One KPI with a trend",
  "props": {
    "label": { "type": "text", "required": true, "maxChars": 40 },
    "value": { "type": "text", "required": true, "maxChars": 40 },
    "trend": { "type": "enum", "values": ["up", "down", "flat"] }
  },
  "render": { "kind": "sandbox", "entry": "ui/metric.html", "height": 120 }
}
```

- `sandbox`: the host loads `entry` in an iframe and sends the validated props
  through `ZylaraPlugin.onGenui((props) => { ... })`; call `resize()` after
  rendering. No host DOM or direct network access.
- `trusted`: `render.component` names a React component registered by
  `main.js` through `host.ui.registerGenuiComponent`; requires
  `unsafe.renderer` and the trusted loader.
- Props schema: max 16 properties; `type` is `text`, `number`, `boolean`,
  `enum` or `icon`; `maxChars` 1–4000; enum 1–16 string values; schema ≤ 8 KiB.
- Height is 80–480. The host renders the component inside a bounded block.

## Rules

- Root: one `card` or `stack`; maximum 4 root components.
- Every top-level card has a short `title`; never nest a card inside a card.
- At most 4 cards per block; use a grid of `stat` components for metrics.
- Use `badge` for status, Markdown for caveats. Never use `callout`.
- Use only generated component types and props; unknown fields are warnings or
  errors. Icons use the generated icon allowlist.
- Keep text within the generated char limits; use `table` for compact tabular
  data and `code` for snippets.
- Interactive components use only declared actions; never send a chat message
  from a GenUI component without an explicit user action.

## Verification

- Validate the block with `validate_ui` before returning it.
- Render the component in all supported layouts and themes; no host CSS
  assumptions.
- Sandbox GenUI calls `resize()` and handles missing/invalid props defensively.
- Trusted GenUI is registered before activation and cleaned up in `deactivate`.
