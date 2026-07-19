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

## 架构

Claro 采用**前后端分离**设计：

```
┌──────────────┐       HTTP        ┌──────────────┐
│  pi 扩展      │ ◄──────────────► │  claro-server │
│  (claro.ts)   │    localhost     │  (index.mjs)  │
└──────────────┘                   └──────┬────────┘
                                          │
                                    ┌─────▼─────┐
                                    │    LLM    │
                                    │  (配置)    │
                                    └───────────┘
```

- **前端** (`extensions/claro.ts`) — 在 pi 中注册 `/claro` 系列命令，首次使用时自动启动后端服务
- **后端** (`server/index.mjs`) — 独立的 HTTP 服务，处理 LLM 调用、请求排队、差异分析和项目级术语词典

后端与具体 agent 无关。要为其他 agent 添加支持，只需基于同一后端编写一个薄扩展即可。

## 安装

```bash
pi install npm:claro
```

扩展和服务端一并安装，无需额外配置。

## 配置

首次运行时，服务端会自动从模板创建 `server/config.json`。编辑它：

```json
{
  "base_url": "https://api.deepseek.com",
  "api_key": "$CLARO_API_KEY",
  "model": "deepseek-v4-flash",
  "port": 3742
}
```

| 字段 | 说明 |
|------|------|
| `base_url` | OpenAI 兼容的 API 地址 |
| `api_key` | API 密钥（支持 `$ENV_VAR` 语法从环境变量读取） |
| `model` | 清洁文本使用的模型 |
| `port` | 本地服务端口（默认 `3742`） |
| `clean.model` | 覆盖 `/clean` 请求的模型 |
| `diff.model` | 覆盖 `/diff` 请求的模型 |

也可以通过环境变量配置：`CLARO_API_KEY`、`CLARO_BASE_URL`、`CLARO_MODEL`。

## 工作原理

1. `/claro <文本>` → 扩展将文本发给本地 claro-server
2. 服务端调用 LLM，使用清洁 prompt（可在 `server/prompts/clean.md` 自定义）
3. 清洁后的文本以 `/claro-edit <结果>` 形式放入编辑器
4. 你修改 → 按回车 → 最终文本发送给 agent
5. 扩展对比你的修改与 LLM 输出，学习术语偏好
6. 词典按项目存储在 `.pi/claro/claro-dict.json`

## License

MIT
