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
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  matchesKey,
  Key,
  truncateToWidth,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Resolve server root — try multiple strategies
// ---------------------------------------------------------------------------

function resolveClaroHome(): string {
  if (process.env.CLARO_HOME) return process.env.CLARO_HOME;

  // Strategy 1: relative to extension file (../server)
  // Works when running from source (git clone) or development
  try {
    const candidate = join(__dirname, "..", "server");
    if (existsSync(join(candidate, "index.mjs"))) return candidate;
  } catch { /* __dirname may not be defined */ }

  // Strategy 2: check common pi installation paths
  // When pi clones the repo, it's at: ~/.pi/agent/git/github.com/Crack-Hu/Claro/
  try {
    const homeDir = homedir();
    const candidates = [
      join(homeDir, ".pi", "agent", "git", "github.com", "Crack-Hu", "Claro", "server"),
      join(homeDir, ".pi", "agent", "node_modules", "claro", "server"),
      join(homeDir, ".pi", "node_modules", "claro", "server"),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, "index.mjs"))) return candidate;
    }
  } catch { /* ignore */ }

  // Strategy 3: fallback to ~/.pi/agent/claro/server (user-managed)
  return join(homedir(), ".pi", "agent", "claro", "server");
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

/**
 * Try to free the given port. If a claro server is running, shut it down gracefully.
 * If the port is occupied by a stale process, force kill it.
 */
async function freePort(port: number): Promise<void> {
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/ping`, {
      signal: AbortSignal.timeout(1000),
    });
    if (probe.ok) {
      // A claro server is running — try graceful shutdown
      try {
        const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "claro-extension" }),
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          await new Promise((r) => setTimeout(r, 500));
          return;
        }
      } catch {
        // Graceful shutdown failed, fall through to force kill
      }
      // Graceful shutdown didn't work — force kill
      await forceKillByPort(port);
    }
  } catch {
    // Nothing listening — port is free
  }
}

/**
 * Force kill all processes listening on the given port using lsof.
 */
async function forceKillByPort(port: number): Promise<void> {
  try {
    const result = execSync(
      `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`,
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    if (result) {
      const pids = result.split("\n").filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), "SIGTERM");
        } catch {
          // May not have permission
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {
    // lsof not available
  }
}

let serverStartRetries = 0;
const MAX_SERVER_START_RETRIES = 3;

async function ensureServerRunning(): Promise<void> {
  SERVER_URL = `http://127.0.0.1:${extConfig.port}`;

  const alive = await isServerRunning();
  if (alive) return;

  if (serverStarted) return;

  // Before starting, try to free the port
  await freePort(extConfig.port);

  console.log(`[claro] Starting server at ${SERVER_URL}...`);

  // Pass config to the server via environment variables so they agree on port
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env as Record<string, string>).filter(
        ([k]) => !k.startsWith("CLARO_"),
      ),
    ),
    CLARO_HOME,
    CLARO_PORT: String(extConfig.port),
  };

  const child = spawn(process.execPath, ["index.mjs"], {
    cwd: CLARO_HOME,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });

  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  child.on("exit", (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });

  child.stderr?.on("data", (data) => {
    console.error(`[claro-server] ${data.toString().trim()}`);
  });
  child.unref();
  serverStarted = true;

  const maxAttempts = Math.ceil(extConfig.server_ready_timeout_ms / extConfig.server_ready_poll_ms);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, extConfig.server_ready_poll_ms));

    if (childExited) {
      // Server process exited before becoming ready
      console.warn(
        `[claro] Server exited with code ${exitCode}${exitSignal ? ` (signal: ${exitSignal})` : ""} ` +
        `before becoming ready. Port ${extConfig.port} may be in use.`,
      );
      // Try one more time after freeing the port (with retry limit)
      serverStarted = false;
      serverStartRetries++;
      if (serverStartRetries <= MAX_SERVER_START_RETRIES) {
        await freePort(extConfig.port);
        return ensureServerRunning();
      } else {
        console.error(
          `[claro] Failed to start server after ${MAX_SERVER_START_RETRIES} retries. ` +
          `Please check that port ${extConfig.port} is available and no other claro server is running.`,
        );
        return;
      }
    }

    if (await isServerRunning()) {
      console.log(`[claro] Server ready at ${SERVER_URL}`);
      serverStartRetries = 0;
      return;
    }
  }

  console.warn(`[claro] Server did not become ready within ${extConfig.server_ready_timeout_ms / 1000}s.`);
  serverStarted = false;
  serverStartRetries = 0;
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
// Dictionary TUI types & helpers
// ---------------------------------------------------------------------------

interface DictAction {
  type: "delete" | "edit" | "add";
  key: string;
  value: string;
  oldKey?: string; // original key for edit (may differ if user changed it)
  selectedIndex: number; // position before the action
}

async function addOrEditEntry(
  ctx: any,
  oldKey: string | null,
  key: string,
  value: string,
): Promise<void> {
  // If editing and the key changed, delete the old entry first
  if (oldKey && oldKey !== key) {
    try {
      await fetch(
        `${SERVER_URL}/dict?project_root=${encodeURIComponent(ctx.cwd)}&key=${encodeURIComponent(oldKey)}`,
        { method: "DELETE", signal: AbortSignal.timeout(extConfig.request_timeout_ms) },
      );
    } catch { /* best-effort */ }
  }

  const resp = await fetch(`${SERVER_URL}/dict`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_root: ctx.cwd, key, value }),
    signal: AbortSignal.timeout(extConfig.request_timeout_ms),
  });

  if (!resp.ok) {
    const data = await resp.json();
    throw new Error(data.error || `Server ${resp.status}`);
  }
}

// ---------------------------------------------------------------------------
// DictBrowser — TUI component for browsing / editing / deleting dict entries
// ---------------------------------------------------------------------------

type DictView = "list" | "confirmDelete" | "edit" | "add";

class DictBrowser {
  private static readonly MAX_VISIBLE = 10;
  private view: DictView = "list";
  private entries: Array<{ key: string; value: string }>;
  private sorted = false;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private confirmFocus: "yes" | "no" = "yes";
  private deleteTarget: { key: string; value: string } | null = null;

  // Edit state
  private editKey = "";
  private editValue = "";
  private editFocus: "key" | "value" = "key";
  private editOldKey: string | null = null;
  private editError: string | null = null;

  // Render cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  private theme: any;
  private requestRender: () => void;
  private onAction: (action: DictAction | null) => void;

  constructor(
    entries: Array<{ key: string; value: string }>,
    theme: any,
    requestRender: () => void,
    onAction: (action: DictAction | null) => void,
    initialView?: DictView,
    initialIndex?: number,
  ) {
    this.entries = entries;
    this.theme = theme;
    this.requestRender = requestRender;
    this.onAction = onAction;
    if (initialView) {
      this.view = initialView;
    }
    if (initialIndex !== undefined && initialIndex < entries.length) {
      this.selectedIndex = initialIndex;
      // Scroll to show the selected entry
      if (initialIndex >= DictBrowser.MAX_VISIBLE) {
        this.scrollOffset = initialIndex - DictBrowser.MAX_VISIBLE + 1;
      }
    }
  }

  // ---- public interface ----

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    // Compute display entries (sorted or original order)
    const displayEntries = this.sorted
      ? [...this.entries].sort((a, b) => a.key.localeCompare(b.key, "zh"))
      : this.entries;

    let raw: string[];
    switch (this.view) {
      case "list":
        raw = this.renderList(width, displayEntries);
        break;
      case "confirmDelete":
        raw = this.renderConfirm(width);
        break;
      case "edit":
      case "add":
        raw = this.renderEdit(width);
        break;
    }

    // Wrap content in a magenta top / bottom line, with 1-char side padding
    const MAG = "\x1b[35m";
    const RST = "\x1b[0m";
    const innerW = Math.max(10, width - 4);
    const bar = MAG + "─".repeat(innerW) + RST;

    const lines = [bar];
    for (const line of raw) {
      const truncated = truncateToWidth(line, innerW - 2); // -2 for the 1-char side padding
      const after = truncated.replace(/\x1b\[[0-9;]*m/g, "");
      const pad = innerW - 2 - after.length;
      lines.push(" " + truncated + " ".repeat(Math.max(pad, 0)) + " ");
    }
    lines.push(bar);

    // Pad lines to terminal width so the overlay fully covers
    const padded = lines.map((l) => {
      const plain = l.replace(/\x1b\[[0-9;]*m/g, "");
      const need = width - plain.length;
      return need > 0 ? l + " ".repeat(need) : l;
    });

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.view === "list") {
      const displayEntries = this.sorted
        ? [...this.entries].sort((a, b) => a.key.localeCompare(b.key, "zh"))
        : this.entries;
      this.handleListInput(data, displayEntries);
    } else if (this.view === "confirmDelete") {
      this.handleConfirmInput(data);
    } else {
      this.handleEditInput(data);
    }
  }

  // ---- list view ----

  private renderList(width: number, displayEntries: Array<{ key: string; value: string }>): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const pad = " ".repeat(2);

    // Title
    const title = `Claro Dictionary (${this.entries.length} entries)` + (this.sorted ? " [sorted]" : "");
    lines.push(pad + t.fg("accent", t.bold(title)));
    lines.push("");

    // Entries — show only a scrollable window
    if (displayEntries.length === 0) {
      lines.push(pad + t.fg("muted", "(empty)"));
    } else {
      const visibleStart = this.scrollOffset;
      const visibleEnd = Math.min(visibleStart + DictBrowser.MAX_VISIBLE, displayEntries.length);
      for (let i = visibleStart; i < visibleEnd; i++) {
        const { key, value } = displayEntries[i]!;
        const display = `${key}  →  ${value}`;
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? "> " : "  ";
        const colored = isSelected
          ? t.bg("selectedBg", prefix + display)
          : prefix + t.fg("text", display);
        lines.push(truncateToWidth(colored, width - 2));
      }
    }

    lines.push("");
    const scrollHint = displayEntries.length > DictBrowser.MAX_VISIBLE
      ? ` (${this.selectedIndex + 1}/${displayEntries.length})`
      : "";
    lines.push(
      pad +
        t.fg(
          "dim",
          `↑↓ · esc · d delete · e edit · n new · s sort${scrollHint}`,
        ),
    );

    return lines;
  }

  private handleListInput(data: string, displayEntries: Array<{ key: string; value: string }>): void {
    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        if (this.selectedIndex < this.scrollOffset) {
          this.scrollOffset = this.selectedIndex;
        }
        this.invalidate();
        this.requestRender();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selectedIndex < displayEntries.length - 1) {
        this.selectedIndex++;
        if (this.selectedIndex >= this.scrollOffset + DictBrowser.MAX_VISIBLE) {
          this.scrollOffset = this.selectedIndex - DictBrowser.MAX_VISIBLE + 1;
        }
        this.invalidate();
        this.requestRender();
      }
    } else if (matchesKey(data, Key.escape)) {
      this.onAction(null);
    } else if (data === "d" || data === "D") {
      if (displayEntries.length > 0 && this.selectedIndex < displayEntries.length) {
        this.deleteTarget = displayEntries[this.selectedIndex]!;
        this.view = "confirmDelete";
        this.confirmFocus = "yes";
        this.invalidate();
        this.requestRender();
      }
    } else if (data === "e" || data === "E") {
      if (displayEntries.length > 0 && this.selectedIndex < displayEntries.length) {
        const entry = displayEntries[this.selectedIndex]!;
        this.editOldKey = entry.key;
        this.editKey = entry.key;
        this.editValue = entry.value;
        this.editFocus = "key";
        this.editError = null;
        this.view = "edit";
        this.invalidate();
        this.requestRender();
      }
    } else if (data === "s" || data === "S") {
      this.sorted = !this.sorted;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.invalidate();
      this.requestRender();
    } else if (data === "n" || data === "N") {
      this.editOldKey = null;
      this.editKey = "";
      this.editValue = "";
      this.editFocus = "key";
      this.editError = null;
      this.view = "add";
      this.invalidate();
      this.requestRender();
    }
  }

  // ---- confirm dialog ----

  private renderConfirm(width: number): string[] {
    const t = this.theme;
    const entry = this.deleteTarget!;
    const lines: string[] = [];
    const pad = "  ";

    lines.push(pad + t.fg("warning", t.bold("Delete Entry")));
    lines.push("");
    lines.push(
      pad + `Delete "${t.fg("accent", entry.key)} → ${t.fg("accent", entry.value)}"?`,
    );
    lines.push("");

    const yesLabel =
      this.confirmFocus === "yes"
        ? t.bg("selectedBg", "  Yes  ")
        : "  Yes  ";
    const noLabel =
      this.confirmFocus === "no"
        ? t.bg("selectedBg", "  No  ")
        : "  No  ";
    lines.push(pad + `${yesLabel}  ${noLabel}`);
    lines.push("");
    lines.push(
      pad + t.fg("dim", "←→ choose · enter confirm · esc cancel"),
    );

    return lines;
  }

  private handleConfirmInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.view = "list";
      this.invalidate();
      this.requestRender();
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.confirmFocus = this.confirmFocus === "yes" ? "no" : "yes";
      this.invalidate();
      this.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      if (this.confirmFocus === "yes") {
        const entry = this.deleteTarget!;
        this.onAction({ type: "delete", key: entry.key, value: entry.value, selectedIndex: this.selectedIndex });
      } else {
        this.view = "list";
        this.invalidate();
        this.requestRender();
      }
    }
  }

  // ---- edit dialog ----

  private renderEdit(width: number): string[] {
    const t = this.theme;
    const isAdd = this.view === "add";
    const lines: string[] = [];
    const pad = "  ";

    const title = isAdd ? "Add Entry" : "Edit Entry";
    lines.push(pad + t.fg("accent", t.bold(title)));
    lines.push("");

    // Key field
    const keyLabel = "Key:  ";
    const keyCursor = this.editFocus === "key" ? "│" : " ";
    const keyDisplay = this.editKey;
    const keyLine =
      pad +
      keyLabel +
      (this.editFocus === "key"
        ? t.bg("selectedBg", keyDisplay + keyCursor)
        : keyDisplay + keyCursor);
    lines.push(truncateToWidth(keyLine, width - 2));

    // Arrow
    lines.push(pad + "       ↓");

    // Value field
    const valLabel = "Value:";
    const valCursor = this.editFocus === "value" ? "│" : " ";
    const valDisplay = this.editValue;
    const valLine =
      pad +
      valLabel +
      (this.editFocus === "value"
        ? t.bg("selectedBg", valDisplay + valCursor)
        : valDisplay + valCursor);
    lines.push(truncateToWidth(valLine, width - 2));

    lines.push("");

    // Error message
    if (this.editError) {
      lines.push(pad + t.fg("error", `✗ ${this.editError}`));
      lines.push("");
    }

    lines.push(
      pad +
        t.fg(
          "dim",
          "Tab switch field · Enter save · Esc cancel",
        ),
    );

    return lines;
  }

  private handleEditInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      // In "add" view, escape closes the browser (no entries to go back to)
      if (this.view === "add") {
        this.onAction(null);
        return;
      }
      this.view = "list";
      this.editError = null;
      this.invalidate();
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.editFocus = this.editFocus === "key" ? "value" : "key";
      this.editError = null;
      this.invalidate();
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const key = this.editKey.trim();
      const value = this.editValue.trim();

      if (!key || !value) {
        this.editError = "Key and value cannot be empty";
        this.invalidate();
        this.requestRender();
        return;
      }

      // Validate format: a -> b (key and value must be non-empty)
      if (key === value) {
        this.editError = "Key and value must be different";
        this.invalidate();
        this.requestRender();
        return;
      }

      const isAdd = this.view === "add";
      this.onAction({
        type: isAdd ? "add" : "edit",
        key,
        value,
        oldKey: isAdd ? undefined : (this.editOldKey ?? undefined),
        selectedIndex: this.selectedIndex,
      });
      return;
    }

    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      if (this.editFocus === "key" && this.editKey.length > 0) {
        this.editKey = this.editKey.slice(0, -1);
      } else if (this.editFocus === "value" && this.editValue.length > 0) {
        this.editValue = this.editValue.slice(0, -1);
      }
      this.editError = null;
      this.invalidate();
      this.requestRender();
      return;
    }

    // Printable characters (single byte, not a control sequence)
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      if (this.editFocus === "key") {
        this.editKey += data;
      } else {
        this.editValue += data;
      }
      this.editError = null;
      this.invalidate();
      this.requestRender();
    }
  }
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
  // showDictBrowser — TUI dictionary browser (called by /claro --dict)
  // -----------------------------------------------------------------------

  async function showDictBrowser(ctx: any): Promise<void> {
    const showBrowser = async (newIndex?: number): Promise<void> => {
      // Fetch current entries
      let entries: Array<{ key: string; value: string }> = [];
      try {
        const resp = await fetch(
          `${SERVER_URL}/dict?project_root=${encodeURIComponent(ctx.cwd)}`,
          { signal: AbortSignal.timeout(extConfig.request_timeout_ms) },
        );
        if (resp.ok) {
          const data = await resp.json();
          entries = Object.entries(data.terms as Record<string, string>).map(
            ([k, v]) => ({ key: k, value: v }),
          );
        }
      } catch {
        ctx.ui.notify("✗ Failed to load dictionary", "error");
        return;
      }

      if (entries.length === 0) {
        const addNew = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
          const comp = new DictBrowser(
            [],
            theme,
            () => { tui.requestRender(); },
            (action) => {
              if (!action) {
                done(false);
              } else if (action.type === "add") {
                addOrEditEntry(ctx, null, action.key, action.value)
                  .then(() => done(true))
                  .catch((err: any) => {
                    ctx.ui.notify(`✗ Failed: ${err.message}`, "error");
                    done(false);
                  });
              } else {
                done(false);
              }
            },
            "add",
          );
          return {
            render: (w) => comp.render(w),
            invalidate: () => comp.invalidate(),
            handleInput: (data) => { comp.handleInput(data); tui.requestRender(); },
          };
        }, { overlay: true });
        if (addNew) {
          ctx.ui.notify("✓ Dictionary updated", "success");
          return showBrowser();
        }
        return;
      }

      const result = await ctx.ui.custom<DictAction | null>(
        (tui, theme, _kb, done) => {
          const comp = new DictBrowser(
            entries,
            theme,
            () => { tui.requestRender(); },
            (action) => done(action),
            undefined,
            newIndex,
          );
          return {
            render: (w) => comp.render(w),
            invalidate: () => comp.invalidate(),
            handleInput: (data) => { comp.handleInput(data); tui.requestRender(); },
          };
        },
        { overlay: true },
      );

      if (!result) {
        return; // user cancelled
      }

      if (result.type === "delete") {
        try {
          const resp = await fetch(
            `${SERVER_URL}/dict?project_root=${encodeURIComponent(ctx.cwd)}&key=${encodeURIComponent(result.key)}`,
            { method: "DELETE", signal: AbortSignal.timeout(extConfig.request_timeout_ms) },
          );
          if (resp.ok) {
            ctx.ui.notify(`✓ Deleted "${result.key}"`, "success");
          } else {
            ctx.ui.notify(`✗ Failed to delete "${result.key}"`, "error");
          }
        } catch {
          ctx.ui.notify(`✗ Failed to delete "${result.key}"`, "error");
        }
        // After delete: auto-select next entry (or previous if last was deleted)
        const nextIndex = result.selectedIndex < entries.length
          ? result.selectedIndex
          : Math.max(0, result.selectedIndex - 1);
        return showBrowser(nextIndex);
      }

      if (result.type === "edit") {
        await addOrEditEntry(ctx, result.oldKey ?? null, result.key, result.value);
        ctx.ui.notify(`✓ Updated "${result.key} → ${result.value}"`, "success");
        return showBrowser(result.selectedIndex);
      }

      if (result.type === "add") {
        await addOrEditEntry(ctx, null, result.key, result.value);
        ctx.ui.notify(`✓ Added "${result.key} → ${result.value}"`, "success");
        return showBrowser();
      }
    };

    await showBrowser();
  }

  // -----------------------------------------------------------------------
  // Command: /claro [--mode <name>] <text>  |  /claro --stop
  // -----------------------------------------------------------------------

  pi.registerCommand("claro", {
    description:
      "Process text via claro-server. Usage: /claro [--mode <name>] <text> | /claro --stop | /claro --dict",
    getArgumentCompletions: (prefix: string) => {
      const flags = ["--mode ", "--stop", "--dict"];
      return flags
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ value: f, label: f }));
    },
    handler: async (args, ctx) => {
      const raw = args.trim();

      // --- /claro --dict ---
      if (raw === "--dict") {
        try {
          await ensureServerRunning();
          await showDictBrowser(ctx);
        } catch (err: any) {
          ctx.ui.notify(`✗ dict: ${err.message}`, "error");
        }
        return;
      }

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
