/**
 * Server unit tests — import internal functions, no TCP needed.
 */
import { deepMerge, loadMode, buildModeCtx, handleProcess, handleFinalize } from "./index.mjs";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

async function test() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));

  // =============================================
  console.log("=== deepMerge ===");
  // =============================================
  const m = deepMerge(
    { a: 1, b: { x: 1 } },
    { b: { y: 2 }, c: 3 }
  );
  assert(m.a === 1, "shallow merge preserves base");
  assert(m.b.x === 1, "deep merge preserves nested base");
  assert(m.b.y === 2, "deep merge applies nested override");
  assert(m.c === 3, "shallow merge applies new key");
  console.log(`  deepMerge: ${passed}/${passed + failed} passed`);

  // =============================================
  console.log("=== loadMode ===");
  // =============================================
  const noop = await loadMode("noop");
  assert(noop !== null, "noop mode loads");
  assert(noop.meta.name === "noop", "noop meta.name correct");
  assert(noop.meta.behavior === "passthrough", "noop behavior is passthrough");
  assert(typeof noop.process === "function", "noop.process is function");

  const claro = await loadMode("claro");
  assert(claro !== null, "claro mode loads");
  assert(claro.meta.behavior === "review", "claro behavior is review");
  assert(typeof claro.finalize === "function", "claro.finalize is function");

  const ghost = await loadMode("ghost");
  assert(ghost === null, "nonexistent mode returns null");

  const bad = await loadMode("../../etc/passwd");
  assert(bad === null, "path traversal blocked");
  console.log(`  loadMode: ${passed}/${passed + failed} passed`);

  // =============================================
  console.log("=== buildModeCtx ===");
  // =============================================
  const testRoot = join(__dirname, "..", ".pi", "claro-test");

  // Context for noop mode (no loadPrompt expected, not used)
  const ctxNoop = buildModeCtx(
    { mode: "noop", session_id: "s1", request_id: "r1", project_root: testRoot },
    config, "process", new AbortController().signal
  );
  assert(ctxNoop.callLLM !== undefined, "ctx has callLLM");
  assert(ctxNoop.loadPrompt !== undefined, "ctx has loadPrompt");
  assert(ctxNoop.projectRoot !== undefined, "ctx has projectRoot");
  assert(ctxNoop.sessionId === "s1", "ctx.sessionId correct");
  assert(ctxNoop.requestId === "r1", "ctx.requestId correct");

  // Context for claro mode — has mode-local prompts
  const ctxClaro = buildModeCtx(
    { mode: "claro", session_id: "s1", request_id: "r1", project_root: testRoot },
    config, "process", new AbortController().signal
  );

  // loadPrompt — mode-local fallback
  try {
    const prompt = await ctxClaro.loadPrompt("clean.md");
    assert(typeof prompt === "string" && prompt.length > 0, "loadPrompt reads prompt file");
  } catch (e) {
    assert(false, `loadPrompt failed: ${e.message}`);
  }
  console.log(`  buildModeCtx: ${passed}/${passed + failed} passed`);

  // =============================================
  console.log("=== handleProcess (noop) ===");
  // =============================================
  const pResult = await handleProcess(config, {
    source: "claro-extension",
    session_id: "s1",
    request_id: "p1",
    mode: "noop",
    text: "你好世界 Hello World",
    project_root: testRoot,
  }, new AbortController().signal);

  assert(pResult.status === 200, "process returns 200");
  assert(pResult.data.result === "你好世界 Hello World", "noop returns input unchanged");
  assert(pResult.data.tokens === 0, "noop uses 0 tokens");
  assert(pResult.data.model === "noop", "noop model is noop");
  assert(pResult.data.behavior === "passthrough", "noop behavior correct");
  assert(pResult.data.mode === "noop", "mode name in response");
  console.log(`  handleProcess noop: ${passed}/${passed + failed} passed`);

  // =============================================
  console.log("=== handleProcess (bad mode) ===");
  // =============================================
  const badResult = await handleProcess(config, {
    source: "claro-extension",
    session_id: "s2",
    request_id: "p2",
    mode: "ghost",
    text: "hello",
    project_root: testRoot,
  }, new AbortController().signal);

  assert(badResult.status === 400, "bad mode returns 400");
  console.log(`  handleProcess bad mode: ${passed}/${passed + failed} passed`);

  // =============================================
  console.log("=== handleProcess (default mode — claro, needs LLM) ===");
  // This test calls the real LLM. Skipped in test env without valid API key.
  console.log("  (skipped — requires valid LLM API key)");

  // =============================================
  console.log("=== handleFinalize ===");
  // =============================================
  // Test with existing pending from the noop process above
  const fResult = await handleFinalize(config, {
    source: "claro-extension",
    request_id: "p1",
    modified_text: "你好世界 Hello World (edited)",
    project_root: testRoot,
  }, new AbortController().signal);

  assert(fResult.status === 200, "finalize returns 200");
  assert(fResult.data.final_text === "你好世界 Hello World (edited)", "finalize returns modified text");
  console.log(`  handleFinalize: ${passed}/${passed + failed} passed`);

  // =============================================
  console.log("=== handleFinalize (unknown request) ===");
  // =============================================
  const fUnknown = await handleFinalize(config, {
    source: "claro-extension",
    request_id: "nonexistent",
    modified_text: "some text",
  }, new AbortController().signal);

  assert(fUnknown.status === 200, "unknown finalize returns 200");
  assert(fUnknown.data.final_text === "some text", "echoes text back");
  console.log(`  handleFinalize unknown: ${passed}/${passed + failed} passed`);

  // =============================================
  // Cleanup
  // =============================================
  await rm(testRoot, { recursive: true, force: true });

  // =============================================
  console.log(`\n===== ${passed} passed, ${failed} failed =====`);
  if (failed > 0) process.exit(1);
}

test().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
