#!/usr/bin/env node
/**
 * claro — Oral text cleaning extension for pi.
 *
 * Provides:
 *   /claro <text>   — Clean oral/colloquial text via claro-server
 *   /claro-edit      — Finalize edited text, trigger diff learning
 *   /claro-stop      — Shutdown the claro server
 *
 * The claro-server (server/index.mjs) is spawned as an independent child
 * process on session_start. Server path is resolved relative to this
 * extension file, so it works when installed as a pi package via npm.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, appendFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Resolve server root — try multiple strategies:
//   1. CLARO_HOME env var
//   2. Relative to this extension file (works for npm-installed packages)
//   3. ~/.pi/agent/claro (legacy)
// ---------------------------------------------------------------------------

function resolveClaroHome(): string {
  if (process.env.CLARO_HOME) return process.env.CLARO_HOME;

  // When loaded by jiti, __dirname points to the extension's directory
  try {
    const candidate = join(__dirname, "..", "server");
    if (existsSync(join(candidate, "index.mjs"))) return candidate;
  } catch { /* __dirname may not be defined */ }

  // Legacy fallback
  return join(homedir(), ".pi", "agent", "claro");
}

const CLARO_HOME = resolveClaroHome();

// Extension config lives alongside this file (extensions/), not in server/.
function resolveExtConfigPath(): string {
  try {
    return join(__dirname, "claro-ext.json");
  } catch {
    return join(CLARO_HOME, "claro-ext.json");
  }
}

const EXT_CONFIG_PATH = resolveExtConfigPath();

// ---------------------------------------------------------------------------
// Extension config — completely separate from server config.json.
// Only contains extension-side settings (no API keys, no LLM params).
// ---------------------------------------------------------------------------

interface ExtConfig {
  port: number;
  request_timeout_ms: number;
  health_check_timeout_ms: number;
  server_ready_timeout_ms: number;
  server_ready_poll_ms: number;
  queue_poll_ms: number;
  queue_timeout_ms: number;
  shutdown_timeout_ms: number;
  log_max_lines: number;
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
  log_max_lines: 500,
};

// Module-level config — starts as defaults, loaded from file on session_start.
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

// ---------------------------------------------------------------------------
// Per-project runtime data
// ---------------------------------------------------------------------------

function projectDataDir(projectRoot: string): string {
  return join(projectRoot, ".pi", "claro");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function claroLog(projectRoot: string, level: string, msg: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    const logPath = join(projectDataDir(projectRoot), "claro.log");
    await appendFile(logPath, line);
  } catch {
    /* never crash on log failure */
  }
}

async function rotateLog(projectRoot: string) {
  try {
    const logPath = join(projectDataDir(projectRoot), "claro.log");
    const content = await readFile(logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    if (lines.length > extConfig.log_max_lines) {
      const trimmed = lines.slice(-extConfig.log_max_lines).join("\n") + "\n";
      await writeFile(logPath, trimmed, "utf-8");
    }
  } catch {
    /* log file doesn't exist yet or is unreadable — skip */
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle — health check, spawn, lazy recovery
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

  // Already running?
  const alive = await isServerRunning();
  if (alive) return;

  // Already attempted by us this session
  if (serverStarted) return;

  // Spawn as independent child process (detached + unref = survives pi exit)
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

  // Wait for server to become ready
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
// In-memory cache — one-to-one matching between /claro and /claro-edit
// ---------------------------------------------------------------------------

let lastCleanRequest: { requestId: string; cleaned: string } | null = null;

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
          ctx.ui.notify(
            `⏳ 排队第 ${qData.position} 位，预计 ${sec} 秒...`,
            "info",
          );
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
// Async diff — fire and forget
// ---------------------------------------------------------------------------

function triggerAsyncDiff(
  userModified: string,
  projectRoot: string,
  requestId: string,
  original: string,
) {
  (async () => {
    try {
      await claroLog(projectRoot, "DIFF", "triggered");

      if (!original) {
        await claroLog(projectRoot, "DIFF", "skipped: no original text");
        return;
      }

      if (original.trim() === userModified.trim()) {
        await claroLog(projectRoot, "DIFF", "skipped: no changes (identical)");
        return;
      }

      await claroLog(
        projectRoot,
        "DIFF",
        `sending to server · id=${requestId} · original=${original.length}chars · modified=${userModified.length}chars`,
      );

      const response = await fetch(`${SERVER_URL}/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "claro-extension",
          request_id: requestId,
          original,
          modified: userModified,
          project_root: projectRoot,
        }),
        signal: AbortSignal.timeout(extConfig.request_timeout_ms),
      });

      if (!response.ok) {
        await claroLog(projectRoot, "DIFF", `server error: ${response.status}`);
      }
    } catch (err: any) {
      await claroLog(projectRoot, "ERROR", `diff failed: ${err.message}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    extConfig = await loadExtConfig();
    SERVER_URL = `http://127.0.0.1:${extConfig.port}`;
    rotateLog(ctx.cwd);
    ensureServerRunning();
  });

  // -----------------------------------------------------------------------
  // Command: /claro <text>
  // -----------------------------------------------------------------------

  pi.registerCommand("claro", {
    description:
      "Clean oral/colloquial text: remove filler words and convert to written style. Usage: /claro <text>",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("Usage: /claro <oral text>", "info");
        return;
      }

      ctx.ui.notify("🧹 Cleaning with claro...", "info");

      const doFetch = async (): Promise<any> => {
        const response = await fetch(`${SERVER_URL}/clean`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "claro-extension",
            text,
            project_root: ctx.cwd,
          }),
          signal: AbortSignal.timeout(extConfig.request_timeout_ms),
        });

        if (!response.ok && response.status !== 202) {
          const err: any = await response.json().catch(() => ({}));
          throw new Error(err.error || `Server ${response.status}`);
        }

        return response.json();
      };

      const tryFetch = async (isRetry: boolean): Promise<any> => {
        try {
          return await doFetch();
        } catch (error: any) {
          if (isRetry) throw error;
          // Server may be down — revive once and retry
          const alive = await isServerRunning();
          if (!alive) {
            ctx.ui.notify("🔄 Server is down, restarting...", "info");
            serverStarted = false;
            await ensureServerRunning();
            return doFetch();
          }
          throw error;
        }
      };

      try {
        const result = await tryFetch(false);

        // Handle queued response — poll with countdown
        if (result.status === "queued") {
          ctx.ui.notify(
            `⏳ 排队第 ${result.position} 位，预计 ${Math.ceil(result.wait_ms / 1000)} 秒...`,
            "info",
          );
          const finalResult = await pollQueue(result.ticket, ctx);
          lastCleanRequest = {
            requestId: finalResult.request_id,
            cleaned: finalResult.cleaned,
          };
          ctx.ui.setEditorText(`/claro-edit ${finalResult.cleaned}`);
          ctx.ui.notify(
            `✓ Cleaned · ${finalResult.tokens} tokens · ${finalResult.model}`,
            "success",
          );
          await claroLog(
            ctx.cwd,
            "CLEAN",
            `cleaned ${finalResult.tokens} tokens · model=${finalResult.model} · id=${finalResult.request_id}`,
          );
          return;
        }

        // Immediate result
        lastCleanRequest = {
          requestId: result.request_id,
          cleaned: result.cleaned,
        };
        ctx.ui.setEditorText(`/claro-edit ${result.cleaned}`);
        ctx.ui.notify(
          `✓ Cleaned · ${result.tokens} tokens · ${result.model}`,
          "success",
        );
        await claroLog(
          ctx.cwd,
          "CLEAN",
          `cleaned ${result.tokens} tokens · model=${result.model} · id=${result.request_id}`,
        );
      } catch (error: any) {
        ctx.ui.notify(`✗ claro failed: ${error.message}`, "error");
      }
    },
  });

  // -----------------------------------------------------------------------
  // Command: /claro-edit — intercept user-edited version for diff learning
  // -----------------------------------------------------------------------

  pi.registerCommand("claro-edit", {
    description:
      "Finalize the claro-cleaned text (auto-generated, do not type manually).",
    handler: async (args, ctx) => {
      const userModified = args.trim();
      if (!userModified) return;

      // 1. Send user's final text to main agent immediately (non-blocking)
      pi.sendUserMessage(userModified);

      // 2. Diff against in-memory last clean request (one-to-one by requestId)
      if (lastCleanRequest) {
        triggerAsyncDiff(
          userModified,
          ctx.cwd,
          lastCleanRequest.requestId,
          lastCleanRequest.cleaned,
        );
        lastCleanRequest = null; // free memory
      }
    },
  });

  // -----------------------------------------------------------------------
  // Command: /claro-stop — shutdown the claro server
  // -----------------------------------------------------------------------

  pi.registerCommand("claro-stop", {
    description: "Shutdown the claro server.",
    handler: async (_args, ctx) => {
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
    },
  });
}
