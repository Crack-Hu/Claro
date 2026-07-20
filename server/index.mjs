#!/usr/bin/env node
/**
 * claro-server — Local HTTP service for cleaning oral/colloquial text via LLM.
 *
 * Endpoints:
 *   POST /clean     — Clean oral text via LLM (with 5s queue)
 *   GET  /queue     — Poll queued request status (ticket param)
 *   POST /diff      — Compare original vs modified, suggest dictionary updates
 *   GET  /ping      — Health check
 *   POST /shutdown  — Graceful shutdown
 *
 * Config: <SERVER_HOME>/config.json
 *   { api_type, base_url, api_key, model, port, clean?, diff? }
 *
 * If config.json is missing, falls back to environment variables:
 *   CLARO_API_KEY, CLARO_BASE_URL, CLARO_MODEL, CLARO_PORT
 *
 * Usage:
 *   node index.mjs                      # Start with default port 3742
 *   CLARO_API_KEY=sk-xxx node index.mjs # With env var
 *
 * Shutdown:
 *   curl -X POST http://127.0.0.1:3742/shutdown \
 *     -H 'Content-Type: application/json' \
 *     -d '{"source":"claro-extension"}'
 */

import { readFile, writeFile, mkdir, unlink, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// SERVER_HOME: where config.json and prompts/ live.
// Defaults to the directory containing this script.
const SERVER_HOME = process.env.CLARO_HOME || __dirname;

const CONFIG_PATH = join(SERVER_HOME, "config.json");
const PROMPTS_DIR = join(SERVER_HOME, "prompts");

// Per-project runtime data is stored under <project>/.pi/claro/
function projectDataDir(projectRoot) {
  return join(projectRoot, ".pi", "claro");
}

const DEFAULT_CONFIG = {
  port: parseInt(process.env.CLARO_PORT || "3742", 10),
  verbose: false,
};

const DEFAULT_LLM = {
  api_type: "openai-completions",
  base_url: process.env.CLARO_BASE_URL || "https://api.deepseek.com",
  api_key: process.env.CLARO_API_KEY || null,
  model: process.env.CLARO_MODEL || "deepseek-v4-flash",
  temperature: 0.3,
  max_tokens: 4096,
};

async function loadConfig() {
  const examplePath = join(SERVER_HOME, "config.example.json");

  // Try to read config.json
  try {
    await readFile(CONFIG_PATH, "utf8");
  } catch {
    // Config missing — try to create from example
    try {
      await copyFile(examplePath, CONFIG_PATH);
      console.log(`[claro] Created config.json from config.example.json`);
      console.log(`[claro] Please edit ${CONFIG_PATH} to set your API key and other options.`);
    } catch (copyErr) {
      console.error(`[claro] Cannot create config.json: ${copyErr.message}`);
      console.error(`[claro] Copy ${examplePath} to ${CONFIG_PATH} manually.`);
    }
  }

  // Read and parse config.json
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const userConfig = JSON.parse(raw);
    const llm = { ...DEFAULT_LLM, ...(userConfig.llm || {}) };
    llm.api_key = resolveApiKey(llm.api_key);
    return {
      port: userConfig.port || DEFAULT_CONFIG.port,
      verbose: userConfig.verbose ?? DEFAULT_CONFIG.verbose,
      llm,
    };
  } catch (readErr) {
    // config.json still missing — use env vars only if API key is available
    const apiKey = process.env.CLARO_API_KEY;
    if (!apiKey) {
      console.error(`[claro] No config.json and no CLARO_API_KEY env var.`);
      console.error(`[claro] Copy ${examplePath} to ${CONFIG_PATH} and set your API key.`);
      return null;
    }
    console.warn(`[claro] Running without config.json — using CLARO_API_KEY env var with defaults.`);
    console.warn(`[claro] Create ${CONFIG_PATH} to configure model, thinking, etc.`);
    return {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_LLM, api_key: apiKey },
    };
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function resolveApiKey(rawKey) {
  if (rawKey && rawKey.startsWith("$")) {
    const envName = rawKey.slice(1);
    return process.env[envName] || "";
  }
  return rawKey || "";
}

function resolveTaskConfig(baseConfig, taskOverride) {
  const merged = { ...baseConfig, ...(taskOverride || {}) };
  return {
    api_type: merged.api_type,
    base_url: merged.base_url,
    api_key: resolveApiKey(merged.api_key),
    model: merged.model,
    temperature: merged.temperature,
    max_tokens: merged.max_tokens,
    thinking: merged.thinking,
    reasoning_effort: merged.reasoning_effort,
  };
}

// ---------------------------------------------------------------------------
// LLM API call (OpenAI-compatible)
// ---------------------------------------------------------------------------

async function callLLM(config, messages, signal, verbose) {
  const url = `${config.base_url}/v1/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature ?? 0.3,
      max_tokens: config.max_tokens ?? 4096,
      ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
      ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    let detail = response.statusText;
    let rawBody = "";
    try {
      rawBody = await response.text();
      const err = JSON.parse(rawBody);
      detail =
        err.error?.message || err.message || err.msg || JSON.stringify(err);
    } catch {
      /* ignore */
    }
    console.error(
      `[claro] LLM API error (${response.status}):`,
      detail || rawBody || "(empty body)",
    );
    throw new Error(
      `LLM API ${response.status}: ${detail || rawBody || "(empty body)"}`,
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const tokens = data.usage?.total_tokens || 0;

  if (verbose) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      request: { model: config.model, messages },
      response: data,
    };
    console.log("[claro] LLM call logged (verbose mode)");
    await writeFile(
      join(SERVER_HOME, "llm-debug.log"),
      JSON.stringify(logEntry, null, 2) + "\n---\n",
      { flag: "a" },
    ).catch(() => {});
  }

  return {
    content: content.trim(),
    tokens,
    model: data.model || config.model,
  };
}

// ---------------------------------------------------------------------------
// Dictionary helpers
// ---------------------------------------------------------------------------

async function loadDictionary(projectRoot) {
  const dictPath = join(projectDataDir(projectRoot), "claro-dict.json");
  try {
    const raw = await readFile(dictPath, "utf8");
    const dict = JSON.parse(raw);
    return dict.terms || {};
  } catch {
    return {};
  }
}

async function saveDictionary(projectRoot, terms) {
  const dictPath = join(projectDataDir(projectRoot), "claro-dict.json");
  await mkdir(dirname(dictPath), { recursive: true });
  await writeFile(
    dictPath,
    JSON.stringify(
      {
        version: 1,
        updated_at: new Date().toISOString(),
        terms,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Pending cache helpers
// ---------------------------------------------------------------------------

async function loadPending(projectRoot) {
  const pendingPath = join(projectDataDir(projectRoot), "claro-pending.json");
  try {
    const raw = await readFile(pendingPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function clearPending(projectRoot, requestId) {
  const pendingPath = join(projectDataDir(projectRoot), "claro-pending.json");
  const all = await loadPending(projectRoot);
  delete all[requestId];
  if (Object.keys(all).length === 0) {
    try {
      await unlink(pendingPath);
    } catch {
      /* ok */
    }
  } else {
    await writeFile(pendingPath, JSON.stringify(all, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Prompt template helpers
// ---------------------------------------------------------------------------

async function loadPromptTemplate(name) {
  const path = join(PROMPTS_DIR, name);
  return await readFile(path, "utf8");
}

function renderTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function buildDictBlock(dict) {
  const entries = Object.entries(dict);
  if (entries.length === 0) return "";
  let block = "以下是项目历史中积累的术语对应关系，**仅供参考，绝非强制替换**：\n\n";
  block += "- 每个映射表示过去某次对话中，用户将左侧词语修改为右侧词语\n";
  block += "- 同一词语在不同上下文中可能表达不同含义，请根据当前文本的语境自行判断\n";
  block += "- 列表中可能存在相互矛盾的映射（如 A→B 和 B→A 同时存在），这说明两者在不同场景下各有正确性，务必结合上下文决定\n\n";
  for (const [from, to] of entries) {
    block += `- "${from}" → "${to}"\n`;
  }
  return block;
}

async function buildCleanSystemPrompt(dict) {
  const template = await loadPromptTemplate("clean.md");
  return renderTemplate(template, { DICT: buildDictBlock(dict) });
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

function parseJSON(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function requireSource(body) {
  return body.source === "claro-extension";
}

async function handleClean(config, body, signal) {
  const { text, project_root } = body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return { status: 400, data: { error: "Missing or empty 'text' field" } };
  }

  const dict = project_root ? await loadDictionary(project_root) : {};
  const systemPrompt = await buildCleanSystemPrompt(dict);

  const cleanConfig = resolveTaskConfig(config.llm, config.llm?.clean);
  const result = await callLLM(
    cleanConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text.trim() },
    ],
    signal,
    config.verbose,
  );

  const requestId = randomUUID();

  // Store pending entry
  if (project_root) {
    const pendingPath = join(
      projectDataDir(project_root),
      "claro-pending.json",
    );
    await mkdir(dirname(pendingPath), { recursive: true });
    await writeFile(
      pendingPath,
      JSON.stringify(
        {
          [requestId]: {
            original_cleaned: result.content,
            timestamp: Date.now(),
          },
        },
        null,
        2,
      ),
    );
  }

  return {
    status: 200,
    data: {
      request_id: requestId,
      cleaned: result.content,
      model: result.model,
      tokens: result.tokens,
    },
  };
}

async function handleDiff(config, body, signal) {
  const { request_id, original, modified, project_root } = body;

  if (!original || !modified) {
    return {
      status: 400,
      data: { error: "Missing 'original' or 'modified' field" },
    };
  }

  if (original.trim() === modified.trim()) {
    if (request_id && project_root)
      await clearPending(project_root, request_id);
    return { status: 200, data: { suggestions: [] } };
  }

  const systemPrompt = await loadPromptTemplate("diff.md");

  const diffConfig = resolveTaskConfig(config.llm, config.llm?.diff);
  const result = await callLLM(
    diffConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `原始版本（模型清洁后）：\n${original}\n\n用户修改后的版本：\n${modified}` },
    ],
    signal,
    config.verbose,
  );

  const suggestions = parseDiffOutput(result.content);

  if (suggestions.length > 0 && project_root) {
    const dict = await loadDictionary(project_root);
    let updated = false;
    for (const { old_word, new_word } of suggestions) {
      if (old_word && new_word && old_word !== new_word) {
        dict[old_word] = new_word;
        updated = true;
      }
    }
    if (updated) {
      await saveDictionary(project_root, dict);
    }
  }

  if (request_id && project_root) {
    await clearPending(project_root, request_id);
  }

  return {
    status: 200,
    data: { suggestions },
  };
}

function parseDiffOutput(output) {
  if (
    !output ||
    output.trim() === "无" ||
    output.includes("没有任何术语改动")
  ) {
    return [];
  }

  const suggestions = [];
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    const match = trimmed.match(
      /^["'"“”‘’]?(.+?)["'"“”‘’]?\s*(?:->|→|=>|:)\s*["'"“”‘’]?(.+?)["'"“”‘’]?$/,
    );
    if (match) {
      const left = match[1].trim();
      const right = match[2].trim();
      if (left && right && left !== right) {
        suggestions.push({ old_word: left, new_word: right });
      }
    }
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Request queue — serializes /clean requests with 5s minimum interval
// ---------------------------------------------------------------------------

const MIN_CLEAN_INTERVAL_MS = 5000;
const tickets = new Map();
let lastCleanEnd = 0;
let processing = false;

function getQueuePosition(ticketId) {
  const queued = [...tickets.values()]
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt);
  const idx = queued.findIndex((t) => t.ticketId === ticketId);
  return idx >= 0 ? idx + 1 : 0;
}

function estimateWaitMs(position) {
  const now = Date.now();
  const intervalRemaining = Math.max(
    0,
    lastCleanEnd + MIN_CLEAN_INTERVAL_MS - now,
  );
  const queuedAhead = Math.max(0, position - 1);
  return intervalRemaining + queuedAhead * MIN_CLEAN_INTERVAL_MS;
}

function enqueueClean(config, body) {
  const ticketId = randomUUID();
  const ticket = {
    ticketId,
    status: "queued",
    config,
    body,
    createdAt: Date.now(),
    result: null,
    error: null,
    resolve: null,
    reject: null,
  };

  const promise = new Promise((resolve, reject) => {
    ticket.resolve = resolve;
    ticket.reject = reject;
  });
  ticket.promise = promise;
  tickets.set(ticketId, ticket);

  kickQueue();
  return ticketId;
}

async function kickQueue() {
  if (processing) return;

  const queued = [...tickets.values()]
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt);

  if (queued.length === 0) return;

  processing = true;

  const waitMs = Math.max(
    0,
    lastCleanEnd + MIN_CLEAN_INTERVAL_MS - Date.now(),
  );
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const ticket = queued[0];
  ticket.status = "processing";

  try {
    const result = await handleClean(
      ticket.config,
      ticket.body,
      AbortSignal.timeout(60000),
    );
    ticket.result = result;
    ticket.status = "done";
    ticket.resolve(result);
    lastCleanEnd = Date.now();
  } catch (err) {
    ticket.error = err.message;
    ticket.status = "error";
    ticket.reject(err);
    // Don't update lastCleanEnd — the API wasn't called successfully,
    // so no rate-limit token was consumed.
  }

  processing = false;

  // Clean up old tickets (keep last 50)
  const toDelete = [...tickets.entries()]
    .filter((t) => t.status === "done" || t.status === "error")
    .slice(50);
  for (const [id] of toDelete) tickets.delete(id);

  kickQueue();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await loadConfig();

  if (!config) {
    process.exit(1);
  }

  if (!config.llm?.api_key) {
    console.error("[claro] ERROR: No API key configured.");
    console.error("  Set CLARO_API_KEY environment variable, or");
    console.error(`  add 'api_key' to ${CONFIG_PATH}`);
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // GET /ping
    if (req.method === "GET" && url.pathname === "/ping") {
      sendJSON(res, 200, { status: "ok" });
      return;
    }

    // POST /clean
    if (req.method === "POST" && url.pathname === "/clean") {
      try {
        const body = await parseJSON(req);

        if (!requireSource(body)) {
          sendJSON(res, 403, { error: "Forbidden" });
          return;
        }

        if (
          !body.text ||
          typeof body.text !== "string" ||
          body.text.trim().length === 0
        ) {
          sendJSON(res, 400, { error: "Missing or empty 'text' field" });
          return;
        }

        const canProcessNow =
          !processing && Date.now() - lastCleanEnd >= MIN_CLEAN_INTERVAL_MS;

        if (canProcessNow) {
          processing = true;
          try {
            const result = await handleClean(
              config,
              body,
              AbortSignal.timeout(60000),
            );
            lastCleanEnd = Date.now();
            sendJSON(res, result.status, result.data);
          } catch (err) {
            // Don't update lastCleanEnd — the API wasn't called successfully,
            // so no rate-limit token was consumed.
            console.error("[claro] /clean error:", err.message);
            sendJSON(res, 500, { error: err.message });
          } finally {
            processing = false;
            kickQueue();
          }
          return;
        }

        // Enqueue
        const ticketId = enqueueClean(config, body);
        const position = getQueuePosition(ticketId);
        const waitMs = estimateWaitMs(position);
        sendJSON(res, 202, {
          status: "queued",
          ticket: ticketId,
          position,
          wait_ms: waitMs,
        });
      } catch (err) {
        processing = false;
        console.error("[claro] /clean error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // POST /diff
    if (req.method === "POST" && url.pathname === "/diff") {
      try {
        const body = await parseJSON(req);

        if (!requireSource(body)) {
          sendJSON(res, 403, { error: "Forbidden" });
          return;
        }

        const result = await handleDiff(
          config,
          body,
          AbortSignal.timeout(60000),
        );
        sendJSON(res, result.status, result.data);
      } catch (err) {
        console.error("[claro] /diff error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // GET /queue?ticket=xxx
    if (req.method === "GET" && url.pathname === "/queue") {
      const ticketId = url.searchParams.get("ticket");
      if (!ticketId) {
        sendJSON(res, 400, { error: "Missing 'ticket' parameter" });
        return;
      }

      const ticket = tickets.get(ticketId);
      if (!ticket) {
        sendJSON(res, 404, { status: "not_found" });
        return;
      }

      if (ticket.status === "done") {
        sendJSON(res, 200, { status: "done", ...ticket.result.data });
        return;
      }

      if (ticket.status === "error") {
        sendJSON(res, 200, { status: "error", error: ticket.error });
        return;
      }

      const position = getQueuePosition(ticketId);
      const waitMs = estimateWaitMs(position);
      sendJSON(res, 200, { status: "queued", position, wait_ms: waitMs });
      return;
    }

    // POST /shutdown
    if (req.method === "POST" && url.pathname === "/shutdown") {
      let body;
      try {
        body = await parseJSON(req);
      } catch {
        /* body may be empty */
      }

      if (!requireSource(body)) {
        sendJSON(res, 403, { error: "Forbidden" });
        return;
      }

      console.log("[claro] Shutting down...");
      sendJSON(res, 200, { status: "shutting_down" });
      server.close(() => {
        console.log("[claro] Server stopped.");
        process.exit(0);
      });
      return;
    }

    // 404
    sendJSON(res, 404, { error: "Not found" });
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[claro] Server running at http://127.0.0.1:${config.port}`);
    console.log(`[claro] Model: ${config.llm?.model}`);
    console.log(`[claro] API: ${config.llm?.base_url}`);
    console.log(
      `[claro] API key: ${config.llm?.api_key ? "configured" : "MISSING"}`,
    );
  });
}

main().catch((err) => {
  console.error("[claro] Fatal error:", err);
  process.exit(1);
});
