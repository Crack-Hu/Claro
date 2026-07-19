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

## Architecture

Claro is **frontend + backend**:

```
┌──────────────┐       HTTP        ┌──────────────┐
│  pi extension │ ◄──────────────► │  claro-server │
│  (claro.ts)   │    localhost     │  (index.mjs)  │
└──────────────┘                   └──────┬────────┘
                                          │
                                    ┌─────▼─────┐
                                    │    LLM    │
                                    │  (config) │
                                    └───────────┘
```

- **Frontend** (`extensions/claro.ts`) — registers `/claro` commands inside pi, spawns the server on first use
- **Backend** (`server/index.mjs`) — a standalone HTTP service that handles LLM calls, queueing, diff analysis, and per-project terminology dictionaries

The server is agent-agnostic. Adding support for another coding agent means writing a thin extension on top of the same backend.

## Install

```bash
pi install npm:claro
```

This installs both the extension and the server. No separate setup needed.

## Configure

On first run, the server creates `server/config.json` from the example template. Edit it:

```json
{
  "base_url": "https://api.deepseek.com",
  "api_key": "$CLARO_API_KEY",
  "model": "deepseek-v4-flash",
  "port": 3742
}
```

| Field | Description |
|-------|-------------|
| `base_url` | OpenAI-compatible API endpoint |
| `api_key` | API key (supports `$ENV_VAR` syntax to read from environment) |
| `model` | Model name for cleaning |
| `port` | Local server port (default: `3742`) |
| `clean.model` | Override model for `/clean` requests |
| `diff.model` | Override model for `/diff` requests |

You can also configure entirely via environment variables: `CLARO_API_KEY`, `CLARO_BASE_URL`, `CLARO_MODEL`.

## How it works

1. `/claro <text>` → extension sends text to local claro-server
2. Server calls your LLM with a cleaning prompt (customizable in `server/prompts/clean.md`)
3. Cleaned text lands in your editor as `/claro-edit <cleaned>`
4. You edit → press Enter → final text sent to agent
5. Extension diffs your edits against the LLM output, learns terminology preferences
6. Dictionary stored per-project in `.pi/claro/claro-dict.json`

## License

MIT
