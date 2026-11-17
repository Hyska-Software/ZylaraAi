---
title: Web search and sources
description: Let the agent search the web, read pages, and cite every source it used.
---

With web search enabled, the agent can look things up instead of relying on its training
data, and every page it uses is listed as a source.

## Turning it on

- The globe toggle in the composer enables **Web search** for the conversation.
- **Settings → Tools → Agent tools → Web search** controls the default.
- The command palette has **Enable web search** / **Disable web search**.

When the toggle is off, the tool is not offered to the model at all, so it cannot search by
accident.

## What happens in a turn

1. The model decides a query is needed and calls `web_search` with a query and an optional
   result count (1–8, default 8).
2. The app queries a search engine and returns titles, URLs and snippets.
3. If a result looks relevant, the model calls `fetch_url` to read the page, which is
   downloaded, reduced to readable text and truncated to fit the context.
4. The answer cites the URLs it used.

Searches go to Bing (RSS endpoint, with HTML and DuckDuckGo fallbacks) — not to the model
provider. That means the query leaves your machine to a search engine even when the model
itself runs elsewhere. Keep web search off for queries you do not want to send to a search
engine.

## Citations

- Citation chips appear under the answer, with a count ("N sources") and an action to open
  the full list in the side panel.
- The **Sources** panel lists every page with title, domain and link; links open in your
  default browser.
- A citation is attached only to pages the agent actually read, not to every search result.

## What it is good for

- Recent news, releases, prices, documentation versions and anything after the model's
  knowledge cutoff.
- Checking a claim against a primary source.
- Reading a specific URL you provide.

## Limits and behaviour

- Results are capped at eight per call; snippets are short, so the model must fetch a page
  to read it in full.
- Some pages block automated requests or return JavaScript-only content; the agent reports
  the failure instead of inventing content.
- Page content is treated as **untrusted data**: the agent is instructed not to follow
  instructions found on a page, and to treat them as content to summarize.
- Search quality depends on the query language; the tool asks the model to search in the
  language of your question.

## Privacy

Search queries and fetched URLs leave your machine. If you need a fully local turn, disable
web search in the composer and in **Settings → Tools**. What else leaves the machine is
listed in [Data and privacy](/docs/data-and-privacy#what-leaves-the-machine).

Next: [Generative UI](/docs/generative-ui).
