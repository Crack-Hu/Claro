# claro 🧹

**Speech-to-text, cleaned.** Claro takes voice-typed text — full of filler words, repetitions, and ASR errors — and turns it into clean, written prose using an LLM. It learns from your corrections, automatically fixing the same recognition mistakes next time.

> 简体中文说明 → [README.zh-CN.md](./README.zh-CN.md)

## Demo

You dictated this into your phone with voice input:

```
/claro umm I think like this approach could you know be optimized a bit more and also pi-agent performance might need another look
```

Claro cleans it up. The result appears in your editor:

```
I think this approach could be optimized further, and pi-agent's performance might need another look.
```

Notice `pi-agent` was automatically corrected — you fixed that once before and claro remembered.

You can edit the result further before pressing Enter. Claro silently compares your edits against its output and learns new speech recognition error patterns in the background.

## Usage

| Command | What it does |
|---------|-------------|
| `/claro <text>` | Clean oral text, place result in editor for review |
| `/claro --mode <name> <text>` | Use a specific processing mode (requires writing a mode module) |
| `/claro --stop` | Shutdown the local claro server |

After processing, the result appears in your editor. Edit and press Enter. The behavior depends on the mode:

| behavior | Description |
|----------|-------------|
| `review` | Text in editor. Your edits trigger automatic diff learning (default claro mode) |
| `passthrough` | Text in editor. Press Enter to send directly, no learning |

> **Currently only available as a [pi](https://pi.dev) extension.** The backend is agent-agnostic — thin frontends for other coding agents are welcome contributions.

## File Structure

```
Claro/
├── extensions/
│   ├── claro.ts                   # pi extension (thin UI bridge)
│   └── config.json                # Extension config (port, timeouts)
├── server/
│   ├── index.mjs                  # HTTP server framework (endpoints, queue, config)
│   ├── config.json                # Server config (LLM, API key, port, modes)
│   ├── lib/
│   │   └── dict.mjs               # Dictionary utilities (imported by modes as needed)
│   └── modes/
│       ├── noop/
│       │   └── index.mjs          # Pass-through mode (for testing)
│       └── claro/
│           ├── index.mjs          # Oral text cleaning mode
│           └── prompts/
│               ├── clean.md       # Cleaning prompt
│               └── diff.md        # Error-learning prompt
├── README.md
└── README.zh-CN.md
```

## Architecture

```
┌───────────┐           ┌──────────┐           ┌──────────┐           ┌──────────┐
│ extension │ ────────► │  server  │ ────────► │   mode   │ ────────► │   LLM    │
└───────────┘           └──────────┘           └──────────┘           └──────────┘
```

- **extension** — server lifecycle, HTTP transport, queue polling, UI bridging, arg parsing
- **server** — routing, queuing, config merge, prompt resolution
- **mode** — pluggable processing module, implements `process()` / `finalize()`, calls LLM via `ctx.callLLM()`

The frontend is intentionally thin — it only bridges pi's UI. All business logic lives on the server. Each mode is an independent ES module with two lifecycle functions:

- `process(input, ctx)` — process the text (required)
- `finalize(input, ctx)` — handle user's edits for learning (optional)

## Installation

```bash
pi install git:https://github.com/Crack-Hu/Claro
```

## Configuration

Claro has **two independent config files**.

### Server config (`server/config.json`)

LLM connection and mode definitions. Auto-created from `config.example.json` on first run.

```json
{
  "port": 3742,
  "verbose": false,
  "defaultMode": "claro",
  "llm": {
    "api_type": "openai-completions",
    "base_url": "https://api.deepseek.com",
    "api_key": "$CLARO_API_KEY",
    "model": "deepseek-v4-flash",
    "temperature": 0.3,
    "max_tokens": 4096,
    "reasoning_effort": "medium"
  },
  "modes": {
    "noop": { "enabled": true },
    "claro": {
      "enabled": true,
      "process_llm": {
        "thinking": { "type": "enabled" }
      },
      "finalize_llm": {
        "thinking": { "type": "enabled" }
      }
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `port` | Server listen port (default `3742`) |
| `verbose` | Log full LLM request/response to `llm-debug.log` |
| `defaultMode` | Mode used when no `--mode` is specified |
| `llm` | Global LLM config: `base_url`, `api_key` (supports `$ENV_VAR`), `model`, etc. |
| `modes.<name>.enabled` | Enable/disable a mode |
| `modes.<name>.process_llm` | LLM config override for process phase |
| `modes.<name>.finalize_llm` | LLM config override for finalize phase |

Config merge order: **global llm ← mode.process_llm ← mode.finalize_llm** (deep merge).

### Extension config (`extensions/config.json`)

Connection parameters only — **no API keys**.

```json
{
  "port": 3742,
  "request_timeout_ms": 60000,
  "health_check_timeout_ms": 2000,
  "server_ready_timeout_ms": 10000,
  "server_ready_poll_ms": 500,
  "queue_poll_ms": 1000,
  "queue_timeout_ms": 120000,
  "shutdown_timeout_ms": 5000
}
```

## How It Works

1. `/claro <text>` → extension sends text to local claro-server at `/process`
2. Server loads the mode module, calls `process()` → LLM cleans the text
3. Result placed in the pi editor (plain text, no command prefix)
4. You edit and press Enter → the `input` event detects the edit → calls `/finalize` silently
5. Server calls mode's `finalize()`, compares original vs modified, learns new errors
6. Learned mappings stored in `.pi/claro/claro-dict.json`, applied in future cleanings

## Writing a Custom Mode

Each mode lives in `server/modes/<name>/` as an ES module. Two exports to get started:

### Step 1: Create the mode directory

```bash
mkdir -p server/modes/translate/prompts
```

### Step 2: Write `index.mjs`

```js
// server/modes/translate/index.mjs

import { loadDictionary, saveDictionary } from "../../lib/dict.mjs";

export const meta = {
  name: "translate",
  description: "Translate text to English",
  behavior: "passthrough",   // "review" | "passthrough"
};

export async function process(input, ctx) {
  const prompt = await ctx.loadPrompt("translate.md");  // loads from modes/translate/prompts/
  const result = await ctx.callLLM([
    { role: "system", content: prompt },
    { role: "user", content: input.text },
  ]);
  return {
    content: result.content.trim(),
    tokens: result.tokens,
    model: result.model,
  };
}

// Optional: learn from user edits
export async function finalize(input, ctx) {
  // input.original — model output
  // input.modified — user's edited version
  // For dictionary access: const dict = await loadDictionary(ctx.projectRoot);
  return { final_text: input.modified };
}
```

### Step 3: (Optional) Add prompts

```
server/modes/translate/prompts/
└── translate.md
```

`ctx.loadPrompt(name)` checks `<mode>/prompts/` first, then falls back to `server/prompts/`.

### Step 4: Enable the mode

In `server/config.json`:

```json
"modes": {
  "translate": {
    "enabled": true,
    "process_llm": { "model": "deepseek-v4-pro" }
  }
}
```

### Step 5: Use it

```
/claro --mode translate 你好世界
```

### ctx API Reference

| Method | Description |
|--------|-------------|
| `ctx.callLLM(messages, phase?)` | Call LLM with auto-merged config for current mode/phase |
| `ctx.loadPrompt(name)` | Load a prompt file (mode-local first, global fallback) |
| `ctx.signal` | AbortSignal, pass to `fetch()` for cancellation |
| `ctx.sessionId` | Current session identifier |
| `ctx.requestId` | Current request identifier |
| `ctx.projectRoot` | pi working directory, for locating project data |

## Project Data

Each project maintains its own data under `.pi/claro/`:

| File | Purpose |
|------|---------|
| `claro-dict.json` | Learned speech recognition error mappings |
| `claro-pending.json` | Two-phase request state |
| `claro.log` | Operation log |

## License

MIT
