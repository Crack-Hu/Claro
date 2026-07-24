# claro 🧹

**让口语变成书面语。** Claro 利用 LLM 修正语音识别的错误，将充满语气词、重复和破碎短句的口语化文字，转化为干净的书面表达，并自动学习你的纠错习惯。

> English version → [README.md](./README.md)

## 演示

你对着手机说了一段话，语音识别出了偏差：

```
/claro 嗯那个我觉得吧这个方案其实可以就是说再优化一下然后派agent那个性能可能还需要再看看
```

Claro 处理后，清洁的文本出现在编辑器里：

```
我认为这个方案可以进一步优化，pi-agent 的性能可能还需要再看看。
```

注意 `派agent` 被自动修正为 `pi-agent`——你在上次编辑中修正过一次，claro 记住了。

你可以进一步修改，再按回车。claro 会在后台对比你的修改和它的输出，自动学习新的识别错误模式。

## 用法

| 命令 | 作用 |
|------|------|
| `/claro <文本>` | 清洁口语文本，结果放入编辑器供审阅 |
| `/claro --mode <name> <文本>` | 指定处理模式（如 `translate`、`summarize`，需自行编写 mode 模块） |
| `/claro --stop` | 关闭本地 claro 服务 |

处理结果放入编辑器后，你编辑文本再回车即可。会根据模式的 behavior 不同而有不同行为：

| behavior | 说明 |
|----------|------|
| `review` | 文本放入编辑器，你修改后回车 → 自动对比学习新的识别错误（默认 claro 模式） |
| `passthrough` | 文本放入编辑器，回车直接发送，不进行学习 |

> **目前仅提供 [pi](https://pi.dev) 扩展。** 后端是独立的 HTTP 服务，理论上可以为其他 coding agent 编写前端插件——欢迎贡献。

## 文件结构

```
Claro/
├── extensions/
│   ├── claro.ts                   # pi 扩展（薄前端，仅 UI 桥接）
│   └── config.json                # 扩展配置（端口、超时等）
├── server/
│   ├── index.mjs                  # HTTP 服务框架（端点路由、队列、配置）
│   ├── config.json                # 服务端配置（LLM、API 密钥、端口、模式）
│   ├── lib/
│   │   └── dict.mjs               # 词典读写工具（mode 按需引用）
│   └── modes/
│       ├── noop/
│       │   └── index.mjs          # 透传模式（测试用）
│       └── claro/
│           ├── index.mjs          # 口语清洁模式
│           └── prompts/
│               ├── clean.md       # 清洁提示词
│               └── diff.md        # 识别错误学习提示词
├── README.md
└── README.zh-CN.md
```

## 架构

```
┌───────────┐           ┌──────────┐           ┌──────────┐           ┌──────────┐
│ extension │ ────────► │  server  │ ────────► │   mode   │ ────────► │   LLM    │
└───────────┘           └──────────┘           └──────────┘           └──────────┘
```

- **extension** — server 生命周期、HTTP 收发、队列轮询、UI 桥接、参数解析
- **server** — 路由、队列、配置合并、提示词解析
- **mode** — 可插拔处理模块，实现 `process()` / `finalize()`，通过 `ctx.callLLM()` 调用 LLM

前后端严格分离：**前端只管 UI 桥接，所有业务逻辑在 server 端**。每个 mode 是一个独立的 ES 模块，实现两个生命周期函数：

- `process(input, ctx)` — 处理文本（必须）
- `finalize(input, ctx)` — 处理用户的修改反馈（可选）

## 安装

```bash
pi install git:https://github.com/Crack-Hu/Claro
```

扩展和服务端一并安装，无需额外配置。

## 配置

Claro 有**两个独立的配置文件**。

### 服务端配置 (`server/config.json`)

包含 LLM 连接、模式定义。首次运行时自动从 `config.example.json` 创建。

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

| 字段 | 说明 |
|------|------|
| `port` | 服务器监听端口（默认 `3742`） |
| `verbose` | 启用后将完整 LLM 请求/响应用于调试写入 `llm-debug.log` |
| `defaultMode` | 未指定 `--mode` 时使用的默认模式 |
| `llm` | 全局 LLM 配置：`base_url`、`api_key`（支持 `$ENV_VAR`）、`model`、`temperature` 等 |
| `modes.<name>.enabled` | 是否启用该模式 |
| `modes.<name>.process_llm` | 该模式第一阶段（process）的 LLM 配置覆盖 |
| `modes.<name>.finalize_llm` | 该模式第二阶段（finalize）的 LLM 配置覆盖 |

LLM 配置合并规则：**全局 llm ← mode.process_llm ← mode.finalize_llm**，深层合并。

### 扩展配置 (`extensions/config.json`)

仅包含连接和超时参数，**不含 API 密钥**。

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

| 字段 | 说明 |
|------|------|
| `port` | 连接服务端的端口（**必须与**服务端 `port` 一致） |
| `request_timeout_ms` | HTTP 请求超时 |
| `queue_poll_ms` | 排队等待时的轮询间隔 |
| `queue_timeout_ms` | 排队最大等待时间 |

## 工作原理

1. `/claro <文本>` → 扩展将文本发给本地 claro-server 的 `/process` 端点
2. 服务端根据 `mode` 加载对应模块，调用 `process()` → LLM 处理
3. 结果放回 pi 编辑器（无命令前缀，纯文本）
4. 你编辑后回车 → 扩展通过 `input` 事件检测到编辑 → 调用 `/finalize` 端点
5. 服务端调用 mode 的 `finalize()`，对比原文和修改，学习新的识别错误
6. 学到的映射写入 `.pi/claro/claro-dict.json`，下次清洁时自动应用

## 添加自定义 Mode

每个 mode 是 `server/modes/<name>/` 目录下的一个 ES 模块。最少只需两个导出：

### 第一步：创建 mode 目录

```bash
mkdir -p server/modes/translate
```

### 第二步：编写 `index.mjs`

```js
// server/modes/translate/index.mjs

import { loadDictionary, saveDictionary } from "../../lib/dict.mjs";

export const meta = {
  name: "translate",
  description: "Translate text to English",
  behavior: "passthrough",   // "review" | "passthrough"
};

export async function process(input, ctx) {
  const prompt = await ctx.loadPrompt("translate.md");  // 从 modes/translate/prompts/ 读取
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

// 如果需要学习用户修改，可选实现 finalize
export async function finalize(input, ctx) {
  // input.original — 模型输出
  // input.modified — 用户修改后的文本
  // 需要词典则: const dict = await loadDictionary(ctx.projectRoot);
  return { final_text: input.modified };
}
```

### 第三步：（可选）添加提示词

```
server/modes/translate/prompts/
└── translate.md
```

`ctx.loadPrompt(name)` 会先在 `<mode>/prompts/` 下查找，找不到再回退到 `server/prompts/`。

### 第四步：启用模式

在 `server/config.json` 的 `modes` 中添加：

```json
"modes": {
  "translate": {
    "enabled": true,
    "process_llm": { "model": "deepseek-v4-pro" }
  }
}
```

### 第五步：使用

```
/claro --mode translate 你好世界
```

### ctx 可用方法

| 方法 | 说明 |
|------|------|
| `ctx.callLLM(messages, phase?)` | 调用 LLM，自动合并全局/模式/阶段的配置 |
| `ctx.loadPrompt(name)` | 加载提示词文件（mode 本地优先） |
| `ctx.signal` | 取消信号，可传入 `fetch()` |
| `ctx.sessionId` | 当前会话标识 |
| `ctx.requestId` | 当前请求标识 |
| `ctx.projectRoot` | pi 当前工作目录，可用于定位项目数据 |

## 项目数据

每个项目在 `.pi/claro/` 下维护独立数据：

| 文件 | 用途 |
|------|------|
| `claro-dict.json` | 学到的语音识别错误映射 |
| `claro-pending.json` | 两阶段请求的暂存状态 |
| `claro.log` | 操作日志 |

## License

MIT
