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

function createState() {
  return {
    toolCalls: new Map(),
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
