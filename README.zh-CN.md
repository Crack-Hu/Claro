# claro 🧹

**让口语变成书面语。** Claro 利用 LLM 将充满语气词、重复和破碎短句的口语化文字，转化为干净流畅的书面表达。

> English version → [README.md](./README.md)

## 演示

假设你对着手机说了一段话：

```
/claro 嗯那个我觉得吧这个方案其实可以就是说再优化一下然后就是那个性能方面可能还需要再看看
```

Claro 处理后，直接把可发送的版本放在编辑器里：

```
/claro-edit 我认为这个方案可以进一步优化，性能方面还需要再评估。
```

你可以修改结果后再按回车。当你修改时，claro 会学习你的编辑习惯——如果你总是把"方案"改成"架构设计"，下次它就会自动用"架构设计"。

## 用法

| 命令 | 作用 |
|------|------|
| `/claro <文本>` | 将口语文本发送给 LLM 清洁，结果放入编辑器供审阅 |
| `/claro-edit <文本>` | 自动生成。编辑结果后按回车，最终文本发送给 agent，同时 claro 对比你的修改学习术语偏好 |
| `/claro-stop` | 关闭本地 claro 服务 |

> **目前仅提供 [pi](https://pi.dev) 扩展。** 后端是独立的 HTTP 服务，理论上可以为其他 coding agent 编写前端插件——欢迎贡献。

## 文件结构

```
Claro/
├── extensions/
│   ├── claro.ts                   # pi 扩展
│   └── config.json                # 扩展配置（端口、超时等）
├── server/
│   ├── index.mjs                  # 独立 HTTP 服务
│   ├── config.json                # 服务端配置（LLM、API 密钥、端口）
│   └── prompts/
│       ├── clean.md               # 清洁 prompt 模板
│       └── diff.md                # 差异分析 prompt 模板
├── README.md
└── README.zh-CN.md
```

## 架构

Claro 采用**前后端分离**设计，配置完全隔离：

```
┌──────────────────┐     HTTP (localhost)     ┌──────────────────┐     HTTPS     ┌─────────┐
│  pi 扩展          │ ◄─────────────────────► │  claro-server     │ ◄───────────► │   LLM   │
│  extensions/      │                         │  server/          │               └─────────┘
│  config.json      │                         │  config.json      │
└──────────────────┘                         └──────────────────┘
```

- **前端** (`extensions/claro.ts`) — 在 pi 中注册 `/claro` 系列命令，首次使用时自动启动后端服务。配置在 `extensions/config.json`。
- **后端** (`server/index.mjs`) — 独立的 HTTP 服务，处理 LLM 调用、请求排队、差异分析和项目级术语词典。配置在 `server/config.json`。

后端与具体 agent 无关。要为其他 agent 添加支持，只需基于同一后端编写一个薄扩展即可。

## 安装

```bash
pi install git:https://github.com/Crack-Hu/Claro
```

扩展和服务端一并安装，无需额外配置。

## 配置

Claro 有**两个独立的配置文件**——扩展配置和服务端配置。它们位于不同目录，包含不同设置，以此将敏感数据（API 密钥）与扩展隔离。

### 服务端配置 (`server/config.json`)

包含 LLM 连接设置和服务器监听端口。首次运行时自动从 `config.example.json` 创建。

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

| 字段 | 说明 |
|------|------|
| `port` | 服务器监听端口（默认 `3742`） |
| `verbose` | 是否将完整 LLM 请求/响应记录到 `llm-debug.log` |
| `llm.base_url` | OpenAI 兼容的 API 地址 |
| `llm.api_key` | API 密钥（支持 `$ENV_VAR` 语法从环境变量读取） |
| `llm.model` | 默认模型 |
| `llm.temperature` | 采样温度（0–2） |
| `llm.max_tokens` | 响应最大 token 数 |
| `llm.thinking` | 启用/禁用推理模式（如 `{"type": "enabled"}`） |
| `llm.reasoning_effort` | 推理强度：`"low"`、`"medium"`、`"high"` |
| `llm.clean` | `/clean` 请求的覆盖配置（模型、温度等） |
| `llm.diff` | `/diff` 请求的覆盖配置（模型、温度等） |

也可以通过环境变量配置：`CLARO_API_KEY`、`CLARO_BASE_URL`、`CLARO_MODEL`、`CLARO_PORT`。

### 扩展配置 (`extensions/config.json`)

仅包含扩展侧设置——连接目标、超时时间和日志限制。**不含任何 API 密钥或 LLM 参数。** 如果文件缺失，将使用默认值。

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

| 字段 | 说明 |
|------|------|
| `port` | 连接服务端的端口（**必须与**服务端配置一致） |
| `request_timeout_ms` | /clean 和 /diff HTTP 请求的超时时间 |
| `health_check_timeout_ms` | `/ping` 健康检查的超时时间 |
| `server_ready_timeout_ms` | 等待服务端启动的总时长 |
| `server_ready_poll_ms` | 等待服务端启动时的轮询间隔 |
| `queue_poll_ms` | 排队等待时的轮询间隔 |
| `queue_timeout_ms` | 排队最大等待时间 |
| `shutdown_timeout_ms` | `/shutdown` 请求的超时时间 |
| `log_max_lines` | 每个项目日志文件的最大行数 |

> **注意：** `port` 字段在两个配置中都出现。服务端配置决定服务器*监听*哪个端口，扩展配置决定扩展*连接*哪个端口。请保持两者一致。

## 工作原理

1. `/claro <文本>` → 扩展将文本发给本地 claro-server
2. 服务端调用 LLM，使用清洁 prompt（可在 `server/prompts/clean.md` 自定义）
3. 清洁后的文本以 `/claro-edit <结果>` 形式放入编辑器
4. 你修改 → 按回车 → 最终文本发送给 agent
5. 扩展对比你的修改与 LLM 输出，学习术语偏好
6. 词典按项目存储在 `.pi/claro/claro-dict.json`

## 项目数据

每个项目在 `.pi/claro/` 下有自己的数据：

| 文件 | 用途 |
|------|------|
| `claro-dict.json` | 学习到的术语映射 |
| `claro-pending.json` | 待处理的 diff 请求状态 |
| `claro.log` | 操作日志 |

## License

MIT
