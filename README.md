# claro 🧹

**Oral text, cleaned.** Claro takes messy spoken language — full of filler words, false starts, and broken sentences — and turns it into clean, polished written text using an LLM.

> 简体中文说明 → [README.zh-CN.md](./README.zh-CN.md)

## Demo

Imagine you just dictated this into your phone:

```
/claro 嗯那个我觉得吧这个方案其实可以就是说再优化一下然后就是那个性能方面可能还需要再看看
```

Claro hands it back, ready to send:

```
/claro-edit 我认为这个方案可以进一步优化，性能方面还需要再评估。
```

You can tweak the result before hitting Enter. When you do, claro learns from your edits — if you consistently replace "方案" with "架构设计", it picks up the pattern and applies it next time.

## Usage

| Command | What it does |
|---------|-------------|
| `/claro <text>` | Sends oral text to the LLM, returns a cleaned version in the editor for review |
| `/claro-edit <text>` | Auto-generated. Edit the result, then press Enter — the final text is sent to the agent, and claro diffs your changes to learn your terminology preferences |
| `/claro-stop` | Shuts down the local claro server |

> **Currently only available as a [pi](https://pi.dev) extension.** The backend is a standalone HTTP server, so integrations with other coding agents are possible — contributions welcome.

## File structure

```
Claro/
├── extensions/
│   ├── claro.ts                   # pi extension
│   └── config.json                # extension config (port & timeouts)
├── server/
│   ├── index.mjs                  # standalone HTTP server
│   ├── config.json                # server config (LLM, API key, port)
│   └── prompts/
│       ├── clean.md               # cleaning prompt template
│       └── diff.md                # diff analysis prompt template
├── README.md
└── README.zh-CN.md
```

## Architecture

Claro is **frontend + backend** with fully separated configuration:

```
┌──────────────────┐     HTTP (localhost)     ┌──────────────────┐     HTTPS     ┌─────────┐
│  pi extension     │ ◄─────────────────────► │  claro-server     │ ◄───────────► │   LLM   │
│  extensions/      │                         │  server/          │               └─────────┘
│  config.json      │                         │  config.json      │
└──────────────────┘                         └──────────────────┘
```

- **Frontend** (`extensions/claro.ts`) — registers `/claro` commands inside pi, spawns the server on first use. Config in `extensions/config.json`.
- **Backend** (`server/index.mjs`) — a standalone HTTP service that handles LLM calls, queueing, diff analysis, and per-project terminology dictionaries. Config in `server/config.json`.

The server is agent-agnostic. Adding support for another coding agent means writing a thin extension on top of the same backend.

## Install

```bash
pi install git:https://github.com/Crack-Hu/Claro
```

This installs both the extension and the server. No separate setup needed.

## Configure

Claro has **two separate config files** — the extension config and the server config. They live in different directories and contain different settings. This keeps sensitive data (API keys) isolated from the extension.

### Server config (`server/config.json`)

Contains LLM connection settings and the port the server listens on. On first run, created automatically from `config.example.json`.

```json
{
  "port": 3742,
  "verbose": false,
  "llm": {
    "api_type": "openai-completions",
    "base_url": "https://api.deepseek.com",
    "api_key": "$CLARO_API_KEY",
    "model": "deepseek-v4-flash",
    "temperature": 0.3,
    "max_tokens": 4096,
    "thinking": { "type": "disabled" },
    "reasoning_effort": "medium",
    "clean": {},
    "diff": {}
  }
}
```

| Field | Description |
|-------|-------------|
| `port` | Port the server listens on (default: `3742`) |
| `verbose` | Log full LLM request/response to `llm-debug.log` |
| `llm.base_url` | OpenAI-compatible API endpoint |
| `llm.api_key` | API key (supports `$ENV_VAR` syntax to read from environment) |
| `llm.model` | Default model for all requests |
| `llm.temperature` | Sampling temperature (0–2) |
| `llm.max_tokens` | Max tokens in response |
| `llm.thinking` | Enable/disable reasoning (e.g. `{"type": "enabled"}`) |
| `llm.reasoning_effort` | Reasoning effort level: `"low"`, `"medium"`, `"high"` |
| `llm.clean` | Overrides for `/clean` requests (model, temperature, etc.) |
| `llm.diff` | Overrides for `/diff` requests (model, temperature, etc.) |

You can also configure entirely via environment variables: `CLARO_API_KEY`, `CLARO_BASE_URL`, `CLARO_MODEL`, `CLARO_PORT`.

### Extension config (`extensions/config.json`)

Contains only extension-side settings — connection target, timeouts, and log limits. **No API keys or LLM parameters.** If the file is missing, defaults are used.

```json
{
  "port": 3742,
  "request_timeout_ms": 60000,
  "health_check_timeout_ms": 2000,
  "server_ready_timeout_ms": 10000,
  "server_ready_poll_ms": 500,
  "queue_poll_ms": 1000,
  "queue_timeout_ms": 120000,
  "shutdown_timeout_ms": 5000,
  "log_max_lines": 500
}
```

| Field | Description |
|-------|-------------|
| `port` | Port to connect to the server (**must match** server config) |
| `request_timeout_ms` | Timeout for /clean and /diff HTTP requests |
| `health_check_timeout_ms` | Timeout for `/ping` health checks |
| `server_ready_timeout_ms` | How long to wait for server startup |
| `server_ready_poll_ms` | Polling interval during server startup |
| `queue_poll_ms` | Polling interval while waiting in queue |
| `queue_timeout_ms` | Maximum time to wait in queue |
| `shutdown_timeout_ms` | Timeout for `/shutdown` requests |
| `log_max_lines` | Maximum lines per project log file |

> **Note:** The `port` field appears in both configs. The server config controls where the server *listens*, the extension config controls where the extension *connects*. Keep them in sync.

## How it works

1. `/claro <text>` → extension sends text to local claro-server
2. Server calls your LLM with a cleaning prompt (customizable in `server/prompts/clean.md`)
3. Cleaned text lands in your editor as `/claro-edit <cleaned>`
4. You edit → press Enter → final text sent to agent
5. Extension diffs your edits against the LLM output, learns terminology preferences
6. Dictionary stored per-project in `.pi/claro/claro-dict.json`

## Per-project data

Each project gets its own data under `.pi/claro/`:

| File | Purpose |
|------|---------|
| `claro-dict.json` | Learned terminology mappings |
| `claro-pending.json` | Pending diff request state |
| `claro.log` | Operation log |

## License

MIT
