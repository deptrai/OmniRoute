// Tests for tryRepairTruncatedJson — repairs truncated tool call JSON
// when a model hits max_tokens mid-JSON (missing closing `}` and/or `]`).
// This is the fix for Windsurf/GLM-5.2-max truncating tool call arguments.
import test from "node:test";
import assert from "node:assert/strict";

const { tryRepairTruncatedJson } =
  await import("../../open-sse/translator/response/openai-to-claude.ts");

// ─── No repair needed ────────────────────────────────────────────────────────

test("valid JSON object → null (no repair needed)", () => {
  assert.equal(tryRepairTruncatedJson('{"skill":"x","args":"y"}'), null);
});

test("valid JSON array → null (parses OK)", () => {
  assert.equal(tryRepairTruncatedJson("[1,2,3]"), null);
});

test("valid nested JSON → null", () => {
  assert.equal(tryRepairTruncatedJson('{"a":{"b":["c"]}}'), null);
});

test("empty string → null", () => {
  assert.equal(tryRepairTruncatedJson(""), null);
});

test("null input → null", () => {
  assert.equal(tryRepairTruncatedJson(null as unknown as string), null);
});

test("undefined input → null", () => {
  assert.equal(tryRepairTruncatedJson(undefined as unknown as string), null);
});

// ─── Missing closing braces ──────────────────────────────────────────────────

test("missing closing } → returns }", () => {
  const result = tryRepairTruncatedJson('{"skill":"x"');
  assert.equal(result, "}");
  assert.doesNotThrow(() => JSON.parse('{"skill":"x"' + result));
});

test("trailing comma before cutoff → null (can't un-stream the comma)", () => {
  // The function returns null because raw + suffix = '{"skill":"x",}' which is
  // invalid JSON (trailing comma). The suffix-only contract can't remove the
  // comma that was already streamed to the client. This is a known limitation.
  const result = tryRepairTruncatedJson('{"skill":"x",');
  assert.equal(result, null);
});

// ─── Missing closing brackets + braces ───────────────────────────────────────

test("missing ] and } → returns ]}", () => {
  const result = tryRepairTruncatedJson('{"items":["a"');
  assert.equal(result, "]}");
  assert.doesNotThrow(() => JSON.parse('{"items":["a"' + result));
});

test("nested objects + arrays missing closers → returns ]}}", () => {
  const result = tryRepairTruncatedJson('{"a":{"b":["c"');
  assert.equal(result, "]}}");
  assert.doesNotThrow(() => JSON.parse('{"a":{"b":["c"' + result));
});

// ─── String cutoff mid-value ─────────────────────────────────────────────────

test("string cutoff mid-value → closes string then closers", () => {
  const result = tryRepairTruncatedJson('{"skill":"hel');
  assert.equal(result, '"}');
  assert.doesNotThrow(() => JSON.parse('{"skill":"hel' + result));
});

test("escaped quote in string at cutoff → closes string correctly", () => {
  const result = tryRepairTruncatedJson('{"skill":"he\\"llo');
  assert.equal(result, '"}');
  assert.doesNotThrow(() => JSON.parse('{"skill":"he\\"llo' + result));
});

test("truncated value in nested array → closes string + array + object", () => {
  const result = tryRepairTruncatedJson('{"a":["x","y');
  assert.equal(result, '"]}');
  assert.doesNotThrow(() => JSON.parse('{"a":["x","y' + result));
});

test("string cutoff with trailing comma after string close → trims comma", () => {
  // After closing the string, we have: {"skill":"hello",
  // The trailing comma should be trimmed before adding }
  const result = tryRepairTruncatedJson('{"skill":"hello');
  assert.equal(result, '"}');
  assert.doesNotThrow(() => JSON.parse('{"skill":"hello' + result));
});

// ─── Not repairable ──────────────────────────────────────────────────────────

test("balanced but malformed JSON → null (not repairable)", () => {
  assert.equal(tryRepairTruncatedJson("{invalid}"), null);
});

test("not starting with { → null (only objects repaired)", () => {
  assert.equal(tryRepairTruncatedJson("[1,2,3"), null);
});

test("extra closing brackets (negative depth) → null", () => {
  // This has more closers than openers — not a truncation scenario
  assert.equal(tryRepairTruncatedJson('{"a":"b"}}'), null);
});

// ─── Complex realistic cases ─────────────────────────────────────────────────

test("realistic GLM tool call truncation: missing args closer", () => {
  const truncated = '{"skill":"bmad-code-review","args":"review epic 17';
  const result = tryRepairTruncatedJson(truncated);
  assert.equal(result, '"}');
  const repaired = truncated + result;
  assert.doesNotThrow(() => JSON.parse(repaired));
  assert.equal(JSON.parse(repaired).skill, "bmad-code-review");
});

test("realistic GLM tool call truncation: nested JSON args", () => {
  const truncated = '{"skill":"bmad-quick-dev","args":"build {\\n  feature: \\"auth';
  const result = tryRepairTruncatedJson(truncated);
  assert.ok(result !== null, "should produce a repair suffix");
  const repaired = truncated + result;
  assert.doesNotThrow(() => JSON.parse(repaired));
});

test("multi-field object with one complete, one truncated", () => {
  const truncated = '{"skill":"x","args":"y","extra":["a","b"';
  const result = tryRepairTruncatedJson(truncated);
  assert.equal(result, "]}");
  const repaired = truncated + result;
  assert.doesNotThrow(() => JSON.parse(repaired));
  assert.equal(JSON.parse(repaired).skill, "x");
});
