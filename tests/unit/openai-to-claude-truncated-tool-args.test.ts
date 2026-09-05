/**
 * Regression test: when the upstream stream ends mid-tool-call, the accumulated
 * arguments buffer is unparseable JSON. Previously the translator closed the
 * tool_use block normally, handing the client a truncated partial_json — Claude
 * Code then raised InputValidationError and the model retried with hallucinated
 * stub args like {"command": "<prefix>", "len": <bytes>}. Now the finish path
 * emits a terminal `error` event instead so the turn is retried, never executed.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { openaiToClaudeResponse } =
  await import("../../open-sse/translator/response/openai-to-claude.ts");

function createState(toolSchemas = null) {
  return {
    toolCalls: new Map(),
    ...(toolSchemas ? { toolSchemas } : {}),
  };
}

function flatten(items) {
  return items.flatMap((item) => item || []);
}

test("truncated tool-call arguments at finish_reason emit an error event, not a closed block", () => {
  const state = createState();

  // Chunk 1: tool call start with id+name.
  const chunk1 = openaiToClaudeResponse(
    {
      id: "chatcmpl-trunc-1",
      model: "swe-1-7",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "Bash_1",
                type: "function",
                function: { name: "Bash" },
              },
            ],
          },
        },
      ],
    },
    state
  );
  assert.ok(flatten([chunk1]).some((e) => e?.type === "content_block_start"));

  // Chunk 2: truncated argument fragment — JSON never closes.
  openaiToClaudeResponse(
    {
      id: "chatcmpl-trunc-1",
      model: "swe-1-7",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"command": "cat > /tmp/file.ts' },
              },
            ],
          },
        },
      ],
    },
    state
  );

  // Chunk 3: stream ends with finish_reason — arguments are still unparseable.
  // (finish emission requires a usage-bearing chunk — pendingClaudeFinishChoice
  // defers otherwise.)
  const finish = flatten([
    openaiToClaudeResponse(
      {
        id: "chatcmpl-trunc-1",
        model: "swe-1-7",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 1024 },
      },
      state
    ),
  ]);

  const errorEvent = finish.find((e) => e?.type === "error");
  assert.ok(errorEvent, "expected a terminal error event for truncated tool args");
  assert.equal(errorEvent.error.type, "api_error");
  assert.match(errorEvent.error.message, /truncated/i);
  assert.equal(
    finish.some((e) => e?.type === "content_block_delta" && e.delta?.type === "input_json_delta"),
    false,
    "must not emit corrective input_json_delta for truncated args"
  );
});

test("well-formed tool-call arguments still close normally (no regression)", () => {
  const state = createState();

  openaiToClaudeResponse(
    {
      id: "chatcmpl-ok-1",
      model: "swe-1-7",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "Bash_2",
                type: "function",
                function: { name: "Bash", arguments: '{"command": "ls -la"}' },
              },
            ],
          },
        },
      ],
    },
    state
  );

  const finish = flatten([
    openaiToClaudeResponse(
      {
        id: "chatcmpl-ok-1",
        model: "swe-1-7",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
      state
    ),
  ]);

  assert.equal(
    finish.some((e) => e?.type === "error"),
    false,
    "valid args must not trigger the truncation error path"
  );
  assert.ok(finish.some((e) => e?.type === "content_block_stop"));
});

test("schema-driven repair: wrong types and extra keys are fixed against input_schema", () => {
  const toolSchemas = new Map([
    [
      "Read",
      {
        type: "object",
        additionalProperties: false,
        required: ["file_path"],
        properties: {
          file_path: { type: "string" },
          limit: { type: "number" },
          pages: { type: "string" },
        },
      },
    ],
  ]);
  const state = createState(toolSchemas);

  openaiToClaudeResponse(
    {
      id: "chatcmpl-schema-1",
      model: "glm-5.3",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_schema",
                type: "function",
                // stringified number + undeclared key when schema is closed
                function: {
                  name: "Read",
                  arguments: '{"file_path":"/tmp/a.ts","limit":"50","bogus":1}',
                },
              },
            ],
          },
        },
      ],
    },
    state
  );

  const finish = flatten([
    openaiToClaudeResponse(
      {
        id: "chatcmpl-schema-1",
        model: "glm-5.3",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
      state
    ),
  ]);

  assert.equal(
    finish.some((e) => e?.type === "error"),
    false
  );
  const delta = finish.find(
    (e) => e?.type === "content_block_delta" && e.delta?.type === "input_json_delta"
  );
  assert.ok(delta, "expected one corrective input_json_delta");
  const parsed = JSON.parse(delta.delta.partial_json);
  assert.deepEqual(parsed, { file_path: "/tmp/a.ts", limit: 50 });
});

test("schema-driven repair: missing required fields filled with type-correct empties", () => {
  const toolSchemas = new Map([
    [
      "TaskUpdate",
      {
        type: "object",
        required: ["taskId", "tags"],
        properties: {
          taskId: { type: "string" },
          tags: { type: "array" },
          active: { type: "boolean" },
        },
      },
    ],
  ]);
  const state = createState(toolSchemas);

  openaiToClaudeResponse(
    {
      id: "chatcmpl-schema-2",
      model: "glm-5.3",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_req",
                type: "function",
                function: {
                  name: "TaskUpdate",
                  arguments: '{"taskId":123,"active":"true"}',
                },
              },
            ],
          },
        },
      ],
    },
    state
  );

  const finish = flatten([
    openaiToClaudeResponse(
      {
        id: "chatcmpl-schema-2",
        model: "glm-5.3",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
      state
    ),
  ]);

  const delta = finish.find(
    (e) => e?.type === "content_block_delta" && e.delta?.type === "input_json_delta"
  );
  const parsed = JSON.parse(delta.delta.partial_json);
  // number→string coercion, "true"→boolean, missing required array filled
  assert.deepEqual(parsed, { taskId: "123", tags: [], active: true });
});
