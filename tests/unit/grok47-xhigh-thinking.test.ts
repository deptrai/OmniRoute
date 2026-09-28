import test from "node:test";
import assert from "node:assert/strict";

const { translateNonStreamingResponse } =
  await import("../../open-sse/handlers/responseTranslator.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { resolveSuffixEffortOverride } =
  await import("../../open-sse/services/defaultReasoningEffort.ts");

function grokResponsesBody(summaryParts: Array<{ type: string; text: string }>) {
  return {
    object: "response",
    id: "resp_1",
    model: "grok-4.7-build",
    output: [
      {
        id: "rs_f8b221e3-5ad0-9a24-a69a-09f7669e0d46",
        type: "reasoning",
        status: "completed",
        summary: summaryParts,
        encrypted_content: "ENCRYPTED-BLOB",
      },
      {
        id: "msg_f8b221e3-5ad0-9a24-a69a-09f7669e0d46",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "**391**" }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 94 },
    },
  };
}

test("Responses reasoning summary_text surfaces as Claude thinking block (non-streaming)", () => {
  const out = translateNonStreamingResponse(
    grokResponsesBody([
      { type: "summary_text", text: "The user is asking a simple math question." },
    ]),
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE
  ) as Record<string, unknown>;
  const content = out.content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(content), "expected Claude content blocks");
  const thinking = content.find((b) => b.type === "thinking") as
    Record<string, unknown> | undefined;
  assert.ok(thinking, "expected a thinking block from the reasoning summary");
  assert.match(
    String(thinking.thinking),
    /simple math question/,
    "thinking block must carry the upstream summary text"
  );
});

test("Encrypted-only reasoning (no summary) still emits no thinking block", () => {
  const out = translateNonStreamingResponse(
    grokResponsesBody([]),
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE
  ) as Record<string, unknown>;
  const content = out.content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(content), "expected Claude content blocks");
  assert.equal(
    content.some((b) => b.type === "thinking"),
    false,
    "must not fabricate thinking from encrypted-only reasoning"
  );
});

test("explicit -xhigh model suffix overrides translator-derived effort", () => {
  assert.equal(resolveSuffixEffortOverride("xhigh", undefined), "xhigh");
  assert.equal(resolveSuffixEffortOverride("xhigh", null), "xhigh");
});

test("explicit client output_config.effort still wins over the model suffix", () => {
  assert.equal(resolveSuffixEffortOverride("xhigh", "high"), null);
  assert.equal(resolveSuffixEffortOverride("xhigh", "medium"), null);
});

test("blank client effort counts as absent, suffix still applies", () => {
  assert.equal(resolveSuffixEffortOverride("xhigh", "  "), "xhigh");
});

test("no suffix effort means no override", () => {
  assert.equal(resolveSuffixEffortOverride(null, undefined), null);
  assert.equal(resolveSuffixEffortOverride("", undefined), null);
  assert.equal(resolveSuffixEffortOverride(undefined, undefined), null);
});
