import test from "node:test";
import assert from "node:assert/strict";

const { openaiResponsesToOpenAIRequest, openaiToOpenAIResponsesRequest } =
  await import("../../open-sse/translator/request/openai-responses.ts");

const userMsg = { role: "user", content: [{ type: "input_text", text: "hi" }] };

// --- Namespace tool flattening ---

test("Responses -> Chat flattens namespace tool groups into individual function tools", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [],
    tools: [{
      type: "namespace", name: "mcp_server",
      tools: [
        { name: "read_file", description: "Read a file", parameters: { type: "object" } },
        { name: "write_file", description: "Write a file", input_schema: { type: "object" } },
        { name: "", description: "skip me" },
      ],
    }],
  }, false, null) as any;

  assert.equal(result.tools.length, 2, "empty-name sub-tools must be filtered");
  assert.deepEqual(result.tools[0], {
    type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
  });
  assert.deepEqual(result.tools[1].function.parameters, { type: "object" }, "input_schema fallback");
});

test("Responses -> Chat flattens namespace with no sub-tools into empty array", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [], tools: [{ type: "namespace", name: "empty_server", tools: [] }],
  }, false, null) as any;
  assert.deepEqual(result.tools, []);
});

// --- web_search tool type preservation ---

test("Responses -> Chat preserves plain and versioned web_search tool types as-is", () => {
  for (const wsType of ["web_search", "web_search_20250305"]) {
    const result = openaiResponsesToOpenAIRequest("gpt-4o", {
      input: [], tools: [{ type: wsType, name: "search" }],
    }, false, null) as any;
    assert.equal(result.tools[0].type, wsType);
  }
});

// --- local_shell -> shell function mapping ---

test("Responses -> Chat maps local_shell tool to a shell function tool", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [], tools: [{ type: "local_shell" }],
  }, false, null) as any;

  assert.equal(result.tools[0].type, "function");
  assert.equal(result.tools[0].function.name, "shell");
  assert.deepEqual(result.tools[0].function.parameters.required, ["command"]);
});

test("Responses -> Chat maps tool_choice local_shell to shell function", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [userMsg], tools: [{ type: "local_shell" }], tool_choice: { type: "local_shell" },
  }, false, null) as any;
  assert.deepEqual(result.tool_choice, { type: "function", function: { name: "shell" } });
});

// --- tool_search and image_generation silent dropping ---

test("Responses -> Chat silently drops tool_search and image_generation built-in tools", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [],
    tools: [
      { type: "tool_search", name: "ts" },
      { type: "image_generation", name: "img" },
      { type: "function", name: "my_func", parameters: { type: "object" } },
    ],
  }, false, null) as any;

  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].function.name, "my_func");
});

// --- Custom tool type normalization -> { input: string } schema ---

test("Responses -> Chat normalizes custom tools to { input: string } schema", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [],
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch", strict: true }],
  }, false, null) as any;

  const fn = result.tools[0].function;
  assert.equal(fn.name, "apply_patch");
  assert.deepEqual(fn.parameters.properties, { input: { type: "string" } });
  assert.deepEqual(fn.parameters.required, ["input"]);
  assert.equal(fn.parameters.additionalProperties, false);
  assert.equal(fn.strict, true);
});

// --- Verbosity normalization ---

test("Responses -> Chat promotes text.verbosity to top-level and drops invalid levels", () => {
  const r1 = openaiResponsesToOpenAIRequest("gpt-5", {
    input: [userMsg], text: { verbosity: "high" },
  }, false, null) as any;
  assert.equal(r1.verbosity, "high");
  assert.equal(r1.text, undefined);

  const r2 = openaiResponsesToOpenAIRequest("gpt-5", {
    input: [userMsg], text: { verbosity: "ultra" },
  }, false, null) as any;
  assert.equal(r2.verbosity, undefined);
  assert.equal(r2.text, undefined);
});

// --- Reasoning effort normalization ---

test("Responses -> Chat promotes reasoning.effort to reasoning_effort (max -> xhigh)", () => {
  const r1 = openaiResponsesToOpenAIRequest("gpt-5", {
    input: [userMsg], reasoning: { effort: "high" },
  }, false, null) as any;
  assert.equal(r1.reasoning_effort, "high");
  assert.equal(r1.reasoning, undefined);

  const r2 = openaiResponsesToOpenAIRequest("gpt-5", {
    input: [userMsg], reasoning: { effort: "max" },
  }, false, null) as any;
  assert.equal(r2.reasoning_effort, "xhigh");
});

// --- Store handling ---

test("Responses -> Chat preserves store via marker when opt-in enabled, strips otherwise", () => {
  const creds = { providerSpecificData: { openaiStoreEnabled: true } };
  const r1 = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [userMsg], store: true,
  }, false, creds) as any;
  assert.equal(r1.store, undefined);
  assert.equal(r1._omnirouteResponsesStore, true);

  const r2 = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [userMsg], store: true,
  }, false, null) as any;
  assert.equal(r2.store, undefined);
  assert.equal(r2._omnirouteResponsesStore, undefined);
});

// --- custom_tool_call and custom_tool_call_output ---

test("Responses -> Chat maps custom_tool_call and unwraps custom_tool_call_output", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [
      { type: "custom_tool_call", call_id: "ctc_1", name: "apply_patch", input: "*** Patch ***" },
      { type: "custom_tool_call_output", call_id: "ctc_1",
        output: JSON.stringify({ output: "success", metadata: { applied: true } }) },
    ],
  }, false, null) as any;

  const assistant = result.messages.find((m: any) => m.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.tool_calls[0].function.name, "apply_patch");
  assert.deepEqual(assistant.tool_calls[0].function.arguments, JSON.stringify({ input: "*** Patch ***" }));

  const toolMsg = result.messages.find((m: any) => m.role === "tool");
  assert.ok(toolMsg);
  assert.equal(toolMsg.content, "success", "JSON { output: '...' } must be unwrapped to plain string");
  assert.equal(toolMsg.tool_call_id, "ctc_1");
});

// --- Edge cases ---

test("Responses -> Chat injects placeholder user message for empty input array", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", { input: [] }, false, null) as any;
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
});

test("Responses -> Chat passes through body unchanged when input is absent", () => {
  const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  assert.equal(openaiResponsesToOpenAIRequest("gpt-4o", body, false, null), body);
});

test("Responses -> Chat handles null model and empty tools gracefully", () => {
  const r1 = openaiResponsesToOpenAIRequest(null, { input: [userMsg] }, false, null) as any;
  assert.equal(r1.messages.length, 1);

  const r2 = openaiResponsesToOpenAIRequest("gpt-4o", { input: [userMsg], tools: [] }, false, null) as any;
  assert.ok(Array.isArray(r2.tools));
  assert.equal(r2.tools.length, 0);
});

test("Responses -> Chat skips function_call with empty name or empty call_id", () => {
  const result = openaiResponsesToOpenAIRequest("gpt-4o", {
    input: [
      { type: "function_call", call_id: "c1", name: "", arguments: "{}" },
      { type: "function_call", call_id: "", name: "orphan_fn", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "real_fn", arguments: "{}" },
    ],
  }, false, null) as any;

  const assistant = result.messages.find((m: any) => m.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].function.name, "real_fn");
});

// --- Chat -> Responses: verbosity reverse mapping ---

test("Chat -> Responses maps top-level verbosity to text.verbosity and drops invalid", () => {
  const r1 = openaiToOpenAIResponsesRequest("gpt-5", {
    messages: [{ role: "user", content: "hi" }], verbosity: "medium",
  }, false, null) as any;
  assert.equal(r1.text.verbosity, "medium");

  const r2 = openaiToOpenAIResponsesRequest("gpt-5", {
    messages: [{ role: "user", content: "hi" }], verbosity: "extreme",
  }, false, null) as any;
  assert.equal(r2.text, undefined);
});
