import test from "node:test";
import assert from "node:assert/strict";

const { applyToolCallShimToBuffer, hasToolCallShim, __test } =
  await import("../../open-sse/translator/helpers/toolCallShim.ts");
const { openaiToClaudeResponse } =
  await import("../../open-sse/translator/response/openai-to-claude.ts");

const { coerceToArray } = __test as { coerceToArray: (v: unknown) => unknown[] };

// -------- Helper-level tests --------

test("hasToolCallShim: returns true for registered shims", () => {
  assert.equal(hasToolCallShim("Read"), true);
  assert.equal(hasToolCallShim("Skill"), true);
  assert.equal(hasToolCallShim("TaskUpdate"), true);
  assert.equal(hasToolCallShim("submit_pr_review"), true);
  assert.equal(hasToolCallShim("some_other_tool"), false);
  assert.equal(hasToolCallShim(""), false);
  assert.equal(hasToolCallShim(undefined), false);
  assert.equal(hasToolCallShim(null), false);
});

test("coerceToArray: passes arrays through unchanged", () => {
  assert.deepEqual(coerceToArray([]), []);
  assert.deepEqual(coerceToArray([{ a: 1 }]), [{ a: 1 }]);
});

test("coerceToArray: null/undefined -> []", () => {
  assert.deepEqual(coerceToArray(null), []);
  assert.deepEqual(coerceToArray(undefined), []);
});

test("coerceToArray: plain object -> []", () => {
  assert.deepEqual(coerceToArray({}), []);
  assert.deepEqual(coerceToArray({ a: 1 }), []);
});

test("coerceToArray: empty string -> []", () => {
  assert.deepEqual(coerceToArray(""), []);
});

test("coerceToArray: stringified array parsed", () => {
  assert.deepEqual(coerceToArray("[]"), []);
  assert.deepEqual(coerceToArray('[{"title":"x"}]'), [{ title: "x" }]);
});

test("coerceToArray: unparseable string -> []", () => {
  assert.deepEqual(coerceToArray("not json"), []);
  assert.deepEqual(coerceToArray("{"), []);
});

test("coerceToArray: stringified non-array -> []", () => {
  assert.deepEqual(coerceToArray('{"a":1}'), []);
  assert.deepEqual(coerceToArray('"a string"'), []);
});

test("applyToolCallShimToBuffer: Read removes empty pages but preserves valid ranges", () => {
  const withEmptyPages = JSON.parse(
    applyToolCallShimToBuffer(
      "Read",
      JSON.stringify({ file_path: "/etc/hosts", offset: 1, limit: 5, pages: "" })
    )
  );
  assert.deepEqual(withEmptyPages, { file_path: "/etc/hosts", offset: 1, limit: 5 });

  const withEmptyArrayPages = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/tmp/a.pdf", pages: [] }))
  );
  assert.deepEqual(withEmptyArrayPages, { file_path: "/tmp/a.pdf" });

  const withValidPages = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/tmp/a.pdf", pages: "1-5" }))
  );
  assert.deepEqual(withValidPages, { file_path: "/tmp/a.pdf", pages: "1-5" });
});

// Port of decolua/9router#1144: non-Anthropic models (GPT-5.5, DeepSeek …) sometimes
// emit absurd Read-tool args (e.g. limit: 99999999999) that Claude Code rejects and
// retries, wasting tokens. The shim clamps/normalizes those args before re-emitting.
test("applyToolCallShimToBuffer: Read clamps limit to 2000 (non-Anthropic models)", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Read",
      JSON.stringify({ file_path: "/etc/hosts", limit: 99999999999 })
    )
  );
  assert.equal(out.limit, 2000);
});

test("applyToolCallShimToBuffer: Read drops non-positive limit", () => {
  const zero = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/etc/hosts", limit: 0 }))
  );
  assert.equal("limit" in zero, false);

  const negative = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/etc/hosts", limit: -50 }))
  );
  assert.equal("limit" in negative, false);
});

test("applyToolCallShimToBuffer: Read clamps negative offset to 0", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/etc/hosts", offset: -5 }))
  );
  assert.equal(out.offset, 0);
});

test("applyToolCallShimToBuffer: Read coerces numeric-string limit/offset", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Read",
      JSON.stringify({ file_path: "/etc/hosts", limit: "100", offset: "5" })
    )
  );
  assert.equal(out.limit, 100);
  assert.equal(out.offset, 5);
});

test("applyToolCallShimToBuffer: Read strips pages for non-PDF files", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/etc/hosts", pages: "1-3" }))
  );
  assert.equal("pages" in out, false);
});

test("applyToolCallShimToBuffer: Read strips malformed pages even on PDFs", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/tmp/doc.pdf", pages: "abc" }))
  );
  assert.equal("pages" in out, false);
});

test("applyToolCallShimToBuffer: Read accepts a single page on PDFs", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("Read", JSON.stringify({ file_path: "/tmp/doc.PDF", pages: "7" }))
  );
  assert.equal(out.pages, "7");
});

test("applyToolCallShimToBuffer: Read combined absurd args from non-Anthropic model", () => {
  // Simulates the upstream issue exactly: GPT-5.5-style giant limit, negative offset,
  // and a stray empty-string pages on a non-PDF.
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Read",
      JSON.stringify({
        file_path: "F:/repo/file.js",
        offset: -5,
        limit: 25999999999999999,
        pages: "",
      })
    )
  );
  assert.deepEqual(out, { file_path: "F:/repo/file.js", offset: 0, limit: 2000 });
});

test("applyToolCallShimToBuffer: submit_pr_review with valid arrays preserved", () => {
  const raw = JSON.stringify({
    summary: "ok",
    functionalChanges: [{ description: "x" }],
    findings: [{ title: "y" }],
  });
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", raw));
  assert.equal(out.summary, "ok");
  assert.deepEqual(out.functionalChanges, [{ description: "x" }]);
  assert.deepEqual(out.findings, [{ title: "y" }]);
});

test("applyToolCallShimToBuffer: submit_pr_review missing both keys -> arrays injected", () => {
  const raw = JSON.stringify({ summary: "no findings" });
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", raw));
  assert.equal(out.summary, "no findings");
  assert.deepEqual(out.functionalChanges, []);
  assert.deepEqual(out.findings, []);
});

test("applyToolCallShimToBuffer: submit_pr_review with functionalChanges=null replaced", () => {
  const raw = JSON.stringify({ functionalChanges: null, findings: [] });
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", raw));
  assert.deepEqual(out.functionalChanges, []);
  assert.deepEqual(out.findings, []);
});

test("applyToolCallShimToBuffer: submit_pr_review with findings={} replaced", () => {
  const raw = JSON.stringify({ functionalChanges: [], findings: {} });
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", raw));
  assert.deepEqual(out.findings, []);
});

test("applyToolCallShimToBuffer: submit_pr_review with findings='' replaced", () => {
  const raw = JSON.stringify({ functionalChanges: [], findings: "" });
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", raw));
  assert.deepEqual(out.findings, []);
});

test("applyToolCallShimToBuffer: submit_pr_review with findings='[]' parsed", () => {
  const raw = JSON.stringify({ functionalChanges: [], findings: "[]" });
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", raw));
  assert.deepEqual(out.findings, []);
});

test("applyToolCallShimToBuffer: submit_pr_review with stringified array of objects parsed", () => {
  const raw = JSON.stringify({
    functionalChanges: [],
    findings: '[{"title":"x"}]',
  });
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", raw));
  assert.deepEqual(out.findings, [{ title: "x" }]);
});

test("applyToolCallShimToBuffer: submit_pr_review with empty buffer -> empty arrays injected", () => {
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", ""));
  assert.deepEqual(out.functionalChanges, []);
  assert.deepEqual(out.findings, []);
});

test("applyToolCallShimToBuffer: submit_pr_review with unparseable buffer -> empty arrays", () => {
  const out = JSON.parse(applyToolCallShimToBuffer("submit_pr_review", "{broken"));
  assert.deepEqual(out.functionalChanges, []);
  assert.deepEqual(out.findings, []);
});

test("applyToolCallShimToBuffer: non-shimmed tool passes raw through", () => {
  const raw = '{"x":1}';
  assert.equal(applyToolCallShimToBuffer("some_other_tool", raw), raw);
});

// -------- Skill shim tests (GLM-5.2 emits `name` instead of `skill`) --------

test("applyToolCallShimToBuffer: Skill remaps name -> skill when skill is missing", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Skill",
      JSON.stringify({ name: "bmad-code-review", args: "review epic 17" })
    )
  );
  assert.equal(out.skill, "bmad-code-review");
  assert.equal(out.args, "review epic 17");
  assert.equal("name" in out, false, "name must be removed after remap");
});

test("applyToolCallShimToBuffer: Skill preserves skill when already correct", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Skill",
      JSON.stringify({ skill: "bmad-code-review", args: "review epic 17" })
    )
  );
  assert.equal(out.skill, "bmad-code-review");
  assert.equal(out.args, "review epic 17");
  assert.equal("name" in out, false);
});

test("applyToolCallShimToBuffer: Skill does not remap name when skill is present", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Skill",
      JSON.stringify({ skill: "correct-skill", name: "wrong-skill", args: "x" })
    )
  );
  assert.equal(out.skill, "correct-skill");
  assert.equal("name" in out, false, "stray name should be dropped when skill exists");
});

test("applyToolCallShimToBuffer: Skill with no name and no skill passes through", () => {
  const out = JSON.parse(applyToolCallShimToBuffer("Skill", JSON.stringify({ args: "x" })));
  assert.deepEqual(out, { args: "x" });
});

test("applyToolCallShimToBuffer: Skill with empty buffer -> empty object", () => {
  const out = JSON.parse(applyToolCallShimToBuffer("Skill", ""));
  assert.deepEqual(out, {});
});

// -------- TaskUpdate shim tests (GLM-5.2 emits taskId as number) --------

test("applyToolCallShimToBuffer: TaskUpdate coerces numeric taskId -> string", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("TaskUpdate", JSON.stringify({ taskId: 1, status: "in_progress" }))
  );
  assert.equal(out.taskId, "1");
  assert.equal(typeof out.taskId, "string");
  assert.equal(out.status, "in_progress");
});

test("applyToolCallShimToBuffer: TaskUpdate preserves string taskId", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("TaskUpdate", JSON.stringify({ taskId: "abc-123", status: "done" }))
  );
  assert.equal(out.taskId, "abc-123");
  assert.equal(out.status, "done");
});

test("applyToolCallShimToBuffer: TaskUpdate coerces large numeric taskId -> string", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "TaskUpdate",
      JSON.stringify({ taskId: 1234567890, status: "completed" })
    )
  );
  assert.equal(out.taskId, "1234567890");
  assert.equal(typeof out.taskId, "string");
});

test("applyToolCallShimToBuffer: TaskUpdate remaps id -> taskId when taskId is missing", () => {
  // Real-world case: GLM emits `id` instead of `taskId`
  const out = JSON.parse(
    applyToolCallShimToBuffer("TaskUpdate", JSON.stringify({ id: 1, status: "completed" }))
  );
  assert.equal(out.taskId, "1");
  assert.equal(out.status, "completed");
  assert.equal("id" in out, false, "id should be removed after remap");
});

test("applyToolCallShimToBuffer: TaskUpdate remaps string id -> taskId", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("TaskUpdate", JSON.stringify({ id: "abc-123", status: "done" }))
  );
  assert.equal(out.taskId, "abc-123");
  assert.equal("id" in out, false);
});

test("applyToolCallShimToBuffer: TaskUpdate with no taskId passes through", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("TaskUpdate", JSON.stringify({ status: "done" }))
  );
  assert.deepEqual(out, { status: "done" });
});

test("applyToolCallShimToBuffer: TaskUpdate with empty buffer -> empty object", () => {
  const out = JSON.parse(applyToolCallShimToBuffer("TaskUpdate", ""));
  assert.deepEqual(out, {});
});

// -------- Agent shim tests (GLM-5.2-max emits `description` instead of `prompt`) --------

test("applyToolCallShimToBuffer: Agent copies description -> prompt when prompt is missing", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Agent",
      JSON.stringify({
        description: "UX designer review Admin Console plan",
        agent: "general-purpose",
      })
    )
  );
  assert.equal(out.prompt, "UX designer review Admin Console plan");
  assert.equal(out.agent, "general-purpose");
  assert.equal(
    out.description,
    "UX designer review Admin Console plan",
    "description must be kept"
  );
});

test("applyToolCallShimToBuffer: Agent preserves prompt when already correct, adds description from prompt", () => {
  // GLM emits only prompt (no description) — shim must add description from prompt
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Agent",
      JSON.stringify({ prompt: "Review the architecture", agent: "general-purpose" })
    )
  );
  assert.equal(out.prompt, "Review the architecture");
  assert.equal(out.agent, "general-purpose");
  assert.equal(typeof out.description, "string", "description added from prompt");
  assert.equal(out.description, "Review the architecture");
});

test("applyToolCallShimToBuffer: Agent keeps description when prompt is present", () => {
  // Agent tool requires BOTH description AND prompt. When both present, keep both.
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Agent",
      JSON.stringify({
        prompt: "correct prompt",
        description: "short description",
        agent: "general-purpose",
      })
    )
  );
  assert.equal(out.prompt, "correct prompt");
  assert.equal(out.description, "short description", "description must be kept");
});

test("applyToolCallShimToBuffer: Agent with no description and no prompt passes through", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer("Agent", JSON.stringify({ agent: "general-purpose" }))
  );
  assert.equal(out.agent, "general-purpose");
  assert.equal("prompt" in out, false);
  assert.equal("description" in out, false);
});

test("applyToolCallShimToBuffer: Agent with empty buffer -> empty object", () => {
  const out = JSON.parse(applyToolCallShimToBuffer("Agent", ""));
  assert.deepEqual(out, {});
});

test("applyToolCallShimToBuffer: Agent copies description only (no agent field)", () => {
  // Real-world case from session 241b7ee8: GLM-5.2-max emitted only description, no agent
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Agent",
      JSON.stringify({ description: "UX designer review Admin Console plan" })
    )
  );
  assert.equal(out.prompt, "UX designer review Admin Console plan");
  assert.equal(
    out.description,
    "UX designer review Admin Console plan",
    "description must be kept"
  );
});

test("applyToolCallShimToBuffer: Agent copies prompt -> description when description is missing", () => {
  // Real-world case: GLM emits only prompt (long), omits description
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Agent",
      JSON.stringify({
        prompt: "You are Sally, UX designer. Review the Admin Console UX plan.",
        run_in_background: true,
      })
    )
  );
  assert.equal(out.prompt, "You are Sally, UX designer. Review the Admin Console UX plan.");
  assert.equal(typeof out.description, "string", "description must be added");
  assert.equal(out.description.length > 0, true);
  assert.equal(out.run_in_background, true);
});

test("applyToolCallShimToBuffer: Agent truncates long prompt when copying to description", () => {
  const longPrompt = "A".repeat(200);
  const out = JSON.parse(
    applyToolCallShimToBuffer("Agent", JSON.stringify({ prompt: longPrompt }))
  );
  assert.equal(out.prompt, longPrompt);
  assert.equal(out.description.length, 80, "description truncated to 80 chars");
  assert.equal(out.description.endsWith("..."), true);
});

test("applyToolCallShimToBuffer: Agent with both prompt and description keeps both unchanged", () => {
  const out = JSON.parse(
    applyToolCallShimToBuffer(
      "Agent",
      JSON.stringify({
        prompt: "full task",
        description: "short summary",
        agent: "general-purpose",
      })
    )
  );
  assert.equal(out.prompt, "full task");
  assert.equal(out.description, "short summary");
  assert.equal(out.agent, "general-purpose");
});

test("hasToolCallShim: returns true for Agent", () => {
  assert.equal(hasToolCallShim("Agent"), true);
});

// -------- Truncated JSON + shim interaction tests --------
// GLM-5.2-max cuts off tool call args mid-stream, leaving unmatched brackets.
// Without repair, the shim falls back to {} and loses the fields it needs to remap.

test("applyToolCallShimToBuffer: Agent with truncated description (missing closing brace) + repaired raw", () => {
  // Real-world case from session 241b7ee8: GLM streamed {"description": "..." with no closing }
  const truncated = '{"description": "UX designer review Admin Console plan"';
  const repaired = '{"description": "UX designer review Admin Console plan"}';
  const out = JSON.parse(applyToolCallShimToBuffer("Agent", truncated, repaired));
  assert.equal(out.prompt, "UX designer review Admin Console plan");
  assert.equal(
    out.description,
    "UX designer review Admin Console plan",
    "description kept after repair"
  );
});

test("applyToolCallShimToBuffer: Agent with truncated description, no repair provided -> falls back to {}", () => {
  // Without repairedRaw, JSON.parse fails on truncated input -> {} -> no prompt
  const truncated = '{"description": "UX designer review Admin Console plan"';
  const out = JSON.parse(applyToolCallShimToBuffer("Agent", truncated));
  assert.equal("prompt" in out, false);
  assert.equal("description" in out, false);
});

test("applyToolCallShimToBuffer: Skill with truncated name (missing closing brace) + repaired raw", () => {
  const truncated = '{"name": "bmad-product-brief"';
  const repaired = '{"name": "bmad-product-brief"}';
  const out = JSON.parse(applyToolCallShimToBuffer("Skill", truncated, repaired));
  assert.equal(out.skill, "bmad-product-brief");
  assert.equal("name" in out, false);
});

test("applyToolCallShimToBuffer: TaskUpdate with truncated taskId (missing closing brace) + repaired raw", () => {
  const truncated = '{"taskId": 1, "status": "in_progress"';
  const repaired = '{"taskId": 1, "status": "in_progress"}';
  const out = JSON.parse(applyToolCallShimToBuffer("TaskUpdate", truncated, repaired));
  assert.equal(out.taskId, "1");
  assert.equal(out.status, "in_progress");
});

test("applyToolCallShimToBuffer: Agent with truncated nested value + repaired raw", () => {
  // Truncated mid-string-value with nested structure
  const truncated = '{"description": "Review the plan", "agent": "general-purpose"';
  const repaired = '{"description": "Review the plan", "agent": "general-purpose"}';
  const out = JSON.parse(applyToolCallShimToBuffer("Agent", truncated, repaired));
  assert.equal(out.prompt, "Review the plan");
  assert.equal(out.agent, "general-purpose");
  assert.equal(out.description, "Review the plan", "description kept after repair");
});

test("applyToolCallShimToBuffer: Agent with valid JSON, repairedRaw ignored (raw parses fine)", () => {
  const raw = '{"prompt": "already correct", "description": "short"}';
  const out = JSON.parse(applyToolCallShimToBuffer("Agent", raw, '{"description": "wrong"}'));
  // raw parses successfully, so repairedRaw is not used
  assert.equal(out.prompt, "already correct");
  assert.equal(out.description, "short");
});

// -------- Streaming integration tests --------

function freshState() {
  return {
    messageStartSent: false,
    nextBlockIndex: 0,
    toolCalls: new Map(),
    thinkingBlockStarted: false,
    textBlockStarted: false,
    textBlockClosed: false,
  };
}

function streamChunks(chunks: any[], state: any): any[] {
  const all: any[] = [];
  for (const c of chunks) {
    const out = openaiToClaudeResponse(c, state);
    if (out) all.push(...out);
  }
  return all;
}

test("streaming: Read suppresses raw pages delta and emits cleaned input at finish", () => {
  const state = freshState();
  const chunks = [
    {
      id: "chatcmpl-read",
      model: "codex/gpt-5.5-high",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_read",
                function: { name: "Read", arguments: "" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: '{"file_path":"/etc/hosts","offset":1,"limit":5,"pages":""}',
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];

  const events = streamChunks(chunks, state);
  const inputDeltas = events.filter(
    (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
  );

  assert.equal(inputDeltas.length, 1, "expected exactly one cleaned Read delta");
  assert.equal(inputDeltas[0].delta.partial_json.includes('"pages"'), false);
  assert.deepEqual(JSON.parse(inputDeltas[0].delta.partial_json), {
    file_path: "/etc/hosts",
    offset: 1,
    limit: 5,
  });
});

test("streaming: submit_pr_review with missing arrays gets corrective delta at finish", () => {
  const state = freshState();
  const chunks = [
    // chunk 1: message start + tool call start with name
    {
      id: "chatcmpl-1",
      model: "xiaomi-mimo/mimo-v2.5-pro",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "submit_pr_review", arguments: "" },
              },
            ],
          },
        },
      ],
    },
    // chunk 2: argument fragment (summary only — no findings/functionalChanges)
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"summary":"no findings"}' },
              },
            ],
          },
        },
      ],
    },
    // chunk 3: finish
    {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    },
  ];

  const events = streamChunks(chunks, state);

  // No passthrough input_json_delta for shimmed tool
  const passthroughDeltas = events.filter(
    (e) =>
      e.type === "content_block_delta" &&
      e.delta?.type === "input_json_delta" &&
      e.delta?.partial_json === '{"summary":"no findings"}'
  );
  assert.equal(passthroughDeltas.length, 0, "raw passthrough delta should be suppressed");

  // Exactly one corrective input_json_delta on the tool block
  const correctiveDeltas = events.filter(
    (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
  );
  assert.equal(correctiveDeltas.length, 1, "expected exactly one corrective delta");

  const finalInput = JSON.parse(correctiveDeltas[0].delta.partial_json);
  assert.equal(finalInput.summary, "no findings");
  assert.deepEqual(finalInput.functionalChanges, []);
  assert.deepEqual(finalInput.findings, []);

  // Corrective delta MUST come before the content_block_stop for that tool block
  const correctiveIdx = events.findIndex(
    (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
  );
  const stopIdx = events.findIndex(
    (e) => e.type === "content_block_stop" && e.index === correctiveDeltas[0].index
  );
  assert.ok(correctiveIdx < stopIdx, "corrective delta must precede content_block_stop");
});

test("streaming: non-shimmed tool still streams partials through", () => {
  const state = freshState();
  const chunks = [
    {
      id: "chatcmpl-1",
      model: "x",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "some_other_tool", arguments: "" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];

  const events = streamChunks(chunks, state);
  const deltas = events.filter(
    (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
  );
  // For non-shimmed tools, the original passthrough delta survives (and no extra corrective delta).
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta.partial_json, '{"x":1}');
});
