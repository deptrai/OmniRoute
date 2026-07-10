import test from "node:test";
import assert from "node:assert/strict";

const { VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES, filterToOpenAIFormat } =
  await import("../../open-sse/translator/helpers/openaiHelper.ts");

// ── Constants ────────────────────────────────────────────────────────────────

test("VALID_OPENAI_CONTENT_TYPES includes text, image_url, input_audio, audio_url", () => {
  assert.ok(VALID_OPENAI_CONTENT_TYPES.includes("text"));
  assert.ok(VALID_OPENAI_CONTENT_TYPES.includes("image_url"));
  assert.ok(VALID_OPENAI_CONTENT_TYPES.includes("input_audio"));
  assert.ok(VALID_OPENAI_CONTENT_TYPES.includes("audio_url"));
});

test("VALID_OPENAI_MESSAGE_TYPES includes tool_calls and tool_result", () => {
  assert.ok(VALID_OPENAI_MESSAGE_TYPES.includes("tool_calls"));
  assert.ok(VALID_OPENAI_MESSAGE_TYPES.includes("tool_result"));
});

// ── filterToOpenAIFormat: edge cases ──────────────────────────────────────────

test("filterToOpenAIFormat: body without messages array returns unchanged", () => {
  const body = { model: "x" };
  assert.equal(filterToOpenAIFormat(body), body);
  const empty = {};
  assert.equal(filterToOpenAIFormat(empty), empty);
});

test("filterToOpenAIFormat: developer role normalized to system", () => {
  const body = { messages: [{ role: "developer", content: "be helpful" }] };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "be helpful");
});

test("filterToOpenAIFormat: tool messages kept as-is", () => {
  const body = { messages: [{ role: "tool", tool_call_id: "c1", content: "result" }] };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].role, "tool");
  assert.equal(out.messages[0].content, "result");
});

test("filterToOpenAIFormat: assistant with tool_calls strips reasoning_content by default", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        reasoning_content: "thinking...",
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].reasoning_content, undefined);
  assert.ok(out.messages[0].tool_calls);
});

test("filterToOpenAIFormat: preserveReasoningContent keeps reasoning_content", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        reasoning_content: "thinking...",
      },
    ],
  };
  const out = filterToOpenAIFormat(body, { preserveReasoningContent: true });
  assert.equal(out.messages[0].reasoning_content, "thinking...");
});

test("filterToOpenAIFormat: thinking block becomes reasoning_content on assistant", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan it" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].reasoning_content, "plan it");
  assert.equal(out.messages[0].content[0].text, "answer");
});

test("filterToOpenAIFormat: redacted_thinking blocks are dropped", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "redacted_thinking" },
          { type: "text", text: "hi" },
        ],
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].content.length, 1);
  assert.equal(out.messages[0].content[0].text, "hi");
});

test("filterToOpenAIFormat: empty text blocks are skipped", () => {
  const body = {
    messages: [{ role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "x" }] }],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].content.length, 1);
  assert.equal(out.messages[0].content[0].text, "x");
});

test("filterToOpenAIFormat: tool_result block becomes text with id label", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].content[0].type, "text");
  assert.match(out.messages[0].content[0].text, /\[Tool Result: tu_1\]/);
  assert.match(out.messages[0].content[0].text, /ok/);
});

test("filterToOpenAIFormat: tool_result with array content joins text blocks", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
          },
        ],
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.match(out.messages[0].content[0].text, /line1\nline2/);
});

test("filterToOpenAIFormat: file/document without url/data inlines content as text", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "file", file: { name: "notes.txt", content: "hello file" } }],
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].content[0].type, "text");
  assert.match(out.messages[0].content[0].text, /\[notes.txt\]/);
  assert.match(out.messages[0].content[0].text, /hello file/);
});

test("filterToOpenAIFormat: all-empty content gets a single empty text block", () => {
  const body = { messages: [{ role: "user", content: [{ type: "redacted_thinking" }] }] };
  const out = filterToOpenAIFormat(body);
  // user message with only empty text is filtered out entirely
  assert.equal(out.messages.length, 0);
});

test("filterToOpenAIFormat: empty tools array is deleted", () => {
  const body = { messages: [{ role: "user", content: "hi" }], tools: [] };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.tools, undefined);
});

test("filterToOpenAIFormat: metadata, anthropic_version, client_metadata stripped", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    metadata: { x: 1 },
    anthropic_version: "2023",
    client_metadata: { y: 2 },
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.metadata, undefined);
  assert.equal(out.anthropic_version, undefined);
  assert.equal(out.client_metadata, undefined);
});

test("filterToOpenAIFormat: max_output_tokens maps to max_tokens when absent", () => {
  const body = { messages: [{ role: "user", content: "hi" }], max_output_tokens: 100 };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.max_tokens, 100);
  assert.equal(out.max_output_tokens, undefined);
});

test("filterToOpenAIFormat: max_output_tokens does not overwrite existing max_tokens", () => {
  const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 50, max_output_tokens: 100 };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.max_tokens, 50);
  assert.equal(out.max_output_tokens, undefined);
});

test("filterToOpenAIFormat: Claude tools normalized to OpenAI function format", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "search", description: "search web", input_schema: { type: "object" } }],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "search");
  assert.equal(out.tools[0].function.description, "search web");
  assert.deepEqual(out.tools[0].function.parameters, { type: "object" });
});

test("filterToOpenAIFormat: Claude tool description coerced to string", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", input_schema: { type: "object" } }],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.tools[0].function.description, "");
});

test("filterToOpenAIFormat: Gemini functionDeclarations expanded to multiple tools", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        functionDeclarations: [
          { name: "a", description: "a desc", parameters: { type: "object" } },
          { name: "b", description: "b desc", parameters: { type: "object" } },
        ],
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.tools.length, 2);
  assert.equal(out.tools[0].function.name, "a");
  assert.equal(out.tools[1].function.name, "b");
});

test("filterToOpenAIFormat: already-OpenAI tools pass through", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: {} } }],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "f");
});

test("filterToOpenAIFormat: Claude tool_choice {type:auto} → 'auto'", () => {
  const body = { messages: [{ role: "user", content: "hi" }], tool_choice: { type: "auto" } };
  assert.equal(filterToOpenAIFormat(body).tool_choice, "auto");
});

test("filterToOpenAIFormat: Claude tool_choice {type:any} → 'required'", () => {
  const body = { messages: [{ role: "user", content: "hi" }], tool_choice: { type: "any" } };
  assert.equal(filterToOpenAIFormat(body).tool_choice, "required");
});

test("filterToOpenAIFormat: Claude tool_choice {type:tool,name} → function choice", () => {
  const body = { messages: [{ role: "user", content: "hi" }], tool_choice: { type: "tool", name: "myTool" } };
  const out = filterToOpenAIFormat(body);
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "myTool" } });
});

test("filterToOpenAIFormat: preserveCacheControl keeps cache_control on blocks", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" }, signature: "sig" }],
      },
    ],
  };
  const out = filterToOpenAIFormat(body, { preserveCacheControl: true });
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(out.messages[0].content[0].signature, undefined);
});

test("filterToOpenAIFormat: default strips cache_control and signature", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" }, signature: "sig" }],
      },
    ],
  };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages[0].content[0].cache_control, undefined);
  assert.equal(out.messages[0].content[0].signature, undefined);
});

test("filterToOpenAIFormat: empty user message (whitespace string) filtered out", () => {
  const body = { messages: [{ role: "user", content: "   " }] };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages.length, 0);
});

test("filterToOpenAIFormat: string-content message preserved", () => {
  const body = { messages: [{ role: "user", content: "hello" }] };
  const out = filterToOpenAIFormat(body);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].content, "hello");
});
