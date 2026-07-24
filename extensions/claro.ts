#!/usr/bin/env node
/**
 * claro — Pluggable text processing extension for pi.
 *
 * Provides:
 *   /claro [--mode <name>] <text>  — Process text through claro-server
 *   /claro --stop                   — Shutdown the claro server
 *
 * For modes with behavior "review": the result is placed in the editor.
 * When you press Enter the text is sent to the agent AND, if you edited it,
 * the changes are sent to the server for diff learning — all transparently.
 *
 * The claro-server (server/index.mjs) is spawned as an independent child
 * process on session_start. Server path is resolved relative to this
 * extension file, so it works when installed as a pi package via npm.
 *
 * This frontend is intentionally thin: it only handles server lifecycle,
 * HTTP transport, queue polling, and pi UI bridging. All business logic
 * (mode routing, LLM calls, dictionary management, diff analysis) lives
 * server-side.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Resolve server root — try multiple strategies
// ---------------------------------------------------------------------------

function resolveClaroHome(): string {
  if (process.env.CLARO_HOME) return process.env.CLARO_HOME;

  try {
    const candidate = join(__dirname, "..", "server");
    if (existsSync(join(candidate, "index.mjs"))) return candidate;
  } catch { /* __dirname may not be defined */ }

  return join(homedir(), ".pi", "agent", "claro");
}

const CLARO_HOME = resolveClaroHome();

// ---------------------------------------------------------------------------
// Extension config
// ---------------------------------------------------------------------------

function resolveExtConfigPath(): string {
  try {
    return join(__dirname, "config.json");
  } catch {
    return join(CLARO_HOME, "config.json");
  }
}

const EXT_CONFIG_PATH = resolveExtConfigPath();

interface ExtConfig {
  port: number;
  request_timeout_ms: number;
  health_check_timeout_ms: number;
  server_ready_timeout_ms: number;
  server_ready_poll_ms: number;
  queue_poll_ms: number;
  queue_timeout_ms: number;
  shutdown_timeout_ms: number;
}

const DEFAULT_EXT_CONFIG: ExtConfig = {
  port: 3742,
  request_timeout_ms: 60_000,
  health_check_timeout_ms: 2_000,
  server_ready_timeout_ms: 10_000,
  server_ready_poll_ms: 500,
  queue_poll_ms: 1_000,
  queue_timeout_ms: 120_000,
  shutdown_timeout_ms: 5_000,
};

let extConfig: ExtConfig = { ...DEFAULT_EXT_CONFIG };

async function loadExtConfig(): Promise<ExtConfig> {
  try {
    const raw = await readFile(EXT_CONFIG_PATH, "utf8");
    const user = JSON.parse(raw);
    return { ...DEFAULT_EXT_CONFIG, ...user };
  } catch {
    return { ...DEFAULT_EXT_CONFIG };
  }
}

let SERVER_URL = "http://127.0.0.1:3742";
let serverStarted = false;

// Lightweight pending edit state — only the most recent request.
// When a mode with behavior "review" processes text and puts it in the
// editor, this carries the requestId across the invisible boundary so the
// input event handler can fire-and-forget /finalize after the user submits.
let lastEdit: { requestId: string; original: string } | null = null;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/ping`, {
      signal: AbortSignal.timeout(extConfig.health_check_timeout_ms),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServerRunning(): Promise<void> {
  SERVER_URL = `http://127.0.0.1:${extConfig.port}`;

  const alive = await isServerRunning();
  if (alive) return;

  if (serverStarted) return;

  console.log(`[claro] Starting server at ${SERVER_URL}...`);
  const child = spawn(process.execPath, ["index.mjs"], {
    cwd: CLARO_HOME,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (data) => {
    console.error(`[claro-server] ${data.toString().trim()}`);
  });
  child.unref();
  serverStarted = true;

  const maxAttempts = Math.ceil(extConfig.server_ready_timeout_ms / extConfig.server_ready_poll_ms);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, extConfig.server_ready_poll_ms));
    if (await isServerRunning()) {
      console.log(`[claro] Server ready at ${SERVER_URL}`);
      return;
    }
  }
  console.warn(`[claro] Server did not become ready within ${extConfig.server_ready_timeout_ms / 1000}s.`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJSON(path: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(extConfig.request_timeout_ms),
  });

  const data = await response.json();

  if (!response.ok && response.status !== 202) {
    throw new Error(data.error || `Server ${response.status}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Queue polling
// ---------------------------------------------------------------------------

async function pollQueue(ticket: string, ctx: any): Promise<any> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        if (Date.now() - startTime > extConfig.queue_timeout_ms) {
          reject(new Error("Queue timeout — request took too long"));
          return;
        }

        const qResp = await fetch(`${SERVER_URL}/queue?ticket=${ticket}`);
        const qData = await qResp.json();

        if (qData.status === "done") {
          resolve(qData);
        } else if (qData.status === "error") {
          reject(new Error(qData.error || "Queue processing failed"));
        } else {
          const sec = Math.ceil(qData.wait_ms / 1000);
          ctx.ui.notify(`⏳ 排队第 ${qData.position} 位，预计 ${sec} 秒...`, "info");
          setTimeout(poll, extConfig.queue_poll_ms);
        }
      } catch (err: any) {
        reject(err);
      }
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(raw: string): { mode?: string; text: string } {
  // Flags are separated from text by " -- " (first occurrence).
  // Without " -- ", everything is treated as text with default mode.
  const sepIdx = raw.indexOf(" -- ");

  if (sepIdx < 0) {
    // No separator: check for inline --mode at the beginning
    const modeMatch = raw.match(/^--mode[= ](\S+)\s+(.*)/s);
    if (modeMatch) {
      return { mode: modeMatch[1], text: modeMatch[2].trim() };
    }
    return { text: raw.trim() };
  }

  const flagStr = raw.slice(0, sepIdx).trim();
  const text = raw.slice(sepIdx + 4).trim();

  const modeMatch = flagStr.match(/--mode[= ](\S+)/);
  return { mode: modeMatch?.[1], text };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    extConfig = await loadExtConfig();
    SERVER_URL = `http://127.0.0.1:${extConfig.port}`;
    ensureServerRunning();
  });

  // -----------------------------------------------------------------------
  // Command: /claro [--mode <name>] <text>  |  /claro --stop
  // -----------------------------------------------------------------------

  pi.registerCommand("claro", {
    description:
      "Process text via claro-server. Usage: /claro [--mode <name>] <text> | /claro --stop",
    getArgumentCompletions: (prefix: string) => {
      const flags = ["--mode ", "--stop"];
      return flags
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ value: f, label: f }));
    },
    handler: async (args, ctx) => {
      const raw = args.trim();

      // --- /claro --stop ---
      if (raw === "--stop") {
        ctx.ui.notify("🔌 Shutting down claro server...", "info");
        try {
          const response = await fetch(`${SERVER_URL}/shutdown`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: "claro-extension" }),
            signal: AbortSignal.timeout(extConfig.shutdown_timeout_ms),
          });
          if (response.ok) {
            ctx.ui.notify("✓ Server stopped", "success");
          } else {
            ctx.ui.notify(`✗ Server returned ${response.status}`, "error");
          }
        } catch (err: any) {
          ctx.ui.notify(`✗ Failed: ${err.message}`, "error");
        }
        return;
      }

      if (!raw) {
        ctx.ui.notify("Usage: /claro [--mode <name>] <text> | /claro --stop", "info");
        return;
      }

      const { mode, text: inputText } = parseArgs(raw);

      if (!inputText) {
        ctx.ui.notify("Usage: /claro [--mode <name>] <text>", "info");
        return;
      }

      const requestId = randomUUID();
      const sessionId = ctx.sessionManager.getSessionId();

      ctx.ui.notify("🧹 Processing with claro...", "info");

      const tryFetch = async (isRetry: boolean): Promise<any> => {
        try {
          return await postJSON("/process", {
            source: "claro-extension",
            session_id: sessionId,
            request_id: requestId,
            mode: mode || "claro",
            text: inputText,
            project_root: ctx.cwd,
          });
        } catch (error: any) {
          if (isRetry) throw error;
          const alive = await isServerRunning();
          if (!alive) {
            ctx.ui.notify("🔄 Server is down, restarting...", "info");
            serverStarted = false;
            await ensureServerRunning();
            return postJSON("/process", {
              source: "claro-extension",
              session_id: sessionId,
              request_id: requestId,
              mode: mode || "claro",
              text: inputText,
              project_root: ctx.cwd,
            });
          }
          throw error;
        }
      };

      try {
        let result = await tryFetch(false);

        if (result.status === "queued") {
          ctx.ui.notify(
            `⏳ 排队第 ${result.position} 位，预计 ${Math.ceil(result.wait_ms / 1000)} 秒...`,
            "info",
          );
          result = await pollQueue(result.ticket, ctx);
        }

        const behavior = result.behavior || "passthrough";

        if (behavior === "review") {
          // Two-phase: place in editor, input event triggers /finalize
          lastEdit = { requestId: result.request_id, original: result.result };
          ctx.ui.setEditorText(result.result);
          ctx.ui.notify(
            `✓ ${result.mode} · ${result.tokens} tokens · ${result.model}`,
            "success",
          );
        } else if (behavior === "passthrough") {
          ctx.ui.setEditorText(result.result);
          ctx.ui.notify(
            `✓ ${result.mode} · ${result.tokens} tokens · ready to send`,
            "success",
          );
        } else {
          pi.sendUserMessage(result.result);
        }
      } catch (error: any) {
        ctx.ui.notify(`✗ claro failed: ${error.message}`, "error");
      }
    },
  });

  // -----------------------------------------------------------------------
  // Input event — transparently handles /finalize for review-mode edits
  // -----------------------------------------------------------------------

  pi.on("input", async (event, _ctx) => {
    if (!lastEdit) return { action: "continue" };

    const { requestId, original } = lastEdit;
    lastEdit = null;

    const modifiedText = event.text;

    // Only call /finalize if the user actually changed the text
    if (modifiedText.trim() !== original.trim()) {
      const sessionId = _ctx.sessionManager.getSessionId();
      fetch(`${SERVER_URL}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "claro-extension",
          session_id: sessionId,
          request_id: requestId,
          modified_text: modifiedText,
          project_root: _ctx.cwd,
        }),
        signal: AbortSignal.timeout(extConfig.request_timeout_ms),
      })
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            if (data.suggestions?.length > 0) {
              _ctx.ui.notify(
                `📝 Learned ${data.suggestions.length} term(s)`,
                "success",
              );
            }
          }
        })
        .catch(() => {
          /* fire-and-forget: silent failure is acceptable */
        });
    }

    return { action: "continue" };
  });
}
