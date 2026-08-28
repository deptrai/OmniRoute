import test from "node:test";
import assert from "node:assert/strict";

const { normalizeClaudeCodeToolResult } =
  await import("../../open-sse/translator/helpers/claudeHelper.ts");
const { claudeToOpenAIRequest } =
  await import("../../open-sse/translator/request/claude-to-openai.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");

test("normalizeClaudeCodeToolResult rewrites known Claude Code sentinels", () => {
  const sentinels = [
    "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.",
    "Wasted call - file unchanged since your last Read.",
    "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.",
    "<system-reminder>This file is already in your context and has not changed on disk. Use that content instead of re-reading.</system-reminder>",
    "\n  Wasted call — file unchanged since your last Read.",
    "\r\nfile unchanged since last read",
    "  <system-reminder> this file is already in your context",
  ];

  for (const s of sentinels) {
    const result = normalizeClaudeCodeToolResult(s);
    assert.match(
      result,
      /Notice: The content of this file has already been retrieved/i,
      `Expected notice for sentinel: ${JSON.stringify(s)}`
    );
    assert.match(
      result,
      /Do NOT call Read or inspect this file again/i,
      `Expected instruction not to re-read for sentinel: ${JSON.stringify(s)}`
    );
  }
});

test("normalizeClaudeCodeToolResult preserves normal content and avoids false positives", () => {
  const normalInputs = [
    "const x = 10;\nconsole.log(x);",
    "This is documentation discussing how a wasted call — file unchanged behaves in theory.",
    "Some text where file unchanged since last read is mentioned casually in line 5.",
    "",
    "Simple string result",
  ];

  for (const input of normalInputs) {
    const result = normalizeClaudeCodeToolResult(input);
    assert.equal(result, input, `Expected normal input to be preserved: ${JSON.stringify(input)}`);
  }
});

test("normalizeClaudeCodeToolResult handles non-string inputs safely", () => {
  assert.equal(normalizeClaudeCodeToolResult(null as any), null);
  assert.equal(normalizeClaudeCodeToolResult(undefined as any), undefined);
  assert.equal(normalizeClaudeCodeToolResult(123 as any), 123);
});

test("claudeToOpenAIRequest normalizes Claude Code sentinels in tool_result messages", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "Read",
            input: { path: "foo.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content:
              "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.",
          },
        ],
      },
    ],
  };

  const converted = claudeToOpenAIRequest("gpt-4o", body, false);
  const toolMsg = converted.messages.find((m: any) => m.role === "tool");
  assert.ok(toolMsg, "Expected tool message to exist");
  assert.match(
    toolMsg.content,
    /Notice: The content of this file has already been retrieved/i,
    "Expected tool message content to be normalized"
  );
});

test("claudeToGeminiRequest normalizes Claude Code sentinels in tool_result messages", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_abc",
            content: "File unchanged since last read. The content from the earlier Read...",
          },
        ],
      },
    ],
  };

  const converted = claudeToGeminiRequest("gemini-2.5-flash", body, false);
  const part = converted.contents?.[0]?.parts?.[0];
  assert.ok(part?.functionResponse, "Expected functionResponse part");
  assert.match(
    JSON.stringify(part.functionResponse.response),
    /Notice: The content of this file has already been retrieved/i,
    "Expected functionResponse to contain normalized notice"
  );
});

test("normalizeClaudeCodeToolResult normalizes worktree sentinels", () => {
  const worktreeSentinels = [
    'Already in a worktree session. Pass `path` to switch into another existing worktree, or pass `action: "exit"` to leave the current worktree.',
    "<tool_use_error>Already in a worktree session. Pass `path` to switch into another existing worktree</tool_use_error>",
    "<tool_use_error>InputValidationError: EnterWorktree failed due to the following issue:\nAn unexpected parameter `reason` was provided</tool_use_error>",
  ];

  for (const s of worktreeSentinels) {
    const result = normalizeClaudeCodeToolResult(s);
    assert.match(
      result,
      /Notice: The current session is ALREADY running inside an isolated git worktree/i,
      `Expected worktree notice for sentinel: ${JSON.stringify(s)}`
    );
    assert.match(
      result,
      /Do NOT call EnterWorktree again/i,
      `Expected instruction not to call EnterWorktree for sentinel: ${JSON.stringify(s)}`
    );
  }
});

test("claudeToOpenAIRequest injects Claude Code harness adapter instructions for Claude Code sessions", () => {
  const body = {
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [
      {
        role: "user",
        content: "hello",
      },
    ],
  };

  const converted = claudeToOpenAIRequest("gpt-4o", body, false);
  const sysMsg = converted.messages.find((m: any) => m.role === "system");
  assert.ok(sysMsg, "Expected system message to exist");
  assert.match(
    sysMsg.content,
    /Claude Code CLI Runtime Conventions/i,
    "Expected harness adapter instructions in system prompt"
  );
});

test("claudeToGeminiRequest injects Claude Code harness adapter instructions for Claude Code sessions", () => {
  const body = {
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [
      {
        role: "user",
        content: "hello",
      },
    ],
  };

  const converted = claudeToGeminiRequest("gemini-2.5-flash", body, false);
  const sysText = converted.systemInstruction?.parts?.[0]?.text;
  assert.ok(sysText, "Expected systemInstruction text to exist");
  assert.match(
    sysText,
    /Claude Code CLI Runtime Conventions/i,
    "Expected harness adapter instructions in Gemini systemInstruction"
  );
});
