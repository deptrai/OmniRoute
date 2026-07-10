import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToClaudeResponse, tryRepairTruncatedJson } from "../../open-sse/translator/response/openai-to-claude.ts";

// ─── T4: openai-to-claude streaming shim integration ────────────────────────
// Tests the finish handler where shimmed tools get a corrective input_json_delta
// and non-shimmed tools get repaired JSON.

function makeState() {
  return {
    nextBlockIndex: 0,
    textBlockStarted: false,
    textBlockClosed: false,
    textBlockIndex: -1,
    thinkingBlockStarted: false,
    thinkingBlockIndex: -1,
    toolCalls: new Map(),
    finishReason: null,
    claudeFinishEmitted: false,
    usage: null,
  };
}

/** Simulate streaming a tool call through openaiToClaudeResponse.
 * Returns { allResults, finishResults } where finishResults is only the
 * results from the finish chunk (so we can inspect corrective deltas). */
function streamToolCall(
  toolName: string,
  argsBuffer: string,
  state: ReturnType<typeof makeState>
): { allResults: any[]; finishResults: any[] } {
  const allResults: any[] = [];

  // 1. content_block_start (tool call header)
  const startChunk = {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_test_1",
          type: "function",
          function: { name: toolName, arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  };
  allResults.push(...(openaiToClaudeResponse(startChunk, state) || []));

  // 2. Stream argument fragments (if any)
  if (argsBuffer) {
    const argChunk = {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: argsBuffer },
          }],
        },
        finish_reason: null,
      }],
    };
    allResults.push(...(openaiToClaudeResponse(argChunk, state) || []));
  }

  // 3. Finish chunk — this is where the corrective delta is emitted
  const finishChunk = {
    choices: [{
      index: 0,
      delta: {},
      finish_reason: "tool_calls",
    }],
  };
  const finishResults = openaiToClaudeResponse(finishChunk, state) || [];
  allResults.push(...finishResults);

  return { allResults, finishResults };
}

/** Extract the corrective input_json_delta from finish handler results only.
 * For shimmed tools: the corrective delta is the FULL patched JSON.
 * For non-shimmed tools: the corrective delta is the repair SUFFIX (closing brackets),
 *   or null if no repair was needed (valid JSON).
 */
function getCorrectiveDelta(finishResults: any[]): string | null {
  for (const r of finishResults) {
    if (r.type === "content_block_delta" && r.delta?.type === "input_json_delta") {
      return r.delta.partial_json;
    }
  }
  return null;
}

/** Get all content_block_start events */
function getBlockStarts(results: any[]): any[] {
  return results.filter((r) => r.type === "content_block_start");
}

/** Get all content_block_stop events */
function getBlockStops(results: any[]): any[] {
  return results.filter((r) => r.type === "content_block_stop");
}

// ─── T4: Shimmed tool — corrective delta at finish ──────────────────────────

test("T4: Agent shim — corrective delta copies description -> prompt when prompt missing", () => {
  const state = makeState();
  // GLM emits only description, no prompt
  const args = JSON.stringify({ description: "Review the code", agent: "general-purpose" });
  const { allResults: results, finishResults } = streamToolCall("Agent", args, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted for shimmed Agent tool");
  const parsed = JSON.parse(corrective!);
  assert.equal(parsed.prompt, "Review the code", "prompt copied from description");
  assert.equal(parsed.description, "Review the code");
  assert.equal(parsed.agent, "general-purpose");
});

test("T4: Agent shim — corrective delta copies prompt -> description when description missing", () => {
  const state = makeState();
  // GLM emits only prompt, no description
  const args = JSON.stringify({ prompt: "Do the thing", agent: "general-purpose" });
  const { allResults: results, finishResults } = streamToolCall("Agent", args, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted");
  const parsed = JSON.parse(corrective!);
  assert.equal(parsed.description, "Do the thing", "description copied from prompt");
  assert.equal(parsed.prompt, "Do the thing");
});

test("T4: Agent shim — both present, no corrective copy needed", () => {
  const state = makeState();
  const args = JSON.stringify({
    description: "Short summary",
    prompt: "Full task instructions here",
    agent: "general-purpose",
  });
  const { allResults: results, finishResults } = streamToolCall("Agent", args, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta still emitted (shimmed tool always gets one)");
  const parsed = JSON.parse(corrective!);
  assert.equal(parsed.description, "Short summary");
  assert.equal(parsed.prompt, "Full task instructions here");
});

test("T4: TaskUpdate shim — id remapped to taskId in corrective delta", () => {
  const state = makeState();
  // GLM emits id instead of taskId
  const args = JSON.stringify({ id: 42, status: "completed" });
  const { allResults: results, finishResults } = streamToolCall("TaskUpdate", args, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted for TaskUpdate");
  const parsed = JSON.parse(corrective!);
  assert.equal(parsed.taskId, "42", "id remapped to taskId and coerced to string");
  assert.equal("id" in parsed, false, "id removed after remap");
  assert.equal(parsed.status, "completed");
});

test("T4: Skill shim — name remapped to skill in corrective delta", () => {
  const state = makeState();
  const args = JSON.stringify({ name: "bmad-code-review" });
  const { allResults: results, finishResults } = streamToolCall("Skill", args, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted for Skill");
  const parsed = JSON.parse(corrective!);
  assert.equal(parsed.skill, "bmad-code-review", "name remapped to skill");
  assert.equal("name" in parsed, false, "name removed after remap");
});

test("T4: Read shim — limit clamped in corrective delta", () => {
  const state = makeState();
  const args = JSON.stringify({ file_path: "/tmp/test.txt", limit: 999999 });
  const { allResults: results, finishResults } = streamToolCall("Read", args, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted for Read");
  const parsed = JSON.parse(corrective!);
  assert.equal(parsed.limit, 2000, "limit clamped to 2000");
  assert.equal(parsed.file_path, "/tmp/test.txt");
});

test("T4: submit_pr_review shim — arrays injected in corrective delta", () => {
  const state = makeState();
  const args = JSON.stringify({ functionalChanges: null, findings: "" });
  const { allResults: results, finishResults } = streamToolCall("submit_pr_review", args, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted for submit_pr_review");
  const parsed = JSON.parse(corrective!);
  assert.deepEqual(parsed.functionalChanges, []);
  assert.deepEqual(parsed.findings, []);
});

// ─── T4: Non-shimmed tool — truncated JSON repair at finish ─────────────────

test("T4: non-shimmed tool — truncated JSON repaired at finish (suffix emitted)", () => {
  const state = makeState();
  // Truncated JSON: missing closing brace
  const truncatedArgs = '{"command":"ls","cwd":"/tmp"';
  const { allResults: results, finishResults } = streamToolCall("Bash", truncatedArgs, state);

  // Non-shimmed tool: corrective delta is the repair SUFFIX (closing brackets)
  // The suffix completes the already-streamed partial JSON on the client side
  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "repair suffix emitted for non-shimmed tool with truncated JSON");
  // The suffix should be just the closing brace(s)
  assert.equal(corrective, "}", "suffix is the missing closing brace");
  // Verify the full repaired JSON (raw + suffix) parses correctly
  const fullJson = truncatedArgs + corrective;
  const parsed = JSON.parse(fullJson);
  assert.equal(parsed.command, "ls");
  assert.equal(parsed.cwd, "/tmp");
});

test("T4: non-shimmed tool — valid JSON, no repair suffix needed", () => {
  const state = makeState();
  const args = JSON.stringify({ command: "echo hello" });
  const { allResults: results, finishResults } = streamToolCall("Bash", args, state);

  // Non-shimmed tool with valid JSON: no repair suffix emitted
  // The streamed args are already valid, so no corrective delta at finish
  const corrective = getCorrectiveDelta(finishResults);
  assert.equal(corrective, null, "no repair suffix for valid non-shimmed JSON");
});

// ─── T4: claudeFinishEmitted guard — no duplicate finish ─────────────────────

test("T4: duplicate finish_reason chunks — finish events emitted exactly once", () => {
  const state = makeState();
  const args = JSON.stringify({ command: "ls" });

  // Stream a tool call
  streamToolCall("Bash", args, state);

  // Send another finish chunk (duplicate)
  const dupFinish = {
    choices: [{
      index: 0,
      delta: {},
      finish_reason: "tool_calls",
    }],
  };
  const dupResults = openaiToClaudeResponse(dupFinish, state);

  // Should return null or empty — finish already emitted
  assert.ok(!dupResults || dupResults.length === 0, "no duplicate finish events");
});

// ─── T4: content_block_start/stop lifecycle ─────────────────────────────────

test("T4: tool call — content_block_start and content_block_stop emitted", () => {
  const state = makeState();
  const args = JSON.stringify({ prompt: "test" });
  const { allResults: results, finishResults } = streamToolCall("Agent", args, state);

  const starts = getBlockStarts(results);
  const stops = getBlockStops(results);

  // Should have at least one start (tool_use) and one stop
  assert.ok(starts.some((s) => s.content_block?.type === "tool_use"), "content_block_start for tool_use");
  assert.ok(stops.length >= 1, "content_block_stop emitted");
});

test("T4: tool call — content_block_start has input:{}", () => {
  const state = makeState();
  const args = JSON.stringify({ prompt: "test" });
  const { allResults: results, finishResults } = streamToolCall("Agent", args, state);

  const toolStart = results.find(
    (r) => r.type === "content_block_start" && r.content_block?.type === "tool_use"
  );
  assert.ok(toolStart, "tool_use content_block_start found");
  assert.deepEqual(toolStart.content_block.input, {}, "initial input is empty object");
});

// ─── T4: Truncated JSON + shim interaction ──────────────────────────────────

test("T4: Agent shim + truncated JSON — repair runs before shim", () => {
  const state = makeState();
  // Truncated: missing closing brace, and prompt field is missing
  const truncated = '{"description":"Review code","agent":"general-purpose"';
  const { allResults: results, finishResults } = streamToolCall("Agent", truncated, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted despite truncation");
  const parsed = JSON.parse(corrective!);
  // Shim should have copied description -> prompt after repair
  assert.equal(parsed.prompt, "Review code", "prompt copied from description after repair");
  assert.equal(parsed.description, "Review code");
  assert.equal(parsed.agent, "general-purpose");
});

test("T4: TaskUpdate shim + truncated JSON — repair + id->taskId remap", () => {
  const state = makeState();
  // Truncated: missing closing brace, id instead of taskId
  const truncated = '{"id":5,"status":"done"';
  const { allResults: results, finishResults } = streamToolCall("TaskUpdate", truncated, state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted");
  const parsed = JSON.parse(corrective!);
  assert.equal(parsed.taskId, "5", "id remapped to taskId after repair");
  assert.equal(parsed.status, "done");
});

// ─── T4: Empty args buffer ──────────────────────────────────────────────────

test("T4: shimmed tool with empty args buffer — shim gets {} and still applies", () => {
  const state = makeState();
  const { allResults: results, finishResults } = streamToolCall("submit_pr_review", "", state);

  const corrective = getCorrectiveDelta(finishResults);
  assert.ok(corrective, "corrective delta emitted for empty buffer");
  const parsed = JSON.parse(corrective!);
  // submit_pr_review shim injects empty arrays even for empty input
  assert.deepEqual(parsed.functionalChanges, []);
  assert.deepEqual(parsed.findings, []);
});
