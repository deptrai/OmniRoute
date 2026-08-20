/**
 * PostmanAgentExecutor — Postman Agent Mode (Claude Opus 4.8 / Sonnet 4.6 / GPT-5.5 / GPT-5.6)
 *
 * Routes requests directly through persistent Postman Agent session.
 *
 * Auth: Cookie-based (postman.sid) or session cookies.
 * Models supported: claude-opus-4-8, claude-sonnet-4-6, gpt-5.5, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.4, thinking, auto
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult, normalizeCookie } from "../utils/error.ts";
import { askPostmanAgent } from "./postman-session.ts";

const DEFAULT_POSTMAN_BASE = "https://identity.getpostman.com";

const MODEL_MAP: Record<string, string> = {
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4.8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.4": "GPT-5.4",
  thinking: "Thinking",
  auto: "Auto",
};

interface MessageItem {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === "text" ? c.text || "" : "")).join("");
  }
  return String(content || "");
}

function formatConversationPrompt(messages: MessageItem[], tools?: unknown[]): string {
  const parts: string[] = [];

  // If tools are provided, inject tool schema definitions
  if (Array.isArray(tools) && tools.length > 0) {
    parts.push(
      `[Tools Available]:\n${JSON.stringify(tools, null, 2)}\nIf you choose to invoke a tool, respond with a JSON code block or standard tool call format.`
    );
  }

  // Format all conversation turns
  for (const m of messages) {
    const text = extractText(m.content).trim();
    if (!text) continue;
    if (m.role === "system") {
      parts.push(`[System Instruction]:\n${text}`);
    } else if (m.role === "assistant") {
      parts.push(`[Assistant]:\n${text}`);
    } else {
      parts.push(`[User]:\n${text}`);
    }
  }

  return parts.join("\n\n");
}

function splitTextIntoSafeChunks(text: string, chunkSize = 16): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    chunks.push(chars.slice(i, i + chunkSize).join(""));
  }
  return chunks.length > 0 ? chunks : [text];
}

export class PostmanAgentExecutor extends BaseExecutor {
  constructor() {
    super("postman-agent", { id: "postman-agent", baseUrl: DEFAULT_POSTMAN_BASE });
  }

  async execute(input: ExecuteInput) {
    const { body, credentials, stream: wantStream } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;
    const rawApiKey = String(credentials?.apiKey ?? "").trim();
    const cookie = normalizeCookie(rawApiKey);

    if (!cookie) {
      return makeErrorResult(
        401,
        "Postman Agent requires a valid session cookie (postman.sid).",
        body,
        DEFAULT_POSTMAN_BASE
      );
    }

    const messages = (bodyObj.messages as MessageItem[]) || [];
    const tools = (bodyObj.tools as unknown[]) || undefined;
    const rawRequestedModel =
      (bodyObj.model as string) || (input.model as string) || "claude-opus-4-8";
    const cleanModelKey = rawRequestedModel
      .toLowerCase()
      .replace(/^(postman-agent|postman)\//i, "");
    const postmanModel = MODEL_MAP[cleanModelKey] || "Claude Opus 4.8";

    // Format full multi-turn conversation and tools
    const prompt = formatConversationPrompt(messages, tools);

    if (!prompt) {
      return makeErrorResult(
        400,
        "No prompt or messages provided in request.",
        body,
        DEFAULT_POSTMAN_BASE
      );
    }

    // Call real Postman Agent
    let responseText = "";
    try {
      const psData = credentials?.providerSpecificData as Record<string, unknown> | undefined;
      const rawDomain = psData?.teamDomain
        ? String(psData.teamDomain)
            .trim()
            .replace(/^https?:\/\//i, "")
            .replace(/\.postman\.(co|com)\/?.*$/i, "")
            .replace(/[^a-zA-Z0-9_-]/g, "")
        : "";
      const rawWorkspace = psData?.workspaceId
        ? String(psData.workspaceId)
            .trim()
            .replace(/[^a-zA-Z0-9_-]/g, "")
        : "";
      const customUrl =
        rawDomain && rawWorkspace
          ? `https://${rawDomain}.postman.co/workspace/${rawWorkspace}?sideView=agentMode`
          : undefined;

      responseText = await askPostmanAgent(prompt, cookie, postmanModel, customUrl, input.signal);
    } catch (err: any) {
      return makeErrorResult(
        502,
        `Postman Agent upstream error: ${err.message}`,
        body,
        DEFAULT_POSTMAN_BASE
      );
    }

    if (!responseText) {
      return makeErrorResult(
        504,
        `Postman Agent did not produce a response within the timeout limit for model ${postmanModel}.`,
        body,
        DEFAULT_POSTMAN_BASE
      );
    }

    const encoder = new TextEncoder();
    const modelName = rawRequestedModel;
    const completionId = `chatcmpl-postman-${Date.now()}`;
    const createdTime = Math.floor(Date.now() / 1000);

    if (!wantStream) {
      return {
        response: new Response(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created: createdTime,
            model: modelName,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: responseText,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: Math.ceil(prompt.length / 4),
              completion_tokens: Math.ceil(responseText.length / 4),
              total_tokens: Math.ceil(prompt.length / 4) + Math.ceil(responseText.length / 4),
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        ),
        url: DEFAULT_POSTMAN_BASE,
        headers: {},
        transformedBody: { model: postmanModel, prompt },
      };
    }

    // Safe streaming pipeline preserving all whitespace, newlines, emojis, and indentation
    const chunks = splitTextIntoSafeChunks(responseText, 16);
    const stream = new ReadableStream({
      async start(controller) {
        const initialChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTime,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`));

        for (const chunkText of chunks) {
          const chunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTime,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { content: chunkText },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }

        const doneChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTime,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return {
      response: new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: DEFAULT_POSTMAN_BASE,
      headers: {},
      transformedBody: { model: postmanModel, prompt },
    };
  }
}
