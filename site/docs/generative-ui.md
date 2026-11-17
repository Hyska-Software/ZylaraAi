---
title: Generative UI
description: The agent can answer with native cards, tables, charts, timelines and small interactive forms instead of plain text.
---

Sometimes the best answer is not a paragraph. Zylara lets the model emit a declarative block
that the app renders with native components: a comparison table, a chart, a checklist, a
timeline, a set of cards — or a small form that fills the composer for you.

## How it works

The model writes a fenced block tagged `ui` containing JSON. The app validates that JSON
against a fixed contract (`data/genui-contract.json`) and renders only whitelisted
components. There is no HTML, CSS or JavaScript in the block, and nothing is executed.

If the JSON is invalid, the block is shown as code instead of breaking the message. The same
contract is enforced in the backend and in the interface, and both are tested against the
same fixtures, so a block that renders in one place renders in the other.

## What can be rendered

| Family | Components |
| --- | --- |
| Layout | **card**, **stack**, **grid**, **tabs**, **reveal**, **section**, **divider** |
| Data | **table**, **chart** (bar, line, pie), **stat**, **progress**, **timeline**, **steps**, **checklist**, **keyvalue**, **list** |
| Content | **code**, **quote**, **text**, **badge**, **image**, **source**, **link** |
| Interaction | **actions**, **choices** |

Typical results: a comparison of plans as a table, a monthly series as a bar chart, a
migration as numbered steps, an incident as a timeline, a decision as cards with a
**Compare scenarios** action.

## Interaction is declarative

Two components can respond to clicks, and neither sends anything on its own:

- **choices** — radio, checkbox or segmented options with a submit button. Submitting fills
  the composer with your selection (prefixed by a sentence chosen by the agent); you review
  and send.
- **actions** — up to four suggested next steps. A `prompt` action fills the composer; a
  `copy` action copies text to the clipboard.

There are no free-text inputs inside a rendered block: the composer remains the only place
where you type. That is deliberate — it keeps the transcript readable and avoids a second,
hidden input path.

## Limits

| Limit | Value |
| --- | --- |
| Components per block | 120 |
| Nesting depth | 8 levels |
| Props per component | 24 |
| Array items (table rows, list items) | 200 |
| Text length per prop | 4,000 characters |
| Source size per block | 200,000 characters |
| Blocks per answer | 2 |

Design rules are enforced too: at most four cards, charts need a title and at least two
points, tables have at most ten columns, and a grid must be filled by its children.

## When you will see it

The agent decides. It tends to use a block when you ask for a comparison, a dashboard, a
plan, a checklist or a set of options — or when a table would be clearer than prose. Ask
directly if you want one:

> Compare the three plans in a table, with a column for what changes at each tier.

Blocks render in Chat, Code and agent transcripts. They are part of the message, so they are
stored and exported with it.

## Safety

- Only the documented components and props render; unknown ones are ignored.
- No `eval`, no inline script, no arbitrary URLs: images and links must be `http(s)`.
- The block cannot call tools, change settings or start a turn.
- Content inside a block is model output, so treat it like any other answer.

Next: [Markdown and math](/docs/markdown-and-math).
