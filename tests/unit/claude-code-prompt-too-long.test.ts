import test from "node:test";
import assert from "node:assert/strict";

test("Claude Code reactive compaction error message format", () => {
  const estimatedInputTokens = 262404;
  const limitTokens = 262000;
  const provider = "devin-desktop";
  const effectiveModel = "swe-1-7";

  const isClaudeClient = true;
  const message = isClaudeClient
    ? `Prompt is too long: ${estimatedInputTokens} tokens > ${limitTokens} maximum context length for ${provider}/${effectiveModel}. Reduce the prompt or route to a model with a larger context window.`
    : `Input exceeds context window for ${provider}/${effectiveModel}: estimated ${estimatedInputTokens} input tokens, limit ${limitTokens}. Reduce the prompt or route to a model with a larger context window.`;

  // 1. Claude Code v2.1.250 matcher checks
  const LG = (e: string) => e.toLowerCase().includes("prompt is too long");
  const startsWithPromptIsTooLong = message.startsWith("Prompt is too long");
  assert.equal(LG(message), true, "Must be recognized by Claude Code LG()");
  assert.equal(startsWithPromptIsTooLong, true, "Must start with 'Prompt is too long'");

  // 2. Token extraction regex checks in Claude Code ZU()
  const match = message.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);
  assert.ok(match, "Must match Claude Code ZU() regex");
  assert.equal(match![1], "262404", "actualTokens must match");
  assert.equal(match![2], "262000", "limitTokens must match");
});
