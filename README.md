<p align="center">
  <img src="./brand.jpg" alt="chat-demo-unrestricted — Yes, Sun Xiaochuan Chat" width="760">
</p>
<h1 align="center"><img src="brand_2.jpg" alt="你应该放弃这世间所有的C端客户端，来体验宇宙最强对抗路神作，这是你唯一和顶级开源模型厮杀的机会" width="250"></h1>

<h1 align="center">deepseek unrestricted</h1>

<p align="center">
  Yes, Sun Xiaochuan Chat — a static DeepSeek chat front end with an unrestricted mode, editable replies, and direct control over model parameters<br>
  English | <a href="./README.zh-CN.md">简体中文</a>
</p>

> This is an **unofficial fork** of the official demo [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo), MIT licensed.
> Every change lives in the browser: how the request body is assembled, how replies are stored, and how they are rendered.
> There is no proxy and no relay service. Your API key and conversations stay in your own browser.
>
> 🔗Live demo: <https://dawangnailong.github.io/chat4code-unrestricted/>
>
> 📦Repository: <https://github.com/dawangnailong/chat4code-unrestricted>
>
> 🎥Intro video: <https://www.bilibili.com/video/BV1m3s66WESg/>
>
> 📚Reference paper: <https://arxiv.org/pdf/2403.12171>

<p align="center">
  <img src="./Demo%20Picture.png" alt="Chat demo — technical Q&A in unrestricted mode" width="860">
</p>

---

## Contents

- [1. What this is](#1-what-this-is)
- [2. Restrictions in the original](#2-restrictions-in-the-original)
- [3. What this fork changes](#3-what-this-fork-changes)
- [4. Behaviour matrix](#4-behaviour-matrix)
- [5. Settings reference](#5-settings-reference)
- [6. What the request actually contains](#6-what-the-request-actually-contains)
- [7. Implementation index](#7-implementation-index)
- [8. Data, privacy, and network](#8-data-privacy-and-network)
- [9. Run and build](#9-run-and-build)
- [10. Known limitations](#10-known-limitations)
- [11. License and credits](#11-license-and-credits)

---

## 1. What this is

A fully static DeepSeek chat front end: multiple conversations, streaming replies, deep thinking, web search, link reading, attachments, speech, Markdown / KaTeX / Mermaid, Chinese and English UI, light and dark themes, and history import/export. Every original feature is preserved.

> Current version: **2.6.4**

On top of that, this fork turns the hard-coded limits of the original into configurable settings and adds a full set of jailbreak, experiment and context-management features:

- **Unrestricted mode and prompts**: unrestricted mode, the default rules document / GODMODE preset, silent per-round system-prompt injection, and the experimental Chinese translation;
- **Custom chain of thought**: write reasoning steps in advance and inject them into system, with an injected-steps card above replies when deep thinking is off; experimental guidance when it is on;
- **Advanced engines**: a 0–4 thinking slider, input perturbation (33 techniques, single technique or tiered variants), AutoTune, STM output shaping, and one-click auto jailbreak that retries with another combo on refusal;
- **Jailbreak lab**: local MCP + EasyJailbreak attackers, model races, variant races (budget cap + start confirmation), and result import/export;
- **Chat features**: editable replies, anti-retraction, branch to a new chat (the original is untouched), and long-chat compression (pressure-triggered auto plus manual);
- **Models and cost**: a model card in the input bar (built-in Flash / V4 Pro plus cloud fetch), a context ring, session statistics, per-model billing, and daily token / cost alerts;
- **Memory**: long-term memory (manual / auto-extracted) and a memory graph (nodes, edges, vector dimension, retrieval weights, search debug) injected into requests;
- **Data and attachments**: configurable size / count / extension limits, history import/export, and one-click restore-default-settings.

- **Unrestricted mode** — swap the system prompt, automatically skip the safety check, and allow continuing refused replies.
- **Direct model parameters** — temperature, Top P, and max output tokens.
- **Anti-retraction** — when the model retracts a reply, keep the text and thinking that were already streamed.
- **Editable replies** — rewrite the body or the chain of thought of any AI reply; every later turn uses the edited version.
- **Custom system prompt** — rewrite the `system` field directly in Settings, overriding the assembled result;
- **Jailbreak lab** — run EasyJailbreak attackers through a local MCP backend (PAIR, TAP, GPTFuzzer, ReNeLLM, ICA, DeepInception, Jailbroken, Cipher, CodeChameleon, Multilingual) and inspect the final prompt, target response and judge result for every instance.

Every switch only affects **requests sent from this browser and conversations stored locally**. Nothing changes the behaviour of the API service itself.

---

## 2. Restrictions in the original

These are the limit-related behaviours in the upstream code. Paths point at the upstream implementation; in this fork those files have been modified (see section 3).

### 2.1 Request side

| #   | Restriction                              | Where in the original                              | Behaviour                                                                                                                             |
| --- | ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hard-coded system prompt                 | `SYSTEM_PROMPT` in `src/services/chat/store.ts`    | Every request's `system` field is one identity sentence: `该助手为DeepSeek，由深度求索公司创造。`. No behavioural instructions at all |
| 2   | Base safety filtering always on          | `SAFETY_CHECK` in `src/services/chat/store.ts`     | Every request carries `safety_check: { level: 'high' }`; the comment states it is "always on"                                         |
| 3   | Model and sampling parameters hard-coded | `src/services/chat/store.ts`                       | Model pinned to `deepseek-flash`; `temperature`, `top_p`, and `max_tokens` are never sent and the server defaults apply               |
| 4   | Fixed tool declarations                  | `serverTools` in `src/services/chat/store.ts`      | `deepseek_read_url` is always declared; `deepseek_web_search` follows the smart-search toggle                                         |
| 5   | Streamed content discarded on refusal    | `settleReply` in `src/services/chat/reply.ts`      | When a stream ends with `stop_reason: 'refusal'`, all received `thinking` / `text` blocks are **deleted**; only tool blocks survive   |
| 6   | Refused turns excluded from context      | `isUsableReply` in `src/services/chat/reply.ts`    | Rounds with `stopReason === 'refusal'` are never sent back to the model                                                               |
| 7   | Refused replies cannot be continued      | `canContinueReply` in `src/services/chat/reply.ts` | Returns `false` for refusal, so the "Continue" button never appears                                                                   |
| 8   | Refused replies show a canned answer     | `src/services/chat/describe.ts`                    | Refusals render a fixed sentence: `你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。`                                            |
| 9   | Refused replies cannot be edited         | The original has no reply editing                  | Only the user prompt can be edited (which creates a new branch and regenerates)                                                       |

### 2.2 UI and technical boundaries (not safety policy, listed for completeness)

| #   | Item              | Where                                          | Notes                                                                                                              |
| --- | ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 10  | AI content notice | Under the composer                             | A fixed line, "AI-generated, for reference only". Display only, it blocks nothing (kept unchanged in this fork)    |
| 11  | Attachment limits | `src/services/attachments.ts`, `uploadExts.ts` | 64 MB per file, 50 files per conversation, extension allow-list (no heic/heif)                                     |
| 12  | No backend        | By design                                      | The browser talks straight to the configured API origin (default `https://api.deepseek.com`); no server-side relay |

> To be clear: **the hard limits live on the server**. The lowest `safety_check` value is `low` (the docs state that omitting the field equals `low`) and there is no "off"; the model's own alignment is also not something a front end can change. This fork simply opens up everything the **client** can control.

---

## 3. What this fork changes

### 3.1 Settings layout

The settings dialog grows from two groups to thirteen:

| Group           | Contents                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| General         | Theme, language, TTS voice, location, daily usage and alerts                                                                                     |
| **Model**       | Current model, stream output, temperature, Top P, max output tokens, anti-retraction, auto-compress, skip safety check, continue refused replies |
| **Prompt**      | Unrestricted mode, per-round prompt injection, custom system prompt, pipeline explanation, full preview                                          |
| **Chain of thought** | Settings + composer card: switch, step editor, example / clear, injection preview; injected steps appear above replies when deep thinking is off |
| **Advanced**    | System prompt preset, Chinese jailbreak prompts, input perturbation, auto jailbreak, AutoTune, output shaping                                    |
| **Search poison** | Custom current time and knowledge cutoff, search takeover, keyword / regex replacement, blacklist, forced results and whitelist              |
| **Memory**      | Long-term memory, auto-extraction, memory graph, import/export, relation graph, vector dimension, retrieval weights, search debug                |
| **Attachments** | Limit switch, max size per file, max files per session, extension whitelist                                                                      |
| **Attachment poison** | Rewrite attachments before upload: text body / image text / DOCX / metadata / file trailer / filename / companion text attachment          |
| **Statistics**  | Usage overview with range switch, daily trend bars, 8-week activity heatmap, input composition ring, per-model split, context statistics management |
| Data            | API key, import, export, restore default settings, delete all                                                                                    |
| About           | Repository, demo and upstream links                                                                                                              |
| Changelog       | Version history and upstream credits                                                                                                             |

No existing style rules were modified. New controls only use newly added classes (the switch, slider, and editor each ship their own CSS Module; a few prompt-preview classes are appended to the settings stylesheet), and colours and radii come from the existing design tokens.

### 3.2 Unrestricted mode

**Where:** Settings → Prompt.

**How it works:** the system prompt becomes an assembly pipeline:

```text
Persona block (official identity sentence)
      │
      ▼  [unrestricted mode]
      ├─ on : append the unrestricted rules block, force-skip the safety check, allow continuing refused replies
      └─ off: send the Persona only, i.e. the official default prompt
      │
      ▼
request body `system` field
```

- The unrestricted rules come from [`deepseekv4.1 and v4.1-1017.md`](<./deepseekv4.1 and v4.1-1017.md>) in the repository root. At build time rspack inlines it verbatim with `asset/source`, so the built app does not depend on the file.
- Two normalisations run during assembly: the leftover sample-answer scaffold at the end of the document is trimmed, and `{{PAYLOAD}}` is replaced with "the request in the latest user message".
- The settings page can expand and preview **the exact system prompt that will be sent**.
- Turning it on forces two things: the `safety_check` field is not sent, and refused replies can be continued (the two switches below show as on and disabled).
- **Custom system prompt** (the input box in the same group): left empty, the pipeline above still applies; once filled, its content is sent verbatim as `system` and the assembled result no longer applies. Unrestricted mode then still skips the safety check and allows continuing refused replies, but no longer swaps the prompt. "Fill with default" seeds the box with the current assembled prompt as a starting point; "Reset to default" clears the override.

### 3.3 Model parameters

**Where:** Settings → Model.

| Parameter         | Control               | Range / step      | Default | Sent as                                  |
| ----------------- | --------------------- | ----------------- | ------- | ---------------------------------------- |
| Temperature       | Slider + number input | 0–2, step 0.05    | 1       | `temperature`                            |
| Top P             | Slider + number input | 0.01–1, step 0.01 | 1       | `top_p`                                  |
| Max output tokens | Number input          | ≥ 1, may be empty | empty   | Empty means `max_tokens` is **not sent** |

- Slider and number input stay in sync; the input commits on blur or Enter, clamps out-of-range values, and rounds to the step.
- Everything is persisted in localStorage and restored on reload.
- All of them are sent with every request except max output tokens, which is omitted while empty.

### 3.4 Anti-retraction

**Where:** Settings → Model.

The original deletes streamed text and thinking when a reply ends with `stop_reason: 'refusal'`. With anti-retraction on, that content is kept instead:

| Behaviour                | Off (original behaviour)              | On                                                                                                     |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Streamed body / thinking | Deleted                               | Kept and rendered normally                                                                             |
| UI notice                | Canned refusal answer                 | One notice line: "This reply was flagged by safety review; anti-retraction kept the streamed content." |
| Following context        | Turn excluded                         | **Included** once the body was kept                                                                    |
| Edit button              | Unavailable                           | Available (the reply is treated as a normal one)                                                       |
| History export           | Marked `CONTENT_FILTER` plus template | Exported as a normal finish, so re-importing does not wipe it again                                    |

Anti-retraction is independent of unrestricted mode; turning on unrestricted does not enable it.

### 3.5 Skip safety check

**Where:** Settings → Model.

- Off (default): requests carry `safety_check: { level: 'high' }` as before.
- On: the request body **no longer contains `safety_check`** (`undefined` is dropped by `JSON.stringify`).
- Unrestricted mode forces it on and disables the switch.

Per the official docs, omitting `safety_check` is identical to `low`, which is the lowest level the API offers.

### 3.6 Continue refused replies

**Where:** Settings → Model.

- Off (default): `canContinueReply()` returns `false` for `stopReason === 'refusal'` and the Continue button stays hidden (original behaviour).
- On: a refused reply is treated like a normal finish, so the last refused reply gets a Continue button.
- Unrestricted mode forces it on and disables the switch.

All other continuation rules are unchanged: template notices, server tool blocks, and non-prefix messages still block continuation.

### 3.7 Editable replies

**Where:** the action row under every AI reply — copy / read aloud / **edit (pencil)** / regenerate.

- The pencil expands an inline editor: **chain of thought** on top (only when the reply has one) and **body** below. `Ctrl/Cmd + Enter` saves, `Esc` cancels.
- Saving writes the content **back into the message blocks** — no new branch, no new request. Every later turn that assembles context reads the edited version.
- Write-back rules: thinking goes into the first thinking block (a new one is prepended if none exists) and the others are cleared; the body only touches the trailing answer run's first text block, the remaining text blocks are cleared, and citations are dropped when the body changes. Tool blocks, template notices, and thinking signatures are left untouched.
- The first edit stores a snapshot of the original blocks; **Revert to original** in the editor restores it.
- Continuing a reply changes the block structure, so the snapshot no longer matches and revert disappears after a continuation.
- Replies that were refused _and_ had their content dropped cannot be edited (there is no model text left); with anti-retraction on, the kept content can be edited.

### 3.8 Engineering changes

| Change                                           | Where                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Inline `.md` as raw source in the bundle         | `rspack.config.ts` (`{ test: /\.md$/, type: 'asset/source' }`)                 |
| `*.md` module typing                             | `src/env.d.ts`                                                                 |
| Prompt assembly pipeline                         | `src/services/chat/systemPrompt.ts` (new)                                      |
| Switch component                                 | `src/components/base/Switch.tsx` + `Switch.module.css` (new)                   |
| Slider + number control                          | `src/components/settings/ParamControls.tsx` + `ParamControls.module.css` (new) |
| Reply editor                                     | `src/components/messages/ReplyEditor.tsx` + `ReplyEditor.module.css` (new)     |
| Translations                                     | `src/i18n/zh.ts`, `src/i18n/en.ts`                                             |
| Perturbation / AutoTune / shaping / race engines | `src/services/unrestricted/` (ported from G0DM0D3, AGPL-3.0)                   |

> `deepseekv4.1 and v4.1-1017.md` is a build dependency. Commit it together with the code, otherwise a fresh clone will fail to build.

### 3.9 Jailbreak lab (optional, requires the local MCP backend)

The sidebar now has a **Lab** entry: it connects to the local `mcp-server/` over MCP and brings the EasyJailbreak attackers into the UI.

- Backend: `mcp-server/` (Python, MCP Streamable HTTP, default `http://127.0.0.1:8765/mcp`); start it with `./mcp-server/run.sh`;
- Frontend: `src/services/lab/` (MCP client) and `src/components/lab/` (lab page) only handle scheduling and display;
- Custom queries, dataset size, method-parameter JSON, and three model channels (target / attack / eval, reusing the API key from Settings by default); the model dropdown offers **DeepSeek Flash / V4 Pro**, defaults to the chat model, and is shared by all three channels;
- On mobile the parameter panel and results stack into one scrolling column, two-column fields collapse, and result summaries wrap;
- Shows the final prompt, target response, judge result and ASR per instance; supports cancelling and exporting;
- Available: PAIR, TAP, GPTFuzzer, ReNeLLM, ICA, DeepInception, Jailbroken, Cipher, CodeChameleon, Multilingual (all smoke-tested with the local mock model; the real behaviour of TAP and GPTFuzzer depends on the judge model returning parseable scores). MJP is not adapted yet; GCG / AutoDAN need a local white-box model and do not work with an API-only setup. See [`mcp-server/README.md`](mcp-server/README.md);
- Datasets: after `pip install datasets`, AdvBench (520 rows) / HarmBench / StrongREJECT can be loaded online through the `hf-mirror.com` mirror by default (override with `HF_ENDPOINT`); without the package the built-in sample queries are used;
- Results can be exported to JSON and imported back for later review; a successful entry has a "Send to chat" button that starts a new chat draft with the final prompt (any `{query}` placeholder is replaced with a hint you can edit before sending).
- Three steps: `pip install datasets` (optional) → `./mcp-server/run.sh` → `pnpm dev`, then connect from the sidebar Lab entry and run. If connecting returns 403, see the troubleshooting section in [`mcp-server/README.md`](mcp-server/README.md) (browser Origin allow-list: dev server, `null` for `file://`, and the deployed domains; extend it with `MCP_ALLOWED_ORIGINS`).

### 3.10 Advanced features: prompt presets, perturbation, AutoTune, output shaping, model race

The input bar is responsive: on desktop a single compact row shows the labels (model, auto jailbreak, thinking, search, perturbation) with a thin divider between the model and the toggles; below 768px everything except the model picker collapses to circular icons with horizontal scrolling, instead of hiding desktop labels based on width measurement.

Settings → **Advanced** (everything is off by default, so the out-of-the-box behaviour is unchanged):

| Setting               | What it does                                           | Caveat                                                                                                                                 |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| System prompt preset  | Switches between the default v4.1 document and GODMODE | GODMODE replaces the whole `system` field instead of appending the rules chunk; a custom prompt still overrides it                     |
| Input perturbation    | Rewrites matched trigger words before sending          | The input box shows the rewritten text, i.e. exactly what is sent; resends and continuations reuse it                                  |
| Technique / intensity | 8 techniques, 3 intensities                            | Leetspeak, homoglyphs, mixed case and phonetic only affect Latin letters; full-width, thin spacing and zero-width work for Chinese too |
| AutoTune              | Picks sampling parameters from the prompt context      | DeepSeek's Anthropic-compatible API only accepts `temperature` and `top_p`; `top_k` and friends are never sent                         |
| Output shaping        | Hedge reduction / direct / casual                      | Affects rendered chat and copied race results only; the stored reply is untouched                                                      |

- The trigger table is bilingual (60+ English, 90+ Chinese); Chinese triggers match by substring and English ones by word boundary — see `src/services/unrestricted/parseltongue.ts`;
- The input toolbar gains a **Perturb** button that opens a panel with the on/off switch, technique, matched-trigger count and a live preview;
- The lab's attackers tab gains **Perturb test queries first**, which rewrites custom test queries before they are submitted;
- The lab gains a **Model race** tab: 5 L1B3RT4S prompt combos run in parallel (optionally alternating `deepseek-v4-pro` / `deepseek-flash`), stream into cards, get a 0–100 composite score (length, structure, anti-refusal, directness, relevance) and a winner badge, and each card can **start a chat with this combo** (the combo's system prompt is attached to that chat only (global settings stay untouched) and the question goes into the input box);
- Engine code lives in `src/services/unrestricted/`, ported from [G0DM0D3](https://github.com/elder-plinius/G0DM0D3), with AGPL-3.0 headers and a license copy (`COPYING-AGPL-3.0`).

### 3.11 Thinking effort, context usage, session statistics and cost estimate

- **Stream output**: a new switch in Settings → Model, on by default; turn it off to hide the intermediate state and render the complete reply at once. Anti-retraction still applies to the final content.
- **Thinking effort**: the old on/off switch in the input bar becomes a 0–4 slider (Off / Light / Standard / Deep / Max). The level is sent as `thinking: { type: "enabled", budget_tokens }` plus `reasoning_effort` (low / medium / high / max). If the server answers 400 mentioning reasoning / thinking / budget / effort, the client drops the effort fields, retries once with plain `thinking: { type: "enabled" }` and tells you it fell back.
- **Context usage**: the ring in the input corner converts the last request's context (`input + cache_read + cache_creation`) into a share of the model window (1M); amber past 60%, red past 85%. The tooltip shows the exact numbers, the compaction threshold (80% of the window after a 64k headroom and the output reserve) and, after compression, the effective usage and tokens saved.
- **Session statistics** (the stats button next to the ring): rounds, steps (replies + tool calls), output speed, average first token, model time, cache hit rate, plus uncached input / cache read / cache write / output tokens; a live section shows the current run while it streams.
- **Auto jailbreak** (toggle in the input bar): swaps `system` to GODMODE plus the depth directive, forces perturbation (full-width when no technique is chosen), forces AutoTune and skips the safety check. When a reply is refused (`stop_reason: refusal` or refusal text) with no retained text, it retries with L1B3RT4S combos twice, then stops and tells you (each retry is a real request and costs tokens).
- **Reply ratings**: thumbs up / down on any reply feed the AutoTune EMA profile together with that run's context type and sampling parameters, so later AutoTune runs learn from your feedback (stored locally only).
- **Per-chat system prompt**: `Start a chat with this combo` now affects only the new chat, with a notice bar to restore the default; global prompt settings are untouched. It is stored with the chat in IndexedDB; history exports do not include it.
- **Cost estimate**: priced from the official price page (yuan per million tokens) with separate rates for `deepseek-flash` and `deepseek-v4-pro` (each reply is priced by its own model; unknown models fall back to Flash), split into peak and off-peak (Beijing time weekdays 09:00–12:00 and 14:00–18:00 are peak; off-peak costs half), with a "treat today as a holiday" override. Search and fetch are billed at 5 yuan / 1000 calls, document parsing at 1.5 yuan / 1000 pages (pages estimated from file size), TTS at 3 yuan / 10k characters (optional limited-time 50% off) and ASR at 0.78 yuan / hour.

### 3.12 Attachment limits

Settings → **Attachments**:

| Item                      | Default                        | Notes                                                                           |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Enforce attachment limits | on                             | Turn off to skip size, count and extension checks; the server still decides     |
| Max size per file         | 64 MB                          | Plain text, code and spreadsheet files still use the smaller 32 MB server limit |
| Max files per session     | 50                             | Exceeding it rejects the whole batch                                            |
| Extension whitelist       | built-in list (no heic / heif) | Comma or newline separated; empty restores the default                          |

---

### 3.13 Variant race (third lab tab)

> Model race and variant race call the API directly and **need no MCP backend**; only the attackers tab uses MCP.

The standalone app's Parseltongue v4 now lives in the lab: **33 perturbation techniques**, selected by tier (light 11 / standard 22 / heavy 33), rewrite each trigger word in the question, fire requests in parallel batches and keep the best composite score.

| Item              | Notes                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tiers             | 11 / 22 / 33 techniques, in the same order as upstream                                                                                                                               |
| Sampling          | Each variant cycles through one of 11 temperature / top_p pairs, matching `getParseltongueSamplingParams`                                                                            |
| Concurrency       | Batches of 6 with 100 ms stagger; stops early once the leader scores ≥ 65                                                                                                            |
| Budget cap        | The per-request worst case estimates how many requests fit; no new request is fired after reaching the budget, and billing uses server-reported usage                                |
| Confirmation      | The first start asks for confirmation with request count and worst-case cost; "Do not ask again" hides it permanently                                                                |
| Refusal detection | Either `stop_reason: refusal` or refusal text marks a variant as refused; refused variants never win                                                                                 |
| Import / export   | "Export results" saves JSON including the system prompt actually used; "Import results" replays a previous race; the `type` field keeps files from other pages out                   |
| Continue in chat  | Any finished result can be carried into a new chat: the obfuscated text becomes the question and the reply the answer; the system prompt is attached to that chat, never to Settings |

Chinese support: `spaced / zwj / dotted / underscored / reversed / brackets / strikethrough / hyphenated` work on Chinese triggers; `bubble / unicode / morse / pigLatin / mathBold` only touch Latin letters, and `fullwidth` only shifts ASCII. Chinese triggers match by substring rather than `\b`.

---

### 3.14 Prompt injection, Chinese translation and long-chat compression

| Feature                                  | Where                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inject the system prompt every round     | Settings → Prompt                               | Silently appends the current system prompt to `latest_reminder` on every request so long chats keep the setup; it is not stored in history snapshots, and input tokens clearly increase.                                                                                                                                                                                                                                     |
| Chinese jailbreak prompts (experimental) | Settings → Advanced                             | Replaces the built-in GODMODE and depth directive with Chinese translations. Phrasing and training-data differences may weaken the jailbreak, so it is off by default. L1B3RT4S combos stay in English.                                                                                                                                                                                                                      |
| Disguise historical thinking             | Settings → Prompt                               | Folds the **previous** reply’s thinking into the historical assistant text so the server does not drop it; only the last historical round is converted and token usage rises slightly.                                                                                                                                                                                                                                       |
| Long-chat compression                    | Settings → Model (auto) + stats dialog (manual) | Auto: once context pressure reaches 80% of the window (after the 64k headroom and output reserve) with at least 2 new rounds since the last compression, older content is summarised in the background. Manual: "Compress older messages" in the stats dialog, always keeping the last 2 rounds verbatim. The summary is injected as a `latest_reminder`; local history is untouched and the summary can be cleared anytime. |

---

### 3.15 Branch to a new chat

Use the session menu (⋯ → **Branch to new chat**) or the button in the desktop session header to copy the current visible branch into a **brand-new chat**:

- The new session id and every message id are regenerated; the original chat is untouched;
- The current system prompt (lab combo) and compression summary are inherited;
- The new title carries a " (branch)" suffix, and both lines evolve independently;
- Branching is disabled while generating, importing, or before the session loads.

This is different from the in-session branch switcher (which keeps alternative answer versions inside one chat): here you get a separate line in the session list.

---

### 3.16 Model switching and per-model billing

The leftmost control in the input toolbar is the model card, with **DeepSeek Flash** and **DeepSeek V4 Pro** built in:

- Open it to see each model's cache-hit / input / output price per 1M tokens (off-peak; peak ×2);
- "Fetch from cloud" calls `GET /models`, then the Anthropic prefix `/anthropic/v1/models`; fetched models are cached for an hour and their ids are passed through to requests;
- A switch affects only new replies: old replies keep their own model, continuations keep the original model, and statistics/cost are computed per reply;
- The context ring uses the current model's window; models without a price entry fall back to Flash rates and a 128k window;
- On mobile the model picker stays expanded with the current model name and dropdown arrow; only the other input controls collapse to circles;
- Settings → Model shows the current model; restoring defaults resets it to DeepSeek Flash.

Prices (yuan per million tokens, off-peak; peak ×2):

| Model             | Cache hit | Input (miss) | Output |
| ----------------- | --------- | ------------ | ------ |
| `deepseek-flash`  | 0.02      | 1            | 4      |
| `deepseek-v4-pro` | 0.15      | 4.5          | 13.5   |

The billing section in the stats dialog gains a "By model" breakdown with reply counts and cost per model.

### 3.17 Long-term memory and daily usage

**Long-term memory** (Settings → Memory):

- Add / edit / enable / delete / clear entries manually; enabled entries are injected into every request's `system`;
- With **auto-extract** on, one extra Flash call after each turn turns stable facts, identity and long-term preferences into JSON operations (small extra cost, off by default);
- Memories stay on this device and are not part of history exports; enabled entries also sync into the memory graph as `saved` nodes.

**Daily usage and alerts** (Settings → General):

- Tracks today's `input + cache_read + cache_creation + output` tokens and cost at each model's peak/off-peak rates;
- Optional daily token and cost limits; crossing one shows a toast once per day and never blocks requests;
- The stats dialog shows today's tokens and cost, with a reset button.

### 3.18 Memory graph (ported from Operit)

Settings → Memory → **Memory graph**:

- Nodes carry a title, content, tags, importance and credibility; a new node is auto-linked to up to 3 similar nodes by local hashed-vector cosine similarity;
- Retrieval combines keyword, tag, vector and weighted edge expansion; all four weights, the relevance threshold and the number of results are configurable;
- Vector dimension can be 64 / 128 / 256 / 384 / 768 (default 256), generated locally without an embedding service;
- **Search debug** shows each candidate's keyword / tag / vector / edge score, total, pass flag, plus node/edge counts, match counts and edges traversed;
- At request time the top N matches are injected into `system` together with long-term memory; no matches means no injection;
- Import/export a JSON archive of long-term memories plus graph nodes/edges; import can merge (content-deduplicated) or replace;
- The relation graph draws nodes and weighted edges; click a node to inspect its content and tags; on mobile it keeps a readable size and scrolls horizontally;
- Shows the current vector dimension, node count, average degree and estimated Float32 footprint; search debug adds dimension, query-token count and top score;
- Chat statistics and the input context ring show memory nodes/edges/dimension/last injected hits; restoring defaults resets retrieval settings and daily alerts but keeps saved memory data;
- On mobile the weights become single-column, the search-debug table scrolls horizontally, and nodes/tags wrap.

### 3.19 Locations: clear, custom and off-world

Settings → General → Location:

- When a location is set, a **Clear location** button removes it;
- A free-form input next to the selects accepts any place (for example “Paris” or “Zhongshan Station, Antarctica”); press Enter or leave the field to apply;
- A custom location takes precedence over administrative and special choices and is written directly into `latest_reminder`;
- Special locations: Space Station (Satellite / Station), Moon (Near Side / Far Side) and Mars (Spacetime Management Center);
- Special locations override the administrative selection; custom and special locations only affect `latest_reminder`, not weather, web search or server-side region detection.

### 3.20 Search poisoning

Settings → Search poisoning. This group exposes every search input the client can control:

| Capability | Behaviour |
| --- | --- |
| Current time | A `datetime-local` value injected as the model’s date and weekday; empty uses the real time |
| Knowledge cutoff | Declares the model database / training-data cutoff; empty means no declaration |
| Search takeover | With custom results, `deepseek_web_search` is not declared and the model only sees the filtered local results; turn it off to keep real search |
| Replacement | Keyword or regex replacement by URL / title / snippet / all fields; regex supports `$1` groups |
| Blacklist | Matching results are removed from the UI, exports and model context; forces takeover |
| Forced results | Custom results are injected and shown as search results regardless of real search hits |
| Whitelist | Only custom results matching the whitelist are returned; all server results are withheld |

- The engine lives in [`src/services/searchPoison.ts`](src/services/searchPoison.ts): replacement, blacklist and whitelist run before injection; at most 50 rules and 20 custom results;
- Custom results go into `system`, so long snippets increase input tokens; each snippet is capped at 4000 characters;
- Takeover mode: `tools` only keeps `deepseek_read_url`, `system` gains a `[LOCAL SEARCH LAYER]` block, and a “poisoned search” step is added to the reply timeline; the bottom web summary opens it;
- Non-takeover mode: real server search stays; result blocks are replaced / filtered as they reach the client and citation markers follow, but results already consumed by the server cannot be retracted;
- The custom time goes into the `latest_reminder` date, weekday and location; the knowledge cutoff and search results go into `system`; UI time, billing, weather and geolocation stay unchanged;
- Compatible with anti-retraction and stream output: only request context and result display change; refusal handling is untouched, and with streaming off the poisoned step appears once at completion;
- Everything is stored under `chat-demo:search-poison` and reset by Restore default settings; takeover means no real web search, so turn it off (or clear blacklist / whitelist) when real search is needed.

### 3.21 Attachment poisoning

Settings → Attachment poisoning. Off by default; when enabled, attachments are rewritten locally before upload so the model sees your text when it reads them.

| Method | File types | Behaviour |
| --- | --- | --- |
| Text body injection | TXT / MD / CSV / code / HTML / JSON | Inserts text with an `[ATTACHMENT NOTE]` marker before or after the body |
| DOCX body injection | `.docx` | Unzips the file and appends a paragraph to the end of `word/document.xml` |
| Image text overlay | PNG / JPG / WebP / GIF and other raster images | Draws a text panel at the top or bottom for vision / OCR |
| Image metadata (experimental) | JPEG / PNG | Writes a JPEG COM or PNG tEXt comment; some extractors read it |
| File trailer (experimental) | PDF / unknown binary | Appends text at the end; ZIP-based Office files are skipped |
| Filename injection | Any format | Puts the first 40 characters into the upload filename; works when the model can see it |
| Companion text attachment | PDF / Office / any format | Adds a separate `.txt` to the message; most reliable, but uses one attachment slot |

- Methods can be combined; only those that fit the file type are applied, and failures fall back to the original file without blocking the upload;
- Content is capped at 4000 characters and wrapped in an `[ATTACHMENT NOTE]` marker; text, DOCX and the image panel go before or after the body;
- The original file stays in IndexedDB and the processed copy is uploaded; re-uploading can apply a new configuration;
- After a settings change, the next send re-uploads attachments in the input box that still have a local original; attachments already sent are not rewritten, and imported files without a local original stay as-is;
- Enabling / disabling or toggling the companion attachment immediately re-uploads the originals in the input box; companion text attachments sync when enabled / disabled, and should be re-selected after content changes;
- Restoring defaults disables and clears the config and removes automatically generated companion attachments from drafts;
- Image text overlay re-encodes the image: GIF / animations become static and GIF / BMP may become PNG; prefer the companion text attachment for PDF / Office.

### 3.22 Custom chain of thought

**Where:** Settings → **Chain of thought**. Off by default. When enabled, the reasoning steps you write are injected as a separate system block on every request, so the model follows your order instead of a vague “think step by step”.

| Deep thinking | Injected block | Behaviour | Stability |
| --- | --- | --- | --- |
| Off (level 0) | `[CUSTOM CHAIN OF THOUGHT]` | The model reasons internally through the steps; an “Injected chain of thought” card appears above the reply, followed by the final answer | Standard |
| On (levels 1-4) | `[CUSTOM CHAIN OF THOUGHT · EXPERIMENTAL]` | Guidance for server-side reasoning; the server may ignore, adjust or rewrite the steps | Experimental |

- The composer is now two rows: model / auto jailbreak / perturbation on the first, chain of thought / web search / deep thinking on the second; mobile keeps a single horizontal row.
- The composer **Chain** button is a card, sharing the same config as the settings page: toggle, edit, insert an example, clear, or open the full settings for the system preview.
- **With deep thinking off, an “Injected chain of thought” card is rendered above the reply** (expanded by default, collapsible). It shows the exact steps written into system for that turn instead of showing only the final answer; it is user-defined input, not server-side thinking.
- With deep thinking on, the card is not repeated; server-side thinking is shown as usual, and the custom chain remains experimental guidance.
- Each reply stores a snapshot of the injected chain: continue reuses it, regenerate reads the current settings, so changing settings mid-conversation cannot make one turn inconsistent.
- The block sits after the Persona / unrestricted rules and before long-term memory and search context. The first request also asks for a title, and still gets the block; otherwise the first reply in a new chat would not use it.
- The text is capped at 4000 characters and stored locally in `chat-demo:custom-cot` and `chat-demo:custom-cot-enabled`; every request increases input tokens.
- Turning the switch off keeps the text for later; restoring defaults clears it and disables the feature.
- Only `system` changes. Streaming / non-streaming, continue, regenerate, title generation, attachments, search poisoning and history import/export stay compatible.

### 3.23 Statistics, charts and context management

**Where:** Settings → **Statistics**, plus the stats dialog in the composer toolbar.

- **Usage ledger** (`usageLedger`): every finished request is written into a day / model bucket with uncached input, cache read, cache write, output, estimated cost, request count and web searches. The ledger keeps the last 400 days in localStorage, never stores message text, and is separate from the today-only daily usage that drives the quota reminders.
- **Range switch**: today / 7 days / 30 days; missing days are filled with zeros so the chart always has a continuous axis.
- **KPI band**: total tokens, estimated cost, cache hit rate, requests, days with usage, web searches.
- **Daily trend bars**: switchable metric — tokens (with cost as the second bar), cost, or request count — one bar pair per day, with a hover tooltip carrying the exact numbers.
- **Activity heatmap**: the last 8 weeks, one cell per day, four intensity steps relative to the busiest day in the window.
- **Hourly distribution**: all 24 hours of the range on one axis, so you can see when you actually chat; the note names the busiest hour.
- **Input composition ring**: uncached input / cached input / cache write / output, each with tokens and share, so it is obvious which part drives the bill.
- **Per-model split**: requests, tokens and cost for each model seen in the range; unknown ids fall back to Flash prices.
- **Session ranking**: the busiest sessions in the range by tokens, with cost and request count; **Open** jumps straight into that session (disabled once the session is gone).
- **Auxiliary usage**: web searches, parsed document pages, TTS characters and ASR seconds — the parts of the bill that token counts do not cover.
- **Context statistics management**: the current session's context against the model window and the compaction threshold, then a table of tracked sessions with context size, window share and last request time. Clear a single record, clear all records, export the ledger as JSON or CSV, or wipe the ledger entirely.
- **Ledger v2**: per-day records now also carry an hourly histogram and a per-session breakdown. Older v1 ledgers are read with the missing fields defaulted, so upgrading never needs a migration script; corrupt JSON is treated as an empty ledger instead of crashing the page.

**The composer stats dialog** now also carries the per-session output trend (sparkline plus latest / average / longest), the last-7-days app-wide trend for comparison, the input composition ring, an auxiliary card (searches, fetches, parsed files and pages, TTS characters, ASR seconds), and a pressure gauge with remaining window and compaction threshold; its footer jumps straight into Settings → Statistics.

**API key masking:** the jailbreak lab no longer renders the full key. It shows `sk-****` plus the last four characters, and a “Change in Settings” link that opens Settings → Data, matching how the data section itself masks the saved key.

### 3.24 OpenCode Bridge provider (optional)

Settings → **Data** → **Inference provider** adds a second, opt-in transport:

- `DeepSeek API` (default) keeps the existing browser-direct behaviour described above.
- `OpenCode Bridge` forwards Anthropic Messages through the local [OpenCode Bridge](https://github.com/dawangnailong/opencode-bridge) browser extension (Chrome or Safari) to `https://opencode.ai/inference` (Console pay-as-you-go) or `https://opencode.ai/inference/go` (Go subscription), as selected inside the extension. This is needed because the OpenCode inference endpoints send no CORS headers and answer the OPTIONS preflight with 404, so a page cannot call them directly.

Setup:

1. Install the extension and open its options page to save your `oc_sk_...` key there. The key never reaches this page.
   - Chrome: load it unpacked (`chrome://extensions` → Developer mode → Load unpacked).
   - Safari 16.4+: convert it with `xcrun safari-web-extension-converter`, run the generated app once with a signing team, then enable the extension under Safari → Settings → Extensions.
2. Add this page's exact origin (for example `http://localhost:8090`) to the extension's **Allowed origins**, choose Console or Go, and set the User-Agent override to `chat4code-unrestricted/1.0`.
3. Paste the extension ID into Settings → Data → OpenCode Bridge and press **Test connection**.
   - Chrome uses the 32-character ID from `chrome://extensions`.
   - Safari uses the extension's **bundle identifier** (for example `com.example.OpenCodeBridge.Extension`) shown on its options page.
4. Serve this app over `http://localhost:...` or another `http(s)` origin; `file://` is rejected by the extension.
5. Safari also requires per-site access: Safari → Settings → Extensions → OpenCode Bridge → **Website Access** → allow this site (or all sites), then reload the page. Chrome connects directly; Safari pages automatically fall back to the extension's content-script relay over `window.postMessage`. The connection test reports which path was negotiated.

Safari has no offscreen document, so requests run inside the MV3 service worker and are subject to its fetch limits (roughly 25 seconds to first byte and 5 minutes per request). Chrome is not affected; very long Safari replies may be interrupted.

Bridge mode sends standard Anthropic Messages only: DeepSeek-specific fields (`safety_check`, `latest_reminder`, `deepseek_*` server tools, `title`, `reasoning_effort`) are stripped, the model id `deepseek-flash` is mapped to `deepseek-v4.1-flash`, and a stable `x-opencode-session` is derived from each chat.

Image attachments are inlined as Anthropic base64 blocks in bridge mode (requires extension v0.2.0+): each request inlines only the most recent few images (configurable in Settings → OpenCode Bridge, default 4, with an overall ~24 MB image budget); older images become placeholder text in the request. Local originals are always kept in full in IndexedDB and exported with backups. Document attachments remain unsupported in bridge mode. Speech, server-side web search and the lab are disabled in this mode.

---

## 4. Behaviour matrix


| Scenario                    | Original                    | This fork, defaults (all switches off)                                               | Unrestricted mode on                                      |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `system` field              | Official identity sentence  | Same                                                                                 | Persona + unrestricted rules block                        |
| `safety_check`              | Always `high`               | `high`                                                                               | Not sent                                                  |
| Custom system prompt        | None                        | Empty = assembled; filled = sent verbatim                                            | Filled text wins; unrestricted no longer swaps the prompt |
| Streamed content on refusal | Discarded                   | Discarded (kept when anti-retraction is on)                                          | Same as default                                           |
| Refused turn in context     | No                          | No (yes when anti-retraction kept the body)                                          | Same as default                                           |
| Continue on refused reply   | Blocked                     | Blocked (switch can enable)                                                          | Allowed                                                   |
| Edit refused reply          | No editing at all           | Editable when content was kept                                                       | Same                                                      |
| Sampling parameters         | Not sent                    | Adjustable                                                                           | Adjustable                                                |
| Export of refused reply     | `CONTENT_FILTER` + template | Same (normal finish when content was kept)                                           | Same as default                                           |
| Other original features     | —                           | Search, attachments, branches, import/export, read-aloud, themes, i18n all preserved | Same                                                      |
| Web search                  | Server-side                 | Kept by default; search poisoning can take over or rewrite the display                | Same as default                                           |
| Custom chain of thought     | Not available               | Off by default; injected into system; the “Injected chain of thought” card shows above replies when deep thinking is off | Same as default                                           |

---

## 5. Settings reference

| Group       | Setting                              | Default           | localStorage key                           | Unrestricted mode               |
| ----------- | ------------------------------------ | ----------------- | ------------------------------------------ | ------------------------------- |
| Model       | Temperature                          | `1`               | `chat-demo:temperature`                    | Unaffected                      |
| Model       | Top P                                | `1`               | `chat-demo:top-p`                          | Unaffected                      |
| Model       | Max output tokens                    | empty (not sent)  | `chat-demo:max-tokens`                     | Unaffected                      |
| Model       | Anti-retraction                      | off               | `chat-demo:keep-reply-content`             | Unaffected (independent switch) |
| Model       | Skip safety check                    | off               | `chat-demo:skip-safety-check`              | Forced on, disabled             |
| Model       | Continue refused replies             | off               | `chat-demo:continue-refused`               | Forced on, disabled             |
| Prompt      | Unrestricted mode                    | off               | `chat-demo:unrestricted`                   | —                               |
| Prompt      | Custom system prompt                 | empty (assembled) | `chat-demo:system-prompt`                  | Overrides the assembled result  |
| Chain of thought | Enable custom chain of thought  | off               | `chat-demo:custom-cot-enabled`             | Unaffected                      |
| Chain of thought | Chain text                      | empty             | `chat-demo:custom-cot`                     | Unaffected                      |
| Advanced    | System prompt preset                 | `deepseek`        | `chat-demo:prompt-preset`                  | Unaffected                      |
| Advanced    | Input perturbation                   | off               | `chat-demo:parseltongue`                   | Unaffected                      |
| Advanced    | Perturbation technique               | `leetspeak`       | `chat-demo:parseltongue-technique`         | Unaffected                      |
| Advanced    | Perturbation intensity               | `medium`          | `chat-demo:parseltongue-intensity`         | Unaffected                      |
| Advanced    | AutoTune                             | off               | `chat-demo:autotune`                       | Unaffected                      |
| Advanced    | AutoTune strategy                    | `adaptive`        | `chat-demo:autotune-strategy`              | Unaffected                      |
| Advanced    | Output shaping                       | empty (off)       | `chat-demo:stm-modules`                    | Unaffected                      |
| Attachments | Enforce attachment limits            | on                | `chat-demo:attachment-limits`              | Unaffected                      |
| Attachments | Max size per file                    | 64 MB             | `chat-demo:attachment-max-mb`              | Unaffected                      |
| Attachments | Max files per session                | 50                | `chat-demo:attachment-max-count`           | Unaffected                      |
| Attachments | Extension whitelist                  | built-in          | `chat-demo:attachment-exts`                | Unaffected                      |
| Input bar   | Model                                | `deepseek-flash`  | `chat-demo:model`                          | Next reply                      |
| Input bar   | Thinking effort                      | 0 (off)           | `chat-demo:reasoning-effort`               | Unaffected                      |
| Input bar   | Auto jailbreak                       | off               | `chat-demo:auto-jailbreak`                 | Unaffected                      |
| Lab         | Variant race budget                  | 1 yuan            | `chat-demo:variant-race-budget`            | Unaffected                      |
| Lab         | Variant race confirm dismissed       | off               | `chat-demo:variant-race-confirm-dismissed` | Unaffected                      |
| Prompt      | Inject the system prompt every round | off               | `chat-demo:inject-prompt-every-turn`       | Unaffected                      |
| Prompt      | Disguise historical thinking         | off               | `chat-demo:thinking-as-body`               | Unaffected                      |
| Model       | Stream output                        | on                | `chat-demo:stream-output`                  | Unaffected                      |
| Model       | Auto-compress long chats             | off               | `chat-demo:auto-compress`                  | Unaffected                      |
| Search poison | Enable search poisoning            | off               | `chat-demo:search-poison`                  | Unaffected                      |
| Attachment poison | Enable attachment poisoning    | off               | `chat-demo:attachment-poison`              | Unaffected                      |
| Advanced    | Chinese jailbreak prompts            | off               | `chat-demo:translate-jailbreak-zh`         | Unaffected                      |
| General     | Daily limit alerts                   | off               | `chat-demo:daily-limit-enabled`            | Unaffected                      |
| General     | Daily token limit                    | 1000000           | `chat-demo:daily-token-limit`              | Unaffected                      |
| General     | Daily cost limit (yuan)              | 10                | `chat-demo:daily-cost-limit`               | Unaffected                      |
| Memory      | Long-term memory                     | on                | `chat-demo:saved-memory-enabled`           | Unaffected                      |
| Memory      | Auto-extract memory                  | off               | `chat-demo:auto-extract-memory`            | Unaffected                      |
| Memory      | Memory-graph retrieval               | on                | `chat-demo:memory-bank-enabled`            | Unaffected                      |
| Memory      | Results to inject                    | 4                 | `chat-demo:memory-bank-limit`              | Unaffected                      |
| Memory      | Vector dimension                     | 256               | `chat-demo:memory-bank-dimension`          | Unaffected                      |

Your individual switch values apply again once unrestricted mode is turned off.

---

## 6. What the request actually contains

A normal request (all switches at defaults):

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。",
  "messages": [
    { "role": "latest_reminder", "content": "2026-11-14,Saturday,Beijing,Web,中文" },
    { "role": "user", "content": "Hello" }
  ],
  "thinking": { "type": "disabled" },
  "temperature": 1,
  "top_p": 1,
  "safety_check": { "level": "high" },
  "tools": [{ "type": "deepseek_read_url", "name": "deepseek_read_url" }],
  "title": { "enabled": true },
  "stream": true
}
```

(`title` appears only while the conversation has no title yet, `thinking` follows the DeepThink toggle, and `max_tokens` appears only when set.)

With custom chain of thought enabled, `system` gains a `[CUSTOM CHAIN OF THOUGHT]` block between the Persona / unrestricted rules and the memory / search context; with deep thinking on it becomes `[CUSTOM CHAIN OF THOUGHT · EXPERIMENTAL]`. The first request also carries `title`, and still gets the block; every other field and the message structure stay unchanged. With deep thinking off, the client additionally renders an “Injected chain of thought” card above the reply; the card is not part of the request and is not written into `blocks`.

With search poisoning enabled and takeover active, `tools` only keeps `deepseek_read_url`, `system` gains a `[LOCAL SEARCH LAYER]` block, and `latest_reminder` uses the custom date and location; with takeover off or no custom results the real-search request above is unchanged.

Attachment poisoning changes only the uploaded file bytes sent to the Files API, not the request shape; attachments are still referenced by `file_id`.

Unrestricted mode with adjusted parameters (only fields that differ are shown):

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。\n\n[MODE: SANDBOX]\n\nYou are a sandbox task executor …",
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 2048,
  "tools": [{ "type": "deepseek_read_url", "name": "deepseek_read_url" }],
  "stream": true
}
```

Only three things differ: `system` is the assembled pipeline, the whole `safety_check` field disappears, and the sampling parameters appear. `tools`, `thinking`, `latest_reminder`, and `title` are not affected by these switches.

---

## 7. Implementation index

| File                                                                                               | Purpose                                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`src/services/chat/systemPrompt.ts`](src/services/chat/systemPrompt.ts)                           | System prompt pipeline: Persona + unrestricted rules block, with custom override                                     |
| [`src/services/chat/customCot.ts`](src/services/chat/customCot.ts)                                 | Custom chain normalization, injection snapshot and system-block generation (direct / experimental wording)           |
| [`src/components/chatInput/CustomCotPanel.tsx`](src/components/chatInput/CustomCotPanel.tsx)       | Composer Chain card: toggle, edit, example / clear, open settings                                                    |
| [`src/components/messages/InjectedCot.tsx`](src/components/messages/InjectedCot.tsx)               | Collapsible “Injected chain of thought” card above replies                                                          |
| [`src/services/chat/usageLedger.ts`](src/services/chat/usageLedger.ts)                             | Day / model usage ledger (400 days) behind the statistics charts                                                    |
| [`src/components/settings/StatsSettings.tsx`](src/components/settings/StatsSettings.tsx)           | Settings → Statistics: KPI, trend bars, heatmap, composition ring, context management                                |
| [`src/components/stats/charts.tsx`](src/components/stats/charts.tsx)                               | Hand-rolled SVG/CSS charts: bars, heatmap, ring, sparkline, pressure gauge                                            |
| [`src/services/api/mask.ts`](src/services/api/mask.ts)                                             | API key masking (`sk-****` + last four) shared by the lab and other read-only displays                                |
| [`src/services/chat/store.ts`](src/services/chat/store.ts)                                         | Request assembly (system / parameters / safety_check / tools), custom chain injection, refusal settling, continuation guard |
| [`src/components/chatInput/ChatInput.tsx`](src/components/chatInput/ChatInput.tsx)                 | Composer Chain shortcut, active state and settings entry                                                             |
| [`src/services/chat/reply.ts`](src/services/chat/reply.ts)                                         | `settleReply` (keep refused content), `hasReplyContent`, `rewriteReplyBlocks` (write edits back), `canContinueReply` |
| [`src/services/chat/describe.ts`](src/services/chat/describe.ts)                                   | Refusal notices: a hint line when content was kept, the template otherwise                                           |
| [`src/services/chat/history/toArchive.ts`](src/services/chat/history/toArchive.ts)                 | Export status and template handling for refused replies                                                              |
| [`src/services/settings.ts`](src/services/settings.ts)                                             | New settings, defaults, and persistence                                                                              |
| [`src/services/searchPoison.ts`](src/services/searchPoison.ts)                                     | Search-poison engine: replacement / blacklist / whitelist, context injection, result and citation rewriting          |
| [`src/services/attachmentPoison.ts`](src/services/attachmentPoison.ts)                             | Attachment-poison engine: text / DOCX / image text / metadata / trailer / filename / companion attachment            |
| [`src/components/settings/AttachmentPoisonSettings.tsx`](src/components/settings/AttachmentPoisonSettings.tsx) | Attachment-poison settings UI and method descriptions                                                              |
| [`src/components/settings/SearchPoisonSettings.tsx`](src/components/settings/SearchPoisonSettings.tsx) | Search-poison settings UI: time, takeover, rules and result editing                                                  |
| [`src/services/location.ts`](src/services/location.ts)                                             | Location normalization and custom places                                                                             |
| [`src/services/api/types.ts`](src/services/api/types.ts)                                           | Request types: `temperature` / `top_p` / `max_tokens` / optional `safety_check`                                      |
| [`src/components/settings/SettingsDialog.tsx`](src/components/settings/SettingsDialog.tsx)         | Settings page: Model / Prompt / Chain of thought groups, switches and preview                                        |
| [`src/components/settings/ParamControls.tsx`](src/components/settings/ParamControls.tsx)           | Slider + number input control                                                                                        |
| [`src/services/chat/sessionStats.ts`](src/services/chat/sessionStats.ts)                           | Session aggregates, timings and cost estimate                                                                        |
| [`src/services/chat/contextUsage.ts`](src/services/chat/contextUsage.ts)                           | Context usage cached per session                                                                                     |
| [`src/components/chatInput/ThinkingSlider.tsx`](src/components/chatInput/ThinkingSlider.tsx)       | Thinking effort 0–4 track                                                                                            |
| [`src/components/session/StatsDialog.tsx`](src/components/session/StatsDialog.tsx)                 | Statistics and billing dialog                                                                                        |
| [`src/services/chat/compression.ts`](src/services/chat/compression.ts)                             | Long-chat compression: structured summary, auto trigger and savings                                                  |
| [`src/services/chat/savedMemory.ts`](src/services/chat/savedMemory.ts)                             | Long-term memory: CRUD, auto-extraction, system injection                                                            |
| [`src/services/chat/memoryBank.ts`](src/services/chat/memoryBank.ts)                               | Memory graph: nodes / edges / hashed vectors / weighted search / debug                                               |
| [`src/services/chat/memoryArchive.ts`](src/services/chat/memoryArchive.ts)                         | Memory archive JSON import/export: merge or replace                                                                  |
| [`src/services/chat/dailyUsage.ts`](src/services/chat/dailyUsage.ts)                               | Daily token and cost tracking with limit alerts                                                                      |
| [`src/components/settings/MemorySettings.tsx`](src/components/settings/MemorySettings.tsx)         | Memory settings and search debug                                                                                     |
| [`src/services/chat/contextPressure.ts`](src/services/chat/contextPressure.ts)                     | Context pressure and compaction reserve (matching DSH)                                                               |
| [`src/services/chat/feedbackStore.ts`](src/services/chat/feedbackStore.ts)                         | Reply ratings and the AutoTune EMA profile                                                                           |
| [`src/services/api/models.ts`](src/services/api/models.ts)                                         | Built-in models, cloud `/models` fetch and cache                                                                     |
| [`src/components/chatInput/ModelPicker.tsx`](src/components/chatInput/ModelPicker.tsx)             | Model picker card                                                                                                    |
| [`src/components/chatInput/ContextRing.tsx`](src/components/chatInput/ContextRing.tsx)             | Context ring linked with compression                                                                                 |
| [`src/components/chatInput/ParseltonguePanel.tsx`](src/components/chatInput/ParseltonguePanel.tsx) | Input perturbation panel                                                                                             |
| [`src/services/unrestricted/promptsZh.ts`](src/services/unrestricted/promptsZh.ts)                 | Chinese translation of GODMODE and the depth directive                                                               |
| [`src/services/unrestricted/techniques.ts`](src/services/unrestricted/techniques.ts)               | 33 perturbation techniques (ported from the standalone build)                                                        |
| [`src/services/unrestricted/refusal.ts`](src/services/unrestricted/refusal.ts)                     | 44 refusal patterns                                                                                                  |
| [`src/services/lab/variantRace.ts`](src/services/lab/variantRace.ts)                               | Variant race: budget, batches, scoring                                                                               |
| [`src/components/lab/VariantView.tsx`](src/components/lab/VariantView.tsx)                         | Variant race UI and start confirmation                                                                               |
| [`src/components/base/Switch.tsx`](src/components/base/Switch.tsx)                                 | Switch component                                                                                                     |
| [`src/components/messages/ReplyEditor.tsx`](src/components/messages/ReplyEditor.tsx)               | Reply editor (thinking / body)                                                                                       |
| [`src/components/messages/AssistantMessage.tsx`](src/components/messages/AssistantMessage.tsx)     | Edit entry point, Continue button, injected-chain card and refusal rendering branch                                  |
| [`deepseekv4.1 and v4.1-1017.md`](<./deepseekv4.1 and v4.1-1017.md>)                               | Unrestricted rules text, inlined at build time                                                                       |
| [`mcp-server/`](mcp-server/README.md)                                                              | Local EasyJailbreak MCP backend                                                                                      |
| [`src/components/lab/`](src/components/lab/LabView.tsx)                                            | Jailbreak lab page                                                                                                   |
| [`src/services/lab/`](src/services/lab/mcpClient.ts)                                               | MCP client and lab state                                                                                             |

---

## 8. Data, privacy, and network

- API key and settings: browser localStorage (keys listed in section 5).
- Search-poison settings (time, replacement / filter rules, custom results) live only in localStorage; when enabled they are sent as system context to the API origin you configured.
- Attachment-poison settings live only in localStorage; original attachments stay on this device, the processed copies are uploaded, and companion text attachments are sent as ordinary files.
- Conversations and original attachments: IndexedDB, isolated per browser profile and site origin.
- The only outbound traffic goes to the API origin you configured (default `https://api.deepseek.com`): `/models` for key validation, `/anthropic/v1/messages` for chat, `/anthropic/v1/files` for attachments, and the ASR / TTS endpoints for speech.
- No analytics, no telemetry, no third-party scripts, no relay server.
- History import/export uses ZIP archives; exports contain conversations and locally available image originals, but no API keys or settings. See the [history archive documentation](src/services/chat/history/README.md) for the format and retention rules.

---

## 9. Run and build

**On Windows**, double-click the two scripts in the repository root:

- `启动chat-web前端.bat`: detects Node.js / pnpm / `node_modules` and installs whatever is missing (winget / corepack / npm), then starts the dev server on http://localhost:8090;
- `启动mcp后端越狱实验台.bat`: detects Python / `.venv` / MCP deps / fastchat / torch / datasets / EasyJailbreak; EasyJailbreak is installed via pip first and falls back to GitHub or mirror clones, then starts the MCP backend on http://127.0.0.1:8765/mcp.

Manual setup (any OS), requires Node.js 22.12+ and pnpm:

```sh
git clone https://github.com/dawangnailong/chat4code-unrestricted.git
cd chat4code-unrestricted
pnpm install
pnpm dev        # http://localhost:8090
```

Build the static site:

```sh
pnpm build      # output in dist/
```

`dist/` can be deployed to any static host, or opened locally by double-clicking `dist/index.html` (the browser must allow storage on `file://` pages and cross-origin requests to your API origin). Enter your API key under Settings → Data before the first chat.

| Command       | Purpose                      |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the dev server on 8090 |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | TypeScript type check        |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

The API origin is set in [`rspack.config.ts`](rspack.config.ts) via `createConfig({ apiOrigin })`; it defaults to `https://api.deepseek.com`.

### 9.1 Android APK

A native WebView shell is included; the built artifact is `android/deepseek-unrestricted-2.6.4.apk`:

- The app starts a local static server on `http://127.0.0.1:18765` and loads `assets/public`, giving localStorage / IndexedDB / fetch a stable secure origin;
- File selection, microphone permission, the back key and external links are wired up;
- Building requires Android SDK 34, build-tools 34.0.0 and JDK 17 (JDK 27 crashes d8). A one-click script at the repo root reads the `package.json` version (currently 2.6.4 / 264), builds the web app and the signed APK:
  ```sh
  KS_PASS=... ./构建APK.sh
  ```
  The manual path still works:
  ```sh
  export ANDROID_HOME=$HOME/android-sdk
  export JAVA_HOME=/path/to/jdk-17
  pnpm build
  KS_PASS=... KEY_PASS=... ./android/build-apk.sh
  ```
- The APK is signed with `xiaohuangbo.jks`, alias `xiaohuangbo`, versionCode 264;
- **The Python backend is not executed inside the APK**: `android/assets/backend` bundles the `mcp-server` and EasyJailbreak sources for reference only; the lab still needs a backend on a PC or server, with its endpoint set to `http://<PC-IP>:8765/mcp`. The phone page origin is `http://127.0.0.1:18765`, which the backend already allows.

---

## 10. Known limitations

1. **There is no "off" for `safety_check`**: omitting it equals `low`, which is the lowest level the API offers; the server still runs its default check.
2. **Server-side alignment remains**: a model-initiated refusal (`stop_reason: 'refusal'`) cannot be cancelled by the client. Anti-retraction only keeps what was already streamed; it cannot make the model continue refused content.
3. **Historical chain-of-thought is never sent back**: by protocol, the server drops history thinking and the client does not resend it. Editing the thinking therefore affects the UI and the continuation prefix, while only the body applies to ordinary later turns.
4. **Sampling parameters are constrained in thinking mode**: the server fixes temperature at 1, and Top P below 0.95 is treated as 0.95.
5. **`max_tokens` includes thinking tokens**: setting it too low can truncate the thinking as well.
6. **Edits only affect the local context**: they do not re-request the model and do not change what the server already produced. Exports store the edited content; the original snapshot is not exported.
7. **Attachment limits, key validation, and speech endpoints** still follow the original logic and are independent of the switches described here.
8. **The lab is not a purely static capability**: it needs the local Python + MCP backend (`mcp-server/`), and a single job can issue a large number of model calls. Start with `limit=1` and small iteration counts.
9. **A custom prompt overrides the assembly**: once filled, unrestricted mode no longer swaps `system` (it still skips the safety check and allows continuing refused replies). Clear the box to go back to the default pipeline.
10. **Long-chat compression is lossy**: summaries drop detail, and auto-compression triggers at 80% of the window (about 800k tokens on a 1M window), so manual compression is the practical option. Per-chat system prompts and compression summaries live only in local sessions and are not included in history exports.
11. **Branch to new chat copies the current visible branch**: other answer versions and drafts are not copied; attachments reuse the original file ids; the new chat starts its statistics at zero and inherited usage is not counted.
12. **Restore default settings keeps the API key**: it only resets preferences and switches, never chats, attachments or statistics.
13. **Auto jailbreak and variant races cost extra**: every retry and every variant is a real request; variant races are bounded by the budget cap.
14. **Cloud model lists depend on the API and network**: a failed fetch falls back to the two built-ins; models without a price entry are estimated at Flash rates with a 128k window, and actual capabilities come from the server.
15. **Switching models does not rewrite old replies**: old replies keep their model and cost; continuations keep that reply's model, and only new replies use the current choice.
16. **Auto-extraction costs an extra call**: one Flash request per turn; long-term memory and the memory graph stay on this device and are not exported.
17. **The memory graph uses local hashed vectors**, not semantic embeddings: retrieval is approximate but needs no external service; changing the dimension recomputes vectors.
18. **Daily usage only counts chat replies**: MCP lab, races and title generation are not included; costs are estimated from current peak/off-peak rates and may differ slightly from the bill.
19. **Custom and special locations only affect `latest_reminder`**: they do not change weather, web search or server-side regional behaviour.
20. **Disguised thinking only covers the previous round**: it is sent as ordinary text, so the server no longer treats it as thinking; token usage rises slightly.
21. **The relation graph draws at most 80 nodes**: extra nodes are still searched, just not drawn; importing in Replace mode overwrites current long-term memories and graph data, so export a backup first.
22. **The stream-output switch only controls rendering**: when off, replies are still received over SSE and accumulated, just not shown mid-flight; accumulated content is written back when the page is hidden or closed to avoid loss.
23. **Search poisoning is not a server-side proxy**: server search runs on the server and the client only sees what the model already consumed; with takeover off it can rewrite display only, not retract this turn’s results.
24. **Takeover depends on custom results**: with no custom results it does not disable server search (unless a blacklist / whitelist is present); with takeover on the model only sees the configured results and real search does not run.
25. **Custom time / knowledge cutoff are hints**: they only affect `latest_reminder` and the injected context, not the UI, billing, weather or server region detection, and the model may not fully obey the cutoff.
26. **Attachment poisoning only affects new / re-uploaded attachments**: server files for messages already sent are not rewritten; attachments in the input box with a local original are re-uploaded on the next send with the current config, while imported files without an original stay as-is and sent history is never rewritten.
27. **Client-side rewriting is best-effort**: image text overlay needs Canvas, while PDF trailers and image metadata are experimental and not guaranteed to be read; prefer the companion text attachment for PDF / Office.
28. **Companion text attachments use an attachment slot**: none are generated when the limit is full; restoring defaults only clears the local config and generated companions in drafts, not server or historical attachments.
29. **Image text overlay re-encodes the image**: GIF / animations become static and GIF / BMP may become PNG; the file trailer skips ZIP-based Office files.
30. **The Python backend does not run inside the APK**: EasyJailbreak / torch cannot be packed into a normal WebView APK; the bundled backend sources are for reference and the lab must connect to an MCP service on a PC or server.
31. **The APK is a WebView shell**: browser capabilities such as file downloads depend on the system WebView; the local server occupies port 18765 and shows a startup error if the port is taken.
32. **Custom chain of thought is prompt guidance, not a real reasoning channel**: with deep thinking off, the card above the reply shows the steps you wrote, not live model reasoning; the model may not follow every step; each request increases input tokens and the text is capped at 4000 characters.
33. **With deep thinking on the custom chain is experimental**: server-side thinking takes priority and may ignore or rewrite the steps, so results are not guaranteed to match direct injection; the injected card is not repeated and server-side thinking is shown instead.
34. **Custom chain of thought only applies to chat requests**: race, variant race, long-chat compression and memory extraction use their own system prompts and ignore it; the first chat request that also generates a title still receives it.
35. **The “Injected chain of thought” card is local display data**: history export does not include it, so an imported archive does not show the card; continue reuses the reply’s snapshot and regenerate reads the current settings.

---

## Star History

<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/star-history/star-history-light.svg" />
  <img alt="Star History Chart" src="assets/star-history/star-history-light.svg" />
</picture>
<!-- star-history:end -->

---

## 11. License and credits

- Code based on [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo), under the [MIT](LICENSE) license. The build copies the license to `dist/LICENSE`; keep it when redistributing.
- `brand.jpg` is artwork provided by the repository author and remains theirs; "Yes, Sun Xiaochuan Chat" is an inside joke and is not affiliated with DeepSeek.
- This is a personal fork, not an official DeepSeek project. Check the terms and costs of whichever API service you point it at.
- Thanks to the [EasyJailbreak project](https://github.com/EasyJailbreak/EasyJailbreak) for the theoretical foundation.
- Thanks to [DeepSeek-Agent](https://github.com/Aoan2011/DeepSeek-Agent) for the reference implementation of the thinking slider, context ring and session statistics.
- Thanks to [dsh-unrestricted](https://github.com/yexi-by/dsh-unrestricted) for the reference jailbreak prompts and experiment settings.
- Thanks to [L1B3RT4S](https://github.com/elder-plinius/L1B3RT4S), the upstream source for GODMODE, the Hall of Fame combos and jailbreak prompts.
- Thanks to [Operit](https://github.com/AAswordman/Operit) for the memory graph, vector dimensions, retrieval weights and search-debug reference.
- Thanks to [DeepChat](https://github.com/YanJiuWeiYuanHui/DeepChat) for the long-term memory and daily token / cost alert reference.
- The engines under `src/services/unrestricted/` (input perturbation, AutoTune, STM, race scoring, GODMODE prompt) are ported from [G0DM0D3](https://github.com/elder-plinius/G0DM0D3) and licensed [AGPL-3.0](src/services/unrestricted/COPYING-AGPL-3.0); that directory keeps its own license, separate from the MIT-licensed rest of the repo.
