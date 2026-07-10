import test from "node:test";
import assert from "node:assert/strict";

const gemini = await import("../../open-sse/translator/helpers/geminiHelper.ts");

const {
  GEMINI_UNSUPPORTED_SCHEMA_KEYS,
  UNSUPPORTED_SCHEMA_CONSTRAINTS,
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  cleanJSONSchemaForAntigravity,
} = gemini;

// ── Constants ────────────────────────────────────────────────────────────────

test("DEFAULT_SAFETY_SETTINGS lists 5 categories all set to OFF", () => {
  assert.equal(DEFAULT_SAFETY_SETTINGS.length, 5);
  for (const s of DEFAULT_SAFETY_SETTINGS) {
    assert.equal(s.threshold, "OFF");
  }
  assert.ok(DEFAULT_SAFETY_SETTINGS.some((s) => s.category === "HARM_CATEGORY_HATE_SPEECH"));
});

test("UNSUPPORTED_SCHEMA_CONSTRAINTS mirrors the Set contents", () => {
  assert.equal(UNSUPPORTED_SCHEMA_CONSTRAINTS.length, GEMINI_UNSUPPORTED_SCHEMA_KEYS.size);
  for (const k of UNSUPPORTED_SCHEMA_CONSTRAINTS) {
    assert.ok(GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k), `${k} should be in set`);
  }
});

test("pattern is intentionally NOT in unsupported keys (glob/grep tools depend on it)", () => {
  assert.equal(GEMINI_UNSUPPORTED_SCHEMA_KEYS.has("pattern"), false);
});

// ── convertOpenAIContentToParts ───────────────────────────────────────────────

test("convertOpenAIContentToParts: string → single text part", () => {
  assert.deepEqual(convertOpenAIContentToParts("hi"), [{ text: "hi" }]);
});

test("convertOpenAIContentToParts: empty/null/number → no parts", () => {
  assert.deepEqual(convertOpenAIContentToParts(null), []);
  assert.deepEqual(convertOpenAIContentToParts(undefined), []);
  assert.deepEqual(convertOpenAIContentToParts(42), []);
});

test("convertOpenAIContentToParts: text array items become text parts", () => {
  assert.deepEqual(
    convertOpenAIContentToParts([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    [{ text: "a" }, { text: "b" }]
  );
});

test("convertOpenAIContentToParts: input_audio strips data URI prefix and normalizes mime", () => {
  const parts = convertOpenAIContentToParts([
    { type: "input_audio", input_audio: { format: "mp3", data: "data:audio/mp3;base64,AAAA" } },
  ]);
  assert.equal(parts[0].inlineData.mimeType, "audio/mpeg");
  assert.equal(parts[0].inlineData.data, "AAAA");
});

test("convertOpenAIContentToParts: input_audio with empty format defaults to wav", () => {
  const parts = convertOpenAIContentToParts([
    { type: "input_audio", input_audio: { data: "BBBB" } },
  ]);
  assert.equal(parts[0].inlineData.mimeType, "audio/wav");
});

test("convertOpenAIContentToParts: image_url data URI is split into mimeType + data", () => {
  const parts = convertOpenAIContentToParts([
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
  ]);
  assert.deepEqual(parts[0].inlineData, { mimeType: "image/png", data: "iVBOR" });
});

test("convertOpenAIContentToParts: http(s) image_url becomes fileData with image/* mime", () => {
  const parts = convertOpenAIContentToParts([
    { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
  ]);
  assert.deepEqual(parts[0].fileData, { fileUri: "https://example.com/cat.png", mimeType: "image/*" });
});

test("convertOpenAIContentToParts: Claude-style base64 source block", () => {
  const parts = convertOpenAIContentToParts([
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "JJJJ" } },
  ]);
  assert.deepEqual(parts[0].inlineData, { mimeType: "image/jpeg", data: "JJJJ" });
});

test("convertOpenAIContentToParts: inline_data passthrough (Cherry Studio shape)", () => {
  const parts = convertOpenAIContentToParts([
    { type: "file", inline_data: { mime_type: "application/pdf", data: "data:application/pdf;base64,PDF" } },
  ]);
  assert.deepEqual(parts[0].inlineData, { mimeType: "application/pdf", data: "PDF" });
});

test("convertOpenAIContentToParts: raw data string with mime_type fallback to pdf", () => {
  const parts = convertOpenAIContentToParts([{ type: "file", data: "RAWBASE64" }]);
  assert.deepEqual(parts[0].inlineData, { mimeType: "application/pdf", data: "RAWBASE64" });
});

test("convertOpenAIContentToParts: audio_url data URI", () => {
  const parts = convertOpenAIContentToParts([
    { type: "audio_url", audio_url: { url: "data:audio/wav;base64,WAV" } },
  ]);
  assert.deepEqual(parts[0].inlineData, { mimeType: "audio/wav", data: "WAV" });
});

// ── extractTextContent ────────────────────────────────────────────────────────

test("extractTextContent: concatenates only text blocks from array", () => {
  assert.equal(
    extractTextContent([
      { type: "text", text: "Hello" },
      { type: "image_url", image_url: { url: "x" } },
      { type: "text", text: " World" },
    ]),
    "Hello World"
  );
});

test("extractTextContent: non-text array items contribute empty string", () => {
  assert.equal(extractTextContent([{ type: "image", url: "x" }]), "");
});

// ── tryParseJSON ───────────────────────────────────────────────────────────────

test("tryParseJSON: non-string passthrough (numbers, null)", () => {
  assert.equal(tryParseJSON(0), 0);
  assert.equal(tryParseJSON(null), null);
  assert.deepEqual(tryParseJSON({ a: 1 }), { a: 1 });
});

// ── generateRequestId / generateSessionId ─────────────────────────────────────

test("generateRequestId is prefixed with agent-", () => {
  assert.match(generateRequestId(), /^agent-[0-9a-f-]{36}$/);
});

test("generateSessionId is a negative numeric string", () => {
  assert.match(generateSessionId(), /^-\d+$/);
});

// ── cleanJSONSchemaForAntigravity ─────────────────────────────────────────────

test("cleanJSONSchemaForAntigravity: null/primitive passthrough", () => {
  assert.equal(cleanJSONSchemaForAntigravity(null), null);
  assert.equal(cleanJSONSchemaForAntigravity("x"), "x");
  assert.equal(cleanJSONSchemaForAntigravity(5), 5);
});

test("cleanJSONSchemaForAntigravity: const → enum with single value", () => {
  const out = cleanJSONSchemaForAntigravity({ type: "string", const: "fixed" });
  assert.deepEqual(out.enum, ["fixed"]);
  assert.equal(out.const, undefined);
});

test("cleanJSONSchemaForAntigravity: enum values coerced to strings", () => {
  const out = cleanJSONSchemaForAntigravity({ enum: [1, 2, 3] });
  assert.deepEqual(out.enum, ["1", "2", "3"]);
  assert.equal(out.type, "string");
});

test("cleanJSONSchemaForAntigravity: enum on integer type is removed", () => {
  const out = cleanJSONSchemaForAntigravity({ type: "integer", enum: [1, 2] });
  assert.equal(out.enum, undefined);
  assert.equal(out.type, "integer");
});

test("cleanJSONSchemaForAntigravity: allOf merges properties + required", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    allOf: [
      { properties: { a: { type: "string" } }, required: ["a"] },
      { properties: { b: { type: "number" } }, required: ["b"] },
    ],
  });
  assert.ok(out.properties.a);
  assert.ok(out.properties.b);
  assert.deepEqual(out.required, ["a", "b"]);
  assert.equal(out.allOf, undefined);
});

test("cleanJSONSchemaForAntigravity: anyOf selects non-null best schema (object wins)", () => {
  const out = cleanJSONSchemaForAntigravity({
    anyOf: [
      { type: "null" },
      { type: "object", properties: { x: { type: "string" } } },
      { type: "string" },
    ],
  });
  assert.equal(out.type, "object");
  assert.ok(out.properties.x);
  assert.equal(out.anyOf, undefined);
});

test("cleanJSONSchemaForAntigravity: oneOf selects non-null schema", () => {
  const out = cleanJSONSchemaForAntigravity({ oneOf: [{ type: "null" }, { type: "string" }] });
  assert.equal(out.type, "string");
  assert.equal(out.oneOf, undefined);
});

test("cleanJSONSchemaForAntigravity: type array flattens to first non-null", () => {
  const out = cleanJSONSchemaForAntigravity({ type: ["string", "null"] });
  assert.equal(out.type, "string");
});

test("cleanJSONSchemaForAntigravity: type array of only null defaults to string", () => {
  const out = cleanJSONSchemaForAntigravity({ type: ["null"] });
  assert.equal(out.type, "string");
});

test("cleanJSONSchemaForAntigravity: additionalProperties is stripped", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  });
  assert.equal(out.additionalProperties, undefined);
});

test("cleanJSONSchemaForAntigravity: unsupported keywords removed (minLength, format, title)", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    title: "MyObj",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 10, format: "email" },
    },
  });
  assert.equal(out.title, undefined);
  assert.equal(out.properties.name.minLength, undefined);
  assert.equal(out.properties.name.maxLength, undefined);
  assert.equal(out.properties.name.format, undefined);
});

test("cleanJSONSchemaForAntigravity: pattern is preserved on string properties", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { glob: { type: "string", pattern: ".*\\.ts$" } },
  });
  assert.equal(out.properties.glob.pattern, ".*\\.ts$");
});

test("cleanJSONSchemaForAntigravity: property named 'pattern' is preserved (not treated as keyword)", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { pattern: { type: "string" } },
  });
  assert.ok(out.properties.pattern, "property named 'pattern' must survive");
});

test("cleanJSONSchemaForAntigravity: x- custom keys removed", () => {
  const out = cleanJSONSchemaForAntigravity({ type: "string", "x-custom": 1 });
  assert.equal(out["x-custom"], undefined);
});

test("cleanJSONSchemaForAntigravity: required entries without matching property are dropped", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a", "ghost"],
  });
  assert.deepEqual(out.required, ["a"]);
});

test("cleanJSONSchemaForAntigravity: required removed entirely when all entries invalid", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["ghost"],
  });
  assert.equal(out.required, undefined);
});

test("cleanJSONSchemaForAntigravity: empty object schema gets placeholder reason property", () => {
  const out = cleanJSONSchemaForAntigravity({ type: "object" });
  assert.ok(out.properties.reason);
  assert.deepEqual(out.required, ["reason"]);
});

test("cleanJSONSchemaForAntigravity: $ref to $defs is inlined", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    $defs: { addr: { type: "object", properties: { city: { type: "string" } } } },
    properties: { home: { $ref: "#/$defs/addr" } },
  });
  assert.ok(out.properties.home.properties.city, "$ref should be inlined");
  assert.equal(out.properties.home.$ref, undefined);
});

test("cleanJSONSchemaForAntigravity: recursive $ref does not infinite-loop", () => {
  const out = cleanJSONSchemaForAntigravity({
    type: "object",
    $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
    properties: { root: { $ref: "#/$defs/node" } },
  });
  assert.ok(out.properties.root.properties.next, "recursive ref resolved without crash");
});
