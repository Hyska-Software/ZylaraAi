---
title: Models and providers
description: Connect OpenCode, OpenAI, Anthropic, Gemini and 21 other providers, choose a model, control thinking and read usage.
---

Zylara does not include model access. You connect a provider, and requests go from your
machine straight to that provider's API with your credential.

## Supported providers

The bundled catalog has **26 providers and 464 models**. Five are featured in
**Settings → Providers**:

| Provider | Authentication | Notes |
| --- | --- | --- |
| **OpenCode Go** | OpenCode Console key | Subscription-style access to the Go catalog (45 models) |
| **OpenCode Zen** | OpenCode Console key | Credit-based access to the Zen catalog (92 models) |
| **OpenAI** | API key `sk-…` **or** **Continue with ChatGPT** | The ChatGPT sign-in uses your plan for eligible models |
| **Anthropic** | API key `sk-ant-…` | Official API, pay-as-you-go; no subscription sign-in |
| **Gemini** | API key `AIza…` | Also accepts `GOOGLE_API_KEY` |

**See more providers** lists 21 further key-based services: DeepSeek, xAI (Grok), Mistral,
Moonshot (Kimi), Z.AI (GLM), MiniMax, Inception (Mercury), StepFun, OpenRouter, Vercel AI
Gateway, Groq, Together AI, Fireworks AI, Cerebras, NVIDIA NIM, DeepInfra, SiliconFlow,
SambaNova, Scaleway, Novita AI and Venice AI.

## Connecting a provider

1. Open **Settings → Providers**.
2. Press **Connect** on the provider and paste the key.
3. Press **Continue**. Saving a key also fetches the model list for that account.

The provider row shows where the credential came from:

| Badge | Meaning |
| --- | --- |
| **Configured** | Key saved in `secrets.json` |
| **Environment variable** | Detected from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OPENCODE_API_KEY`, …) |
| **OpenCode CLI** | Reused from an existing OpenCode CLI login |
| **ChatGPT account** | Signed in with ChatGPT instead of a key |
| **Missing** | No credential; models from that provider cannot be used |

The resolution order is settings → environment → OpenCode CLI, and keys are never sent to
the interface. Use **Test connection** to validate a key without changing anything.

### Continue with ChatGPT

OpenAI supports the official *Sign in with ChatGPT* flow:

1. **Settings → Providers → OpenAI → Continue with ChatGPT**.
2. The system browser opens the OpenAI consent page; the app receives the callback on a
   loopback port.
3. When it returns, the provider badge shows **ChatGPT account** and a **ChatGPT plan** chip
   appears in the title bar.

Eligible requests use your plan; the limit is shared across apps that use the same account.
The app never invents a percentage or a reset time — **Manage usage** opens the provider's
own page. You can keep an API key as a fallback (**Use API key as fallback**) and
**Sign out** revokes the session.

### Custom OpenAI-compatible providers

**Add provider** registers any endpoint that speaks the OpenAI chat protocol — useful for
Ollama, LM Studio or vLLM. `http://` is accepted only for localhost; remote endpoints must
use HTTPS. Custom providers are stored with an id starting with `custom__`.

## The model catalog

The catalog ships inside the app, so the model picker works offline. It is generated from
the providers' official documentation and models.dev, and each entry records context size,
maximum output, price, protocol, vision and reasoning support.

- Saving a key merges the models that account reports.
- **Refresh models** (in **Settings → Providers**, or **Reload model catalog** in the
  command palette) re-reads every configured provider.
- Account-only models that the catalog does not describe are marked **Estimated**.

## Choosing a model

Click the model pill in the composer to open **Select model**:

- **Search models…** matches name, family, identifier and capabilities.
- Filters: **Favorites**, **Vision**, **Reasoning**, **Free**.
- Provider dropdown, with **All providers** by default.
- Badges per model: **Free**, **Vision**, **Reasoning**, **Open**, **Preview**,
  **Unavailable**, and **ChatGPT plan** for models included in your plan.
- Detail lines: **Context**, **Max output**, **Cost (1M tok.)**, **Input**, **Protocol**,
  **Knowledge until**, **Release**.
- **Use this model** confirms; **In use** marks the current one.

The model is fixed for the duration of a turn ("Wait for the current response to finish"
otherwise) and belongs to the conversation or Code session, not to the app. Mark favorites
to keep a short list at the top.

## Thinking modes

The ✦ button next to the model pill sets how much the model should reason:

| Control | Options |
| --- | --- |
| **Off** | Answers directly, without extended reasoning |
| Effort | **Minimal**, **Low**, **Medium**, **High**, **Very high**, **Maximum** |
| Budget | **Fast (~4k)**, **Balanced (~8k)**, **Deep (~16k)**, **Maximum (~32k)**, or a slider between the model's limits |
| On | Toggle-only models |

Not every model exposes the control; when it does not, the app shows *"This model does not
expose a reasoning control"*, and thinking-only models require choosing an effort level.
Reasoning is replayed to the next request for the model families that accept it; choosing
**Off** disables that replay.

## Usage and cost

- **Settings → General → Show token usage** adds tokens and duration under each answer.
- The model details show the price per million tokens reported by the catalog.
- **Prompt cache**: with **Settings → Tools → Prompt cache → Show indicator** enabled, a
  cache chip appears in the Chat composer and in the Code context meter, with the hit rate
  and, when the cache breaks, the reason. See [Goals and tasks](/docs/goals-and-tasks#context-and-cache).
- Agents have a per-agent daily budget in **Settings → Agents → Budget**.

## Timeouts and retries

Per provider, **Settings → Providers → Reliability** controls **Response headers timeout (s)**
(120), **First token timeout (s)** (180), **Stream idle timeout (s)** (120) and **Total stream
timeout (s)** (1800) — `0` disables a limit — plus **Retries per step**, backoff and the
`Retry-After` cap. Defaults work for most networks; raise the first-token timeout if a
reasoning model takes long to start.

## Common situations

| Situation | What it means |
| --- | --- |
| "No API key for *provider*" | The selected model belongs to a provider you have not connected |
| Model shows **Unavailable** | The provider no longer serves it, or your account has no access |
| Answer stops early | Provider limit, context window reached, or the network dropped; the partial text is kept |
| **Estimated** badge | The model came from the account list, not from the bundled catalog |

More in [Troubleshooting](/docs/troubleshooting).
