import { BaseExecutor, type ExecuteInput, type ExecutorResult } from "./base.ts";
import { normalizeCookie } from "../utils/error.ts";
import { askPostmanAgent } from "./postman-session.ts";

const DEFAULT_POSTMAN_BASE = "https://go.postman.co";

const MODEL_MAP: Record<string, string> = {
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
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

function makeErrorResult(
  status: number,
  message: string,
  body: unknown,
  url: string = DEFAULT_POSTMAN_BASE
): ExecutorResult {
  return {
    url,
    headers: {},
    transformedBody: body,
    response: new Response(
      JSON.stringify({
        error: {
          message,
        },
      }),
      {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      }
    ),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === "text" ? c.text || "" : "")).join("");
  }
  return String(content || "");
}

function formatConversationPrompt(messages: MessageItem[]): string {
  const parts: string[] = [];

  // Format all conversation turns
  for (const m of messages) {
    const text = extractText(m.content).trim();
    if (!text) continue;
    if (m.role === "system") {
      parts.push(`[System Instruction]:\n${text}`);
    } else if (m.role === "assistant") {
      parts.push(`[Assistant]:\n${text}`);
    } else {
      parts.push(text);
    }
  }

  return parts.join("\n\n");
}

function splitTextIntoSafeChunks(text: string, chunkSize: number = 32): string[] {
  // Use Array.from to iterate over unicode code points safely (prevents splitting surrogate pairs)
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < codePoints.length; i += chunkSize) {
    chunks.push(codePoints.slice(i, i + chunkSize).join(""));
  }
  return chunks;
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
      .replace(/^(postman-agent|postman|codex|cx)\//i, "");
    const baseCleanKey = cleanModelKey.replace(/-(xhigh|high|medium|low|none)$/i, "");
    const postmanModel = MODEL_MAP[cleanModelKey] || MODEL_MAP[baseCleanKey] || "Claude Opus 4.8";

    // Format full multi-turn conversation
    const prompt = formatConversationPrompt(messages);

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

      let customUrl: string | undefined = undefined;
      if (psData?.workspaceUrl || psData?.workspace_url || psData?.url) {
        customUrl = String(psData.workspaceUrl || psData.workspace_url || psData.url).trim();
      } else if (rawDomain && rawWorkspace) {
        customUrl = `https://${rawDomain}.postman.co/workspace/${rawWorkspace}?sideView=agentMode`;
      }

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
              total_tokens: Math.ceil((prompt.length + responseText.length) / 4),
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        ),
        transformedBody: body,
      };
    }

    // Stream SSE Response
    const chunks = splitTextIntoSafeChunks(responseText, 32);
    const stream = new ReadableStream({
      start(controller) {
        // First chunk with role
        const roleChunk = {
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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        // Content chunks
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

        // Final chunk
        const finalChunk = {
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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return {
      response: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      }),
      transformedBody: body,
    };
  }
}
