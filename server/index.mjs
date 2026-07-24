#!/usr/bin/env node
/**
 * claro-server — Local HTTP service for processing text via pluggable modes.
 *
 * Endpoints:
 *   POST /process  — Process text through a named mode (with queue)
 *   POST /finalize — Finalize a processed result (diff learning, dict update)
 *   GET  /queue    — Poll queued request status (ticket param)
 *   GET  /ping     — Health check
 *   POST /shutdown — Graceful shutdown
 *
 * Legacy (redirected internally):
 *   POST /clean    — → /process?mode=clean
 *   POST /diff     — → handled inside mode.finalize()
 *
 * Config: <SERVER_HOME>/config.json
 *   { port, verbose, defaultMode, llm, modes: { <name>: { enabled, process_llm?, finalize_llm? } } }
 *
 * Modes: <SERVER_HOME>/modes/<name>.mjs
 *   Each exports: meta { name, description, behavior }, process(), finalize()?.
 */

import { readFile, writeFile, mkdir, unlink, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { projectDataDir } from "./lib/dict.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_HOME = process.env.CLARO_HOME || __dirname;

const CONFIG_PATH = join(SERVER_HOME, "config.json");
const MODES_DIR = join(SERVER_HOME, "modes");
const PROMPTS_DIR = join(SERVER_HOME, "prompts"); // legacy fallback

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  port: parseInt(process.env.CLARO_PORT || "3742", 10),
  verbose: false,
  defaultMode: "clean",
};

const DEFAULT_LLM = {
  api_type: "openai-completions",
  base_url: process.env.CLARO_BASE_URL || "https://api.deepseek.com",
  api_key: process.env.CLARO_API_KEY || null,
  model: process.env.CLARO_MODEL || "deepseek-v4-flash",
  temperature: 0.3,
  max_tokens: 4096,
};

const DEFAULT_MODES = {
  clean: { enabled: true },
};

async function loadConfig() {
  const examplePath = join(SERVER_HOME, "config.example.json");

  let raw;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch {
    try {
      await copyFile(examplePath, CONFIG_PATH);
      console.log(`[claro] Created config.json from config.example.json`);
      console.log(`[claro] Please edit ${CONFIG_PATH} to set your API key.`);
      raw = await readFile(CONFIG_PATH, "utf8");
    } catch (copyErr) {
      console.error(`[claro] Cannot create config.json: ${copyErr.message}`);
    }
  }

  if (raw !== undefined) {
    try {
      const user = JSON.parse(raw);
      const llm = deepMerge({}, DEFAULT_LLM, user.llm || {});

      // --- backward compat: migrate old llm.clean / llm.diff into modes.clean ---
      let modes = user.modes || {};
      if (!modes.clean && (user.llm?.clean || user.llm?.diff)) {
        modes = { clean: { enabled: true }, ...modes };
      }
      if (user.llm?.clean && !modes.clean?.process_llm) {
        modes.clean = { ...modes.clean, process_llm: user.llm.clean };
      }
      if (user.llm?.diff && !modes.clean?.finalize_llm) {
        modes.clean = { ...modes.clean, finalize_llm: user.llm.diff };
      }
      // Normalise: ensure every key in DEFAULT_MODES exists
      for (const [name, def] of Object.entries(DEFAULT_MODES)) {
        if (!modes[name]) modes[name] = def;
      }
      // ----------------------------------------------------------------

      return {
        port: user.port || DEFAULT_CONFIG.port,
        verbose: user.verbose ?? DEFAULT_CONFIG.verbose,
        defaultMode: user.defaultMode || DEFAULT_CONFIG.defaultMode,
        llm,
        modes,
      };
    } catch (parseErr) {
      console.error(`[claro] ERROR: Invalid JSON in ${CONFIG_PATH}`);
      console.error(`[claro] ${parseErr.message}`);
      return null;
    }
  }

  // No config.json — try env vars
  const apiKey = process.env.CLARO_API_KEY;
  if (!apiKey) {
    console.error(`[claro] No config.json and no CLARO_API_KEY env var.`);
    return null;
  }
  console.warn(`[claro] Running without config.json — using CLARO_API_KEY env var.`);
  return {
    ...DEFAULT_CONFIG,
    llm: { ...DEFAULT_LLM, api_key: apiKey },
    modes: { ...DEFAULT_MODES },
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function deepMerge(...objects) {
  const result = {};
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    for (const [key, value] of Object.entries(obj)) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function resolveApiKey(rawKey) {
  if (rawKey && rawKey.startsWith("$")) {
    const envName = rawKey.slice(1);
    return process.env[envName] || "";
  }
  return rawKey || "";
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

async function callLLM(config, messages, signal, verbose) {
  const url = `${config.base_url}/v1/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolveApiKey(config.api_key)}`,
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
    try {
      const err = await response.json();
      detail = err.error?.message || err.message || err.msg || JSON.stringify(err);
    } catch { /* ignore */ }
    throw new Error(`LLM API ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const tokens = data.usage?.total_tokens || 0;

  if (verbose) {
    await writeFile(
      join(SERVER_HOME, "llm-debug.log"),
      JSON.stringify({ timestamp: new Date().toISOString(), request: { model: config.model, messages }, response: data }, null, 2) + "\n---\n",
      { flag: "a" },
    ).catch(() => {});
  }

  return { content, tokens, model: data.model || config.model };
}

// ---------------------------------------------------------------------------
// Pending (two-phase state) helpers
// ---------------------------------------------------------------------------

const pendingCache = new Map();

async function loadPending(requestId) {
  // Check in-memory cache first
  if (pendingCache.has(requestId)) return pendingCache.get(requestId);

  // Fallback: scan all project .pi/claro/claro-pending.json files
  // (in practice the in-memory cache covers the common case)
  return null;
}

async function savePending(requestId, data) {
  pendingCache.set(requestId, { ...data, timestamp: Date.now() });

  // Persist to project dir
  if (data.project_root) {
    const pendingPath = join(projectDataDir(data.project_root), "claro-pending.json");
    await mkdir(dirname(pendingPath), { recursive: true });
    const all = await loadPendingAll(data.project_root);
    all[requestId] = {
      mode: data.mode,
      session_id: data.session_id,
      original_result: data.original_result,
      timestamp: Date.now(),
    };
    await writeFile(pendingPath, JSON.stringify(all, null, 2));
  }
}

async function loadPendingAll(projectRoot) {
  const pendingPath = join(projectDataDir(projectRoot), "claro-pending.json");
  try {
    const raw = await readFile(pendingPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function clearPending(requestId) {
  pendingCache.delete(requestId);
  // Persisted cleanup happens lazily — entries expire after 24h
}

async function getPending(requestId) {
  // Check in-memory first
  if (pendingCache.has(requestId)) return pendingCache.get(requestId);

  // Could scan project directories, but for now rely on in-memory
  return null;
}

// ---------------------------------------------------------------------------
// Mode loading
// ---------------------------------------------------------------------------

const modeModuleCache = new Map();

async function loadMode(modeName) {
  if (modeModuleCache.has(modeName)) return modeModuleCache.get(modeName);

  // Security: only allow safe characters
  if (!/^[a-zA-Z0-9_-]+$/.test(modeName)) return null;

  // Try <modes>/<name>/index.mjs first, then <modes>/<name>.mjs (flat legacy)
  const candidates = [
    join(MODES_DIR, modeName, "index.mjs"),
    join(MODES_DIR, `${modeName}.mjs`),
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (!mod.meta || !mod.process) {
        console.error(`[claro] Mode "${modeName}" missing meta or process export`);
        return null;
      }
      modeModuleCache.set(modeName, mod);
      return mod;
    } catch {
      // try next candidate
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Mode context factory
// ---------------------------------------------------------------------------

function buildModeCtx(body, config, phase, signal) {
  const modeName = body.mode || config.defaultMode;
  const modeConfig = config.modes?.[modeName] || {};

  // Merge LLM config: global → mode override → phase override
  const llmConfig = (() => {
    const base = deepMerge({}, config.llm, modeConfig.process_llm || {});
    if (phase === "finalize" && modeConfig.finalize_llm) {
      return deepMerge(base, modeConfig.finalize_llm);
    }
    return base;
  })();

  return {
    config,
    signal,
    sessionId: body.session_id,
    requestId: body.request_id,
    projectRoot: body.project_root,

    callLLM: (messages, overridePhase) => {
      const effectivePhase = overridePhase || phase;
      const effectiveConfig = (() => {
        const base = deepMerge({}, config.llm, modeConfig.process_llm || {});
        if (effectivePhase === "finalize" && modeConfig.finalize_llm) {
          return deepMerge(base, modeConfig.finalize_llm);
        }
        return base;
      })();
      return callLLM(effectiveConfig, messages, signal, config.verbose);
    },

    loadPrompt: async (name) => {
      // 1. Check mode-local prompts/ dir first
      const modePromptPath = join(MODES_DIR, modeName, "prompts", name);
      try { return await readFile(modePromptPath, "utf8"); } catch { /* fall through */ }

      // 2. Fallback to global prompts/ dir
      const globalPath = join(PROMPTS_DIR, name);
      try { return await readFile(globalPath, "utf8"); } catch { /* fall through */ }

      throw new Error(`Prompt not found: ${name} (searched mode prompts and global prompts)`);
    },

    projectRoot: body.project_root,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function parseJSON(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("Invalid JSON")); }
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

// ---------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------

const MIN_PROCESS_INTERVAL_MS = 5000;
const tickets = new Map();
let lastProcessEnd = 0;
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
  const intervalRemaining = Math.max(0, lastProcessEnd + MIN_PROCESS_INTERVAL_MS - now);
  const queuedAhead = Math.max(0, position - 1);
  return intervalRemaining + queuedAhead * MIN_PROCESS_INTERVAL_MS;
}

function enqueueProcess(config, body) {
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

  const waitMs = Math.max(0, lastProcessEnd + MIN_PROCESS_INTERVAL_MS - Date.now());
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  const ticket = queued[0];
  ticket.status = "processing";

  try {
    const result = await handleProcess(ticket.config, ticket.body, AbortSignal.timeout(60000));
    ticket.result = result;
    ticket.status = "done";
    ticket.resolve(result);
    lastProcessEnd = Date.now();
  } catch (err) {
    ticket.error = err.message;
    ticket.status = "error";
    ticket.reject(err);
  }

  processing = false;

  // Clean up old tickets
  const toDelete = [...tickets.entries()]
    .filter((t) => t.status === "done" || t.status === "error")
    .slice(50);
  for (const [id] of toDelete) tickets.delete(id);

  kickQueue();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleProcess(config, body, signal) {
  const { text, mode, project_root, session_id, request_id } = body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return { status: 400, data: { error: "Missing or empty 'text' field" } };
  }

  const modeName = mode || config.defaultMode;
  const modeConfig = config.modes?.[modeName];

  if (!modeConfig || !modeConfig.enabled) {
    return { status: 400, data: { error: `Unknown or disabled mode: ${modeName}` } };
  }

  const mod = await loadMode(modeName);
  if (!mod) {
    return { status: 400, data: { error: `Mode module not found: ${modeName}` } };
  }

  const ctx = buildModeCtx(
    { ...body, mode: modeName },
    config,
    "process",
    signal,
  );

  const result = await mod.process({ text }, ctx);

  // Persist pending state for potential /finalize
  await savePending(request_id, {
    mode: modeName,
    session_id,
    original_result: result.content,
    project_root,
  });

  return {
    status: 200,
    data: {
      request_id,
      mode: modeName,
      behavior: mod.meta.behavior || "passthrough",
      result: result.content,
      tokens: result.tokens,
      model: result.model,
    },
  };
}

async function handleFinalize(config, body, signal) {
  const { request_id, modified_text, project_root } = body;

  if (!request_id) {
    return { status: 400, data: { error: "Missing 'request_id'" } };
  }
  if (modified_text === undefined || modified_text === null) {
    return { status: 400, data: { error: "Missing 'modified_text'" } };
  }

  const pending = await getPending(request_id);

  // Fallback: try loading from disk
  let modeName = pending?.mode;
  let originalResult = pending?.original_result;

  if (!modeName && project_root) {
    const all = await loadPendingAll(project_root);
    const entry = all[request_id];
    if (entry) {
      modeName = entry.mode;
      originalResult = entry.original_result;
    }
  }

  if (!modeName) {
    // No pending record — just echo back the modified text
    return { status: 200, data: { final_text: modified_text, suggestions: [] } };
  }

  const mod = await loadMode(modeName);
  if (!mod || !mod.finalize) {
    await clearPending(request_id);
    return { status: 200, data: { final_text: modified_text, suggestions: [] } };
  }

  const ctx = buildModeCtx(
    {
      mode: modeName,
      session_id: pending?.session_id || "",
      request_id,
      project_root,
    },
    config,
    "finalize",
    signal,
  );

  const result = await mod.finalize(
    { original: originalResult || "", modified: modified_text },
    ctx,
  );

  await clearPending(request_id);

  return { status: 200, data: result };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await loadConfig();
  if (!config) {
    console.error("[claro] Cannot start: no valid configuration.");
    process.exit(1);
  }

  if (!config.llm?.api_key) {
    console.error("[claro] ERROR: No API key configured.");
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // GET /ping
    if (req.method === "GET" && url.pathname === "/ping") {
      sendJSON(res, 200, { status: "ok" });
      return;
    }

    // POST /process
    if (req.method === "POST" && url.pathname === "/process") {
      try {
        const body = await parseJSON(req);
        if (!requireSource(body)) { sendJSON(res, 403, { error: "Forbidden" }); return; }

        const modeName = body.mode || config.defaultMode;
        if (!body.text || typeof body.text !== "string" || body.text.trim().length === 0) {
          sendJSON(res, 400, { error: "Missing or empty 'text' field" });
          return;
        }

        // Ensure request_id exists
        if (!body.request_id) body.request_id = randomUUID();

        const canProcessNow = !processing && Date.now() - lastProcessEnd >= MIN_PROCESS_INTERVAL_MS;

        if (canProcessNow) {
          processing = true;
          try {
            const result = await handleProcess(config, body, AbortSignal.timeout(60000));
            lastProcessEnd = Date.now();
            sendJSON(res, result.status, result.data);
          } catch (err) {
            console.error(`[claro] /process error:`, err.message);
            sendJSON(res, 500, { error: err.message });
          } finally {
            processing = false;
            kickQueue();
          }
          return;
        }

        // Enqueue
        const ticketId = enqueueProcess(config, body);
        const position = getQueuePosition(ticketId);
        const waitMs = estimateWaitMs(position);
        sendJSON(res, 202, { status: "queued", ticket: ticketId, position, wait_ms: waitMs });
      } catch (err) {
        processing = false;
        console.error(`[claro] /process error:`, err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // POST /finalize
    if (req.method === "POST" && url.pathname === "/finalize") {
      try {
        const body = await parseJSON(req);
        if (!requireSource(body)) { sendJSON(res, 403, { error: "Forbidden" }); return; }

        const result = await handleFinalize(config, body, AbortSignal.timeout(60000));
        sendJSON(res, result.status, result.data);
      } catch (err) {
        console.error(`[claro] /finalize error:`, err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // -- Legacy endpoints (backward compat) --

    // POST /clean → redirect to /process?mode=clean
    if (req.method === "POST" && url.pathname === "/clean") {
      try {
        const body = await parseJSON(req);
        if (!requireSource(body)) { sendJSON(res, 403, { error: "Forbidden" }); return; }

        body.mode = body.mode || "clean";
        if (!body.request_id) body.request_id = randomUUID();

        const canProcessNow = !processing && Date.now() - lastProcessEnd >= MIN_PROCESS_INTERVAL_MS;
        if (canProcessNow) {
          processing = true;
          try {
            const result = await handleProcess(config, body, AbortSignal.timeout(60000));
            lastProcessEnd = Date.now();
            sendJSON(res, result.status, result.data);
          } catch (err) {
            console.error(`[claro] /clean error:`, err.message);
            sendJSON(res, 500, { error: err.message });
          } finally {
            processing = false;
            kickQueue();
          }
          return;
        }

        const ticketId = enqueueProcess(config, body);
        const position = getQueuePosition(ticketId);
        const waitMs = estimateWaitMs(position);
        sendJSON(res, 202, { status: "queued", ticket: ticketId, position, wait_ms: waitMs });
      } catch (err) {
        processing = false;
        console.error(`[claro] /clean error:`, err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // POST /diff → handled via /finalize (kept for backward compat)
    if (req.method === "POST" && url.pathname === "/diff") {
      try {
        const body = await parseJSON(req);
        if (!requireSource(body)) { sendJSON(res, 403, { error: "Forbidden" }); return; }

        // Map old diff params to finalize
        const result = await handleFinalize(
          config,
          {
            request_id: body.request_id || randomUUID(),
            modified_text: body.modified,
            project_root: body.project_root,
          },
          AbortSignal.timeout(60000),
        );
        sendJSON(res, result.status, result.data);
      } catch (err) {
        console.error(`[claro] /diff error:`, err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return;
    }

    // GET /queue?ticket=xxx
    if (req.method === "GET" && url.pathname === "/queue") {
      const ticketId = url.searchParams.get("ticket");
      if (!ticketId) { sendJSON(res, 400, { error: "Missing 'ticket' parameter" }); return; }

      const ticket = tickets.get(ticketId);
      if (!ticket) { sendJSON(res, 404, { status: "not_found" }); return; }

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
      try { body = await parseJSON(req); } catch { /* ok */ }
      if (!requireSource(body)) { sendJSON(res, 403, { error: "Forbidden" }); return; }

      console.log("[claro] Shutting down...");
      sendJSON(res, 200, { status: "shutting_down" });
      server.close(() => { console.log("[claro] Server stopped."); process.exit(0); });
      return;
    }

    // 404
    sendJSON(res, 404, { error: "Not found" });
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`[claro] Server running at http://127.0.0.1:${config.port}`);
    console.log(`[claro] Model: ${config.llm?.model}`);
    console.log(`[claro] API: ${config.llm?.base_url}`);
    console.log(`[claro] Default mode: ${config.defaultMode}`);
    const enabled = Object.entries(config.modes || {}).filter(([, v]) => v.enabled).map(([k]) => k);
    console.log(`[claro] Modes: ${enabled.join(", ") || "(none)"}`);
  });
}

// Only start the server when this is the main module (not when imported for testing)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error("[claro] Fatal error:", err);
    process.exit(1);
  });
}

// Exports for testing
export { loadConfig, loadMode, buildModeCtx, handleProcess, handleFinalize, deepMerge, callLLM, savePending, getPending, clearPending };
