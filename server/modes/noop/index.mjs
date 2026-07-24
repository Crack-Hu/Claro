/**
 * noop mode — Identity pass-through for testing the server pipeline.
 *
 * Phase 1 (process): Return input unchanged.
 * Phase 2 (finalize): Not used (behavior = "passthrough").
 */

export const meta = {
  name: "noop",
  description: "Pass-through — returns input unchanged (for testing)",
  behavior: "passthrough",
};

export async function process(input, _ctx) {
  return {
    content: input.text,
    tokens: 0,
    model: "noop",
  };
}
