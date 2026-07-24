/**
 * clean mode — Oral text cleaning for Claro.
 *
 * Phase 1 (process):  Remove filler words, merge fragments, add punctuation.
 * Phase 2 (finalize): Compare user edits to original, extract term mappings
 *                      via diff LLM, and update the project dictionary.
 */

import { loadDictionary, saveDictionary } from "../../lib/dict.mjs";

// ---------------------------------------------------------------------------
// Meta — read by the server framework to decide two-phase behaviour
// ---------------------------------------------------------------------------

export const meta = {
  name: "claro",
  description: "Clean oral/colloquial text to polished written style",
  behavior: "review",          // "review" = two-phase (show result → user edits → finalize with diff learning)
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDictBlock(dict) {
  const entries = Object.entries(dict);
  if (entries.length === 0) return "(暂无)";
  let block = "";
  for (const [from, to] of entries) {
    block += `- "${from}" → "${to}"\n`;
  }
  return block;
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
      /^[\\"'\u201c\u201d\u2018\u2019]?(.+?)[\\"'\u201c\u201d\u2018\u2019]?\s*(?:->|\u2192|=>|:)\s*[\\"'\u201c\u201d\u2018\u2019]?(.+?)[\\"'\u201c\u201d\u2018\u2019]?$/,
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
// Phase 1 — Process input text
// ---------------------------------------------------------------------------

export async function process(input, ctx) {
  const systemPrompt = await ctx.loadPrompt("clean.md");
  const dict = await loadDictionary(ctx.projectRoot);
  const dictBlock = buildDictBlock(dict);
  const rendered = systemPrompt.replace("{{DICT}}", dictBlock);

  const result = await ctx.callLLM([
    { role: "system", content: rendered },
    { role: "user", content: input.text.trim() },
  ]);

  return {
    content: result.content.trim(),
    tokens: result.tokens,
    model: result.model,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — Finalize after user edit (diff learning)
// ---------------------------------------------------------------------------

export async function finalize(input, ctx) {
  const { original, modified } = input;

  // No changes — nothing to learn
  if (original.trim() === modified.trim()) {
    return { final_text: modified, suggestions: [] };
  }

  // Run diff LLM to extract terminology changes
  const diffPrompt = await ctx.loadPrompt("diff.md");
  const result = await ctx.callLLM(
    [
      { role: "system", content: diffPrompt },
      { role: "user", content: `原始版本（模型清洁后）：\n${original}\n\n用户修改后的版本：\n${modified}` },
    ],
    "finalize",
  );

  const suggestions = parseDiffOutput(result.content);

  // Persist learned terms
  if (suggestions.length > 0) {
    const dict = await loadDictionary(ctx.projectRoot);
    let updated = false;
    for (const { old_word, new_word } of suggestions) {
      if (old_word && new_word && old_word !== new_word) {
        dict[old_word] = new_word;
        updated = true;
      }
    }
    if (updated) {
      await saveDictionary(ctx.projectRoot, dict);
    }
  }

  return { final_text: modified, suggestions };
}
