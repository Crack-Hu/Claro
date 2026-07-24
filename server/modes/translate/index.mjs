/**
 * translate mode — Translate text to English.
 *
 * Phase 1 (process):  Translate input text to English via LLM.
 * Phase 2 (finalize): Not used (behavior = "passthrough").
 */

export const meta = {
  name: "translate",
  description: "Translate text to English",
  behavior: "passthrough",
};

export async function process(input, ctx) {
  const systemPrompt = await ctx.loadPrompt("translate.md");
  const result = await ctx.callLLM([
    { role: "system", content: systemPrompt },
    { role: "user", content: input.text.trim() },
  ]);

  return {
    content: result.content.trim(),
    tokens: result.tokens,
    model: result.model,
  };
}
