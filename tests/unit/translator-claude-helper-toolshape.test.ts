// Unit tests for prepareClaudeRequest() tool-shape and cache_control logic.
// Covers: cache_control stripping/re-injection, defer_loading interaction,
// passthrough mode, tool normalization edge cases, and empty/missing tool
// handling. Does NOT duplicate translator-tools-anthropic-shape.test.ts which
// already covers basic OpenAI→Anthropic fold and web_search_20250305 stripping.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";

// Minimal body with messages so the tool-normalization pass (gated on
// body.messages being a non-empty array) actually runs.
function baseBody(tools: any[]): any {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 256,
    tools,
  };
}

// ──────────────── cache_control stripping + re-injection ────────────────

describe("prepareClaudeRequest — cache_control on tools (preserveCacheControl=false)", () => {
  test("strips all cache_control and re-injects only on last tool (claude)", () => {
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: {}, cache_control: { type: "ephemeral" } },
      { name: "tool_b", description: "B", input_schema: {}, cache_control: { type: "ephemeral" } },
      { name: "tool_c", description: "C", input_schema: {}, cache_control: { type: "ephemeral" } },
    ]);
    const result = prepareClaudeRequest(body, "claude");
    const tools = result.tools!;
    assert.equal(tools.length, 3);
    assert.equal(tools[0].cache_control, undefined, "first tool cache_control stripped");
    assert.equal(tools[1].cache_control, undefined, "middle tool cache_control stripped");
    assert.deepEqual(tools[2].cache_control, { type: "ephemeral", ttl: "1h" }, "last tool gets re-injected");
  });

  test("re-injects on last NON-deferred tool when the final tool is deferred", () => {
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: {} },
      { name: "tool_b", description: "B", input_schema: {} },
      { name: "tool_c", description: "C", input_schema: {}, defer_loading: true },
    ]);
    const result = prepareClaudeRequest(body, "claude");
    const tools = result.tools!;
    assert.equal(tools[0].cache_control, undefined);
    assert.deepEqual(tools[1].cache_control, { type: "ephemeral", ttl: "1h" }, "second-to-last non-deferred gets it");
    assert.equal(tools[2].cache_control, undefined, "deferred tool must NOT get cache_control");
    assert.equal(tools[2].defer_loading, true, "defer_loading field preserved");
  });

  test("all tools deferred → no cache_control re-injected anywhere", () => {
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: {}, defer_loading: true, cache_control: { type: "ephemeral" } },
      { name: "tool_b", description: "B", input_schema: {}, defer_loading: true },
    ]);
    const result = prepareClaudeRequest(body, "claude");
    const tools = result.tools!;
    assert.equal(tools[0].cache_control, undefined, "stripped, not re-injected (deferred)");
    assert.equal(tools[1].cache_control, undefined, "stripped, not re-injected (deferred)");
  });

  test("single tool (non-deferred) gets cache_control re-injected", () => {
    const body = baseBody([
      { name: "only_tool", description: "only", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "claude");
    assert.deepEqual(result.tools![0].cache_control, { type: "ephemeral", ttl: "1h" });
  });

  test("non-Anthropic provider (minimax) — cache_control stripped, NOT re-injected", () => {
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: {}, cache_control: { type: "ephemeral" } },
      { name: "tool_b", description: "B", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "minimax");
    const tools = result.tools!;
    assert.equal(tools[0].cache_control, undefined, "cache_control stripped for minimax");
    assert.equal(tools[1].cache_control, undefined, "no re-inject — minimax does not support prompt caching");
  });

  test("anthropic-compatible-* provider — cache_control re-injected on last non-deferred", () => {
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: {} },
      { name: "tool_b", description: "B", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "anthropic-compatible-xyz");
    const tools = result.tools!;
    assert.equal(tools[0].cache_control, undefined);
    assert.deepEqual(tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
  });
});

// ──────────────── passthrough mode (preserveCacheControl=true) ────────────────

describe("prepareClaudeRequest — passthrough mode (preserveCacheControl=true)", () => {
  test("preserves existing client cache_control markers on tools", () => {
    const cc = { type: "ephemeral", ttl: "5m" };
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: {}, cache_control: cc },
      { name: "tool_b", description: "B", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "claude", true);
    const tools = result.tools!;
    assert.deepEqual(tools[0].cache_control, cc, "client cache_control preserved verbatim");
    assert.equal(tools[1].cache_control, undefined);
  });

  test("does NOT auto-inject cache_control on last tool in passthrough", () => {
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: {} },
      { name: "tool_b", description: "B", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "claude", true);
    const tools = result.tools!;
    assert.equal(tools[0].cache_control, undefined);
    assert.equal(tools[1].cache_control, undefined, "no auto-inject in passthrough");
  });

  test("passthrough still normalizes tool shape for non-Anthropic provider", () => {
    const body = baseBody([
      { type: "function", function: { name: "fn", description: "d", parameters: { type: "object" } } },
    ]);
    const result = prepareClaudeRequest(body, "minimax", true);
    const tools = result.tools!;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "fn");
    assert.equal(tools[0].type, undefined, "type stripped even in passthrough");
    assert.deepEqual(tools[0].input_schema, { type: "object" });
  });
});

// ──────────────── tool shape normalization edge cases ────────────────

describe("prepareClaudeRequest — tool shape normalization edge cases", () => {
  test("OpenAI-shape tool with function wrapper drops cache_control during fold", () => {
    // When folding function.{...} → {name, description, input_schema}, the
    // top-level cache_control is NOT carried over (only function.* fields are).
    const body = baseBody([
      {
        type: "function",
        function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
        cache_control: { type: "ephemeral" },
      },
    ]);
    const result = prepareClaudeRequest(body, "minimax");
    const tools = result.tools!;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "get_weather");
    assert.equal(tools[0].type, undefined);
    assert.equal(tools[0].function, undefined);
    assert.equal(tools[0].cache_control, undefined, "cache_control dropped during function fold");
    assert.deepEqual(tools[0].input_schema, { type: "object" });
  });

  test("Anthropic-native tool (no type, no function) — extra fields preserved, type stripped", () => {
    const body = baseBody([
      { name: "tool_a", description: "A", input_schema: { type: "object" }, custom_field: "keep" },
    ]);
    const result = prepareClaudeRequest(body, "minimax");
    const tools = result.tools!;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "tool_a");
    assert.equal(tools[0].type, undefined);
    assert.equal(tools[0].custom_field, "keep", "extra fields preserved via rest spread");
    assert.deepEqual(tools[0].input_schema, { type: "object" });
  });

  test("type:'function' with no function wrapper — strips type, keeps rest", () => {
    const body = baseBody([
      { type: "function", name: "bare_fn", description: "bare", input_schema: { type: "object" } },
    ]);
    const result = prepareClaudeRequest(body, "minimax");
    const tools = result.tools!;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, undefined, "stray 'function' type stripped");
    assert.equal(tools[0].name, "bare_fn");
    assert.deepEqual(tools[0].input_schema, { type: "object" });
  });

  test("multiple OpenAI-shape tools all normalized for non-Anthropic provider", () => {
    const body = baseBody([
      { type: "function", function: { name: "fn1", description: "d1", parameters: { type: "object" } } },
      { type: "function", function: { name: "fn2", description: "d2", parameters: { type: "object" } } },
    ]);
    const result = prepareClaudeRequest(body, "kimi-coding");
    const tools = result.tools!;
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "fn1");
    assert.equal(tools[0].type, undefined);
    assert.deepEqual(tools[0].input_schema, { type: "object" });
    assert.equal(tools[1].name, "fn2");
    assert.equal(tools[1].type, undefined);
    assert.deepEqual(tools[1].input_schema, { type: "object" });
  });

  test("defer_loading field preserved through normalization for Anthropic-native shape", () => {
    const body = baseBody([
      { name: "lazy_tool", description: "lazy", input_schema: {}, defer_loading: true },
      { name: "eager_tool", description: "eager", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "anthropic-compatible-x");
    const tools = result.tools!;
    assert.equal(tools[0].defer_loading, true, "defer_loading preserved via rest spread");
    assert.equal(tools[1].defer_loading, undefined);
    // cache_control goes to last non-deferred = eager_tool
    assert.equal(tools[0].cache_control, undefined);
    assert.deepEqual(tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
  });

  test("first-party claude — does NOT normalize tool shape (keeps type field)", () => {
    const body = baseBody([
      { type: "web_search_20250305", name: "web_search" },
      { name: "regular", description: "r", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "claude");
    const tools = result.tools!;
    assert.equal(tools.length, 2);
    assert.equal(tools[0].type, "web_search_20250305", "built-in type preserved for claude");
    assert.equal(tools[1].type, undefined);
  });
});

// ──────────────── edge cases: empty / null / missing name ────────────────

describe("prepareClaudeRequest — tool edge cases", () => {
  test("empty tools array — no crash, stays empty", () => {
    const body = baseBody([]);
    const result = prepareClaudeRequest(body, "claude");
    assert.ok(Array.isArray(result.tools));
    assert.equal(result.tools!.length, 0);
  });

  test("missing tools field — no crash, stays undefined", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 256,
    };
    const result = prepareClaudeRequest(body as any, "claude");
    assert.equal(result.tools, undefined);
  });

  test("tools with missing/empty/whitespace name are filtered out (claude)", () => {
    const body = baseBody([
      { description: "no name field", input_schema: {} },
      { name: "", description: "empty name", input_schema: {} },
      { name: "   ", description: "whitespace name", input_schema: {} },
      { name: "valid_tool", description: "valid", input_schema: {} },
    ]);
    const result = prepareClaudeRequest(body, "claude");
    const tools = result.tools!;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "valid_tool");
  });

  test("tools with empty name filtered out after function fold (non-Anthropic)", () => {
    const body = baseBody([
      { type: "function", function: { name: "", description: "empty", parameters: {} } },
      { type: "function", function: { name: "valid", description: "ok", parameters: {} } },
    ]);
    const result = prepareClaudeRequest(body, "minimax");
    const tools = result.tools!;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "valid");
  });

  test("null provider — tools normalized (treated as non-Anthropic)", () => {
    const body = baseBody([
      { type: "function", function: { name: "fn", description: "d", parameters: {} } },
      { type: "web_search_20250305", name: "web_search" },
    ]);
    const result = prepareClaudeRequest(body, null);
    const tools = result.tools!;
    assert.equal(tools.length, 1, "web_search stripped when provider is null");
    assert.equal(tools[0].name, "fn");
    assert.equal(tools[0].type, undefined);
  });
});
