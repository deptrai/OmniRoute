import test from "node:test";
import assert from "node:assert/strict";

import { normalizeClaudeCodeToolResult } from "../../open-sse/translator/helpers/claudeHelper.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

test("normalizeClaudeCodeToolResult: rewrites known Claude Code sentinels", () => {
  const sentinels = [
    "Wasted call — file unchanged since your last Read. Please do not call Read again.",
    "  wasted call - file unchanged since your last read\n",
    "File unchanged since last read. The content from the earlier Read is still valid.",
    "<system-reminder>This file is already in your context. Do not read it again.</system-reminder>",
    "Error: file unchanged since your last Read on line 12",
  ];

  for (const sentinel of sentinels) {
    const normalized = normalizeClaudeCodeToolResult(sentinel);
    assert.match(
      normalized,
      /\[Notice: The content of this file has already been retrieved earlier in this conversation/
    );
    assert.match(normalized, /Do NOT call Read on this file again\./);
  }
});

test("normalizeClaudeCodeToolResult: leaves regular tool outputs untouched", () => {
  const normalOutputs = [
    "const x = 1;\nconsole.log(x);",
    '{"status": "ok", "count": 42}',
    "Wasted effort on something else that is not a tool call sentinel",
    "",
  ];

  for (const output of normalOutputs) {
    assert.equal(normalizeClaudeCodeToolResult(output), output);
  }
});

test("claudeToGeminiRequest: normalizes tool_result containing Claude Code sentinels", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: "Read file src/app.ts",
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_read_1",
            name: "Read",
            input: { file_path: "src/app.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read_1",
            content: "Wasted call — file unchanged since your last Read.",
          },
        ],
      },
    ],
  };

  const req = claudeToGeminiRequest("gemini-2.5-flash", body, false);
  assert.ok(req.contents);
  const toolResultTurn = req.contents[req.contents.length - 1];
  assert.equal(toolResultTurn.role, "user");
  const functionResponsePart = toolResultTurn.parts.find((p: any) => p.functionResponse);
  assert.ok(functionResponsePart);
  const resultVal =
    typeof functionResponsePart.functionResponse.response.result === "string"
      ? functionResponsePart.functionResponse.response.result
      : functionResponsePart.functionResponse.response.result?.result ||
        JSON.stringify(functionResponsePart.functionResponse.response.result);
  assert.match(
    resultVal,
    /\[Notice: The content of this file has already been retrieved earlier in this conversation/
  );
});

test("claudeToOpenAIRequest: normalizes tool_result containing Claude Code sentinels", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: "Read file src/app.ts",
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_read_1",
            name: "Read",
            input: { file_path: "src/app.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read_1",
            content: "File unchanged since last read.",
          },
        ],
      },
    ],
  };

  const req = claudeToOpenAIRequest("gpt-4o", body);
  assert.ok(req.messages);
  const toolMsg = req.messages.find((m: any) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(
    toolMsg.content,
    /\[Notice: The content of this file has already been retrieved earlier in this conversation/
  );
});

test("openaiToGeminiRequest: normalizes tool response in signatureless context mode", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: "Read file index.ts",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read_2",
            type: "function",
            function: {
              name: "Read",
              arguments: '{"file_path":"index.ts"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_read_2",
        content: "<system-reminder>This file is already in your context.</system-reminder>",
      },
    ],
  };

  const req = openaiToGeminiRequest("gemini-2.5-flash", body, false);
  assert.ok(req.contents);
  const userTurn = req.contents[req.contents.length - 1];
  assert.equal(userTurn.role, "user");
  const responsePart = userTurn.parts[0];
  const responseText = responsePart.text || JSON.stringify(responsePart);
  assert.match(
    responseText,
    /\[Notice: The content of this file has already been retrieved earlier in this conversation/
  );
});
