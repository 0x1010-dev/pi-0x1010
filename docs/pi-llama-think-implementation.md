# pi-llama-think — implementation document

Status: **implemented — as a separate `llama-think` provider (v0.6.0), not an override.**
Written 2026-07 from a live investigation of pi 1.6.0 source and the iceland
llama-server; implemented and validated against the live server.

> **The original design (override the `llama.cpp` provider) is architecturally
> impossible.** pi's `resource-loader.loadExtensionPaths` loads *user* extensions first
> and *built-in* extensions second; both call `registerNativeProvider`, so last write
> wins and the built-in always overwrites an extension's registration of the same id.
> Only built-ins flagged `replaceable` (codemode, tool-search, mcp) can be dropped via
> the tool/command/flag name-collision mechanism — `llama.cpp` is not. Verified live:
> `getRegisteredNativeProvider('llama.cpp')` returned the built-in and the extension's
> `refreshModels` never ran. The shipped design therefore registers a distinct
> `llama-think` provider (live discovery + real thinking levels); models appear as
> `llama-think/<id>` alongside the built-in's `llama.cpp/<id>`, and auth is a separate
> `/login llama-think` (an extension's `AuthContext` only exposes `env()`/`fileExists()`,
> so it cannot read the `llama.cpp` credential).

## Implementation notes (delta from the original design)

- **Separate `llama-think` provider id** (see above). The full pi-ai `Provider` object
  (auth, `refreshModels`, `stream`) is otherwise a faithful port of the built-in with the
  thinking wiring enhanced.
- **Classifier models are intentionally NOT re-provided (accepted regression).** The
  built-in's llama.cpp classifier models (`llama-cpp-classify` / `typesafe-system-one`)
  cannot be replicated from an installed extension: their APIs are only importable via the
  wildcard subpath `@earendil-works/pi-ai/api/*.lazy`, which **does not resolve** for a
  git/npm-installed extension (only pi's own bundled code can import it). Verified: root
  `@earendil-works/pi-ai` and the explicit `./compat` export resolve; the `./api/*`
  wildcard does not (static *and* dynamic import), and `import.meta.resolve` is unavailable
  in the extension loader. Consequence: codemode `models.classify()` can no longer select a
  llama.cpp model. Chat, thinking levels, streaming, and auth are unaffected. (The
  `import type`-only pi-context-bar extension never hit this — type imports are erased at
  runtime, so it needs no `@earendil-works/*` runtime resolution.)
- **`omitWhenOff: true` on the `reasoning_effort` kwarg.** The original sketch sent
  `reasoning_effort: { $var: "thinking.effort" }` unconditionally. But when the level is
  `off`, pi sets `reasoningEffort = undefined`, so the kwarg resolves to
  `thinkingLevelMap.off` = `"off"` — which the template **rejects** (`"off"` is not in the
  guard tuple → `raise_exception`). Live-verified: `reasoning_effort: "high"` (and `"off"`)
  500s, while `enable_thinking: false` with no `reasoning_effort` succeeds. `omitWhenOff`
  drops the key entirely when off, so off sends only `{ enable_thinking: false,
  preserve_thinking: true }`.
- **`$var: "thinking.effort"` is not special-cased at runtime.** pi-ai's
  `resolveChatTemplateKwargValue` only treats `thinking.enabled` and `thinking.budget`
  specially; any other object (incl. `thinking.effort`) falls through to the generic
  `thinkingLevelMap[level]` lookup. It works, and the pi-ai type accepts it — but the
  mechanism is the fallthrough, not a dedicated var.
- **`preserve_thinking: true`** kept (static) to match the built-in's
  `qwen-chat-template` multi-turn behavior.
- **Testing:** pure parsing lives in `parse.ts` (unit-tested in `parse.test.ts`); the rest
  is a faithful port of the untyped built-in. `stream` needs a single boundary cast
  (`as Provider["stream"]`) because pi-ai's compat `stream` is typed against
  `ProviderStreamOptions` while the `Provider` interface declares `ApiStreamOptions<T>`.

## Goal

Pi extension (in this repo, `extensions/pi-llama-think/`) that gives pi's `/thinking`
selector the **real reasoning-effort levels a llama.cpp model's chat template supports**,
discovered live from the server — replacing the built-in provider's hardcoded
`off + medium` for llama.cpp models.

Target server: iceland llama-server (BeeLlama `ghcr.io/anbeeld/beellama.cpp:server-cuda13`,
router mode, `--models-preset`), port 55262. Must stay generic: any llama.cpp router whose
templates accept `reasoning_effort`.

## Why (verified facts, pi 1.6.0)

### How pi derives the /thinking option list

`dist/core/agent-session.js` → `getAvailableThinkingLevels()` →
`getSupportedThinkingLevels(model)` (defined in `dist/bundle/chunks/chunk-NRY4NBZW.js`):

```js
function getSupportedThinkingLevels(model) {
  return model.reasoning
    ? EXTENDED_THINKING_LEVELS.filter(level => {
        let mapped = model.thinkingLevelMap?.[level];
        return mapped === null ? false
          : level === "xhigh" || level === "max" ? mapped !== void 0
          : true;
      })
    : ["off"];
}
```

- Level universe: `off, minimal, low, medium, high, xhigh, max`.
- `reasoning: false` → only `off`.
- `thinkingLevelMap[level] === null` hides a level; `xhigh`/`max` only appear when
  explicitly mapped; other levels appear by default when `reasoning: true`.
- The mapped **string value** is what gets sent to the provider for that level.

### What the built-in llama.cpp provider does

`dist/extensions/llama/provider.js`, `toPiModel()`:

```js
const reasoning = props?.chat_template?.includes("enable_thinking") === true;
// when reasoning:
thinkingLevelMap: { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null }
compat.thinkingFormat: "qwen-chat-template"
```

- `props` comes from `GET /props?model=<id>` — **fetched only for loaded models**
  (unloaded → `reasoning: false` until a later refresh after load).
- `thinkingFormat: "qwen-chat-template"` (see
  `dist/bundle/chunks/openai-completions-4IC6AGTR.js`) sends only a boolean:
  `chat_template_kwargs = { enable_thinking: !!reasoningEffort, preserve_thinking: true }`.
  **No per-level effort is ever sent** — that's the gap.

### The `chat-template` thinkingFormat (what we need)

Same chunk: `thinkingFormat: "chat-template"` builds `chat_template_kwargs` from
`compat.chatTemplateKwargs`, resolving `$var` objects via `buildChatTemplateValues`:

- `{ "$var": "thinking.enabled" }` → `true` for any non-off level, `false` for off
- `{ "$var": "thinking.effort" }` → `thinkingLevelMap[level]` (the mapped string)
- `{ "$var": "thinking.budget" }` → thinking token budget

### Server facts (iceland, live-verified)

- `GET /v1/models` (router): entries with `id`, `status: { value: loaded|sleeping|unloaded,
  args: [...] }`, `source: "preset"`, `architecture.input_modalities`, `context_length`,
  and `meta` (e.g. `n_ctx`) **only when loaded**.
- `GET /props?model=<id>` (loaded only): returns `chat_template` (full Jinja) and
  `chat_template_caps`. On this build caps contains `supports_reasoning_effort: true`,
  `supports_preserve_reasoning: true`, … but **NO `reasoning_effort_levels` field**.
  (Extensions like pi-llama-cpp that key off `reasoning_effort_levels` get nothing here —
  which is why we parse the template itself.)
- Qwen3.8-27B template (both local models use it):
  ```jinja
  {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
  {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
      {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ ...) }}
  ```
  → accepts exactly **`xhigh`, `medium`, `low`**; default `xhigh`; any other value
  **raises** (request fails). `enable_thinking` undefined-or-true = thinking on;
  `preserve_thinking` honored.
- Per-request `chat_template_kwargs` **override** server-level
  `--chat-template-kwargs` (request wins). Server preset currently pins
  `reasoning_effort: "low"` as default.
- `reasoning-budget` was removed from both presets in
  `/opt/services/data/models/models.ini` (2026-07); takes effect on
  `docker restart llama-server`. No server-side token cap anymore — pi-side
  per-level budgets (native thinking budgets) are the only cap.

## Design

### Approach: override the `llama.cpp` provider dynamically

`pi.registerProvider("llama.cpp", config)` — documented as "Register **or override** a
model provider dynamically" (docs/extensions.md, `### pi.registerProvider(name, config)`).
The legacy object form supports `async refreshModels({ signal })` returning model entries
— the docs' own "Register a live llama.cpp catalog" example is this exact shape.
`models.json` overrides still apply above it.

Register from an **async factory** (`export default async function (pi) {...}`): factory
await completes before `session_start` / `resources_discover` / provider flush, so a
fetch-at-startup works; `refreshModels` covers later model load/unload.

### Server URL resolution (open question — resolve during implementation)

Built-in uses `/login llama.cpp` credential (`env.LLAMA_BASE_URL`) or `LLAMA_BASE_URL`.
User's `settings.json` also has `llamaSettings.servers: [{ url: "http://localhost:55262",
id: "iceland", ... }]` (consumed by the built-in). Resolution order to implement:
1. `LLAMA_BASE_URL` env (works today for the user — set via /login credential)
2. `llamaSettings.servers[0].url` if the extension API exposes settings (find the API;
   check `ctx` in a session_start handler)
3. fail → register nothing, built-in stays (log a warning)

Single server only. Multi-server: out of scope.

### refreshModels algorithm

1. `GET {server}/v1/models` → catalog.
2. Selectable = `status.value` in {`loaded`, `sleeping`} ∪ (`unloaded` presets when
   router autoload enabled — mirror built-in's `routerAutoloadEnabled` via
   `GET /props` → `models_autoload`). Keep it simple: loaded + sleeping first;
   autoload handling is a nice-to-have.
3. For each **loaded** chat model: `GET {server}/props?model={id}` → `chat_template`.
   Unloaded → `reasoning: false` (same limitation as built-in; fixed on next refresh
   after load).
4. Parse the template (pure string ops, no Jinja lib):
   - `hasThinking = /enable_thinking/.test(template)`
   - Effort tuple: find the `raise_exception` guard — regex
     `not in \(\s*([^)]+)\)` on the substring around `reasoning_effort`; extract all
     `'word'` tokens. Fallback if no tuple found: `reasoning_effort\|default\('(\w+)'\)`
     → single-effort list `[default]`.
   - `supportsEffort = /reasoning_effort/.test(template)`
5. Build the model entry:
   ```ts
   {
     id, name: id,
     api: "openai-completions",
     baseUrl: `${server}/v1`,
     reasoning: hasThinking,
     input: arch.input_modalities?.includes("image") ? ["text","image"] : ["text"],
     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
     contextWindow,   // meta.n_ctx > args --ctx-size/-c > n_ctx_train > 128000 (mirror built-in)
     maxTokens: contextWindow,
     ...(hasThinking && {
       thinkingLevelMap: buildLevelMap(efforts),
     }),
     compat: {
       supportsStore: false,
       supportsReasoningEffort: false,
       supportsUsageInStreaming: true,
       supportsStrictMode: false,
       maxTokensField: "max_tokens",
       ...(hasThinking && supportsEffort && {
         thinkingFormat: "chat-template",
         chatTemplateKwargs: {
           enable_thinking: { $var: "thinking.enabled" },
           reasoning_effort: { $var: "thinking.effort" },
         },
       }),
       ...(hasThinking && !supportsEffort && { thinkingFormat: "qwen-chat-template" }),
     },
   }
   ```
   `buildLevelMap(efforts)`: for each of `off, minimal, low, medium, high, xhigh, max`:
   `off` → `"off"` (always); others → the level name if `efforts.includes(level)`,
   else `null`. For the iceland templates this yields
   `{ off:"off", minimal:null, low:"low", medium:"medium", high:null, xhigh:"xhigh", max:null }`
   → selector shows **off, low, medium, xhigh**.
6. **Classifiers**: the built-in provider also registers classifier models
   (`llama-cpp-classify` / `typesafe-systemone`) used by codemode `models.classify()`.
   Overriding the provider may drop them. Check whether the legacy config's `models[]`
   accepts `type: "classifier"` entries (see `extensionModelFromDefinition` in
   `dist/core/provider-composer.js` — it does handle `type`); if not, register a full
   pi-ai `Provider` object (object form supports `getAllModels`). **Verify in
   implementation; do not silently regress classifiers.**

### Risks / open questions (resolve in this order during implementation)

1. **Does overriding `llama.cpp` break the `/llama` command** (load/unload/download UI)?
   The command lives in the built-in extension, separate from provider registration, but
   it displays the provider's model list. Test: `/llama` still lists + loads after
   override. Fallback if broken: register under a distinct id (e.g. `llama-think`) —
   models then appear twice in `/model`; user picks the `-think` ones. Ugly but safe.
2. **Classifier regression** (see step 6).
3. **Settings access** for `llamaSettings.servers` (see URL resolution).
4. `refreshModels` error behavior when server unreachable: return `[]` (provider shows
   no models) and log — don't throw out of refresh.

## Implementation sketch

`extensions/pi-llama-think/index.ts` (single file is fine; ~150 lines):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseEfforts(template: string): string[] {
  const m = template.match(/reasoning_effort[\s\S]{0,400}?not in \(\s*([^)]+)\)/);
  if (m) return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const d = template.match(/reasoning_effort\|default\('([^']+)'\)/);
  return d ? [d[1]] : [];
}

function buildLevelMap(efforts: string[]) {
  const map: Record<string, string | null> = {};
  for (const l of LEVELS) map[l] = l === "off" ? "off" : efforts.includes(l) ? l : null;
  return map;
}

export default function (pi: ExtensionAPI) {
  const server = process.env.LLAMA_BASE_URL;
  if (!server) return; // built-in provider stays
  pi.registerProvider("llama.cpp", {
    baseUrl: server,
    apiKey: "local",
    api: "openai-completions",
    async refreshModels({ signal }) {
      // 1. GET {server}/v1/models
      // 2. filter selectable
      // 3. for loaded: GET {server}/props?model={id} → chat_template
      // 4-6. parse + build entries (see Design)
      // return [] on fetch failure
    },
  });
}
```

Notes:
- Use `fetch` with the passed `signal` everywhere (docs: `context.signal` is concrete,
  pass it to blocking I/O).
- `apiKey: "local"` dummy — local server ignores it (same as built-in's fallback).
- No new npm dependencies.

## Test plan

1. `pi --list-models` → both models, thinking = yes.
2. `/thinking` on `qwen3.8-27b` → exactly **off, low, medium, xhigh** (no
   minimal/high/max).
3. Payload verification: select `xhigh`, confirm the server receives
   `chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh" }`.
   Quickest: a one-off netcat/curl proxy in front of 55262, or temporarily point the
   extension at a logging stub. Cross-check with direct curl:
   ```sh
   curl -s localhost:55262/v1/chat/completions -H 'content-type: application/json' \
     -d '{"model":"swift-1.5","messages":[{"role":"user","content":"hi"}],"max_tokens":16,
          "chat_template_kwargs":{"enable_thinking":true,"reasoning_effort":"high"}}'
   # "high" MUST fail (template raise_exception); "xhigh"/"medium"/"low" must succeed
   ```
4. `off` → `enable_thinking: false`, no thinking blocks in response.
5. Regression: `/llama` command still lists/loads models; codemode classifier listing
   still shows the llama models (if used).
6. Reload behavior: `/reload` re-runs refresh; a model loaded after startup gains
   levels on the next refresh (or pi restart).

## Server-side state (iceland)

- `/opt/services/data/models/models.ini`: `reasoning-budget` + `reasoning-budget-message`
  removed from both presets (2026-07). Preset keeps
  `chat-template-kwargs = {"reasoning_effort": "low"}` as server default.
  **Pending: `docker restart llama-server`** to apply — NOT while a pi session runs on
  that backend (it is the agent's LLM).
- Compose: `/opt/services/compose.yaml`, service `llama-server`, host port 55262.

## References

- pi source (1.6.0, `/usr/lib/node_modules/pi/packages/coding-agent/dist/`):
  - `core/agent-session.js` — `getAvailableThinkingLevels`, `supportsThinking`
  - `bundle/chunks/chunk-NRY4NBZW.js` — `getSupportedThinkingLevels`
  - `extensions/llama/provider.js` — built-in discovery (`toPiModel`, `refreshModels`)
  - `bundle/chunks/openai-completions-4IC6AGTR.js` — thinkingFormat handling,
    `buildChatTemplateValues` / `$var` resolution
  - `core/provider-composer.js` — `applyModelsJson`, `modelOverrides` merge,
    `extensionModelFromDefinition` (classifier `type` support)
  - docs: `docs/extensions.md` (§ pi.registerProvider, async factories),
    `docs/models.md` (thinking levels, models.json)
- Prior art:
  - `https://pi.dev/packages/pi-llama-reasoning` — model-reported efforts + slot pinning
    (npm public; GitHub repo private). Fallbacks to built-in off+medium when the server
    reports no levels — which is our server's case.
  - `https://github.com/soster/qwen38-thinking-levels` — config for the exact same model:
    per-request `chat_template_kwargs` (`enable_thinking`, `reasoning_effort`,
    `preserve_thinking`), levels xhigh/medium/low, no reload needed.
  - `https://github.com/earendil-works/pi/issues/9528` — "Built-in llama.cpp provider
    ignores reasoning level" (the motivating bug; Qwen3.8-27B, llama.cpp).
  - `https://pi.dev/packages/pi-llama-cpp` — keys off `chat_template_caps
    .reasoning_effort_levels`, absent on our build → would show levels the template
    rejects. Avoid.
